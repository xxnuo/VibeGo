/**
 * Small, transport-only helpers for the terminal WebSocket protocol.
 *
 * A terminal that predates routed output has one implicit stream. Routed
 * BlockTerm messages opt into an explicit block/token stream. Keeping the
 * distinction here lets consumers migrate incrementally without accidentally
 * comparing cursors from unrelated streams.
 */

export type BlockTermRouteMode = "legacy" | "block";

export interface BlockTermTerminalRoute {
  terminalId: string;
  mode: BlockTermRouteMode;
  blockId: string | null;
  blockToken: string | null;
  streamKey: string;
}

export type BlockTermRouteError =
  | "terminal_required"
  | "invalid_route_mode"
  | "block_id_required"
  | "block_token_required"
  | "invalid_block_id"
  | "invalid_block_token"
  | "legacy_route_has_block_fields";

export interface BlockTermRouteParseSuccess {
  ok: true;
  route: BlockTermTerminalRoute;
}

export interface BlockTermRouteParseFailure {
  ok: false;
  error: BlockTermRouteError;
}

export type BlockTermRouteParseResult = BlockTermRouteParseSuccess | BlockTermRouteParseFailure;

export interface BlockTermRouteMessage {
  route_mode?: unknown;
  block_id?: unknown;
  block_token?: unknown;
}

export interface BlockTermRouteParseOptions {
  /**
   * Only used when a message has no route fields. The default preserves the
   * historical single-session behavior.
   */
  defaultMode?: BlockTermRouteMode;
}

const BLOCK_TERM_TOKEN_RE = /^[0-9a-fA-F]{32,128}$/u;
const MAX_BLOCK_ID_BYTES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTerminalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBlockId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized !== value) return null;
  if (normalized.includes("\u0000")) return null;
  if (new TextEncoder().encode(normalized).byteLength > MAX_BLOCK_ID_BYTES) return null;
  return normalized;
}

function normalizeBlockToken(value: unknown): string | null {
  return typeof value === "string" && BLOCK_TERM_TOKEN_RE.test(value) ? value : null;
}

function makeStreamKey(
  terminalId: string,
  mode: BlockTermRouteMode,
  blockId: string | null,
  blockToken: string | null
): string {
  if (mode === "legacy") return `session:${terminalId}`;
  // IDs and tokens are validated before this function is called. Separators
  // are therefore unambiguous for the protocol's current identifier grammar.
  return `block:${terminalId}:${blockId}:${blockToken}`;
}

export function getBlockTermTerminalStreamKey(
  route: Pick<BlockTermTerminalRoute, "terminalId" | "mode" | "blockId" | "blockToken">
): string {
  const normalized = createBlockTermTerminalRoute(route.terminalId, route.mode, route.blockId, route.blockToken);
  return normalized.streamKey;
}

export function createBlockTermTerminalRoute(
  terminalId: string,
  mode: BlockTermRouteMode = "legacy",
  blockId?: string | null,
  blockToken?: string | null
): BlockTermTerminalRoute {
  const normalizedTerminalId = normalizeTerminalId(terminalId);
  if (!normalizedTerminalId) throw new TypeError("terminal id is required");
  if (mode === "legacy") {
    if (blockId || blockToken) throw new TypeError("legacy route cannot carry block fields");
    return {
      terminalId: normalizedTerminalId,
      mode,
      blockId: null,
      blockToken: null,
      streamKey: makeStreamKey(normalizedTerminalId, mode, null, null),
    };
  }
  if (mode !== "block") throw new TypeError("invalid route mode");
  const normalizedBlockId = normalizeBlockId(blockId);
  const normalizedBlockToken = normalizeBlockToken(blockToken);
  if (!normalizedBlockId) throw new TypeError("block id is required");
  if (!normalizedBlockToken) throw new TypeError("block token is invalid");
  return {
    terminalId: normalizedTerminalId,
    mode,
    blockId: normalizedBlockId,
    blockToken: normalizedBlockToken,
    streamKey: makeStreamKey(normalizedTerminalId, mode, normalizedBlockId, normalizedBlockToken),
  };
}

/**
 * Parse route fields from a wire message. A pair of block fields without an
 * explicit mode is accepted for transitional servers; an absent pair remains
 * the legacy session route. A partial pair is rejected rather than silently
 * falling back to the session stream.
 */
