import { BLOCKTERM_OUTPUT_MAX_BYTES } from "./blockterm-output-limits.ts";

export { BLOCKTERM_OUTPUT_MAX_BYTES } from "./blockterm-output-limits.ts";

export type BlockTermOutputStatus = "idle" | "loading" | "ready" | "error";

export interface BlockTermOutputSnapshot {
  status: BlockTermOutputStatus;
  value: string;
  cursor: number | null;
  outputSize: number;
  dirty: boolean;
  revision: number;
  contentRevision: number;
  error: string | null;
}

export interface BlockTermOutputLoadResult {
  value: string;
  cursor: number | null;
}

export type BlockTermOutputLoader = (blockId: string, signal: AbortSignal) => Promise<BlockTermOutputLoadResult>;

export interface BlockTermOutputStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxValueChars?: number;
  maxOutputBytes?: number;
}

interface BlockTermOutputLoad {
  controller: AbortController;
  contentRevision: number;
  promise: Promise<BlockTermOutputSnapshot>;
}

interface BlockTermOutputEntry {
  snapshot: BlockTermOutputSnapshot;
  fullValue: string;
  truncated: boolean;
  durableRevision: number;
  listeners: Set<() => void>;
  pins: Set<string>;
  load: BlockTermOutputLoad | null;
  byteSize: number;
  lastAccess: number;
}

const EMPTY_BLOCKTERM_OUTPUT: BlockTermOutputSnapshot = Object.freeze({
  status: "idle",
  value: "",
  cursor: null,
  outputSize: 0,
  dirty: false,
  revision: 0,
  contentRevision: 0,
  error: null,
});

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_VALUE_CHARS = 200_000;
const BLOCKTERM_OUTPUT_TOO_LARGE = "Block output is too large; output was truncated";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.max(1, Math.trunc(value as number));
}

function normalizeCursor(cursor: number | null): number | null {
  if (cursor === null || !Number.isSafeInteger(cursor) || cursor < 0) return null;
  return cursor;
}

function outputErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Failed to load block output");
}

export class BlockTermOutputStore {
  private readonly entries = new Map<string, BlockTermOutputEntry>();
  private readonly evictedSnapshots = new Map<string, BlockTermOutputSnapshot>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxValueChars: number;
  private readonly maxOutputBytes: number;
  private accessClock = 0;

  constructor(options: BlockTermOutputStoreOptions = {}) {
    this.maxEntries = normalizePositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxValueChars = normalizePositiveInteger(options.maxValueChars, DEFAULT_MAX_VALUE_CHARS);
    this.maxOutputBytes = normalizePositiveInteger(options.maxOutputBytes, BLOCKTERM_OUTPUT_MAX_BYTES);
  }

  getSnapshot = (blockId: string): BlockTermOutputSnapshot =>
    this.entries.get(blockId)?.snapshot ?? this.evictedSnapshots.get(blockId) ?? EMPTY_BLOCKTERM_OUTPUT;

  getFullValue(blockId: string): string {
    return this.entries.get(blockId)?.fullValue ?? this.evictedSnapshots.get(blockId)?.value ?? "";
  }

  subscribe = (blockId: string, listener: () => void): (() => void) => {
    const entry = this.ensureEntry(blockId);
    entry.listeners.add(listener);
    this.touch(entry);
    return () => {
      entry.listeners.delete(listener);
      this.evictIfNeeded();
    };
  };

  prime(blockId: string, outputSize: number, cursor: number | null): BlockTermOutputSnapshot {
    const entry = this.ensureEntry(blockId);
    const measuredSize = Number.isSafeInteger(outputSize) && outputSize >= 0 ? outputSize : 0;
    const nextSize = Math.min(measuredSize, this.maxOutputBytes);
    const nextCursor = normalizeCursor(cursor);
    const currentCursor = entry.snapshot.cursor;

    if (entry.snapshot.dirty) {
      if (nextCursor !== null && (currentCursor === null || nextCursor >= currentCursor)) {
        this.publish(entry, { cursor: nextCursor + 1 });
      }
      return entry.snapshot;
    }
    if (
      entry.snapshot.status === "ready" &&
      entry.snapshot.outputSize === nextSize &&
      entry.snapshot.cursor === nextCursor
    ) {
      return entry.snapshot;
    }

    this.cancelLoad(entry);
    entry.fullValue = "";
    entry.truncated = measuredSize > this.maxOutputBytes;
    entry.durableRevision = entry.snapshot.contentRevision;
    entry.byteSize = 0;
    this.publish(entry, {
      status: nextSize === 0 ? "ready" : "idle",
      value: "",
      cursor: nextCursor,
      outputSize: nextSize,
      dirty: false,
      error: measuredSize > this.maxOutputBytes ? BLOCKTERM_OUTPUT_TOO_LARGE : null,
    });
    this.evictIfNeeded();
    return entry.snapshot;
  }

