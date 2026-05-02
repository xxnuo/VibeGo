export type DialogRequestType = "alert" | "confirm" | "prompt";

export interface DialogRequest {
  id: number;
  type: DialogRequestType;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: "default" | "danger";
  resolve: (value: boolean | string | null) => void;
  signal?: AbortSignal;
  settled: boolean;
  abortCleanup?: () => void;
}

export function getDialogCancelValue(request: DialogRequest): boolean | string | null {
  return request.type === "confirm" ? false : request.type === "prompt" ? null : true;
}

export class DialogRequestQueue {
  private pending: DialogRequest[] = [];
  private active: DialogRequest | null = null;
  private disposed = false;
  private readonly onActiveChange: (request: DialogRequest | null) => void;

  constructor(onActiveChange: (request: DialogRequest | null) => void) {
    this.onActiveChange = onActiveChange;
  }

  mount(): void {
    this.disposed = false;
  }

  enqueue<T>(
    request: DialogRequest,
    abortValue: boolean | string | null,
    mapValue: (value: boolean | string | null) => T
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      request.resolve = (value) => resolve(mapValue(value));
      if (this.disposed || request.signal?.aborted) {
        request.settled = true;
        resolve(mapValue(abortValue));
        return;
      }
      if (request.signal) {
        const onAbort = () => this.finish(request, abortValue);
        request.signal.addEventListener("abort", onAbort, { once: true });
        request.abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.push(request);
      this.activateNext();
    });
  }

  finish(request: DialogRequest, value: boolean | string | null): boolean {
    if (request.settled) return false;
    request.settled = true;
    request.abortCleanup?.();
    request.abortCleanup = undefined;
    request.resolve(value);
    if (this.active === request) {
      this.active = null;
      this.activateNext();
    }
    return true;
  }

  isActive(request: DialogRequest | null): request is DialogRequest {
    return Boolean(request && this.active === request);
  }

  dispose(options: { notifyActiveChange?: boolean } = {}): void {
    this.disposed = true;
    const requests = this.active ? [this.active, ...this.pending] : [...this.pending];
    this.active = null;
    this.pending = [];
    if (options.notifyActiveChange !== false) this.onActiveChange(null);
    for (const request of requests) {
      if (request.settled) continue;
      request.settled = true;
      request.abortCleanup?.();
      request.abortCleanup = undefined;
      request.resolve(getDialogCancelValue(request));
    }
  }

  private activateNext(): void {
    if (this.disposed || this.active) return;
    let next = this.pending.shift();
    while (next?.settled) next = this.pending.shift();
    if (!next) {
      this.onActiveChange(null);
      return;
    }
    this.active = next;
    this.onActiveChange(next);
  }
}
