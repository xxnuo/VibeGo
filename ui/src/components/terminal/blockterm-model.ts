export type BlockStatus = "running" | "streaming" | "success" | "error" | "interrupted";
export type BlockMode = "text" | "terminal";
export type BlockTermKind = "command" | "note" | "renderer";
export type BlockTermCompletionKind = "command" | "file";
export type BlockTermCompletionQuote = "none" | "single" | "double";
export type BlockTermRuntimeType = "local" | "ssh";

/** Connection selected for a command block or for the next submitted block. */
export interface BlockTermConnectionContext {
  runtimeType: BlockTermRuntimeType;
  sshProfileId?: string;
  cwd?: string;
}

export function normalizeBlockTermRuntimeType(value: unknown): BlockTermRuntimeType {
  return value === "ssh" ? "ssh" : "local";
}

export function normalizeBlockTermSSHProfileId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const profileId = value.trim();
  return profileId || undefined;
}

export function normalizeBlockTermConnectionCwd(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

/**
 * Resolve a block's connection without allowing a session-level default to
 * overwrite an explicitly selected block runtime. `next` is intentionally
 * separate because `/connect` changes only future blocks.
 */
export function resolveBlockTermConnectionContext(input: {
  block?: Partial<BlockTermConnectionContext> | null;
  next?: BlockTermConnectionContext | null;
  session: BlockTermConnectionContext;
}): BlockTermConnectionContext {
  const blockRuntime = input.block?.runtimeType;
  const source =
    blockRuntime === "local" || blockRuntime === "ssh"
      ? input.block
      : input.next?.runtimeType === "local" || input.next?.runtimeType === "ssh"
        ? input.next
        : input.session;
  const runtimeType = normalizeBlockTermRuntimeType(source?.runtimeType);
  const profileId = runtimeType === "ssh" ? normalizeBlockTermSSHProfileId(source?.sshProfileId) : undefined;
  const cwd = normalizeBlockTermConnectionCwd(source?.cwd);
  return { runtimeType, ...(profileId ? { sshProfileId: profileId } : {}), ...(cwd ? { cwd } : {}) };
}

export function isSameBlockTermConnectionIdentity(
  left: BlockTermConnectionContext,
  right: BlockTermConnectionContext
): boolean {
  const leftRuntime = normalizeBlockTermRuntimeType(left.runtimeType);
  const rightRuntime = normalizeBlockTermRuntimeType(right.runtimeType);
  if (leftRuntime !== rightRuntime) return false;
  if (leftRuntime === "local") return true;
  return normalizeBlockTermSSHProfileId(left.sshProfileId) === normalizeBlockTermSSHProfileId(right.sshProfileId);
}

/** Keep a cwd only when it belongs to the selected connection identity. */
export function resolveBlockTermConnectionCwd(input: {
  connection: BlockTermConnectionContext;
  current: BlockTermConnectionContext & { cwd: string };
}): string {
  const selectedCwd = normalizeBlockTermConnectionCwd(input.connection.cwd);
  if (selectedCwd) return selectedCwd;
  if (!isSameBlockTermConnectionIdentity(input.connection, input.current)) return ".";
  return input.current.cwd || ".";
}

/**
 * Fill the durable next-connection cwd before persisting a connection change.
 * A cwd from another runtime identity is never portable, so identity changes
 * explicitly use the runtime's home-directory sentinel (".") instead of
 * allowing the server to infer the parent terminal's cwd.
 */
export function resolveBlockTermNextConnectionContext(input: {
  requested: BlockTermConnectionContext;
  current?: BlockTermConnectionContext | null;
  session: BlockTermConnectionContext & { cwd: string };
}): BlockTermConnectionContext {
  const runtimeType = normalizeBlockTermRuntimeType(input.requested.runtimeType);
  const sshProfileId = runtimeType === "ssh" ? normalizeBlockTermSSHProfileId(input.requested.sshProfileId) : undefined;
  const requested: BlockTermConnectionContext = {
    runtimeType,
    ...(sshProfileId ? { sshProfileId } : {}),
    ...(normalizeBlockTermConnectionCwd(input.requested.cwd)
      ? { cwd: normalizeBlockTermConnectionCwd(input.requested.cwd) }
      : {}),
  };
  if (requested.cwd) return requested;

  const current = input.current || input.session;
  const cwd = isSameBlockTermConnectionIdentity(requested, current)
    ? normalizeBlockTermConnectionCwd(current.cwd)
    : isSameBlockTermConnectionIdentity(requested, input.session)
      ? normalizeBlockTermConnectionCwd(input.session.cwd)
      : undefined;
  return { ...requested, cwd: cwd || "." };
}

export type {
  BlockTermCursorDecision,
  BlockTermCursorState,
  BlockTermCursorUpdate,
  BlockTermMessageParseResult,
  BlockTermRoutedInputMessage,
  BlockTermRoutedMessage,
  BlockTermRoutedResizeMessage,
  BlockTermRoutedSignalMessage,
  BlockTermRouteError,
  BlockTermRouteMessage,
  BlockTermRouteMode,
  BlockTermRouteParseOptions,
  BlockTermRouteParseResult,
  BlockTermTerminalRoute,
} from "./blockterm-terminal-protocol.ts";
export {
  clearBlockTermStreamCursor,
  createBlockTermRoutedInputMessage,
  createBlockTermRoutedResizeMessage,
  createBlockTermRoutedSignalMessage,
  createBlockTermTerminalRoute,
  getBlockTermStreamCursor,
  getBlockTermTerminalStreamKey,
  isBlockTermTerminalRouteForStream,
  parseBlockTermTerminalMessage,
  parseBlockTermTerminalRoute,
  reduceBlockTermStreamCursor,
} from "./blockterm-terminal-protocol.ts";

export interface BlockTermCompletionContext {
  draft: string;
  cursor: number;
  prefix: string;
  kind: BlockTermCompletionKind;
  executableOnly: boolean;
  quote: BlockTermCompletionQuote;
  quoteAtTokenEnd: BlockTermCompletionQuote;
  tokenEnd: number;
  hasContentSuffix: boolean;
}

export interface BlockTermCompletionCandidate {
  value: string;
  display: string;
  isDirectory: boolean;
}

export interface BlockTermCompletionEdit {
  draft: string;
  cursor: number;
}

export interface BlockTermShellState {
  cwd: string;
  shellType?: string;
  shellState?: string;
  shellIntegration: boolean;
  lastCommand?: string;
  lastCommandExitCode?: number | null;
}

export interface BlockTermBlock {
  id: string;
  terminalId?: string;
  lineNum?: number;
  kind: BlockTermKind;
  command: string;
  text: string;
  runtimeType: BlockTermRuntimeType;
  sshProfileId?: string;
  output: string;
  outputSize: number;
  outputCursor: number | null;
  cmdPid: number | null;
  remotePid: number | null;
  termCols: number;
  termRows: number;
  termFlexRows: boolean;
  termMaxPtySize: number;
  beforeStateJson?: string;
  afterStateJson?: string;
  status: BlockStatus;
  mode: BlockMode;
  cwd: string;
  exitCode: number | null;
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
  collapsed: boolean;
  pinned: boolean;
  archived: boolean;
  starred: boolean;
  renderer?: string;
  stateJson?: string;
  presentationJson?: string;
}

const BLOCKTERM_MIN_ESTIMATED_HEIGHT = 54;
const BLOCKTERM_MAX_PRESENTATION_HEIGHT = 10_000;
const BLOCKTERM_PRESENTATION_KEYS = new Set(["height", "sidebar", "terminal", "terminal_cols", "terminal_rows"]);

/**
 * Returns a persisted outer block height when the presentation payload has a
 * valid non-negative pixel value. `-1` is WaveTerm's auto-height sentinel and
 * is intentionally treated as unknown so the virtualizer can measure it.
 */
export function getBlockTermPresentationHeight(presentationJson?: string): number | null {
  if (!presentationJson) return null;
  try {
    const value: unknown = JSON.parse(presentationJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const height = (value as { height?: unknown }).height;
    if (!Number.isSafeInteger(height) || (height as number) < 0) return null;
    return Math.min(BLOCKTERM_MAX_PRESENTATION_HEIGHT, height as number);
  } catch {
    return null;
  }
}

function sanitizeBlockTermPresentation(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of BLOCKTERM_PRESENTATION_KEYS) {
    if (!(key in source)) continue;
    const field = source[key];
    if (key === "height") {
      if (
        Number.isSafeInteger(field) &&
        (field as number) >= -1 &&
        (field as number) <= BLOCKTERM_MAX_PRESENTATION_HEIGHT
      ) {
        result[key] = field;
      }
      continue;
    }
    if (key === "terminal_cols" || key === "terminal_rows") {
      const min = key === "terminal_cols" ? 10 : 2;
      if (Number.isSafeInteger(field) && (field as number) >= min && (field as number) <= 1024) {
        result[key] = field;
      }
      continue;
    }
    if (key === "sidebar") {
      if (typeof field === "boolean") {
        result[key] = field;
        continue;
      }
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const sidebar = field as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      if (typeof sidebar.open === "boolean") cleaned.open = sidebar.open;
      if (typeof sidebar.width === "string" && /^([1-9][0-9]{0,3})(px|%)$/u.test(sidebar.width)) {
        const match = sidebar.width.match(/^([1-9][0-9]{0,3})(px|%)$/u);
        const numeric = Number(match?.[1]);
        if ((match?.[2] === "%" && numeric <= 100) || (match?.[2] === "px" && numeric <= 4000)) {
          cleaned.width = sidebar.width;
        }
      }
      for (const lineKey of ["line_id", "sidebarlineid"]) {
        if (
          typeof sidebar[lineKey] === "string" &&
          new TextEncoder().encode(sidebar[lineKey] as string).byteLength <= 256
        ) {
          cleaned[lineKey] = sidebar[lineKey];
        }
      }
      result[key] = cleaned;
      continue;
    }
    if (key === "terminal") {
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const terminal = field as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      if (Number.isSafeInteger(terminal.cols) && (terminal.cols as number) >= 10 && (terminal.cols as number) <= 1024) {
        cleaned.cols = terminal.cols;
      }
      if (Number.isSafeInteger(terminal.rows) && (terminal.rows as number) >= 2 && (terminal.rows as number) <= 1024) {
        cleaned.rows = terminal.rows;
      }
      result[key] = cleaned;
    }
  }
  return result;
}

/** Merge a measured height into the supported presentation object. */
export function setBlockTermPresentationHeight(presentationJson: string | undefined, height: number): string {
  let presentation: Record<string, unknown> = {};
  if (presentationJson) {
    try {
      presentation = sanitizeBlockTermPresentation(JSON.parse(presentationJson));
    } catch {
      // Replace malformed legacy state with a valid minimal presentation object.
    }
  }
  const boundedHeight = Math.min(
    BLOCKTERM_MAX_PRESENTATION_HEIGHT,
    Math.max(0, Math.round(Number.isFinite(height) ? height : 0))
  );
  presentation.height = boundedHeight;
  return JSON.stringify(presentation);
}

/** Keep the virtualizer's fallback estimate in one place for pressure tests. */
export function getBlockTermEstimatedBlockHeight(
  block: Pick<BlockTermBlock, "collapsed" | "mode" | "presentationJson">
): number {
  if (block.collapsed) return BLOCKTERM_MIN_ESTIMATED_HEIGHT;
  const persisted = getBlockTermPresentationHeight(block.presentationJson);
  if (persisted !== null) return Math.max(BLOCKTERM_MIN_ESTIMATED_HEIGHT, persisted);
  return block.mode === "terminal" ? 480 : 120;
}

export interface BlockTermSession {
  id: string;
  name: string;
  tabColor?: string;
  tabIcon?: string;
  cwd: string;
  runtimeType: BlockTermRuntimeType;
  sshProfileId?: string;
  cols: number;
  rows: number;
  shellType?: string;
  shellState?: string;
  shellIntegration: boolean;
  completion: boolean;
  lastCommand?: string;
  lastCommandExitCode?: number | null;
  status: "connecting" | "ready" | "running" | "exited" | "closed";
  blocks: BlockTermBlock[];
  draft: string;
  activeBlockId: string | null;
  selectedBlockId: string | null;
  history: string[];
  historyIndex: number;
  historyDraft: string | null;
}

type BlockTermShellStateSource = Pick<
  BlockTermSession,
  "cwd" | "shellType" | "shellState" | "shellIntegration" | "lastCommand" | "lastCommandExitCode"
>;

export interface BlockTermRuntimeStatePatch {
  current_cwd?: string;
  shell_type?: string;
  shell_state?: string;
  shell_integration?: boolean;
  last_command?: string;
  last_command_exit_code?: number | null;
}

function getBlockTermShellState(
  session: BlockTermShellStateSource,
  patch: Partial<BlockTermShellState> = {}
): BlockTermShellState {
  return {
    cwd: patch.cwd ?? session.cwd,
    shellType: patch.shellType ?? session.shellType,
    shellState: patch.shellState ?? session.shellState,
    shellIntegration: patch.shellIntegration ?? session.shellIntegration,
    lastCommand: patch.lastCommand ?? session.lastCommand,
    lastCommandExitCode:
      patch.lastCommandExitCode !== undefined ? patch.lastCommandExitCode : session.lastCommandExitCode,
  };
}

export function serializeBlockTermShellState(
  session: BlockTermShellStateSource,
  patch: Partial<BlockTermShellState> = {}
): string {
  return JSON.stringify(getBlockTermShellState(session, patch));
}

export function resolveBlockTermInterruptedState(input: {
  session: BlockTermShellStateSource;
  blockId: string;
  activeBlockId?: string | null;
  command?: string;
  phase: "not-sent" | "stop" | "runtime-exit";
}): {
  afterStateJson: string;
  sessionPatch: Partial<
    Pick<
      BlockTermSession,
      "status" | "activeBlockId" | "shellState" | "shellIntegration" | "lastCommand" | "lastCommandExitCode"
    >
  >;
  runtimePatch: BlockTermRuntimeStatePatch | null;
} {
  const active = input.activeBlockId === input.blockId;
  const canContinue = input.phase === "stop" && active;
  const runtimeEnded = input.phase === "runtime-exit";
  const command = input.command || input.session.lastCommand;
  const patch: Partial<BlockTermShellState> = runtimeEnded
    ? {
        shellState: "interrupted",
        shellIntegration: false,
        lastCommand: command,
        lastCommandExitCode: null,
      }
    : canContinue
      ? { shellState: "ready", lastCommand: command, lastCommandExitCode: null }
      : input.phase === "not-sent" && active
        ? { shellState: "ready" }
        : {};
  const state = getBlockTermShellState(input.session, patch);
  const sessionPatch: Partial<
    Pick<
      BlockTermSession,
      "status" | "activeBlockId" | "shellState" | "shellIntegration" | "lastCommand" | "lastCommandExitCode"
    >
  > = {};
  if (runtimeEnded) {
    Object.assign(sessionPatch, {
      activeBlockId: null,
      shellState: state.shellState,
      shellIntegration: state.shellIntegration,
      lastCommand: state.lastCommand,
      lastCommandExitCode: null,
    });
  } else if (canContinue) {
    Object.assign(sessionPatch, {
      status: "ready",
      activeBlockId: null,
      shellState: state.shellState,
      lastCommand: state.lastCommand,
      lastCommandExitCode: null,
    });
  } else if (input.phase === "not-sent" && active) {
    Object.assign(sessionPatch, { status: "ready", activeBlockId: null, shellState: state.shellState });
  }
  const runtimePatch =
    runtimeEnded || canContinue || (input.phase === "not-sent" && active)
      ? {
          current_cwd: state.cwd,
          shell_state: state.shellState,
          shell_integration: state.shellIntegration,
          ...(state.lastCommand ? { last_command: state.lastCommand } : {}),
          last_command_exit_code: state.lastCommandExitCode ?? null,
        }
      : null;
  return {
    afterStateJson: JSON.stringify(state),
    sessionPatch,
    runtimePatch,
  };
}

function formatBlockTermByteSize(value: number): string {
  if (value >= 1024 * 1024 && value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MiB`;
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024} KiB`;
  return `${value} B`;
}

export function getBlockTermLifecycleMetadata(
  block: Pick<BlockTermBlock, "cmdPid" | "remotePid" | "termCols" | "termRows" | "termFlexRows" | "termMaxPtySize">
): string[] {
  const metadata: string[] = [];
  if (block.cmdPid) metadata.push(`process pid ${block.cmdPid}`);
  if (block.remotePid) metadata.push(`remote shell pid ${block.remotePid}`);
  if (block.termCols > 0 && block.termRows > 0) metadata.push(`${block.termCols}x${block.termRows}`);
  else if (block.termCols > 0) metadata.push(`${block.termCols} cols`);
  else if (block.termRows > 0) metadata.push(`${block.termRows} rows`);
  if (block.termFlexRows) metadata.push("flex rows");
  if (block.termMaxPtySize > 0) metadata.push(`pty ${formatBlockTermByteSize(block.termMaxPtySize)}`);
  return metadata;
}

export type BlockNavigationKey = "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";

interface BlockListItem {
  id: string;
}

interface VisibleBlockListItem extends BlockListItem {
  archived: boolean;
  pinned: boolean;
  status?: string;
  starred?: boolean;
}

export function getVisibleOrderedBlocks<T extends VisibleBlockListItem>(
  blocks: readonly T[],
  showArchived: boolean
): T[] {
  return blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => showArchived || !block.archived)
    .sort((left, right) => Number(right.block.pinned) - Number(left.block.pinned) || left.index - right.index)
    .map(({ block }) => block);
}

export function resolveVisibleBlockSelection<T extends BlockListItem>(
  previousBlocks: readonly T[],
  nextBlocks: readonly T[],
  selectedBlockId: string | null
): string | null {
  if (!selectedBlockId) return null;
  if (nextBlocks.some((block) => block.id === selectedBlockId)) return selectedBlockId;
  if (nextBlocks.length === 0) return null;

  const previousIndex = previousBlocks.findIndex((block) => block.id === selectedBlockId);
  if (previousIndex < 0) return nextBlocks[0].id;
  return nextBlocks[Math.min(previousIndex, nextBlocks.length - 1)].id;
}

export function resolveCreatedBlockSelection<T extends BlockListItem>(
  previousBlocks: readonly T[],
  nextBlocks: readonly T[],
  selectedBlockId: string | null,
  createdBlockId: string
): string | null {
  if (nextBlocks.some((block) => block.id === createdBlockId)) return createdBlockId;
  return resolveVisibleBlockSelection(previousBlocks, nextBlocks, selectedBlockId);
}

export function getBlockMutationFocusTarget<T extends VisibleBlockListItem>(
  blocks: readonly T[],
  showArchived: boolean,
  blockId: string,
  patch: Partial<Pick<VisibleBlockListItem, "archived" | "pinned">>,
  filters: { runningOnly?: boolean; starredOnly?: boolean } = {}
): string | null {
  const isVisibleByFilter = (block: T) =>
    (!filters.runningOnly || block.status === "running" || block.status === "streaming") &&
    (!filters.starredOnly || block.starred === true);
  const previousBlocks = getVisibleOrderedBlocks(blocks.filter(isVisibleByFilter), showArchived);
  const nextBlocks = getVisibleOrderedBlocks(
    blocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block)).filter(isVisibleByFilter),
    showArchived
  );
  return resolveVisibleBlockSelection(previousBlocks, nextBlocks, blockId);
}