export function parseBlockTermTerminalRoute(
  terminalId: string,
  message: unknown,
  options: BlockTermRouteParseOptions = {}
): BlockTermRouteParseResult {
  const normalizedTerminalId = normalizeTerminalId(terminalId);
  if (!normalizedTerminalId) return { ok: false, error: "terminal_required" };
  if (!isRecord(message)) {
    const mode = options.defaultMode ?? "legacy";
    if (mode !== "legacy") return { ok: false, error: "invalid_route_mode" };
    return {
      ok: true,
      route: createBlockTermTerminalRoute(normalizedTerminalId),
    };
  }

  const rawMode = message.route_mode;
  const hasMode = rawMode !== undefined && rawMode !== null;
  if (hasMode && rawMode !== "legacy" && rawMode !== "block") {
    return { ok: false, error: "invalid_route_mode" };
  }
  const rawBlockId = message.block_id;
  const rawBlockToken = message.block_token;
  const hasBlockId = rawBlockId !== undefined && rawBlockId !== null && rawBlockId !== "";
  const hasBlockToken = rawBlockToken !== undefined && rawBlockToken !== null && rawBlockToken !== "";

  const mode =
    (rawMode as BlockTermRouteMode | undefined) ??
    (hasBlockId || hasBlockToken ? "block" : (options.defaultMode ?? "legacy"));
  if (mode === "legacy") {
    if (hasBlockId || hasBlockToken) return { ok: false, error: "legacy_route_has_block_fields" };
    return {
      ok: true,
      route: createBlockTermTerminalRoute(normalizedTerminalId),
    };
  }

  if (!hasBlockId) return { ok: false, error: "block_id_required" };
  if (!hasBlockToken) return { ok: false, error: "block_token_required" };
  const blockId = normalizeBlockId(rawBlockId);
  if (!blockId) return { ok: false, error: "invalid_block_id" };
  const blockToken = normalizeBlockToken(rawBlockToken);
  if (!blockToken) return { ok: false, error: "invalid_block_token" };
  return {
    ok: true,
    route: createBlockTermTerminalRoute(normalizedTerminalId, "block", blockId, blockToken),
  };
}

export function isBlockTermTerminalRouteForStream(
  route: BlockTermTerminalRoute,
  candidate: BlockTermTerminalRoute
): boolean {
  return route.streamKey === candidate.streamKey;
}

export interface BlockTermCursorState {
  readonly [streamKey: string]: number;
}

export type BlockTermCursorDecision = "untracked" | "accepted" | "reset" | "duplicate" | "stale";

export interface BlockTermCursorUpdate {
  state: BlockTermCursorState;
  accepted: boolean;
  decision: BlockTermCursorDecision;
  cursor: number | null;
  previousCursor: number | null;
}

function normalizeCursor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Fold one message cursor into an immutable per-stream cursor map.
 *
 * Missing cursors are deliberately untracked so old servers keep working.
 * A lower cursor is accepted only with an explicit reset marker. This means a
 * replay reset on one block stream cannot rewind or deduplicate another.
 */
export function reduceBlockTermStreamCursor(
  state: BlockTermCursorState,
  route: Pick<BlockTermTerminalRoute, "streamKey">,
  rawCursor: unknown,
  reset = false
): BlockTermCursorUpdate {
  const cursor = normalizeCursor(rawCursor);
  const previousCursor = Object.hasOwn(state, route.streamKey) ? state[route.streamKey] : null;
  if (cursor === null) {
    if (reset) {
      return {
        state: clearBlockTermStreamCursor(state, route),
        accepted: true,
        decision: "reset",
        cursor: null,
        previousCursor,
      };
    }
    return { state, accepted: true, decision: "untracked", cursor: null, previousCursor };
  }
  if (reset) {
    return {
      state: { ...state, [route.streamKey]: cursor },
      accepted: true,
      decision: "reset",
      cursor,
      previousCursor,
    };
  }
  if (previousCursor === null || cursor > previousCursor) {
    return {
      state: { ...state, [route.streamKey]: cursor },
      accepted: true,
      decision: "accepted",
      cursor,
      previousCursor,
    };
  }
  return {
    state,
    accepted: false,
    decision: cursor === previousCursor ? "duplicate" : "stale",
    cursor,
    previousCursor,
  };
}

export function getBlockTermStreamCursor(
  state: BlockTermCursorState,
  route: Pick<BlockTermTerminalRoute, "streamKey">
): number | null {
  const cursor = state[route.streamKey];
  return typeof cursor === "number" ? cursor : null;
}