  hydrate(blockId: string, value: string, cursor: number | null): BlockTermOutputSnapshot {
    const entry = this.ensureEntry(blockId);
    const capped = this.capValue(value);
    const nextValue = this.trimValue(value);
    const nextCursor = normalizeCursor(cursor);
    this.cancelLoad(entry);
    entry.fullValue = capped.value;
    entry.truncated = capped.truncated;
    this.publishContent(
      entry,
      {
        status: "ready",
        value: nextValue,
        cursor: nextCursor,
        outputSize: capped.byteSize,
        dirty: false,
        error: capped.truncated ? BLOCKTERM_OUTPUT_TOO_LARGE : null,
      },
      true
    );
    this.evictIfNeeded();
    return entry.snapshot;
  }

  appendLive(blockId: string, chunk: string, cursor?: number | null): BlockTermOutputSnapshot {
    const entry = this.ensureEntry(blockId);
    const nextCursor = cursor === undefined ? (entry.snapshot.cursor ?? 0) + 1 : normalizeCursor(cursor);
    if (nextCursor !== null && entry.snapshot.cursor !== null && nextCursor <= entry.snapshot.cursor) {
      return entry.snapshot;
    }
    this.cancelLoad(entry);
    const nextValue = this.appendDisplayValue(entry.snapshot.value, chunk);
    const truncatedSize = Math.max(entry.byteSize, entry.snapshot.outputSize);
    const appended = entry.truncated
      ? { value: entry.fullValue, byteSize: truncatedSize, truncated: true, changed: false }
      : this.appendCappedValue(entry.fullValue, entry.byteSize, chunk);
    entry.fullValue = appended.value;
    entry.truncated = appended.truncated;
    this.publishContent(
      entry,
      {
        status: "ready",
        value: nextValue,
        cursor: nextCursor ?? entry.snapshot.cursor,
        outputSize: appended.byteSize,
        dirty: appended.changed || entry.snapshot.dirty,
        error: appended.truncated ? BLOCKTERM_OUTPUT_TOO_LARGE : null,
      },
      appended.changed
    );
    this.evictIfNeeded();
    return entry.snapshot;
  }

  load(blockId: string, loader: BlockTermOutputLoader, force = false): Promise<BlockTermOutputSnapshot> {
    const entry = this.ensureEntry(blockId);
    this.touch(entry);
    if (!force && entry.snapshot.status === "ready") {
      this.evictIfNeeded();
      return Promise.resolve(entry.snapshot);
    }
    if (entry.load) return entry.load.promise;

    const controller = new AbortController();
    const contentRevision = entry.snapshot.contentRevision;
    this.publish(entry, { status: "loading", error: null });

    let loaderPromise: Promise<BlockTermOutputLoadResult>;
    try {
      loaderPromise = loader(blockId, controller.signal);
    } catch (error) {
      loaderPromise = Promise.reject(error);
    }

    const promise = loaderPromise
      .then((result) => {
        const current = this.entries.get(blockId);
        if (
          !current ||
          current !== entry ||
          controller.signal.aborted ||
          current.snapshot.contentRevision !== contentRevision
        ) {
          return current?.snapshot ?? EMPTY_BLOCKTERM_OUTPUT;
        }

        const resultCursor = normalizeCursor(result.cursor);
        if (resultCursor !== null && current.snapshot.cursor !== null && resultCursor < current.snapshot.cursor) {
          this.publish(current, { status: "ready", error: null });
          return current.snapshot;
        }

        const capped = this.capValue(result.value);
        const value = this.trimValue(result.value);
        current.fullValue = capped.value;
        current.truncated = capped.truncated;
        this.publishContent(
          current,
          {
            status: "ready",
            value,
            cursor: resultCursor,
            outputSize: capped.byteSize,
            dirty: false,
            error: capped.truncated ? BLOCKTERM_OUTPUT_TOO_LARGE : null,
          },
          true
        );
        this.evictIfNeeded();
        return current.snapshot;
      })
      .catch((error: unknown) => {
        const current = this.entries.get(blockId);
        if (!current || current !== entry || controller.signal.aborted) {
          return current?.snapshot ?? EMPTY_BLOCKTERM_OUTPUT;
        }
        this.publish(current, { status: "error", error: outputErrorMessage(error) });
        throw error;
      })
      .finally(() => {
        const current = this.entries.get(blockId);
        if (current?.load?.promise === promise) current.load = null;
      });

    entry.load = { controller, contentRevision, promise };
    return promise;
  }

