import type { TerminalProcessIdentity } from "@/api/terminal";

export type BlockTermProcessIdentityDecision = "accept" | "continue" | "stop";

export interface BlockTermProcessIdentityGuard {
  tokenMatches: boolean;
  scopeMatches: boolean;
  sessionRunning: boolean;
  blockRunning: boolean;
}

export interface BlockTermProcessIdentityDecisionInput extends BlockTermProcessIdentityGuard {
  identity: TerminalProcessIdentity | null;
  timedOut?: boolean;
}

type BlockTermProcessIdentityTimer = ReturnType<typeof setTimeout>;

export interface BlockTermProcessIdentityTracker {
  cancel: () => void;
  isActive: () => boolean;
}

export interface BlockTermProcessIdentityTrackerOptions {
  load: (signal: AbortSignal) => Promise<TerminalProcessIdentity>;
  guard: () => BlockTermProcessIdentityGuard;
  onAccept: (pid: number, identity: TerminalProcessIdentity) => void;
  signal?: AbortSignal;
  initialDelayMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => BlockTermProcessIdentityTimer;
  clear?: (timer: BlockTermProcessIdentityTimer) => void;
  now?: () => number;
}

const STOPPED_GUARD: BlockTermProcessIdentityGuard = {
  tokenMatches: false,
  scopeMatches: false,
  sessionRunning: false,
  blockRunning: false,
};

export function decideBlockTermProcessIdentity(
  input: BlockTermProcessIdentityDecisionInput
): BlockTermProcessIdentityDecision {
  if (input.timedOut || !input.tokenMatches || !input.scopeMatches || !input.sessionRunning || !input.blockRunning) {
    return "stop";
  }

  const pid = input.identity?.foreground_child_pid;
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0 || pid === input.identity?.shell_pid) return "continue";
  return "accept";
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function startBlockTermProcessIdentityTracker(
  options: BlockTermProcessIdentityTrackerOptions
): BlockTermProcessIdentityTracker {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clear = options.clear ?? clearTimeout;
  const now = options.now ?? Date.now;
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 0);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 50);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 2000);
  const startedAt = now();

  let settled = false;
  let pollTimer: BlockTermProcessIdentityTimer | null = null;
  let timeoutTimer: BlockTermProcessIdentityTimer | null = null;
  let requestController: AbortController | null = null;

  const readGuard = (): BlockTermProcessIdentityGuard => {
    try {
      return options.guard();
    } catch {
      return STOPPED_GUARD;
    }
  };
  const timedOut = () => now() - startedAt >= timeoutMs;
  const onExternalAbort = () => settle();
  const settle = () => {
    if (settled) return;
    settled = true;
    if (pollTimer !== null) clear(pollTimer);
    if (timeoutTimer !== null) clear(timeoutTimer);
    pollTimer = null;
    timeoutTimer = null;
    requestController?.abort();
    requestController = null;
    options.signal?.removeEventListener("abort", onExternalAbort);
  };

  const schedulePoll = (delayMs: number) => {
    if (settled) return;
    pollTimer = schedule(() => {
      pollTimer = null;
      void poll();
    }, delayMs);
  };

  const poll = async () => {
    if (settled) return;
    const beforeLoad = decideBlockTermProcessIdentity({
      ...readGuard(),
      identity: null,
      timedOut: timedOut(),
    });
    if (beforeLoad === "stop") {
      settle();
      return;
    }

    const controller = new AbortController();
    requestController = controller;
    try {
      const identity = await options.load(controller.signal);
      if (settled || requestController !== controller) return;
      requestController = null;
      const decision = decideBlockTermProcessIdentity({
        ...readGuard(),
        identity,
        timedOut: timedOut(),
      });
      if (decision === "accept") {
        const pid = identity.foreground_child_pid;
        settle();
        options.onAccept(pid as number, identity);
        return;
      }
      if (decision === "stop") {
        settle();
        return;
      }
      schedulePoll(pollIntervalMs);
    } catch (error) {
      if (requestController === controller) requestController = null;
      if (settled) return;
      if (controller.signal.aborted || options.signal?.aborted || isAbortError(error)) {
        settle();
        return;
      }
      const decision = decideBlockTermProcessIdentity({
        ...readGuard(),
        identity: null,
        timedOut: timedOut(),
      });
      if (decision === "stop") settle();
      else schedulePoll(pollIntervalMs);
    }
  };

  const tracker: BlockTermProcessIdentityTracker = {
    cancel: settle,
    isActive: () => !settled,
  };

  if (options.signal?.aborted || timeoutMs === 0) {
    settle();
    return tracker;
  }
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  timeoutTimer = schedule(() => {
    timeoutTimer = null;
    settle();
  }, timeoutMs);
  schedulePoll(initialDelayMs);
  return tracker;
}
