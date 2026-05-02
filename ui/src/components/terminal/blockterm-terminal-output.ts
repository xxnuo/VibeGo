export interface BlockTermRawOutputChunk {
  data: Uint8Array;
  startCursor: number | null;
  endCursor: number | null;
}

export interface BlockTermTerminalWrite {
  data: Uint8Array;
  cursor: number | null;
  reset: boolean;
}

export interface BlockTermTerminalBufferSnapshot {
  bufferLength: number;
  cursorY: number;
  isRunning: boolean;
  maxRows: number;
  getLineText: (index: number) => string;
}

export interface BlockTermTerminalCellDimensions {
  cssCellHeight?: number;
  deviceCellHeight?: number;
  devicePixelRatio?: number;
  totalRows: number;
}

export const BLOCKTERM_TERMINAL_MIN_ROWS = 2;
export const BLOCKTERM_TERMINAL_MAX_ROWS = 1024;

/** Keep the furthest completion watermark seen for a mounted or pending view. */
export function mergeBlockTermRawTarget(current: number | null, target: number | null | undefined): number | null {
  const normalizedTarget = target ?? null;
  if (!isValidCursor(normalizedTarget)) return isValidCursor(current) ? current : null;
  if (!isValidCursor(current) || normalizedTarget > current) return normalizedTarget;
  return current;
}

/**
 * Completion cursors include the OSC end frame and therefore cannot be
 * compared with raw segment cursors. A target is complete only after a raw
 * GET issued for that target has crossed the recorder barrier successfully.
 */
export function hasAcknowledgedBlockTermRawTarget(
  acknowledgedTarget: number | null,
  target: number | null | undefined
): boolean {
  const normalizedTarget = target ?? null;
  if (!isValidCursor(normalizedTarget)) return true;
  return isValidCursor(acknowledgedTarget) && acknowledgedTarget >= normalizedTarget;
}

/** @deprecated Completion cursors are not raw segment cursors; use the ack helper above. */
export function hasReachedBlockTermRawTarget(cursor: number | null, target: number | null | undefined): boolean {
  const normalizedTarget = target ?? null;
  if (!isValidCursor(normalizedTarget)) return true;
  return isValidCursor(cursor) && cursor >= normalizedTarget;
}

// The command wrapper disables PTY OPOST so raw output remains byte-exact.
// Restore the normal terminal LF-to-new-line behavior only in xterm display.
export const BLOCKTERM_TERMINAL_CONVERT_EOL = true;