export function getBlockNavigationTarget<T extends BlockListItem>(
  blocks: readonly T[],
  currentBlockId: string,
  key: BlockNavigationKey,
  pageSize = 1
): string | null {
  if (blocks.length === 0) return null;
  const currentIndex = blocks.findIndex((block) => block.id === currentBlockId);
  if (currentIndex < 0) return null;

  const pageStep = Math.max(1, Math.floor(pageSize));
  let nextIndex = currentIndex;
  switch (key) {
    case "ArrowUp":
      nextIndex -= 1;
      break;
    case "ArrowDown":
      nextIndex += 1;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = blocks.length - 1;
      break;
    case "PageUp":
      nextIndex -= pageStep;
      break;
    case "PageDown":
      nextIndex += pageStep;
      break;
  }
  return blocks[Math.max(0, Math.min(blocks.length - 1, nextIndex))].id;
}

export function navigateBlockHistory(
  state: Pick<BlockTermSession, "draft" | "history" | "historyIndex" | "historyDraft">,
  key: "ArrowUp" | "ArrowDown"
): Pick<BlockTermSession, "draft" | "historyIndex" | "historyDraft"> | null {
  if (state.history.length === 0) return null;
  if (key === "ArrowUp") {
    const nextIndex = state.historyIndex < 0 ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
    return {
      draft: state.history[nextIndex] || "",
      historyIndex: nextIndex,
      historyDraft: state.historyIndex < 0 ? state.draft : state.historyDraft,
    };
  }
  if (state.historyIndex < 0) return null;

  const nextIndex = state.historyIndex + 1;
  if (nextIndex >= state.history.length) {
    return {
      draft: state.historyDraft ?? "",
      historyIndex: -1,
      historyDraft: null,
    };
  }
  return {
    draft: state.history[nextIndex] || "",
    historyIndex: nextIndex,
    historyDraft: state.historyDraft,
  };
}

