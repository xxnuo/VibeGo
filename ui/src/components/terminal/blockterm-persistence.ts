export interface BlockPersistenceDrainOptions {
  collectIds: () => Iterable<string>;
  flush: (blockId: string) => Promise<unknown>;
  getWriteChain: (blockId: string) => Promise<unknown> | undefined;
  hasPending: (targetIds: Set<string> | undefined) => boolean;
}

export interface BlockPersistenceRetryOptions {
  attempts?: number;
  getDelayMs?: (failedAttempt: number) => number;
  wait?: (delayMs: number) => Promise<void>;
}

export interface BlockTermModelCompensation {
  cancel: () => Promise<unknown>;
  remove: () => Promise<unknown>;
}

export interface ConfirmBlockTermDeleteOptions {
  prepare: () => Promise<unknown>;
  cancel?: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  commit: () => Promise<unknown> | unknown;
}

export type BlockTermPersistenceDisposition = "discard" | "defer" | "schedule";

export function getBlockTermPersistenceDisposition(input: {
  deleted: boolean;
  deleting: boolean;
}): BlockTermPersistenceDisposition {
  if (input.deleted) return "discard";
  return input.deleting ? "defer" : "schedule";
}

export function enqueueBlockPersistence<T>(
  chains: Map<string, Promise<void>>,
  blockId: string,
  operation: () => Promise<T> | T,
  retryOptions?: BlockPersistenceRetryOptions
): Promise<T> {
  const previous = chains.get(blockId) || Promise.resolve();
  const result = previous.then(() => retryBlockPersistence(operation, retryOptions));
  const settledTail = result.then(
    () => {},
    () => {}
  );
  chains.set(blockId, settledTail);
  void settledTail
    .finally(() => {
      if (chains.get(blockId) === settledTail) chains.delete(blockId);
    })
    .catch(() => {});
  return result;
}

export async function compensateUnconfirmedBlockTermModelRun(options: BlockTermModelCompensation): Promise<void> {
  await options.cancel().catch(() => {});
  await options.remove();
}

export function isBlockTermDeleteAlreadyAppliedError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { status?: unknown }).status === 404;
}

export async function confirmBlockTermDelete(options: ConfirmBlockTermDeleteOptions): Promise<void> {
  await options.prepare();
  if (options.cancel) await options.cancel().catch(() => {});
  try {
    await options.remove();
  } catch (error) {
    if (!isBlockTermDeleteAlreadyAppliedError(error)) throw error;
  }
  await options.commit();
}

export function enqueueSessionCommand(
  chains: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<void> | void
): Promise<void> {
  const previous = chains.get(sessionId) || Promise.resolve();
  const result = previous.then(operation);
  const settledTail = result.then(
    () => {},
    () => {}
  );
  chains.set(sessionId, settledTail);
  void settledTail.finally(() => {
    if (chains.get(sessionId) === settledTail) chains.delete(sessionId);
  });
  return result;
}

export function trackConcurrentSessionCommand(
  chains: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<void> | void
): Promise<void> {
  const result = Promise.resolve().then(operation);
  const previous = chains.get(sessionId);
  const settledResult = result.then(
    () => {},
    () => {}
  );
  const aggregate = previous ? Promise.allSettled([previous, settledResult]).then(() => {}) : settledResult;
  chains.set(sessionId, aggregate);
  void aggregate.finally(() => {
    if (chains.get(sessionId) === aggregate) chains.delete(sessionId);
  });
  return result;
}

export async function awaitSessionCommandChain(chains: Map<string, Promise<void>>, sessionId: string): Promise<void> {
  for (;;) {
    const pending = chains.get(sessionId);
    if (!pending) return;
    await pending;
    if (chains.get(sessionId) === pending) return;
  }
}

export interface PersistThenSendCommandOptions {
  persist: () => Promise<unknown>;
  prepareSend: () => boolean;
  send: () => boolean;
  interrupt: () => Promise<unknown> | unknown;
}

export async function persistThenSendCommand(options: PersistThenSendCommandOptions): Promise<"sent" | "interrupted"> {
  await options.persist();
  if (!options.prepareSend() || !options.send()) {
    await options.interrupt();
    return "interrupted";
  }
  return "sent";
}

export function mergeFailedBlockPatch<T extends object>(failedPatch: T, pendingPatch: T | undefined): T {
  return { ...failedPatch, ...pendingPatch };
}

export function isBlockTermTombstoneError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    body?: unknown;
    message?: unknown;
  };
  if (candidate.status !== 409) return false;
  const bodyError =
    candidate.body && typeof candidate.body === "object" ? (candidate.body as { error?: unknown }).error : undefined;
  return (
    bodyError === "block has been deleted" ||
    (bodyError === undefined && candidate.message === "block has been deleted")
  );
}

const waitForRetry = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

export async function retryBlockPersistence<T>(
  operation: () => Promise<T> | T,
  options: BlockPersistenceRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 4));
  const getDelayMs = options.getDelayMs ?? ((failedAttempt) => Math.min(1500, 200 * 2 ** (failedAttempt - 1)));
  const wait = options.wait ?? waitForRetry;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await wait(Math.max(0, getDelayMs(attempt)));
    }
  }

  throw lastError;
}

export async function drainBlockPersistence(
  blockIds: Iterable<string> | undefined,
  options: BlockPersistenceDrainOptions
): Promise<void> {
  const targetIds = blockIds === undefined ? undefined : new Set(blockIds);
  const requestedIds = new Set(targetIds || []);
  const includes = (id: string) => targetIds === undefined || targetIds.has(id);
  for (;;) {
    const ids = new Set(requestedIds);
    for (const id of options.collectIds()) {
      if (includes(id)) ids.add(id);
    }
    for (const id of Array.from(ids)) {
      if (!includes(id)) ids.delete(id);
    }
    if (ids.size === 0) return;

    const writes: Promise<unknown>[] = [];
    for (const id of ids) writes.push(options.flush(id));
    for (const id of ids) {
      const chain = options.getWriteChain(id);
      if (chain) writes.push(chain);
    }
    await Promise.all(writes);

    // Give promise-finally cleanup and synchronous callbacks queued by a
    // completed request a chance to publish another pending patch.
    await Promise.resolve();
    if (!options.hasPending(targetIds)) return;
    requestedIds.clear();
  }
}
