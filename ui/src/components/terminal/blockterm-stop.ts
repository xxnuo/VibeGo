export type BlockTermSignal = "INT" | "TERM" | "KILL";

export interface BlockTermStopSequence {
  readonly blockId: string;
  readonly done: Promise<void>;
  advance: () => boolean;
  cancel: () => void;
}

export interface BlockTermStopStartResult {
  readonly sent: boolean;
  readonly sequence: BlockTermStopSequence | null;
}

/**
 * Stop escalation as soon as a replacement command is ready to take over the
 * PTY. The interrupted block remains the output-tail owner; only its delayed
 * TERM/KILL timer must be cancelled.
 */
export function cancelBlockTermStopSequence(sequences: Map<string, BlockTermStopSequence>, blockId: string): boolean {
  const sequence = sequences.get(blockId);
  if (!sequence) return false;
  sequence.cancel();
  sequences.delete(blockId);
  return true;
}

export function resolveBlockTermStopToken(
  sessionId: string,
  binding?: { sessionId: string; token: string }
): string | null {
  if (binding?.sessionId !== sessionId || !/^[0-9a-fA-F]{32,128}$/u.test(binding.token)) return null;
  return binding.token;
}

interface BlockTermStopSequenceOptions {
  blockId: string;
  isRunning: (blockId: string) => boolean;
  send: (blockId: string, signal: BlockTermSignal) => boolean;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
  escalationDelayMs?: number;
  signals?: readonly BlockTermSignal[];
  onComplete?: () => void;
}

const STOP_SIGNALS: readonly BlockTermSignal[] = ["INT", "TERM", "KILL"];
const SSH_STOP_SIGNALS: readonly BlockTermSignal[] = ["INT"];

export function resolveBlockTermStopSignals(runtimeType: "local" | "ssh" | undefined): readonly BlockTermSignal[] {
  return runtimeType === "ssh" ? SSH_STOP_SIGNALS : STOP_SIGNALS;
}

export function startBlockTermStop(options: BlockTermStopSequenceOptions): BlockTermStopStartResult {
  const signals = options.signals ?? STOP_SIGNALS;
  if (signals.length === 1) {
    const sent = options.isRunning(options.blockId) && options.send(options.blockId, signals[0]);
    return { sent, sequence: null };
  }
  const sequence = createBlockTermStopSequence(options);
  return { sent: sequence !== null, sequence };
}

export function createBlockTermStopSequence(options: BlockTermStopSequenceOptions): BlockTermStopSequence | null {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clear = options.clear ?? clearTimeout;
  const delayMs = Math.max(0, options.escalationDelayMs ?? 1500);
  const signals = options.signals ?? STOP_SIGNALS;
  let nextSignalIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let completed = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const complete = () => {
    if (cancelled || completed) return;
    completed = true;
    if (timer !== null) clear(timer);
    timer = null;
    options.onComplete?.();
    resolveDone();
  };
  const cancel = () => {
    if (cancelled || completed) return;
    cancelled = true;
    if (timer !== null) clear(timer);
    timer = null;
    resolveDone();
  };

  const scheduleNext = () => {
    if (cancelled || completed) return;
    if (nextSignalIndex >= signals.length) {
      complete();
      return;
    }
    timer = schedule(() => {
      timer = null;
      advance();
    }, delayMs);
  };

  const advance = (): boolean => {
    if (cancelled || completed) return false;
    if (nextSignalIndex >= signals.length) {
      complete();
      return false;
    }
    if (!options.isRunning(options.blockId)) {
      cancel();
      return false;
    }
    if (timer !== null) clear(timer);
    timer = null;
    const signal = signals[nextSignalIndex];
    if (!options.send(options.blockId, signal)) {
      complete();
      return false;
    }
    nextSignalIndex += 1;
    scheduleNext();
    return true;
  };

  const sequence = { blockId: options.blockId, done, advance, cancel };
  return advance() ? sequence : null;
}