interface CommandHistoryItem {
  command: string;
}

export function recentCommandHistory(newestFirstEntries: readonly CommandHistoryItem[], limit = 100): string[] {
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (const entry of newestFirstEntries) {
    if (!entry.command.trim() || seen.has(entry.command)) continue;
    seen.add(entry.command);
    newestFirst.push(entry.command);
    if (newestFirst.length >= boundedLimit) break;
  }
  return newestFirst.reverse();
}

export function appendRecentCommand(history: readonly string[], command: string, limit = 100): string[] {
  if (!command.trim()) return [...history];
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];
  return [...history.filter((entry) => entry !== command), command].slice(-boundedLimit);
}

export function shouldRecordBlockTermHistory(kind: BlockTermKind): boolean {
  return kind !== "note";
}

export function parseBlockTermNoteCommand(value: string): { text: string } | null {
  const match = value.match(/^\/(?:note|comment)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { text: (match[1] || "").trim() };
}

export function resolveDraftAfterCommandPublish(
  state: Pick<BlockTermSession, "draft" | "historyIndex" | "historyDraft">,
  submittedCommand: string
): Pick<BlockTermSession, "draft" | "historyIndex" | "historyDraft"> {
  if (state.draft !== submittedCommand) return state;
  return { draft: "", historyIndex: -1, historyDraft: null };
}

export function moveBlockTermCompletionSelection(
  selectedIndex: number,
  candidateCount: number,
  direction: "previous" | "next"
): number {
  if (candidateCount <= 0) return 0;
  const boundedIndex = Math.max(0, Math.min(candidateCount - 1, Math.trunc(selectedIndex)));
  return direction === "previous" ? Math.max(0, boundedIndex - 1) : Math.min(candidateCount - 1, boundedIndex + 1);
}

function isBlockTermShellWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function isBlockTermCommandSeparator(char: string): boolean {
  return char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")";
}

function isBlockTermCompletionUnsafe(char: string): boolean {
  return (
    char === "$" ||
    char === "`" ||
    char === "*" ||
    char === "?" ||
    char === "[" ||
    char === "]" ||
    char === "{" ||
    char === "}" ||
    char === "!"
  );
}

function nextBlockTermCodePoint(value: string, index: number, limit: number): { char: string; next: number } | null {
  if (index >= limit) return null;
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) return null;
  const char = String.fromCodePoint(codePoint);
  const next = index + char.length;
  if (next > limit) return null;
  return { char, next };
}

function scanBlockTermCompletionSuffix(
  draft: string,
  cursor: number,
  initialQuote: BlockTermCompletionQuote
): Pick<BlockTermCompletionContext, "tokenEnd" | "quoteAtTokenEnd" | "hasContentSuffix"> {
  let quote = initialQuote;
  let index = cursor;
  let hasContentSuffix = false;

  while (index < draft.length) {
    const point = nextBlockTermCodePoint(draft, index, draft.length);
    if (!point) break;
    const { char, next } = point;

    if (quote === "single") {
      if (char === "'") quote = "none";
      else hasContentSuffix = true;
      index = next;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = "none";
        index = next;
        continue;
      }
      if (char === "\\") {
        const escaped = nextBlockTermCodePoint(draft, next, draft.length);
        hasContentSuffix = true;
        index = escaped?.next ?? next;
        continue;
      }
      hasContentSuffix = true;
      index = next;
      continue;
    }

    if (isBlockTermShellWhitespace(char) || isBlockTermCommandSeparator(char) || char === "<" || char === ">") {
      break;
    }
    if (char === "'") {
      quote = "single";
      index = next;
      continue;
    }
    if (char === '"') {
      quote = "double";
      index = next;
      continue;
    }
    if (char === "\\") {
      const escaped = nextBlockTermCodePoint(draft, next, draft.length);
      hasContentSuffix = true;
      index = escaped?.next ?? next;
      continue;
    }
    hasContentSuffix = true;
    index = next;
  }

  return { tokenEnd: index, quoteAtTokenEnd: quote, hasContentSuffix };
}

export function parseBlockTermCompletionContext(draft: string, cursor: number): BlockTermCompletionContext | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > draft.length) return null;
  if (cursor > 0) {
    const previous = draft.charCodeAt(cursor - 1);
    const current = cursor < draft.length ? draft.charCodeAt(cursor) : 0;
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return null;
  }

  let quote: BlockTermCompletionQuote = "none";
  let index = 0;
  let prefix = "";
  let wordActive = false;
  let commandExpected = true;
  let redirectTargetPending = false;
  let currentWordIsCommand = true;
  let unsafe = false;

  const startWord = () => {
    if (wordActive) return;
    wordActive = true;
    prefix = "";
    unsafe = false;
    currentWordIsCommand = commandExpected && !redirectTargetPending;
  };
  const finishWord = (consumeCommand = true) => {
    if (!wordActive) return;
    if (redirectTargetPending) {
      redirectTargetPending = false;
    } else if (consumeCommand && commandExpected && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix)) {
      commandExpected = false;
    }
    wordActive = false;
    prefix = "";
    unsafe = false;
    quote = "none";
  };

  while (index < cursor) {
    const point = nextBlockTermCodePoint(draft, index, cursor);
    if (!point) return null;
    const { char, next } = point;

    if (quote === "single") {
      if (char === "'") quote = "none";
      else prefix += char;
      index = next;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = "none";
        index = next;
        continue;
      }
      if (char === "\\") {
        const escaped = nextBlockTermCodePoint(draft, next, cursor);
        if (!escaped) return null;
        if (escaped.char === "$" || escaped.char === "`" || escaped.char === '"' || escaped.char === "\\") {
          prefix += escaped.char;
        } else {
          prefix += `\\${escaped.char}`;
        }
        index = escaped.next;
        continue;
      }
      if (char === "`") return null;
      if (char === "$" || char === "{") unsafe = true;
      prefix += char;
      index = next;
      continue;
    }

    if (isBlockTermShellWhitespace(char)) {
      finishWord();
      index = next;
      continue;
    }
    if (isBlockTermCommandSeparator(char)) {
      if (char === "(" || char === ")") return null;
      finishWord();
      commandExpected = true;
      redirectTargetPending = false;
      index = next;
      continue;
    }
    if (char === "<" || char === ">") {
      const fileDescriptor = wordActive && commandExpected && /^[0-9]+$/.test(prefix);
      finishWord(!fileDescriptor);
      redirectTargetPending = true;
      index = next;
      continue;
    }
    if (char === "#" && !wordActive) return null;

    startWord();
    if (char === "`") return null;
    if (char === "'") {
      quote = "single";
      index = next;
      continue;
    }
    if (char === '"') {
      quote = "double";
      index = next;
      continue;
    }
    if (char === "\\") {
      const escaped = nextBlockTermCodePoint(draft, next, cursor);
      if (!escaped) return null;
      prefix += escaped.char;
      index = escaped.next;
      continue;
    }
    if (isBlockTermCompletionUnsafe(char)) unsafe = true;
    prefix += char;
    index = next;
  }

  if (!wordActive) {
    currentWordIsCommand = commandExpected && !redirectTargetPending;
    prefix = "";
    unsafe = false;
    quote = "none";
  }
  if (unsafe || (currentWordIsCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix))) return null;

  const commandPath = currentWordIsCommand && prefix.includes("/");
  const suffix = scanBlockTermCompletionSuffix(draft, cursor, quote);
  return {
    draft,
    cursor,
    prefix,
    kind: currentWordIsCommand && !commandPath ? "command" : "file",
    executableOnly: commandPath,
    quote,
    ...suffix,
  };
}

function escapeBlockTermCompletionExtension(value: string, quote: BlockTermCompletionQuote): string {
  let result = "";
  for (const char of value) {
    if (quote === "single") {
      result += char === "'" ? "'\\''" : char;
      continue;
    }
    if (quote === "double") {
      result += char === "\\" || char === '"' || char === "$" || char === "`" ? `\\${char}` : char;
      continue;
    }
    const codePoint = char.codePointAt(0) ?? 0;
    const safeASCII =
      (codePoint >= 48 && codePoint <= 57) ||
      (codePoint >= 65 && codePoint <= 90) ||
      (codePoint >= 97 && codePoint <= 122) ||
      "-._/:=+~,@%".includes(char);
    result += safeASCII || codePoint > 127 ? char : `\\${char}`;
  }
  return result;
}