  markPersisted(blockId: string, contentRevision: number): boolean {
    const entry = this.entries.get(blockId);
    if (!entry || contentRevision < entry.durableRevision || contentRevision > entry.snapshot.contentRevision)
      return false;
    if (!entry.snapshot.dirty) return true;
    this.publish(entry, { dirty: false });
    this.evictIfNeeded();
    return true;
  }

  reconcileConflict(
    blockId: string,
    contentRevision: number,
    persisted: BlockTermOutputLoadResult
  ): BlockTermOutputSnapshot | null {
    const entry = this.entries.get(blockId);
    if (!entry || contentRevision < entry.durableRevision || contentRevision > entry.snapshot.contentRevision)
      return null;
    const persistedCursor = normalizeCursor(persisted.cursor);
    const capped = this.capValue(persisted.value);
    if (entry.fullValue === capped.value) {
      this.publish(entry, {
        cursor: persistedCursor,
        dirty: false,
        error: entry.truncated || capped.truncated ? BLOCKTERM_OUTPUT_TOO_LARGE : null,
        status: "ready",
      });
      this.evictIfNeeded();
      return entry.snapshot;
    }
    const nextCursor = Math.max(entry.snapshot.cursor ?? 0, persistedCursor ?? 0) + 1;
    this.publish(entry, {
      cursor: nextCursor,
      dirty: true,
      error: entry.snapshot.error || (capped.truncated ? BLOCKTERM_OUTPUT_TOO_LARGE : null),
      status: "ready",
    });
    return entry.snapshot;
  }

  setPinned(blockId: string, reason: string, pinned: boolean): void {
    const normalizedReason = reason.trim();
    if (!normalizedReason) return;
    const entry = pinned ? this.ensureEntry(blockId) : this.entries.get(blockId);
    if (!entry) return;
    if (pinned) {
      entry.pins.add(normalizedReason);
      this.touch(entry);
    } else {
      entry.pins.delete(normalizedReason);
      this.evictIfNeeded();
    }
  }

  cancelLoads(blockIds?: Iterable<string>): void {
    const ids = blockIds ?? this.entries.keys();
    for (const blockId of ids) {
      const entry = this.entries.get(blockId);
      if (!entry?.load) continue;
      this.cancelLoad(entry);
      this.publish(entry, {
        status: entry.snapshot.outputSize === 0 ? "ready" : "idle",
        error: null,
      });
    }
  }

  delete(blockId: string): void {
    this.evictedSnapshots.delete(blockId);
    const entry = this.entries.get(blockId);
    if (!entry) return;
    this.cancelLoad(entry);
    const listeners = [...entry.listeners];
    this.entries.delete(blockId);
    for (const listener of listeners) this.notify(listener);
  }

  clear(): void {
    const blockIds = new Set([...this.entries.keys(), ...this.evictedSnapshots.keys()]);
    for (const blockId of blockIds) this.delete(blockId);
  }

  has(blockId: string): boolean {
    return this.entries.has(blockId);
  }

  private ensureEntry(blockId: string): BlockTermOutputEntry {
    const existing = this.entries.get(blockId);
    if (existing) return existing;
    const evictedSnapshot = this.evictedSnapshots.get(blockId);
    this.evictedSnapshots.delete(blockId);
    const entry: BlockTermOutputEntry = {
      snapshot: evictedSnapshot ?? { ...EMPTY_BLOCKTERM_OUTPUT },
      fullValue: evictedSnapshot?.value ?? "",
      truncated: evictedSnapshot?.error === BLOCKTERM_OUTPUT_TOO_LARGE,
      durableRevision: evictedSnapshot?.contentRevision ?? 0,
      listeners: new Set(),
      pins: new Set(),
      load: null,
      byteSize: 0,
      lastAccess: 0,
    };
    this.entries.set(blockId, entry);
    this.touch(entry);
    return entry;
  }

  private publish(entry: BlockTermOutputEntry, patch: Partial<BlockTermOutputSnapshot>): void {
    entry.snapshot = {
      ...entry.snapshot,
      ...patch,
      revision: entry.snapshot.revision + 1,
    };
    this.touch(entry);
    for (const listener of entry.listeners) this.notify(listener);
  }