export function clearBlockTermStreamCursor(
  state: BlockTermCursorState,
  route: Pick<BlockTermTerminalRoute, "streamKey">
): BlockTermCursorState {
  if (!Object.hasOwn(state, route.streamKey)) return state;
  const next = { ...state };
  delete next[route.streamKey];
  return next;
}

export interface BlockTermRoutedMessage extends BlockTermRouteMessage {
  type: string;
  route: BlockTermTerminalRoute;
  cursor: number | null;
  reset: boolean;
  data?: string;
}

export type BlockTermMessageParseResult =
  | { ok: true; message: BlockTermRoutedMessage }
  | { ok: false; error: BlockTermRouteError | "invalid_message" | "invalid_cursor" };

/** Normalize a decoded JSON message and attach its canonical stream route. */
export function parseBlockTermTerminalMessage(
  terminalId: string,
  message: unknown,
  options: BlockTermRouteParseOptions = {}
): BlockTermMessageParseResult {
  if (!isRecord(message) || typeof message.type !== "string" || !message.type) {
    return { ok: false, error: "invalid_message" };
  }
  const routeResult = parseBlockTermTerminalRoute(terminalId, message, options);
  if (!routeResult.ok) return routeResult;
  const rawCursor = message.cursor;
  const cursor = rawCursor === undefined || rawCursor === null ? null : normalizeCursor(rawCursor);
  if (rawCursor !== undefined && rawCursor !== null && cursor === null) {
    return { ok: false, error: "invalid_cursor" };
  }
  return {
    ok: true,
    message: {
      ...(routeResult.route.mode === "block" || message.route_mode === "legacy"
        ? { route_mode: routeResult.route.mode }
        : {}),
      ...(routeResult.route.blockId ? { block_id: routeResult.route.blockId } : {}),
      ...(routeResult.route.blockToken ? { block_token: routeResult.route.blockToken } : {}),
      type: message.type,
      route: routeResult.route,
      cursor,
      reset: message.reset === true,
      ...(typeof message.data === "string" ? { data: message.data } : {}),
    },
  };
}

function encodeUtf8Base64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type BlockTermRoutedInputMessage = {
  type: "input";
  data: string;
  route_mode?: "block";
  block_id?: string;
  block_token?: string;
};

export function createBlockTermRoutedInputMessage(
  data: string,
  route: BlockTermTerminalRoute
): BlockTermRoutedInputMessage {
  validateBuilderRoute(route);
  const message: BlockTermRoutedInputMessage = { type: "input", data: encodeUtf8Base64(data) };
  if (route.mode === "block") {
    message.route_mode = "block";
    message.block_id = route.blockId as string;
    message.block_token = route.blockToken as string;
  }
  return message;
}

export type BlockTermRoutedSignalMessage = {
  type: "signal";
  signal: string;
  route_mode?: "block";
  block_id?: string;
  block_token?: string;
};

export function createBlockTermRoutedSignalMessage(
  signal: string,
  route: BlockTermTerminalRoute
): BlockTermRoutedSignalMessage {
  validateBuilderRoute(route);
  const message: BlockTermRoutedSignalMessage = { type: "signal", signal };
  if (route.mode === "block") {
    message.route_mode = "block";
    message.block_id = route.blockId as string;
    message.block_token = route.blockToken as string;
  }
  return message;
}

export type BlockTermRoutedResizeMessage = {
  type: "resize";
  cols: number;
  rows: number;
  route_mode?: "block";
  block_id?: string;
  block_token?: string;
};

/** Build a geometry update without ever silently falling back to the session route. */
export function createBlockTermRoutedResizeMessage(
  cols: number,
  rows: number,
  route: BlockTermTerminalRoute
): BlockTermRoutedResizeMessage {
  validateBuilderRoute(route);
  if (!Number.isSafeInteger(cols) || cols <= 0 || !Number.isSafeInteger(rows) || rows <= 0) {
    throw new TypeError("terminal size is invalid");
  }
  const message: BlockTermRoutedResizeMessage = { type: "resize", cols, rows };
  if (route.mode === "block") {
    message.route_mode = "block";
    message.block_id = route.blockId as string;
    message.block_token = route.blockToken as string;
  }
  return message;
}

function validateBuilderRoute(route: BlockTermTerminalRoute): void {
  if (!route || typeof route !== "object") throw new TypeError("route is required");
  const normalized = createBlockTermTerminalRoute(route.terminalId, route.mode, route.blockId, route.blockToken);
  if (normalized.streamKey !== route.streamKey) throw new TypeError("route stream key is invalid");
}