export function applyBlockTermCompletion(
  context: BlockTermCompletionContext,
  value: string,
  complete: boolean,
  isDirectory = false
): BlockTermCompletionEdit | null {
  if (!value.startsWith(context.prefix)) return null;
  const extension = value.slice(context.prefix.length);
  const escaped = escapeBlockTermCompletionExtension(extension, context.quote);
  const before = context.draft.slice(0, context.cursor);
  const after = context.draft.slice(context.cursor);
  const canFinishAtTokenEnd =
    !context.hasContentSuffix &&
    (context.cursor === context.tokenEnd ||
      (context.quote !== "none" && context.quoteAtTokenEnd === "none" && context.tokenEnd > context.cursor));

  if (!complete || isDirectory || !canFinishAtTokenEnd) {
    return { draft: `${before}${escaped}${after}`, cursor: context.cursor + escaped.length };
  }

  const hasExistingClosingQuote =
    context.quote !== "none" && context.quoteAtTokenEnd === "none" && context.tokenEnd > context.cursor;
  if (hasExistingClosingQuote) {
    const middle = context.draft.slice(context.cursor, context.tokenEnd);
    const tail = context.draft.slice(context.tokenEnd);
    const space = tail.length === 0 || !isBlockTermShellWhitespace(tail[0]) ? " " : "";
    return {
      draft: `${before}${escaped}${middle}${space}${tail}`,
      cursor: before.length + escaped.length + middle.length + space.length,
    };
  }

  const closingQuote = context.quote === "single" ? "'" : context.quote === "double" ? '"' : "";
  const space = after.length === 0 || !isBlockTermShellWhitespace(after[0]) ? " " : "";
  const insertion = `${escaped}${closingQuote}${space}`;
  return { draft: `${before}${insertion}${after}`, cursor: context.cursor + insertion.length };
}

export function resolveBlockTermCompletion(
  context: BlockTermCompletionContext,
  candidates: readonly BlockTermCompletionCandidate[],
  commonPrefix: string,
  hasMore = false
): { edit: BlockTermCompletionEdit | null; showCandidates: boolean } {
  if (candidates.length === 0) return { edit: null, showCandidates: false };
  if (candidates.length === 1 && !hasMore) {
    const candidate = candidates[0];
    return {
      edit: applyBlockTermCompletion(context, candidate.value, true, candidate.isDirectory),
      showCandidates: false,
    };
  }
  if (commonPrefix.startsWith(context.prefix) && commonPrefix.length > context.prefix.length) {
    return {
      edit: applyBlockTermCompletion(context, commonPrefix, false),
      showCandidates: false,
    };
  }
  return { edit: null, showCandidates: true };
}

export function createBlockState(input: {
  id: string;
  terminalId?: string;
  lineNum?: number;
  kind?: BlockTermKind;
  command: string;
  text?: string;
  runtimeType?: BlockTermRuntimeType;
  sshProfileId?: string;
  cwd: string;
  mode: BlockMode;
  output?: string;
  status?: BlockStatus;
  createdAt?: number;
  startedAt?: number;
  renderer?: string;
  stateJson?: string;
  presentationJson?: string;
  cmdPid?: number | null;
  remotePid?: number | null;
  termCols?: number;
  termRows?: number;
  termFlexRows?: boolean;
  termMaxPtySize?: number;
  beforeStateJson?: string;
  afterStateJson?: string;
}): BlockTermBlock {
  return {
    id: input.id,
    terminalId: input.terminalId,
    lineNum: input.lineNum,
    kind: input.kind || "command",
    command: input.command,
    text: input.text || "",
    runtimeType: normalizeBlockTermRuntimeType(input.runtimeType),
    ...(input.runtimeType === "ssh" && input.sshProfileId ? { sshProfileId: input.sshProfileId } : {}),
    output: input.output || "",
    outputSize: new TextEncoder().encode(input.output || "").byteLength,
    outputCursor: null,
    cmdPid: input.cmdPid ?? null,
    remotePid: input.remotePid ?? null,
    termCols: input.termCols || 0,
    termRows: input.termRows || 0,
    termFlexRows: input.termFlexRows || false,
    termMaxPtySize: input.termMaxPtySize || 0,
    beforeStateJson: input.beforeStateJson,
    afterStateJson: input.afterStateJson,
    status: input.status || "running",
    mode: input.mode,
    cwd: input.cwd,
    exitCode: null,
    createdAt: input.createdAt ?? input.startedAt ?? Date.now(),
    startedAt: input.startedAt || Date.now(),
    collapsed: false,
    pinned: false,
    archived: false,
    starred: false,
    renderer: input.renderer,
    stateJson: input.stateJson,
    presentationJson: input.presentationJson,
  };
}

export interface ParsedFrame {
  kind: "start" | "end";
  id: string;
  protocolVersion?: "v2" | "v3";
  blockToken?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  shellPid?: number;
}

type BlockTermRunningOwner = Pick<BlockTermBlock, "id" | "terminalId" | "status">;

export interface BlockTermOutputPhaseBinding {
  sessionId: string;
  phase: "expected" | "active";
}

/**
 * Raw PTY data received before the state handshake is reconciled. Keeping the
 * transport bytes (rather than parsed segments) preserves OSC and UTF-8
 * boundaries while the durable block inventory is being restored.
 */
export interface BlockTermPendingChunk {
  data: Uint8Array;
  replay: boolean;
  reset: boolean;
}

export interface BlockTermPendingChunkQueue {
  chunks: BlockTermPendingChunk[];
  bytes: number;
  overflowed: boolean;
}

// The backend history ring is smaller than this in normal deployments. The
// bound also covers a burst of live output while block restoration is pending.
export const BLOCKTERM_HANDSHAKE_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
export const BLOCKTERM_HANDSHAKE_BUFFER_MAX_CHUNKS = 4096;

export function createBlockTermPendingChunkQueue(): BlockTermPendingChunkQueue {
  return { chunks: [], bytes: 0, overflowed: false };
}

/** Queue one transport chunk without allowing unbounded handshake memory. */
export function enqueueBlockTermPendingChunk(queue: BlockTermPendingChunkQueue, chunk: BlockTermPendingChunk): boolean {
  if (queue.overflowed) return false;
  if (
    queue.chunks.length >= BLOCKTERM_HANDSHAKE_BUFFER_MAX_CHUNKS ||
    chunk.data.length > BLOCKTERM_HANDSHAKE_BUFFER_MAX_BYTES - queue.bytes
  ) {
    queue.overflowed = true;
    return false;
  }
  queue.chunks.push({ data: chunk.data.slice(), replay: chunk.replay, reset: chunk.reset });
  queue.bytes += chunk.data.length;
  return true;
}

export function drainBlockTermPendingChunkQueue(queue: BlockTermPendingChunkQueue): {
  chunks: BlockTermPendingChunk[];
  overflowed: boolean;
} {
  const result = { chunks: queue.chunks, overflowed: queue.overflowed };
  queue.chunks = [];
  queue.bytes = 0;
  queue.overflowed = false;
  return result;
}

export interface BlockTermCorrelatedCompletion {
  blockId: string;
  blockToken?: string;
  exitCode: number;
  cwd: string;
  endCursor: number;
}

export interface BlockTermCompletionReconcile {
  blockId: string;
  cwd: string;
  outputEndCursor: number;
  preserveInterrupted: true;
}

export interface BlockTermStateOwnerBinding {
  blockId: string;
  blockToken: string;
  blockPhase: "expected" | "active";
}

export interface BlockTermStateBindings {
  primary: BlockTermStateOwnerBinding | null;
  tail: BlockTermStateOwnerBinding | null;
}

export type BlockTermLocalStateBinding = Pick<BlockTermStateOwnerBinding, "blockId" | "blockToken">;

export function resolveBlockTermOutputOwner(input: {
  sessionId: string;
  activeBlockId?: string | null;
  interruptedBlockId?: string | null;
  transitionBlockId?: string | null;
  activeBlockPhase?: BlockTermOutputPhaseBinding;
  interruptedBlockPhase?: BlockTermOutputPhaseBinding;
  transitionBlockPhase?: BlockTermOutputPhaseBinding;
}): string | null {
  if (
    input.activeBlockId &&
    input.activeBlockPhase?.sessionId === input.sessionId &&
    input.activeBlockPhase.phase === "active"
  ) {
    return input.activeBlockId;
  }
  if (
    input.interruptedBlockId &&
    (!input.interruptedBlockPhase ||
      (input.interruptedBlockPhase.sessionId === input.sessionId && input.interruptedBlockPhase.phase === "active"))
  ) {
    return input.interruptedBlockId;
  }
  if (
    input.transitionBlockId &&
    input.transitionBlockPhase?.sessionId === input.sessionId &&
    input.transitionBlockPhase.phase === "active"
  ) {
    return input.transitionBlockId;
  }
  return null;
}

function getBlockTermOwnedBlock(
  sessionId: string,
  blockId: string,
  blocks: readonly BlockTermRunningOwner[]
): BlockTermRunningOwner | null {
  const block = blocks.find((candidate) => candidate.id === blockId);
  return block?.terminalId === sessionId ? block : null;
}

function isValidBlockTermToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{32,128}$/u.test(value);
}

