export interface BlockTermSessionCloseRequest {
  sessionId: string;
  epoch: number;
  controller: AbortController;
}

export interface BlockTermSessionCloseCommit {
  persist: () => Promise<void>;
  closeTerminal: () => Promise<void>;
  cleanup: () => void;
}

export async function commitBlockTermSessionClose(commit: BlockTermSessionCloseCommit): Promise<void> {
  let persistFailed = false;
  let persistError: unknown;
  try {
    await commit.persist();
  } catch (error) {
    persistFailed = true;
    persistError = error;
  }

  let closeFailed = false;
  let closeError: unknown;
  try {
    // Closing the backend runtime is still required when the final block write
    // fails; otherwise the frontend can retain the session while leaking a PTY.
    await commit.closeTerminal();
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }

  if (persistFailed || closeFailed) {
    if (persistFailed && closeFailed) {
      throw new AggregateError([persistError, closeError], "BlockTerm session close failed");
    }
    if (persistFailed) throw persistError;
    throw closeError;
  }
  commit.cleanup();
}

interface BlockTermSessionCloseQueue {
  epoch: number;
  tail: Promise<void>;
}

export class BlockTermSessionCloseCoordinator {
  private readonly requests = new Map<string, BlockTermSessionCloseRequest>();
  private epoch = 0;
  private queue: BlockTermSessionCloseQueue = { epoch: 0, tail: Promise.resolve() };

  begin(sessionId: string): BlockTermSessionCloseRequest | null {
    const existing = this.requests.get(sessionId);
    if (existing?.epoch === this.epoch) return null;
    const request = {
      sessionId,
      epoch: this.epoch,
      controller: new AbortController(),
    };
    this.requests.set(sessionId, request);
    return request;
  }

  isCurrent(request: BlockTermSessionCloseRequest): boolean {
    return (
      !request.controller.signal.aborted &&
      request.epoch === this.epoch &&
      this.requests.get(request.sessionId) === request
    );
  }

  run(request: BlockTermSessionCloseRequest, task: () => Promise<void>): Promise<void> {
    if (!this.isCurrent(request)) {
      if (this.requests.get(request.sessionId) === request) this.requests.delete(request.sessionId);
      return Promise.resolve();
    }
    let queue = this.queue;
    if (queue.epoch !== request.epoch) {
      queue = { epoch: request.epoch, tail: Promise.resolve() };
      this.queue = queue;
    }
    const invoke = () => (this.isCurrent(request) ? task() : Promise.resolve());
    const queued = queue.tail.then(invoke, invoke);
    const completed = queued.finally(() => {
      if (this.requests.get(request.sessionId) === request) this.requests.delete(request.sessionId);
    });
    queue.tail = completed.catch(() => {});
    return completed;
  }

  reset(): void {
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.epoch += 1;
    this.queue = { epoch: this.epoch, tail: Promise.resolve() };
  }
}