  private publishContent(
    entry: BlockTermOutputEntry,
    patch: Pick<BlockTermOutputSnapshot, "status" | "value" | "cursor" | "outputSize" | "dirty" | "error">,
    durableChanged: boolean
  ): void {
    entry.byteSize = patch.outputSize;
    const contentRevision = entry.snapshot.contentRevision + 1;
    if (durableChanged) entry.durableRevision = contentRevision;
    this.publish(entry, {
      ...patch,
      contentRevision,
    });
  }

  private cancelLoad(entry: BlockTermOutputEntry): void {
    entry.load?.controller.abort();
    entry.load = null;
  }

  private trimValue(value: string): string {
    return value.length <= this.maxValueChars ? value : value.slice(-this.maxValueChars);
  }

  private appendDisplayValue(value: string, chunk: string): string {
    if (chunk.length >= this.maxValueChars) return chunk.slice(-this.maxValueChars);
    const remaining = this.maxValueChars - chunk.length;
    return `${value.length > remaining ? value.slice(-remaining) : value}${chunk}`;
  }

  private appendCappedValue(
    value: string,
    byteSize: number,
    chunk: string
  ): { value: string; byteSize: number; truncated: boolean; changed: boolean } {
    const chunkBytes = textEncoder.encode(chunk);
    const remaining = this.maxOutputBytes - byteSize;
    if (chunkBytes.byteLength <= remaining) {
      return {
        value: value + chunk,
        byteSize: byteSize + chunkBytes.byteLength,
        truncated: false,
        changed: chunkBytes.byteLength > 0,
      };
    }

    const prefixSize = this.utf8PrefixSize(chunkBytes, remaining);
    const prefix = prefixSize > 0 ? textDecoder.decode(chunkBytes.subarray(0, prefixSize)) : "";
    return {
      value: value + prefix,
      byteSize: byteSize + prefixSize,
      truncated: true,
      changed: prefixSize > 0,
    };
  }

  private capValue(value: string): { value: string; byteSize: number; truncated: boolean } {
    const bytes = textEncoder.encode(value);
    if (bytes.byteLength <= this.maxOutputBytes) {
      return { value, byteSize: bytes.byteLength, truncated: false };
    }

    const end = this.utf8PrefixSize(bytes, this.maxOutputBytes);
    return { value: textDecoder.decode(bytes.subarray(0, end)), byteSize: end, truncated: true };
  }

  private utf8PrefixSize(bytes: Uint8Array, maxBytes: number): number {
    if (bytes.byteLength <= maxBytes) return bytes.byteLength;
    if (maxBytes <= 0) return 0;

    let end = maxBytes;
    let start = end - 1;
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
    const first = bytes[start];
    const sequenceLength =
      first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : (first & 0xf8) === 0xf0 ? 4 : 1;
    if (start + sequenceLength > end) end = start;
    return end;
  }

  private touch(entry: BlockTermOutputEntry): void {
    this.accessClock += 1;
    entry.lastAccess = this.accessClock;
  }

  private evictIfNeeded(): void {
    for (;;) {
      let totalBytes = 0;
      for (const entry of this.entries.values()) totalBytes += entry.byteSize;
      if (this.entries.size <= this.maxEntries && totalBytes <= this.maxBytes) return;

      let candidateId: string | null = null;
      let candidate: BlockTermOutputEntry | null = null;
      for (const [blockId, entry] of this.entries) {
        if (
          entry.listeners.size > 0 ||
          entry.pins.size > 0 ||
          entry.snapshot.dirty ||
          entry.snapshot.status === "loading"
        ) {
          continue;
        }
        if (!candidate || entry.lastAccess < candidate.lastAccess) {
          candidateId = blockId;
          candidate = entry;
        }
      }
      if (!candidateId) return;
      candidate?.load?.controller.abort();
      const snapshot = candidate?.snapshot;
      if (snapshot) {
        this.evictedSnapshots.set(candidateId, {
          ...snapshot,
          status: snapshot.status === "ready" ? (snapshot.outputSize === 0 ? "ready" : "idle") : snapshot.status,
          value: "",
          dirty: false,
        });
      }
      this.entries.delete(candidateId);
    }
  }

  private notify(listener: () => void): void {
    try {
      listener();
    } catch {
      // A broken subscriber must not block output delivery to other rows.
    }
  }
}