function resolveBlockTermServerStateBinding(input: {
  sessionId: string;
  serverBlockId: unknown;
  serverBlockToken: unknown;
  serverBlockPhase: unknown;
  blocks: readonly BlockTermRunningOwner[];
}): { binding: BlockTermStateOwnerBinding; status: BlockStatus } | null {
  // The recorder exposes `prepared` while a restart has committed its durable
  // row but the tagged wrapper has not reached the PTY yet. Treat that as the
  // normal expected phase on the client; it must not be mistaken for a stale
  // or interrupted owner during reconnect.
  const normalizedPhase = input.serverBlockPhase === "prepared" ? "expected" : input.serverBlockPhase;
  if (
    typeof input.serverBlockId !== "string" ||
    !isValidBlockTermToken(input.serverBlockToken) ||
    (normalizedPhase !== "expected" && normalizedPhase !== "active")
  ) {
    return null;
  }
  const block = getBlockTermOwnedBlock(input.sessionId, input.serverBlockId, input.blocks);
  if (!block) return null;
  return {
    binding: {
      blockId: input.serverBlockId,
      blockToken: input.serverBlockToken,
      blockPhase: normalizedPhase,
    },
    status: block.status,
  };
}

/**
 * Parse the two independent lifecycle bindings carried by a state snapshot.
 * A primary running block becomes the future/current owner. An explicit
 * interrupted tail remains a separate sink until its end or the primary start
 * boundary. Older servers may report that tail through the primary fields.
 */
export function resolveBlockTermStateBindings(input: {
  sessionId: string;
  terminalStatus: unknown;
  serverBlockId: unknown;
  serverBlockToken: unknown;
  serverBlockPhase: unknown;
  serverTailBlockId?: unknown;
  serverTailBlockToken?: unknown;
  serverTailBlockPhase?: unknown;
  blocks: readonly BlockTermRunningOwner[];
  localPrimaryBinding?: BlockTermLocalStateBinding | null;
  localTailBinding?: BlockTermLocalStateBinding | null;
}): BlockTermStateBindings {
  if (input.terminalStatus !== "running") return { primary: null, tail: null };

  const primaryCandidate = resolveBlockTermServerStateBinding({
    sessionId: input.sessionId,
    serverBlockId: input.serverBlockId,
    serverBlockToken: input.serverBlockToken,
    serverBlockPhase: input.serverBlockPhase,
    blocks: input.blocks,
  });
  const tailCandidate = resolveBlockTermServerStateBinding({
    sessionId: input.sessionId,
    serverBlockId: input.serverTailBlockId,
    serverBlockToken: input.serverTailBlockToken,
    serverBlockPhase: input.serverTailBlockPhase,
    blocks: input.blocks,
  });

  const tokenMatchesLocal = (
    binding: BlockTermStateOwnerBinding,
    localBinding: BlockTermLocalStateBinding | null | undefined
  ): boolean =>
    !localBinding || localBinding.blockId !== binding.blockId || localBinding.blockToken === binding.blockToken;
  const primary =
    primaryCandidate?.status === "running" && tokenMatchesLocal(primaryCandidate.binding, input.localPrimaryBinding)
      ? primaryCandidate.binding
      : null;
  const explicitTail =
    tailCandidate?.status === "interrupted" &&
    tailCandidate.binding.blockPhase === "active" &&
    tokenMatchesLocal(tailCandidate.binding, input.localTailBinding)
      ? tailCandidate.binding
      : null;
  const legacyTail =
    primaryCandidate?.status === "interrupted" &&
    primaryCandidate.binding.blockPhase === "active" &&
    tokenMatchesLocal(primaryCandidate.binding, input.localTailBinding)
      ? primaryCandidate.binding
      : null;
  return {
    primary,
    tail: explicitTail || legacyTail,
  };
}

export interface BlockTermInterruptedStateBinding {
  blockId: string;
  blockToken: string;
  blockPhase: "expected" | "active";
}

export function resolveBlockTermInterruptedStateBinding(input: {
  sessionId: string;
  currentActiveBlockId?: string | null;
  localBlockToken?: string;
  terminalStatus: unknown;
  serverBlockId: unknown;
  serverBlockToken: unknown;
  serverBlockPhase: unknown;
  blocks: readonly BlockTermRunningOwner[];
}): BlockTermInterruptedStateBinding | null {
  const normalizedPhase = input.serverBlockPhase === "prepared" ? "expected" : input.serverBlockPhase;
  if (
    input.terminalStatus !== "running" ||
    typeof input.serverBlockId !== "string" ||
    !isValidBlockTermToken(input.serverBlockToken) ||
    (normalizedPhase !== "expected" && normalizedPhase !== "active") ||
    (input.currentActiveBlockId && input.currentActiveBlockId !== input.serverBlockId) ||
    (input.localBlockToken && input.localBlockToken !== input.serverBlockToken)
  ) {
    return null;
  }
  const block = getBlockTermOwnedBlock(input.sessionId, input.serverBlockId, input.blocks);
  if (block?.status !== "interrupted") return null;
  return {
    blockId: input.serverBlockId,
    blockToken: input.serverBlockToken,
    blockPhase: normalizedPhase,
  };
}

export function shouldInterruptBlockTermStateBinding(input: {
  blockId?: string | null;
  activeBlockId?: string | null;
  blockStatus?: BlockStatus;
}): boolean {
  return Boolean(input.blockId && input.blockStatus === "running" && input.activeBlockId === input.blockId);
}

function isCurrentRunningBlockTermOwner(input: {
  sessionId: string;
  blockId: unknown;
  activeBlockId?: string | null;
  activeBlockStatus?: BlockStatus;
  blocks: readonly BlockTermRunningOwner[];
}): boolean {
  if (
    typeof input.blockId !== "string" ||
    input.activeBlockId !== input.blockId ||
    input.activeBlockStatus !== "running"
  ) {
    return false;
  }
  const block = input.blocks.find((candidate) => candidate.id === input.blockId);
  return Boolean(block && block.status === "running" && block.terminalId === input.sessionId);
}

export function shouldHandleBlockTermInputRejected(input: {
  sessionId: string;
  blockId: unknown;
  blockToken?: unknown;
  reason?: unknown;
  activeBlockId?: string | null;
  activeBlockToken?: string;
  activeBlockStatus?: BlockStatus;
  blocks: readonly BlockTermRunningOwner[];
}): boolean {
  // A failed runtime signal did not terminate the command. Keep its binding
  // and running state so the next state/end frame can reconcile it normally.
  if (input.reason === "runtime_signal_failed") return false;
  return (
    isCurrentRunningBlockTermOwner(input) &&
    isValidBlockTermToken(input.activeBlockToken) &&
    isValidBlockTermToken(input.blockToken) &&
    input.blockToken === input.activeBlockToken
  );
}

/**
 * Returns whether a signal-failure NACK belongs to the block that Stop
 * optimistically interrupted. A failed signal leaves the runtime binding live,
 * so the caller must restore the local interrupted transition instead of
 * treating the NACK as a command completion.
 */
export function shouldRestoreBlockTermSignalFailure(input: {
  sessionId: string;
  blockId: unknown;
  blockToken?: unknown;
  reason?: unknown;
  activeBlockId?: string | null;
  activeBlockToken?: string;
  activeBlockStatus?: BlockStatus;
  interruptedOutputBlockId?: string | null;
  stopPending: boolean;
  blocks: readonly BlockTermRunningOwner[];
}): boolean {
  if (
    input.reason !== "runtime_signal_failed" ||
    !input.stopPending ||
    input.activeBlockStatus !== "interrupted" ||
    input.interruptedOutputBlockId !== input.blockId ||
    typeof input.blockId !== "string" ||
    input.activeBlockId !== input.blockId ||
    !isValidBlockTermToken(input.blockToken) ||
    !isValidBlockTermToken(input.activeBlockToken) ||
    input.blockToken !== input.activeBlockToken
  ) {
    return false;
  }
  const block = input.blocks.find((candidate) => candidate.id === input.blockId);
  return Boolean(block && block.terminalId === input.sessionId);
}

export function shouldSeedBlockTermToken(input: {
  sessionId: string;
  blockId: unknown;
  blockToken: unknown;
  activeBlockId?: string | null;
  activeBlockStatus?: BlockStatus;
  blocks: readonly BlockTermRunningOwner[];
}): input is typeof input & { blockId: string; blockToken: string } {
  return isValidBlockTermToken(input.blockToken) && isCurrentRunningBlockTermOwner(input);
}

export function resolveBlockTermStateBinding(input: {
  sessionId: string;
  activeBlockId?: string | null;
  activeBlockStatus?: BlockStatus;
  blocks: readonly BlockTermRunningOwner[];
  localBlockToken?: string;
  serverBlockId: unknown;
  serverBlockToken: unknown;
}): { action: "ignore" | "interrupt" } | { action: "bind"; blockToken: string } {
  const serverBlockToken = input.serverBlockToken;
  if (
    !input.activeBlockId ||
    !isCurrentRunningBlockTermOwner({
      sessionId: input.sessionId,
      blockId: input.activeBlockId,
      activeBlockId: input.activeBlockId,
      activeBlockStatus: input.activeBlockStatus,
      blocks: input.blocks,
    })
  ) {
    return { action: "ignore" };
  }
  if (
    shouldSeedBlockTermToken({
      sessionId: input.sessionId,
      blockId: input.serverBlockId,
      blockToken: serverBlockToken,
      activeBlockId: input.activeBlockId,
      activeBlockStatus: input.activeBlockStatus,
      blocks: input.blocks,
    })
  ) {
    if (input.localBlockToken && input.localBlockToken !== serverBlockToken) {
      return { action: "interrupt" };
    }
    return { action: "bind", blockToken: serverBlockToken as string };
  }
  return { action: "interrupt" };
}

