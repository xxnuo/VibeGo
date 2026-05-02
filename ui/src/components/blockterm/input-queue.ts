type PendingInput = {
  generation: number;
  send: () => Promise<unknown>;
  allowed: () => boolean;
  onError: (error: unknown) => void;
  size: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

// Input is ephemeral: reconnecting must never replay buffered keystrokes.
export class InputQueue {
  private generation = 0;
  private queue: PendingInput[] = [];
  private draining = false;
  private overloaded = false;
  private pending = 0;
  private size = 0;

  private readonly maxPending: number;
  private readonly maxSize: number;

  constructor(maxPending = 1024, maxSize = 1024 * 1024) {
    this.maxPending = maxPending;
    this.maxSize = maxSize;
  }

  invalidate() {
    this.generation++;
    const discarded = this.queue;
    this.queue = [];
    for (const entry of discarded) {
      this.pending--;
      this.size -= entry.size;
      entry.resolve();
    }
  }

  enqueue(send: () => Promise<unknown>, allowed: () => boolean, onError: (error: unknown) => void, size = 1) {
    if (
      this.overloaded ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      this.pending >= this.maxPending ||
      size > this.maxSize - this.size
    ) {
      this.invalidate();
      this.overloaded = this.draining;
      try {
        onError(new Error("终端输入积压过多，已丢弃未发送输入，请确认当前命令后重试"));
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve();
    }
    this.pending++;
    this.size += size;
    const result = new Promise<void>((resolve, reject) => {
      this.queue.push({ generation: this.generation, send, allowed, onError, size, resolve, reject });
    });
    if (!this.draining) {
      this.draining = true;
      queueMicrotask(() => void this.drain());
    }
    return result;
  }

  private async drain() {
    let entry: PendingInput | undefined;
    while ((entry = this.queue.shift())) {
      let dispatched = false;
      try {
        if (entry.generation === this.generation && entry.allowed()) {
          dispatched = true;
          await entry.send();
        }
      } catch (error) {
        if (entry.generation === this.generation) {
          // The server may have consumed an unacknowledged write. Drop its pending suffix.
          this.invalidate();
          try {
            entry.onError(
              dispatched
                ? new Error(
                    `终端输入发送未确认，部分内容可能已执行；已丢弃未发送输入，请检查终端状态后再操作：${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                  )
                : error
            );
          } catch (handlerError) {
            entry.reject(handlerError);
          }
        }
      } finally {
        this.pending--;
        this.size -= entry.size;
        entry.resolve();
      }
    }
    this.draining = false;
    this.overloaded = false;
  }
}