function isValidCursor(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export function shouldUseBlockTermTerminalRenderer(renderer: string | undefined): boolean {
  return !renderer || renderer === "terminal";
}

export function resolveBlockTermTerminalRows(termRows: number, fallbackRows: number): number {
  const fallback =
    Number.isSafeInteger(fallbackRows) && fallbackRows >= BLOCKTERM_TERMINAL_MIN_ROWS
      ? Math.min(BLOCKTERM_TERMINAL_MAX_ROWS, fallbackRows)
      : BLOCKTERM_TERMINAL_MIN_ROWS;
  if (!Number.isSafeInteger(termRows) || termRows < BLOCKTERM_TERMINAL_MIN_ROWS) return fallback;
  return Math.min(BLOCKTERM_TERMINAL_MAX_ROWS, termRows);
}

export function resolveBlockTermTerminalMaxPtySize(maxPtySize: number, fallbackMaxPtySize: number): number {
  const fallback = Number.isSafeInteger(fallbackMaxPtySize) && fallbackMaxPtySize > 0 ? fallbackMaxPtySize : 1;
  if (Number.isSafeInteger(maxPtySize) && maxPtySize > 0) return Math.min(maxPtySize, fallback);
  return fallback;
}

export function getBlockTermTerminalRowsOption(termRows: number, fallbackRows: number): { rows: number } {
  return { rows: resolveBlockTermTerminalRows(termRows, fallbackRows) };
}

export function getBlockTermTerminalInitialUsedRows(flexRows: boolean, isRunning: boolean, maxRows: number): number {
  if (!flexRows) return maxRows;
  return isRunning ? 1 : 0;
}

export function getBlockTermTerminalUsedRows(snapshot: BlockTermTerminalBufferSnapshot): number {
  const maxRows = resolveBlockTermTerminalRows(snapshot.maxRows, BLOCKTERM_TERMINAL_MIN_ROWS);
  if (snapshot.bufferLength > maxRows) return maxRows;

  let usedRows = snapshot.isRunning ? 1 : 0;
  if (snapshot.isRunning && snapshot.cursorY >= usedRows) {
    usedRows = snapshot.cursorY + 1;
  }
  for (let index = maxRows - 1; index >= usedRows; index -= 1) {
    if (snapshot.getLineText(index).trim()) {
      usedRows = index + 1;
      break;
    }
  }
  return Math.min(maxRows, Math.max(0, usedRows));
}

export function resolveBlockTermTerminalUsedRows(
  flexRows: boolean,
  previousRows: number,
  measuredRows: number,
  maxRows: number,
  forceFull: boolean
): number {
  if (!flexRows) return maxRows;
  const previous = Math.min(maxRows, Math.max(0, Math.trunc(previousRows)));
  const measured = Math.min(maxRows, Math.max(0, Math.trunc(measuredRows)));
  if (!forceFull && measured <= previous) return previous;
  return measured;
}

/** Match xterm's device-pixel canvas rounding before deriving a CSS row height. */
export function getBlockTermTerminalCellHeight(dimensions: BlockTermTerminalCellDimensions): number | null {
  const { deviceCellHeight, totalRows } = dimensions;
  const devicePixelRatio = dimensions.devicePixelRatio ?? 1;
  if (
    Number.isFinite(deviceCellHeight) &&
    (deviceCellHeight as number) > 0 &&
    Number.isSafeInteger(totalRows) &&
    totalRows > 0 &&
    Number.isFinite(devicePixelRatio) &&
    devicePixelRatio > 0
  ) {
    return Math.round(((deviceCellHeight as number) * totalRows) / devicePixelRatio) / totalRows;
  }
  return Number.isFinite(dimensions.cssCellHeight) && (dimensions.cssCellHeight as number) > 0
    ? (dimensions.cssCellHeight as number)
    : null;
}

export function getBlockTermTerminalHeight(usedRows: number, totalRows: number, cellHeight: number | null): number {
  if (!Number.isFinite(cellHeight) || (cellHeight as number) <= 0) return 0;
  const rows = Math.min(Math.max(0, Math.trunc(usedRows)), Math.max(0, Math.trunc(totalRows)));
  return Math.ceil((cellHeight as number) * rows);
}

export function appendBlockTermTerminalBytes(existing: Uint8Array, incoming: Uint8Array, maxBytes: number): Uint8Array {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 1;
  if (incoming.length >= limit) return incoming.slice(incoming.length - limit);
  const retainedExisting =
    existing.length > limit - incoming.length ? existing.subarray(existing.length - limit + incoming.length) : existing;
  const combined = new Uint8Array(retainedExisting.length + incoming.length);
  combined.set(retainedExisting);
  combined.set(incoming, retainedExisting.length);
  return combined;
}

/** Prefer the byte-preserving terminal history when a mounted view is rebuilt. */
export function getBlockTermTerminalHydrationValue(raw: Uint8Array | undefined, text: string): Uint8Array | string {
  return raw && raw.length > 0 ? raw : text;
}

export function resolveBlockTermTerminalWrite(
  currentCursor: number | null,
  chunk: BlockTermRawOutputChunk
): BlockTermTerminalWrite {
  const startCursor = isValidCursor(chunk.startCursor) ? chunk.startCursor : null;
  const endCursor = isValidCursor(chunk.endCursor) ? chunk.endCursor : null;
  const current = isValidCursor(currentCursor) ? currentCursor : null;

  if (current === null) {
    return { data: chunk.data, cursor: endCursor, reset: true };
  }
  if (endCursor !== null && endCursor <= current) {
    return { data: new Uint8Array(), cursor: current, reset: false };
  }

  const contiguousRange =
    startCursor !== null &&
    endCursor !== null &&
    endCursor >= startCursor &&
    endCursor - startCursor === chunk.data.length;
  if (!contiguousRange || startCursor > current) {
    return { data: chunk.data, cursor: endCursor, reset: true };
  }

  const overlap = current - startCursor;
  if (overlap <= 0) {
    return { data: chunk.data, cursor: endCursor, reset: false };
  }
  return {
    data: overlap < chunk.data.length ? chunk.data.subarray(overlap) : new Uint8Array(),
    cursor: endCursor,
    reset: false,
  };
}