export function resolveBlockTermCorrelatedCompletions(input: {
  sessionId: string;
  completions: unknown;
  blocks: readonly BlockTermRunningOwner[];
}): BlockTermCorrelatedCompletion[] {
  if (!Array.isArray(input.completions)) return [];
  const completableBlockIds = new Set(
    input.blocks
      .filter(
        (block) =>
          block.terminalId === input.sessionId && (block.status === "running" || block.status === "interrupted")
      )
      .map((block) => block.id)
  );
  const resolved = new Map<string, BlockTermCorrelatedCompletion>();
  for (const value of input.completions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const completion = value as Record<string, unknown>;
    const blockId = completion.block_id;
    const blockToken = completion.block_token;
    const exitCode = completion.exit_code;
    const cwd = completion.cwd;
    const endCursor = completion.end_cursor;
    if (
      typeof blockId !== "string" ||
      blockId.length === 0 ||
      blockId.length > 256 ||
      blockId.trim() !== blockId ||
      blockId.includes("\0") ||
      !completableBlockIds.has(blockId) ||
      (blockToken !== undefined && !isValidBlockTermToken(blockToken)) ||
      !Number.isSafeInteger(exitCode) ||
      (exitCode as number) < 0 ||
      (exitCode as number) > 255 ||
      typeof cwd !== "string" ||
      cwd.length > 16_384 ||
      !Number.isSafeInteger(endCursor) ||
      (endCursor as number) <= 0
    ) {
      continue;
    }
    const correlated = {
      blockId,
      ...(typeof blockToken === "string" ? { blockToken } : {}),
      exitCode: exitCode as number,
      cwd,
      endCursor: endCursor as number,
    };
    const previous = resolved.get(blockId);
    if (!previous || previous.endCursor < correlated.endCursor) resolved.set(blockId, correlated);
  }
  return Array.from(resolved.values()).sort((left, right) => left.endCursor - right.endCursor);
}

/**
 * Build the completion-only plan for a durable interrupted command. The
 * caller may restore output through `outputEndCursor` and cwd, but must keep
 * the interrupted status and null exit code.
 */
export function resolveBlockTermCompletionReconcile(input: {
  sessionId: string;
  completion: BlockTermCorrelatedCompletion;
  blocks: readonly BlockTermRunningOwner[];
}): BlockTermCompletionReconcile | null {
  const completion = input.completion;
  if (
    !completion ||
    typeof completion.blockId !== "string" ||
    completion.blockId.length === 0 ||
    completion.blockId.length > 256 ||
    completion.blockId.trim() !== completion.blockId ||
    completion.blockId.includes("\0") ||
    !Number.isSafeInteger(completion.exitCode) ||
    completion.exitCode < 0 ||
    completion.exitCode > 255 ||
    typeof completion.cwd !== "string" ||
    completion.cwd.length > 16_384 ||
    !Number.isSafeInteger(completion.endCursor) ||
    completion.endCursor <= 0
  ) {
    return null;
  }
  const block = getBlockTermOwnedBlock(input.sessionId, completion.blockId, input.blocks);
  if (block?.status !== "interrupted") return null;
  return {
    blockId: completion.blockId,
    cwd: completion.cwd,
    outputEndCursor: completion.endCursor,
    preserveInterrupted: true,
  };
}

export interface BlockTermFrameHandlingInput {
  frame: ParsedFrame;
  replay: boolean;
  sessionId: string;
  activeBlockId?: string | null;
  interruptedBlockId?: string | null;
  /**
   * A state-handshake primary that is waiting for its buffered start marker.
   * The ordinary active owner remains in place until that exact marker is
   * consumed, so bytes before it can still complete the previous owner.
   */
  pendingBlockId?: string | null;
  pendingBlockToken?: string;
  pendingBlockPhase?: BlockTermOutputPhaseBinding;
  /**
   * The previous running owner while a handshake has already published a new
   * primary. Its token-fenced end is still valid even though it is no longer
   * the session active owner.
   */
  transitionBlockId?: string | null;
  transitionBlockToken?: string;
  transitionBlockPhase?: BlockTermOutputPhaseBinding;
  activeBlockPhase?: BlockTermOutputPhaseBinding;
  interruptedBlockPhase?: BlockTermOutputPhaseBinding;
  blocks: readonly BlockTermRunningOwner[];
  blockToken?: string;
}

export type BlockTermFrameDisposition =
  | { accepted: false }
  | {
      accepted: true;
      action:
        | "activate-running"
        | "activate-pending-running"
        | "activate-interrupted"
        | "complete-running"
        | "complete-pending-running"
        | "complete-transition-running"
        | "reconcile-interrupted";
    };

export function resolveBlockTermFrameDisposition(input: BlockTermFrameHandlingInput): BlockTermFrameDisposition {
  const owner = getBlockTermOwnedBlock(input.sessionId, input.frame.id, input.blocks);
  if (!owner) return { accepted: false };

  // During a state handshake the new primary may have a start marker in the
  // FIFO while the old active owner is still published locally. Accept only
  // that exact token-fenced start and let the caller switch the owner at the
  // marker boundary.
  if (
    owner.status === "running" &&
    input.pendingBlockId === input.frame.id &&
    input.pendingBlockToken === input.frame.blockToken &&
    input.pendingBlockPhase?.sessionId === input.sessionId &&
    input.frame.protocolVersion === "v3" &&
    isValidBlockTermToken(input.frame.blockToken)
  ) {
    if (input.pendingBlockPhase.phase === "expected" && input.frame.kind === "start") {
      return { accepted: true, action: "activate-pending-running" };
    }
    if (input.pendingBlockPhase.phase === "active" && input.frame.kind === "end") {
      return { accepted: true, action: "complete-pending-running" };
    }
  }

  // A state snapshot can publish a newer primary before replay has delivered
  // the previous owner's end frame. Preserve that end as a detached,
  // token-fenced completion; it must not be confused with arbitrary stale
  // frames for the same durable block id.
  if (
    owner.status === "running" &&
    input.transitionBlockId === input.frame.id &&
    input.transitionBlockToken === input.frame.blockToken &&
    input.transitionBlockPhase?.sessionId === input.sessionId &&
    input.transitionBlockPhase.phase === "active" &&
    input.frame.protocolVersion === "v3" &&
    input.frame.kind === "end" &&
    isValidBlockTermToken(input.frame.blockToken)
  ) {
    return { accepted: true, action: "complete-transition-running" };
  }

  if (owner.status === "interrupted") {
    const interruptedPhase =
      input.interruptedBlockPhase ||
      (input.interruptedBlockId === input.activeBlockId ? input.activeBlockPhase : undefined);
    if (
      input.interruptedBlockId !== input.frame.id ||
      input.frame.protocolVersion !== "v3" ||
      !interruptedPhase ||
      interruptedPhase.sessionId !== input.sessionId
    ) {
      return { accepted: false };
    }
    if (!isValidBlockTermToken(input.frame.blockToken)) return { accepted: false };
    if (!input.blockToken || input.blockToken !== input.frame.blockToken) return { accepted: false };
    if (interruptedPhase.phase === "expected" && input.frame.kind === "start") {
      const primaryAlreadyActive =
        input.activeBlockId &&
        input.activeBlockId !== input.frame.id &&
        input.activeBlockPhase?.sessionId === input.sessionId &&
        input.activeBlockPhase.phase === "active";
      if (primaryAlreadyActive) return { accepted: false };
      return { accepted: true, action: "activate-interrupted" };
    }
    if (interruptedPhase.phase === "active" && input.frame.kind === "end") {
      return { accepted: true, action: "reconcile-interrupted" };
    }
    return { accepted: false };
  }
  if (
    owner.status !== "running" ||
    input.activeBlockId !== input.frame.id ||
    input.activeBlockPhase?.sessionId !== input.sessionId ||
    input.frame.protocolVersion !== "v3"
  )
    return { accepted: false };
  if (!isValidBlockTermToken(input.frame.blockToken)) return { accepted: false };
  if (!input.blockToken || input.blockToken !== input.frame.blockToken) return { accepted: false };
  if (input.activeBlockPhase.phase === "expected" && input.frame.kind === "start") {
    return { accepted: true, action: "activate-running" };
  }
  if (input.activeBlockPhase.phase === "active" && input.frame.kind === "end") {
    return { accepted: true, action: "complete-running" };
  }
  return { accepted: false };
}

/**
 * Compatibility projection for callers that still finalize every accepted end
 * frame. Replay ends for interrupted blocks stay rejected here until those
 * callers migrate to the status-preserving disposition API.
 */
export function resolveBlockTermFrameAcceptance(input: BlockTermFrameHandlingInput): { accepted: boolean } {
  // Older callers supplied the phase for the frame's block through
  // `activeBlockPhase`, even when a newer primary block had already replaced
  // it. Preserve that shape while new callers use the explicit tail phase.
  const legacyInput =
    input.interruptedBlockId &&
    !input.interruptedBlockPhase &&
    input.activeBlockPhase?.sessionId === input.sessionId &&
    input.activeBlockPhase.phase === "active"
      ? { ...input, interruptedBlockPhase: input.activeBlockPhase }
      : input;
  const disposition = resolveBlockTermFrameDisposition(legacyInput);
  return {
    accepted: disposition.accepted && !(input.replay && disposition.action === "reconcile-interrupted"),
  };
}

export function resolveBlockTermStartActivation(input: {
  accepted: boolean;
  frame: ParsedFrame;
  sessionId: string;
}): BlockTermOutputPhaseBinding | null {
  if (!input.accepted || input.frame.kind !== "start") return null;
  return { sessionId: input.sessionId, phase: "active" };
}

export function shouldRouteRejectedBlockTermFrame(replay: boolean): boolean {
  return !replay;
}

export function enqueueBlockTermMessageTask(previous: Promise<void>, task: () => Promise<void> | void): Promise<void> {
  return previous.then(task, task).then(
    () => {},
    () => {}
  );
}

export type TerminalSegment =
  | { type: "text"; value: string; hasTuiSequence: boolean }
  | { type: "frame"; frame: ParsedFrame };

