export type TerminalLifecycleState = "hydrating" | "replaying" | "live" | "reconnecting" | "exited";

export interface TerminalSessionCache {
  terminalId: string;
  serialized: string;
  cursor: number;
  cols: number;
  rows: number;
  status: string;
  updatedAt: number;
  size?: number;
  viewportY?: number;
}

const DB_NAME = "VibeGoTerminalCache";
const STORE = "terminal_sessions";
const META = "terminal_metadata";
export const TERMINAL_CACHE_BYTES = 64 * 1024 * 1024;
export const TERMINAL_CACHE_COUNT = 100;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
// Lifecycle ownership tokens prevent an unmounted/deleted view's delayed save from
// resurrecting a cache, without retaining every terminal ID forever.
const owners = new Map<string, Set<{ valid: boolean }>>();
export function acquireTerminalCacheOwner(id: string) {
  const token = { valid: true };
  const tokens = owners.get(id) ?? new Set();
  tokens.add(token);
  owners.set(id, tokens);
  return {
    token,
    release() {
      tokens.delete(token);
      if (!tokens.size) owners.delete(id);
    },
  };
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    let abandoned = false;
    const fail = (error: unknown) => {
      abandoned = true;
      clearTimeout(timer);
      reject(error);
    };
    // An old tab may hold a v1 connection indefinitely. Cache availability
    // must never prevent connecting to the terminal itself.
    const timer = setTimeout(() => fail(new Error("Terminal cache unavailable")), 1000);
    request.onblocked = () => fail(new Error("Terminal cache upgrade blocked"));
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: "terminalId" });
      if (!store.indexNames.contains("access")) store.createIndex("access", ["updatedAt", "terminalId"]);
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, { keyPath: "terminalId" });
        meta.createIndex("access", ["updatedAt", "terminalId"]);
      }
    };
  });
}

async function transaction<T>(
  action: (store: IDBObjectStore, result: (value: T) => void, meta: IDBObjectStore) => void
): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction([STORE, META], "readwrite");
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      action(
        tx.objectStore(STORE),
        (next) => {
          value = next;
        },
        tx.objectStore(META)
      );
    });
  } finally {
    db.close();
  }
}

let migration: Promise<void> | undefined;
function migrateMetadata(): Promise<void> {
  return (migration ??= (async () => {
    const complete = await transaction<boolean>((_store, result, meta) => {
      const request = meta.get("\0migration");
      request.onsuccess = () => result(!!request.result);
    });
    if (complete) return;
    let after: IDBValidKey | undefined;
    for (;;) {
      const next = await transaction<IDBValidKey | undefined>((store, result, meta) => {
        let count = 0;
        const request = store.openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            meta.put({ terminalId: "\0migration" });
            result(undefined);
            return;
          }
          const cache = cursor.value as TerminalSessionCache;
          const size = cache.size ?? new TextEncoder().encode(cache.serialized).length;
          meta.put({ terminalId: cache.terminalId, size, updatedAt: cache.updatedAt });
          if (++count >= 100) result(cursor.key);
          else cursor.continue();
        };
      });
      if (next === undefined) return;
      after = next;
    }
  })().catch((error) => {
    migration = undefined;
    throw error;
  }));
}

// Process at most 100 entries per transaction; never materialize all snapshots.
async function prune(clear = false): Promise<void> {
  await migrateMetadata();
  let before: IDBValidKey | undefined;
  let count = 0;
  let bytes = 0;
  for (;;) {
    const next = await transaction<IDBValidKey | undefined>((store, result, meta) => {
      let visited = 0;
      const request = meta
        .index("access")
        .openCursor(before ? IDBKeyRange.upperBound(before, true) : undefined, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          result(undefined);
          return;
        }
        const cache = cursor.value as TerminalSessionCache;
        const size = cache.size ?? 0;
        if (
          clear ||
          cache.updatedAt < Date.now() - MAX_AGE ||
          count >= TERMINAL_CACHE_COUNT ||
          bytes + size > TERMINAL_CACHE_BYTES
        ) {
          cursor.delete();
          store.delete(cache.terminalId);
        } else {
          count++;
          bytes += size;
        }
        if (++visited >= 100) result(cursor.key);
        else cursor.continue();
      };
    });
    if (next === undefined) return;
    before = next;
  }
}

let maintenance: Promise<void> = Promise.resolve();
function maintain() {
  maintenance = maintenance.then(() => prune()).catch(() => {});
  return maintenance;
}

export async function readTerminalSessionCache(id: string): Promise<TerminalSessionCache | null> {
  if (!id || typeof indexedDB === "undefined") return null;
  try {
    await migrateMetadata();
    await maintain();
    return await transaction<TerminalSessionCache | null>((store, result, meta) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const cache = request.result as TerminalSessionCache | undefined;
        if (!cache || cache.updatedAt < Date.now() - MAX_AGE) {
          store.delete(id);
          meta.delete(id);
          result(null);
          return;
        }
        cache.updatedAt = Date.now();
        store.put(cache);
        meta.put({
          terminalId: id,
          size: cache.size ?? new TextEncoder().encode(cache.serialized).length,
          updatedAt: cache.updatedAt,
        });
        result(cache);
      };
    });
  } catch {
    return null;
  }
}

type PendingSave = { latest: TerminalSessionCache | null; token?: { valid: boolean }; promise: Promise<void> };
const saves = new Map<string, PendingSave>();
export function writeTerminalSessionCache(cache: TerminalSessionCache, token?: { valid: boolean }): Promise<void> {
  if (!cache.terminalId || typeof indexedDB === "undefined" || token?.valid === false) return Promise.resolve();
  const existing = saves.get(cache.terminalId);
  if (existing) {
    existing.latest = cache;
    existing.token = token;
    return existing.promise;
  }
  const pending: PendingSave = { latest: cache, token, promise: Promise.resolve() };
  saves.set(cache.terminalId, pending);
  pending.promise = (async () => {
    await migrateMetadata();
    while (pending.latest) {
      const next = pending.latest;
      const owner = pending.token;
      pending.latest = null;
      const size = new TextEncoder().encode(next.serialized).length;
      if (size > TERMINAL_CACHE_BYTES || owner?.valid === false) continue;
      const put = () =>
        transaction<void>((store, done, meta) => {
          if (owner?.valid !== false) {
            store.put({ ...next, size });
            meta.put({ terminalId: next.terminalId, updatedAt: next.updatedAt, size });
          }
          done();
        });
      try {
        await put();
      } catch {
        await prune(true);
        await put();
      }
      await maintain();
    }
  })()
    .catch(() => {})
    .finally(() => {
      saves.delete(cache.terminalId);
    });
  return pending.promise;
}

const invalidations =
  typeof window !== "undefined" && typeof window.BroadcastChannel !== "undefined"
    ? new window.BroadcastChannel("VibeGoTerminalCache:delete")
    : null;
if (invalidations)
  invalidations.onmessage = (event) => {
    if (typeof event.data === "string") void removeTerminalSessionCache(event.data);
  };

export async function deleteTerminalSessionCache(id: string): Promise<void> {
  invalidations?.postMessage(id);
  await removeTerminalSessionCache(id);
}

async function removeTerminalSessionCache(id: string): Promise<void> {
  for (const token of owners.get(id) ?? []) token.valid = false;
  const pending = saves.get(id);
  if (pending) {
    pending.latest = null;
    await pending.promise;
  }
  if (!id || typeof indexedDB === "undefined") return;
  try {
    await transaction<void>((store, done, meta) => {
      store.delete(id);
      meta.delete(id);
      done();
    });
  } catch {}
}
