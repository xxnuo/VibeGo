export interface ViewSession {
  url: string;
  expiresAt: number | null;
}

export const VIEW_SESSION_RENEW_AHEAD_MS = 60_000;
export const VIEW_SESSION_MAX_ERROR_RETRIES = 2;

export function createSerialExecutor() {
  let tail: Promise<void> = Promise.resolve();
  return function runSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

export function viewSessionRenewDelay(
  session: ViewSession,
  nowMs: number,
  renewAheadMs = VIEW_SESSION_RENEW_AHEAD_MS
): number | null {
  if (session.expiresAt === null) return null;
  return Math.max(0, session.expiresAt * 1_000 - renewAheadMs - nowMs);
}

export function shouldRenewViewSession(
  session: ViewSession,
  nowMs: number,
  renewAheadMs = VIEW_SESSION_RENEW_AHEAD_MS
): boolean {
  return viewSessionRenewDelay(session, nowMs, renewAheadMs) === 0;
}

export function mergeViewSession(
  current: ViewSession | null,
  next: ViewSession
): { session: ViewSession; urlChanged: boolean } {
  const urlChanged = current?.url !== next.url;
  if (!urlChanged && current?.expiresAt === next.expiresAt) {
    return { session: current, urlChanged: false };
  }
  return { session: next, urlChanged };
}

export function viewSessionRetryDelay(attempt: number): number | null {
  if (attempt < 1 || attempt > VIEW_SESSION_MAX_ERROR_RETRIES) return null;
  return 1_000 * 2 ** (attempt - 1);
}

export function viewResourceKey(session: ViewSession, resourceRevision: number): string {
  return `${resourceRevision}:${session.url}`;
}

export function clampMediaRestoreTime(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || currentTime < 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return currentTime;
  return Math.min(currentTime, Math.max(0, duration - 0.05));
}