export const MARK_PREFIX = "__VIBEGO_BLOCKTERM__";
export const ESC = String.fromCharCode(27);
export const BEL = String.fromCharCode(7);
export const OSC_SEQUENCE_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
export const CSI_SEQUENCE_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
export const CHARSET_SEQUENCE_RE = new RegExp(`${ESC}[()][A-Za-z0-9]`, "g");
export const TUI_SEQUENCE_RE = new RegExp(`${ESC}\\[\\?(?:47|1047|1049)h`);
export const MAX_TEXT_OUTPUT_LENGTH = 200_000;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export const TUI_COMMANDS = new Set([
  "btop",
  "fzf",
  "htop",
  "k9s",
  "lazygit",
  "less",
  "man",
  "more",
  "nano",
  "nvim",
  "screen",
  "ssh",
  "tig",
  "tmux",
  "top",
  "vi",
  "vim",
]);

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateBlockTermToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeUtf8Base64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

export function createBlockTermInputMessage(
  data: string,
  blockId?: string,
  blockToken?: string
): { type: "input"; data: string; block_id?: string; block_token?: string } {
  const message: { type: "input"; data: string; block_id?: string; block_token?: string } = {
    type: "input",
    data: encodeUtf8Base64(data),
  };
  if (blockId && blockToken) {
    message.block_id = blockId;
    message.block_token = blockToken;
  }
  return message;
}

export function createBlockTermSignalMessage(
  signal: "INT" | "TERM" | "KILL",
  blockId: string,
  blockToken?: string
): { type: "signal"; signal: "INT" | "TERM" | "KILL"; block_id: string; block_token?: string } {
  return {
    type: "signal",
    signal,
    block_id: blockId,
    ...(blockToken ? { block_token: blockToken } : {}),
  };
}

export function decodeBase64Utf8(data: string, decoder: TextDecoder): string {
  return decoder.decode(decodeBase64Bytes(data), { stream: true });
}

/** Decode transport Base64 without passing the payload through a JS string. */
export function decodeBase64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Flush a streaming UTF-8 decoder and start a fresh decoding scope. */
export function flushTerminalProjectionDecoder(state: { decoder: TextDecoder }): string {
  let tail = "";
  try {
    tail = state.decoder.decode();
  } catch {
    // The decoder is non-fatal, but teardown must tolerate browser differences.
  }
  state.decoder = new TextDecoder("utf-8", { fatal: false });
  return tail;
}

/**
 * Take bytes buffered by the OSC parser before clearing both parser and
 * decoder state. The bytes are intentionally returned verbatim so callers can
 * publish an unterminated OSC sequence as ordinary PTY output during teardown.
 */
export function takeTerminalParserTail(state: { decoder: TextDecoder; parseBuffer: string | Uint8Array }): {
  raw: Uint8Array;
  projection: string;
} {
  const raw =
    typeof state.parseBuffer === "string" ? new TextEncoder().encode(state.parseBuffer) : state.parseBuffer.slice();
  const projection = flushTerminalProjectionDecoder(state);
  state.parseBuffer = typeof state.parseBuffer === "string" ? "" : new Uint8Array();
  return { raw, projection };
}

export function discardTerminalParserTail(state: { decoder: TextDecoder; parseBuffer: string | Uint8Array }): void {
  takeTerminalParserTail(state);
}

export function decodeBase64Text(data: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

export function escapeShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function encodeShellPrintfBytes(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
}

/**
 * A leading `exec <command>` would replace the persistent PTY shell before
 * the wrapper can restore its tty state or emit the end frame. Run that one
 * command as a child instead. Other shell state mutations still execute in
 * the persistent shell because the surrounding command is not subshelled.
 */
export function guardLeadingBlockTermExec(command: string): string {
  const match = /^([\t\r\n ]*)exec(?=[\t ]+)/.exec(command);
  if (!match) return command;
  const remainder = command.slice(match[0].length).trimStart();
  if (!remainder || remainder.startsWith("-") || remainder.startsWith(">") || remainder.startsWith("<")) return command;
  return `${match[1]}command${command.slice(match[0].length)}`;
}

export function buildWrappedCommand(command: string, blockId: string, blockToken: string): string {
  const userCommand = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const executableCommand = guardLeadingBlockTermExec(userCommand);
  const id = escapeShellSingleQuoted(blockId);
  const token = escapeShellSingleQuoted(blockToken);
  const historyTokenPattern = `*${token}*`;
  const prefix = escapeShellSingleQuoted(MARK_PREFIX);
  const command64 = escapeShellSingleQuoted(encodeUtf8Base64(userCommand));
  const commandBytes = escapeShellSingleQuoted(encodeShellPrintfBytes(executableCommand));
  // zsh reads user startup files after command-line options, so .zshrc may
  // disable HIST_IGNORE_SPACE again. Install a history hook in this token-free
  // line; the hook runs before each command is saved and rejects the wrapper
  // by its public marker, regardless of the current option state.
  const zshHistoryGuard =
    `function __vibego_blockterm_history_guard { case "$1" in *__VIBEGO_BLOCKTERM__*) return 1;; esac; return 0; }; ` +
    `builtin typeset -ga zshaddhistory_functions 2>/dev/null || :; ` +
    `zshaddhistory_functions=(__vibego_blockterm_history_guard "\${(@)zshaddhistory_functions[@]:#__vibego_blockterm_history_guard}");`;
  const zshHistoryPrelude =
    ` if [ -n "\${ZSH_VERSION-}" ]; then builtin eval ${escapeShellSingleQuoted(zshHistoryGuard)}; ` +
    `builtin setopt HIST_IGNORE_SPACE 2>/dev/null || :; fi`;
  const wrapped = [
    // Keep the wrapper out of Bash history even when the user's startup
    // files did not configure HISTCONTROL. The token is only a lifecycle
    // correlation value; a process sharing this PTY can still inspect it.
    `if [ -n "\${BASH_VERSION-}" ]; then builtin trap - DEBUG RETURN 2>/dev/null || :; fi`,
    `if [ -n "\${ZSH_VERSION-}" ]; then builtin unfunction TRAPDEBUG TRAPRETURN 2>/dev/null || :; fi`,
    `if [ -n "\${BASH_VERSION-}" ]; then case "\${HISTCONTROL-}" in *ignorespace*|*ignoreboth*) :;; *) HISTCONTROL="\${HISTCONTROL:+\${HISTCONTROL}:}ignorespace"; export HISTCONTROL;; esac; fi`,
    `if [ -n "\${ZSH_VERSION-}" ]; then builtin setopt HIST_IGNORE_SPACE 2>/dev/null || :; fi`,
    `if [ -n "\${BASH_VERSION-}" ]; then __vibego_blockterm_history_line=$(builtin history 1 2>/dev/null) || __vibego_blockterm_history_line=; case "$__vibego_blockterm_history_line" in ${historyTokenPattern}) builtin history -d "$HISTCMD" 2>/dev/null || :;; esac; unset __vibego_blockterm_history_line; fi`,
    `__vibego_blockterm_tty_state=$(command stty -g 2>/dev/null) || __vibego_blockterm_tty_state=`,
    `if [ -n "$__vibego_blockterm_tty_state" ]; then command stty -opost 2>/dev/null || __vibego_blockterm_tty_state=; fi`,
    `command printf '\\033]633;%s;start;%s;v3;%s;%s;%s;%s\\007' ${prefix} ${id} ${token} "$$" "$(command pwd)" ${command64}`,
    `builtin eval "$(command printf '%b' ${commandBytes})"`,
    `__vibego_blockterm_exit=$?`,
    `if [ -n "$__vibego_blockterm_tty_state" ]; then command stty "$__vibego_blockterm_tty_state" 2>/dev/null || :; fi`,
    `command printf '\\033]633;%s;end;%s;v3;%s;%s;%s\\007\\n' ${prefix} ${id} ${token} "$__vibego_blockterm_exit" "$(command pwd)"`,
    `unset __vibego_blockterm_exit __vibego_blockterm_tty_state`,
  ].join("; ");
  return `${zshHistoryPrelude}\n ${wrapped}\n`;
}

export function stripAnsiForText(value: string): string {
  return value
    .replace(OSC_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(CHARSET_SEQUENCE_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function findOscTerminator(value: string, start: number): { index: number; length: number } | null {
  const bellIndex = value.indexOf("\x07", start);
  const stIndex = value.indexOf("\x1b\\", start);
  if (bellIndex === -1 && stIndex === -1) return null;
  if (bellIndex !== -1 && (stIndex === -1 || bellIndex < stIndex)) return { index: bellIndex, length: 1 };
  return { index: stIndex, length: 2 };
}

function parseBlockTermFrameParts(parts: string[]): ParsedFrame | null {
  if (parts[0] !== MARK_PREFIX || !parts[1] || !parts[2]) return null;
  if (parts[1] === "start") {
    const version3 = parts[3] === "v3";
    const version2 = parts[3] === "v2";
    if (
      (version3 && parts.length < 8) ||
      (version2 && parts.length < 7) ||
      (!version3 && !version2 && parts.length < 5)
    ) {
      return null;
    }
    const blockToken = version3 ? parts[4] : undefined;
    if (version3 && !isValidBlockTermToken(blockToken)) return null;
    const shellPIDIndex = version3 ? 5 : version2 ? 4 : -1;
    const cwdIndex = version3 ? 6 : version2 ? 5 : 3;
    const commandPart = parts[parts.length - 1] || "";
    const rawShellPID = shellPIDIndex >= 0 ? Number.parseInt(parts[shellPIDIndex] || "", 10) : Number.NaN;
    const frame: ParsedFrame = {
      kind: "start",
      id: parts[2],
      ...(version3 ? { protocolVersion: "v3" as const, blockToken } : {}),
      ...(version2 ? { protocolVersion: "v2" as const } : {}),
      cwd: parts.slice(cwdIndex, -1).join(";") || undefined,
      command: commandPart ? decodeBase64Text(commandPart) : "",
    };
    if (Number.isSafeInteger(rawShellPID) && rawShellPID > 0) frame.shellPid = rawShellPID;
    return frame;
  }
  if (parts[1] === "end") {
    const version3 = parts[3] === "v3";
    const version2 = parts[3] === "v2";
    if (
      (version3 && parts.length < 7) ||
      (version2 && parts.length < 6) ||
      (!version3 && !version2 && parts.length < 5)
    ) {
      return null;
    }
    const blockToken = version3 ? parts[4] : undefined;
    if (version3 && !isValidBlockTermToken(blockToken)) return null;
    const exitCodeIndex = version3 ? 5 : version2 ? 4 : 3;
    const cwdIndex = version3 ? 6 : version2 ? 5 : 4;
    const rawExitCode = parts[exitCodeIndex] || "";
    if (!/^\d{1,3}$/u.test(rawExitCode)) return null;
    const exitCode = Number(rawExitCode);
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) return null;
    return {
      kind: "end",
      id: parts[2],
      ...(version3 ? { protocolVersion: "v3" as const, blockToken } : {}),
      ...(version2 ? { protocolVersion: "v2" as const } : {}),
      exitCode,
      cwd: parts.slice(cwdIndex).join(";"),
    };
  }
  return null;
}

export function extractSegmentsFromBuffer(value: string): { segments: TerminalSegment[]; rest: string } {
  const segments: TerminalSegment[] = [];
  const markerPrefix = `${ESC}]633;`;
  let index = 0;
  while (index < value.length) {
    const markerStart = value.indexOf(markerPrefix, index);
    if (markerStart === -1) break;
    if (markerStart > index) {
      const text = value.slice(index, markerStart);
      segments.push({ type: "text", value: text, hasTuiSequence: TUI_SEQUENCE_RE.test(text) });
    }
    const terminator = findOscTerminator(value, markerStart + 6);
    if (!terminator) return { segments, rest: value.slice(markerStart) };
    const parts = value.slice(markerStart + 6, terminator.index).split(";");
    const frame = parseBlockTermFrameParts(parts);
    if (frame) segments.push({ type: "frame", frame });
    index = terminator.index + terminator.length;
  }
  const trailing = value.slice(index);
  // Only retain a suffix that can actually become our OSC marker. A bare ESC
  // is valid ANSI input and must be emitted immediately for interactive TUI
  // programs; retaining every ESC would stall the whole stream.
  let partialLength = 0;
  const maxPrefixLength = Math.min(markerPrefix.length - 1, trailing.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    if (trailing.endsWith(markerPrefix.slice(0, length))) {
      partialLength = length;
      break;
    }
  }
  const text = trailing.slice(0, trailing.length - partialLength);
  if (text) segments.push({ type: "text", value: text, hasTuiSequence: TUI_SEQUENCE_RE.test(text) });
  return { segments, rest: partialLength > 0 ? trailing.slice(-partialLength) : "" };
}

export type TerminalByteSegment =
  | { type: "text"; value: Uint8Array; hasTuiSequence: boolean }
  | { type: "frame"; frame: ParsedFrame; raw: Uint8Array };

const BLOCKTERM_OSC_MARKER_BYTES = new TextEncoder().encode(`${ESC}]633;`);
const BLOCKTERM_OSC_MAX_FRAME_BYTES = 1 << 20;
const TUI_SEQUENCE_BYTES = [
  new TextEncoder().encode(`${ESC}[?47h`),
  new TextEncoder().encode(`${ESC}[?1047h`),
  new TextEncoder().encode(`${ESC}[?1049h`),
];

function byteArrayIndexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return Math.max(0, from);
  const limit = haystack.length - needle.length;
  for (let index = Math.max(0, from); index <= limit; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function byteArrayEndsWith(value: Uint8Array, suffix: Uint8Array): boolean {
  if (suffix.length > value.length) return false;
  const offset = value.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (value[offset + index] !== suffix[index]) return false;
  }
  return true;
}

export function concatBlockTermBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function hasTuiSequenceBytes(value: Uint8Array): boolean {
  return TUI_SEQUENCE_BYTES.some((sequence) => byteArrayIndexOf(value, sequence) >= 0);
}

function parseBlockTermFrameBodyBytes(body: Uint8Array): ParsedFrame | null {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  return parseBlockTermFrameParts(decoded.split(";"));
}

function findByteOscTerminator(value: Uint8Array, start: number): { index: number; length: number } | null {
  for (let index = Math.max(0, start); index < value.length; index += 1) {
    if (value[index] === 0x07) return { index, length: 1 };
    if (value[index] === 0x1b && value[index + 1] === 0x5c) return { index, length: 2 };
  }
  return null;
}

function byteMarkerSuffixLength(value: Uint8Array): number {
  const maxLength = Math.min(BLOCKTERM_OSC_MARKER_BYTES.length - 1, value.length);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.subarray(value.length - length);
    if (byteArrayEndsWith(BLOCKTERM_OSC_MARKER_BYTES.subarray(0, length), suffix)) return length;
  }
  return 0;
}

/**
 * Parse BlockTerm OSC frames while retaining ordinary PTY bytes verbatim.
 * Only complete, valid UTF-8 frame metadata is decoded; command output is
 * never converted through a JS string before it reaches xterm.
 */
export function extractSegmentsFromBytes(value: Uint8Array): {
  segments: TerminalByteSegment[];
  rest: Uint8Array;
} {
  const segments: TerminalByteSegment[] = [];
  let index = 0;
  while (index < value.length) {
    const markerStart = byteArrayIndexOf(value, BLOCKTERM_OSC_MARKER_BYTES, index);
    if (markerStart < 0) break;
    if (markerStart > index) {
      const text = value.slice(index, markerStart);
      segments.push({ type: "text", value: text, hasTuiSequence: hasTuiSequenceBytes(text) });
    }
    const terminator = findByteOscTerminator(value, markerStart + BLOCKTERM_OSC_MARKER_BYTES.length);
    if (!terminator) {
      if (value.length - markerStart <= BLOCKTERM_OSC_MAX_FRAME_BYTES) {
        return { segments, rest: value.slice(markerStart) };
      }
      const malformed = value.slice(markerStart);
      segments.push({ type: "text", value: malformed, hasTuiSequence: hasTuiSequenceBytes(malformed) });
      return { segments, rest: new Uint8Array() };
    }
    const frameEnd = terminator.index + terminator.length;
    const body = value.slice(markerStart + BLOCKTERM_OSC_MARKER_BYTES.length, terminator.index);
    const frame = parseBlockTermFrameBodyBytes(body);
    if (!frame) {
      const malformed = value.slice(markerStart, frameEnd);
      segments.push({ type: "text", value: malformed, hasTuiSequence: hasTuiSequenceBytes(malformed) });
    } else {
      segments.push({ type: "frame", frame, raw: value.slice(markerStart, frameEnd) });
    }
    index = frameEnd;
  }

  const trailing = value.slice(index);
  const partialLength = byteMarkerSuffixLength(trailing);
  const text = trailing.slice(0, trailing.length - partialLength);
  if (text.length > 0) segments.push({ type: "text", value: text, hasTuiSequence: hasTuiSequenceBytes(text) });
  return {
    segments,
    rest: partialLength > 0 ? trailing.slice(trailing.length - partialLength) : new Uint8Array(),
  };
}

/**
 * Check buffered transport bytes for the exact correlated start boundary that
 * makes a server-reported active block safe to own following replay text.
 */
export function hasBlockTermPendingStartFrame(input: {
  chunks: readonly BlockTermPendingChunk[];
  blockId: string;
  blockToken: string;
  parserPrefix?: Uint8Array;
}): boolean {
  let pending: Uint8Array = input.parserPrefix?.slice() || new Uint8Array();
  for (const chunk of input.chunks) {
    if (chunk.reset) pending = new Uint8Array();
    const parsed = extractSegmentsFromBytes(concatBlockTermBytes(pending, chunk.data));
    pending = parsed.rest;
    for (const segment of parsed.segments) {
      if (
        segment.type === "frame" &&
        segment.frame.kind === "start" &&
        segment.frame.protocolVersion === "v3" &&
        segment.frame.id === input.blockId &&
        segment.frame.blockToken === input.blockToken
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Return the portion of an incoming replay chunk not already retained. */
export function missingReplayByteSuffix(existing: Uint8Array, incoming: Uint8Array): Uint8Array {
  if (incoming.length === 0 || existing.length === 0) return incoming;
  // Only remove bytes when the complete incoming chunk is already present at
  // the rendered tail. Prefix and partial overlaps are not proof of duplicate
  // delivery without a cursor; repeated PTY bytes are valid output.
  if (existing.length >= incoming.length && byteArrayEndsWith(existing, incoming)) return new Uint8Array();
  return incoming;
}

export function shouldUseTerminalMode(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const tokens = trimmed.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
  const unwrap = (token: string) => {
    if (
      token.length >= 2 &&
      ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
    ) {
      return token.slice(1, -1);
    }
    return token;
  };

  let commandName = "";
  let index = 0;
  let wrapper = "";
  const optionValues = new Set(["-u", "--user", "-C", "--chdir", "-D", "--directory", "-R", "--role"]);
  while (index < tokens.length) {
    const token = unwrap(tokens[index]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token === "sudo" || token === "env") {
      wrapper = token;
      index += 1;
      continue;
    }
    if (wrapper && token === "--") {
      wrapper = "";
      index += 1;
      continue;
    }
    if (wrapper && token.startsWith("-")) {
      if (optionValues.has(token)) index += 2;
      else index += 1;
      continue;
    }
    if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    commandName = token;
    break;
  }
  const firstToken = tokens[0];
  if (!commandName && firstToken !== undefined) commandName = unwrap(firstToken);
  commandName = commandName.split("/").pop() || commandName;
  if (TUI_COMMANDS.has(commandName)) return true;
  if (/\|\s*(less|more|fzf)\b/.test(trimmed)) return true;
  if (/\b(git\s+(log|show|diff|blame)|gh\s+[^|]*\|\s*less)\b/.test(trimmed)) return true;
  return false;
}
