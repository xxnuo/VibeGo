import { useVirtualizer } from "@tanstack/react-virtual";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bookmark,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Columns2,
  Copy,
  File,
  Folder,
  GripVertical,
  History,
  Keyboard,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Play,
  Plus,
  RotateCcw,
  Server,
  Settings2,
  Sparkles,
  Square,
  Star,
  StarOff,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";
import {
  BLOCKTERM_OUTPUT_MAX_BYTES,
  BlockTermApiError,
  type BlockTermHistoryEntry,
  blockTermApi,
} from "@/api/blockterm";
import { blockTermModelApi } from "@/api/blockterm-model";
import { type BlockTermViewPatch, blockTermViewApi } from "@/api/blockterm-view";
import { createRendererFileClient } from "@/api/file";
import { sessionApi } from "@/api/session";
import { sshApi } from "@/api/ssh";
import { terminalApi } from "@/api/terminal";
import { useDialog } from "@/components/common";
import BlockTermBookmarkDialog from "@/components/terminal/blockterm-bookmark-dialog";
import {
  type BlockTermCommandCompletionCandidate,
  resolveBlockTermCommandCompletion,
} from "@/components/terminal/blockterm-command-completion";
import { resolveBlockTermSSHProfileReference } from "@/components/terminal/blockterm-connection-selector";
import {
  type BlockTermSessionFocusTarget,
  hasOpenBlockTermDesktopShortcutModal,
  isBlockTermDesktopShortcutRepeatable,
  isBlockTermMacPlatform,
  resolveBlockTermDesktopShortcutForTarget,
  resolveBlockTermSessionAfterClose,
  resolveBlockTermSessionFocusTarget,
  shouldConfirmBlockTermSessionClose,
} from "@/components/terminal/blockterm-desktop-keybindings";
import BlockTermHistoryCenter from "@/components/terminal/blockterm-history-center";
import BlockTermHistoryDialog from "@/components/terminal/blockterm-history-dialog";
import { activateBlockTermHistoryTarget } from "@/components/terminal/blockterm-history-navigation";
import {
  clearBlockTermHistoryActivation,
  getBlockTermHistoryActivationRequest,
  resolveBlockTermHistoryActivationState,
  shouldCancelBlockTermHistoryActivationForSession,
  subscribeBlockTermHistoryActivation,
} from "@/components/terminal/blockterm-history-selection";
import {
  clearBlockTermInput,
  cutBlockTermInputLineLeft,
  cutBlockTermInputWordLeft,
  getBlockTermInputRows,
  insertBlockTermInputText,
  resolveBlockTermInputShortcut,
} from "@/components/terminal/blockterm-input-keybindings";
import { BLOCKTERM_KEYMAP_SETTING_KEY, parseBlockTermKeymapConfig } from "@/components/terminal/blockterm-keymap";
import BlockTermKeymapDialog from "@/components/terminal/blockterm-keymap-dialog";
import BlockTermLineAIPanel, { clearBlockTermLineAIConversation } from "@/components/terminal/blockterm-line-ai-panel";
import {
  type BlockTermManagementCommandResult,
  parseBlockTermManagementCommand,
} from "@/components/terminal/blockterm-management";
import {
  type BlockTermManagementDispatchAction,
  type BlockTermManagementIndependentBinding,
  buildBlockTermManagementScreenSettingsPatch,
  planBlockTermManagementDispatch,
  resolveBlockTermManagementScreenReorderAnchor,
} from "@/components/terminal/blockterm-management-dispatch";
import {
  appendRecentCommand,
  applyBlockTermCompletion,
  type BlockMode,
  type BlockNavigationKey,
  type BlockStatus,
  type BlockTermBlock,
  type BlockTermCompletionCandidate,
  type BlockTermCompletionContext,
  type BlockTermCompletionEdit,
  type BlockTermConnectionContext,
  type BlockTermOutputPhaseBinding,
  type BlockTermPendingChunkQueue,
  type BlockTermSession,
  type BlockTermStateOwnerBinding,
  concatBlockTermBytes,
  createBlockState,
  createBlockTermPendingChunkQueue,
  createBlockTermSignalMessage,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  decodeBase64Bytes,
  drainBlockTermPendingChunkQueue,
  encodeUtf8Base64,
  enqueueBlockTermMessageTask,
  enqueueBlockTermPendingChunk,
  extractSegmentsFromBytes,
  flushTerminalProjectionDecoder,
  generateBlockTermToken,
  generateId,
  getBlockMutationFocusTarget,
  getBlockNavigationTarget,
  getBlockTermEstimatedBlockHeight,
  getBlockTermLifecycleMetadata,
  getBlockTermPresentationHeight,
  getVisibleOrderedBlocks,
  hasBlockTermPendingStartFrame,
  isSameBlockTermConnectionIdentity,
  missingReplayByteSuffix,
  moveBlockTermCompletionSelection,
  navigateBlockHistory,
  parseBlockTermCompletionContext,
  parseBlockTermNoteCommand,
  recentCommandHistory,
  resolveBlockTermCompletion,
  resolveBlockTermCompletionReconcile,
  resolveBlockTermConnectionContext,
  resolveBlockTermConnectionCwd,
  resolveBlockTermCorrelatedCompletions,
  resolveBlockTermFrameDisposition,
  resolveBlockTermInterruptedState,
  resolveBlockTermNextConnectionContext,
  resolveBlockTermOutputOwner,
  resolveBlockTermStateBinding,
  resolveBlockTermStateBindings,
  resolveCreatedBlockSelection,
  resolveDraftAfterCommandPublish,
  resolveVisibleBlockSelection,
  serializeBlockTermShellState,
  setBlockTermPresentationHeight,
  shouldHandleBlockTermInputRejected,
  shouldInterruptBlockTermStateBinding,
  shouldRecordBlockTermHistory,
  shouldRestoreBlockTermSignalFailure,
  shouldRouteRejectedBlockTermFrame,
  shouldUseTerminalMode,
  stripAnsiForText,
  takeTerminalParserTail,
} from "@/components/terminal/blockterm-model";
import { canControlBlockTermModelStream } from "@/components/terminal/blockterm-model-stream";
import { BlockTermOutputStore } from "@/components/terminal/blockterm-output-store";
import {
  awaitSessionCommandChain,
  compensateUnconfirmedBlockTermModelRun,
  confirmBlockTermDelete,
  drainBlockPersistence,
  enqueueBlockPersistence,
  enqueueSessionCommand,
  getBlockTermPersistenceDisposition,
  isBlockTermDeleteAlreadyAppliedError,
  isBlockTermTombstoneError,
  mergeFailedBlockPatch,
  persistThenSendCommand,
  trackConcurrentSessionCommand,
} from "@/components/terminal/blockterm-persistence";
import {
  type BlockTermProcessIdentityTracker,
  startBlockTermProcessIdentityTracker,
} from "@/components/terminal/blockterm-process-identity";
import { parseBlockTermRendererCommand } from "@/components/terminal/blockterm-renderer";
import BlockTermRendererHost, { clearBlockTermRendererCache } from "@/components/terminal/blockterm-renderer-host";
import {
  BLOCKTERM_RENDERER_SELECTIONS,
  type BlockTermRendererSelection,
  isBlockTermRendererSelection,
  resolveBlockTermRendererSwitch,
} from "@/components/terminal/blockterm-renderer-registry";
import {
  type BlockTermInventoryLoadOutcome,
  type BlockTermInventoryLoadRequest,
  type BlockTermRestoredOwnerBlock,
  followSupersedingBlockTermInventoryLoad,
  getBlockTermRestoreScope,
  getBlockTermRestoreScopeKey,
  getLoadedBlockTermInventory,
  isBlockTermConnectionContinuationCurrent,
  isBlockTermRestoreScopeCurrent,
  isBlockTermRootTerminalInRestoreScope,
  mergeBlockTermPersistedBlock,
  resolveBlockTermActiveSessionId,
  resolveBlockTermRestoredOwner,
  resolveBlockTermRestoredStatus,
  restoreBlockTermTerminalInventory,
} from "@/components/terminal/blockterm-restore";
import {
  type BlockTermRuntimeBinding,
  forgetBlockTermRuntimeBinding,
  getBlockTermRuntimeBinding,
  loadBlockTermRuntimeBindings,
  pruneBlockTermRuntimeBindings,
  rememberBlockTermRuntimeBinding,
} from "@/components/terminal/blockterm-runtime-bindings";
import {
  BlockTermSessionCloseCoordinator,
  commitBlockTermSessionClose,
} from "@/components/terminal/blockterm-session-close";
import BlockTermSessionIcon from "@/components/terminal/blockterm-session-icon";
import {
  normalizeBlockTermTabColor,
  normalizeBlockTermTabIcon,
  orderBlockTermTerminalsByWorkspace,
  reorderBlockTermItems,
} from "@/components/terminal/blockterm-session-settings";
import BlockTermSessionSettingsDialog, {
  type BlockTermSessionSettingsValues,
} from "@/components/terminal/blockterm-session-settings-dialog";
import {
  BLOCKTERM_SIDEBAR_DEFAULT_WIDTH,
  BLOCKTERM_SIDEBAR_FIXED_WIDTH,
  type BlockTermViewState,
  DEFAULT_BLOCKTERM_VIEW_STATE,
  isBlockTermViewScopeCurrent,
  legalizeBlockTermSidebarState,
  partitionBlockTermSidebarBlocks,
  queueBlockTermViewLoadAfterWrites,
  queueBlockTermViewWriteAfterLoad,
  resolveBlockTermSidebarBody,
  resolveBlockTermSidebarWidth,
  resolveBlockTermViewWrite,
  setBlockTermNextConnectionState,
  setBlockTermSidebarState,
  shouldLegalizeBlockTermSidebarState,
} from "@/components/terminal/blockterm-sidebar";
import {
  type BlockTermSignal,
  type BlockTermStopSequence,
  cancelBlockTermStopSequence,
  resolveBlockTermStopSignals,
  resolveBlockTermStopToken,
  startBlockTermStop,
} from "@/components/terminal/blockterm-stop";
import {
  appendBlockTermTerminalBytes,
  BLOCKTERM_TERMINAL_CONVERT_EOL,
  getBlockTermTerminalCellHeight,
  getBlockTermTerminalHeight,
  getBlockTermTerminalHydrationValue,
  getBlockTermTerminalInitialUsedRows,
  getBlockTermTerminalRowsOption,
  getBlockTermTerminalUsedRows,
  hasAcknowledgedBlockTermRawTarget,
  mergeBlockTermRawTarget,
  resolveBlockTermTerminalMaxPtySize,
  resolveBlockTermTerminalRows,
  resolveBlockTermTerminalUsedRows,
  resolveBlockTermTerminalWrite,
  shouldUseBlockTermTerminalRenderer,
} from "@/components/terminal/blockterm-terminal-output";
import {
  type BlockTermCursorState,
  type BlockTermTerminalRoute,
  createBlockTermRoutedInputMessage,
  createBlockTermRoutedResizeMessage,
  createBlockTermRoutedSignalMessage,
  createBlockTermTerminalRoute,
  parseBlockTermTerminalMessage,
  reduceBlockTermStreamCursor,
} from "@/components/terminal/blockterm-terminal-protocol";
import { loadBlockTermWorkspaceSearchTargets } from "@/components/terminal/blockterm-workspace-loader";
import {
  BlockTermWorkspaceNavigationCoordinator,
  type BlockTermWorkspaceNavigationDependencies,
} from "@/components/terminal/blockterm-workspace-navigation";
import {
  type BlockTermWorkspaceSearchTarget,
  createLocalBlockTermWorkspaceInventory,
  resolveRequestedBlockTermSessionId,
} from "@/components/terminal/blockterm-workspace-search";
import BlockTermWorkspaceSettingsDialog from "@/components/terminal/blockterm-workspace-settings-dialog";
import SSHConnectionDialog, { type SSHConnectionAttempt } from "@/components/terminal/ssh-connection-dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { useReorderableList } from "@/hooks/use-reorderable-list";
import { useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import { cleanupSpeculativeTerminal } from "@/services/speculative-terminal-cleanup";
import { useAppStore, useFrameStore, useSessionStore, useTerminalStore } from "@/stores";
import { enqueueWorkspaceMutation, isCurrentWorkspaceTransition } from "@/stores/session-store";
import type { TerminalSession } from "@/stores/terminal-store";

interface SessionRuntime {
  /** String decoder is used only for the durable text projection. */
  decoder: TextDecoder;
  parseBuffer: Uint8Array;
  ws: WebSocket | null;
  cursor: number;
  /** Cursor watermarks are scoped to the canonical session/block stream key. */
  streamCursors: BlockTermCursorState;
  /** Decoder/parser state must not be shared by interleaved block streams. */
  streamParsers: Map<string, { decoder: TextDecoder; parseBuffer: Uint8Array }>;
  echoConfigured: boolean;
  allowReconnect: boolean;
  scopeGeneration: number;
  connectionToken: number;
  handshakeReady: boolean;
  pendingTerminalChunks: BlockTermPendingChunkQueue;
  pendingPrimaryBinding: BlockTermStateOwnerBinding | null;
  transitionPrimaryBinding: BlockTermStateOwnerBinding | null;
  transitionPrimaryTimer?: ReturnType<typeof setTimeout>;
  handshakeStartCursor: number;
  stateHandshakePending: boolean;
  initialStatePending: boolean;
  replayRefreshPromise?: Promise<BlockTermInventoryLoadOutcome<BlockTermRestoredOwnerBlock>>;
  pendingPtyExited?: boolean;
  endedStatus?: "exited" | "closed";
}

interface BlockTermRuntimeConnection {
  sessionId: string;
  blockId: string;
  blockToken: string;
  route: BlockTermTerminalRoute;
  ws: WebSocket | null;
  cursor: number;
  parser: BlockTermStreamParser;
  allowReconnect: boolean;
  scopeGeneration: number;
  connectionToken: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  messageChain: Promise<void>;
  hasOpened: boolean;
}

interface BlockTermTokenBinding {
  sessionId: string;
  token: string;
}

interface BlockTermRestartTransition extends BlockTermTokenBinding {
  fence: number;
}

interface BlockTermCreatedBlockContext {
  // The shell state captured before persistence. This is the only state we
  // can safely attach when a scope reset has already removed the in-memory
  // session before the create-then-send operation reaches its send gate.
  afterStateJson?: string;
}

function getBlockTermSessionConnectionFallback(
  session: Pick<BlockTermSession, "runtimeType" | "sshProfileId" | "cwd">
): BlockTermConnectionContext {
  return {
    runtimeType: session.runtimeType,
    ...(session.runtimeType === "ssh" && session.sshProfileId ? { sshProfileId: session.sshProfileId } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
  };
}

function getBlockTermViewNextConnection(
  view: BlockTermViewState,
  session: Pick<BlockTermSession, "runtimeType" | "sshProfileId" | "cwd">
): BlockTermConnectionContext {
  return view.nextConnection ? { ...view.nextConnection } : getBlockTermSessionConnectionFallback(session);
}

function getBlockTermViewWithConnectionFallback(
  view: BlockTermViewState,
  session: Pick<BlockTermSession, "runtimeType" | "sshProfileId" | "cwd">
): BlockTermViewState {
  return view.nextConnection ? view : { ...view, nextConnection: getBlockTermSessionConnectionFallback(session) };
}

interface TerminalRuntime {
  blockId: string;
  fitAddon: FitAddon;
  terminal: XTerm;
  disposed: boolean;
  flexRows: boolean;
  isRunning: boolean;
  maxRows: number;
  maxPtySize: number;
  usedRows: number;
  cellHeight: number | null;
  onMetrics: (usedRows: number, cellHeight: number | null) => void;
  rawCursor: number | null;
  rawTargetCursor: number | null;
  rawAcknowledgedTargetCursor: number | null;
  rawSyncController: AbortController | null;
  rawSyncInFlight: Promise<void> | null;
  rawSyncPending: boolean;
  rawSyncTimer: ReturnType<typeof setTimeout> | null;
  rawSynced: boolean;
  rawSettled: boolean;
  rawSyncStartedAt: number;
  rawFallbackApplied: boolean;
  hasLiveWrites: boolean;
  pendingWriteResolutions: Set<(written: boolean) => void>;
}

interface BlockTermLifecycleFenceRef {
  current: Record<string, number>;
}

interface BlockTermTerminalTestHook {
  mount?: (blockId: string, terminal: XTerm) => void;
  unmount?: (blockId: string, terminal: XTerm) => void;
}

function getBlockTermTerminalTestHook(): BlockTermTerminalTestHook | undefined {
  if (import.meta.env.VITE_BLOCKTERM_TERMINAL_TEST_HOOK !== "1" || typeof window === "undefined") {
    return undefined;
  }
  return (window as Window & { __VIBEGO_BLOCKTERM_TERMINAL_TEST_HOOK__?: BlockTermTerminalTestHook })
    .__VIBEGO_BLOCKTERM_TERMINAL_TEST_HOOK__;
}

interface BlockTermCompletionState {
  sessionId: string;
  context: BlockTermCompletionContext;
  candidates: BlockTermCompletionCandidate[];
  commandCandidates?: BlockTermCommandCompletionCandidate[];
  selectedIndex: number;
  loading: boolean;
  scopeGeneration: number;
}

interface BlockTermGhostCompletionState {
  sessionId: string;
  context: BlockTermCompletionContext;
  text: string;
  scopeGeneration: number;
}

interface PendingBlockTermOutput {
  value: string;
  cursor: number;
  contentRevision: number;
}

interface BlockTermPageProps {
  groupId: string;
}

const EMPTY_BLOCKTERM_TERMINALS: TerminalSession[] = [];

interface BlockTermLineAIViewState {
  sourceBlockId: string;
  open: boolean;
}

interface BlockTermPendingSessionFocus {
  sessionId: string;
  mode: "input" | "restore";
}

interface BlockTermPendingHistoryActivation {
  entry: BlockTermHistoryEntry;
  scopeGeneration: number;
  workspaceSessionId?: string;
  requestId: number;
}

const BLOCKTERM_SESSION_FOCUS_RETRY_DELAY_MS = 50;
const BLOCKTERM_SESSION_FOCUS_RETRY_TIMEOUT_MS = 5_000;
const BLOCKTERM_BOTTOM_ANCHOR_SETTLE_MS = 250;

interface CreateBlockTermSessionOptions {
  cwd?: string;
  name?: string;
  activate?: boolean;
  runtimeType?: "local" | "ssh";
  sshProfileId?: string;
  sshAuth?: SSHConnectionAttempt["auth"];
}

function getInitialCwd(): string {
  const groups = useFrameStore.getState().groups;
  for (const group of groups) {
    if (group.type !== "group") continue;
    const page = group.pages.find((item) => item.type === "files" && item.path);
    if (page?.path) return page.path;
  }
  return ".";
}

function resolveBlockTermManagementReference<T extends { id: string; name: string }>(
  reference: string,
  candidates: readonly T[],
  label: string
): T {
  const value = reference.trim();
  if (/^[1-9][0-9]*$/u.test(value)) {
    const indexed = candidates[Number(value) - 1];
    if (indexed) return indexed;
  }
  const byId = candidates.find((candidate) => candidate.id === value);
  if (byId) return byId;
  const exactNames = candidates.filter((candidate) => candidate.name === value);
  if (exactNames.length === 1) return exactNames[0];
  if (exactNames.length > 1) throw new Error(`${label} name '${value}' is ambiguous`);
  const prefixNames = candidates.filter((candidate) => candidate.name.startsWith(value));
  if (prefixNames.length === 1) return prefixNames[0];
  if (prefixNames.length > 1) throw new Error(`${label} prefix '${value}' is ambiguous`);
  throw new Error(`cannot find ${label} '${value}'`);
}

function resolveBlockTermManagementLine(blocks: readonly BlockTermBlock[], reference: string): BlockTermBlock {
  const byId = blocks.find((block) => block.id === reference);
  if (byId) return byId;
  if (/^(?:0|[1-9][0-9]*)$/u.test(reference)) {
    const lineNum = Number(reference);
    const byLine = Number.isSafeInteger(lineNum) ? blocks.find((block) => block.lineNum === lineNum) : undefined;
    if (byLine) return byLine;
  }
  throw new Error(`cannot find line '${reference}'`);
}

function getCompactPath(path: string): string {
  if (!path || path === ".") return path || ".";
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return normalized || "/";
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function shouldFullscreenTerminalMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;
}

function getXtermTheme(theme: string) {
  const isDark = theme !== "light";
  return {
    background: isDark ? "#18181b" : "#ffffff",
    foreground: isDark ? "#d4d4d8" : "#18181b",
    cursor: isDark ? "#a1a1aa" : "#52525b",
    selectionBackground: isDark ? "rgba(161,161,170,0.3)" : "rgba(82,82,91,0.25)",
  };
}

function blockStatusClass(status: BlockStatus): string {
  switch (status) {
    case "running":
      return "text-blue-500";
    case "streaming":
      return "text-blue-500";
    case "success":
      return "text-green-500";
    case "error":
      return "text-red-500";
    case "interrupted":
      return "text-yellow-500";
  }
}

function isActiveBlockStatus(status: BlockStatus): boolean {
  return status === "running" || status === "streaming";
}

function blockStatusRailClass(status: BlockStatus): string {
  switch (status) {
    case "running":
      return "bg-blue-500";
    case "streaming":
      return "bg-blue-500";
    case "success":
      return "bg-green-500";
    case "error":
      return "bg-red-500";
    case "interrupted":
      return "bg-yellow-500";
  }
}

function nextBlockLineNum(blocks: BlockTermBlock[]): number {
  return blocks.reduce((max, block, index) => Math.max(max, block.lineNum ?? index), -1) + 1;
}

function missingReplaySuffix(existing: string, incoming: string): string {
  if (!incoming || !existing) return incoming;
  if (existing === incoming || existing.endsWith(incoming)) return "";
  // Without a cursor, prefix and partial overlaps are not proof that replay
  // text is duplicate. Preserve the incoming projection and accept a possible
  // duplicate rather than silently dropping real repeated output.
  return incoming;
}

function getRequestErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

type BlockTermStreamParser = { decoder: TextDecoder; parseBuffer: Uint8Array };

function createBlockTermStreamParser(): BlockTermStreamParser {
  return {
    decoder: new TextDecoder("utf-8", { fatal: false }),
    parseBuffer: new Uint8Array(),
  };
}

function parseBlockTermPageMessage(terminalId: string, value: unknown) {
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const type = typeof record?.type === "string" ? record.type : "";
  const routeMode = record?.route_mode;
  // Legacy state/NACK messages used block_id/token as lifecycle metadata before
  // routed streams existed. Keep those fields available to the state machine,
  // but parse their transport route as the implicit session stream.
  if ((type === "state" || type === "input_rejected") && routeMode === undefined) {
    return parseBlockTermTerminalMessage(terminalId, {
      ...(record || {}),
      block_id: undefined,
      block_token: undefined,
    });
  }
  return parseBlockTermTerminalMessage(terminalId, value);
}

const decodeTerminalProjection = (parser: Pick<BlockTermStreamParser, "decoder">, bytes: Uint8Array): string =>
  parser.decoder.decode(bytes, { stream: true });

const RAW_SYNC_INTERVAL_MS = 200;
const RAW_SYNC_MAX_WAIT_MS = 5_000;
// A state snapshot may publish a replacement primary before the old command's
// end frame reaches the client. Keep the old transition owner long enough for
// that live frame, then reconcile it as interrupted if it never arrives.
const BLOCKTERM_TRANSITION_RECONCILE_DELAY_MS = 2_000;

function resetRawSyncState(runtime: TerminalRuntime): void {
  runtime.rawCursor = null;
  runtime.rawAcknowledgedTargetCursor = null;
  runtime.rawSynced = false;
  runtime.rawSettled = false;
  runtime.rawSyncStartedAt = 0;
  runtime.rawFallbackApplied = false;
}

function reopenRawSyncState(runtime: TerminalRuntime): void {
  runtime.rawSynced = false;
  runtime.rawSettled = false;
  runtime.rawSyncStartedAt = 0;
  runtime.rawFallbackApplied = false;
}

function updateTerminalUsedRows(runtime: TerminalRuntime, forceFull = false): void {
  if (runtime.disposed) return;
  const buffer = runtime.terminal.buffer.active;
  const measuredRows = getBlockTermTerminalUsedRows({
    bufferLength: buffer.length,
    cursorY: buffer.cursorY,
    isRunning: runtime.isRunning,
    maxRows: runtime.maxRows,
    getLineText: (index) => buffer.getLine(index)?.translateToString(true) ?? "",
  });
  const usedRows = resolveBlockTermTerminalUsedRows(
    runtime.flexRows,
    runtime.usedRows,
    measuredRows,
    runtime.maxRows,
    forceFull
  );
  const dimensions = (
    runtime.terminal as XTerm & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: { cell?: { height?: number } };
            device?: { cell?: { height?: number } };
          };
        };
      };
    }
  )._core?._renderService?.dimensions;
  const cellHeight = getBlockTermTerminalCellHeight({
    cssCellHeight: dimensions?.css?.cell?.height,
    deviceCellHeight: dimensions?.device?.cell?.height,
    devicePixelRatio: runtime.terminal.element?.ownerDocument.defaultView?.devicePixelRatio ?? 1,
    totalRows: runtime.maxRows,
  });
  if (usedRows === runtime.usedRows && cellHeight === runtime.cellHeight) return;
  runtime.usedRows = usedRows;
  runtime.cellHeight = cellHeight;
  runtime.onMetrics(usedRows, cellHeight);
}

function resizeTerminalColumns(runtime: TerminalRuntime): void {
  if (runtime.disposed) return;
  const dimensions = runtime.fitAddon.proposeDimensions();
  const cols = dimensions?.cols;
  if (Number.isSafeInteger(cols) && (cols as number) > 0) {
    if (runtime.terminal.cols !== cols || runtime.terminal.rows !== runtime.maxRows) {
      runtime.terminal.resize(cols as number, runtime.maxRows);
    }
  } else if (runtime.terminal.rows !== runtime.maxRows) {
    runtime.terminal.resize(runtime.terminal.cols, runtime.maxRows);
  }
  updateTerminalUsedRows(runtime, true);
}

function writeTerminalData(runtime: TerminalRuntime, data: string | Uint8Array, reset = false): Promise<boolean> {
  if (runtime.disposed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (written: boolean) => {
      if (!runtime.pendingWriteResolutions.delete(resolve)) return;
      resolve(written);
    };
    runtime.pendingWriteResolutions.add(resolve);
    const write = () => {
      if (runtime.disposed) {
        finish(false);
        return;
      }
      try {
        if (reset) runtime.terminal.reset();
        runtime.terminal.write(data, () => {
          if (runtime.disposed) {
            finish(false);
            return;
          }
          runtime.terminal.refresh(0, Math.max(0, runtime.terminal.rows - 1));
          updateTerminalUsedRows(runtime, reset);
          finish(true);
        });
      } catch {
        finish(false);
      }
    };
    try {
      if (reset) runtime.terminal.write(new Uint8Array(), write);
      else write();
    } catch {
      finish(false);
    }
  });
}

function disposeTerminalRuntime(runtime: TerminalRuntime): void {
  if (runtime.disposed) return;
  runtime.disposed = true;
  if (runtime.rawSyncTimer !== null) clearTimeout(runtime.rawSyncTimer);
  runtime.rawSyncTimer = null;
  runtime.rawSyncController?.abort();
  runtime.rawSyncController = null;
  for (const resolve of runtime.pendingWriteResolutions) resolve(false);
  runtime.pendingWriteResolutions.clear();
  getBlockTermTerminalTestHook()?.unmount?.(runtime.blockId, runtime.terminal);
  runtime.terminal.dispose();
}

function clearBlockTermTransitionTimer(runtime: SessionRuntime): void {
  if (runtime.transitionPrimaryTimer !== undefined) {
    clearTimeout(runtime.transitionPrimaryTimer);
    runtime.transitionPrimaryTimer = undefined;
  }
}

function getBlockTermLifecycleFence(ref: BlockTermLifecycleFenceRef, blockId: string): number {
  return ref.current[blockId] || 0;
}

function bumpBlockTermLifecycleFence(ref: BlockTermLifecycleFenceRef, blockId: string): number {
  const next = getBlockTermLifecycleFence(ref, blockId) + 1;
  ref.current[blockId] = next;
  return next;
}

const BlockTerminalView: React.FC<{
  blockId: string;
  flexRows: boolean;
  fullscreen: boolean;
  isActive: boolean;
  isRunning: boolean;
  isTui: boolean;
  maxPtySize: number;
  termRows: number;
  onMount: (
    blockId: string,
    element: HTMLDivElement,
    isActive: boolean,
    flexRows: boolean,
    maxRows: number,
    maxPtySize: number,
    isRunning: boolean,
    onMetrics: (usedRows: number, cellHeight: number | null) => void
  ) => void;
  onUnmount: (blockId: string) => void;
  onResize: (blockId: string) => void;
  onToggleFullscreen: () => void;
}> = ({
  blockId,
  flexRows,
  fullscreen,
  isActive,
  isRunning,
  isTui,
  maxPtySize,
  termRows,
  onMount,
  onUnmount,
  onResize,
  onToggleFullscreen,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const maxRows = resolveBlockTermTerminalRows(termRows, DEFAULT_ROWS);
  const resolvedMaxPtySize = resolveBlockTermTerminalMaxPtySize(maxPtySize, BLOCKTERM_OUTPUT_MAX_BYTES);
  const initialUsedRows = getBlockTermTerminalInitialUsedRows(flexRows, isRunning, maxRows);
  const [metrics, setMetrics] = useState<{ usedRows: number; cellHeight: number | null }>({
    usedRows: initialUsedRows,
    cellHeight: null,
  });
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const handleMetrics = useCallback((usedRows: number, cellHeight: number | null) => {
    setMetrics((current) =>
      current.usedRows === usedRows && current.cellHeight === cellHeight ? current : { usedRows, cellHeight }
    );
  }, []);
  const terminalHeight = getBlockTermTerminalHeight(metrics.usedRows, maxRows, metrics.cellHeight);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setMetrics({
      usedRows: getBlockTermTerminalInitialUsedRows(flexRows, isRunningRef.current, maxRows),
      cellHeight: null,
    });
    onMount(
      blockId,
      element,
      isActiveRef.current,
      flexRows,
      maxRows,
      resolvedMaxPtySize,
      isRunningRef.current,
      handleMetrics
    );
    return () => onUnmount(blockId);
  }, [blockId, flexRows, handleMetrics, maxRows, onMount, onUnmount, resolvedMaxPtySize]);

  useEffect(() => {
    onResize(blockId);
  }, [blockId, onResize, terminalHeight]);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let lastWidth = Math.floor(element.getBoundingClientRect().width);
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? element.getBoundingClientRect().width);
      if (width === lastWidth) return;
      lastWidth = width;
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        onResize(blockId);
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
    };
  }, [blockId, onResize]);

  if (!isTui) {
    return (
      <div
        className="px-3 pb-3 overflow-hidden"
        data-blockterm-terminal-renderer={flexRows ? "flex" : "fixed"}
        data-used-rows={metrics.usedRows}
      >
        <div ref={ref} className="w-full overflow-hidden" style={{ height: `${terminalHeight}px` }} />
      </div>
    );
  }

  return (
    <div
      data-blockterm-terminal-renderer="tui"
      className={`border border-ide-border bg-black overflow-hidden ${fullscreen ? "fixed inset-0 z-50" : ""}`}
      data-used-rows={metrics.usedRows}
    >
      <div className="h-9 px-2 border-b border-ide-border bg-ide-panel flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-ide-mute">
          <Server size={14} />
          <span>{isActive ? "TUI" : "TUI snapshot"}</span>
        </div>
        <button
          className="p-1.5 text-ide-mute hover:text-ide-text hover:bg-ide-bg rounded"
          title={fullscreen ? t("plugin.blockTerm.exitFullscreen") : t("plugin.blockTerm.enterFullscreen")}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
      <div
        ref={ref}
        className={fullscreen ? "h-[calc(100%-36px)] w-full" : "w-full overflow-hidden"}
        style={fullscreen ? undefined : { height: `${terminalHeight}px` }}
      />
    </div>
  );
};

const BlockTermOutputView: React.FC<{
  block: BlockTermBlock;
  fullscreen: boolean;
  isActive: boolean;
  runtimeType: "local" | "ssh";
  terminalId: string;
  outputStore: BlockTermOutputStore;
  loadOutput: (blockId: string, force?: boolean) => Promise<unknown>;
  onMountTerminal: (
    blockId: string,
    element: HTMLDivElement,
    isActive: boolean,
    flexRows: boolean,
    maxRows: number,
    maxPtySize: number,
    isRunning: boolean,
    onMetrics: (usedRows: number, cellHeight: number | null) => void
  ) => void;
  onUnmountTerminal: (blockId: string) => void;
  onHydrateTerminal: (blockId: string, value: string) => void;
  onResizeTerminal: (blockId: string) => void;
  onToggleFullscreen: () => void;
  onModelEvent?: (
    blockId: string,
    patch: Partial<Pick<BlockTermBlock, "output" | "status" | "exitCode" | "finishedAt">>
  ) => void;
  onModelStreamUnavailable?: (blockId: string, unavailable: boolean) => void;
}> = ({
  block,
  fullscreen,
  isActive,
  runtimeType,
  terminalId,
  outputStore,
  loadOutput,
  onMountTerminal,
  onUnmountTerminal,
  onHydrateTerminal,
  onResizeTerminal,
  onToggleFullscreen,
  onModelEvent,
  onModelStreamUnavailable,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const rendererFileClient = useMemo(
    () =>
      createRendererFileClient({
        runtimeType,
        terminalId,
        blockId: block.id,
        createdAt: block.createdAt,
      }),
    [block.createdAt, block.id, runtimeType, terminalId]
  );
  const subscribe = useCallback(
    (listener: () => void) => outputStore.subscribe(block.id, listener),
    [block.id, outputStore]
  );
  const getSnapshot = useCallback(() => outputStore.getSnapshot(block.id), [block.id, outputStore]);
  const output = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const terminalRenderer = shouldUseBlockTermTerminalRenderer(block.renderer);

  useEffect(() => {
    if (terminalRenderer || block.renderer === "none") return;
    if (output.status !== "idle") return;
    void loadOutput(block.id).catch(() => {});
  }, [block.id, block.renderer, loadOutput, output.status, terminalRenderer]);

  useEffect(() => {
    if (!terminalRenderer || output.status !== "ready") return;
    // The page-level hydration callback validates the exact block/runtime
    // ownership. Do not gate it on the parent session's lagging active flag.
    onHydrateTerminal(block.id, output.value);
  }, [block.id, onHydrateTerminal, output.status, output.value, terminalRenderer]);

  if (block.renderer === "none") return null;
  if (terminalRenderer) {
    return (
      <BlockTerminalView
        blockId={block.id}
        flexRows={block.termFlexRows}
        fullscreen={fullscreen}
        isActive={isActive}
        isRunning={block.status === "running"}
        isTui={block.mode === "terminal"}
        maxPtySize={block.termMaxPtySize}
        termRows={block.termRows}
        onMount={onMountTerminal}
        onUnmount={onUnmountTerminal}
        onResize={onResizeTerminal}
        onToggleFullscreen={onToggleFullscreen}
      />
    );
  }

  if (output.status === "idle" || output.status === "loading") {
    return (
      <div className="h-12 flex items-center justify-center text-ide-mute">
        <Loader2 size={14} className="animate-spin" aria-label={t("common.loading")} />
      </div>
    );
  }
  if (output.status === "error") {
    return (
      <div className="h-12 flex items-center justify-center">
        <button
          type="button"
          className="p-1.5 text-ide-mute hover:text-ide-text hover:bg-ide-bg"
          title={t("plugin.blockTerm.rerun")}
          onClick={() => void loadOutput(block.id, true).catch(() => {})}
        >
          <RotateCcw size={14} />
        </button>
      </div>
    );
  }

  const loadedBlock = {
    ...block,
    output: output.value,
    outputSize: output.outputSize,
    outputCursor: output.cursor,
  };
  return (
    <BlockTermRendererHost
      block={loadedBlock}
      fileClient={rendererFileClient}
      rawOutput={blockTermApi.getRawOutput}
      onModelEvent={onModelEvent}
      onModelStreamUnavailable={onModelStreamUnavailable}
      fallback={
        <pre
          className={`select-text px-3 pb-3 min-h-6 max-h-[52vh] overflow-auto custom-scrollbar text-xs sm:text-sm leading-relaxed font-mono whitespace-pre-wrap break-words ${
            block.status === "error" ? "text-red-500" : "text-ide-text"
          }`}
        >
          {output.value || (isActive ? t("plugin.blockTerm.waitingOutput") : "")}
        </pre>
      }
    />
  );
};

const BlockTermRendererMenu: React.FC<{
  block: BlockTermBlock;
  disabled: boolean;
  onSelect: (renderer: BlockTermRendererSelection) => void;
}> = ({ block, disabled, onSelect }) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const current = isBlockTermRendererSelection(block.renderer || "terminal") ? block.renderer || "terminal" : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-blockterm-renderer-menu={block.id}
          className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text disabled:opacity-40 md:size-7"
          title={t("plugin.blockTerm.rendererMenu")}
          aria-label={t("plugin.blockTerm.rendererMenu")}
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
        >
          <Terminal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-40 rounded-none border-ide-border bg-ide-panel text-ide-text"
        onClick={(event) => event.stopPropagation()}
      >
        {BLOCKTERM_RENDERER_SELECTIONS.map((renderer) => (
          <DropdownMenuItem
            key={renderer}
            data-blockterm-renderer-option={renderer}
            className="min-h-11 rounded-none text-xs focus:bg-ide-bg focus:text-ide-text md:min-h-0"
            onSelect={() => onSelect(renderer)}
          >
            <Check size={13} className={current === renderer ? "opacity-100" : "opacity-0"} />
            <span>{t(`plugin.blockTerm.rendererOptions.${renderer}`)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const BlockTermMoreMenu: React.FC<{
  block: BlockTermBlock;
  isRunning: boolean;
  isDeleting: boolean;
  copied: boolean;
  copiedFullOutput: boolean;
  onCopyOutput: () => void;
  onCopyFullOutput: () => void;
  onTogglePinned: () => void;
  onSaveBookmark: () => void;
  onToggleStarred: () => void;
  onToggleArchived: () => void;
  onDelete: () => void;
}> = ({
  block,
  isRunning,
  isDeleting,
  copied,
  copiedFullOutput,
  onCopyOutput,
  onCopyFullOutput,
  onTogglePinned,
  onSaveBookmark,
  onToggleStarred,
  onToggleArchived,
  onDelete,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuItemClass = "min-h-11 rounded-none text-xs focus:bg-ide-bg focus:text-ide-text md:min-h-0";
  const actions: Array<{
    key: string;
    icon: React.ReactNode;
    label: string;
    action: () => void;
    disabled?: boolean;
    danger?: boolean;
    separatorBefore?: boolean;
  }> = [];
  if (block.kind !== "note") {
    actions.push(
      {
        key: "copy-output",
        icon: copied ? <Check size={14} /> : <Copy size={14} />,
        label: t("plugin.blockTerm.copyOutput"),
        action: onCopyOutput,
      },
      {
        key: "copy-full-output",
        icon: copiedFullOutput ? <Check size={14} /> : <ClipboardCopy size={14} />,
        label: t("plugin.blockTerm.copyFullOutput"),
        action: onCopyFullOutput,
      }
    );
  }
  actions.push({
    key: "toggle-pinned",
    icon: block.pinned ? <PinOff size={14} /> : <Pin size={14} />,
    label: block.pinned ? t("plugin.blockTerm.unpin") : t("plugin.blockTerm.pin"),
    action: onTogglePinned,
    disabled: isDeleting,
    separatorBefore: block.kind !== "note",
  });
  if (block.kind !== "note") {
    actions.push({
      key: "save-bookmark",
      icon: <BookmarkPlus size={14} />,
      label: t("plugin.blockTerm.saveBlockAsBookmark"),
      action: onSaveBookmark,
    });
  }
  actions.push(
    {
      key: "toggle-starred",
      icon: block.starred ? <StarOff size={14} /> : <Star size={14} />,
      label: block.starred ? t("plugin.blockTerm.unfavorite") : t("plugin.blockTerm.favorite"),
      action: onToggleStarred,
      disabled: isDeleting,
    },
    {
      key: "toggle-archived",
      icon: block.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />,
      label: block.archived ? t("plugin.blockTerm.restore") : t("plugin.blockTerm.archive"),
      action: onToggleArchived,
      disabled: isDeleting,
    }
  );
  if (!isRunning) {
    actions.push({
      key: "delete",
      icon: isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />,
      label: isDeleting ? t("plugin.blockTerm.deletingBlock") : t("plugin.blockTerm.deleteBlock"),
      action: onDelete,
      disabled: isDeleting,
      danger: true,
      separatorBefore: true,
    });
  }

  const trigger = (
    <button
      type="button"
      data-blockterm-actions-menu={block.id}
      data-blockterm-deleting={isDeleting || undefined}
      disabled={isDeleting}
      className={`flex size-11 shrink-0 items-center justify-center hover:bg-ide-panel md:size-7 ${
        block.pinned || block.starred ? "text-ide-accent" : "text-ide-mute hover:text-ide-text"
      } disabled:cursor-wait disabled:opacity-60`}
      title={isDeleting ? t("plugin.blockTerm.deletingBlock") : t("common.moreActions")}
      aria-label={isDeleting ? t("plugin.blockTerm.deletingBlock") : t("common.moreActions")}
      onClick={(event) => event.stopPropagation()}
    >
      {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={14} />}
    </button>
  );

  if (isMobile) {
    return (
      <Drawer open={mobileOpen} onOpenChange={setMobileOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="max-h-[min(78dvh,36rem)] border-ide-border bg-ide-panel pb-[max(0.75rem,env(safe-area-inset-bottom))] text-ide-text">
          <DrawerHeader className="border-b border-ide-border pb-3 pr-14 text-left">
            <DrawerTitle className="truncate text-sm text-ide-text">{t("common.moreActions")}</DrawerTitle>
            <DrawerClose
              className="absolute right-3 top-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm text-ide-mute hover:bg-ide-bg hover:text-ide-text"
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <X size={17} />
            </DrawerClose>
          </DrawerHeader>
          <div className="min-h-0 overflow-y-auto py-2">
            {actions.map((item) => (
              <React.Fragment key={item.key}>
                {item.separatorBefore && <div className="my-1 border-t border-ide-border" />}
                <button
                  type="button"
                  disabled={item.disabled}
                  className={`flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm hover:bg-ide-bg ${
                    item.danger ? "text-red-500" : "text-ide-text"
                  } disabled:cursor-wait disabled:opacity-60`}
                  onClick={() => {
                    setMobileOpen(false);
                    window.requestAnimationFrame(item.action);
                  }}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              </React.Fragment>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44 rounded-none border-ide-border bg-ide-panel text-ide-text"
        onClick={(event) => event.stopPropagation()}
      >
        {actions.map((item) => (
          <React.Fragment key={item.key}>
            {item.separatorBefore && <DropdownMenuSeparator className="bg-ide-border" />}
            <DropdownMenuItem
              className={`${menuItemClass} ${item.danger ? "text-red-500 focus:text-red-500" : ""}`}
              disabled={item.disabled}
              onSelect={item.action}
            >
              {item.icon}
              <span>{item.label}</span>
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const BlockTermPage: React.FC<BlockTermPageProps> = ({ groupId }) => {
  const dialog = useDialog();
  const locale = useAppStore((state) => state.locale);
  const theme = useAppStore((state) => state.theme);
  const t = useTranslation(locale);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentWorkspaceNameOverride = useSessionStore((state) => state.currentWorkspaceNameOverride);
  const sessionLoading = useSessionStore((state) => state.loading);
  const sessionInitialized = useSessionStore((state) => state.sessionInitialized);
  const workspaceSessions = useSessionStore((state) => state.sessions);
  const renameWorkspaceSession = useSessionStore((state) => state.renameSession);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const setActiveTerminalId = useTerminalStore((state) => state.setActiveId);
  const requestedActiveSessionId = useTerminalStore((state) => state.activeIdByGroup[groupId] || null);
  const setTerminalStatus = useTerminalStore((state) => state.setTerminalStatus);
  const updateTerminal = useTerminalStore((state) => state.updateTerminal);
  const terminalInventory = useTerminalStore((state) => state.terminalsByGroup[groupId] || EMPTY_BLOCKTERM_TERMINALS);
  const reorderTerminalPages = useTerminalStore((state) => state.reorderTerminalPages);
  const blockTermKeymapSetting = useSettingsStore((state) => state.settings[BLOCKTERM_KEYMAP_SETTING_KEY] || "");
  const blockTermKeymap = useMemo(
    () => parseBlockTermKeymapConfig(blockTermKeymapSetting).keymap,
    [blockTermKeymapSetting]
  );

  const [sessions, setSessions] = useState<BlockTermSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // `/connect` changes only the context used by future blocks. Keep it
  // separate from the durable parent terminal runtime and mirror it in a ref
  // because command/event callbacks can run before the next React commit.
  const [nextConnectionBySession, setNextConnectionBySession] = useState<Record<string, BlockTermConnectionContext>>(
    {}
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedFullOutputId, setCopiedFullOutputId] = useState<string | null>(null);
  const [fullscreenBlockId, setFullscreenBlockId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [showRunningOnly, setShowRunningOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("vibego_blockterm_filter_running") === "1";
    } catch {
      return false;
    }
  });
  const [showStarredOnly, setShowStarredOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("vibego_blockterm_filter_starred") === "1";
    } catch {
      return false;
    }
  });
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyCenterOpen, setHistoryCenterOpen] = useState(false);
  const [keymapDialogOpen, setKeymapDialogOpen] = useState(false);
  const [sshDialogOpen, setSSHDialogOpen] = useState(false);
  const [sshSelectionSessionId, setSSHSelectionSessionId] = useState<string | null>(null);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null);
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false);
  const [bookmarkInitialCommand, setBookmarkInitialCommand] = useState<string | undefined>(undefined);
  const [completionState, setCompletionState] = useState<BlockTermCompletionState | null>(null);
  const [ghostCompletion, setGhostCompletion] = useState<BlockTermGhostCompletionState | null>(null);
  const [inputExpandedBySession, setInputExpandedBySession] = useState<Record<string, boolean>>({});
  const [viewBySession, setViewBySession] = useState<Record<string, BlockTermViewState>>({});
  const [lineAIViewBySession, setLineAIViewBySession] = useState<Record<string, BlockTermLineAIViewState>>({});
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [blockViewportWidth, setBlockViewportWidth] = useState(0);
  const [unavailableModelStreams, setUnavailableModelStreams] = useState<ReadonlySet<string>>(() => new Set());
  const [deletingBlockIds, setDeletingBlockIds] = useState<ReadonlySet<string>>(() => new Set());
  const [restoreRetryNonce, setRestoreRetryNonce] = useState(0);

  useEffect(() => {
    setWorkspaceSettingsOpen(false);
    setSessionSettingsId(null);
  }, [currentSessionId]);
  const outputStore = useMemo(() => new BlockTermOutputStore(), []);
  const historyActivationRequest = useSyncExternalStore(
    subscribeBlockTermHistoryActivation,
    getBlockTermHistoryActivationRequest,
    getBlockTermHistoryActivationRequest
  );

  const runtimesRef = useRef<Map<string, SessionRuntime>>(new Map());
  const blockRuntimesRef = useRef<Map<string, BlockTermRuntimeConnection>>(new Map());
  const independentBlockIdsRef = useRef<Set<string>>(new Set());
  const nextConnectionBySessionRef = useRef<Record<string, BlockTermConnectionContext>>({});
  const outputRef = useRef<Record<string, string>>({});
  const terminalRawRef = useRef<Record<string, Uint8Array>>({});
  const rawTargetCursorRef = useRef<Record<string, number | null>>({});
  const rawAcknowledgedTargetCursorRef = useRef<Record<string, number | null>>({});
  const modeRef = useRef<Record<string, BlockMode>>({});
  const xtermRefs = useRef<Map<string, TerminalRuntime>>(new Map());
  const blockElementRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sidebarBlockElementRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const blockLayoutRef = useRef<HTMLDivElement | null>(null);
  const blockScrollRef = useRef<HTMLDivElement | null>(null);
  const blockContentRef = useRef<HTMLDivElement | null>(null);
  const commandDockRef = useRef<HTMLDivElement | null>(null);
  const pendingBlockScrollBottomAnchorRef = useRef<{
    sessionId: string;
    scopeGeneration: number;
    clearTimer: number;
  } | null>(null);
  const pendingBlockFocusRef = useRef<{ blockId: string; position: ScrollLogicalPosition } | null>(null);
  const pendingHistoryEntryRef = useRef<BlockTermPendingHistoryActivation | null>(null);
  const sshSelectionScopeRef = useRef<{
    sessionId: string;
    scopeGeneration: number;
    workspaceRevision: number;
    workspaceSessionId: string | null;
  } | null>(null);
  const commandInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionFocusTargetRef = useRef<Record<string, BlockTermSessionFocusTarget>>({});
  const pendingSessionFocusRef = useRef<BlockTermPendingSessionFocus | null>(null);
  const sessionFocusRestoreInProgressRef = useRef(false);
  const sessionFocusRetryRef = useRef<{
    pending: BlockTermPendingSessionFocus;
    timer: number | null;
    passCount: number;
    deadlineAt: number;
  } | null>(null);
  const sessionFocusScrollRef = useRef<{ pending: BlockTermPendingSessionFocus; blockId: string } | null>(null);
  const sessionFocusAttemptRef = useRef<() => void>(() => {});
  const desktopShortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const sessionCloseCoordinatorRef = useRef(new BlockTermSessionCloseCoordinator());
  const completionOptionRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const completionAbortRef = useRef<AbortController | null>(null);
  const completionRequestRef = useRef(0);
  const viewBySessionRef = useRef<Partial<Record<string, BlockTermViewState>>>({});
  const lineAIViewBySessionRef = useRef<Partial<Record<string, BlockTermLineAIViewState>>>({});
  const confirmedViewBySessionRef = useRef<Partial<Record<string, BlockTermViewState>>>({});
  const viewLoadPromisesRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const viewLoadControllersRef = useRef<Partial<Record<string, AbortController>>>({});
  const viewLoadGenerationRef = useRef<Partial<Record<string, number>>>({});
  const confirmedViewGenerationRef = useRef<Partial<Record<string, number>>>({});
  const viewWriteVersionRef = useRef<Partial<Record<string, number>>>({});
  const viewWriteChainsRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const patchSessionViewRef = useRef<
    (
      sessionId: string,
      patch: BlockTermViewPatch,
      movingBlockIds?: string[],
      allowDeletingCleanup?: boolean
    ) => Promise<void>
  >(async () => {});
  const nextConnectionCwdWatermarkRef = useRef<Record<string, number>>({});
  const sidebarDragRef = useRef<{
    sessionId: string;
    containerLeft: number;
    containerWidth: number;
    initialWidth: string;
    lastWidth: string;
  } | null>(null);
  const showArchivedRef = useRef(showArchived);
  const showRunningOnlyRef = useRef(showRunningOnly);
  const showStarredOnlyRef = useRef(showStarredOnly);
  const sessionActiveBlockRef = useRef<Record<string, string | null>>({});
  const interruptedOutputBlockRef = useRef<Record<string, string | null>>({});
  const blockStatusRef = useRef<Record<string, BlockStatus>>({});
  const blockTokenRef = useRef<Record<string, BlockTermTokenBinding>>({});
  const blockOutputPhaseRef = useRef<Record<string, BlockTermOutputPhaseBinding>>({});
  // Monotonic per-block fence for asynchronous lifecycle persistence. Token
  // values can intentionally survive a stop/NACK round trip, so token equality
  // alone is not enough to reject an older interruption write.
  const blockLifecycleFenceRef = useRef<Record<string, number>>({});
  const blockRestartTransitionRef = useRef<Record<string, BlockTermRestartTransition>>({});
  // Highest completion watermark observed for each block. Completion ring
  // entries can be replayed across reconnects; retaining this cursor fences
  // an older completion from clearing a newer lifecycle owner.
  const blockCompletionCursorRef = useRef<Record<string, number>>({});
  const nextLineNumRef = useRef<Record<string, number>>({});
  const persistedLoadRequestRef = useRef<Record<string, number>>({});
  const persistedLoadPromiseRef = useRef<Record<string, BlockTermInventoryLoadRequest<BlockTermBlock> | undefined>>({});
  const persistedBlocksLoadedGenerationRef = useRef<Record<string, number>>({});
  const historyLoadRequestRef = useRef<Record<string, number>>({});
  const reconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const persistTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const persistPatchRef = useRef<Map<string, Parameters<typeof blockTermApi.update>[1]>>(new Map());
  const persistOutputRef = useRef<Map<string, PendingBlockTermOutput>>(new Map());
  const presentationHeightTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const presentationHeightPendingRef = useRef<Map<string, number>>(new Map());
  const pendingBlockCreatesRef = useRef<Map<string, Parameters<typeof blockTermApi.create>[0]>>(new Map());
  const createBlockRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const processIdentityTrackersRef = useRef<
    Map<
      string,
      {
        blockId: string;
        scopeGeneration: number;
        token: number;
        tracker: BlockTermProcessIdentityTracker;
      }
    >
  >(new Map());
  const processIdentityTokenRef = useRef(0);
  const capturedProcessIdentityBlockIdsRef = useRef<Set<string>>(new Set());
  // Every durable operation for a block shares one promise chain. This keeps
  // create, debounced patches, and delete in database order even when network
  // responses complete out of order.
  const blockWriteChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const stopSequencesRef = useRef<Map<string, BlockTermStopSequence>>(new Map());
  const sessionCommandChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const runCommandRef = useRef<
    (sessionId: string, command: string, skipManagement?: boolean, submittedDraft?: string) => Promise<void>
  >(async () => {});
  const managementCommandHandlerRef = useRef<(sessionId: string, result: BlockTermManagementCommandResult) => void>(
    () => {}
  );
  const managementNavigationRef = useRef(new BlockTermWorkspaceNavigationCoordinator());
  const managementNavigationAbortRef = useRef<AbortController | null>(null);
  const runtimeInfoWriteChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const persistedBlockMetadataRef = useRef<
    Record<string, Pick<BlockTermBlock, "createdAt" | "runtimeType" | "sshProfileId">>
  >({});
  const deletedBlockIdsRef = useRef<Set<string>>(new Set());
  const deletingBlockIdsRef = useRef<Set<string>>(new Set());
  const interruptedBlocksRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef<BlockTermSession[]>([]);
  const sessionSettingsMutationVersionsRef = useRef<Record<string, number>>({});
  const sessionReorderMutationVersionRef = useRef(0);
  const visibleOrderedBlocksRef = useRef<BlockTermBlock[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const connectSessionRef = useRef<(sessionId: string, expectedGeneration?: number) => void>(() => {});
  const connectBlockRuntimeRef = useRef<
    (sessionId: string, blockId: string, blockToken: string, expectedGeneration?: number) => boolean
  >(() => false);
  const closeBlockRuntimeRef = useRef<
    (sessionId: string, blockId: string, blockToken: string, requestClose?: boolean) => Promise<void>
  >(async () => {});
  const reconcileBlockRuntimeRef = useRef<
    (sessionId: string, blockId: string, blockToken: string, expectedGeneration?: number) => Promise<boolean>
  >(async () => false);
  const requestTerminalRawSyncRef = useRef<(blockId: string) => void>(() => {});
  const markCreatedBlockInterruptedRef = useRef<
    (
      sessionId: string,
      blockId: string,
      expectedToken?: string,
      expectedFence?: number,
      creationContext?: BlockTermCreatedBlockContext
    ) => Promise<void>
  >(async () => {});
  const restoreBlockTermSignalFailureRef = useRef<(sessionId: string, blockId: string, expectedToken?: string) => void>(
    () => {}
  );
  const currentRestoreScopeKeyRef = useRef<string | null>(null);
  const restoredScopeKeyRef = useRef<string | null>(null);
  const restoreRequestVersionRef = useRef(0);
  const scopeGenerationRef = useRef(0);

  const syncNextConnectionCache = useCallback((sessionId: string, context: BlockTermConnectionContext | null) => {
    if (context) {
      nextConnectionBySessionRef.current = {
        ...nextConnectionBySessionRef.current,
        [sessionId]: context,
      };
      setNextConnectionBySession((current) => ({ ...current, [sessionId]: context }));
      return;
    }
    const next = { ...nextConnectionBySessionRef.current };
    delete next[sessionId];
    nextConnectionBySessionRef.current = next;
    setNextConnectionBySession((current) => {
      if (!(sessionId in current)) return current;
      const updated = { ...current };
      delete updated[sessionId];
      return updated;
    });
  }, []);

  const setNextConnectionContext = useCallback(
    (sessionId: string, context: BlockTermConnectionContext): Promise<void> => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const currentView = viewBySessionRef.current[sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
      const current =
        nextConnectionBySessionRef.current[sessionId] ||
        currentView.nextConnection ||
        (session ? getBlockTermSessionConnectionFallback(session) : null);
      const normalized: BlockTermConnectionContext = session
        ? resolveBlockTermNextConnectionContext({
            requested: context,
            current,
            session,
          })
        : {
            runtimeType: context.runtimeType === "ssh" ? "ssh" : "local",
            ...(context.runtimeType === "ssh" && context.sshProfileId?.trim()
              ? { sshProfileId: context.sshProfileId.trim() }
              : {}),
            cwd: context.cwd?.trim() || ".",
          };
      return patchSessionViewRef.current(sessionId, { nextConnection: normalized });
    },
    []
  );

  const clearNextConnectionContext = useCallback(
    (sessionId: string) => {
      syncNextConnectionCache(sessionId, null);
    },
    [syncNextConnectionCache]
  );

  const seedNextConnectionContext = useCallback(
    (session: Pick<BlockTermSession, "id" | "runtimeType" | "sshProfileId" | "cwd">) => {
      if (nextConnectionBySessionRef.current[session.id]) return;
      syncNextConnectionCache(session.id, getBlockTermSessionConnectionFallback(session));
    },
    [syncNextConnectionCache]
  );

  const resolveSessionConnectionContext = useCallback(
    (session: Pick<BlockTermSession, "id" | "runtimeType" | "sshProfileId" | "cwd">, block?: Partial<BlockTermBlock>) =>
      resolveBlockTermConnectionContext({
        block,
        next: nextConnectionBySessionRef.current[session.id] || nextConnectionBySession[session.id],
        session,
      }),
    [nextConnectionBySession]
  );

  // Event handlers attached to xterm instances outlive individual renders.
  // Keep a synchronous snapshot so ended sessions can never accept input.
  sessionsRef.current = sessions;
  viewBySessionRef.current = viewBySession;
  lineAIViewBySessionRef.current = lineAIViewBySession;
  showArchivedRef.current = showArchived;
  showRunningOnlyRef.current = showRunningOnly;
  showStarredOnlyRef.current = showStarredOnly;

  const isCurrentIndependentBlockOwner = useCallback((sessionId: string, blockId: string): boolean => {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    const block = session?.blocks.find((item) => item.id === blockId);
    const status = block ? (blockStatusRef.current[blockId] ?? block.status) : undefined;
    const binding = blockTokenRef.current[blockId];
    const runtime = blockRuntimesRef.current.get(blockId);
    return Boolean(
      block &&
        block.kind === "command" &&
        block.terminalId === sessionId &&
        status !== undefined &&
        isActiveBlockStatus(status) &&
        independentBlockIdsRef.current.has(blockId) &&
        binding?.sessionId === sessionId &&
        binding?.token.trim() &&
        runtime &&
        runtime.sessionId === sessionId &&
        runtime.blockId === blockId &&
        runtime.blockToken === binding.token &&
        runtime.scopeGeneration === scopeGenerationRef.current &&
        runtime.allowReconnect
    );
  }, []);
  const isSidebarEligibleBlock = useCallback(
    (sessionId: string, block: Pick<BlockTermBlock, "id" | "archived" | "status">): boolean => {
      if (block.archived || deletedBlockIdsRef.current.has(block.id) || deletingBlockIdsRef.current.has(block.id)) {
        return false;
      }
      const status = blockStatusRef.current[block.id] ?? block.status;
      return !isActiveBlockStatus(status) || isCurrentIndependentBlockOwner(sessionId, block.id);
    },
    [isCurrentIndependentBlockOwner]
  );

  useEffect(
    () => () => {
      managementNavigationAbortRef.current?.abort();
      managementNavigationRef.current.invalidate();
    },
    []
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("vibego_blockterm_filter_running", showRunningOnly ? "1" : "0");
      window.localStorage.setItem("vibego_blockterm_filter_starred", showStarredOnly ? "1" : "0");
    } catch {
      // Local persistence is optional in private browsing and embedded views.
    }
  }, [showRunningOnly, showStarredOnly]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null,
    [activeSessionId, sessions]
  );
  activeSessionIdRef.current = activeSession?.id ?? null;
  const activeView = activeSession
    ? viewBySession[activeSession.id] || DEFAULT_BLOCKTERM_VIEW_STATE
    : DEFAULT_BLOCKTERM_VIEW_STATE;
  const activeBlockInventoryLoaded = Boolean(
    activeSession && persistedBlocksLoadedGenerationRef.current[activeSession.id] === scopeGenerationRef.current
  );
  const activeSidebarOwner = activeSession?.blocks.find((block) => block.id === activeView.sidebar.blockId) || null;
  const activeViewOwnerPending = Boolean(
    activeSession && !activeBlockInventoryLoaded && activeView.sidebar.blockId && !activeSidebarOwner
  );
  const activeViewNeedsLegalization = Boolean(
    activeSession && shouldLegalizeBlockTermSidebarState(activeView, activeSession.blocks, activeBlockInventoryLoaded)
  );
  const legalizedActiveView =
    activeViewNeedsLegalization || activeViewOwnerPending
      ? legalizeBlockTermSidebarState(activeView, activeSession?.blocks || [])
      : activeView;
  const sidebarOwner = activeSidebarOwner && !activeSidebarOwner.archived ? activeSidebarOwner : null;
  const selectedSidebarCandidate =
    activeSession?.blocks.find((block) => block.id === activeSession.selectedBlockId && !block.archived) || null;
  const sidebarOpenCandidate = sidebarOwner || selectedSidebarCandidate;
  const activeLineAIView = activeSession ? lineAIViewBySession[activeSession.id] : undefined;
  const activeLineAISource =
    activeSession?.blocks.find(
      (block) =>
        block.id === activeLineAIView?.sourceBlockId &&
        !block.archived &&
        block.kind !== "note" &&
        !isActiveBlockStatus(block.status) &&
        !deletingBlockIds.has(block.id)
    ) || null;
  const lineAISidebarOpen = Boolean(
    activeLineAIView?.open &&
      activeLineAISource &&
      activeSession &&
      (activeSession.status === "ready" || activeSession.status === "running")
  );
  const rightSidebarOpen = legalizedActiveView.sidebar.open || lineAISidebarOpen;
  const filteredOrderedBlocks = useMemo(() => {
    if (!activeSession) return [];
    const filtered = activeSession.blocks.filter(
      (block) => (!showRunningOnly || isActiveBlockStatus(block.status)) && (!showStarredOnly || block.starred)
    );
    return getVisibleOrderedBlocks(filtered, showArchived);
  }, [activeSession, showArchived, showRunningOnly, showStarredOnly]);
  const sidebarPartitionSource = useMemo(() => {
    if (!sidebarOwner || filteredOrderedBlocks.some((block) => block.id === sidebarOwner.id))
      return filteredOrderedBlocks;
    return [...filteredOrderedBlocks, sidebarOwner];
  }, [filteredOrderedBlocks, sidebarOwner]);
  const { mainBlocks: visibleOrderedBlocks, sidebarBlock } = useMemo(
    () => partitionBlockTermSidebarBlocks(sidebarPartitionSource, legalizedActiveView, true),
    [legalizedActiveView, sidebarPartitionSource]
  );
  const sidebarBody = sidebarBlock ? resolveBlockTermSidebarBody(sidebarBlock) : null;
  visibleOrderedBlocksRef.current = visibleOrderedBlocks;
  const sidebarPaneWidth = rightSidebarOpen
    ? resolveBlockTermSidebarWidth(blockViewportWidth || 1000, legalizedActiveView.sidebar.width)
    : 0;

  useEffect(() => {
    const element = blockLayoutRef.current;
    if (!element) return;
    const updateWidth = () => setBlockViewportWidth(Math.floor(element.clientWidth));
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeSession?.id]);

  useEffect(() => {
    const scrollElement = blockScrollRef.current;
    const contentElement = blockContentRef.current;
    const dockElement = commandDockRef.current;
    if (!scrollElement || !contentElement || !dockElement) return;

    const clearPendingAnchor = () => {
      const pending = pendingBlockScrollBottomAnchorRef.current;
      if (!pending || pending.sessionId !== activeSession?.id) return;
      window.clearTimeout(pending.clearTimer);
      pendingBlockScrollBottomAnchorRef.current = null;
    };
    const stickToBottom = () => {
      const pending = pendingBlockScrollBottomAnchorRef.current;
      if (!pending || pending.sessionId !== activeSession?.id || pending.scopeGeneration !== scopeGenerationRef.current)
        return;
      scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      window.clearTimeout(pending.clearTimer);
      pending.clearTimer = window.setTimeout(() => {
        if (pendingBlockScrollBottomAnchorRef.current !== pending) return;
        scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
        pendingBlockScrollBottomAnchorRef.current = null;
      }, BLOCKTERM_BOTTOM_ANCHOR_SETTLE_MS);
    };
    const cancelForUserScroll = () => clearPendingAnchor();
    scrollElement.addEventListener("wheel", cancelForUserScroll, { passive: true });
    scrollElement.addEventListener("touchstart", cancelForUserScroll, { passive: true });
    scrollElement.addEventListener("pointerdown", cancelForUserScroll, { passive: true });

    if (typeof ResizeObserver === "undefined") {
      return () => {
        scrollElement.removeEventListener("wheel", cancelForUserScroll);
        scrollElement.removeEventListener("touchstart", cancelForUserScroll);
        scrollElement.removeEventListener("pointerdown", cancelForUserScroll);
        clearPendingAnchor();
      };
    }

    const observer = new ResizeObserver(stickToBottom);
    observer.observe(contentElement);
    observer.observe(dockElement);
    return () => {
      scrollElement.removeEventListener("wheel", cancelForUserScroll);
      scrollElement.removeEventListener("touchstart", cancelForUserScroll);
      scrollElement.removeEventListener("pointerdown", cancelForUserScroll);
      observer.disconnect();
      clearPendingAnchor();
    };
  }, [activeSession?.id]);

  const loadSessionView = useCallback(
    (sessionId: string): Promise<void> => {
      const scopeGeneration = scopeGenerationRef.current;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const confirmed = confirmedViewBySessionRef.current[sessionId];
      if (confirmed && confirmedViewGenerationRef.current[sessionId] === scopeGeneration && session) {
        const visible = viewBySessionRef.current[sessionId] || confirmed;
        syncNextConnectionCache(sessionId, getBlockTermViewNextConnection(visible, session));
        return Promise.resolve();
      }
      const pending = viewLoadPromisesRef.current[sessionId];
      if (pending && viewLoadGenerationRef.current[sessionId] === scopeGeneration) return pending;
      if (pending) viewLoadControllersRef.current[sessionId]?.abort();
      const controller = new AbortController();
      viewLoadControllersRef.current = { ...viewLoadControllersRef.current, [sessionId]: controller };
      viewLoadGenerationRef.current = { ...viewLoadGenerationRef.current, [sessionId]: scopeGeneration };
      // A scope can restore the same terminal ID while an old PATCH is still in
      // flight. Read only after that chain settles so the confirmed snapshot can
      // never predate the server's final state from the previous scope.
      const previousWrite = viewWriteChainsRef.current[sessionId] || Promise.resolve();
      const request = queueBlockTermViewLoadAfterWrites(previousWrite, async () => {
        const isCurrentRequest = () =>
          !controller.signal.aborted &&
          isBlockTermViewScopeCurrent(scopeGeneration, scopeGenerationRef.current) &&
          sessionsRef.current.some((item) => item.id === sessionId);
        if (!isCurrentRequest()) return;
        const currentSession = sessionsRef.current.find((item) => item.id === sessionId);
        if (!currentSession) return;
        const applyLoadedView = (rawView: BlockTermViewState) => {
          const view = getBlockTermViewWithConnectionFallback(rawView, currentSession);
          confirmedViewBySessionRef.current = { ...confirmedViewBySessionRef.current, [sessionId]: view };
          confirmedViewGenerationRef.current = {
            ...confirmedViewGenerationRef.current,
            [sessionId]: scopeGeneration,
          };
          const visible = viewBySessionRef.current[sessionId];
          const nextVisible = visible || view;
          syncNextConnectionCache(sessionId, getBlockTermViewNextConnection(nextVisible, currentSession));
          if (!visible) {
            viewBySessionRef.current = { ...viewBySessionRef.current, [sessionId]: view };
            setViewBySession((items) => {
              if (!isCurrentRequest() || items[sessionId]) return items;
              return { ...items, [sessionId]: view };
            });
          }
        };
        try {
          const { view } = await blockTermViewApi.getView(sessionId, { signal: controller.signal });
          if (!isCurrentRequest()) return;
          applyLoadedView(view);
        } catch {
          if (!isCurrentRequest()) return;
          applyLoadedView(DEFAULT_BLOCKTERM_VIEW_STATE);
        }
      }).finally(() => {
        if (viewLoadPromisesRef.current[sessionId] === request) {
          const { [sessionId]: _, ...remaining } = viewLoadPromisesRef.current;
          viewLoadPromisesRef.current = remaining;
          const { [sessionId]: _generation, ...remainingGenerations } = viewLoadGenerationRef.current;
          viewLoadGenerationRef.current = remainingGenerations;
        }
        if (viewLoadControllersRef.current[sessionId] === controller) {
          const { [sessionId]: _, ...remaining } = viewLoadControllersRef.current;
          viewLoadControllersRef.current = remaining;
        }
      });
      viewLoadPromisesRef.current = { ...viewLoadPromisesRef.current, [sessionId]: request };
      return request;
    },
    [syncNextConnectionCache]
  );

  useEffect(() => {
    const sessionId = activeSession?.id;
    if (sessionId) void loadSessionView(sessionId);
  }, [activeSession?.id, loadSessionView]);

  useEffect(
    () => () => {
      for (const controller of Object.values(viewLoadControllersRef.current)) controller?.abort();
      viewLoadControllersRef.current = {};
    },
    []
  );
  const getVisibleBlocks = useCallback(
    (
      blocks: readonly BlockTermBlock[],
      archived = showArchivedRef.current,
      runningOnly = showRunningOnlyRef.current,
      starredOnly = showStarredOnlyRef.current
    ) =>
      getVisibleOrderedBlocks(
        blocks.filter(
          (block) => (!runningOnly || isActiveBlockStatus(block.status)) && (!starredOnly || block.starred)
        ),
        archived
      ),
    []
  );
  const blockVirtualizer = useVirtualizer({
    count: visibleOrderedBlocks.length,
    getScrollElement: () => blockScrollRef.current,
    getItemKey: (index) => visibleOrderedBlocks[index]?.id ?? index,
    estimateSize: (index) => {
      const block = visibleOrderedBlocks[index];
      return block ? getBlockTermEstimatedBlockHeight(block) : 54;
    },
    overscan: 4,
    scrollPaddingStart: 52,
    scrollPaddingEnd: 16,
  });
  const virtualBlockRows = blockVirtualizer.getVirtualItems();

  const closeCompletion = useCallback(() => {
    completionRequestRef.current += 1;
    completionAbortRef.current?.abort();
    completionAbortRef.current = null;
    completionOptionRefs.current.clear();
    setCompletionState(null);
    setGhostCompletion(null);
  }, []);

  const cancelSessionFocusRetry = useCallback(() => {
    const retry = sessionFocusRetryRef.current;
    if (retry?.timer !== null && retry?.timer !== undefined) window.clearTimeout(retry.timer);
    sessionFocusRetryRef.current = null;
    sessionFocusScrollRef.current = null;
  }, []);

  const cancelPendingSessionFocus = useCallback(() => {
    pendingSessionFocusRef.current = null;
    cancelSessionFocusRetry();
  }, [cancelSessionFocusRetry]);

  const cancelPendingHistoryActivation = useCallback(() => {
    const pending = pendingHistoryEntryRef.current;
    pendingHistoryEntryRef.current = null;
    if (pending) clearBlockTermHistoryActivation(pending.requestId);
  }, []);

  const updateGhostCompletion = useCallback((sessionId: string, draft: string, cursor: number) => {
    const result = resolveBlockTermCommandCompletion(draft, cursor);
    if (!result || !result.ghostText) {
      setGhostCompletion(null);
      return;
    }
    setGhostCompletion({
      sessionId,
      context: result.context,
      text: result.ghostText,
      scopeGeneration: scopeGenerationRef.current,
    });
  }, []);

  const selectSession = useCallback(
    (sessionId: string, focusMode: BlockTermPendingSessionFocus["mode"] = "restore") => {
      const pendingHistoryActivation = pendingHistoryEntryRef.current;
      if (
        pendingHistoryActivation &&
        shouldCancelBlockTermHistoryActivationForSession(
          pendingHistoryActivation.entry.terminalId,
          sessionId,
          pendingHistoryActivation.scopeGeneration,
          scopeGenerationRef.current
        )
      ) {
        cancelPendingHistoryActivation();
      }
      closeCompletion();
      if (activeSessionIdRef.current === sessionId) {
        pendingSessionFocusRef.current = null;
        cancelSessionFocusRetry();
        setActiveTerminalId(groupId, sessionId);
        return;
      }
      cancelSessionFocusRetry();
      pendingBlockFocusRef.current = null;
      activeSessionIdRef.current = sessionId;
      pendingSessionFocusRef.current = { sessionId, mode: focusMode };
      setActiveSessionId(sessionId);
      setActiveTerminalId(groupId, sessionId);
    },
    [cancelPendingHistoryActivation, cancelSessionFocusRetry, closeCompletion, groupId, setActiveTerminalId]
  );

  useEffect(() => {
    const requestedId = resolveRequestedBlockTermSessionId(
      requestedActiveSessionId,
      activeSessionIdRef.current,
      sessions.map((session) => session.id)
    );
    if (requestedId) selectSession(requestedId);
  }, [requestedActiveSessionId, selectSession, sessions]);

  const captureBlockScrollBottomAnchor = useCallback((sessionId: string) => {
    if (activeSessionIdRef.current !== sessionId) return;
    const scrollElement = blockScrollRef.current;
    if (!scrollElement) return;
    const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const current = pendingBlockScrollBottomAnchorRef.current;
    if (current) window.clearTimeout(current.clearTimer);
    if (maxScrollTop - scrollElement.scrollTop > 2) {
      pendingBlockScrollBottomAnchorRef.current = null;
      return;
    }
    const pending = {
      sessionId,
      scopeGeneration: scopeGenerationRef.current,
      clearTimer: 0,
    };
    pending.clearTimer = window.setTimeout(() => {
      if (pendingBlockScrollBottomAnchorRef.current === pending) {
        pendingBlockScrollBottomAnchorRef.current = null;
      }
    }, BLOCKTERM_BOTTOM_ANCHOR_SETTLE_MS);
    pendingBlockScrollBottomAnchorRef.current = pending;
  }, []);

  const setSessionPatch = useCallback(
    (sessionId: string, patch: Partial<BlockTermSession>) => {
      if (patch.draft !== undefined) captureBlockScrollBottomAnchor(sessionId);
      setSessions((items) => items.map((item) => (item.id === sessionId ? { ...item, ...patch } : item)));
    },
    [captureBlockScrollBottomAnchor]
  );

  const handleSessionReorder = useCallback(
    (fromId: string, toId: string) => {
      const currentInventory = useTerminalStore.getState().getTerminals(groupId);
      const current = orderBlockTermTerminalsByWorkspace(sessionsRef.current, currentInventory);
      const optimistic = reorderBlockTermItems(current, fromId, toId);
      if (optimistic.every((session, index) => session.id === current[index]?.id)) return;

      const mutationVersion = ++sessionReorderMutationVersionRef.current;
      setSessions((items) =>
        reorderBlockTermItems(orderBlockTermTerminalsByWorkspace(items, currentInventory), fromId, toId)
      );
      const workspaceState = useSessionStore.getState();
      const workspaceSessionId = workspaceState.currentSessionId || undefined;
      void reorderTerminalPages(groupId, fromId, toId, { workspaceSessionId }).catch((error) => {
        if (sessionReorderMutationVersionRef.current !== mutationVersion) return;
        const latest = sessionsRef.current;
        const latestInventory = useTerminalStore.getState().getTerminals(groupId);
        const rootsAvailable = latestInventory.some((terminal) => !terminal.parentId);
        const restored = rootsAvailable ? orderBlockTermTerminalsByWorkspace(latest, latestInventory) : current;
        setSessions(restored);
        toast.error(error instanceof Error ? error.message : t("common.saveFailed"));
      });
    },
    [groupId, reorderTerminalPages, t]
  );

  const handleSaveSessionSettings = useCallback(
    async (values: BlockTermSessionSettingsValues) => {
      const target = sessionsRef.current.find((session) => session.id === sessionSettingsId);
      if (!target) throw new Error(t("plugin.blockTerm.workspaceSearch.targetUnavailable"));

      const normalizedColor = normalizeBlockTermTabColor(values.tabColor);
      const normalizedIcon = normalizeBlockTermTabIcon(values.tabIcon);
      const tabColor = normalizedColor === "default" ? "" : normalizedColor;
      const tabIcon = normalizedIcon === "default" ? "" : normalizedIcon;
      const optimistic = { name: values.name.trim(), tabColor, tabIcon };
      const previous = {
        name: target.name,
        tabColor: target.tabColor || "",
        tabIcon: target.tabIcon || "",
      };
      const mutationVersion = (sessionSettingsMutationVersionsRef.current[target.id] || 0) + 1;
      sessionSettingsMutationVersionsRef.current[target.id] = mutationVersion;
      const workspaceState = useSessionStore.getState();
      const requestRevision = workspaceState.workspaceRevision;
      const requestWorkspaceId = workspaceState.currentSessionId;

      setSessions((items) =>
        items.map((session) => (session.id === target.id ? { ...session, ...optimistic } : session))
      );
      updateTerminal(groupId, target.id, optimistic);

      try {
        await enqueueWorkspaceMutation(async () => {
          if (!isCurrentWorkspaceTransition(requestRevision, requestWorkspaceId, true)) {
            throw new Error(t("plugin.blockTerm.workspaceSearch.targetUnavailable"));
          }
          await terminalApi.updateSettings(target.id, {
            name: optimistic.name,
            tab_color: optimistic.tabColor,
            tab_icon: optimistic.tabIcon,
          });
        });
      } catch (error) {
        const currentSession = sessionsRef.current.find((session) => session.id === target.id);
        const currentTerminal = useTerminalStore
          .getState()
          .getTerminals(groupId)
          .find((terminal) => terminal.id === target.id);
        const sessionStillOptimistic =
          currentSession?.name === optimistic.name &&
          (currentSession.tabColor || "") === optimistic.tabColor &&
          (currentSession.tabIcon || "") === optimistic.tabIcon;
        const terminalStillOptimistic =
          currentTerminal?.name === optimistic.name &&
          (currentTerminal.tabColor || "") === optimistic.tabColor &&
          (currentTerminal.tabIcon || "") === optimistic.tabIcon;
        const isLatestMutation = sessionSettingsMutationVersionsRef.current[target.id] === mutationVersion;
        if (isLatestMutation && sessionStillOptimistic) {
          setSessions((items) =>
            items.map((session) =>
              session.id === target.id
                ? { ...session, name: previous.name, tabColor: previous.tabColor, tabIcon: previous.tabIcon }
                : session
            )
          );
        }
        if (isLatestMutation && terminalStillOptimistic) updateTerminal(groupId, target.id, previous);
        throw error;
      }
    },
    [groupId, sessionSettingsId, t, updateTerminal]
  );

  const handleSaveWorkspaceSettings = useCallback(
    async ({ name }: { name: string }) => {
      const workspaceId = useSessionStore.getState().currentSessionId;
      if (!workspaceId) throw new Error(t("plugin.blockTerm.workspaceSearch.targetUnavailable"));
      await renameWorkspaceSession(workspaceId, name);
    },
    [renameWorkspaceSession, t]
  );

  const orderedSessions = useMemo(() => {
    const rootsAvailable = terminalInventory.some((terminal) => !terminal.parentId);
    return rootsAvailable ? orderBlockTermTerminalsByWorkspace(sessions, terminalInventory) : sessions;
  }, [sessions, terminalInventory]);

  const sessionReorder = useReorderableList({
    ids: orderedSessions.map((session) => session.id),
    axis: "x",
    onReorder: handleSessionReorder,
    disabled: orderedSessions.length < 2 || sessionLoading || !sessionInitialized,
  });

  const workspaceSession = useMemo(
    () => workspaceSessions.find((session) => session.id === currentSessionId) || null,
    [currentSessionId, workspaceSessions]
  );
  const workspaceDisplayName = currentWorkspaceNameOverride || workspaceSession?.name || t("plugin.blockTerm.title");

  const queueRuntimeInfoUpdate = useCallback(
    (sessionId: string, patch: Parameters<typeof terminalApi.updateRuntimeInfo>[1]) => {
      void enqueueSessionCommand(runtimeInfoWriteChainsRef.current, sessionId, async () => {
        await terminalApi.updateRuntimeInfo(sessionId, patch);
      }).catch(() => {});
    },
    []
  );

  const updateSessionBlock = useCallback(
    (sessionId: string, blockId: string, patch: Partial<BlockTermBlock>) => {
      if (patch.status !== undefined) blockStatusRef.current[blockId] = patch.status;
      setSessions((items) =>
        items.map((session) => {
          if (session.id !== sessionId) return session;
          const blocks = session.blocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block));
          if (
            patch.archived === undefined &&
            (patch.starred === undefined || !showStarredOnlyRef.current) &&
            (patch.status === undefined || !showRunningOnlyRef.current)
          )
            return { ...session, blocks };
          const previousVisible = getVisibleBlocks(session.blocks);
          const nextVisible = getVisibleBlocks(blocks);
          return {
            ...session,
            blocks,
            selectedBlockId: resolveVisibleBlockSelection(previousVisible, nextVisible, session.selectedBlockId),
          };
        })
      );
    },
    [getVisibleBlocks]
  );

  const enqueueBlockWrite = useCallback(
    <T,>(blockId: string, operation: () => Promise<T> | T): Promise<T> =>
      enqueueBlockPersistence(blockWriteChainsRef.current, blockId, operation),
    []
  );

  const flushBlockCreate = useCallback(
    (blockId: string): Promise<void> => {
      if (deletedBlockIdsRef.current.has(blockId)) {
        pendingBlockCreatesRef.current.delete(blockId);
        return Promise.resolve();
      }
      const existingRequest = createBlockRequestsRef.current.get(blockId);
      if (existingRequest) return existingRequest;
      const input = pendingBlockCreatesRef.current.get(blockId);
      if (!input) return Promise.resolve();

      const request = enqueueBlockWrite(blockId, () => blockTermApi.create(input)).then((response) => {
        const persisted = response.block;
        persistedBlockMetadataRef.current[blockId] = {
          createdAt: persisted.createdAt,
          runtimeType: persisted.runtimeType,
          ...(persisted.sshProfileId ? { sshProfileId: persisted.sshProfileId } : {}),
        };
        const live = sessionsRef.current.find((session) => session.id === input.terminalId);
        if (live?.blocks.some((block) => block.id === blockId)) {
          updateSessionBlock(input.terminalId, blockId, persistedBlockMetadataRef.current[blockId]);
        }
        if (pendingBlockCreatesRef.current.get(blockId) === input) {
          pendingBlockCreatesRef.current.delete(blockId);
        }
      });
      createBlockRequestsRef.current.set(blockId, request);
      void request
        .finally(() => {
          if (createBlockRequestsRef.current.get(blockId) === request) {
            createBlockRequestsRef.current.delete(blockId);
          }
        })
        .catch(() => {});
      return request;
    },
    [enqueueBlockWrite, updateSessionBlock]
  );

  const flushBlockPatch = useCallback(
    (blockId: string): Promise<void> => {
      const timer = persistTimersRef.current.get(blockId);
      if (timer) clearTimeout(timer);
      persistTimersRef.current.delete(blockId);
      const createRequest = createBlockRequestsRef.current.get(blockId);
      if (createRequest) {
        return createRequest.then(
          () => flushBlockPatch(blockId),
          (error) => Promise.reject(error)
        );
      }
      if (pendingBlockCreatesRef.current.has(blockId)) {
        return flushBlockCreate(blockId).then(() => flushBlockPatch(blockId));
      }
      const activeWrite = blockWriteChainsRef.current.get(blockId);
      if (activeWrite) {
        return activeWrite.then(
          () => flushBlockPatch(blockId),
          () => flushBlockPatch(blockId)
        );
      }
      const patch = persistPatchRef.current.get(blockId);
      const output = persistOutputRef.current.get(blockId);
      persistPatchRef.current.delete(blockId);
      persistOutputRef.current.delete(blockId);
      if ((!patch && !output) || deletedBlockIdsRef.current.has(blockId)) return Promise.resolve();
      return enqueueBlockWrite(blockId, async () => {
        if (deletedBlockIdsRef.current.has(blockId)) return;
        if (patch) await blockTermApi.update(blockId, patch);
        if (!output) return;
        try {
          await blockTermApi.putOutput(blockId, output.value, output.cursor);
          if (outputStore.markPersisted(blockId, output.contentRevision)) {
            const pendingOutput = persistOutputRef.current.get(blockId);
            if (pendingOutput?.value === output.value) persistOutputRef.current.delete(blockId);
            if (blockStatusRef.current[blockId] !== "running") {
              delete outputRef.current[blockId];
              delete terminalRawRef.current[blockId];
            }
          }
        } catch (error) {
          if (!(error instanceof BlockTermApiError) || error.status !== 409) throw error;
          const persisted = await blockTermApi.getOutput(blockId);
          const reconciled = outputStore.reconcileConflict(blockId, output.contentRevision, persisted);
          if (reconciled && !reconciled.dirty && blockStatusRef.current[blockId] !== "running") {
            delete outputRef.current[blockId];
            delete terminalRawRef.current[blockId];
          }
          if (reconciled?.dirty && reconciled.cursor !== null) {
            persistOutputRef.current.set(blockId, {
              value: outputStore.getFullValue(blockId),
              cursor: reconciled.cursor,
              contentRevision: reconciled.contentRevision,
            });
            const timer = setTimeout(() => {
              if (persistTimersRef.current.get(blockId) !== timer) return;
              persistTimersRef.current.delete(blockId);
              void flushBlockPatch(blockId).catch(() => {});
            }, 50);
            persistTimersRef.current.set(blockId, timer);
          }
        }
      }).catch((error) => {
        if (!deletedBlockIdsRef.current.has(blockId)) {
          if (patch) {
            const newerPatch = persistPatchRef.current.get(blockId) || {};
            persistPatchRef.current.set(blockId, mergeFailedBlockPatch(patch, newerPatch));
          }
          if (output && !persistOutputRef.current.has(blockId)) persistOutputRef.current.set(blockId, output);
        }
        throw error;
      });
    },
    [enqueueBlockWrite, flushBlockCreate, outputStore]
  );

  const persistBlockPatch = useCallback(
    (blockId: string, patch: Parameters<typeof blockTermApi.update>[1]) => {
      const disposition = getBlockTermPersistenceDisposition({
        deleted: deletedBlockIdsRef.current.has(blockId),
        deleting: deletingBlockIdsRef.current.has(blockId),
      });
      if (disposition === "discard") return;
      const previousTimer = persistTimersRef.current.get(blockId);
      if (previousTimer) clearTimeout(previousTimer);
      persistTimersRef.current.delete(blockId);
      const pendingPatch = persistPatchRef.current.get(blockId) || {};
      persistPatchRef.current.set(blockId, { ...pendingPatch, ...patch });
      if (disposition === "defer") return;
      const timer = setTimeout(() => {
        persistTimersRef.current.delete(blockId);
        void flushBlockPatch(blockId).catch(() => {});
      }, 250);
      persistTimersRef.current.set(blockId, timer);
    },
    [flushBlockPatch]
  );

  const cancelProcessIdentityTracker = useCallback((sessionId: string, blockId?: string) => {
    const current = processIdentityTrackersRef.current.get(sessionId);
    if (!current || (blockId && current.blockId !== blockId)) return;
    current.tracker.cancel();
    processIdentityTrackersRef.current.delete(sessionId);
  }, []);

  const cancelBlockProcessIdentityTracker = useCallback((blockId: string) => {
    for (const [sessionId, current] of processIdentityTrackersRef.current.entries()) {
      if (current.blockId !== blockId) continue;
      current.tracker.cancel();
      processIdentityTrackersRef.current.delete(sessionId);
    }
  }, []);

  const startProcessIdentityTracker = useCallback(
    (sessionId: string, blockId: string, scopeGeneration: number) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session || session.runtimeType !== "local") return;
      if (capturedProcessIdentityBlockIdsRef.current.has(blockId)) return;
      const existing = processIdentityTrackersRef.current.get(sessionId);
      if (
        existing &&
        existing.blockId === blockId &&
        existing.scopeGeneration === scopeGeneration &&
        existing.tracker.isActive()
      )
        return;
      cancelProcessIdentityTracker(sessionId);
      const token = processIdentityTokenRef.current + 1;
      processIdentityTokenRef.current = token;
      const tracker = startBlockTermProcessIdentityTracker({
        load: (signal) => terminalApi.getProcessIdentity(sessionId, { signal }),
        guard: () => {
          const current = processIdentityTrackersRef.current.get(sessionId);
          const runtime = runtimesRef.current.get(sessionId);
          const currentSession = sessionsRef.current.find((item) => item.id === sessionId);
          return {
            tokenMatches:
              current?.token === token && current.blockId === blockId && current.scopeGeneration === scopeGeneration,
            scopeMatches:
              scopeGenerationRef.current === scopeGeneration && runtime?.scopeGeneration === scopeGeneration,
            sessionRunning:
              currentSession?.runtimeType === "local" &&
              currentSession.status !== "exited" &&
              currentSession.status !== "closed",
            blockRunning:
              !deletedBlockIdsRef.current.has(blockId) &&
              sessionActiveBlockRef.current[sessionId] === blockId &&
              blockStatusRef.current[blockId] === "running",
          };
        },
        onAccept: (pid) => {
          const current = processIdentityTrackersRef.current.get(sessionId);
          if (current?.token !== token || current.blockId !== blockId || current.scopeGeneration !== scopeGeneration)
            return;
          processIdentityTrackersRef.current.delete(sessionId);
          capturedProcessIdentityBlockIdsRef.current.add(blockId);
          updateSessionBlock(sessionId, blockId, { cmdPid: pid });
          persistBlockPatch(blockId, { cmdPid: pid });
        },
        initialDelayMs: 10,
        pollIntervalMs: 50,
        timeoutMs: 2000,
      });
      processIdentityTrackersRef.current.set(sessionId, { blockId, scopeGeneration, token, tracker });
    },
    [cancelProcessIdentityTracker, persistBlockPatch, updateSessionBlock]
  );

  const startActiveProcessIdentityTracker = useCallback(
    (sessionId: string, scopeGeneration: number) => {
      const blockId = sessionActiveBlockRef.current[sessionId];
      if (!blockId || blockStatusRef.current[blockId] !== "running") return;
      startProcessIdentityTracker(sessionId, blockId, scopeGeneration);
    },
    [startProcessIdentityTracker]
  );

  const persistBlockOutput = useCallback(
    (blockId: string, snapshot = outputStore.getSnapshot(blockId)) => {
      if (snapshot.cursor === null || !snapshot.dirty) return;
      const disposition = getBlockTermPersistenceDisposition({
        deleted: deletedBlockIdsRef.current.has(blockId),
        deleting: deletingBlockIdsRef.current.has(blockId),
      });
      if (disposition === "discard") return;
      const previousTimer = persistTimersRef.current.get(blockId);
      if (previousTimer) clearTimeout(previousTimer);
      persistTimersRef.current.delete(blockId);
      persistOutputRef.current.set(blockId, {
        value: outputStore.getFullValue(blockId),
        cursor: snapshot.cursor,
        contentRevision: snapshot.contentRevision,
      });
      if (disposition === "defer") return;
      const timer = setTimeout(() => {
        persistTimersRef.current.delete(blockId);
        void flushBlockPatch(blockId).catch(() => {});
      }, 250);
      persistTimersRef.current.set(blockId, timer);
    },
    [flushBlockPatch, outputStore]
  );

  const flushBlockPersistence = useCallback(
    (blockIds?: Iterable<string>): Promise<void> =>
      drainBlockPersistence(blockIds, {
        collectIds: () => {
          const ids = new Set<string>();
          for (const session of sessionsRef.current) {
            for (const block of session.blocks) ids.add(block.id);
          }
          for (const id of persistPatchRef.current.keys()) ids.add(id);
          for (const id of persistOutputRef.current.keys()) ids.add(id);
          for (const id of persistTimersRef.current.keys()) ids.add(id);
          for (const id of pendingBlockCreatesRef.current.keys()) ids.add(id);
          for (const id of createBlockRequestsRef.current.keys()) ids.add(id);
          for (const id of blockWriteChainsRef.current.keys()) ids.add(id);
          return ids;
        },
        flush: async (blockId) => {
          await flushBlockCreate(blockId);
          await flushBlockPatch(blockId);
        },
        getWriteChain: (blockId) => blockWriteChainsRef.current.get(blockId),
        hasPending: (targetIds) => {
          const includes = (id: string) => targetIds === undefined || targetIds.has(id);
          for (const id of persistPatchRef.current.keys()) if (includes(id)) return true;
          for (const id of persistOutputRef.current.keys()) if (includes(id)) return true;
          for (const id of persistTimersRef.current.keys()) if (includes(id)) return true;
          for (const id of pendingBlockCreatesRef.current.keys()) if (includes(id)) return true;
          for (const id of createBlockRequestsRef.current.keys()) if (includes(id)) return true;
          for (const id of blockWriteChainsRef.current.keys()) if (includes(id)) return true;
          return false;
        },
      }),
    [flushBlockCreate, flushBlockPatch]
  );

  const createBlockRecord = useCallback(
    (input: Parameters<typeof blockTermApi.create>[0]): Promise<void> => {
      if (!input.id) return Promise.reject(new Error("Block ID is required"));
      pendingBlockCreatesRef.current.set(input.id, input);
      return flushBlockCreate(input.id);
    },
    [flushBlockCreate]
  );

  const compensateUnconfirmedModelRun = useCallback(
    async (blockId: string): Promise<void> => {
      await enqueueBlockWrite(blockId, async () => {
        await compensateUnconfirmedBlockTermModelRun({
          cancel: () => blockTermModelApi.cancel(blockId),
          remove: () => blockTermApi.remove(blockId),
        });
      }).catch(() => {});
    },
    [enqueueBlockWrite]
  );

  const discardReplayBlock = useCallback(
    (sessionId: string, blockId: string) => {
      // A tombstoned ID must stay suppressed for the rest of this replay. The
      // next persisted-block listing will confirm the tombstone as well.
      deletedBlockIdsRef.current.add(blockId);
      const binding = blockTokenRef.current[blockId];
      if (binding?.sessionId === sessionId) {
        void closeBlockRuntimeRef.current(sessionId, blockId, binding.token, false);
        forgetBlockTermRuntimeBinding(sessionId, blockId, binding.token);
      }
      independentBlockIdsRef.current.delete(blockId);
      const persistTimer = persistTimersRef.current.get(blockId);
      if (persistTimer) clearTimeout(persistTimer);
      persistTimersRef.current.delete(blockId);
      pendingBlockCreatesRef.current.delete(blockId);
      persistPatchRef.current.delete(blockId);
      persistOutputRef.current.delete(blockId);
      stopSequencesRef.current.get(blockId)?.cancel();
      stopSequencesRef.current.delete(blockId);
      cancelProcessIdentityTracker(sessionId, blockId);
      capturedProcessIdentityBlockIdsRef.current.delete(blockId);
      interruptedBlocksRef.current.delete(blockId);
      delete outputRef.current[blockId];
      delete terminalRawRef.current[blockId];
      delete modeRef.current[blockId];
      delete blockStatusRef.current[blockId];
      delete blockTokenRef.current[blockId];
      delete blockOutputPhaseRef.current[blockId];
      delete blockRestartTransitionRef.current[blockId];
      delete rawTargetCursorRef.current[blockId];
      delete rawAcknowledgedTargetCursorRef.current[blockId];
      delete blockCompletionCursorRef.current[blockId];
      clearBlockTermRendererCache(blockId);
      const runtime = xtermRefs.current.get(blockId);
      if (runtime) {
        disposeTerminalRuntime(runtime);
        xtermRefs.current.delete(blockId);
      }
      outputStore.delete(blockId);
      if (sessionActiveBlockRef.current[sessionId] === blockId) sessionActiveBlockRef.current[sessionId] = null;
      if (interruptedOutputBlockRef.current[sessionId] === blockId) interruptedOutputBlockRef.current[sessionId] = null;
      setSessions((items) =>
        items.map((session) => {
          if (session.id !== sessionId) return session;
          const blocks = session.blocks.filter((block) => block.id !== blockId);
          return {
            ...session,
            activeBlockId: session.activeBlockId === blockId ? null : session.activeBlockId,
            blocks,
            selectedBlockId: resolveVisibleBlockSelection(
              getVisibleBlocks(session.blocks),
              getVisibleBlocks(blocks),
              session.selectedBlockId
            ),
          };
        })
      );
    },
    [cancelProcessIdentityTracker, getVisibleBlocks, outputStore]
  );

  const finalizeRunningBlocks = useCallback(
    (sessionId: string, candidateBlockIds?: string[]) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const hasExplicitCandidates = candidateBlockIds !== undefined;
      const candidateIds = new Set(
        candidateBlockIds ||
          session?.blocks
            .filter(
              (block) =>
                !independentBlockIdsRef.current.has(block.id) &&
                (blockStatusRef.current[block.id] ?? block.status) === "running"
            )
            .map((block) => block.id) ||
          []
      );
      const activeBlockId = sessionActiveBlockRef.current[sessionId];
      if (!hasExplicitCandidates && activeBlockId && blockStatusRef.current[activeBlockId] === "running") {
        candidateIds.add(activeBlockId);
      }
      const runningBlockIds = Array.from(candidateIds).filter(
        (blockId) => !independentBlockIdsRef.current.has(blockId) && blockStatusRef.current[blockId] === "running"
      );
      const transitionRuntime = runtimesRef.current.get(sessionId);
      if (
        transitionRuntime?.transitionPrimaryBinding &&
        candidateIds.has(transitionRuntime.transitionPrimaryBinding.blockId)
      ) {
        clearBlockTermTransitionTimer(transitionRuntime);
        transitionRuntime.transitionPrimaryBinding = null;
      }
      for (const block of session?.blocks || []) {
        if (
          candidateIds.has(block.id) &&
          !independentBlockIdsRef.current.has(block.id) &&
          (blockStatusRef.current[block.id] ?? block.status) === "running" &&
          !runningBlockIds.includes(block.id)
        ) {
          runningBlockIds.push(block.id);
        }
      }
      if (
        activeBlockId &&
        candidateIds.has(activeBlockId) &&
        !independentBlockIdsRef.current.has(activeBlockId) &&
        blockStatusRef.current[activeBlockId] === "running" &&
        !runningBlockIds.includes(activeBlockId)
      ) {
        runningBlockIds.push(activeBlockId);
      }
      if (runningBlockIds.length === 0) {
        if (!hasExplicitCandidates || candidateIds.has(sessionActiveBlockRef.current[sessionId] || "")) {
          const clearedBlockId = sessionActiveBlockRef.current[sessionId];
          if (clearedBlockId) delete blockOutputPhaseRef.current[clearedBlockId];
          sessionActiveBlockRef.current[sessionId] = null;
          const interruptedBlockId = interruptedOutputBlockRef.current[sessionId];
          if (interruptedBlockId) {
            delete blockOutputPhaseRef.current[interruptedBlockId];
            interruptedOutputBlockRef.current[sessionId] = null;
          }
        }
        return;
      }

      const finishedAt = Date.now();
      const runningIds = new Set(runningBlockIds);
      const afterStateByBlockId = new Map<string, string>();
      const interruptionState = session
        ? resolveBlockTermInterruptedState({
            session,
            blockId: runningBlockIds[0] || "",
            activeBlockId: activeBlockId,
            phase: "runtime-exit",
          })
        : null;
      for (const blockId of runningBlockIds) {
        const command = session?.blocks.find((block) => block.id === blockId)?.command;
        const afterStateJson = session
          ? resolveBlockTermInterruptedState({
              session,
              blockId,
              activeBlockId,
              command,
              phase: "runtime-exit",
            }).afterStateJson
          : undefined;
        if (afterStateJson) afterStateByBlockId.set(blockId, afterStateJson);
        bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
        stopSequencesRef.current.get(blockId)?.cancel();
        stopSequencesRef.current.delete(blockId);
        cancelProcessIdentityTracker(sessionId, blockId);
        // A PTY exit without an OSC end frame does not provide a trustworthy
        // command exit code. Mark the block interrupted consistently in memory
        // and persistence instead of leaving it permanently running.
        blockStatusRef.current[blockId] = "interrupted";
        delete blockTokenRef.current[blockId];
        delete blockOutputPhaseRef.current[blockId];
        delete blockRestartTransitionRef.current[blockId];
        interruptedBlocksRef.current.delete(blockId);
        persistBlockPatch(blockId, {
          status: "interrupted",
          exitCode: null,
          afterStateJson,
          finishedAt,
        });
        outputStore.setPinned(blockId, "running", false);
        if (!outputStore.getSnapshot(blockId).dirty) {
          delete outputRef.current[blockId];
          delete terminalRawRef.current[blockId];
        }
      }
      sessionActiveBlockRef.current[sessionId] = null;
      interruptedOutputBlockRef.current[sessionId] = null;
      if (interruptionState) {
        setSessionPatch(sessionId, interruptionState.sessionPatch);
        if (interruptionState.runtimePatch) queueRuntimeInfoUpdate(sessionId, interruptionState.runtimePatch);
      }
      setSessions((items) =>
        items.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                activeBlockId: null,
                blocks: item.blocks.map((block) =>
                  runningIds.has(block.id)
                    ? {
                        ...block,
                        status: "interrupted" as const,
                        exitCode: null,
                        afterStateJson: afterStateByBlockId.get(block.id),
                        finishedAt,
                      }
                    : block
                ),
                selectedBlockId: resolveVisibleBlockSelection(
                  getVisibleBlocks(item.blocks),
                  getVisibleBlocks(
                    item.blocks.map((block) =>
                      runningIds.has(block.id)
                        ? {
                            ...block,
                            status: "interrupted" as const,
                            exitCode: null,
                            afterStateJson: afterStateByBlockId.get(block.id),
                            finishedAt,
                          }
                        : block
                    )
                  ),
                  item.selectedBlockId
                ),
              }
            : item
        )
      );
    },
    [
      cancelProcessIdentityTracker,
      getVisibleBlocks,
      outputStore,
      persistBlockPatch,
      queueRuntimeInfoUpdate,
      setSessionPatch,
    ]
  );

  const ensureBlockOutputLoaded = useCallback(
    (blockId: string, force = false) =>
      outputStore.load(blockId, (_id, signal) => blockTermApi.getOutput(blockId, signal), force),
    [outputStore]
  );

  // Completion frames can arrive before a terminal renderer is mounted. Keep
  // the furthest completion watermark page-locally and acknowledge it only
  // after a later raw GET crosses the recorder barrier successfully.
  const queueTerminalRawTarget = useCallback((blockId: string, endCursor?: number | null): boolean => {
    const current = rawTargetCursorRef.current[blockId] ?? null;
    const next = mergeBlockTermRawTarget(current, endCursor);
    const changed = next !== current;
    rawTargetCursorRef.current[blockId] = next;
    const runtime = xtermRefs.current.get(blockId);
    if (runtime && !runtime.disposed) {
      runtime.rawTargetCursor = mergeBlockTermRawTarget(runtime.rawTargetCursor, endCursor);
      if (
        changed ||
        endCursor === undefined ||
        !hasAcknowledgedBlockTermRawTarget(runtime.rawAcknowledgedTargetCursor, runtime.rawTargetCursor)
      ) {
        reopenRawSyncState(runtime);
        if (runtime.rawSyncInFlight) runtime.rawSyncPending = true;
      }
    }
    requestTerminalRawSyncRef.current(blockId);
    return changed;
  }, []);

  const releaseInterruptedOutputBlock = useCallback(
    (sessionId: string, expectedBlockId?: string, requestRaw = true, expectedToken?: string): string | null => {
      const blockId = interruptedOutputBlockRef.current[sessionId];
      if (!blockId || (expectedBlockId && blockId !== expectedBlockId)) return null;
      const binding = blockTokenRef.current[blockId];
      if (binding && binding.sessionId !== sessionId) return null;
      if (binding && (!expectedToken || binding.token !== expectedToken)) return null;
      if (expectedToken && (!binding || binding.token !== expectedToken)) return null;
      bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
      interruptedOutputBlockRef.current[sessionId] = null;
      stopSequencesRef.current.get(blockId)?.cancel();
      stopSequencesRef.current.delete(blockId);
      const transitionRuntime = runtimesRef.current.get(sessionId);
      if (transitionRuntime?.transitionPrimaryBinding?.blockId === blockId) {
        clearBlockTermTransitionTimer(transitionRuntime);
        transitionRuntime.transitionPrimaryBinding = null;
      }
      cancelProcessIdentityTracker(sessionId, blockId);
      interruptedBlocksRef.current.delete(blockId);
      delete blockTokenRef.current[blockId];
      delete blockOutputPhaseRef.current[blockId];
      const restartTransition = blockRestartTransitionRef.current[blockId];
      if (
        restartTransition?.sessionId === sessionId &&
        expectedToken !== undefined &&
        restartTransition.token === expectedToken
      ) {
        delete blockRestartTransitionRef.current[blockId];
      }
      if (requestRaw) {
        // Re-open even an already-settled historical renderer. Releasing a
        // retained tail is a byte ownership boundary, so a pending raw GET
        // must observe the post-boundary stream rather than remain short-circuited
        // by the previous rawSynced flag.
        const runtime = xtermRefs.current.get(blockId);
        if (runtime && !runtime.disposed) {
          reopenRawSyncState(runtime);
          if (runtime.rawSyncInFlight) runtime.rawSyncPending = true;
        }
        requestTerminalRawSyncRef.current(blockId);
      }
      return blockId;
    },
    [cancelProcessIdentityTracker]
  );

  useEffect(() => {
    const blockId = activeSession?.selectedBlockId;
    if (!blockId) return;
    void ensureBlockOutputLoaded(blockId).catch(() => {});
  }, [activeSession?.selectedBlockId, ensureBlockOutputLoaded]);

  const loadCommandHistory = useCallback(async (sessionId: string) => {
    const scopeGeneration = scopeGenerationRef.current;
    const requestId = (historyLoadRequestRef.current[sessionId] || 0) + 1;
    historyLoadRequestRef.current[sessionId] = requestId;
    try {
      const result = await blockTermApi.listHistory({ terminalId: sessionId, limit: 200 });
      if (scopeGenerationRef.current !== scopeGeneration || historyLoadRequestRef.current[sessionId] !== requestId)
        return;
      const history = recentCommandHistory(result.history, 100);
      setSessions((items) =>
        items.map((session) => {
          if (session.id !== sessionId) return session;
          if (session.historyIndex < 0) return { ...session, history };
          const recalledHistoryIndex = history.indexOf(session.draft);
          if (recalledHistoryIndex >= 0) return { ...session, history, historyIndex: recalledHistoryIndex };
          return {
            ...session,
            draft: session.historyDraft ?? "",
            history,
            historyIndex: -1,
            historyDraft: null,
          };
        })
      );
    } catch {
      // History is independent of block restore; keep the current draft usable.
    }
  }, []);

  const loadPersistedBlocksRequest = useCallback(
    async (
      sessionId: string,
      scopeGeneration: number,
      isCurrentLoad: () => boolean
    ): Promise<BlockTermInventoryLoadOutcome<BlockTermBlock>> => {
      const loadToastId = `blockterm-blocks-load-${sessionId}`;
      try {
        let result = await blockTermApi.list(sessionId, { includeOutput: false });
        // replay_done and the initial restore can both request the same list.
        // Do not let an older response roll back a newer live state.
        if (!isCurrentLoad()) return { kind: "stale" };
        toast.dismiss(loadToastId);

        for (const blockId of result.deletedBlockIds) deletedBlockIdsRef.current.add(blockId);
        let persistedBlocks = result.blocks.filter((block) => !deletedBlockIdsRef.current.has(block.id));
        const storedBindings = loadBlockTermRuntimeBindings().filter((binding) => binding.terminalId === sessionId);
        const runningBlockIds = new Set(
          persistedBlocks.filter((block) => block.status === "running").map((block) => block.id)
        );
        pruneBlockTermRuntimeBindings(sessionId, runningBlockIds);
        const restoredRuntimeBindings: BlockTermRuntimeBinding[] = [];
        const settlingRuntimeBindings: BlockTermRuntimeBinding[] = [];
        const staleRuntimeBlockIds = new Set<string>();
        for (const binding of storedBindings) {
          if (!runningBlockIds.has(binding.blockId)) continue;
          try {
            const response = await blockTermApi.getRuntime(binding.terminalId, binding.blockId, binding.blockToken);
            const info = response.runtime;
            if (
              info.terminal_id !== binding.terminalId ||
              info.block_id !== binding.blockId ||
              info.block_token !== binding.blockToken
            ) {
              forgetBlockTermRuntimeBinding(binding.terminalId, binding.blockId, binding.blockToken);
              staleRuntimeBlockIds.add(binding.blockId);
              continue;
            }
            independentBlockIdsRef.current.add(binding.blockId);
            blockTokenRef.current[binding.blockId] = { sessionId, token: binding.blockToken };
            blockOutputPhaseRef.current[binding.blockId] = { sessionId, phase: "expected" };
            if (info.status === "running" || info.status === "streaming") restoredRuntimeBindings.push(binding);
            else settlingRuntimeBindings.push(binding);
          } catch (error) {
            const status = getRequestErrorStatus(error);
            if (status === 404 || status === 409) {
              forgetBlockTermRuntimeBinding(binding.terminalId, binding.blockId, binding.blockToken);
              staleRuntimeBlockIds.add(binding.blockId);
              continue;
            }
            // The inventory request succeeded, so keep the exact binding and
            // let the websocket reconnect path distinguish a transient probe
            // failure from a retired route.
            independentBlockIdsRef.current.add(binding.blockId);
            blockTokenRef.current[binding.blockId] = { sessionId, token: binding.blockToken };
            blockOutputPhaseRef.current[binding.blockId] = { sessionId, phase: "expected" };
            restoredRuntimeBindings.push(binding);
          }
        }
        if (staleRuntimeBlockIds.size > 0) {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            if (!isCurrentLoad()) return { kind: "stale" };
            result = await blockTermApi.list(sessionId, { includeOutput: false });
            for (const blockId of result.deletedBlockIds) deletedBlockIdsRef.current.add(blockId);
            persistedBlocks = result.blocks.filter((block) => !deletedBlockIdsRef.current.has(block.id));
            const unsettled = persistedBlocks.some(
              (block) => staleRuntimeBlockIds.has(block.id) && block.status === "running"
            );
            if (!unsettled) break;
            if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
          }
          for (const block of persistedBlocks) {
            if (staleRuntimeBlockIds.has(block.id) && block.status === "running") {
              // This row is known to have belonged to a child runtime even
              // though its stale token can no longer be used. Never assign it
              // to the parent recorder while durable finalization catches up.
              independentBlockIdsRef.current.add(block.id);
            }
          }
        }
        const interruptedBlockIds: string[] = [];
        for (const block of persistedBlocks) {
          const pendingPatch = persistPatchRef.current.get(block.id);
          const localStatus = blockStatusRef.current[block.id];
          const localMode = modeRef.current[block.id];
          if (block.output) outputStore.hydrate(block.id, block.output, block.outputCursor);
          else outputStore.prime(block.id, block.outputSize, block.outputCursor);
          // A live start/finish or an interrupted stop is newer than the list
          // request. Preserve those local state transitions when merging.
          const status = resolveBlockTermRestoredStatus({
            persistedStatus: block.status,
            localStatus,
            pendingStatus: pendingPatch?.status,
          });
          const mode = localMode || block.mode;
          modeRef.current[block.id] = mode;
          blockStatusRef.current[block.id] = status;
          outputStore.setPinned(block.id, "running", isActiveBlockStatus(status));
          outputStore.setPinned(block.id, "block-pin", pendingPatch?.pinned ?? block.pinned);
          if (status === "interrupted") interruptedBlockIds.push(block.id);
        }
        // Interrupted blocks can still receive the recorder's trailing bytes
        // or a delayed end frame after restore. Hydrate their durable snapshot
        // before releasing the handshake FIFO; otherwise appendLive would
        // treat the metadata-only prime as the complete output and replace the
        // historical prefix with only the tail.
        await Promise.all(
          interruptedBlockIds.map(async (blockId) => {
            try {
              const snapshot = await ensureBlockOutputLoaded(blockId);
              if (!isCurrentLoad()) return;
              outputRef.current[blockId] = snapshot.value;
            } catch {
              // A missing snapshot is still recoverable from raw segments when
              // a completion watermark or retained tail is available.
            }
          })
        );
        if (!isCurrentLoad()) return { kind: "stale" };
        const persistedNextLine = persistedBlocks.reduce(
          (next, block, index) => Math.max(next, (block.lineNum ?? index) + 1),
          0
        );
        nextLineNumRef.current[sessionId] = Math.max(nextLineNumRef.current[sessionId] || 0, persistedNextLine);
        const mergePersistedInventory = (session?: BlockTermSession): BlockTermBlock[] => {
          const existingById = new Map((session?.blocks || []).map((block) => [block.id, block]));
          const mergedBlocks = persistedBlocks.map((block) => {
            const existing = existingById.get(block.id);
            const pendingPatch = persistPatchRef.current.get(block.id);
            const localStatus = blockStatusRef.current[block.id];
            const localMode = modeRef.current[block.id];
            const outputSnapshot = outputStore.getSnapshot(block.id);
            return mergeBlockTermPersistedBlock({
              persisted: block,
              existing,
              pendingPatch,
              localStatus,
              localMode,
              outputSize: outputSnapshot.outputSize,
              outputCursor: outputSnapshot.cursor,
            });
          });
          const localOnlyBlocks = (session?.blocks || []).filter(
            (block) =>
              !deletedBlockIdsRef.current.has(block.id) && !persistedBlocks.some((item) => item.id === block.id)
          );
          return [...mergedBlocks, ...localOnlyBlocks];
        };
        const currentSession = sessionsRef.current.find((session) => session.id === sessionId);
        const restoredBlocks = mergePersistedInventory(currentSession);
        const ownerResolution = resolveBlockTermRestoredOwner({
          sessionId,
          currentActiveBlockId: sessionActiveBlockRef.current[sessionId],
          ended: currentSession?.status === "exited" || currentSession?.status === "closed",
          blocks: restoredBlocks.filter((block) => !independentBlockIdsRef.current.has(block.id)),
        });
        if (ownerResolution.releasedBlockId) {
          bumpBlockTermLifecycleFence(blockLifecycleFenceRef, ownerResolution.releasedBlockId);
          stopSequencesRef.current.get(ownerResolution.releasedBlockId)?.cancel();
          stopSequencesRef.current.delete(ownerResolution.releasedBlockId);
          cancelProcessIdentityTracker(sessionId, ownerResolution.releasedBlockId);
          interruptedBlocksRef.current.delete(ownerResolution.releasedBlockId);
          delete blockTokenRef.current[ownerResolution.releasedBlockId];
          delete blockOutputPhaseRef.current[ownerResolution.releasedBlockId];
          if (interruptedOutputBlockRef.current[sessionId] === ownerResolution.releasedBlockId) {
            interruptedOutputBlockRef.current[sessionId] = null;
          }
        }
        sessionActiveBlockRef.current[sessionId] = ownerResolution.activeBlockId;
        if (ownerResolution.activeBlockId) {
          const currentPhase = blockOutputPhaseRef.current[ownerResolution.activeBlockId];
          if (currentPhase?.sessionId !== sessionId) {
            blockOutputPhaseRef.current[ownerResolution.activeBlockId] = { sessionId, phase: "expected" };
          }
        }
        setSessions((items) => {
          const next = items.map((session) => {
            if (session.id !== sessionId) return session;
            const blocks = mergePersistedInventory(session);
            const ended = session.status === "exited" || session.status === "closed";
            const activeBlock = resolveBlockTermRestoredOwner({
              sessionId,
              currentActiveBlockId: sessionActiveBlockRef.current[sessionId],
              ended,
              blocks: blocks.filter((block) => !independentBlockIdsRef.current.has(block.id)),
            }).activeBlockId;
            return {
              ...session,
              blocks,
              selectedBlockId: resolveVisibleBlockSelection(
                getVisibleBlocks(session.blocks),
                getVisibleBlocks(blocks),
                session.selectedBlockId
              ),
              activeBlockId: ended ? null : activeBlock,
              status: ended
                ? session.status
                : activeBlock
                  ? "running"
                  : session.status === "running"
                    ? "ready"
                    : session.status,
            };
          });
          sessionsRef.current = next;
          return next;
        });
        const persistedRunningBlockIds = persistedBlocks
          .filter((block) => (blockStatusRef.current[block.id] ?? block.status) === "running")
          .map((block) => block.id);
        await Promise.all(
          persistedRunningBlockIds.map(async (blockId) => {
            try {
              const snapshot = await ensureBlockOutputLoaded(blockId);
              if (!isCurrentLoad()) return;
              outputRef.current[blockId] = snapshot.value;
            } catch {
              // Replay can still reconstruct a running block when its stored snapshot is unavailable.
            }
          })
        );
        if (!isCurrentLoad()) return { kind: "stale" };
        for (const binding of restoredRuntimeBindings) {
          connectBlockRuntimeRef.current(sessionId, binding.blockId, binding.blockToken, scopeGeneration);
        }
        for (const binding of settlingRuntimeBindings) {
          void reconcileBlockRuntimeRef.current(sessionId, binding.blockId, binding.blockToken, scopeGeneration);
        }
        persistedBlocksLoadedGenerationRef.current = {
          ...persistedBlocksLoadedGenerationRef.current,
          [sessionId]: scopeGeneration,
        };
        // Inventory completion is stored in a ref because close/replay paths
        // read it synchronously. Publish a state revision so pending consumers
        // also observe the transition when the loaded inventory is empty.
        setSessions((items) => items.map((session) => (session.id === sessionId ? { ...session } : session)));
        return { kind: "loaded", blocks: restoredBlocks };
      } catch (error) {
        if (!isCurrentLoad()) return { kind: "stale" };
        const pendingHistoryActivation = pendingHistoryEntryRef.current;
        if (
          pendingHistoryActivation?.scopeGeneration === scopeGeneration &&
          pendingHistoryActivation.entry.terminalId === sessionId
        ) {
          pendingHistoryEntryRef.current = null;
        }
        toast.error(t("plugin.blockTerm.loadBlocksFailed"), {
          id: loadToastId,
          description: error instanceof Error ? error.message : undefined,
          action: {
            label: t("plugin.blockTerm.retryRestore"),
            onClick: () => {
              const runtime = runtimesRef.current.get(sessionId);
              if (runtime?.ws) {
                runtime.allowReconnect = true;
                runtime.ws.close();
                return;
              }
              connectSessionRef.current(sessionId, scopeGeneration);
            },
          },
        });
        return { kind: "failed", error };
      }
    },
    [cancelProcessIdentityTracker, ensureBlockOutputLoaded, getVisibleBlocks, outputStore, t]
  );

  const loadPersistedBlocks = useCallback(
    (sessionId: string): Promise<BlockTermInventoryLoadOutcome<BlockTermBlock>> => {
      const scopeGeneration = scopeGenerationRef.current;
      const requestId = (persistedLoadRequestRef.current[sessionId] || 0) + 1;
      persistedLoadRequestRef.current[sessionId] = requestId;
      const isCurrentLoad = (): boolean =>
        scopeGenerationRef.current === scopeGeneration && persistedLoadRequestRef.current[sessionId] === requestId;
      const request = loadPersistedBlocksRequest(sessionId, scopeGeneration, isCurrentLoad);
      const requestNode: BlockTermInventoryLoadRequest<BlockTermBlock> = {
        scopeGeneration,
        requestId,
        promise: request,
      };
      persistedLoadPromiseRef.current[sessionId] = requestNode;
      return request.then((outcome) =>
        followSupersedingBlockTermInventoryLoad(outcome, requestNode, () => persistedLoadPromiseRef.current[sessionId])
      );
    },
    [loadPersistedBlocksRequest]
  );

  const sendInput = useCallback((sessionId: string, data: string, blockId?: string, blockToken?: string): boolean => {
    if (blockId || blockToken) {
      if (!blockId || !blockToken) return false;
      const runtime = blockRuntimesRef.current.get(blockId);
      if (
        !runtime ||
        runtime.sessionId !== sessionId ||
        runtime.blockToken !== blockToken ||
        runtime.ws?.readyState !== WebSocket.OPEN
      )
        return false;
      try {
        runtime.ws.send(JSON.stringify(createBlockTermRoutedInputMessage(data, runtime.route)));
        return true;
      } catch {
        return false;
      }
    }
    const ws = runtimesRef.current.get(sessionId)?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(createBlockTermRoutedInputMessage(data, createBlockTermTerminalRoute(sessionId))));
      return true;
    } catch {
      return false;
    }
  }, []);

  const sendTerminalSignal = useCallback(
    (sessionId: string, blockId: string, signal: "INT" | "TERM" | "KILL"): boolean => {
      const blockToken = resolveBlockTermStopToken(sessionId, blockTokenRef.current[blockId]);
      if (!blockToken) return false;
      const blockRuntime = blockRuntimesRef.current.get(blockId);
      const blockWs = blockRuntime?.ws;
      if (independentBlockIdsRef.current.has(blockId) || blockRuntime) {
        if (
          !blockRuntime ||
          blockRuntime.sessionId !== sessionId ||
          blockRuntime.blockToken !== blockToken ||
          !blockWs ||
          blockWs.readyState !== WebSocket.OPEN
        )
          return false;
        try {
          blockWs.send(JSON.stringify(createBlockTermRoutedSignalMessage(signal, blockRuntime.route)));
          return true;
        } catch {
          return false;
        }
      }

      const parentWs = runtimesRef.current.get(sessionId)?.ws;
      if (!parentWs || parentWs.readyState !== WebSocket.OPEN) return false;
      try {
        parentWs.send(JSON.stringify(createBlockTermSignalMessage(signal, blockId, blockToken)));
        return true;
      } catch {
        if (signal !== "INT") return false;
        return sendInput(sessionId, "\x03");
      }
    },
    [sendInput]
  );

  const resizeBlockRuntime = useCallback(
    (sessionId: string, blockId: string, cols: number, rows: number): boolean => {
      const binding = blockTokenRef.current[blockId];
      const runtime = blockRuntimesRef.current.get(blockId);
      const ws = runtime?.ws;
      if (
        !isCurrentIndependentBlockOwner(sessionId, blockId) ||
        binding?.sessionId !== sessionId ||
        !runtime ||
        runtime.sessionId !== sessionId ||
        runtime.blockToken !== binding.token ||
        !ws ||
        ws.readyState !== WebSocket.OPEN
      )
        return false;
      try {
        ws.send(JSON.stringify(createBlockTermRoutedResizeMessage(cols, rows, runtime.route)));
        updateSessionBlock(sessionId, blockId, { termCols: cols, termRows: rows });
        return true;
      } catch {
        return false;
      }
    },
    [isCurrentIndependentBlockOwner, updateSessionBlock]
  );

  const resizeSession = useCallback((sessionId: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) => {
    const ws = runtimesRef.current.get(sessionId)?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(createBlockTermRoutedResizeMessage(cols, rows, createBlockTermTerminalRoute(sessionId))));
      return true;
    } catch {
      return false;
    }
  }, []);

  const syncMountedBlockRuntime = useCallback((blockId: string) => {
    const terminalRuntime = xtermRefs.current.get(blockId);
    if (!terminalRuntime || terminalRuntime.disposed) return;
    const binding = blockTokenRef.current[blockId];
    const blockRuntime = blockRuntimesRef.current.get(blockId);
    const block = sessionsRef.current
      .find((session) => session.id === binding?.sessionId)
      ?.blocks.find((candidate) => candidate.id === blockId);
    const status = blockStatusRef.current[blockId] ?? block?.status;
    const active =
      !!binding &&
      !!blockRuntime &&
      blockRuntime.sessionId === binding.sessionId &&
      blockRuntime.blockToken === binding.token &&
      blockRuntime.scopeGeneration === scopeGenerationRef.current &&
      blockRuntime.allowReconnect &&
      blockRuntime.ws?.readyState === WebSocket.OPEN &&
      (status === "running" || status === "streaming");
    terminalRuntime.terminal.options.disableStdin = !active;
    terminalRuntime.terminal.options.cursorBlink = active;
    terminalRuntime.isRunning = status === "running" || status === "streaming";
  }, []);

  const appendBlockOutput = useCallback(
    (_sessionId: string, blockId: string, raw: string, replay = false) => {
      let clean = stripAnsiForText(raw);
      if (!clean) return;
      const previous = outputRef.current[blockId] || "";
      if (replay) clean = missingReplaySuffix(previous, clean);
      if (!clean) return;
      const snapshot = outputStore.appendLive(blockId, clean);
      outputRef.current[blockId] = snapshot.value;
      if (!independentBlockIdsRef.current.has(blockId)) persistBlockOutput(blockId, snapshot);
    },
    [outputStore, persistBlockOutput]
  );

  const appendTerminalOutput = useCallback(
    (_sessionId: string, blockId: string, raw: string, replay = false) => {
      if (!raw) return;
      const previous = outputRef.current[blockId] || "";
      const incoming = replay ? missingReplaySuffix(previous, raw) : raw;
      if (!incoming) return;
      const snapshot = outputStore.appendLive(blockId, incoming);
      outputRef.current[blockId] = snapshot.value;
      if (!independentBlockIdsRef.current.has(blockId)) persistBlockOutput(blockId, snapshot);
    },
    [outputStore, persistBlockOutput]
  );

  const writeTerminalOutput = useCallback((blockId: string, raw: string | Uint8Array) => {
    if (!raw || (raw instanceof Uint8Array && raw.length === 0)) return;
    const runtime = xtermRefs.current.get(blockId);
    if (runtime) {
      if (runtime.rawSyncTimer !== null) clearTimeout(runtime.rawSyncTimer);
      runtime.rawSyncTimer = null;
      runtime.rawSyncController?.abort();
      runtime.rawSyncController = null;
      resetRawSyncState(runtime);
      runtime.hasLiveWrites = true;
      const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
      terminalRawRef.current[blockId] = appendBlockTermTerminalBytes(
        terminalRawRef.current[blockId] || new Uint8Array(),
        bytes,
        runtime.maxPtySize
      );
      void writeTerminalData(runtime, raw);
    }
  }, []);

  const promoteBlockToTerminal = useCallback(
    (sessionId: string, blockId: string) => {
      if (modeRef.current[blockId] === "terminal") return;
      modeRef.current[blockId] = "terminal";
      updateSessionBlock(sessionId, blockId, { mode: "terminal" });
      if (!independentBlockIdsRef.current.has(blockId)) persistBlockPatch(blockId, { mode: "terminal" });
      if (shouldFullscreenTerminalMode()) setFullscreenBlockId(blockId);
      const existingOutput = outputStore.getSnapshot(blockId).value || outputRef.current[blockId];
      if (existingOutput) writeTerminalOutput(blockId, existingOutput);
    },
    [outputStore, persistBlockPatch, updateSessionBlock, writeTerminalOutput]
  );

  const finishBlock = useCallback(
    (
      sessionId: string,
      blockId: string,
      exitCode: number,
      nextCwd?: string,
      replay = false,
      expectedToken?: string,
      detached = false
    ) => {
      const currentSession = sessionsRef.current.find((item) => item.id === sessionId);
      const currentBlock = currentSession?.blocks.find((block) => block.id === blockId);
      if (!currentSession || !currentBlock || currentBlock.terminalId !== sessionId) return;

      const previousStatus = blockStatusRef.current[blockId] ?? currentBlock.status;
      // Ordinary finalization is reserved for a live running owner. An
      // interrupted block must be reconciled through the status-preserving
      // path below; allowing it here would overwrite its null exit code.
      if (previousStatus !== "running") return;
      if (interruptedBlocksRef.current.has(blockId)) return;

      const binding = blockTokenRef.current[blockId];
      const phase = blockOutputPhaseRef.current[blockId];
      const restartLifecycle = blockRestartTransitionRef.current[blockId];
      // Once an in-place restart has been committed, the legacy completion
      // ring (which may omit a token) is no longer authoritative for this
      // block. Only the exact new lifecycle can finish it.
      if (
        restartLifecycle &&
        (expectedToken !== restartLifecycle.token ||
          !binding ||
          binding.sessionId !== sessionId ||
          binding.token !== restartLifecycle.token)
      )
        return;
      const completionFallback = replay && expectedToken === undefined;
      if (completionFallback) {
        // The completion ring has no token. It may finalize a running block
        // only while no different primary owner has taken over this session.
        const activeBlockId = sessionActiveBlockRef.current[sessionId];
        if (activeBlockId && activeBlockId !== blockId) return;
        if (
          binding &&
          (binding.sessionId !== sessionId || !phase || phase.sessionId !== sessionId || phase.phase !== "active")
        )
          return;
        if (!binding && phase && (phase.sessionId !== sessionId || phase.phase !== "active")) return;
      } else if (
        !binding ||
        binding.sessionId !== sessionId ||
        (expectedToken !== undefined && binding.token !== expectedToken) ||
        !phase ||
        phase.sessionId !== sessionId ||
        phase.phase !== "active" ||
        (!detached && sessionActiveBlockRef.current[sessionId] !== blockId)
      ) {
        return;
      }

      // All ownership and lifecycle checks must precede cancellation/cleanup.
      // A delayed end frame otherwise can consume a newer owner's tracker or
      // token after the same block id has been rebound.
      bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
      stopSequencesRef.current.get(blockId)?.cancel();
      stopSequencesRef.current.delete(blockId);
      cancelProcessIdentityTracker(sessionId, blockId);
      interruptedBlocksRef.current.delete(blockId);

      const finishedAt = Date.now();
      const status: BlockStatus = exitCode === 0 ? "success" : "error";
      const completedCommand = currentBlock.command;
      const afterStateJson = !replay
        ? serializeBlockTermShellState(currentSession, {
            cwd: nextCwd || currentSession.cwd,
            shellState: "ready",
            lastCommand: completedCommand || currentSession.lastCommand,
            lastCommandExitCode: exitCode,
          })
        : undefined;
      blockStatusRef.current[blockId] = status;
      delete blockTokenRef.current[blockId];
      delete blockOutputPhaseRef.current[blockId];
      if (restartLifecycle?.token === expectedToken) delete blockRestartTransitionRef.current[blockId];
      const isCurrentBlock = sessionActiveBlockRef.current[sessionId] === blockId;
      if (isCurrentBlock) sessionActiveBlockRef.current[sessionId] = null;
      if (interruptedOutputBlockRef.current[sessionId] === blockId) {
        interruptedOutputBlockRef.current[sessionId] = null;
      }
      setSessions((items) =>
        items.map((session) => {
          if (session.id !== sessionId) return session;
          const blocks = session.blocks.map((block) =>
            block.id === blockId
              ? {
                  ...block,
                  ...(nextCwd ? { cwd: nextCwd } : {}),
                  ...(!replay && afterStateJson ? { afterStateJson } : {}),
                  exitCode,
                  finishedAt,
                  status,
                }
              : block
          );
          return {
            ...session,
            ...(!replay && isCurrentBlock && session.status !== "exited" && session.status !== "closed"
              ? {
                  cwd: nextCwd || session.cwd,
                  status: "ready" as const,
                  activeBlockId: null,
                  shellState: "ready",
                  lastCommand: completedCommand || session.lastCommand,
                  lastCommandExitCode: exitCode,
                }
              : {}),
            blocks,
            selectedBlockId: resolveVisibleBlockSelection(
              getVisibleBlocks(session.blocks),
              getVisibleBlocks(blocks),
              session.selectedBlockId
            ),
          };
        })
      );
      persistBlockPatch(blockId, {
        status,
        exitCode,
        ...(nextCwd ? { cwd: nextCwd } : {}),
        ...(!replay && afterStateJson ? { afterStateJson } : {}),
        finishedAt,
      });
      outputStore.setPinned(blockId, "running", false);
      if (!outputStore.getSnapshot(blockId).dirty) {
        delete outputRef.current[blockId];
        delete terminalRawRef.current[blockId];
      }
      if (
        !replay &&
        isCurrentBlock &&
        currentSession &&
        currentSession.status !== "exited" &&
        currentSession.status !== "closed"
      ) {
        queueRuntimeInfoUpdate(sessionId, {
          current_cwd: nextCwd || currentSession.cwd,
          shell_state: "ready",
          shell_integration: currentSession.shellIntegration,
          last_command: completedCommand || currentSession.lastCommand,
          last_command_exit_code: exitCode,
        });
      }
      // A fast command can deliver its complete start/output/end sequence
      // before React mounts the block's terminal. In that case the live bytes
      // had no runtime to receive them, and the mount path intentionally skips
      // recovery while the block still appears active. The completion boundary
      // is the first point where a full raw snapshot is safe to fetch.
      requestTerminalRawSyncRef.current(blockId);
    },
    [cancelProcessIdentityTracker, getVisibleBlocks, outputStore, persistBlockPatch, queueRuntimeInfoUpdate]
  );

  const reconcileInterruptedBlockCompletion = useCallback(
    (sessionId: string, blockId: string, nextCwd?: string, outputEndCursor?: number, expectedToken?: string) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const block = session?.blocks.find((item) => item.id === blockId);
      if (!session || !block || block.terminalId !== sessionId) return;
      if ((blockStatusRef.current[blockId] ?? block.status) !== "interrupted") return;

      const binding = blockTokenRef.current[blockId];
      const phase = blockOutputPhaseRef.current[blockId];
      const isFencedFrame = expectedToken !== undefined;
      const restartLifecycle = blockRestartTransitionRef.current[blockId];
      if (restartLifecycle) {
        if (
          expectedToken !== restartLifecycle.token ||
          !binding ||
          binding.sessionId !== sessionId ||
          binding.token !== restartLifecycle.token
        )
          return;
      }
      if (isFencedFrame) {
        // A replay/live end can clean a retained tail only when it still owns
        // the exact token and active phase that accepted that frame.
        if (
          !binding ||
          binding.sessionId !== sessionId ||
          binding.token !== expectedToken ||
          !phase ||
          phase.sessionId !== sessionId ||
          phase.phase !== "active" ||
          interruptedOutputBlockRef.current[sessionId] !== blockId
        ) {
          return;
        }
        bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
        stopSequencesRef.current.get(blockId)?.cancel();
        stopSequencesRef.current.delete(blockId);
        cancelProcessIdentityTracker(sessionId, blockId);
        interruptedBlocksRef.current.delete(blockId);
        delete blockTokenRef.current[blockId];
        delete blockOutputPhaseRef.current[blockId];
        if (restartLifecycle?.token === expectedToken) delete blockRestartTransitionRef.current[blockId];
        if (sessionActiveBlockRef.current[sessionId] === blockId) {
          sessionActiveBlockRef.current[sessionId] = null;
        }
        if (interruptedOutputBlockRef.current[sessionId] === blockId) {
          interruptedOutputBlockRef.current[sessionId] = null;
        }
      }

      if (nextCwd) {
        updateSessionBlock(sessionId, blockId, { cwd: nextCwd });
        persistBlockPatch(blockId, { cwd: nextCwd });
      }
      if (isFencedFrame) {
        outputStore.setPinned(blockId, "running", false);
        if (!outputStore.getSnapshot(blockId).dirty) {
          delete outputRef.current[blockId];
          delete terminalRawRef.current[blockId];
        }
      }
      // Completion-ring reconciliation intentionally does not consume a live
      // owner because the ring has no lifecycle token. The subsequent end
      // frame/state boundary will perform the fenced cleanup.
      queueTerminalRawTarget(blockId, outputEndCursor);
    },
    [cancelProcessIdentityTracker, outputStore, persistBlockPatch, queueTerminalRawTarget, updateSessionBlock]
  );

  const reconcileCorrelatedBlockCompletion = useCallback(
    (
      sessionId: string,
      completion: { blockId: string; blockToken?: string; exitCode: number; cwd: string; endCursor: number }
    ) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return;
      const effectiveBlocks = session.blocks.map((block) => ({
        ...block,
        status: blockStatusRef.current[block.id] ?? block.status,
      }));
      const ownedBlock = effectiveBlocks.find(
        (item) => item.id === completion.blockId && item.terminalId === sessionId
      );
      if (!ownedBlock || (ownedBlock.status !== "running" && ownedBlock.status !== "interrupted")) return;
      const binding = blockTokenRef.current[completion.blockId];
      const restartLifecycle = blockRestartTransitionRef.current[completion.blockId];
      if (
        restartLifecycle &&
        (completion.blockToken !== restartLifecycle.token ||
          !binding ||
          binding.sessionId !== sessionId ||
          binding.token !== restartLifecycle.token)
      )
        return;
      if (
        binding?.sessionId === sessionId &&
        (completion.blockToken === undefined || completion.blockToken !== binding.token)
      )
        return;
      const previousCursor = blockCompletionCursorRef.current[completion.blockId] ?? 0;
      if (completion.endCursor <= previousCursor) return;
      // Only advance the watermark after ownership and status validation. A
      // stale/foreign completion must not poison a later lifecycle that reuses
      // the same durable block id.
      blockCompletionCursorRef.current[completion.blockId] = completion.endCursor;
      const interruptedPlan = resolveBlockTermCompletionReconcile({
        sessionId,
        completion,
        blocks: effectiveBlocks,
      });
      if (interruptedPlan) {
        reconcileInterruptedBlockCompletion(
          sessionId,
          interruptedPlan.blockId,
          interruptedPlan.cwd,
          interruptedPlan.outputEndCursor,
          completion.blockToken
        );
        return;
      }

      if (ownedBlock.status === "running") {
        finishBlock(sessionId, completion.blockId, completion.exitCode, completion.cwd, true, completion.blockToken);
      }
      // A replayed end may already have finalized the block. The watermark is
      // still needed so a mounted or future terminal view performs one barrier
      // GET for the recorder bytes that preceded that completion.
      queueTerminalRawTarget(completion.blockId, completion.endCursor);
    },
    [finishBlock, queueTerminalRawTarget, reconcileInterruptedBlockCompletion]
  );

  const applyRoutedBlockState = useCallback(
    (sessionId: string, route: BlockTermTerminalRoute, message: Record<string, unknown>) => {
      if (route.mode !== "block" || !route.blockId || !route.blockToken) return;
      const blockId = route.blockId;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const block = session?.blocks.find((item) => item.id === blockId);
      if (!session || !block || block.terminalId !== sessionId) return;
      const binding = blockTokenRef.current[blockId];
      if (binding && (binding.sessionId !== sessionId || binding.token !== route.blockToken)) return;
      const rawStatus = message.status;
      const status = rawStatus === "running" ? "running" : rawStatus === "streaming" ? "streaming" : rawStatus;
      const rawBlockStatus = message.block_status;
      const durableStatus =
        rawBlockStatus === "success" ||
        rawBlockStatus === "error" ||
        rawBlockStatus === "interrupted" ||
        rawBlockStatus === "running"
          ? rawBlockStatus
          : undefined;
      const cwd = typeof message.current_cwd === "string" && message.current_cwd ? message.current_cwd : undefined;
      if (cwd) {
        updateSessionBlock(sessionId, blockId, { cwd });
        if (!independentBlockIdsRef.current.has(blockId)) persistBlockPatch(blockId, { cwd });
      }

      // Child runtimes are finalized transactionally by the server. Their
      // websocket state is only a completion hint; fetch the durable row before
      // clearing the token/output projection so a late state cannot overwrite a
      // newer lifecycle or publish a guessed exit code.
      const independent = independentBlockIdsRef.current.has(blockId) || blockRuntimesRef.current.has(blockId);
      if (
        independent &&
        (durableStatus === "success" ||
          durableStatus === "error" ||
          durableStatus === "interrupted" ||
          status === "exited" ||
          status === "closed")
      ) {
        blockTokenRef.current[blockId] = { sessionId, token: route.blockToken };
        if (durableStatus === "running" || message.durable_error) {
          blockStatusRef.current[blockId] = "running";
          outputStore.setPinned(blockId, "running", true);
        }
        void reconcileBlockRuntimeRef.current(sessionId, blockId, route.blockToken, scopeGenerationRef.current);
        return;
      }
      if (status === "running" || status === "streaming") {
        blockTokenRef.current[blockId] = { sessionId, token: route.blockToken };
        if (independent) {
          rememberBlockTermRuntimeBinding({ terminalId: sessionId, blockId, blockToken: route.blockToken });
        }
        blockStatusRef.current[blockId] = status;
        outputStore.setPinned(blockId, "running", true);
        blockOutputPhaseRef.current[blockId] = { sessionId, phase: "active" };
        return;
      }
      if (status !== "exited" && status !== "closed") return;
      if ((blockStatusRef.current[blockId] ?? block.status) !== "running") return;
      blockTokenRef.current[blockId] = { sessionId, token: route.blockToken };
      const exitCode = Number.isSafeInteger(message.exit_code) ? Number(message.exit_code) : 0;
      blockOutputPhaseRef.current[blockId] = { sessionId, phase: "active" };
      finishBlock(sessionId, blockId, exitCode, cwd, false, route.blockToken, true);
    },
    [finishBlock, outputStore, persistBlockPatch, updateSessionBlock]
  );

  const startStopSequence = useCallback(
    (sessionId: string, blockId: string, scopeGeneration: number, signals?: readonly BlockTermSignal[]): boolean => {
      stopSequencesRef.current.get(blockId)?.cancel();
      stopSequencesRef.current.delete(blockId);
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const block = session?.blocks.find((item) => item.id === blockId);
      const binding = blockTokenRef.current[blockId];
      const independent = independentBlockIdsRef.current.has(blockId) || blockRuntimesRef.current.has(blockId);
      const stop = startBlockTermStop({
        blockId,
        signals: signals ?? resolveBlockTermStopSignals(block?.runtimeType ?? session?.runtimeType),
        isRunning: (candidateId) => {
          if (independent) {
            const blockRuntime = blockRuntimesRef.current.get(blockId);
            return (
              candidateId === blockId &&
              binding?.sessionId === sessionId &&
              !!blockRuntime &&
              blockRuntime.sessionId === sessionId &&
              blockRuntime.blockToken === binding.token &&
              blockRuntime.scopeGeneration === scopeGeneration &&
              blockStatusRef.current[blockId] === "running" &&
              interruptedBlocksRef.current.has(blockId)
            );
          }
          const runtime = runtimesRef.current.get(sessionId);
          const currentSession = sessionsRef.current.find((item) => item.id === sessionId);
          return (
            candidateId === blockId &&
            runtime?.scopeGeneration === scopeGeneration &&
            currentSession?.status !== "exited" &&
            currentSession?.status !== "closed" &&
            sessionActiveBlockRef.current[sessionId] === blockId &&
            interruptedOutputBlockRef.current[sessionId] === blockId
          );
        },
        send: (candidateId, signal) => {
          if (candidateId !== blockId) return false;
          return sendTerminalSignal(sessionId, blockId, signal);
        },
        onComplete: () => {
          stopSequencesRef.current.delete(blockId);
        },
      });
      if (!stop.sent) return false;
      if (stop.sequence) stopSequencesRef.current.set(blockId, stop.sequence);
      return true;
    },
    [sendTerminalSignal]
  );

  const routeTerminalText = useCallback(
    (
      sessionId: string,
      rawText: Uint8Array,
      text: string,
      replay = false,
      hasTuiSequence = false,
      streamRoute?: BlockTermTerminalRoute
    ) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const routedBlockId = streamRoute?.mode === "block" ? streamRoute.blockId : null;
      if (!routedBlockId && (session?.status === "exited" || session?.status === "closed")) return;
      if (streamRoute?.mode === "block" && streamRoute.terminalId !== sessionId) return;
      const currentActiveBlockId = sessionActiveBlockRef.current[sessionId];
      const transitionPrimaryBinding = runtimesRef.current.get(sessionId)?.transitionPrimaryBinding;
      const activeBlockId =
        routedBlockId ||
        resolveBlockTermOutputOwner({
          sessionId,
          activeBlockId: currentActiveBlockId,
          interruptedBlockId: interruptedOutputBlockRef.current[sessionId],
          transitionBlockId: transitionPrimaryBinding?.blockId,
          activeBlockPhase: currentActiveBlockId ? blockOutputPhaseRef.current[currentActiveBlockId] : undefined,
          interruptedBlockPhase: interruptedOutputBlockRef.current[sessionId]
            ? blockOutputPhaseRef.current[interruptedOutputBlockRef.current[sessionId] as string]
            : undefined,
          transitionBlockPhase: transitionPrimaryBinding
            ? { sessionId, phase: transitionPrimaryBinding.blockPhase }
            : undefined,
        });
      if (!activeBlockId) return;
      const routedBlock =
        streamRoute?.mode === "block" ? session?.blocks.find((item) => item.id === activeBlockId) : null;
      if (streamRoute?.mode === "block" && !routedBlock) return;
      if (streamRoute?.mode === "block") {
        const binding = blockTokenRef.current[activeBlockId];
        if (binding && (binding.sessionId !== sessionId || binding.token !== streamRoute.blockToken)) return;
        if (!binding && streamRoute.blockToken) {
          blockTokenRef.current[activeBlockId] = { sessionId, token: streamRoute.blockToken };
        }
      }
      const blockStatus = blockStatusRef.current[activeBlockId];
      if (
        streamRoute?.mode !== "block" &&
        replay &&
        blockStatus &&
        blockStatus !== "running" &&
        interruptedOutputBlockRef.current[sessionId] !== activeBlockId
      )
        return;
      const block = session?.blocks.find((item) => item.id === activeBlockId);
      if (hasTuiSequence) promoteBlockToTerminal(sessionId, activeBlockId);
      const seenBytes = terminalRawRef.current[activeBlockId] || new Uint8Array();
      const terminalBytes = replay ? missingReplayByteSuffix(seenBytes, rawText) : rawText;
      if (modeRef.current[activeBlockId] === "terminal") {
        appendTerminalOutput(sessionId, activeBlockId, text, replay);
        // Raw terminal delivery must not depend on the lossy UTF-8
        // projection. Invalid bytes and split UTF-8 are still valid PTY data.
        if (terminalBytes.length > 0) writeTerminalOutput(activeBlockId, terminalBytes);
        return;
      }
      if (shouldUseBlockTermTerminalRenderer(block?.renderer) && terminalBytes.length > 0) {
        writeTerminalOutput(activeBlockId, terminalBytes);
      }
      appendBlockOutput(sessionId, activeBlockId, text, replay);
    },
    [appendBlockOutput, appendTerminalOutput, promoteBlockToTerminal, writeTerminalOutput]
  );

  const handleTerminalData = useCallback(
    (
      sessionId: string,
      raw: Uint8Array,
      replay = false,
      streamRoute?: BlockTermTerminalRoute,
      streamParser?: BlockTermStreamParser
    ) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime && (streamRoute?.mode !== "block" || !streamParser)) return;
      const parser: BlockTermStreamParser | undefined =
        streamParser ??
        (streamRoute?.mode === "block"
          ? (() => {
              const existing = runtime?.streamParsers.get(streamRoute.streamKey);
              if (existing) return existing;
              const created = createBlockTermStreamParser();
              runtime?.streamParsers.set(streamRoute.streamKey, created);
              return created;
            })()
          : runtime);
      if (!parser) return;
      const parsed = extractSegmentsFromBytes(concatBlockTermBytes(parser.parseBuffer, raw));
      parser.parseBuffer = parsed.rest;
      if (streamRoute?.mode !== "block" && runtime) runtime.parseBuffer = parser.parseBuffer;
      for (const segment of parsed.segments) {
        if (segment.type === "text") {
          const rawText = segment.value;
          routeTerminalText(
            sessionId,
            rawText,
            decodeTerminalProjection(parser, rawText),
            replay,
            segment.hasTuiSequence,
            streamRoute
          );
          continue;
        }

        // A streaming decoder must not carry an incomplete UTF-8 sequence
        // across an OSC frame boundary. Flush the pending projection before
        // applying the frame so bytes after it belong to a fresh scope.
        const boundaryProjection = flushTerminalProjectionDecoder(parser);
        if (boundaryProjection)
          routeTerminalText(sessionId, new Uint8Array(), boundaryProjection, replay, false, streamRoute);

        if (streamRoute?.mode === "block") {
          const frame = segment.frame;
          const blockId = streamRoute.blockId as string;
          const blockToken = streamRoute.blockToken as string;
          if (frame.id !== blockId || (frame.protocolVersion === "v3" && frame.blockToken !== blockToken)) {
            // A marker from another lifecycle must never mutate this routed
            // block. Preserve it as ordinary output so malformed user output
            // is not silently lost.
            routeTerminalText(
              sessionId,
              segment.raw,
              decodeTerminalProjection(parser, segment.raw),
              replay,
              false,
              streamRoute
            );
            continue;
          }
          if (frame.kind === "start") {
            blockTokenRef.current[blockId] = { sessionId, token: blockToken };
            blockOutputPhaseRef.current[blockId] = { sessionId, phase: "active" };
            if (!modeRef.current[blockId]) {
              const session = sessionsRef.current.find((item) => item.id === sessionId);
              const command = frame.command || session?.blocks.find((item) => item.id === blockId)?.command || "";
              const mode = shouldUseTerminalMode(command) ? "terminal" : "text";
              modeRef.current[blockId] = mode;
              blockStatusRef.current[blockId] = "running";
              outputStore.prime(blockId, 0, null);
              outputStore.setPinned(blockId, "running", true);
            }
            if (frame.cwd) updateSessionBlock(sessionId, blockId, { cwd: frame.cwd });
            continue;
          }
          if (frame.kind === "end") {
            if (independentBlockIdsRef.current.has(blockId) || blockRuntimesRef.current.has(blockId)) {
              // The child finalizer owns durable status/output. The marker only
              // tells us that a reconcile should happen; do not PATCH a guessed
              // exit code from the client.
              void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, scopeGenerationRef.current);
            } else {
              finishBlock(sessionId, blockId, frame.exitCode ?? 1, frame.cwd, replay, blockToken, true);
              reconcileInterruptedBlockCompletion(sessionId, blockId, frame.cwd, undefined, blockToken);
              void Promise.resolve().then(() => closeBlockRuntimeRef.current(sessionId, blockId, blockToken));
            }
            continue;
          }
          continue;
        }

        if (!runtime) continue;

        const { frame } = segment;
        if (deletedBlockIdsRef.current.has(frame.id)) continue;
        const session = sessionsRef.current.find((item) => item.id === sessionId);
        const activeBlockId = sessionActiveBlockRef.current[sessionId];
        const interruptedBlockId = interruptedOutputBlockRef.current[sessionId];
        const pendingPrimaryBinding = runtime.pendingPrimaryBinding;
        const transitionPrimaryBinding = runtime.transitionPrimaryBinding;
        const transitionBlockId = transitionPrimaryBinding?.blockId || null;
        const binding = blockTokenRef.current[frame.id];
        const boundToSession = binding?.sessionId === sessionId;
        const frameDisposition = resolveBlockTermFrameDisposition({
          frame,
          replay,
          sessionId,
          activeBlockId,
          interruptedBlockId,
          activeBlockPhase: activeBlockId ? blockOutputPhaseRef.current[activeBlockId] : undefined,
          interruptedBlockPhase: interruptedBlockId ? blockOutputPhaseRef.current[interruptedBlockId] : undefined,
          pendingBlockId: pendingPrimaryBinding?.blockId,
          pendingBlockToken: pendingPrimaryBinding?.blockToken,
          pendingBlockPhase: pendingPrimaryBinding?.blockPhase
            ? {
                sessionId,
                phase: pendingPrimaryBinding.blockPhase,
              }
            : undefined,
          transitionBlockId,
          transitionBlockToken: transitionPrimaryBinding?.blockToken,
          transitionBlockPhase: transitionPrimaryBinding
            ? { sessionId, phase: transitionPrimaryBinding.blockPhase }
            : undefined,
          blocks:
            session?.blocks.map((block) => ({
              ...block,
              status: blockStatusRef.current[block.id] ?? block.status,
            })) || [],
          blockToken: boundToSession ? binding.token : undefined,
        });
        if (!frameDisposition.accepted) {
          if (shouldRouteRejectedBlockTermFrame(replay)) {
            routeTerminalText(sessionId, segment.raw, decodeTerminalProjection(parser, segment.raw), replay);
          }
          continue;
        }
        if (
          frameDisposition.action === "activate-pending-running" ||
          frameDisposition.action === "complete-pending-running"
        ) {
          // Commit the new primary exactly at its correlated frame boundary.
          // Until this point the previous active owner remains visible to the
          // router and can consume an earlier end frame.
          sessionActiveBlockRef.current[sessionId] = frame.id;
          runtime.pendingPrimaryBinding = null;
        }
        if (frameDisposition.action === "activate-interrupted") {
          interruptedOutputBlockRef.current[sessionId] = frame.id;
          blockOutputPhaseRef.current[frame.id] = { sessionId, phase: "active" };
          continue;
        }
        if (frameDisposition.action === "reconcile-interrupted") {
          reconcileInterruptedBlockCompletion(sessionId, frame.id, frame.cwd, undefined, frame.blockToken);
          continue;
        }
        if (frameDisposition.action === "complete-running") {
          finishBlock(sessionId, frame.id, frame.exitCode ?? 1, frame.cwd, replay, frame.blockToken);
          continue;
        }
        if (frameDisposition.action === "complete-pending-running") {
          finishBlock(sessionId, frame.id, frame.exitCode ?? 1, frame.cwd, replay, frame.blockToken);
          continue;
        }
        if (frameDisposition.action === "complete-transition-running") {
          finishBlock(sessionId, frame.id, frame.exitCode ?? 1, frame.cwd, replay, frame.blockToken, true);
          if (blockStatusRef.current[frame.id] !== "running") {
            clearBlockTermTransitionTimer(runtime);
            runtime.transitionPrimaryBinding = null;
          }
          continue;
        }

        // A matched start is the exact ownership boundary for both replay and
        // live delivery. Bytes before it belong to the retained tail; bytes
        // after it belong to the newly active command.
        const retainedTailId = interruptedOutputBlockRef.current[sessionId];
        if (retainedTailId && retainedTailId !== frame.id) {
          const retainedTailBinding = blockTokenRef.current[retainedTailId];
          releaseInterruptedOutputBlock(
            sessionId,
            retainedTailId,
            true,
            retainedTailBinding?.sessionId === sessionId ? retainedTailBinding.token : undefined
          );
        }
        blockOutputPhaseRef.current[frame.id] = { sessionId, phase: "active" };
        const knownStatus =
          blockStatusRef.current[frame.id] ?? session?.blocks.find((block) => block.id === frame.id)?.status;
        if (!knownStatus || knownStatus === "running") {
          sessionActiveBlockRef.current[sessionId] = frame.id;
        }
        if (!modeRef.current[frame.id]) {
          const command = frame.command || "";
          const mode = shouldUseTerminalMode(command) ? "terminal" : "text";
          modeRef.current[frame.id] = mode;
          blockStatusRef.current[frame.id] = "running";
          outputRef.current[frame.id] = outputRef.current[frame.id] || "";
          outputStore.prime(frame.id, 0, null);
          outputStore.setPinned(frame.id, "running", true);
          setSessions((items) =>
            items.map((session) => {
              if (session.id !== sessionId || session.blocks.some((block) => block.id === frame.id)) return session;
              return {
                ...session,
                ...(!replay ? { cwd: frame.cwd || session.cwd, status: "running" as const } : {}),
                blocks: [
                  ...session.blocks,
                  createBlockState({
                    id: frame.id,
                    command,
                    status: "running",
                    mode,
                    cwd: frame.cwd || session.cwd,
                    runtimeType: session.runtimeType,
                    ...(session.runtimeType === "ssh" && session.sshProfileId
                      ? { sshProfileId: session.sshProfileId }
                      : {}),
                    ...(session.runtimeType === "ssh" && frame.shellPid ? { remotePid: frame.shellPid } : {}),
                    termCols: session.cols || DEFAULT_COLS,
                    termRows: session.rows || DEFAULT_ROWS,
                    termFlexRows: mode === "text",
                    termMaxPtySize: BLOCKTERM_OUTPUT_MAX_BYTES,
                    beforeStateJson: serializeBlockTermShellState(session),
                  }),
                ],
              };
            })
          );
          void createBlockRecord({
            id: frame.id,
            terminalId: sessionId,
            lineNum: nextLineNumRef.current[sessionId] || 0,
            command,
            cwd: frame.cwd,
            status: "running",
            mode,
            output: "",
            runtimeType: session?.runtimeType,
            ...(session?.runtimeType === "ssh" && session.sshProfileId ? { sshProfileId: session.sshProfileId } : {}),
            ...(session?.runtimeType === "ssh" && frame.shellPid ? { remotePid: frame.shellPid } : {}),
            termCols: session?.cols || DEFAULT_COLS,
            termRows: session?.rows || DEFAULT_ROWS,
            termFlexRows: mode === "text",
            termMaxPtySize: BLOCKTERM_OUTPUT_MAX_BYTES,
            beforeStateJson: session ? serializeBlockTermShellState(session) : undefined,
            startedAt: Date.now(),
          })
            .then(() => {
              historyLoadRequestRef.current[sessionId] = (historyLoadRequestRef.current[sessionId] || 0) + 1;
              setSessions((items) =>
                items.map((item) =>
                  item.id === sessionId ? { ...item, history: appendRecentCommand(item.history, command) } : item
                )
              );
            })
            .catch((error) => {
              if (replay && isBlockTermTombstoneError(error)) {
                discardReplayBlock(sessionId, frame.id);
              }
            });
          nextLineNumRef.current[sessionId] = (nextLineNumRef.current[sessionId] || 0) + 1;
        }
        if (frame.shellPid && session?.runtimeType === "ssh") {
          const pidPatch = { remotePid: frame.shellPid };
          updateSessionBlock(sessionId, frame.id, pidPatch);
          persistBlockPatch(frame.id, pidPatch);
        }
        if (!replay && session?.runtimeType === "local") {
          startProcessIdentityTracker(sessionId, frame.id, runtime.scopeGeneration);
        }
        if (!replay) {
          const command = frame.command || session?.blocks.find((block) => block.id === frame.id)?.command || "";
          setSessionPatch(sessionId, {
            ...(frame.cwd ? { cwd: frame.cwd } : {}),
            shellState: "running-command",
            shellIntegration: true,
            ...(command ? { lastCommand: command } : {}),
          });
          queueRuntimeInfoUpdate(sessionId, {
            current_cwd: frame.cwd,
            shell_state: "running-command",
            shell_integration: true,
            last_command: command || undefined,
          });
        }
        if (!replay && frame.cwd && (!knownStatus || knownStatus === "running")) {
          setSessionPatch(sessionId, { cwd: frame.cwd, status: "running" });
        }
      }
    },
    [
      createBlockRecord,
      discardReplayBlock,
      finishBlock,
      flushTerminalProjectionDecoder,
      outputStore,
      queueRuntimeInfoUpdate,
      reconcileInterruptedBlockCompletion,
      releaseInterruptedOutputBlock,
      routeTerminalText,
      setSessionPatch,
      startProcessIdentityTracker,
      updateSessionBlock,
    ]
  );

  const resetBlockTermRoutedProjection = useCallback(
    (blockId: string) => {
      outputRef.current[blockId] = "";
      terminalRawRef.current[blockId] = new Uint8Array();
      outputStore.hydrate(blockId, "", null);
      const terminalRuntime = xtermRefs.current.get(blockId);
      if (!terminalRuntime || terminalRuntime.disposed) return;
      if (terminalRuntime.rawSyncTimer !== null) clearTimeout(terminalRuntime.rawSyncTimer);
      terminalRuntime.rawSyncTimer = null;
      terminalRuntime.rawSyncPending = false;
      terminalRuntime.rawSyncController?.abort();
      terminalRuntime.rawSyncController = null;
      terminalRuntime.rawSyncInFlight = null;
      resetRawSyncState(terminalRuntime);
      terminalRuntime.hasLiveWrites = false;
      try {
        terminalRuntime.terminal.reset();
      } catch {
        // xterm may already be disposed during a scope transition.
      }
    },
    [outputStore]
  );

  const acknowledgeBlockTermMessage = useCallback(
    (sessionId: string, route: BlockTermTerminalRoute, cursor: number | null): boolean => {
      if (cursor === null) return false;
      const ws =
        route.mode === "block" && route.blockId
          ? blockRuntimesRef.current.get(route.blockId)?.ws
          : runtimesRef.current.get(sessionId)?.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        const message: Record<string, unknown> = { type: "ack", cursor };
        if (route.mode === "block") {
          message.route_mode = "block";
          message.block_id = route.blockId;
          message.block_token = route.blockToken;
        }
        ws.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const applyTerminalChunk = useCallback(
    (
      sessionId: string,
      data: Uint8Array,
      replay: boolean,
      reset: boolean,
      streamRoute?: BlockTermTerminalRoute,
      streamParser?: BlockTermStreamParser
    ) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime && (streamRoute?.mode !== "block" || !streamParser)) return;
      if (reset) {
        // A reset snapshot starts at a fresh byte boundary. Any partial
        // sequence from the old cursor cannot be combined with it safely.
        if (streamRoute?.mode === "block") {
          if (streamParser) {
            streamParser.decoder = new TextDecoder("utf-8", { fatal: false });
            streamParser.parseBuffer = new Uint8Array();
          } else {
            runtime?.streamParsers.delete(streamRoute.streamKey);
          }
          resetBlockTermRoutedProjection(streamRoute.blockId as string);
        } else if (runtime) {
          runtime.decoder = new TextDecoder("utf-8", { fatal: false });
          runtime.parseBuffer = new Uint8Array();
        }
      }
      handleTerminalData(sessionId, data, replay, streamRoute, streamParser);
    },
    [handleTerminalData, resetBlockTermRoutedProjection]
  );

  const flushPendingTerminalChunks = useCallback(
    (sessionId: string, streamRoute?: BlockTermTerminalRoute): boolean => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) return false;
      const pending = drainBlockTermPendingChunkQueue(runtime.pendingTerminalChunks);
      if (pending.overflowed) return false;
      for (const chunk of pending.chunks) {
        applyTerminalChunk(sessionId, chunk.data, chunk.replay, chunk.reset, streamRoute);
      }
      return true;
    },
    [applyTerminalChunk]
  );

  const flushTerminalParser = useCallback(
    (sessionId: string) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) return;
      const tail = takeTerminalParserTail(runtime);
      if (tail.projection) routeTerminalText(sessionId, new Uint8Array(), tail.projection, false);
      if (tail.raw.length > 0) {
        // Parser bytes were withheld from the streaming decoder. On teardown
        // they become ordinary output, including an unterminated OSC marker.
        const text = new TextDecoder("utf-8", { fatal: false }).decode(tail.raw);
        routeTerminalText(sessionId, tail.raw, text, false);
      }
    },
    [routeTerminalText]
  );

  const flushBlockRuntimeParser = useCallback(
    (runtime: BlockTermRuntimeConnection) => {
      const tail = takeTerminalParserTail(runtime.parser);
      if (tail.projection) {
        routeTerminalText(runtime.sessionId, new Uint8Array(), tail.projection, false, false, runtime.route);
      }
      if (tail.raw.length > 0) {
        routeTerminalText(
          runtime.sessionId,
          tail.raw,
          new TextDecoder("utf-8", { fatal: false }).decode(tail.raw),
          false,
          false,
          runtime.route
        );
      }
    },
    [routeTerminalText]
  );

  const detachBlockRuntime = useCallback(
    (runtime: BlockTermRuntimeConnection, remove = true) => {
      runtime.allowReconnect = false;
      if (runtime.reconnectTimer !== null) clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
      flushBlockRuntimeParser(runtime);
      if (runtime.ws) {
        runtime.ws.onclose = null;
        runtime.ws.close();
        runtime.ws = null;
      }
      if (remove && blockRuntimesRef.current.get(runtime.blockId) === runtime) {
        blockRuntimesRef.current.delete(runtime.blockId);
      }
      syncMountedBlockRuntime(runtime.blockId);
    },
    [flushBlockRuntimeParser, syncMountedBlockRuntime]
  );

  const closeBlockRuntime = useCallback(
    async (sessionId: string, blockId: string, blockToken: string, requestClose = true): Promise<void> => {
      const runtime = blockRuntimesRef.current.get(blockId);
      const exactRuntime =
        runtime && runtime.sessionId === sessionId && runtime.blockToken === blockToken ? runtime : null;
      if (!requestClose) {
        if (exactRuntime) detachBlockRuntime(exactRuntime, false);
        return;
      }
      try {
        await blockTermApi.closeRuntime(sessionId, blockId, blockToken);
      } catch (error) {
        if (getRequestErrorStatus(error) !== 404) throw error;
      }
      if (exactRuntime) detachBlockRuntime(exactRuntime);
      forgetBlockTermRuntimeBinding(sessionId, blockId, blockToken);
    },
    [detachBlockRuntime]
  );
  closeBlockRuntimeRef.current = closeBlockRuntime;

  const closeIndependentBlockRuntimes = useCallback(
    async (sessionId: string, blockIds?: ReadonlySet<string>): Promise<void> => {
      const bindings = new Map<string, BlockTermRuntimeBinding>();
      for (const binding of loadBlockTermRuntimeBindings()) {
        if (binding.terminalId === sessionId && (!blockIds || blockIds.has(binding.blockId))) {
          bindings.set(binding.blockId, binding);
        }
      }
      for (const [blockId, runtime] of blockRuntimesRef.current) {
        if (runtime.sessionId === sessionId && (!blockIds || blockIds.has(blockId))) {
          bindings.set(blockId, { terminalId: sessionId, blockId, blockToken: runtime.blockToken });
        }
      }
      for (const [blockId, binding] of Object.entries(blockTokenRef.current)) {
        if (
          binding.sessionId === sessionId &&
          independentBlockIdsRef.current.has(blockId) &&
          (!blockIds || blockIds.has(blockId))
        ) {
          bindings.set(blockId, { terminalId: sessionId, blockId, blockToken: binding.token });
        }
      }

      await Promise.all(
        [...bindings.values()].map(async (binding) => {
          await closeBlockRuntimeRef.current(sessionId, binding.blockId, binding.blockToken);
          stopSequencesRef.current.get(binding.blockId)?.cancel();
          stopSequencesRef.current.delete(binding.blockId);
          interruptedBlocksRef.current.delete(binding.blockId);
          independentBlockIdsRef.current.delete(binding.blockId);
          const currentBinding = blockTokenRef.current[binding.blockId];
          if (currentBinding?.sessionId === sessionId && currentBinding.token === binding.blockToken) {
            delete blockTokenRef.current[binding.blockId];
            delete blockOutputPhaseRef.current[binding.blockId];
            delete blockRestartTransitionRef.current[binding.blockId];
          }
        })
      );
    },
    []
  );
  const reconcileBlockRuntime = useCallback(
    async (sessionId: string, blockId: string, blockToken: string, expectedGeneration?: number): Promise<boolean> => {
      const scopeGeneration = expectedGeneration ?? scopeGenerationRef.current;
      const isCurrent = (): boolean => {
        const binding = blockTokenRef.current[blockId];
        return (
          scopeGenerationRef.current === scopeGeneration &&
          independentBlockIdsRef.current.has(blockId) &&
          binding?.sessionId === sessionId &&
          binding.token === blockToken &&
          !deletedBlockIdsRef.current.has(blockId)
        );
      };

      // Stop reconnects before asking the durable store for the final row. The
      // websocket may already have been removed by the server finalizer.
      const runtime = blockRuntimesRef.current.get(blockId);
      if (runtime && runtime.sessionId === sessionId && runtime.blockToken === blockToken) {
        runtime.allowReconnect = false;
        if (runtime.reconnectTimer !== null) clearTimeout(runtime.reconnectTimer);
        runtime.reconnectTimer = null;
      }
      await closeBlockRuntimeRef.current(sessionId, blockId, blockToken, false).catch(() => {});

      let durableBlock: BlockTermBlock | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!isCurrent()) return false;
        try {
          const listed = await blockTermApi.list(sessionId, { includeOutput: false });
          durableBlock = listed.blocks.find((candidate) => candidate.id === blockId);
        } catch {
          durableBlock = undefined;
        }
        if (durableBlock && !isActiveBlockStatus(durableBlock.status)) break;
        if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
      if (!isCurrent() || !durableBlock || isActiveBlockStatus(durableBlock.status)) {
        const current = blockRuntimesRef.current.get(blockId);
        if (current && current.sessionId === sessionId && current.blockToken === blockToken && isCurrent()) {
          current.allowReconnect = true;
          if (current.reconnectTimer === null) {
            const timer = setTimeout(() => {
              const latest = blockRuntimesRef.current.get(blockId);
              if (latest !== current || latest.reconnectTimer !== timer || !latest.allowReconnect) return;
              latest.reconnectTimer = null;
              connectBlockRuntimeRef.current(sessionId, blockId, blockToken, scopeGeneration);
            }, 1200);
            current.reconnectTimer = timer;
          }
        }
        return false;
      }

      // A completed independent child is the authoritative source for the
      // working directory of the same future connection. Keep this cursor in
      // memory only; the durable View stores runtime/profile/cwd, while an
      // older completion response must never move the selection backwards.
      const completedAt = durableBlock.finishedAt ?? 0;
      const sessionForCwd = sessionsRef.current.find((item) => item.id === sessionId);
      if (sessionForCwd && durableBlock.cwd && completedAt > (nextConnectionCwdWatermarkRef.current[sessionId] || 0)) {
        const futureConnection = resolveSessionConnectionContext(sessionForCwd);
        const completedConnection: BlockTermConnectionContext = {
          runtimeType: durableBlock.runtimeType,
          ...(durableBlock.runtimeType === "ssh" && durableBlock.sshProfileId
            ? { sshProfileId: durableBlock.sshProfileId }
            : {}),
        };
        if (isSameBlockTermConnectionIdentity(futureConnection, completedConnection)) {
          await setNextConnectionContext(sessionId, {
            ...completedConnection,
            cwd: durableBlock.cwd,
          });
          nextConnectionCwdWatermarkRef.current[sessionId] = completedAt;
        }
      }

      let output: { value: string; cursor: number | null } = outputStore.getSnapshot(blockId);
      try {
        output = await blockTermApi.getOutput(blockId);
      } catch {
        // Metadata is still authoritative when output retrieval races a server
        // transaction. The next mount/load can retry the output GET.
      }
      if (!isCurrent()) return false;

      stopSequencesRef.current.get(blockId)?.cancel();
      stopSequencesRef.current.delete(blockId);
      cancelProcessIdentityTracker(sessionId, blockId);
      interruptedBlocksRef.current.delete(blockId);
      delete blockTokenRef.current[blockId];
      delete blockOutputPhaseRef.current[blockId];
      delete blockRestartTransitionRef.current[blockId];
      independentBlockIdsRef.current.delete(blockId);
      forgetBlockTermRuntimeBinding(sessionId, blockId, blockToken);
      const settledRuntime = blockRuntimesRef.current.get(blockId);
      if (settledRuntime && settledRuntime.sessionId === sessionId && settledRuntime.blockToken === blockToken) {
        detachBlockRuntime(settledRuntime);
      }
      blockStatusRef.current[blockId] = durableBlock.status;
      modeRef.current[blockId] = durableBlock.mode;
      outputRef.current[blockId] = output.value;
      terminalRawRef.current[blockId] = new Uint8Array();
      outputStore.hydrate(blockId, output.value, output.cursor ?? durableBlock.outputCursor);
      outputStore.setPinned(blockId, "running", false);
      const timer = persistTimersRef.current.get(blockId);
      if (timer) clearTimeout(timer);
      persistTimersRef.current.delete(blockId);
      persistPatchRef.current.delete(blockId);
      persistOutputRef.current.delete(blockId);
      updateSessionBlock(sessionId, blockId, durableBlock);
      queueTerminalRawTarget(blockId, output.cursor ?? durableBlock.outputCursor);
      syncMountedBlockRuntime(blockId);
      return true;
    },
    [
      cancelProcessIdentityTracker,
      detachBlockRuntime,
      outputStore,
      queueTerminalRawTarget,
      resolveSessionConnectionContext,
      setNextConnectionContext,
      syncMountedBlockRuntime,
      updateSessionBlock,
    ]
  );
  reconcileBlockRuntimeRef.current = reconcileBlockRuntime;

  const connectBlockRuntime = useCallback(
    (sessionId: string, blockId: string, blockToken: string, expectedGeneration?: number): boolean => {
      const scopeGeneration = expectedGeneration ?? scopeGenerationRef.current;
      if (scopeGeneration !== scopeGenerationRef.current) return false;
      const binding = blockTokenRef.current[blockId];
      const block = sessionsRef.current
        .find((session) => session.id === sessionId)
        ?.blocks.find((candidate) => candidate.id === blockId);
      if (
        binding?.sessionId !== sessionId ||
        binding.token !== blockToken ||
        !block ||
        block.terminalId !== sessionId ||
        (blockStatusRef.current[blockId] ?? block.status) !== "running"
      )
        return false;

      const route = createBlockTermTerminalRoute(sessionId, "block", blockId, blockToken);
      let runtime: BlockTermRuntimeConnection | undefined = blockRuntimesRef.current.get(blockId);
      if (
        runtime &&
        (runtime.sessionId !== sessionId ||
          runtime.blockToken !== blockToken ||
          runtime.route.streamKey !== route.streamKey)
      ) {
        runtime.allowReconnect = false;
        if (runtime.reconnectTimer !== null) clearTimeout(runtime.reconnectTimer);
        runtime.ws?.close();
        blockRuntimesRef.current.delete(blockId);
        runtime = undefined;
      }
      if (!runtime) {
        const createdRuntime: BlockTermRuntimeConnection = {
          sessionId,
          blockId,
          blockToken,
          route,
          ws: null,
          cursor: 0,
          parser: createBlockTermStreamParser(),
          allowReconnect: true,
          scopeGeneration,
          connectionToken: 0,
          reconnectTimer: null,
          messageChain: Promise.resolve(),
          hasOpened: false,
        };
        blockRuntimesRef.current.set(blockId, createdRuntime);
        runtime = createdRuntime;
      }
      const attachedRuntime = runtime;

      attachedRuntime.scopeGeneration = scopeGeneration;
      attachedRuntime.allowReconnect = true;
      attachedRuntime.connectionToken += 1;
      const connectionToken = attachedRuntime.connectionToken;
      if (attachedRuntime.reconnectTimer !== null) clearTimeout(attachedRuntime.reconnectTimer);
      attachedRuntime.reconnectTimer = null;
      if (attachedRuntime.ws) {
        attachedRuntime.ws.onclose = null;
        attachedRuntime.ws.close();
      }

      const ws = new WebSocket(blockTermApi.runtimeWsUrl(sessionId, blockId, blockToken, attachedRuntime.cursor));
      attachedRuntime.ws = ws;
      ws.onopen = () => {
        const current = blockRuntimesRef.current.get(blockId);
        if (
          !current ||
          current !== attachedRuntime ||
          current.scopeGeneration !== scopeGeneration ||
          current.connectionToken !== connectionToken ||
          current.ws !== ws
        )
          return;
        current.hasOpened = true;
        const currentBlock = sessionsRef.current
          .find((session) => session.id === sessionId)
          ?.blocks.find((candidate) => candidate.id === blockId);
        resizeBlockRuntime(
          sessionId,
          blockId,
          currentBlock?.termCols || DEFAULT_COLS,
          currentBlock?.termRows || DEFAULT_ROWS
        );
        syncMountedBlockRuntime(blockId);
      };
      ws.onmessage = (event) => {
        attachedRuntime.messageChain = enqueueBlockTermMessageTask(attachedRuntime.messageChain, async () => {
          const current = blockRuntimesRef.current.get(blockId);
          if (
            !current ||
            current !== attachedRuntime ||
            current.scopeGeneration !== scopeGeneration ||
            current.connectionToken !== connectionToken ||
            current.ws !== ws
          )
            return;
          try {
            const msg = JSON.parse(event.data) as Record<string, unknown>;
            const parsed = parseBlockTermTerminalMessage(sessionId, msg, { defaultMode: "block" });
            if (!parsed.ok || parsed.message.route.streamKey !== current.route.streamKey) return;
            const routedMessage = parsed.message;

            if (msg.type === "replay" || msg.type === "output") {
              const cursorState = current.cursor > 0 ? { [current.route.streamKey]: current.cursor } : {};
              const cursorUpdate = reduceBlockTermStreamCursor(
                cursorState,
                current.route,
                routedMessage.cursor,
                routedMessage.reset
              );
              if (!cursorUpdate.accepted) return;
              if (routedMessage.cursor !== null) current.cursor = routedMessage.cursor;
              const data = typeof msg.data === "string" ? decodeBase64Bytes(msg.data) : new Uint8Array();
              applyTerminalChunk(
                sessionId,
                data,
                msg.type === "replay",
                routedMessage.reset,
                current.route,
                current.parser
              );
              acknowledgeBlockTermMessage(sessionId, current.route, routedMessage.cursor);
              return;
            }
            if (msg.type === "state") {
              const running = msg.status === "running" || msg.status === "streaming";
              if (!running) {
                current.allowReconnect = false;
                flushBlockRuntimeParser(current);
                void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, scopeGeneration);
                return;
              }
              applyRoutedBlockState(sessionId, current.route, msg);
              syncMountedBlockRuntime(blockId);
              return;
            }
            if (msg.type === "input_rejected") {
              const session = sessionsRef.current.find((item) => item.id === sessionId);
              const activeBinding = blockTokenRef.current[blockId];
              if (independentBlockIdsRef.current.has(blockId)) {
                if (msg.reason === "runtime_signal_failed") {
                  stopSequencesRef.current.get(blockId)?.cancel();
                  stopSequencesRef.current.delete(blockId);
                  interruptedBlocksRef.current.delete(blockId);
                  syncMountedBlockRuntime(blockId);
                } else {
                  current.allowReconnect = false;
                  await reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, scopeGeneration);
                }
                return;
              }
              if (
                session &&
                shouldRestoreBlockTermSignalFailure({
                  sessionId,
                  blockId,
                  blockToken: msg.block_token,
                  reason: msg.reason,
                  activeBlockId: sessionActiveBlockRef.current[sessionId],
                  activeBlockToken: activeBinding?.sessionId === sessionId ? activeBinding.token : undefined,
                  activeBlockStatus: blockStatusRef.current[blockId],
                  interruptedOutputBlockId: interruptedOutputBlockRef.current[sessionId],
                  stopPending: interruptedBlocksRef.current.has(blockId),
                  blocks: session.blocks,
                })
              ) {
                restoreBlockTermSignalFailureRef.current(sessionId, blockId, blockToken);
                return;
              }
              if (
                session &&
                shouldHandleBlockTermInputRejected({
                  sessionId,
                  blockId,
                  blockToken: msg.block_token,
                  reason: msg.reason,
                  activeBlockId: sessionActiveBlockRef.current[sessionId],
                  activeBlockToken: activeBinding?.sessionId === sessionId ? activeBinding.token : undefined,
                  activeBlockStatus: blockStatusRef.current[blockId],
                  blocks: session.blocks,
                })
              ) {
                current.allowReconnect = false;
                await markCreatedBlockInterruptedRef.current(sessionId, blockId, blockToken);
              }
              return;
            }
            if (msg.type === "pty_exited") {
              current.allowReconnect = false;
              if (routedMessage.cursor !== null) current.cursor = Math.max(current.cursor, routedMessage.cursor);
              flushBlockRuntimeParser(current);
              acknowledgeBlockTermMessage(sessionId, current.route, routedMessage.cursor);
              await reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, scopeGeneration);
            }
          } catch {
            // Invalid or stale block messages are ignored without changing route ownership.
          }
        });
      };
      ws.onclose = () => {
        const current = blockRuntimesRef.current.get(blockId);
        if (
          !current ||
          current !== attachedRuntime ||
          current.scopeGeneration !== scopeGeneration ||
          current.connectionToken !== connectionToken ||
          current.ws !== ws
        )
          return;
        current.ws = null;
        syncMountedBlockRuntime(blockId);
        if (!current.hasOpened) {
          current.allowReconnect = false;
          void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, scopeGeneration);
          return;
        }
        const currentBlock = sessionsRef.current
          .find((session) => session.id === sessionId)
          ?.blocks.find((candidate) => candidate.id === blockId);
        if (!current.allowReconnect || (blockStatusRef.current[blockId] ?? currentBlock?.status) !== "running") {
          blockRuntimesRef.current.delete(blockId);
          return;
        }
        // A short-lived child can close after the websocket opened but before
        // its final state task reaches this callback. Reconcile the durable row
        // first; it reconnects only when the exact lifecycle is still running.
        void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, scopeGeneration);
      };
      ws.onerror = () => {
        const current = blockRuntimesRef.current.get(blockId);
        if (current === attachedRuntime && current.ws === ws) ws.close();
      };
      return true;
    },
    [
      acknowledgeBlockTermMessage,
      applyRoutedBlockState,
      applyTerminalChunk,
      flushBlockRuntimeParser,
      resizeBlockRuntime,
      syncMountedBlockRuntime,
    ]
  );
  connectBlockRuntimeRef.current = connectBlockRuntime;

  const connectSession = useCallback(
    (sessionId: string, expectedGeneration?: number) => {
      const scopeGeneration = expectedGeneration ?? scopeGenerationRef.current;
      if (scopeGeneration !== scopeGenerationRef.current) return;
      let runtime = runtimesRef.current.get(sessionId);
      if (runtime && runtime.scopeGeneration !== scopeGeneration) {
        runtime.allowReconnect = false;
        clearBlockTermTransitionTimer(runtime);
        runtime.transitionPrimaryBinding = null;
        if (runtime.ws) {
          runtime.ws.onclose = null;
          runtime.ws.close();
        }
        runtimesRef.current.delete(sessionId);
        runtime = undefined;
      }
      if (!runtime) {
        runtime = {
          decoder: new TextDecoder("utf-8", { fatal: false }),
          parseBuffer: new Uint8Array(),
          ws: null,
          cursor: 0,
          streamCursors: {},
          streamParsers: new Map(),
          echoConfigured: false,
          allowReconnect: true,
          scopeGeneration,
          connectionToken: 0,
          handshakeReady: false,
          pendingTerminalChunks: createBlockTermPendingChunkQueue(),
          pendingPrimaryBinding: null,
          transitionPrimaryBinding: null,
          transitionPrimaryTimer: undefined,
          handshakeStartCursor: 0,
          stateHandshakePending: false,
          initialStatePending: true,
        };
        runtimesRef.current.set(sessionId, runtime);
      }
      runtime.scopeGeneration = scopeGeneration;
      const resumeCursor = runtime.cursor;
      // Keep decoder/parser state across a cursor-resumed reconnect. The
      // previous PTY message may have ended in the middle of UTF-8 or OSC
      // 633; the next replay chunk completes that sequence.
      if (resumeCursor === 0) {
        runtime.decoder = new TextDecoder("utf-8", { fatal: false });
        runtime.parseBuffer = new Uint8Array();
      }
      runtime.allowReconnect = true;
      runtime.handshakeReady = false;
      runtime.pendingTerminalChunks = createBlockTermPendingChunkQueue();
      runtime.pendingPrimaryBinding = null;
      clearBlockTermTransitionTimer(runtime);
      runtime.transitionPrimaryBinding = null;
      runtime.handshakeStartCursor = resumeCursor;
      runtime.stateHandshakePending = false;
      runtime.initialStatePending = true;
      runtime.replayRefreshPromise = undefined;
      runtime.pendingPtyExited = false;
      runtime.endedStatus = undefined;
      runtime.connectionToken += 1;
      const connectionToken = runtime.connectionToken;
      setSessionPatch(sessionId, { status: "connecting" });

      const oldTimer = reconnectTimersRef.current.get(sessionId);
      if (oldTimer) clearTimeout(oldTimer);
      reconnectTimersRef.current.delete(sessionId);

      if (runtime.ws) {
        runtime.ws.onclose = null;
        runtime.ws.close();
      }

      const ws = new WebSocket(terminalApi.wsUrl(sessionId, resumeCursor));
      runtime.ws = ws;
      ws.onopen = () => {
        const current = runtimesRef.current.get(sessionId);
        if (
          !current ||
          current.scopeGeneration !== scopeGeneration ||
          current.connectionToken !== connectionToken ||
          current.ws !== ws
        )
          return;
        resizeSession(sessionId);
      };
      let messageChain = Promise.resolve();
      ws.onmessage = (event) => {
        messageChain = enqueueBlockTermMessageTask(messageChain, async () => {
          const attached = runtimesRef.current.get(sessionId);
          if (!isBlockTermConnectionContinuationCurrent(attached, scopeGeneration, connectionToken)) return;
          try {
            const msg = JSON.parse(event.data);
            const parsedMessage = parseBlockTermPageMessage(sessionId, msg);
            if (!parsedMessage.ok) return;
            const routedMessage = parsedMessage.message;
            const messageRoute = routedMessage.route;
            const currentRuntime = runtimesRef.current.get(sessionId);
            if (!currentRuntime) return;
            if (
              messageRoute.mode === "legacy" &&
              routedMessage.cursor !== null &&
              msg.type !== "replay" &&
              msg.type !== "output"
            ) {
              const cursorUpdate = reduceBlockTermStreamCursor(
                currentRuntime.streamCursors,
                messageRoute,
                routedMessage.cursor,
                routedMessage.reset
              );
              currentRuntime.streamCursors = cursorUpdate.state;
              if (cursorUpdate.accepted) currentRuntime.cursor = routedMessage.cursor;
            }

            // Independent block runtimes share this websocket but have no
            // session-level OSC ownership. Apply their bytes directly to the
            // addressed block and maintain a separate cursor/parser watermark.
            if (messageRoute.mode === "block") {
              if (msg.type === "replay" || msg.type === "output") {
                const cursorUpdate = reduceBlockTermStreamCursor(
                  currentRuntime.streamCursors,
                  messageRoute,
                  routedMessage.cursor,
                  routedMessage.reset
                );
                currentRuntime.streamCursors = cursorUpdate.state;
                if (!cursorUpdate.accepted) return;
                const data = typeof msg.data === "string" ? decodeBase64Bytes(msg.data) : new Uint8Array();
                applyTerminalChunk(sessionId, data, msg.type === "replay", msg.reset === true, messageRoute);
                acknowledgeBlockTermMessage(sessionId, messageRoute, routedMessage.cursor);
                return;
              }
              if (msg.type === "state") {
                applyRoutedBlockState(sessionId, messageRoute, msg);
                return;
              }
              if (msg.type === "replay_done") return;
              if (msg.type === "pty_exited") {
                applyRoutedBlockState(sessionId, messageRoute, { ...msg, status: "exited" });
                acknowledgeBlockTermMessage(sessionId, messageRoute, routedMessage.cursor);
                return;
              }
              // A routed NACK is handled by the common lifecycle path below;
              // all other block control messages are intentionally ignored.
            }
            if ((msg.type === "replay" || msg.type === "output") && routedMessage.cursor !== null) {
              const cursorUpdate = reduceBlockTermStreamCursor(
                currentRuntime.streamCursors,
                messageRoute,
                routedMessage.cursor,
                routedMessage.reset
              );
              currentRuntime.streamCursors = cursorUpdate.state;
              if (!cursorUpdate.accepted) return;
            }
            if (msg.type === "input_rejected") {
              const session = sessionsRef.current.find((item) => item.id === sessionId);
              const blockId = msg.block_id;
              const binding = typeof blockId === "string" ? blockTokenRef.current[blockId] : undefined;
              if (
                session &&
                shouldRestoreBlockTermSignalFailure({
                  sessionId,
                  blockId,
                  blockToken: msg.block_token,
                  reason: msg.reason,
                  activeBlockId: sessionActiveBlockRef.current[sessionId],
                  activeBlockToken: binding?.sessionId === sessionId ? binding.token : undefined,
                  activeBlockStatus: typeof blockId === "string" ? blockStatusRef.current[blockId] : undefined,
                  interruptedOutputBlockId: interruptedOutputBlockRef.current[sessionId],
                  stopPending: typeof blockId === "string" && interruptedBlocksRef.current.has(blockId),
                  blocks: session.blocks,
                })
              ) {
                restoreBlockTermSignalFailureRef.current(
                  sessionId,
                  blockId,
                  binding?.sessionId === sessionId ? binding.token : undefined
                );
                return;
              }
              if (
                session &&
                shouldHandleBlockTermInputRejected({
                  sessionId,
                  blockId,
                  blockToken: msg.block_token,
                  reason: msg.reason,
                  activeBlockId: sessionActiveBlockRef.current[sessionId],
                  activeBlockToken: binding?.sessionId === sessionId ? binding.token : undefined,
                  activeBlockStatus: typeof blockId === "string" ? blockStatusRef.current[blockId] : undefined,
                  blocks: session.blocks,
                })
              ) {
                void markCreatedBlockInterruptedRef.current(
                  sessionId,
                  blockId,
                  binding?.sessionId === sessionId ? binding.token : undefined
                );
              }
              return;
            }
            if (msg.type === "replay_done") {
              const current = runtimesRef.current.get(sessionId);
              if (current) {
                current.endedStatus = undefined;
                // The server's automatic state follows replay_done immediately.
                // Reconcile the durable block inventory first, then request a
                // fresh state snapshot that can be evaluated against that list.
                current.stateHandshakePending = false;
                current.initialStatePending = true;
              }
              const refreshPromise = Promise.all([loadPersistedBlocks(sessionId), loadCommandHistory(sessionId)]).then(
                ([outcome]) => {
                  const latest = runtimesRef.current.get(sessionId);
                  if (!isBlockTermConnectionContinuationCurrent(latest, scopeGeneration, connectionToken))
                    return outcome;
                  if (!getLoadedBlockTermInventory(outcome)) return outcome;
                  if (latest.replayRefreshPromise === refreshPromise) latest.replayRefreshPromise = undefined;
                  if (ws.readyState !== WebSocket.OPEN) return outcome;
                  startActiveProcessIdentityTracker(sessionId, scopeGeneration);
                  latest.stateHandshakePending = true;
                  try {
                    ws.send(JSON.stringify({ type: "state" }));
                  } catch {
                    latest.stateHandshakePending = false;
                  }
                  return outcome;
                }
              );
              if (current) current.replayRefreshPromise = refreshPromise;
              void refreshPromise.catch(() => {
                const latest = runtimesRef.current.get(sessionId);
                if (latest?.replayRefreshPromise === refreshPromise) latest.replayRefreshPromise = undefined;
              });
              return;
            }
            if (msg.type === "state") {
              const automaticState = runtime.initialStatePending;
              if (automaticState) runtime.initialStatePending = false;
              const refreshPromise = automaticState ? runtime.replayRefreshPromise : undefined;
              let refreshedBlocks: readonly BlockTermRestoredOwnerBlock[] | undefined;
              if (refreshPromise) {
                const outcome = await refreshPromise;
                const latest = runtimesRef.current.get(sessionId);
                if (!isBlockTermConnectionContinuationCurrent(latest, scopeGeneration, connectionToken)) return;
                const loadedBlocks = getLoadedBlockTermInventory(outcome);
                if (!loadedBlocks) return;
                refreshedBlocks = loadedBlocks;
              } else if (automaticState && persistedBlocksLoadedGenerationRef.current[sessionId] !== scopeGeneration) {
                return;
              }
              if (automaticState) {
                const latest = runtimesRef.current.get(sessionId);
                if (!isBlockTermConnectionContinuationCurrent(latest, scopeGeneration, connectionToken)) return;
                // An open connection requested a fresher state after the block
                // refresh. Ignore the automatic pre-refresh snapshot in that case.
                if (latest.stateHandshakePending) return;
              } else if (!runtime.stateHandshakePending) {
                return;
              }
              const session = sessionsRef.current.find((item) => item.id === sessionId);
              const handshakeBlocks = refreshedBlocks || session?.blocks || [];
              const effectiveHandshakeBlocks = handshakeBlocks.map((block) => ({
                ...block,
                status: blockStatusRef.current[block.id] ?? block.status,
              }));
              const completions = resolveBlockTermCorrelatedCompletions({
                sessionId,
                completions: msg.block_completions,
                blocks: effectiveHandshakeBlocks,
              });
              const stateBindings = resolveBlockTermStateBindings({
                sessionId,
                terminalStatus: msg.status,
                serverBlockId: msg.block_id,
                serverBlockToken: msg.block_token,
                serverBlockPhase: msg.block_phase,
                serverTailBlockId: msg.block_tail_id,
                serverTailBlockToken: msg.block_tail_token,
                serverTailBlockPhase: msg.block_tail_phase,
                blocks: effectiveHandshakeBlocks,
                localPrimaryBinding:
                  sessionActiveBlockRef.current[sessionId] &&
                  blockTokenRef.current[sessionActiveBlockRef.current[sessionId] as string]?.sessionId === sessionId
                    ? {
                        blockId: sessionActiveBlockRef.current[sessionId] as string,
                        blockToken: blockTokenRef.current[sessionActiveBlockRef.current[sessionId] as string].token,
                      }
                    : null,
                localTailBinding:
                  interruptedOutputBlockRef.current[sessionId] &&
                  blockTokenRef.current[interruptedOutputBlockRef.current[sessionId] as string]?.sessionId === sessionId
                    ? {
                        blockId: interruptedOutputBlockRef.current[sessionId] as string,
                        blockToken: blockTokenRef.current[interruptedOutputBlockRef.current[sessionId] as string].token,
                      }
                    : null,
              });
              const bindStateOwner = (
                blockId: string,
                blockToken: string,
                blockPhase: "expected" | "active"
              ): boolean => {
                const existingBinding = blockTokenRef.current[blockId];
                const existingStatus = effectiveStatusById.get(blockId);
                if (
                  existingBinding?.sessionId === sessionId &&
                  existingBinding.token !== blockToken &&
                  (existingStatus === "running" || existingStatus === "interrupted")
                ) {
                  // A delayed state response must not replace a newer local
                  // lifecycle that reused the same durable block id.
                  return false;
                }
                blockTokenRef.current[blockId] = { sessionId, token: blockToken };
                const awaitsBufferedStart =
                  blockPhase === "active" &&
                  hasBlockTermPendingStartFrame({
                    chunks: runtime.pendingTerminalChunks.chunks,
                    blockId,
                    blockToken,
                    parserPrefix: runtime.parseBuffer,
                  });
                blockOutputPhaseRef.current[blockId] = {
                  sessionId,
                  phase: awaitsBufferedStart ? "expected" : blockPhase,
                };
                return true;
              };
              const effectiveStatusById = new Map(
                effectiveHandshakeBlocks.map((block) => [block.id, block.status] as const)
              );
              const previousActiveBlockId = sessionActiveBlockRef.current[sessionId] || null;
              const previousTailBlockId = interruptedOutputBlockRef.current[sessionId] || null;
              const previousActiveBinding = previousActiveBlockId
                ? blockTokenRef.current[previousActiveBlockId]
                : undefined;
              const previousTailBinding = previousTailBlockId ? blockTokenRef.current[previousTailBlockId] : undefined;
              let interruptedBindingBlockId: string | null = null;
              let interruptedBindingToken: string | undefined;
              let deferredInterruptedBlock: { blockId: string; token?: string; fence: number } | null = null;
              let primaryBinding = stateBindings.primary;
              // If the server's snapshot carries an older token for the same
              // local owner, retain the local lifecycle. The snapshot may have
              // been queued before a newer command was armed on this socket.
              if (
                !primaryBinding &&
                previousActiveBlockId &&
                previousActiveBinding?.sessionId === sessionId &&
                effectiveStatusById.get(previousActiveBlockId) === "running" &&
                msg.block_id === previousActiveBlockId &&
                typeof msg.block_token === "string" &&
                msg.block_token !== previousActiveBinding.token
              ) {
                primaryBinding = {
                  blockId: previousActiveBlockId,
                  blockToken: previousActiveBinding.token,
                  blockPhase: blockOutputPhaseRef.current[previousActiveBlockId]?.phase || "expected",
                };
              }
              if (!primaryBinding && previousActiveBlockId && effectiveHandshakeBlocks.length > 0) {
                const activeBlockStatus = effectiveStatusById.get(previousActiveBlockId);
                const currentBinding = blockTokenRef.current[previousActiveBlockId];
                const bindingResolution = resolveBlockTermStateBinding({
                  sessionId,
                  activeBlockId: previousActiveBlockId,
                  activeBlockStatus,
                  blocks: effectiveHandshakeBlocks,
                  localBlockToken: currentBinding?.sessionId === sessionId ? currentBinding.token : undefined,
                  serverBlockId: msg.block_id,
                  serverBlockToken: msg.block_token,
                });
                if (bindingResolution.action === "bind") {
                  primaryBinding = {
                    blockId: previousActiveBlockId,
                    blockToken: bindingResolution.blockToken,
                    blockPhase: msg.block_phase === "active" ? "active" : "expected",
                  };
                } else if (bindingResolution.action === "interrupt") {
                  interruptedBindingBlockId = previousActiveBlockId;
                  interruptedBindingToken = currentBinding?.sessionId === sessionId ? currentBinding.token : undefined;
                }
              }
              if (primaryBinding) {
                // Bind the token before publishing the owner ref. A newer
                // local lifecycle can make the server snapshot stale between
                // taking the snapshot and this reconciliation; in that case
                // bindStateOwner returns false and the local owner must remain
                // untouched.
                const primaryBound = bindStateOwner(
                  primaryBinding.blockId,
                  primaryBinding.blockToken,
                  primaryBinding.blockPhase
                );
                if (primaryBound) {
                  const retainsPreviousActiveOwner = Boolean(
                    previousActiveBlockId &&
                      previousActiveBlockId !== primaryBinding.blockId &&
                      effectiveStatusById.get(previousActiveBlockId) === "running" &&
                      previousActiveBinding?.sessionId === sessionId &&
                      typeof previousActiveBinding.token === "string" &&
                      previousActiveBinding.token.length > 0
                  );
                  if (retainsPreviousActiveOwner && previousActiveBlockId) {
                    interruptedBindingBlockId = previousActiveBlockId;
                    interruptedBindingToken =
                      previousActiveBinding?.sessionId === sessionId ? previousActiveBinding.token : undefined;
                  }
                  if (interruptedBindingBlockId) {
                    deferredInterruptedBlock = {
                      blockId: interruptedBindingBlockId,
                      token: interruptedBindingToken,
                      fence: getBlockTermLifecycleFence(blockLifecycleFenceRef, interruptedBindingBlockId),
                    };
                  }
                  if (retainsPreviousActiveOwner) {
                    const primaryPhase = blockOutputPhaseRef.current[primaryBinding.blockId]?.phase;
                    // Keep the old active owner published until the FIFO
                    // reaches the new primary's exact start boundary. This
                    // lets an old end frame before that boundary finalize its
                    // own lifecycle instead of being rejected as stale.
                    runtime.pendingPrimaryBinding =
                      primaryPhase === "expected" ? { ...primaryBinding, blockPhase: primaryPhase } : null;
                    runtime.transitionPrimaryBinding =
                      previousActiveBinding?.sessionId === sessionId && previousActiveBinding.token
                        ? {
                            blockId: previousActiveBlockId as string,
                            blockToken: previousActiveBinding.token,
                            blockPhase: blockOutputPhaseRef.current[previousActiveBlockId as string]?.phase || "active",
                          }
                        : null;
                    if (primaryPhase === "active") {
                      sessionActiveBlockRef.current[sessionId] = primaryBinding.blockId;
                    }
                  } else {
                    runtime.pendingPrimaryBinding = null;
                    runtime.transitionPrimaryBinding = null;
                    sessionActiveBlockRef.current[sessionId] = primaryBinding.blockId;
                  }
                } else {
                  runtime.pendingPrimaryBinding = null;
                  runtime.transitionPrimaryBinding = null;
                  const retainedPrimary = sessionActiveBlockRef.current[sessionId];
                  const retainedBinding = retainedPrimary ? blockTokenRef.current[retainedPrimary] : undefined;
                  if (
                    !retainedPrimary ||
                    effectiveStatusById.get(retainedPrimary) !== "running" ||
                    retainedBinding?.sessionId !== sessionId
                  ) {
                    sessionActiveBlockRef.current[sessionId] = null;
                  }
                }
              } else {
                runtime.pendingPrimaryBinding = null;
                runtime.transitionPrimaryBinding = null;
                if (
                  previousActiveBlockId &&
                  effectiveStatusById.get(previousActiveBlockId) === "running" &&
                  shouldInterruptBlockTermStateBinding({
                    blockId: previousActiveBlockId,
                    blockStatus: effectiveStatusById.get(previousActiveBlockId),
                    activeBlockId: previousActiveBlockId,
                  })
                ) {
                  // Keep the local running owner through FIFO replay. A
                  // buffered v3 end must still be able to finalize it as a
                  // normal completion; only mark it interrupted if no such
                  // frame was consumed.
                  deferredInterruptedBlock = {
                    blockId: previousActiveBlockId,
                    token: previousActiveBinding?.sessionId === sessionId ? previousActiveBinding.token : undefined,
                    fence: getBlockTermLifecycleFence(blockLifecycleFenceRef, previousActiveBlockId),
                  };
                }
              }

              let tailBinding = stateBindings.tail;
              if (
                !tailBinding &&
                previousTailBlockId &&
                previousTailBinding?.sessionId === sessionId &&
                effectiveStatusById.get(previousTailBlockId) === "interrupted" &&
                msg.block_tail_id === previousTailBlockId &&
                typeof msg.block_tail_token === "string" &&
                msg.block_tail_token !== previousTailBinding.token
              ) {
                tailBinding = {
                  blockId: previousTailBlockId,
                  blockToken: previousTailBinding.token,
                  blockPhase: blockOutputPhaseRef.current[previousTailBlockId]?.phase || "active",
                };
              }
              // Completion-ring entries do not carry a lifecycle token. Keep
              // them as a post-flush fallback only; installing one as a tail
              // owner here would reject a real replay end frame when no local
              // token exists and leave the tail permanently retained.
              const nextTailBlockId = tailBinding?.blockId || null;
              // Keep a retained tail alive until buffered replay has had a
              // chance to deliver its real end frame. Completion/state data is
              // not a substitute for that token-fenced frame boundary.
              const deferredTailRelease =
                previousTailBlockId && previousTailBlockId !== nextTailBlockId
                  ? {
                      blockId: previousTailBlockId,
                      token: previousTailBinding?.sessionId === sessionId ? previousTailBinding.token : undefined,
                    }
                  : null;
              let releasedTailBlockId: string | null = null;
              if (tailBinding) {
                const tailBound = bindStateOwner(tailBinding.blockId, tailBinding.blockToken, tailBinding.blockPhase);
                if (tailBound) {
                  interruptedOutputBlockRef.current[sessionId] = tailBinding.blockId;
                } else {
                  const retainedTail = interruptedOutputBlockRef.current[sessionId];
                  const retainedBinding = retainedTail ? blockTokenRef.current[retainedTail] : undefined;
                  if (
                    !retainedTail ||
                    effectiveStatusById.get(retainedTail) !== "interrupted" ||
                    retainedBinding?.sessionId !== sessionId
                  ) {
                    interruptedOutputBlockRef.current[sessionId] = null;
                  }
                }
              } else {
                // The previous tail remains the temporary replay owner when
                // the snapshot no longer reports one. It is released below
                // only after FIFO replay has been applied.
                if (!deferredTailRelease) interruptedOutputBlockRef.current[sessionId] = null;
              }
              runtime.stateHandshakePending = false;
              if (!flushPendingTerminalChunks(sessionId)) {
                // Reconnect from the cursor that preceded this handshake. No
                // buffered bytes were parsed, so replaying that range is safe.
                runtime.handshakeReady = false;
                runtime.pendingPrimaryBinding = null;
                clearBlockTermTransitionTimer(runtime);
                runtime.transitionPrimaryBinding = null;
                runtime.cursor = runtime.handshakeStartCursor;
                runtime.allowReconnect = true;
                try {
                  ws.close();
                } catch {}
                return;
              }
              if (runtime.pendingPrimaryBinding) {
                const pendingPrimary = runtime.pendingPrimaryBinding;
                const pendingStatus =
                  blockStatusRef.current[pendingPrimary.blockId] ??
                  sessionsRef.current
                    .find((item) => item.id === sessionId)
                    ?.blocks.find((item) => item.id === pendingPrimary.blockId)?.status;
                const pendingBinding = blockTokenRef.current[pendingPrimary.blockId];
                if (
                  pendingStatus === "running" &&
                  pendingBinding?.sessionId === sessionId &&
                  pendingBinding.token === pendingPrimary.blockToken
                ) {
                  // No matching boundary was present in the buffered range.
                  // Publish the server owner after the FIFO is exhausted; an
                  // expected phase will still wait for a future live start.
                  sessionActiveBlockRef.current[sessionId] = pendingPrimary.blockId;
                }
                runtime.pendingPrimaryBinding = null;
              }
              runtime.handshakeReady = true;
              // Replay may already contain the correlated end frame. Apply the
              // server completion ring afterwards only as a fallback, but
              // before state-induced interruption/release cleanup.
              for (const completion of completions) {
                reconcileCorrelatedBlockCompletion(sessionId, completion);
              }
              if (deferredInterruptedBlock) {
                const blockId = deferredInterruptedBlock.blockId;
                const currentStatus =
                  blockStatusRef.current[blockId] ??
                  sessionsRef.current.find((item) => item.id === sessionId)?.blocks.find((item) => item.id === blockId)
                    ?.status;
                const currentBinding = blockTokenRef.current[blockId];
                const canMarkInterrupted =
                  currentStatus === "running" &&
                  (deferredInterruptedBlock.token
                    ? currentBinding?.sessionId === sessionId && currentBinding.token === deferredInterruptedBlock.token
                    : sessionActiveBlockRef.current[sessionId] === blockId);
                const transitionBinding = runtime.transitionPrimaryBinding;
                const transitionMatches = Boolean(
                  transitionBinding &&
                    transitionBinding.blockId === blockId &&
                    (!deferredInterruptedBlock.token || transitionBinding.blockToken === deferredInterruptedBlock.token)
                );
                if (canMarkInterrupted && transitionMatches) {
                  // Keep the detached owner alive for a short bounded window.
                  // The old end frame may still be queued behind the state
                  // response; only reconcile it as interrupted when that frame
                  // never arrives.
                  clearBlockTermTransitionTimer(runtime);
                  runtime.transitionPrimaryTimer = setTimeout(() => {
                    runtime.transitionPrimaryTimer = undefined;
                    const latest = runtimesRef.current.get(sessionId);
                    if (
                      !latest ||
                      latest !== runtime ||
                      !isBlockTermConnectionContinuationCurrent(latest, scopeGeneration, connectionToken)
                    )
                      return;
                    const binding = latest.transitionPrimaryBinding;
                    const status =
                      blockStatusRef.current[blockId] ??
                      sessionsRef.current
                        .find((item) => item.id === sessionId)
                        ?.blocks.find((item) => item.id === blockId)?.status;
                    if (
                      !binding ||
                      binding.blockId !== blockId ||
                      (deferredInterruptedBlock.token && binding.blockToken !== deferredInterruptedBlock.token)
                    )
                      return;
                    if (status === "running") {
                      // Invoke before clearing the binding: the fenced helper
                      // uses this transition owner as its final local proof.
                      void markCreatedBlockInterruptedRef.current(
                        sessionId,
                        blockId,
                        deferredInterruptedBlock.token,
                        deferredInterruptedBlock.fence
                      );
                    }
                    latest.transitionPrimaryBinding = null;
                  }, BLOCKTERM_TRANSITION_RECONCILE_DELAY_MS);
                } else if (canMarkInterrupted) {
                  void markCreatedBlockInterruptedRef.current(
                    sessionId,
                    blockId,
                    deferredInterruptedBlock.token,
                    deferredInterruptedBlock.fence
                  );
                }
                if (sessionActiveBlockRef.current[sessionId] === blockId) {
                  sessionActiveBlockRef.current[sessionId] = null;
                }
                if (runtime.transitionPrimaryBinding?.blockId === blockId && !transitionMatches) {
                  clearBlockTermTransitionTimer(runtime);
                  runtime.transitionPrimaryBinding = null;
                }
              }
              if (
                runtime.transitionPrimaryBinding &&
                (blockStatusRef.current[runtime.transitionPrimaryBinding.blockId] ??
                  sessionsRef.current
                    .find((item) => item.id === sessionId)
                    ?.blocks.find((item) => item.id === runtime.transitionPrimaryBinding?.blockId)?.status) !==
                  "running"
              ) {
                clearBlockTermTransitionTimer(runtime);
                runtime.transitionPrimaryBinding = null;
              }
              if (deferredTailRelease) {
                releasedTailBlockId = releaseInterruptedOutputBlock(
                  sessionId,
                  deferredTailRelease.blockId,
                  false,
                  deferredTailRelease.token
                );
              }
              if (releasedTailBlockId) requestTerminalRawSyncRef.current(releasedTailBlockId);
              const pendingPtyExited = runtime.pendingPtyExited === true;
              runtime.pendingPtyExited = false;
              const reportedTerminalStatus =
                msg.status === "running" || msg.status === "exited" || msg.status === "closed" ? msg.status : undefined;
              const terminalStatus = pendingPtyExited
                ? reportedTerminalStatus === "closed"
                  ? "closed"
                  : "exited"
                : reportedTerminalStatus;
              updateTerminal(groupId, sessionId, {
                currentCwd: typeof msg.current_cwd === "string" ? msg.current_cwd : undefined,
                readonly: !!msg.readonly,
                status: terminalStatus,
              });
              setSessionPatch(sessionId, {
                ...(typeof msg.current_cwd === "string" && msg.current_cwd ? { cwd: msg.current_cwd } : {}),
                ...(Number.isSafeInteger(msg.cols) && msg.cols > 0 ? { cols: msg.cols } : {}),
                ...(Number.isSafeInteger(msg.rows) && msg.rows > 0 ? { rows: msg.rows } : {}),
                ...(typeof msg.shell_type === "string" && msg.shell_type ? { shellType: msg.shell_type } : {}),
                ...(typeof msg.shell_state === "string" && msg.shell_state ? { shellState: msg.shell_state } : {}),
                ...(typeof msg.shell_integration === "boolean" ? { shellIntegration: msg.shell_integration } : {}),
                ...(typeof msg.capabilities?.completion === "boolean"
                  ? { completion: msg.capabilities.completion }
                  : {}),
                ...(typeof msg.last_command === "string" && msg.last_command ? { lastCommand: msg.last_command } : {}),
                ...(typeof msg.last_command_exit_code === "number"
                  ? { lastCommandExitCode: msg.last_command_exit_code }
                  : {}),
                // Keep the React session projection in lockstep with the
                // synchronous owner ref used by the frame router.
                activeBlockId: sessionActiveBlockRef.current[sessionId] || null,
              });
              if (terminalStatus === "running") {
                const current = runtimesRef.current.get(sessionId);
                if (current) {
                  current.allowReconnect = true;
                  if (!current.echoConfigured && !sessionActiveBlockRef.current[sessionId]) {
                    current.echoConfigured = true;
                    try {
                      ws.send(JSON.stringify({ type: "input", data: encodeUtf8Base64("stty -echo\n") }));
                    } catch {
                      current.echoConfigured = false;
                    }
                  }
                }
                setSessionPatch(sessionId, {
                  status: sessionActiveBlockRef.current[sessionId] ? "running" : "ready",
                  activeBlockId: sessionActiveBlockRef.current[sessionId] || null,
                });
                startActiveProcessIdentityTracker(sessionId, scopeGeneration);
              } else if (terminalStatus === "exited" || terminalStatus === "closed") {
                const current = runtimesRef.current.get(sessionId);
                if (current) {
                  current.allowReconnect = false;
                  current.endedStatus = terminalStatus;
                }
                flushTerminalParser(sessionId);
                finalizeRunningBlocks(sessionId);
                const activeOutputBlockId = sessionActiveBlockRef.current[sessionId];
                if (activeOutputBlockId) delete blockOutputPhaseRef.current[activeOutputBlockId];
                const interruptedOutputBlockId = interruptedOutputBlockRef.current[sessionId];
                if (interruptedOutputBlockId) delete blockOutputPhaseRef.current[interruptedOutputBlockId];
                sessionActiveBlockRef.current[sessionId] = null;
                interruptedOutputBlockRef.current[sessionId] = null;
                setSessionPatch(sessionId, { status: terminalStatus, activeBlockId: null });
                setTerminalStatus(groupId, sessionId, terminalStatus);
                ws.close();
              }
              return;
            }
            if (msg.type === "replay") {
              const current = runtimesRef.current.get(sessionId);
              if (!current || (typeof msg.data !== "string" && !msg.reset)) return;
              const data = typeof msg.data === "string" ? decodeBase64Bytes(msg.data) : new Uint8Array();
              if (!current.handshakeReady) {
                if (
                  !enqueueBlockTermPendingChunk(current.pendingTerminalChunks, {
                    data,
                    replay: true,
                    reset: msg.reset === true,
                  })
                ) {
                  current.cursor = current.handshakeStartCursor;
                  current.allowReconnect = true;
                  try {
                    ws.close();
                  } catch {}
                }
                return;
              }
              applyTerminalChunk(sessionId, data, true, msg.reset === true);
              return;
            }
            if (msg.type === "output") {
              const current = runtimesRef.current.get(sessionId);
              if (!current || typeof msg.data !== "string") return;
              const data = decodeBase64Bytes(msg.data);
              if (!current.handshakeReady) {
                if (
                  !enqueueBlockTermPendingChunk(current.pendingTerminalChunks, {
                    data,
                    replay: false,
                    reset: false,
                  })
                ) {
                  current.cursor = current.handshakeStartCursor;
                  current.allowReconnect = true;
                  try {
                    ws.close();
                  } catch {}
                }
                return;
              }
              applyTerminalChunk(sessionId, data, false, false);
              return;
            }
            if (msg.type === "pty_exited") {
              const current = runtimesRef.current.get(sessionId);
              if (current && !current.handshakeReady) {
                current.pendingPtyExited = true;
                current.endedStatus = "exited";
                return;
              }
              const refreshPromise = current?.replayRefreshPromise;
              if (refreshPromise) {
                await refreshPromise;
                const latest = runtimesRef.current.get(sessionId);
                if (!isBlockTermConnectionContinuationCurrent(latest, scopeGeneration, connectionToken)) return;
                if (latest.stateHandshakePending) {
                  latest.pendingPtyExited = true;
                  latest.endedStatus = "exited";
                  return;
                }
              }
              if (current) current.allowReconnect = false;
              flushTerminalParser(sessionId);
              finalizeRunningBlocks(sessionId);
              const activeOutputBlockId = sessionActiveBlockRef.current[sessionId];
              if (activeOutputBlockId) delete blockOutputPhaseRef.current[activeOutputBlockId];
              const interruptedOutputBlockId = interruptedOutputBlockRef.current[sessionId];
              if (interruptedOutputBlockId) delete blockOutputPhaseRef.current[interruptedOutputBlockId];
              sessionActiveBlockRef.current[sessionId] = null;
              interruptedOutputBlockRef.current[sessionId] = null;
              const endedStatus = current?.endedStatus || "exited";
              setSessionPatch(sessionId, { status: endedStatus, activeBlockId: null });
              setTerminalStatus(groupId, sessionId, endedStatus);
              ws.close();
            }
          } catch {}
        });
      };
      ws.onclose = () => {
        const attached = runtimesRef.current.get(sessionId);
        if (
          !attached ||
          attached.scopeGeneration !== scopeGeneration ||
          attached.connectionToken !== connectionToken ||
          attached.ws !== ws
        )
          return;
        if (!attached.handshakeReady) {
          // None of the buffered transport bytes were parsed yet. Resume from
          // the cursor that preceded this handshake so a disconnect cannot
          // turn an acknowledged-but-unapplied replay into output loss.
          attached.cursor = attached.handshakeStartCursor;
        }
        attached.ws = null;
        const scheduleReconnect = () => {
          const current = runtimesRef.current.get(sessionId);
          if (
            !current ||
            current.scopeGeneration !== scopeGeneration ||
            current.connectionToken !== connectionToken ||
            !current.allowReconnect
          )
            return;
          setSessionPatch(sessionId, { status: "connecting" });
          const timer = setTimeout(() => {
            const latest = runtimesRef.current.get(sessionId);
            if (
              !latest ||
              latest.scopeGeneration !== scopeGeneration ||
              latest.connectionToken !== connectionToken ||
              !latest.allowReconnect ||
              reconnectTimersRef.current.get(sessionId) !== timer
            )
              return;
            reconnectTimersRef.current.delete(sessionId);
            connectSessionRef.current(sessionId, scopeGeneration);
          }, 1200);
          reconnectTimersRef.current.set(sessionId, timer);
        };
        const refreshPromise = attached.replayRefreshPromise;
        if (refreshPromise) void refreshPromise.then(scheduleReconnect, scheduleReconnect);
        else scheduleReconnect();
      };
      ws.onerror = () => {
        const current = runtimesRef.current.get(sessionId);
        if (
          !current ||
          current.scopeGeneration !== scopeGeneration ||
          current.connectionToken !== connectionToken ||
          current.ws !== ws
        )
          return;
        try {
          ws.close();
        } catch {}
      };
    },
    [
      applyTerminalChunk,
      flushPendingTerminalChunks,
      groupId,
      flushTerminalParser,
      finalizeRunningBlocks,
      finishBlock,
      loadPersistedBlocks,
      loadCommandHistory,
      resizeSession,
      sendInput,
      setSessionPatch,
      setTerminalStatus,
      startActiveProcessIdentityTracker,
      updateTerminal,
    ]
  );

  useEffect(() => {
    connectSessionRef.current = connectSession;
  }, [connectSession]);

  const createSession = useCallback(
    async (options: CreateBlockTermSessionOptions = {}) => {
      const scopeGeneration = scopeGenerationRef.current;
      const sessionState = useSessionStore.getState();
      if (!sessionState.sessionInitialized || sessionState.loading) return;
      const requestRevision = sessionState.workspaceRevision;
      const requestSessionId = sessionState.currentSessionId;
      const cwd = options.cwd || (options.runtimeType === "ssh" ? "." : getInitialCwd());
      const created = await enqueueWorkspaceMutation(async () => {
        const groupStillExists = useFrameStore.getState().groups.some((group) => group.id === groupId);
        if (!isCurrentWorkspaceTransition(requestRevision, requestSessionId, true) || !groupStillExists) return null;

        const index = sessionsRef.current.length + 1;
        const name = options.name || `BlockTerm ${index}`;
        const result = await terminalApi.create({
          cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          group_id: groupId,
          name,
          runtime_type: options.runtimeType,
          ssh_profile_id: options.sshProfileId,
          ssh_auth: options.sshAuth,
          workspace_session_id: requestSessionId || undefined,
        });
        const scopeStillExists = useFrameStore.getState().groups.some((group) => group.id === groupId);
        if (
          scopeGenerationRef.current !== scopeGeneration ||
          !isCurrentWorkspaceTransition(requestRevision, requestSessionId, true) ||
          !scopeStillExists
        ) {
          await cleanupSpeculativeTerminal(result.id, terminalApi);
          return null;
        }
        const previousActiveSessionId = activeSessionIdRef.current;
        const shouldActivate = options.activate !== false || !previousActiveSessionId;
        const session: BlockTermSession = {
          id: result.id,
          name: result.name || name,
          tabColor: "",
          tabIcon: "",
          cwd,
          runtimeType: options.runtimeType || "local",
          ...(options.runtimeType === "ssh" && options.sshProfileId ? { sshProfileId: options.sshProfileId } : {}),
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          shellState: "ready",
          shellIntegration: false,
          completion: false,
          status: "connecting",
          blocks: [],
          draft: "",
          activeBlockId: null,
          selectedBlockId: null,
          history: [],
          historyIndex: -1,
          historyDraft: null,
        };
        seedNextConnectionContext(session);
        addTerminal(groupId, {
          id: result.id,
          name: session.name,
          tabColor: session.tabColor,
          tabIcon: session.tabIcon,
          pinned: true,
          cwd,
          runtimeType: session.runtimeType,
          sshProfileId: options.sshProfileId,
        });
        setSessions((items) => [...items, session]);
        sessionFocusTargetRef.current[result.id] = { type: "input" };
        if (shouldActivate) {
          selectSession(result.id, "input");
        } else {
          setActiveTerminalId(groupId, previousActiveSessionId);
        }
        return result.id;
      });
      if (!created) return null;

      void Promise.all([loadPersistedBlocks(created), loadCommandHistory(created), loadSessionView(created)]).finally(
        () => {
          if (
            scopeGenerationRef.current === scopeGeneration &&
            isCurrentWorkspaceTransition(requestRevision, requestSessionId, true) &&
            useFrameStore.getState().groups.some((group) => group.id === groupId)
          )
            connectSession(created, scopeGeneration);
        }
      );
      return created;
    },
    [
      addTerminal,
      connectSession,
      groupId,
      loadCommandHistory,
      loadPersistedBlocks,
      loadSessionView,
      seedNextConnectionContext,
      selectSession,
      setActiveTerminalId,
    ]
  );

  const createSSHSession = useCallback(
    async ({ profile, auth, cwd }: SSHConnectionAttempt) => {
      await createSession({
        cwd,
        name: `BlockTerm ${sessionsRef.current.length + 1} · ${profile.name}`,
        runtimeType: "ssh",
        sshProfileId: profile.id,
        sshAuth: auth,
      });
    },
    [createSession]
  );

  const openSSHSessionDialog = useCallback(() => {
    sshSelectionScopeRef.current = null;
    setSSHSelectionSessionId(null);
    setSSHDialogOpen(true);
  }, []);

  const handleSSHDialogOpenChange = useCallback((open: boolean) => {
    setSSHDialogOpen(open);
    if (!open) {
      sshSelectionScopeRef.current = null;
      setSSHSelectionSessionId(null);
    }
  }, []);

  const selectSSHConnection = useCallback(
    async (profile: SSHConnectionAttempt["profile"]) => {
      const sessionId = sshSelectionSessionId;
      const target = sshSelectionScopeRef.current;
      if (
        !sessionId ||
        !target ||
        target.sessionId !== sessionId ||
        scopeGenerationRef.current !== target.scopeGeneration ||
        !isCurrentWorkspaceTransition(target.workspaceRevision, target.workspaceSessionId, true) ||
        !useFrameStore.getState().groups.some((group) => group.id === groupId) ||
        !sessionsRef.current.some((session) => session.id === sessionId)
      ) {
        throw new Error("BlockTerm session is no longer available");
      }
      await setNextConnectionContext(sessionId, { runtimeType: "ssh", sshProfileId: profile.id });
    },
    [groupId, setNextConnectionContext, sshSelectionSessionId]
  );

  const restoreScope = useMemo(
    () => getBlockTermRestoreScope(groupId, currentSessionId, sessionInitialized, sessionLoading),
    [currentSessionId, groupId, sessionInitialized, sessionLoading]
  );
  const restoreScopeKey = useMemo(
    () => getBlockTermRestoreScopeKey(groupId, currentSessionId),
    [currentSessionId, groupId]
  );
  if (currentRestoreScopeKeyRef.current !== restoreScopeKey) {
    const pending = pendingHistoryEntryRef.current;
    const nextGeneration = scopeGenerationRef.current + 1;
    const nextWorkspaceId = currentSessionId || undefined;
    if (pending && pending.workspaceSessionId !== nextWorkspaceId) {
      pendingHistoryEntryRef.current = null;
    } else if (pending) {
      pendingHistoryEntryRef.current = { ...pending, scopeGeneration: nextGeneration };
    }
    currentRestoreScopeKeyRef.current = restoreScopeKey;
    restoredScopeKeyRef.current = null;
    restoreRequestVersionRef.current += 1;
    scopeGenerationRef.current = nextGeneration;
  }

  const resetScopeRuntime = useCallback(
    (resetView = true) => {
      sessionCloseCoordinatorRef.current.reset();
      // Publish parser/decoder tails before the old session view is cleared.
      // The websocket cursor already advanced past these bytes, so dropping
      // them here would make a later scope restore skip output permanently.
      for (const session of sessionsRef.current) flushTerminalParser(session.id);
      const blockIds = new Set<string>(
        sessionsRef.current.flatMap((session) => session.blocks.map((block) => block.id))
      );
      for (const id of persistPatchRef.current.keys()) blockIds.add(id);
      for (const id of persistOutputRef.current.keys()) blockIds.add(id);
      for (const id of persistTimersRef.current.keys()) blockIds.add(id);
      for (const id of pendingBlockCreatesRef.current.keys()) blockIds.add(id);
      for (const id of createBlockRequestsRef.current.keys()) blockIds.add(id);
      for (const id of blockWriteChainsRef.current.keys()) blockIds.add(id);
      // Scope changes must not discard a just-finished block. Keep the backend
      // PTY alive, but finish any pending block writes before clearing views.
      for (const id of blockIds) {
        const timer = persistTimersRef.current.get(id);
        if (timer) clearTimeout(timer);
        persistTimersRef.current.delete(id);
      }
      const draining = flushBlockPersistence(blockIds);
      for (const id of blockIds) clearBlockTermRendererCache(id);
      restoreRequestVersionRef.current += 1;
      const pendingHistoryActivation = pendingHistoryEntryRef.current;
      const nextWorkspaceId = useSessionStore.getState().currentSessionId || undefined;
      const nextGeneration = scopeGenerationRef.current + 1;
      scopeGenerationRef.current = nextGeneration;
      if (pendingHistoryActivation && pendingHistoryActivation.workspaceSessionId === nextWorkspaceId) {
        pendingHistoryEntryRef.current = {
          ...pendingHistoryActivation,
          scopeGeneration: nextGeneration,
        };
      }
      restoredScopeKeyRef.current = null;
      for (const controller of Object.values(viewLoadControllersRef.current)) controller?.abort();
      viewLoadControllersRef.current = {};
      viewLoadPromisesRef.current = {};
      viewLoadGenerationRef.current = {};
      confirmedViewBySessionRef.current = {};
      confirmedViewGenerationRef.current = {};
      viewBySessionRef.current = {};
      sidebarDragRef.current = null;
      // Keep view write versions and chains across the reset. A restored scope
      // that reuses this terminal ID must stay behind any PATCH already sent by
      // the old scope; generation guards below prevent its result touching UI.
      // Do not abort PATCH fetches here: client abort cannot cancel a DB update
      // already running on the server and would let newer writes overtake it.
      closeCompletion();
      for (const session of sessionsRef.current) {
        persistedLoadRequestRef.current[session.id] = (persistedLoadRequestRef.current[session.id] || 0) + 1;
        historyLoadRequestRef.current[session.id] = (historyLoadRequestRef.current[session.id] || 0) + 1;
      }
      sessionsRef.current = [];
      activeSessionIdRef.current = null;
      nextConnectionBySessionRef.current = {};
      nextConnectionCwdWatermarkRef.current = {};
      sshSelectionScopeRef.current = null;
      sessionFocusTargetRef.current = {};
      pendingSessionFocusRef.current = null;
      pendingBlockFocusRef.current = null;
      if (!pendingHistoryActivation || pendingHistoryActivation.workspaceSessionId !== nextWorkspaceId) {
        pendingHistoryEntryRef.current = null;
      }
      cancelSessionFocusRetry();
      for (const timer of reconnectTimersRef.current.values()) clearTimeout(timer);
      reconnectTimersRef.current.clear();
      for (const timer of presentationHeightTimersRef.current.values()) clearTimeout(timer);
      presentationHeightTimersRef.current.clear();
      presentationHeightPendingRef.current.clear();
      for (const sequence of stopSequencesRef.current.values()) sequence.cancel();
      stopSequencesRef.current.clear();
      for (const current of processIdentityTrackersRef.current.values()) current.tracker.cancel();
      processIdentityTrackersRef.current.clear();
      capturedProcessIdentityBlockIdsRef.current.clear();
      // Navigation/unmount detaches child sockets but deliberately leaves the
      // exact bindings in sessionStorage so the next scope can reattach.
      for (const runtime of blockRuntimesRef.current.values()) {
        runtime.allowReconnect = false;
        if (runtime.reconnectTimer !== null) clearTimeout(runtime.reconnectTimer);
        runtime.reconnectTimer = null;
        if (runtime.ws) {
          runtime.ws.onclose = null;
          runtime.ws.close();
          runtime.ws = null;
        }
      }
      blockRuntimesRef.current.clear();
      for (const runtime of runtimesRef.current.values()) {
        runtime.allowReconnect = false;
        clearBlockTermTransitionTimer(runtime);
        runtime.transitionPrimaryBinding = null;
        if (runtime.ws) {
          runtime.ws.onclose = null;
          runtime.ws.close();
        }
      }
      runtimesRef.current.clear();
      for (const runtime of xtermRefs.current.values()) disposeTerminalRuntime(runtime);
      xtermRefs.current.clear();
      blockElementRefs.current.clear();
      sidebarBlockElementRefs.current.clear();
      outputStore.cancelLoads();
      sessionActiveBlockRef.current = {};
      interruptedOutputBlockRef.current = {};
      outputRef.current = {};
      terminalRawRef.current = {};
      modeRef.current = {};
      blockStatusRef.current = {};
      blockTokenRef.current = {};
      independentBlockIdsRef.current.clear();
      blockOutputPhaseRef.current = {};
      blockRestartTransitionRef.current = {};
      rawTargetCursorRef.current = {};
      rawAcknowledgedTargetCursorRef.current = {};
      blockCompletionCursorRef.current = {};
      nextLineNumRef.current = {};
      interruptedBlocksRef.current.clear();
      setUnavailableModelStreams(new Set());
      persistedLoadRequestRef.current = {};
      persistedLoadPromiseRef.current = {};
      persistedBlocksLoadedGenerationRef.current = {};
      historyLoadRequestRef.current = {};
      if (resetView) {
        setViewBySession({});
        setLineAIViewBySession({});
        setNextConnectionBySession({});
        setSSHSelectionSessionId(null);
        setSSHDialogOpen(false);
        setSidebarDragging(false);
        setHistoryDialogOpen(false);
        setFullscreenBlockId(null);
        setActiveSessionId(null);
        setSessions([]);
      }
      // Keep old write chains alive until their ordered requests settle. The
      // helper's finally handlers remove them without affecting a new scope.
      void draining
        .then(() => {
          for (const id of blockIds) {
            if (
              persistPatchRef.current.has(id) ||
              persistOutputRef.current.has(id) ||
              persistTimersRef.current.has(id) ||
              pendingBlockCreatesRef.current.has(id) ||
              blockWriteChainsRef.current.has(id) ||
              createBlockRequestsRef.current.has(id)
            )
              continue;
            persistPatchRef.current.delete(id);
            persistOutputRef.current.delete(id);
            deletedBlockIdsRef.current.delete(id);
            outputStore.delete(id);
          }
        })
        .catch(() => {});
    },
    [cancelSessionFocusRetry, closeCompletion, flushBlockPersistence, flushTerminalParser, outputStore]
  );

  useEffect(() => {
    const scopeKeyAtEffect = restoreScopeKey;
    return () => {
      // The regular unmount cleanup below owns final teardown. Only run this
      // reset when React is replacing this component's restore scope.
      if (currentRestoreScopeKeyRef.current !== scopeKeyAtEffect) resetScopeRuntime();
    };
  }, [resetScopeRuntime, restoreScopeKey]);

  useEffect(() => {
    if (!restoreScope || restoredScopeKeyRef.current === restoreScopeKey) return;
    restoredScopeKeyRef.current = restoreScopeKey;
    const requestVersion = restoreRequestVersionRef.current;
    const isCurrentRequest = () => {
      const state = useSessionStore.getState();
      return (
        currentRestoreScopeKeyRef.current === restoreScopeKey &&
        restoreRequestVersionRef.current === requestVersion &&
        isBlockTermRestoreScopeCurrent(restoreScope, state.currentSessionId)
      );
    };
    const isRestoreReady = () => {
      const state = useSessionStore.getState();
      return (
        state.sessionInitialized &&
        !state.loading &&
        isBlockTermRestoreScopeCurrent(restoreScope, state.currentSessionId)
      );
    };
    const deferCurrentRestore = () => {
      if (isCurrentRequest()) restoredScopeKeyRef.current = null;
    };
    const restore = async () => {
      try {
        await restoreBlockTermTerminalInventory({
          load: async () => {
            const result = await terminalApi.list({
              group_id: restoreScope.groupId,
              workspace_session_id: restoreScope.workspaceSessionId,
            });
            toast.dismiss(`blockterm-session-restore-${restoreScopeKey}`);
            const roots = result.terminals.filter((terminal) =>
              isBlockTermRootTerminalInRestoreScope(
                terminal.workspace_session_id,
                restoreScope.workspaceSessionId,
                terminal.parent_id
              )
            );
            return orderBlockTermTerminalsByWorkspace(
              roots,
              useTerminalStore.getState().getTerminals(restoreScope.groupId)
            );
          },
          restore: async (existing) => {
            if (!isCurrentRequest()) return;
            if (!isRestoreReady()) {
              deferCurrentRestore();
              return;
            }
            const restored: BlockTermSession[] = existing.map((terminal) => ({
              id: terminal.id,
              name: terminal.name,
              tabColor: terminal.tab_color || "",
              tabIcon: terminal.tab_icon || "",
              cwd: terminal.current_cwd || terminal.cwd || ".",
              runtimeType: terminal.runtime_type === "ssh" ? "ssh" : "local",
              ...(terminal.runtime_type === "ssh" && terminal.ssh_profile_id
                ? { sshProfileId: terminal.ssh_profile_id }
                : {}),
              cols: terminal.cols || DEFAULT_COLS,
              rows: terminal.rows || DEFAULT_ROWS,
              shellType: terminal.shell_type || undefined,
              shellState: terminal.shell_state || undefined,
              shellIntegration: terminal.shell_integration,
              completion: terminal.capabilities?.completion === true,
              lastCommand: terminal.last_command || undefined,
              lastCommandExitCode: terminal.last_command_exit_code ?? null,
              status: terminal.status === "running" ? "connecting" : terminal.status,
              blocks: [],
              draft: "",
              activeBlockId: null,
              selectedBlockId: null,
              history: [],
              historyIndex: -1,
              historyDraft: null,
            }));
            for (const session of restored) seedNextConnectionContext(session);
            const preferredActiveId = useTerminalStore.getState().getActiveId(restoreScope.groupId);
            const activeId = resolveBlockTermActiveSessionId(
              restored.map((session) => session.id),
              preferredActiveId
            );
            cancelSessionFocusRetry();
            activeSessionIdRef.current = activeId;
            pendingSessionFocusRef.current = activeId ? { sessionId: activeId, mode: "restore" } : null;
            setSessions(restored);
            setActiveSessionId(activeId);
            for (const terminal of existing) {
              const terminalExists = useTerminalStore
                .getState()
                .getTerminals(restoreScope.groupId)
                .some((item) => item.id === terminal.id);
              if (!terminalExists) {
                addTerminal(restoreScope.groupId, {
                  id: terminal.id,
                  name: terminal.name,
                  tabColor: terminal.tab_color || "",
                  tabIcon: terminal.tab_icon || "",
                  pinned: true,
                  cwd: terminal.current_cwd || terminal.cwd,
                  runtimeType: terminal.runtime_type,
                  sshProfileId: terminal.ssh_profile_id,
                });
              } else {
                updateTerminal(restoreScope.groupId, terminal.id, {
                  name: terminal.name,
                  tabColor: terminal.tab_color || "",
                  tabIcon: terminal.tab_icon || "",
                });
              }
              setTerminalStatus(restoreScope.groupId, terminal.id, terminal.status);
              await Promise.all([
                loadPersistedBlocks(terminal.id),
                loadCommandHistory(terminal.id),
                loadSessionView(terminal.id),
              ]);
              if (!isCurrentRequest()) return;
              if (!isRestoreReady()) {
                deferCurrentRestore();
                return;
              }
              // Even an exited terminal may still have a correlated command
              // completion in the live manager. Complete one state handshake
              // before treating durable running blocks as interrupted.
              connectSession(terminal.id);
            }
            if (isCurrentRequest()) {
              const committedActiveId = resolveBlockTermActiveSessionId(
                restored.map((session) => session.id),
                useTerminalStore.getState().getActiveId(restoreScope.groupId)
              );
              if (activeSessionIdRef.current !== committedActiveId) {
                cancelSessionFocusRetry();
                activeSessionIdRef.current = committedActiveId;
                pendingSessionFocusRef.current = committedActiveId
                  ? { sessionId: committedActiveId, mode: "restore" }
                  : null;
                setActiveSessionId(committedActiveId);
              }
              setActiveTerminalId(restoreScope.groupId, committedActiveId);
            }
          },
          create: async () => {
            if (!isCurrentRequest()) return;
            if (!isRestoreReady()) {
              deferCurrentRestore();
              return;
            }
            await createSession();
          },
        });
      } catch (error) {
        if (!isCurrentRequest()) return;
        if (!isRestoreReady()) {
          deferCurrentRestore();
          return;
        }
        deferCurrentRestore();
        toast.error(t("plugin.blockTerm.restoreFailed"), {
          id: `blockterm-session-restore-${restoreScopeKey}`,
          description: error instanceof Error ? error.message : undefined,
          action: {
            label: t("plugin.blockTerm.retryRestore"),
            onClick: () => {
              if (currentRestoreScopeKeyRef.current !== restoreScopeKey) return;
              restoredScopeKeyRef.current = null;
              setRestoreRetryNonce((current) => current + 1);
            },
          },
        });
      }
    };
    void restore();
  }, [
    addTerminal,
    cancelSessionFocusRetry,
    connectSession,
    createSession,
    loadPersistedBlocks,
    loadCommandHistory,
    loadSessionView,
    restoreScope,
    restoreScopeKey,
    restoreRetryNonce,
    setActiveTerminalId,
    setTerminalStatus,
    seedNextConnectionContext,
    t,
    updateTerminal,
  ]);

  useEffect(() => {
    return () => {
      resetScopeRuntime(false);
    };
  }, [resetScopeRuntime]);

  const setDraft = useCallback(
    (sessionId: string, draft: string) => {
      closeCompletion();
      setSessionPatch(sessionId, { draft, historyIndex: -1, historyDraft: null });
    },
    [closeCompletion, setSessionPatch]
  );

  const openLineAI = useCallback((sessionId: string, sourceBlockId: string) => {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    const sourceBlock = session?.blocks.find((block) => block.id === sourceBlockId);
    if (
      !session ||
      (session.status !== "ready" && session.status !== "running") ||
      !sourceBlock ||
      sourceBlock.archived ||
      sourceBlock.kind === "note" ||
      isActiveBlockStatus(sourceBlock.status) ||
      deletingBlockIdsRef.current.has(sourceBlockId) ||
      deletedBlockIdsRef.current.has(sourceBlockId)
    )
      return;
    setLineAIViewBySession((current) => ({
      ...current,
      [sessionId]: { sourceBlockId, open: true },
    }));
  }, []);

  const closeLineAI = useCallback((sessionId: string) => {
    setLineAIViewBySession((current) => {
      const view = current[sessionId];
      if (!view?.open) return current;
      return { ...current, [sessionId]: { ...view, open: false } };
    });
  }, []);

  const clearLineAIConversationForSession = useCallback((sessionId: string) => {
    flushSync(() => {
      setLineAIViewBySession((current) => {
        if (!(sessionId in current)) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    });
    clearBlockTermLineAIConversation(sessionId);
  }, []);

  const openBookmarkManager = useCallback(() => {
    closeCompletion();
    setBookmarkInitialCommand(undefined);
    setBookmarkDialogOpen(true);
  }, [closeCompletion]);

  const openBookmarkCreate = useCallback((command: string) => {
    setBookmarkInitialCommand(command);
    setBookmarkDialogOpen(true);
  }, []);

  const useBookmarkCommand = useCallback(
    (command: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      flushSync(() => setDraft(sessionId, command));
      window.requestAnimationFrame(() => {
        const textarea = commandInputRef.current;
        if (!textarea || activeSessionIdRef.current !== sessionId) return;
        textarea.focus();
        textarea.setSelectionRange(command.length, command.length);
      });
    },
    [setDraft]
  );

  const useHistoryCommand = useCallback(
    (command: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      flushSync(() => {
        setHistoryCenterOpen(false);
        setDraft(sessionId, command);
      });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const textarea = commandInputRef.current;
          if (!textarea || activeSessionIdRef.current !== sessionId) return;
          textarea.focus();
          textarea.setSelectionRange(command.length, command.length);
        });
      });
    },
    [setDraft]
  );

  const refillLineAICommand = useCallback(
    (edit: { draft: string; cursor: number }) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      flushSync(() => setDraft(sessionId, edit.draft));
      window.requestAnimationFrame(() => {
        const textarea = commandInputRef.current;
        if (!textarea || activeSessionIdRef.current !== sessionId) return;
        textarea.focus();
        const cursor = Math.max(0, Math.min(edit.cursor, edit.draft.length));
        textarea.setSelectionRange(cursor, cursor);
      });
    },
    [setDraft]
  );

  const allocateLineAILineNum = useCallback((sessionId: string): number => {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    const lineNum = Math.max(nextLineNumRef.current[sessionId] || 0, nextBlockLineNum(session?.blocks || []));
    nextLineNumRef.current[sessionId] = lineNum + 1;
    return lineNum;
  }, []);

  const isCompletionSnapshotCurrent = useCallback(
    (sessionId: string, context: BlockTermCompletionContext, scopeGeneration: number): boolean => {
      if (scopeGenerationRef.current !== scopeGeneration || activeSessionIdRef.current !== sessionId) return false;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const textarea = commandInputRef.current;
      return (
        session?.draft === context.draft &&
        textarea?.value === context.draft &&
        textarea.selectionStart === context.cursor &&
        textarea.selectionEnd === context.cursor
      );
    },
    []
  );

  const applyCompletionEdit = useCallback(
    (sessionId: string, edit: BlockTermCompletionEdit) => {
      closeCompletion();
      flushSync(() => {
        setSessionPatch(sessionId, { draft: edit.draft, historyIndex: -1, historyDraft: null });
      });
      const textarea = commandInputRef.current;
      if (activeSessionIdRef.current !== sessionId || textarea?.value !== edit.draft) return;
      textarea.focus();
      textarea.setSelectionRange(edit.cursor, edit.cursor);
    },
    [closeCompletion, setSessionPatch]
  );

  const requestCompletion = useCallback(
    async (sessionId: string, textarea: HTMLTextAreaElement): Promise<void> => {
      const cursor = textarea.selectionStart;
      if (textarea.selectionEnd !== cursor) {
        closeCompletion();
        return;
      }
      const context = parseBlockTermCompletionContext(textarea.value, cursor);
      if (!context) {
        closeCompletion();
        return;
      }
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session || session.draft !== context.draft) {
        closeCompletion();
        return;
      }

      completionAbortRef.current?.abort();
      const controller = new AbortController();
      completionAbortRef.current = controller;
      const requestId = completionRequestRef.current + 1;
      completionRequestRef.current = requestId;
      const scopeGeneration = scopeGenerationRef.current;
      setGhostCompletion(null);

      const commandCompletion = resolveBlockTermCommandCompletion(context.draft, context.cursor);
      if (commandCompletion) {
        const resolution = resolveBlockTermCompletion(
          commandCompletion.context,
          commandCompletion.candidates,
          commandCompletion.commonPrefix,
          false
        );
        if (resolution.edit) {
          applyCompletionEdit(sessionId, resolution.edit);
          return;
        }
        setCompletionState({
          sessionId,
          context: commandCompletion.context,
          candidates: commandCompletion.candidates,
          commandCandidates: commandCompletion.candidates,
          selectedIndex: 0,
          loading: false,
          scopeGeneration,
        });
        completionAbortRef.current = null;
        return;
      }
      if (!session.completion) {
        closeCompletion();
        return;
      }

      setCompletionState({
        sessionId,
        context,
        candidates: [],
        selectedIndex: 0,
        loading: true,
        scopeGeneration,
      });

      try {
        // OSC 633 cwd updates are persisted through this ordered chain. The
        // completion endpoint reads the active terminal cwd, so wait for every
        // update already queued for this session before scanning.
        await awaitSessionCommandChain(runtimeInfoWriteChainsRef.current, sessionId);
        if (
          controller.signal.aborted ||
          completionRequestRef.current !== requestId ||
          !isCompletionSnapshotCurrent(sessionId, context, scopeGeneration)
        )
          return;
        const connection = resolveSessionConnectionContext(session);
        const completionCwd = resolveBlockTermConnectionCwd({ connection, current: session });
        const result = await blockTermApi.complete({
          terminalId: sessionId,
          draft: context.draft,
          cursor: context.cursor,
          prefix: context.prefix,
          kind: context.kind,
          executableOnly: context.executableOnly,
          cwd: completionCwd,
          runtimeType: connection.runtimeType,
          sshProfileId: connection.sshProfileId,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          completionRequestRef.current !== requestId ||
          result.prefix !== context.prefix ||
          result.kind !== context.kind ||
          !isCompletionSnapshotCurrent(sessionId, context, scopeGeneration)
        )
          return;

        const resolution = resolveBlockTermCompletion(context, result.candidates, result.commonPrefix, result.hasMore);
        if (resolution.edit) {
          applyCompletionEdit(sessionId, resolution.edit);
          return;
        }
        if (!resolution.showCandidates) {
          setCompletionState(null);
          return;
        }
        setCompletionState({
          sessionId,
          context,
          candidates: result.candidates,
          selectedIndex: 0,
          loading: false,
          scopeGeneration,
        });
      } catch {
        if (!controller.signal.aborted && completionRequestRef.current === requestId) setCompletionState(null);
      } finally {
        if (completionAbortRef.current === controller) completionAbortRef.current = null;
      }
    },
    [applyCompletionEdit, closeCompletion, isCompletionSnapshotCurrent, resolveSessionConnectionContext]
  );

  const applyCompletionCandidate = useCallback(
    (candidate: BlockTermCompletionCandidate) => {
      const state = completionState;
      if (!state || !isCompletionSnapshotCurrent(state.sessionId, state.context, state.scopeGeneration)) {
        closeCompletion();
        return;
      }
      const edit = applyBlockTermCompletion(state.context, candidate.value, true, candidate.isDirectory);
      if (!edit) {
        closeCompletion();
        return;
      }
      applyCompletionEdit(state.sessionId, edit);
    },
    [applyCompletionEdit, closeCompletion, completionState, isCompletionSnapshotCurrent]
  );

  useEffect(() => {
    closeCompletion();
  }, [activeSessionId, closeCompletion]);

  useEffect(() => {
    if (!completionState || completionState.loading) return;
    completionOptionRefs.current.get(completionState.selectedIndex)?.scrollIntoView({ block: "nearest" });
  }, [completionState]);

  const selectBlock = useCallback(
    (sessionId: string, blockId: string | null) => {
      cancelPendingHistoryActivation();
      setSessionPatch(sessionId, { selectedBlockId: blockId });
    },
    [cancelPendingHistoryActivation, setSessionPatch]
  );

  const focusBlock = useCallback(
    (blockId: string, block: ScrollLogicalPosition = "nearest") => {
      const pending = { blockId, position: block };
      pendingBlockFocusRef.current = pending;
      const scrollToBlock = () => {
        if (pendingBlockFocusRef.current !== pending) return false;
        const index = visibleOrderedBlocksRef.current.findIndex((item) => item.id === blockId);
        if (index < 0) return false;
        blockVirtualizer.scrollToIndex(index, {
          align: block === "start" ? "start" : block === "end" ? "end" : "auto",
        });
        return true;
      };
      scrollToBlock();
      const applyFocus = () => {
        if (pendingBlockFocusRef.current !== pending) return false;
        const element = blockElementRefs.current.get(blockId);
        if (!element) return false;
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block, inline: "nearest" });
        pendingBlockFocusRef.current = null;
        return true;
      };
      window.requestAnimationFrame(() => {
        scrollToBlock();
        applyFocus();
      });
    },
    [blockVirtualizer]
  );

  const applyHistoryEntryActivation = useCallback(
    (pending: BlockTermPendingHistoryActivation): "discarded" | "pending" | "settled" => {
      const entry = pending.entry;
      const activationRequest = getBlockTermHistoryActivationRequest();
      // A navigation callback can run immediately after switchSession resolves,
      // before React commits the new restore scope. Rebind the request when it
      // is still the active request for the same workspace; otherwise an old
      // scope or superseded request must never affect the current view.
      if (!activationRequest || activationRequest.requestId !== pending.requestId) return "discarded";
      const currentGeneration = scopeGenerationRef.current;
      if (pending.scopeGeneration !== currentGeneration) {
        const currentWorkspaceId = useSessionStore.getState().currentSessionId || undefined;
        if (pending.workspaceSessionId !== currentWorkspaceId) return "discarded";
        pending = { ...pending, scopeGeneration: currentGeneration };
        pendingHistoryEntryRef.current = pending;
      }
      const session = sessionsRef.current.find((item) => item.id === entry.terminalId);
      if (!session) return "pending";
      const inventoryLoaded = persistedBlocksLoadedGenerationRef.current[session.id] === currentGeneration;
      const activationState = resolveBlockTermHistoryActivationState(
        session.blocks,
        entry.id,
        inventoryLoaded,
        entry.terminalId,
        activeSessionIdRef.current,
        pending.scopeGeneration,
        currentGeneration
      );
      if (activationState === "discard") return "discarded";
      if (activationState === "wait") return "pending";
      const block = session.blocks.find((item) => item.id === entry.id);
      if (!block) {
        clearBlockTermHistoryActivation(pending.requestId);
        return "settled";
      }
      if (block.archived) setShowArchived(true);
      setShowRunningOnly(false);
      setShowStarredOnly(false);
      selectBlock(session.id, block.id);
      focusBlock(block.id, "center");
      clearBlockTermHistoryActivation(pending.requestId);
      return "settled";
    },
    [focusBlock, selectBlock]
  );

  useEffect(() => {
    const request = historyActivationRequest;
    if (!request) return;
    const workspaceSessionId = request.workspaceSessionId;
    if (workspaceSessionId && workspaceSessionId !== currentSessionId) return;
    let pending = pendingHistoryEntryRef.current;
    if (pending?.requestId !== request.requestId) {
      pending = {
        entry: request.entry,
        scopeGeneration: scopeGenerationRef.current,
        workspaceSessionId,
        requestId: request.requestId,
      };
      pendingHistoryEntryRef.current = pending;
    }
    const state = applyHistoryEntryActivation(pending);
    if (state !== "pending" && pendingHistoryEntryRef.current === pending) {
      pendingHistoryEntryRef.current = null;
    }
  }, [applyHistoryEntryActivation, currentSessionId, historyActivationRequest, activeSessionId, sessions]);

  useEffect(() => {
    const pending = pendingHistoryEntryRef.current;
    if (pending && applyHistoryEntryActivation(pending) !== "pending" && pendingHistoryEntryRef.current === pending) {
      pendingHistoryEntryRef.current = null;
    }
  }, [activeSessionId, applyHistoryEntryActivation, sessions]);

  const attemptSessionFocus = useCallback(() => {
    const pending = pendingSessionFocusRef.current;
    if (!pending || activeSessionIdRef.current !== pending.sessionId) return;
    if (hasOpenBlockTermDesktopShortcutModal(document)) {
      cancelPendingSessionFocus();
      return;
    }
    const session = sessionsRef.current.find((item) => item.id === pending.sessionId);
    if (!session) return;

    let retry = sessionFocusRetryRef.current;
    if (!retry || retry.pending !== pending) {
      if (retry?.timer !== null && retry?.timer !== undefined) window.clearTimeout(retry.timer);
      retry = {
        pending,
        timer: null,
        passCount: 0,
        deadlineAt: Date.now() + BLOCKTERM_SESSION_FOCUS_RETRY_TIMEOUT_MS,
      };
      sessionFocusRetryRef.current = retry;
    } else if (retry.timer !== null) {
      window.clearTimeout(retry.timer);
      retry.timer = null;
    }
    retry.passCount += 1;
    const retryExpired = () => Date.now() >= retry.deadlineAt;

    const finish = () => {
      if (pendingSessionFocusRef.current === pending) pendingSessionFocusRef.current = null;
      const currentRetry = sessionFocusRetryRef.current;
      if (currentRetry?.pending === pending) {
        if (currentRetry.timer !== null) window.clearTimeout(currentRetry.timer);
        sessionFocusRetryRef.current = null;
      }
      if (sessionFocusScrollRef.current?.pending === pending) sessionFocusScrollRef.current = null;
    };
    const restoreFocus = (focus: () => void) => {
      sessionFocusRestoreInProgressRef.current = true;
      try {
        focus();
      } finally {
        sessionFocusRestoreInProgressRef.current = false;
      }
    };
    const scheduleRetry = () => {
      const currentRetry = sessionFocusRetryRef.current;
      if (!currentRetry || currentRetry.pending !== pending || currentRetry.timer !== null) {
        return;
      }
      const delay = Math.min(BLOCKTERM_SESSION_FOCUS_RETRY_DELAY_MS, Math.max(0, currentRetry.deadlineAt - Date.now()));
      const timer = window.setTimeout(() => {
        const latestRetry = sessionFocusRetryRef.current;
        if (!latestRetry || latestRetry.pending !== pending || latestRetry.timer !== timer) return;
        latestRetry.timer = null;
        if (hasOpenBlockTermDesktopShortcutModal(document)) {
          cancelPendingSessionFocus();
          return;
        }
        sessionFocusAttemptRef.current();
      }, delay);
      currentRetry.timer = timer;
    };
    const focusUntilStable = (isFocused: () => boolean, focus: () => void): boolean => {
      if (isFocused()) {
        finish();
        return true;
      }
      restoreFocus(focus);
      if (!isFocused()) return false;
      if (retryExpired()) finish();
      else scheduleRetry();
      return true;
    };
    const focusInput = (): boolean => {
      const input = commandInputRef.current;
      if (!input || input.disabled) return false;
      return focusUntilStable(
        () => document.activeElement === input,
        () => input.focus({ preventScroll: true })
      );
    };

    const storedTarget =
      pending.mode === "input"
        ? ({ type: "input" } as const)
        : sessionFocusTargetRef.current[pending.sessionId] || ({ type: "input" } as const);
    const mainBlockIds = visibleOrderedBlocksRef.current.map((block) => block.id);
    const currentView = viewBySessionRef.current[pending.sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
    const sidebarBlockId =
      currentView.sidebar.open &&
      currentView.sidebar.blockId &&
      session.blocks.some((block) => block.id === currentView.sidebar.blockId && !block.archived)
        ? currentView.sidebar.blockId
        : null;
    const target = resolveBlockTermSessionFocusTarget(
      storedTarget,
      mainBlockIds,
      sidebarBlockId,
      session.selectedBlockId
    );
    if (target.type === "input") {
      if (!focusInput()) {
        if (retryExpired()) finish();
        else scheduleRetry();
      }
      return;
    }

    const block = session.blocks.find((item) => item.id === target.blockId);
    const blockElement =
      target.area === "sidebar"
        ? sidebarBlockElementRefs.current.get(target.blockId)
        : blockElementRefs.current.get(target.blockId);
    if (target.area === "main" && !blockElement) {
      const index = mainBlockIds.indexOf(target.blockId);
      if (index >= 0) {
        const previousScroll = sessionFocusScrollRef.current;
        if (
          !previousScroll ||
          previousScroll.pending !== pending ||
          previousScroll.blockId !== target.blockId ||
          retry.passCount % 8 === 1
        ) {
          blockVirtualizer.scrollToIndex(index, { align: "auto" });
          sessionFocusScrollRef.current = { pending, blockId: target.blockId };
        }
      }
    }

    if (target.focus === "terminal") {
      const terminalRuntime = xtermRefs.current.get(target.blockId);
      if (terminalRuntime && !terminalRuntime.disposed) {
        const focused = focusUntilStable(
          () => {
            const active = document.activeElement;
            return Boolean(active && blockElement?.contains(active) && active.closest(".xterm"));
          },
          () => terminalRuntime.terminal.focus()
        );
        if (focused) return;
      }
      const terminalCanMount = Boolean(
        block && shouldUseBlockTermTerminalRenderer(block.renderer) && (target.area === "sidebar" || !block.collapsed)
      );
      if (!terminalCanMount && blockElement) {
        const focused = focusUntilStable(
          () => document.activeElement === blockElement,
          () => {
            blockElement.focus({ preventScroll: true });
            blockElement.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        );
        if (focused) return;
      }
    } else if (target.focus === "editor") {
      const editorInput = blockElement?.querySelector<HTMLElement>(".monaco-editor textarea");
      if (editorInput) {
        const focused = focusUntilStable(
          () => {
            const active = document.activeElement;
            return Boolean(active && blockElement?.contains(active) && active.closest(".monaco-editor"));
          },
          () => {
            editorInput.focus({ preventScroll: true });
            blockElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        );
        if (focused) return;
      }
    } else if (blockElement) {
      const focused = focusUntilStable(
        () => document.activeElement === blockElement,
        () => {
          blockElement.focus({ preventScroll: true });
          blockElement.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      );
      if (focused) return;
    }

    if (retryExpired()) {
      if (blockElement) {
        restoreFocus(() => {
          blockElement.focus({ preventScroll: true });
          blockElement.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
        finish();
      } else {
        if (!focusInput()) finish();
      }
      return;
    }
    scheduleRetry();
  }, [blockVirtualizer, cancelPendingSessionFocus]);
  sessionFocusAttemptRef.current = attemptSessionFocus;

  useEffect(() => {
    attemptSessionFocus();
  }, [
    activeSession,
    attemptSessionFocus,
    legalizedActiveView.sidebar.blockId,
    legalizedActiveView.sidebar.open,
    virtualBlockRows,
  ]);

  useEffect(() => {
    const listener = (event: FocusEvent) => {
      const pending = pendingSessionFocusRef.current;
      if (!pending || sessionFocusRestoreInProgressRef.current) return;
      const target = event.target;
      if (target instanceof Element) {
        const page = target.closest<HTMLElement>("[data-blockterm-page]");
        if (page?.dataset.blocktermRenderSessionId && page.dataset.blocktermRenderSessionId !== pending.sessionId) {
          return;
        }
        const storedTarget =
          pending.mode === "input"
            ? ({ type: "input" } as const)
            : sessionFocusTargetRef.current[pending.sessionId] || ({ type: "input" } as const);
        if (storedTarget.type === "input" && target === commandInputRef.current) return;
        if (storedTarget.type === "block") {
          const blockElement = target.closest<HTMLElement>("[data-block-id]");
          const area = blockElement?.dataset.blocktermBlockArea === "sidebar" ? "sidebar" : "main";
          const focusMatches =
            (storedTarget.focus === "editor" && Boolean(target.closest(".monaco-editor"))) ||
            (storedTarget.focus === "terminal" && Boolean(target.closest(".xterm"))) ||
            (storedTarget.focus === "container" && target === blockElement);
          if (blockElement?.dataset.blockId === storedTarget.blockId && area === storedTarget.area && focusMatches) {
            return;
          }
        }
      }
      cancelPendingSessionFocus();
    };
    document.addEventListener("focusin", listener, true);
    return () => document.removeEventListener("focusin", listener, true);
  }, [cancelPendingSessionFocus]);

  useEffect(() => {
    const pending = pendingBlockFocusRef.current;
    if (!pending) return;
    const element = blockElementRefs.current.get(pending.blockId);
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: pending.position, inline: "nearest" });
    pendingBlockFocusRef.current = null;
  }, [virtualBlockRows]);

  const getBlockPageSize = useCallback((): number => {
    const scrollElement = blockScrollRef.current;
    if (!scrollElement) return 5;
    const viewportStart = scrollElement.scrollTop;
    const viewportEnd = viewportStart + scrollElement.clientHeight;
    const visibleCount = virtualBlockRows.filter((row) => row.end > viewportStart && row.start < viewportEnd).length;
    return Math.max(1, visibleCount);
  }, [virtualBlockRows]);

  const moveSelection = useCallback(
    (sessionId: string, blockId: string, key: BlockNavigationKey): string | null => {
      if (activeSession?.id !== sessionId) return null;
      const nextId = getBlockNavigationTarget(
        visibleOrderedBlocks,
        blockId,
        key,
        key === "PageUp" || key === "PageDown" ? getBlockPageSize() : 1
      );
      if (!nextId) return null;
      selectBlock(sessionId, nextId);
      return nextId;
    },
    [activeSession?.id, getBlockPageSize, selectBlock, visibleOrderedBlocks]
  );

  const handleHistoryKey = useCallback(
    (sessionId: string, key: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session || (key !== "ArrowUp" && key !== "ArrowDown")) return;
      const nextState = navigateBlockHistory(session, key);
      if (nextState) setSessionPatch(sessionId, nextState);
    },
    [sessions, setSessionPatch]
  );

  const updateBlockState = useCallback(
    (sessionId: string, blockId: string, patch: Partial<BlockTermBlock>) => {
      const visiblePatch =
        patch.runtimeType === "local" && patch.sshProfileId === undefined
          ? { ...patch, sshProfileId: undefined }
          : patch;
      updateSessionBlock(sessionId, blockId, visiblePatch);
      const apiPatch: Parameters<typeof blockTermApi.update>[1] = {};
      if (patch.kind !== undefined) apiPatch.kind = patch.kind;
      if (patch.command !== undefined) apiPatch.command = patch.command;
      if (patch.text !== undefined) apiPatch.text = patch.text;
      if (patch.cwd !== undefined) apiPatch.cwd = patch.cwd;
      if (patch.runtimeType !== undefined) {
        apiPatch.runtimeType = patch.runtimeType;
        if (patch.runtimeType === "local" && patch.sshProfileId === undefined) apiPatch.sshProfileId = null;
      }
      if (patch.sshProfileId !== undefined) apiPatch.sshProfileId = patch.sshProfileId;
      if (patch.status !== undefined) apiPatch.status = patch.status;
      if (patch.mode !== undefined) apiPatch.mode = patch.mode;
      if (patch.cmdPid !== undefined) apiPatch.cmdPid = patch.cmdPid;
      if (patch.remotePid !== undefined) apiPatch.remotePid = patch.remotePid;
      if (patch.termCols !== undefined) apiPatch.termCols = patch.termCols;
      if (patch.termRows !== undefined) apiPatch.termRows = patch.termRows;
      if (patch.termFlexRows !== undefined) apiPatch.termFlexRows = patch.termFlexRows;
      if (patch.termMaxPtySize !== undefined) apiPatch.termMaxPtySize = patch.termMaxPtySize;
      if (patch.beforeStateJson !== undefined) apiPatch.beforeStateJson = patch.beforeStateJson;
      if (patch.afterStateJson !== undefined) apiPatch.afterStateJson = patch.afterStateJson;
      if (patch.exitCode !== undefined) apiPatch.exitCode = patch.exitCode;
      if (patch.startedAt !== undefined) apiPatch.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) apiPatch.finishedAt = patch.finishedAt;
      if (patch.collapsed !== undefined) apiPatch.collapsed = patch.collapsed;
      if (patch.pinned !== undefined) apiPatch.pinned = patch.pinned;
      if (patch.archived !== undefined) apiPatch.archived = patch.archived;
      if (patch.starred !== undefined) apiPatch.starred = patch.starred;
      if (patch.renderer !== undefined) apiPatch.renderer = patch.renderer;
      if (patch.stateJson !== undefined) apiPatch.stateJson = patch.stateJson;
      if (patch.presentationJson !== undefined) apiPatch.presentationJson = patch.presentationJson;
      if (patch.lineNum !== undefined) apiPatch.lineNum = patch.lineNum;
      if (patch.pinned !== undefined) outputStore.setPinned(blockId, "block-pin", patch.pinned);
      if (patch.status !== undefined) outputStore.setPinned(blockId, "running", isActiveBlockStatus(patch.status));
      if (Object.keys(apiPatch).length > 0) persistBlockPatch(blockId, apiPatch);
    },
    [outputStore, persistBlockPatch, updateSessionBlock]
  );

  const handleModelEvent = useCallback(
    (
      sessionId: string,
      blockId: string,
      patch: Partial<Pick<BlockTermBlock, "output" | "status" | "exitCode" | "finishedAt">>
    ) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const block = session?.blocks.find((item) => item.id === blockId);
      if (!block || block.renderer !== "openai") return;
      const { output, ...statePatch } = patch;
      if (output !== undefined) {
        outputRef.current[blockId] = output;
        outputStore.hydrate(blockId, output, null);
      }
      if (statePatch.status !== undefined) {
        outputStore.setPinned(blockId, "running", isActiveBlockStatus(statePatch.status));
      }
      if (Object.keys(statePatch).length > 0) updateSessionBlock(sessionId, blockId, statePatch);
    },
    [outputStore, updateSessionBlock]
  );

  const handleModelStreamUnavailable = useCallback((blockId: string, unavailable: boolean) => {
    setUnavailableModelStreams((current) => {
      if (current.has(blockId) === unavailable) return current;
      const next = new Set(current);
      if (unavailable) next.add(blockId);
      else next.delete(blockId);
      return next;
    });
  }, []);

  const disposeMountedBlockTerminal = useCallback((blockId: string) => {
    const runtime = xtermRefs.current.get(blockId);
    if (!runtime) return;
    disposeTerminalRuntime(runtime);
    xtermRefs.current.delete(blockId);
  }, []);

  const patchSessionView = useCallback(
    (sessionId: string, patch: BlockTermViewPatch, movingBlockIds: string[] = [], allowDeletingCleanup = false) => {
      const scopeGeneration = scopeGenerationRef.current;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return Promise.resolve();
      const currentView = viewBySessionRef.current[sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
      const cachedNext = nextConnectionBySessionRef.current[sessionId];
      const previous =
        !currentView.nextConnection && cachedNext
          ? setBlockTermNextConnectionState(currentView, cachedNext)
          : currentView;
      let optimistic = previous;
      if (patch.sidebar !== undefined) optimistic = setBlockTermSidebarState(optimistic, patch.sidebar);
      if (patch.nextConnection !== undefined) {
        optimistic = setBlockTermNextConnectionState(optimistic, patch.nextConnection);
      }
      const isSidebarPatchAllowed = () => {
        if (patch.sidebar === undefined) return true;
        const latestSession = sessionsRef.current.find((item) => item.id === sessionId);
        if (!latestSession) return false;
        for (const blockId of movingBlockIds) {
          const block = latestSession.blocks.find((item) => item.id === blockId);
          // Closing a stale sidebar is still useful even after its owner has
          // disappeared from the in-memory inventory; there is no runtime to
          // move in that case.
          if (!block) {
            if (!optimistic.sidebar.open) continue;
            return false;
          }
          if (
            !allowDeletingCleanup &&
            (deletedBlockIdsRef.current.has(blockId) || deletingBlockIdsRef.current.has(blockId))
          )
            return false;
        }
        if (!optimistic.sidebar.open) return true;
        const blockId = optimistic.sidebar.blockId;
        if (!blockId || deletedBlockIdsRef.current.has(blockId) || deletingBlockIdsRef.current.has(blockId))
          return false;
        const owner = latestSession.blocks.find((block) => block.id === blockId);
        if (!owner || owner.archived) return false;
        const isOpeningOrReplacing = patch.sidebar.open === true || patch.sidebar.blockId !== undefined;
        return !isOpeningOrReplacing || isSidebarEligibleBlock(sessionId, owner);
      };
      // Do not let a stale click or queued resize reopen the sidebar for a
      // block that is being removed or no longer belongs to this session.
      if (!isSidebarPatchAllowed()) return Promise.resolve();
      const requestVersion = (viewWriteVersionRef.current[sessionId] || 0) + 1;
      viewWriteVersionRef.current[sessionId] = requestVersion;
      const confirmedLoad = loadSessionView(sessionId);
      if (patch.sidebar !== undefined) {
        for (const blockId of movingBlockIds) disposeMountedBlockTerminal(blockId);
      }
      viewBySessionRef.current = { ...viewBySessionRef.current, [sessionId]: optimistic };
      setViewBySession((items) => ({ ...items, [sessionId]: optimistic }));
      syncNextConnectionCache(sessionId, getBlockTermViewNextConnection(optimistic, session));

      // Keep requests for one terminal in order. Version checks protect the
      // optimistic UI from stale responses, while this queue also prevents a
      // slower earlier PATCH from becoming the server's final state.
      const previousWrite = viewWriteChainsRef.current[sessionId] || Promise.resolve();
      const request = queueBlockTermViewWriteAfterLoad(previousWrite, confirmedLoad, async () => {
        const isCurrentRequest = () =>
          isBlockTermViewScopeCurrent(scopeGeneration, scopeGenerationRef.current) &&
          sessionsRef.current.some((session) => session.id === sessionId);
        if (!isCurrentRequest()) return;
        if (!isSidebarPatchAllowed()) return;
        try {
          const { view } = await blockTermViewApi.patchView(sessionId, patch);
          if (!isCurrentRequest()) return;
          const confirmed =
            confirmedViewGenerationRef.current[sessionId] === scopeGeneration
              ? confirmedViewBySessionRef.current[sessionId]
              : previous;
          const resolution = resolveBlockTermViewWrite(
            viewBySessionRef.current[sessionId] || optimistic,
            confirmed || previous,
            { ok: true, view },
            viewWriteVersionRef.current[sessionId] === requestVersion
          );
          confirmedViewBySessionRef.current = {
            ...confirmedViewBySessionRef.current,
            [sessionId]: resolution.confirmed,
          };
          confirmedViewGenerationRef.current = {
            ...confirmedViewGenerationRef.current,
            [sessionId]: scopeGeneration,
          };
          const latestSession = sessionsRef.current.find((item) => item.id === sessionId);
          if (viewWriteVersionRef.current[sessionId] !== requestVersion) return;
          viewBySessionRef.current = { ...viewBySessionRef.current, [sessionId]: resolution.visible };
          if (latestSession)
            syncNextConnectionCache(sessionId, getBlockTermViewNextConnection(resolution.visible, latestSession));
          setViewBySession((items) => (isCurrentRequest() ? { ...items, [sessionId]: resolution.visible } : items));
        } catch (error) {
          if (!isCurrentRequest()) return;
          const confirmed =
            confirmedViewGenerationRef.current[sessionId] === scopeGeneration
              ? confirmedViewBySessionRef.current[sessionId]
              : previous;
          const resolution = resolveBlockTermViewWrite(
            viewBySessionRef.current[sessionId] || optimistic,
            confirmed || previous,
            { ok: false },
            viewWriteVersionRef.current[sessionId] === requestVersion
          );
          confirmedViewBySessionRef.current = {
            ...confirmedViewBySessionRef.current,
            [sessionId]: resolution.confirmed,
          };
          confirmedViewGenerationRef.current = {
            ...confirmedViewGenerationRef.current,
            [sessionId]: scopeGeneration,
          };
          if (viewWriteVersionRef.current[sessionId] !== requestVersion) return;
          viewBySessionRef.current = { ...viewBySessionRef.current, [sessionId]: resolution.visible };
          const latestSession = sessionsRef.current.find((item) => item.id === sessionId);
          if (latestSession)
            syncNextConnectionCache(sessionId, getBlockTermViewNextConnection(resolution.visible, latestSession));
          setViewBySession((items) => (isCurrentRequest() ? { ...items, [sessionId]: resolution.visible } : items));
          toast.error(error instanceof Error ? error.message : t("plugin.blockTerm.sidebarUpdateFailed"));
        }
      });
      const settled = request.then(
        () => {},
        () => {}
      );
      viewWriteChainsRef.current[sessionId] = settled;
      void settled.finally(() => {
        if (viewWriteChainsRef.current[sessionId] === settled) delete viewWriteChainsRef.current[sessionId];
      });
      return request;
    },
    [disposeMountedBlockTerminal, isSidebarEligibleBlock, loadSessionView, syncNextConnectionCache, t]
  );
  patchSessionViewRef.current = patchSessionView;

  const moveBlockToSidebar = useCallback(
    (sessionId: string, blockId: string) => {
      closeLineAI(sessionId);
      const current = viewBySessionRef.current[sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
      const movingBlockIds = [blockId];
      if (current.sidebar.open && current.sidebar.blockId && current.sidebar.blockId !== blockId) {
        movingBlockIds.push(current.sidebar.blockId);
      }
      void patchSessionView(sessionId, { sidebar: { open: true, blockId } }, movingBlockIds);
    },
    [closeLineAI, patchSessionView]
  );

  const moveBlockToMain = useCallback(
    (sessionId: string, blockId: string) => {
      void patchSessionView(sessionId, { sidebar: { open: false, blockId: null } }, [blockId]);
    },
    [patchSessionView]
  );

  const setSidebarOpen = useCallback(
    (sessionId: string, open: boolean) => {
      const current = viewBySessionRef.current[sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
      if (!open) {
        const ownerId = current.sidebar.blockId;
        void patchSessionView(sessionId, { sidebar: { open: false } }, ownerId ? [ownerId] : []);
        return;
      }
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const selected = session?.blocks.find((block) => block.id === session.selectedBlockId) || null;
      const blockId = current.sidebar.blockId || selected?.id || null;
      if (!blockId) return;
      const owner = session?.blocks.find((block) => block.id === blockId);
      if (!owner || !isSidebarEligibleBlock(sessionId, owner)) return;
      closeLineAI(sessionId);
      void patchSessionView(sessionId, { sidebar: { open: true, blockId } }, [blockId]);
    },
    [closeLineAI, isSidebarEligibleBlock, patchSessionView]
  );

  const switchBlockRenderer = useCallback(
    (sessionId: string, block: BlockTermBlock, renderer: BlockTermRendererSelection) => {
      const resolution = resolveBlockTermRendererSwitch(block, renderer);
      if (!resolution.ok) {
        toast.error(t("plugin.blockTerm.rendererSwitchFailed"));
        return;
      }
      clearBlockTermRendererCache(block.id);
      disposeMountedBlockTerminal(block.id);
      updateBlockState(sessionId, block.id, resolution.patch);
    },
    [disposeMountedBlockTerminal, t, updateBlockState]
  );

  const setSidebarWidth = useCallback(
    (sessionId: string, width: string) => {
      void patchSessionView(sessionId, { sidebar: { width } });
    },
    [patchSessionView]
  );

  const handleSidebarResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, sessionId: string) => {
      const container = blockLayoutRef.current;
      if (!container) return;
      const ownerId = viewBySessionRef.current[sessionId]?.sidebar.blockId;
      if (ownerId && deletingBlockIdsRef.current.has(ownerId)) return;
      const rect = container.getBoundingClientRect();
      sidebarDragRef.current = {
        sessionId,
        containerLeft: rect.left,
        containerWidth: rect.width,
        initialWidth: legalizedActiveView.sidebar.width,
        lastWidth: `${resolveBlockTermSidebarWidth(rect.width, legalizedActiveView.sidebar.width)}px`,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setSidebarDragging(true);
      event.preventDefault();
    },
    [legalizedActiveView.sidebar.width]
  );

  const handleSidebarResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    const ownerId = viewBySessionRef.current[drag.sessionId]?.sidebar.blockId;
    if (ownerId && deletingBlockIdsRef.current.has(ownerId)) return;
    const requested = Math.max(200, Math.min(4000, drag.containerLeft + drag.containerWidth - event.clientX));
    const width = `${resolveBlockTermSidebarWidth(drag.containerWidth, `${Math.round(requested)}px`)}px`;
    drag.lastWidth = width;
    const current = viewBySessionRef.current[drag.sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
    const next = setBlockTermSidebarState(current, { width });
    viewBySessionRef.current = { ...viewBySessionRef.current, [drag.sessionId]: next };
    setViewBySession((items) => ({ ...items, [drag.sessionId]: next }));
  }, []);

  const handleSidebarResizeEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = sidebarDragRef.current;
      if (!drag) return;
      sidebarDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      setSidebarDragging(false);
      const ownerId = viewBySessionRef.current[drag.sessionId]?.sidebar.blockId;
      if (ownerId && deletingBlockIdsRef.current.has(ownerId)) {
        const current = viewBySessionRef.current[drag.sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
        const restored = setBlockTermSidebarState(current, { width: drag.initialWidth });
        viewBySessionRef.current = { ...viewBySessionRef.current, [drag.sessionId]: restored };
        setViewBySession((items) => ({ ...items, [drag.sessionId]: restored }));
        return;
      }
      setSidebarWidth(drag.sessionId, drag.lastWidth);
    },
    [setSidebarWidth]
  );

  const measureBlockElement = useCallback(
    (element: HTMLDivElement | null, sessionId: string, block: BlockTermBlock) => {
      if (!element) return;
      blockVirtualizer.measureElement(element);

      // WaveTerm persists the measured line presentation so a restored screen
      // starts near its previous layout before the browser finishes measuring.
      // Running blocks are intentionally excluded because their output height
      // changes continuously while the command is producing bytes.
      if (isActiveBlockStatus(block.status) || block.collapsed) return;
      const measuredHeight = Math.ceil(element.getBoundingClientRect().height || element.offsetHeight);
      if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;
      const persistedHeight = getBlockTermPresentationHeight(block.presentationJson);
      const pendingHeight = presentationHeightPendingRef.current.get(block.id);
      if (
        (persistedHeight !== null && Math.abs(persistedHeight - measuredHeight) <= 1) ||
        (pendingHeight !== undefined && Math.abs(pendingHeight - measuredHeight) <= 1)
      )
        return;
      presentationHeightPendingRef.current.set(block.id, measuredHeight);
      const previousTimer = presentationHeightTimersRef.current.get(block.id);
      if (previousTimer) clearTimeout(previousTimer);
      const timer = setTimeout(() => {
        presentationHeightTimersRef.current.delete(block.id);
        const latestHeight = presentationHeightPendingRef.current.get(block.id);
        presentationHeightPendingRef.current.delete(block.id);
        if (latestHeight === undefined) return;
        const current = sessionsRef.current
          .find((session) => session.id === sessionId)
          ?.blocks.find((item) => item.id === block.id);
        if (!current || isActiveBlockStatus(current.status) || current.collapsed) return;
        const currentHeight = getBlockTermPresentationHeight(current.presentationJson);
        if (currentHeight !== null && Math.abs(currentHeight - latestHeight) <= 1) return;
        updateBlockState(sessionId, block.id, {
          presentationJson: setBlockTermPresentationHeight(current.presentationJson, latestHeight),
        });
      }, 300);
      presentationHeightTimersRef.current.set(block.id, timer);
    },
    [blockVirtualizer, updateBlockState]
  );

  const toggleBlockArchived = useCallback(
    (sessionId: string, blockId: string, archived: boolean) => {
      if (deletingBlockIdsRef.current.has(blockId)) return;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const nextFocusBlockId = session
        ? getBlockMutationFocusTarget(
            session.blocks,
            showArchivedRef.current,
            blockId,
            { archived },
            {
              runningOnly: showRunningOnlyRef.current,
              starredOnly: showStarredOnlyRef.current,
            }
          )
        : null;
      if (archived && viewBySessionRef.current[sessionId]?.sidebar.blockId === blockId) {
        void patchSessionView(sessionId, { sidebar: { open: false, blockId: null } }, [blockId]);
      }
      if (archived && lineAIViewBySessionRef.current[sessionId]?.sourceBlockId === blockId) {
        closeLineAI(sessionId);
      }
      updateBlockState(sessionId, blockId, { archived });
      if (nextFocusBlockId) focusBlock(nextFocusBlockId);
    },
    [closeLineAI, focusBlock, patchSessionView, updateBlockState]
  );

  useEffect(() => {
    if (!activeSession || !activeViewNeedsLegalization) return;
    const sessionId = activeSession.id;
    const previousOwner = activeView.sidebar.blockId;
    void patchSessionView(sessionId, { sidebar: { open: false, blockId: null } }, previousOwner ? [previousOwner] : []);
  }, [activeSession, activeView.sidebar.blockId, activeViewNeedsLegalization, patchSessionView]);

  const toggleBlockPinned = useCallback(
    (sessionId: string, blockId: string, pinned: boolean) => {
      if (deletingBlockIdsRef.current.has(blockId)) return;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const nextFocusBlockId = session
        ? getBlockMutationFocusTarget(
            session.blocks,
            showArchivedRef.current,
            blockId,
            { pinned },
            {
              runningOnly: showRunningOnlyRef.current,
              starredOnly: showStarredOnlyRef.current,
            }
          )
        : null;
      updateBlockState(sessionId, blockId, { pinned });
      if (nextFocusBlockId) focusBlock(nextFocusBlockId);
    },
    [focusBlock, updateBlockState]
  );

  const toggleArchivedVisibility = useCallback(() => {
    const nextShowArchived = !showArchived;
    const active = sessionsRef.current.find((session) => session.id === activeSessionId);
    const activeNextSelection = active
      ? resolveVisibleBlockSelection(
          getVisibleBlocks(active.blocks, showArchived),
          getVisibleBlocks(active.blocks, nextShowArchived),
          active.selectedBlockId
        )
      : null;
    setSessions((items) =>
      items.map((session) => ({
        ...session,
        selectedBlockId: resolveVisibleBlockSelection(
          getVisibleBlocks(session.blocks, showArchived),
          getVisibleBlocks(session.blocks, nextShowArchived),
          session.selectedBlockId
        ),
      }))
    );
    setShowArchived(nextShowArchived);
    if (active?.selectedBlockId && activeNextSelection && active.selectedBlockId !== activeNextSelection) {
      focusBlock(activeNextSelection);
    }
  }, [activeSessionId, focusBlock, getVisibleBlocks, showArchived]);

  const applyBlockFilters = useCallback(
    (nextRunningOnly: boolean, nextStarredOnly: boolean) => {
      const active = sessionsRef.current.find((session) => session.id === activeSessionId);
      const activeNextSelection = active
        ? resolveVisibleBlockSelection(
            getVisibleBlocks(active.blocks, showArchived, showRunningOnly, showStarredOnly),
            getVisibleBlocks(active.blocks, showArchived, nextRunningOnly, nextStarredOnly),
            active.selectedBlockId
          )
        : null;
      setSessions((items) =>
        items.map((session) => ({
          ...session,
          selectedBlockId: resolveVisibleBlockSelection(
            getVisibleBlocks(session.blocks, showArchived, showRunningOnly, showStarredOnly),
            getVisibleBlocks(session.blocks, showArchived, nextRunningOnly, nextStarredOnly),
            session.selectedBlockId
          ),
        }))
      );
      setShowRunningOnly(nextRunningOnly);
      setShowStarredOnly(nextStarredOnly);
      if (active?.selectedBlockId && activeNextSelection && active.selectedBlockId !== activeNextSelection) {
        focusBlock(activeNextSelection);
      }
    },
    [activeSessionId, focusBlock, getVisibleBlocks, showArchived, showRunningOnly, showStarredOnly]
  );

  const getCurrentCommandSession = useCallback(
    (
      sessionId: string,
      expectedScopeGeneration: number,
      expectedWorkspaceRevision: number,
      expectedWorkspaceSessionId: string | null
    ): BlockTermSession | null => {
      if (
        scopeGenerationRef.current !== expectedScopeGeneration ||
        !isCurrentWorkspaceTransition(expectedWorkspaceRevision, expectedWorkspaceSessionId, true) ||
        !useFrameStore.getState().groups.some((group) => group.id === groupId)
      )
        return null;
      return sessionsRef.current.find((session) => session.id === sessionId) || null;
    },
    [groupId]
  );

  const restoreBlockTermSignalFailure = useCallback(
    (sessionId: string, blockId: string, expectedToken?: string) => {
      const lifecycleFence = getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
      const binding = blockTokenRef.current[blockId];
      if (
        expectedToken !== undefined &&
        (!binding || binding.sessionId !== sessionId || binding.token !== expectedToken)
      ) {
        return;
      }
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const block = session?.blocks.find((item) => item.id === blockId);
      if (
        !session ||
        !block ||
        sessionActiveBlockRef.current[sessionId] !== blockId ||
        blockStatusRef.current[blockId] !== "interrupted"
      )
        return;
      if (
        getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId) !== lifecycleFence ||
        (expectedToken !== undefined &&
          (blockTokenRef.current[blockId]?.sessionId !== sessionId ||
            blockTokenRef.current[blockId]?.token !== expectedToken))
      ) {
        return;
      }

      stopSequencesRef.current.get(blockId)?.cancel();
      stopSequencesRef.current.delete(blockId);
      interruptedBlocksRef.current.delete(blockId);
      if (interruptedOutputBlockRef.current[sessionId] === blockId) {
        interruptedOutputBlockRef.current[sessionId] = null;
      }
      bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
      blockStatusRef.current[blockId] = "running";
      sessionActiveBlockRef.current[sessionId] = blockId;
      outputStore.setPinned(blockId, "running", true);

      flushSync(() => {
        setSessions((items) =>
          items.map((item) => {
            if (item.id !== sessionId) return item;
            const blocks = item.blocks.map((candidate) => {
              if (candidate.id !== blockId) return candidate;
              const restored = { ...candidate, status: "running" as const, exitCode: null };
              delete restored.afterStateJson;
              delete restored.finishedAt;
              return restored;
            });
            return {
              ...item,
              status: "running" as const,
              activeBlockId: blockId,
              shellState: "running-command",
              lastCommand: block.command || item.lastCommand,
              lastCommandExitCode: null,
              blocks,
            };
          })
        );
      });
      persistBlockPatch(blockId, {
        status: "running",
        exitCode: null,
        afterStateJson: "",
        finishedAt: null,
      });
      queueRuntimeInfoUpdate(sessionId, {
        current_cwd: session.cwd,
        shell_state: "running-command",
        shell_integration: session.shellIntegration,
        last_command: block.command || session.lastCommand,
        last_command_exit_code: null,
      });
      const runtime = runtimesRef.current.get(sessionId);
      if (runtime?.scopeGeneration === scopeGenerationRef.current) {
        startProcessIdentityTracker(sessionId, blockId, runtime.scopeGeneration);
      }
    },
    [outputStore, persistBlockPatch, queueRuntimeInfoUpdate, startProcessIdentityTracker]
  );

  restoreBlockTermSignalFailureRef.current = restoreBlockTermSignalFailure;

  const markCreatedBlockInterrupted = useCallback(
    async (
      sessionId: string,
      blockId: string,
      expectedToken?: string,
      expectedFence?: number,
      creationContext?: BlockTermCreatedBlockContext
    ) => {
      const lifecycleFence = expectedFence ?? getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
      const isDetachedCreationCandidate = (): boolean => {
        if (!creationContext || expectedToken === undefined || expectedFence === undefined) return false;
        if (getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId) !== lifecycleFence) return false;
        if (deletedBlockIdsRef.current.has(blockId)) return false;
        return true;
      };
      const isCurrentCandidate = (): boolean => {
        if (getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId) !== lifecycleFence) return false;
        const currentSession = sessionsRef.current.find((item) => item.id === sessionId);
        const currentBlock = currentSession?.blocks.find((item) => item.id === blockId);
        // A create request can commit just before a workspace reset clears the
        // session projection. The closure carrying the exact token/fence is
        // then the only remaining proof that this detached row is ours.
        if (!currentSession || !currentBlock || currentBlock.terminalId !== sessionId) {
          return isDetachedCreationCandidate();
        }
        const currentStatus = blockStatusRef.current[blockId] ?? currentBlock.status;
        if (currentStatus !== "running" && !(expectedToken !== undefined && currentStatus === "interrupted"))
          return false;

        const currentBinding = blockTokenRef.current[blockId];
        if (expectedToken !== undefined) {
          if (!currentBinding || currentBinding.sessionId !== sessionId || currentBinding.token !== expectedToken) {
            return false;
          }
        } else if (currentBinding) {
          // An untagged async failure belongs only to a command that never
          // acquired a lifecycle token. It must not consume a newer binding.
          return false;
        }

        const transitionBinding = runtimesRef.current.get(sessionId)?.transitionPrimaryBinding;
        const isTransitionOwner =
          expectedToken !== undefined &&
          transitionBinding?.blockId === blockId &&
          transitionBinding.blockToken === expectedToken;
        const isUnsentOwner =
          expectedToken !== undefined &&
          currentBinding?.sessionId === sessionId &&
          currentBinding.token === expectedToken &&
          currentStatus === "interrupted";
        return sessionActiveBlockRef.current[sessionId] === blockId || isTransitionOwner || isUnsentOwner;
      };
      if (!isCurrentCandidate()) return;
      const finishedAt = Date.now();
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const interruptionState = session
        ? resolveBlockTermInterruptedState({
            session,
            blockId,
            activeBlockId: sessionActiveBlockRef.current[sessionId],
            phase: "not-sent",
          })
        : null;
      const afterStateJson = creationContext?.afterStateJson ?? interruptionState?.afterStateJson;
      const patch: Parameters<typeof blockTermApi.update>[1] = {
        status: "interrupted",
        exitCode: null,
        finishedAt,
        ...(afterStateJson !== undefined ? { afterStateJson } : {}),
      };
      if (!isCurrentCandidate()) return;
      const restartTransition = blockRestartTransitionRef.current[blockId];
      const ownsRestartTransition =
        expectedToken !== undefined &&
        restartTransition?.sessionId === sessionId &&
        restartTransition.token === expectedToken &&
        restartTransition.fence === lifecycleFence;
      const writeFence = bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
      const detachedWrite = Boolean(creationContext);
      blockStatusRef.current[blockId] = "interrupted";
      if (ownsRestartTransition) delete blockRestartTransitionRef.current[blockId];
      delete blockTokenRef.current[blockId];
      delete blockOutputPhaseRef.current[blockId];
      cancelProcessIdentityTracker(sessionId, blockId);
      outputStore.setPinned(blockId, "running", false);
      interruptedBlocksRef.current.delete(blockId);
      if (sessionActiveBlockRef.current[sessionId] === blockId) sessionActiveBlockRef.current[sessionId] = null;
      if (interruptedOutputBlockRef.current[sessionId] === blockId) interruptedOutputBlockRef.current[sessionId] = null;
      if (sessionsRef.current.some((session) => session.id === sessionId)) {
        setSessions((items) =>
          items.map((session) => {
            if (session.id !== sessionId) return session;
            const blocks = session.blocks.map((block) =>
              block.id === blockId
                ? { ...block, status: "interrupted" as const, exitCode: null, afterStateJson, finishedAt }
                : block
            );
            return {
              ...session,
              ...interruptionState?.sessionPatch,
              blocks,
              selectedBlockId: resolveVisibleBlockSelection(
                getVisibleBlocks(session.blocks),
                getVisibleBlocks(blocks),
                session.selectedBlockId
              ),
            };
          })
        );
      }
      if (interruptionState?.runtimePatch) queueRuntimeInfoUpdate(sessionId, interruptionState.runtimePatch);
      try {
        await enqueueBlockWrite(blockId, async () => {
          if (
            getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId) !== writeFence ||
            (blockStatusRef.current[blockId] !== "interrupted" && !detachedWrite)
          )
            return;
          await blockTermApi.update(blockId, patch);
        });
      } catch {
        if (
          getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId) !== writeFence ||
          (blockStatusRef.current[blockId] !== "interrupted" && !detachedWrite)
        )
          return;
        const pendingPatch = persistPatchRef.current.get(blockId) || {};
        persistPatchRef.current.set(blockId, mergeFailedBlockPatch(patch, pendingPatch));
      }
    },
    [cancelProcessIdentityTracker, enqueueBlockWrite, getVisibleBlocks, outputStore, queueRuntimeInfoUpdate]
  );

  markCreatedBlockInterruptedRef.current = markCreatedBlockInterrupted;

  const discardFailedBlockCreate = useCallback(
    (blockId: string) => {
      const binding = blockTokenRef.current[blockId];
      if (binding) forgetBlockTermRuntimeBinding(binding.sessionId, blockId, binding.token);
      const blockRuntime = blockRuntimesRef.current.get(blockId);
      if (blockRuntime) {
        blockRuntime.allowReconnect = false;
        if (blockRuntime.reconnectTimer !== null) clearTimeout(blockRuntime.reconnectTimer);
        blockRuntime.ws?.close();
        blockRuntimesRef.current.delete(blockId);
      }
      independentBlockIdsRef.current.delete(blockId);
      const timer = persistTimersRef.current.get(blockId);
      if (timer) clearTimeout(timer);
      persistTimersRef.current.delete(blockId);
      pendingBlockCreatesRef.current.delete(blockId);
      persistPatchRef.current.delete(blockId);
      persistOutputRef.current.delete(blockId);
      outputStore.delete(blockId);
      delete outputRef.current[blockId];
      delete terminalRawRef.current[blockId];
      delete modeRef.current[blockId];
      delete blockStatusRef.current[blockId];
      delete blockTokenRef.current[blockId];
      delete blockOutputPhaseRef.current[blockId];
      delete rawTargetCursorRef.current[blockId];
      delete rawAcknowledgedTargetCursorRef.current[blockId];
      delete blockCompletionCursorRef.current[blockId];
      interruptedBlocksRef.current.delete(blockId);
    },
    [outputStore]
  );

  const publishCreatedBlock = useCallback(
    (
      sessionId: string,
      command: string,
      block: BlockTermBlock,
      sessionPatch: Partial<Pick<BlockTermSession, "status" | "activeBlockId">> = {},
      submittedDraft = command
    ) => {
      captureBlockScrollBottomAnchor(sessionId);
      const recordHistory = shouldRecordBlockTermHistory(block.kind);
      if (recordHistory) historyLoadRequestRef.current[sessionId] = (historyLoadRequestRef.current[sessionId] || 0) + 1;
      setSessions((items) =>
        items.map((item) => {
          if (item.id !== sessionId) return item;
          const draftState = resolveDraftAfterCommandPublish(item, submittedDraft);
          const persistedMetadata = persistedBlockMetadataRef.current[block.id];
          const publishedBlock = persistedMetadata ? { ...block, ...persistedMetadata } : block;
          const blocks = [...item.blocks, publishedBlock];
          return {
            ...item,
            ...sessionPatch,
            ...draftState,
            selectedBlockId: resolveCreatedBlockSelection(
              getVisibleBlocks(item.blocks),
              getVisibleBlocks(blocks),
              item.selectedBlockId,
              publishedBlock.id
            ),
            history: recordHistory ? appendRecentCommand(item.history, command) : item.history,
            blocks,
          };
        })
      );
      setInputExpandedBySession((current) => (current[sessionId] ? { ...current, [sessionId]: false } : current));
    },
    [captureBlockScrollBottomAnchor, getVisibleBlocks]
  );

  const restartBlock = useCallback(
    async (sessionId: string, block: BlockTermBlock): Promise<void> => {
      closeCompletion();
      const blockId = block.id;
      const expectedScopeGeneration = scopeGenerationRef.current;
      const workspaceState = useSessionStore.getState();
      const expectedWorkspaceRevision = workspaceState.workspaceRevision;
      const expectedWorkspaceSessionId = workspaceState.currentSessionId;

      const resolveCandidate = () => {
        const session = getCurrentCommandSession(
          sessionId,
          expectedScopeGeneration,
          expectedWorkspaceRevision,
          expectedWorkspaceSessionId
        );
        const currentBlock = session?.blocks.find((item) => item.id === blockId);
        const status = currentBlock ? (blockStatusRef.current[blockId] ?? currentBlock.status) : undefined;
        if (
          !session ||
          session.status !== "ready" ||
          !currentBlock ||
          currentBlock.terminalId !== sessionId ||
          currentBlock.kind !== "command" ||
          currentBlock.renderer === "openai" ||
          (status !== undefined && isActiveBlockStatus(status)) ||
          deletingBlockIdsRef.current.has(blockId) ||
          deletedBlockIdsRef.current.has(blockId)
        ) {
          return null;
        }
        return { session, block: currentBlock };
      };

      try {
        await trackConcurrentSessionCommand(sessionCommandChainsRef.current, sessionId, async () => {
          let candidate = resolveCandidate();
          if (!candidate) return;

          await flushBlockPersistence([blockId]);
          candidate = resolveCandidate();
          if (!candidate) return;

          const localBinding = blockTokenRef.current[blockId];
          const persistedBinding = getBlockTermRuntimeBinding(sessionId, blockId);
          const previousToken =
            localBinding?.sessionId === sessionId ? localBinding.token : persistedBinding?.blockToken;
          if (previousToken) {
            await closeBlockRuntimeRef.current(sessionId, blockId, previousToken);
            if (blockTokenRef.current[blockId]?.token === previousToken) delete blockTokenRef.current[blockId];
            delete blockOutputPhaseRef.current[blockId];
            independentBlockIdsRef.current.delete(blockId);
          }

          candidate = resolveCandidate();
          if (!candidate) return;

          const connection = resolveBlockTermConnectionContext({
            block: candidate.block,
            session: candidate.session,
          });
          const mode: BlockMode = shouldUseTerminalMode(candidate.block.command) ? "terminal" : "text";
          const token = generateBlockTermToken();
          const fence = bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
          const transition: BlockTermRestartTransition = { sessionId, token, fence };
          blockRestartTransitionRef.current[blockId] = transition;
          const isExactTransition = (): boolean =>
            blockRestartTransitionRef.current[blockId] === transition &&
            getBlockTermLifecycleFence(blockLifecycleFenceRef, blockId) === fence;

          const input = {
            token,
            independentRuntime: true,
            mode,
            termCols: candidate.session.cols || DEFAULT_COLS,
            termRows: candidate.session.rows || DEFAULT_ROWS,
            termFlexRows: mode === "text",
            termMaxPtySize: BLOCKTERM_OUTPUT_MAX_BYTES,
            beforeStateJson: serializeBlockTermShellState(candidate.session, {
              cwd: candidate.block.cwd || ".",
              shellState: candidate.session.shellState || "ready",
            }),
          };

          const response = await enqueueBlockPersistence(
            blockWriteChainsRef.current,
            blockId,
            () => blockTermApi.restart(blockId, input),
            { attempts: 1 }
          );
          const restartedBlock = response.block;
          if (
            !isExactTransition() ||
            restartedBlock.id !== blockId ||
            restartedBlock.terminalId !== sessionId ||
            restartedBlock.kind !== "command" ||
            restartedBlock.status !== "running"
          ) {
            throw new Error("invalid independent restart response");
          }

          cancelBlockTermStopSequence(stopSequencesRef.current, blockId);
          cancelProcessIdentityTracker(sessionId, blockId);
          capturedProcessIdentityBlockIdsRef.current.delete(blockId);
          interruptedBlocksRef.current.delete(blockId);
          if (interruptedOutputBlockRef.current[sessionId] === blockId) {
            interruptedOutputBlockRef.current[sessionId] = null;
          }
          const persistTimer = persistTimersRef.current.get(blockId);
          if (persistTimer) clearTimeout(persistTimer);
          persistTimersRef.current.delete(blockId);
          persistPatchRef.current.delete(blockId);
          persistOutputRef.current.delete(blockId);
          delete rawTargetCursorRef.current[blockId];
          delete rawAcknowledgedTargetCursorRef.current[blockId];
          clearBlockTermRendererCache(blockId);

          outputRef.current[blockId] = "";
          terminalRawRef.current[blockId] = new Uint8Array();
          outputStore.hydrate(blockId, "", null);
          outputStore.setPinned(blockId, "running", true);
          modeRef.current[blockId] = restartedBlock.mode;
          blockStatusRef.current[blockId] = "running";
          blockTokenRef.current[blockId] = { sessionId, token };
          blockOutputPhaseRef.current[blockId] = { sessionId, phase: "expected" };
          independentBlockIdsRef.current.add(blockId);
          rememberBlockTermRuntimeBinding({ terminalId: sessionId, blockId, blockToken: token });

          const publishedBlock: BlockTermBlock = {
            ...candidate.block,
            ...restartedBlock,
            id: blockId,
            terminalId: sessionId,
            lineNum: candidate.block.lineNum,
            collapsed: candidate.block.collapsed,
            pinned: candidate.block.pinned,
            archived: candidate.block.archived,
            starred: candidate.block.starred,
            renderer: candidate.block.renderer,
            stateJson: candidate.block.stateJson,
            presentationJson: candidate.block.presentationJson,
            status: "running",
            output: "",
            outputSize: 0,
            outputCursor: null,
            exitCode: null,
          };
          flushSync(() => {
            setSessions((items) => {
              const next = items.map((item) =>
                item.id === sessionId
                  ? {
                      ...item,
                      lastCommand: publishedBlock.command || item.lastCommand,
                      lastCommandExitCode: null,
                      blocks: item.blocks.map((candidateBlock) =>
                        candidateBlock.id === blockId ? publishedBlock : candidateBlock
                      ),
                    }
                  : item
              );
              sessionsRef.current = next;
              return next;
            });
          });
          if (mode === "terminal" && shouldFullscreenTerminalMode()) setFullscreenBlockId(blockId);

          const terminalRuntime = xtermRefs.current.get(blockId);
          const previousRawSync = terminalRuntime?.rawSyncInFlight || null;
          if (terminalRuntime && !terminalRuntime.disposed) {
            if (terminalRuntime.rawSyncTimer !== null) clearTimeout(terminalRuntime.rawSyncTimer);
            terminalRuntime.rawSyncTimer = null;
            terminalRuntime.rawSyncPending = false;
            terminalRuntime.rawSyncController?.abort();
            terminalRuntime.rawSyncController = null;
            terminalRuntime.rawSyncInFlight = null;
            terminalRuntime.rawTargetCursor = null;
            resetRawSyncState(terminalRuntime);
            terminalRuntime.hasLiveWrites = true;
          }
          if (previousRawSync) await previousRawSync.catch(() => {});
          if (terminalRuntime && !terminalRuntime.disposed) {
            terminalRawRef.current[blockId] = new Uint8Array();
            await writeTerminalData(terminalRuntime, new Uint8Array(), true);
          }

          let runtimeInfo: Awaited<ReturnType<typeof blockTermApi.getRuntime>>["runtime"];
          try {
            runtimeInfo = (
              await blockTermApi.createRuntime({
                terminalId: sessionId,
                blockId,
                blockToken: token,
                runtimeType: connection.runtimeType,
                sshProfileId: connection.sshProfileId,
                cwd: restartedBlock.cwd || candidate.block.cwd || ".",
                cols: restartedBlock.termCols || input.termCols,
                rows: restartedBlock.termRows || input.termRows,
                command: restartedBlock.command,
              })
            ).runtime;
          } catch (createError) {
            try {
              runtimeInfo = (await blockTermApi.getRuntime(sessionId, blockId, token)).runtime;
            } catch {
              throw createError;
            }
          }

          if (!isExactTransition()) {
            await closeBlockRuntimeRef.current(sessionId, blockId, token).catch(() => {});
            return;
          }
          if (runtimeInfo.status === "running" || runtimeInfo.status === "streaming") {
            connectBlockRuntimeRef.current(sessionId, blockId, token, expectedScopeGeneration);
          } else {
            void reconcileBlockRuntimeRef.current(sessionId, blockId, token, expectedScopeGeneration);
          }
        });
      } catch (error) {
        const binding = blockTokenRef.current[blockId];
        if (
          binding?.sessionId === sessionId &&
          independentBlockIdsRef.current.has(blockId) &&
          blockStatusRef.current[blockId] === "running"
        ) {
          void reconcileBlockRuntimeRef.current(sessionId, blockId, binding.token, expectedScopeGeneration);
        }
        const message = error instanceof Error ? error.message : t("common.saveFailed");
        toast.error(message);
      }
    },
    [cancelProcessIdentityTracker, closeCompletion, flushBlockPersistence, getCurrentCommandSession, outputStore, t]
  );
  const runCommand = useCallback(
    async (sessionId: string, command: string, skipManagement = false, submittedDraft = command): Promise<void> => {
      closeCompletion();
      if (!skipManagement) {
        const management = parseBlockTermManagementCommand(command);
        if (management.kind !== "shell") {
          if (management.kind === "management" && management.commandName === "run") {
            void runCommandRef.current(sessionId, management.command || "", true, command);
          } else {
            managementCommandHandlerRef.current(sessionId, management);
          }
          return;
        }
      }
      const trimmed = command.trim();
      if (!trimmed) return;
      const expectedScopeGeneration = scopeGenerationRef.current;
      const workspaceState = useSessionStore.getState();
      const expectedWorkspaceRevision = workspaceState.workspaceRevision;
      const expectedWorkspaceSessionId = workspaceState.currentSessionId;

      try {
        await trackConcurrentSessionCommand(sessionCommandChainsRef.current, sessionId, async () => {
          const session = getCurrentCommandSession(
            sessionId,
            expectedScopeGeneration,
            expectedWorkspaceRevision,
            expectedWorkspaceSessionId
          );
          const noteCommand = parseBlockTermNoteCommand(command);
          if (noteCommand && !noteCommand.text) {
            toast.error(t("plugin.blockTerm.noteTextRequired"));
            return;
          }
          const rendererCommand = noteCommand
            ? { kind: "not-renderer" as const }
            : parseBlockTermRendererCommand(command);
          if (rendererCommand.kind === "error") {
            toast.error(rendererCommand.message);
            return;
          }
          const independentCommand = !noteCommand && rendererCommand.kind !== "renderer";
          if (
            !session ||
            session.status === "connecting" ||
            session.status === "exited" ||
            session.status === "closed" ||
            (!independentCommand && session.status !== "ready")
          )
            return;
          const activeBlockId = sessionActiveBlockRef.current[sessionId];
          if (!independentCommand && activeBlockId && blockStatusRef.current[activeBlockId] === "running") return;
          const runtime = runtimesRef.current.get(sessionId);
          if (
            !independentCommand &&
            rendererCommand.kind !== "renderer" &&
            (!runtime ||
              runtime.scopeGeneration !== expectedScopeGeneration ||
              runtime.ws?.readyState !== WebSocket.OPEN)
          )
            return;

          const connection = resolveSessionConnectionContext(session);
          const blockCwd = resolveBlockTermConnectionCwd({ connection, current: session });
          const blockId = generateId();
          const lineNum = Math.max(nextLineNumRef.current[sessionId] || 0, nextBlockLineNum(session.blocks));
          const startedAt = Date.now();
          const commandMode: BlockMode = shouldUseTerminalMode(trimmed) ? "terminal" : "text";
          const commandLifecycle = {
            termCols: session.cols || DEFAULT_COLS,
            termRows: session.rows || DEFAULT_ROWS,
            termFlexRows: commandMode === "text",
            termMaxPtySize: BLOCKTERM_OUTPUT_MAX_BYTES,
            beforeStateJson: serializeBlockTermShellState(session, {
              cwd: blockCwd,
              shellState: session.shellState || "ready",
            }),
          };
          nextLineNumRef.current[sessionId] = lineNum + 1;
          deletedBlockIdsRef.current.delete(blockId);
          delete rawTargetCursorRef.current[blockId];
          delete rawAcknowledgedTargetCursorRef.current[blockId];
          delete blockCompletionCursorRef.current[blockId];

          const renderer = rendererCommand.kind === "renderer" ? rendererCommand : null;
          const createInput: Parameters<typeof blockTermApi.create>[0] = noteCommand
            ? {
                id: blockId,
                terminalId: sessionId,
                lineNum,
                kind: "note",
                command: "",
                text: noteCommand.text,
                cwd: blockCwd,
                ...connection,
                status: "success",
                mode: "text",
                output: "",
                exitCode: 0,
                startedAt,
                finishedAt: startedAt,
              }
            : renderer
              ? {
                  id: blockId,
                  terminalId: sessionId,
                  lineNum,
                  command,
                  cwd: blockCwd,
                  ...connection,
                  status: renderer.renderer === "openai" ? "streaming" : "success",
                  mode: "text",
                  text: renderer.renderer === "openai" ? renderer.output : "",
                  output: renderer.renderer === "openai" ? "" : renderer.output,
                  exitCode: 0,
                  startedAt,
                  finishedAt: startedAt,
                  renderer: renderer.renderer,
                  stateJson: renderer.stateJson,
                  kind: "renderer",
                }
              : {
                  id: blockId,
                  terminalId: sessionId,
                  lineNum,
                  command,
                  cwd: blockCwd,
                  ...connection,
                  status: "running",
                  mode: commandMode,
                  output: "",
                  startedAt,
                  ...commandLifecycle,
                };

          if (noteCommand) {
            try {
              await createBlockRecord(createInput);
            } catch (error) {
              discardFailedBlockCreate(blockId);
              const message = error instanceof Error ? error.message : t("common.saveFailed");
              toast.error(`${t("common.saveFailed")}: ${message}`);
              return;
            }
            const currentSession = getCurrentCommandSession(
              sessionId,
              expectedScopeGeneration,
              expectedWorkspaceRevision,
              expectedWorkspaceSessionId
            );
            if (!currentSession) return;
            outputStore.hydrate(blockId, "", null);
            modeRef.current[blockId] = "text";
            blockStatusRef.current[blockId] = "success";
            interruptedBlocksRef.current.delete(blockId);
            publishCreatedBlock(
              sessionId,
              command,
              {
                ...createBlockState({
                  id: blockId,
                  command: "",
                  text: noteCommand.text,
                  status: "success",
                  mode: "text",
                  cwd: createInput.cwd || ".",
                  createdAt: Date.now(),
                  ...connection,
                  terminalId: sessionId,
                  lineNum,
                  startedAt,
                  kind: "note",
                }),
                exitCode: 0,
                finishedAt: startedAt,
              },
              {},
              submittedDraft
            );
            requestAnimationFrame(() => {
              if (visibleOrderedBlocksRef.current.some((block) => block.id === blockId)) focusBlock(blockId);
            });
            return;
          }

          if (renderer) {
            let modelBlock: BlockTermBlock | null = null;
            try {
              if (renderer.renderer === "openai") {
                const rendererState = JSON.parse(renderer.stateJson) as { model?: unknown };
                // Model runs use the same per-block ordered/retrying write
                // chain as ordinary blocks. The stable ID makes a retry
                // idempotent when the server accepted the request but the
                // response was lost.
                modelBlock = await enqueueBlockWrite(blockId, async () => {
                  const response = await blockTermModelApi.create({
                    id: blockId,
                    terminalId: sessionId,
                    lineNum,
                    command,
                    currentCommand: session.lastCommand,
                    prompt: renderer.output,
                    cwd: blockCwd,
                    runtimeType: connection.runtimeType,
                    sshProfileId: connection.sshProfileId,
                    model: typeof rendererState.model === "string" ? rendererState.model : undefined,
                  });
                  return response.block;
                });
              } else {
                await createBlockRecord(createInput);
              }
            } catch (error) {
              discardFailedBlockCreate(blockId);
              if (renderer.renderer === "openai") {
                // A failed POST is ambiguous: the upstream request may have
                // started before the response was lost. Best-effort
                // cancellation and deletion prevent an orphaned run/block.
                await compensateUnconfirmedModelRun(blockId);
              }
              const message = error instanceof Error ? error.message : t("common.saveFailed");
              toast.error(`${t("common.saveFailed")}: ${message}`);
              return;
            }
            const currentSession = getCurrentCommandSession(
              sessionId,
              expectedScopeGeneration,
              expectedWorkspaceRevision,
              expectedWorkspaceSessionId
            );
            if (!currentSession) {
              if (renderer.renderer === "openai") {
                await compensateUnconfirmedModelRun(blockId);
              }
              return;
            }
            const publishedBlock = renderer.renderer === "openai" && modelBlock ? modelBlock : null;
            const publishedStatus =
              publishedBlock?.status || (renderer.renderer === "openai" ? "streaming" : "success");
            const publishedOutput = publishedBlock?.output ?? (renderer.renderer === "openai" ? "" : renderer.output);
            outputStore.hydrate(blockId, publishedOutput, null);
            outputStore.setPinned(blockId, "running", isActiveBlockStatus(publishedStatus));
            modeRef.current[blockId] = publishedBlock?.mode || "text";
            blockStatusRef.current[blockId] = publishedStatus;
            interruptedBlocksRef.current.delete(blockId);
            if (renderer.shouldFocus) {
              cancelSessionFocusRetry();
              pendingBlockFocusRef.current = null;
              sessionFocusTargetRef.current[sessionId] = {
                type: "block",
                blockId,
                area: "main",
                focus: renderer.renderer === "code" ? "editor" : "container",
              };
              pendingSessionFocusRef.current = { sessionId, mode: "restore" };
            }
            publishCreatedBlock(
              sessionId,
              command,
              {
                ...createBlockState({
                  id: blockId,
                  command,
                  status: publishedStatus,
                  mode: publishedBlock?.mode || "text",
                  cwd: createInput.cwd || ".",
                  createdAt: publishedBlock?.createdAt || startedAt,
                  runtimeType: publishedBlock?.runtimeType || connection.runtimeType,
                  sshProfileId: publishedBlock?.sshProfileId || connection.sshProfileId,
                  terminalId: sessionId,
                  lineNum,
                  startedAt,
                  kind: "renderer",
                  text: publishedBlock?.text || (renderer.renderer === "openai" ? renderer.output : ""),
                  output: publishedOutput,
                  renderer: renderer.renderer,
                  stateJson: renderer.stateJson,
                }),
                ...(publishedBlock?.exitCode !== undefined && publishedBlock?.exitCode !== null
                  ? { exitCode: publishedBlock.exitCode }
                  : renderer.renderer === "openai" && publishedStatus === "streaming"
                    ? {}
                    : { exitCode: 0 }),
                ...(publishedBlock?.finishedAt !== undefined
                  ? { finishedAt: publishedBlock.finishedAt }
                  : renderer.renderer === "openai" && publishedStatus === "streaming"
                    ? {}
                    : { finishedAt: startedAt }),
                ...(publishedBlock?.startedAt !== undefined ? { startedAt: publishedBlock.startedAt } : {}),
                ...(publishedBlock?.cwd ? { cwd: publishedBlock.cwd } : {}),
                ...(publishedBlock?.lineNum !== undefined ? { lineNum: publishedBlock.lineNum } : {}),
                ...(publishedBlock?.terminalId ? { terminalId: publishedBlock.terminalId } : {}),
                renderer: renderer.renderer,
                stateJson: publishedBlock?.stateJson || renderer.stateJson,
              },
              {},
              submittedDraft
            );
            if (!renderer.shouldFocus) {
              requestAnimationFrame(() => {
                const index = visibleOrderedBlocksRef.current.findIndex((block) => block.id === blockId);
                if (index < 0) return;
                blockVirtualizer.scrollToIndex(index, { align: "end", behavior: "smooth" });
              });
            }
            return;
          }

          const mode = createInput.mode || "text";
          const blockToken = generateBlockTermToken();
          // Arm the lifecycle identity before persistence/transport work. If
          // prepareSend or the socket write fails, the interrupt callback can
          // still prove that it belongs to this newly-created block.
          const commandLifecycleFence = bumpBlockTermLifecycleFence(blockLifecycleFenceRef, blockId);
          blockTokenRef.current[blockId] = { sessionId, token: blockToken };
          rememberBlockTermRuntimeBinding({ terminalId: sessionId, blockId, blockToken });
          // Register the independent ownership before any asynchronous create
          // or websocket attach. This fences parent-session replay/finalizers
          // and lets a fast child exit reconcile against its exact token.
          independentBlockIdsRef.current.add(blockId);
          let blockRuntimeCreated = false;
          let blockRuntimeCreateError: unknown;
          let localLifecyclePublished = false;
          const publishInterruptedBlock = () =>
            (() => {
              if (localLifecyclePublished) return;
              blockStatusRef.current[blockId] = "interrupted";
              flushSync(() =>
                publishCreatedBlock(
                  sessionId,
                  command,
                  createBlockState({
                    id: blockId,
                    command,
                    status: "interrupted",
                    mode,
                    cwd: createInput.cwd || ".",
                    createdAt: startedAt,
                    ...connection,
                    terminalId: sessionId,
                    lineNum,
                    startedAt,
                    ...commandLifecycle,
                  }),
                  {},
                  submittedDraft
                )
              );
            })();
          try {
            await persistThenSendCommand({
              persist: async () => {
                await createBlockRecord(createInput);
                const previousInterruptedBlockId = interruptedOutputBlockRef.current[sessionId];
                if (previousInterruptedBlockId && previousInterruptedBlockId !== blockId) {
                  // The replacement command owns the prompt immediately. Keep
                  // the interrupted block as the output tail, but cancel its
                  // delayed escalation before it can signal the new command.
                  cancelBlockTermStopSequence(stopSequencesRef.current, previousInterruptedBlockId);
                }

                // Publish the block before opening its independent runtime so
                // replay/state messages can be accepted immediately, including
                // output produced before the websocket attach completes.
                outputRef.current[blockId] = "";
                terminalRawRef.current[blockId] = new Uint8Array();
                outputStore.prime(blockId, 0, null);
                outputStore.setPinned(blockId, "running", true);
                modeRef.current[blockId] = mode;
                blockStatusRef.current[blockId] = "running";
                interruptedBlocksRef.current.delete(blockId);
                blockOutputPhaseRef.current[blockId] = { sessionId, phase: "expected" };
                localLifecyclePublished = true;
                flushSync(() => {
                  publishCreatedBlock(
                    sessionId,
                    command,
                    createBlockState({
                      id: blockId,
                      command,
                      status: "running",
                      mode,
                      cwd: createInput.cwd || ".",
                      createdAt: startedAt,
                      ...connection,
                      terminalId: sessionId,
                      lineNum,
                      startedAt,
                      ...commandLifecycle,
                    }),
                    {},
                    submittedDraft
                  );
                });
                try {
                  const createdRuntime = await blockTermApi.createRuntime({
                    terminalId: sessionId,
                    blockId,
                    blockToken,
                    runtimeType: connection.runtimeType,
                    sshProfileId: connection.sshProfileId,
                    cwd: createInput.cwd,
                    cols: createInput.termCols,
                    rows: createInput.termRows,
                    command,
                  });
                  blockRuntimeCreated = true;
                  const createdRuntimeActive =
                    createdRuntime.runtime.status === "running" || createdRuntime.runtime.status === "streaming";
                  if (!createdRuntimeActive) {
                    void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                  } else {
                    try {
                      const liveRuntime = await blockTermApi.getRuntime(sessionId, blockId, blockToken);
                      if (liveRuntime.runtime.status === "running" || liveRuntime.runtime.status === "streaming") {
                        connectBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                      } else {
                        void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                      }
                    } catch (error) {
                      const status = getRequestErrorStatus(error);
                      if (status === 404 || status === 409) {
                        void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                      } else {
                        connectBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                      }
                    }
                  }
                } catch (error) {
                  try {
                    const runtime = await blockTermApi.getRuntime(sessionId, blockId, blockToken);
                    blockRuntimeCreated = true;
                    if (runtime.runtime.status === "running" || runtime.runtime.status === "streaming") {
                      connectBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                    } else {
                      void reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                    }
                  } catch {
                    blockRuntimeCreateError = error;
                  }
                }
              },
              prepareSend: () => {
                const currentSession = getCurrentCommandSession(
                  sessionId,
                  expectedScopeGeneration,
                  expectedWorkspaceRevision,
                  expectedWorkspaceSessionId
                );
                if (!currentSession) return false;
                const ownsPublishedLifecycle = localLifecyclePublished && blockStatusRef.current[blockId] === "running";
                if (
                  !ownsPublishedLifecycle &&
                  (currentSession.status === "connecting" ||
                    currentSession.status === "exited" ||
                    currentSession.status === "closed")
                ) {
                  publishInterruptedBlock();
                  return false;
                }

                if (!blockRuntimeCreated) {
                  publishInterruptedBlock();
                  return false;
                }

                if (localLifecyclePublished) return true;

                outputRef.current[blockId] = "";
                terminalRawRef.current[blockId] = new Uint8Array();
                outputStore.prime(blockId, 0, null);
                outputStore.setPinned(blockId, "running", true);
                modeRef.current[blockId] = mode;
                blockStatusRef.current[blockId] = "running";
                interruptedBlocksRef.current.delete(blockId);
                blockTokenRef.current[blockId] = { sessionId, token: blockToken };
                blockOutputPhaseRef.current[blockId] = { sessionId, phase: "expected" };
                if (mode === "terminal" && shouldFullscreenTerminalMode()) setFullscreenBlockId(blockId);
                flushSync(() => {
                  publishCreatedBlock(
                    sessionId,
                    command,
                    createBlockState({
                      id: blockId,
                      command,
                      status: "running",
                      mode,
                      cwd: createInput.cwd || ".",
                      ...connection,
                      terminalId: sessionId,
                      lineNum,
                      startedAt,
                      ...commandLifecycle,
                    }),
                    {},
                    submittedDraft
                  );
                });
                return true;
              },
              // The wrapper was supplied as `initial_input` when the runtime
              // was created. Do not send it through the parent session route.
              send: () => blockRuntimeCreated,
              interrupt: async () => {
                if (blockRuntimeCreated) {
                  await closeBlockRuntimeRef.current(sessionId, blockId, blockToken).catch(() => {});
                  await reconcileBlockRuntimeRef.current(sessionId, blockId, blockToken, expectedScopeGeneration);
                  return;
                }
                forgetBlockTermRuntimeBinding(sessionId, blockId, blockToken);
                await markCreatedBlockInterrupted(sessionId, blockId, blockToken, commandLifecycleFence, {
                  afterStateJson: createInput.beforeStateJson,
                });
                independentBlockIdsRef.current.delete(blockId);
              },
            });
          } catch (error) {
            discardFailedBlockCreate(blockId);
            const message = error instanceof Error ? error.message : t("common.saveFailed");
            toast.error(`${t("common.saveFailed")}: ${message}`);
          }
          if (blockRuntimeCreateError) {
            const message =
              blockRuntimeCreateError instanceof Error ? blockRuntimeCreateError.message : t("common.saveFailed");
            toast.error(`${t("common.saveFailed")}: ${message}`);
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : t("common.saveFailed");
        toast.error(message);
      }
    },
    [
      closeCompletion,
      blockVirtualizer,
      cancelBlockTermStopSequence,
      cancelSessionFocusRetry,
      compensateUnconfirmedModelRun,
      createBlockRecord,
      discardFailedBlockCreate,
      enqueueBlockWrite,
      focusBlock,
      getCurrentCommandSession,
      markCreatedBlockInterrupted,
      outputStore,
      publishCreatedBlock,
      resolveSessionConnectionContext,
      sendInput,
      t,
    ]
  );
  runCommandRef.current = runCommand;

  const interruptSession = useCallback(
    (sessionId: string, expectedBlockId?: string, signals?: readonly BlockTermSignal[]): boolean => {
      const blockId = expectedBlockId || sessionActiveBlockRef.current[sessionId];
      if (!blockId) return false;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const blockToken = resolveBlockTermStopToken(sessionId, blockTokenRef.current[blockId]);
      const independent = independentBlockIdsRef.current.has(blockId) || blockRuntimesRef.current.has(blockId);
      if (independent) {
        const block = session?.blocks.find((item) => item.id === blockId);
        const blockRuntime = blockRuntimesRef.current.get(blockId);
        if (
          !session ||
          session.status === "connecting" ||
          session.status === "exited" ||
          session.status === "closed" ||
          !block ||
          block.terminalId !== sessionId ||
          blockStatusRef.current[blockId] !== "running" ||
          !blockToken ||
          !blockRuntime ||
          blockRuntime.sessionId !== sessionId ||
          blockRuntime.blockToken !== blockToken ||
          blockRuntime.scopeGeneration !== scopeGenerationRef.current
        )
          return false;
        const existingSequence = stopSequencesRef.current.get(blockId);
        if (existingSequence) {
          if (!signals && existingSequence.advance()) return true;
          existingSequence.cancel();
          stopSequencesRef.current.delete(blockId);
        }
        interruptedBlocksRef.current.add(blockId);
        if (!startStopSequence(sessionId, blockId, blockRuntime.scopeGeneration, signals)) {
          interruptedBlocksRef.current.delete(blockId);
          return false;
        }
        return true;
      }
      if (expectedBlockId !== undefined && sessionActiveBlockRef.current[sessionId] !== expectedBlockId) return false;
      if (
        !session ||
        session.status !== "running" ||
        session.activeBlockId !== blockId ||
        blockStatusRef.current[blockId] !== "running" ||
        !blockToken
      )
        return false;
      const existingSequence = stopSequencesRef.current.get(blockId);
      if (existingSequence) {
        if (!signals && existingSequence.advance()) return true;
        existingSequence.cancel();
        stopSequencesRef.current.delete(blockId);
      }
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime || runtime.scopeGeneration !== scopeGenerationRef.current) return false;
      cancelProcessIdentityTracker(sessionId, blockId);
      interruptedBlocksRef.current.add(blockId);
      // Keep routing the shell's Ctrl-C tail and OSC end frame to this block.
      // A later OSC start replaces the sink when a new command begins.
      interruptedOutputBlockRef.current[sessionId] = blockId;
      if (!startStopSequence(sessionId, blockId, runtime.scopeGeneration, signals)) {
        interruptedBlocksRef.current.delete(blockId);
        interruptedOutputBlockRef.current[sessionId] = null;
        return false;
      }
      const finishedAt = Date.now();
      const interruptionState = resolveBlockTermInterruptedState({
        session,
        blockId,
        activeBlockId: sessionActiveBlockRef.current[sessionId],
        command: session.blocks.find((block) => block.id === blockId)?.command,
        phase: "stop",
      });
      updateBlockState(sessionId, blockId, {
        status: "interrupted",
        exitCode: null,
        afterStateJson: interruptionState.afterStateJson,
        finishedAt,
      });
      setSessionPatch(sessionId, interruptionState.sessionPatch);
      if (interruptionState.runtimePatch) queueRuntimeInfoUpdate(sessionId, interruptionState.runtimePatch);
      return true;
    },
    [cancelProcessIdentityTracker, queueRuntimeInfoUpdate, setSessionPatch, startStopSequence, updateBlockState]
  );

  const stopSession = useCallback(
    (sessionId: string, blockId?: string) => {
      interruptSession(sessionId, blockId);
    },
    [interruptSession]
  );

  const stopModelRun = useCallback(
    async (blockId: string) => {
      try {
        await blockTermModelApi.cancel(blockId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("plugin.blockTerm.stopFailed"));
      }
    },
    [t]
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      const request = sessionCloseCoordinatorRef.current.begin(sessionId);
      if (!request) return;
      const expectedScopeGeneration = scopeGenerationRef.current;
      const workspaceState = useSessionStore.getState();
      const requestRevision = workspaceState.workspaceRevision;
      const requestSessionId = workspaceState.currentSessionId;
      const isCurrentCloseScope = () =>
        sessionCloseCoordinatorRef.current.isCurrent(request) &&
        scopeGenerationRef.current === expectedScopeGeneration &&
        isCurrentWorkspaceTransition(requestRevision, requestSessionId, true) &&
        useFrameStore.getState().groups.some((group) => group.id === groupId);
      const runClose = async () => {
        try {
          if (!isCurrentCloseScope()) return;
          let closingSession = sessionsRef.current.find((item) => item.id === sessionId);
          if (!closingSession) return;
          let closingBlocks = closingSession.blocks;
          if (persistedBlocksLoadedGenerationRef.current[sessionId] !== scopeGenerationRef.current) {
            const inventory = await loadPersistedBlocks(sessionId);
            if (!isCurrentCloseScope()) return;
            if (inventory.kind === "stale") return;
            if (inventory.kind === "failed") throw inventory.error;
            if (persistedBlocksLoadedGenerationRef.current[sessionId] !== scopeGenerationRef.current) return;
            closingSession = sessionsRef.current.find((item) => item.id === sessionId);
            if (!closingSession) return;
            const mergedBlocks = new Map(inventory.blocks.map((block) => [block.id, block]));
            for (const block of closingSession.blocks) mergedBlocks.set(block.id, block);
            closingBlocks = [...mergedBlocks.values()];
          }
          if (shouldConfirmBlockTermSessionClose(closingBlocks.length)) {
            const confirmed = await dialog.confirm(
              t("plugin.blockTerm.closeSessionConfirmTitle"),
              t("plugin.blockTerm.closeSessionConfirmMessage").replace("{count}", String(closingBlocks.length)),
              { confirmText: t("common.close"), confirmVariant: "danger", signal: request.controller.signal }
            );
            if (!confirmed || !isCurrentCloseScope()) return;
          }
          await enqueueWorkspaceMutation(async () => {
            // This guard is the close commit point. Workspace transitions queue
            // behind this mutation, so every step below must finish even if the
            // render scope resets while an awaited close operation is running.
            if (!isCurrentCloseScope()) return;

            const session = sessionsRef.current.find((item) => item.id === sessionId);
            if (!session) return;
            const blockMap = new Map(closingBlocks.map((block) => [block.id, block]));
            for (const block of session.blocks) blockMap.set(block.id, block);
            const blocks = [...blockMap.values()];
            await closeIndependentBlockRuntimes(sessionId, new Set(blocks.map((block) => block.id)));
            await Promise.allSettled(
              blocks
                .filter((block) => block.renderer === "openai" && block.status === "streaming")
                .map((block) => blockTermModelApi.cancel(block.id))
            );
            const runtime = runtimesRef.current.get(sessionId);
            cancelProcessIdentityTracker(sessionId);
            flushTerminalParser(sessionId);
            if (runtime?.ws) {
              runtime.ws.onclose = null;
              runtime.ws.close();
            }
            runtimesRef.current.delete(sessionId);
            const timer = reconnectTimersRef.current.get(sessionId);
            if (timer) clearTimeout(timer);
            reconnectTimersRef.current.delete(sessionId);
            finalizeRunningBlocks(sessionId);
            setSessionPatch(sessionId, {
              status: "closed",
              activeBlockId: null,
              shellIntegration: false,
            });
            await commitBlockTermSessionClose({
              // A failed final write or terminal close must leave the session and
              // its output available so the user can retry the close operation.
              persist: () => flushBlockPersistence(blocks.map((block) => block.id)),
              closeTerminal: async () => {
                await terminalApi.close(sessionId);
              },
              cleanup: () => {
                sessionActiveBlockRef.current[sessionId] = null;
                interruptedOutputBlockRef.current[sessionId] = null;
                for (const block of blocks) {
                  clearBlockTermRendererCache(block.id);
                  const terminalRuntime = xtermRefs.current.get(block.id);
                  if (terminalRuntime) {
                    disposeTerminalRuntime(terminalRuntime);
                    xtermRefs.current.delete(block.id);
                  }
                  outputStore.delete(block.id);
                  delete modeRef.current[block.id];
                  delete blockTokenRef.current[block.id];
                  delete blockOutputPhaseRef.current[block.id];
                  delete blockRestartTransitionRef.current[block.id];
                  delete rawTargetCursorRef.current[block.id];
                  delete rawAcknowledgedTargetCursorRef.current[block.id];
                  delete blockCompletionCursorRef.current[block.id];
                  delete outputRef.current[block.id];
                  delete terminalRawRef.current[block.id];
                }
                setUnavailableModelStreams((current) => {
                  if (!blocks.some((block) => current.has(block.id))) return current;
                  const next = new Set(current);
                  for (const block of blocks) next.delete(block.id);
                  return next;
                });
                clearLineAIConversationForSession(sessionId);
                clearNextConnectionContext(sessionId);
                delete nextConnectionCwdWatermarkRef.current[sessionId];
                removeTerminal(groupId, sessionId);
                setInputExpandedBySession((current) => {
                  if (!(sessionId in current)) return current;
                  const next = { ...current };
                  delete next[sessionId];
                  return next;
                });
                const shouldActivateNext = activeSessionIdRef.current === sessionId;
                const nextSessionId = shouldActivateNext
                  ? resolveBlockTermSessionAfterClose(
                      sessionsRef.current.map((item) => item.id),
                      sessionId
                    )
                  : null;
                setSessions((items) => {
                  const next = items.filter((item) => item.id !== sessionId);
                  if (shouldActivateNext) {
                    const nextId =
                      nextSessionId && next.some((item) => item.id === nextSessionId)
                        ? nextSessionId
                        : next[0]?.id || null;
                    cancelSessionFocusRetry();
                    pendingBlockFocusRef.current = null;
                    activeSessionIdRef.current = nextId;
                    pendingSessionFocusRef.current = nextId ? { sessionId: nextId, mode: "restore" } : null;
                    setActiveSessionId(nextId);
                    setActiveTerminalId(groupId, nextId);
                  }
                  return next;
                });
                delete sessionFocusTargetRef.current[sessionId];
              },
            });
          });
        } catch (error) {
          if (isCurrentCloseScope()) {
            const message = error instanceof Error ? error.message : t("common.saveFailed");
            toast.error(`${t("common.saveFailed")}: ${message}`);
          }
        }
      };
      await sessionCloseCoordinatorRef.current.run(request, runClose);
    },
    [
      cancelProcessIdentityTracker,
      cancelSessionFocusRetry,
      clearLineAIConversationForSession,
      clearNextConnectionContext,
      closeIndependentBlockRuntimes,
      dialog,
      finalizeRunningBlocks,
      flushBlockPersistence,
      flushTerminalParser,
      groupId,
      loadPersistedBlocks,
      outputStore,
      removeTerminal,
      setActiveTerminalId,
      setSessionPatch,
      t,
    ]
  );

  const deleteBlock = useCallback(
    (blockId: string, sessionId?: string): Promise<void> => {
      const currentSession = sessionsRef.current.find((session) => session.id === sessionId);
      const block = currentSession?.blocks.find((item) => item.id === blockId);
      if (!currentSession || !block || deletingBlockIdsRef.current.has(blockId)) return Promise.resolve();

      const deleteScopeGeneration = scopeGenerationRef.current;
      deletingBlockIdsRef.current.add(blockId);
      setDeletingBlockIds((current) => new Set(current).add(blockId));

      return confirmBlockTermDelete({
        // Existing queued writes remain ahead of DELETE. Suspend only the
        // debounce timer; pending data is discarded on success and retried on
        // failure, so an unrelated PATCH outage cannot block deletion.
        prepare: async () => {
          const persistTimer = persistTimersRef.current.get(blockId);
          if (persistTimer) clearTimeout(persistTimer);
          persistTimersRef.current.delete(blockId);
          const localBinding = blockTokenRef.current[blockId];
          const persistedBinding = getBlockTermRuntimeBinding(currentSession.id, blockId);
          const blockToken =
            localBinding?.sessionId === currentSession.id ? localBinding.token : persistedBinding?.blockToken;
          if (blockToken && (independentBlockIdsRef.current.has(blockId) || blockRuntimesRef.current.has(blockId))) {
            await closeBlockRuntimeRef.current(currentSession.id, blockId, blockToken);
          }
        },
        cancel:
          block.renderer === "openai" && block.status === "streaming"
            ? () => blockTermModelApi.cancel(blockId)
            : undefined,
        remove: () =>
          enqueueBlockWrite(blockId, async () => {
            try {
              await blockTermApi.remove(blockId);
            } catch (error) {
              // A successful DELETE whose response was lost is retried as 404.
              // The durable target state is already reached in that case.
              if (!isBlockTermDeleteAlreadyAppliedError(error)) throw error;
            }
          }),
        commit: () => {
          deletedBlockIdsRef.current.add(blockId);
          cancelBlockProcessIdentityTracker(blockId);
          capturedProcessIdentityBlockIdsRef.current.delete(blockId);
          clearBlockTermRendererCache(blockId);
          const persistTimer = persistTimersRef.current.get(blockId);
          if (persistTimer) clearTimeout(persistTimer);
          persistTimersRef.current.delete(blockId);
          persistPatchRef.current.delete(blockId);
          persistOutputRef.current.delete(blockId);
          pendingBlockCreatesRef.current.delete(blockId);
          delete outputRef.current[blockId];
          delete terminalRawRef.current[blockId];
          delete modeRef.current[blockId];
          delete blockStatusRef.current[blockId];
          delete blockTokenRef.current[blockId];
          independentBlockIdsRef.current.delete(blockId);
          forgetBlockTermRuntimeBinding(currentSession.id, blockId);
          delete blockOutputPhaseRef.current[blockId];
          delete blockRestartTransitionRef.current[blockId];
          delete rawTargetCursorRef.current[blockId];
          delete rawAcknowledgedTargetCursorRef.current[blockId];
          delete blockCompletionCursorRef.current[blockId];
          interruptedBlocksRef.current.delete(blockId);
          const runtime = xtermRefs.current.get(blockId);
          if (runtime) {
            disposeTerminalRuntime(runtime);
            xtermRefs.current.delete(blockId);
          }
          outputStore.delete(blockId);
          setUnavailableModelStreams((current) => {
            if (!current.has(blockId)) return current;
            const next = new Set(current);
            next.delete(blockId);
            return next;
          });
          setFullscreenBlockId((current) => (current === blockId ? null : current));
          if (sessionActiveBlockRef.current[currentSession.id] === blockId) {
            sessionActiveBlockRef.current[currentSession.id] = null;
          }
          if (interruptedOutputBlockRef.current[currentSession.id] === blockId) {
            interruptedOutputBlockRef.current[currentSession.id] = null;
          }
          if (lineAIViewBySessionRef.current[currentSession.id]?.sourceBlockId === blockId) {
            clearLineAIConversationForSession(currentSession.id);
          }

          const latestSession = sessionsRef.current.find((session) => session.id === currentSession.id);
          const remainingBlocks = latestSession?.blocks.filter((item) => item.id !== blockId) || [];
          const nextSelection = latestSession
            ? resolveVisibleBlockSelection(
                getVisibleBlocks(latestSession.blocks),
                getVisibleBlocks(remainingBlocks),
                latestSession.selectedBlockId
              )
            : null;
          const shouldFocusNext =
            activeSessionIdRef.current === currentSession.id && latestSession?.selectedBlockId === blockId;
          setSessions((items) =>
            items.map((session) => {
              if (session.id !== currentSession.id) return session;
              const blocks = session.blocks.filter((item) => item.id !== blockId);
              return {
                ...session,
                blocks,
                selectedBlockId: resolveVisibleBlockSelection(
                  getVisibleBlocks(session.blocks),
                  getVisibleBlocks(blocks),
                  session.selectedBlockId
                ),
              };
            })
          );
          if (viewBySessionRef.current[currentSession.id]?.sidebar.blockId === blockId) {
            void patchSessionView(currentSession.id, { sidebar: { open: false, blockId: null } }, [blockId], true);
          }
          if (shouldFocusNext && nextSelection) {
            window.requestAnimationFrame(() => focusBlock(nextSelection));
          }
        },
      })
        .catch((error) => {
          if (
            scopeGenerationRef.current === deleteScopeGeneration &&
            sessionsRef.current.some(
              (session) => session.id === currentSession.id && session.blocks.some((item) => item.id === blockId)
            )
          ) {
            toast.error(t("plugin.blockTerm.deleteBlockFailed"), {
              id: `blockterm-delete-${blockId}`,
              description: error instanceof Error ? error.message : undefined,
            });
          }
        })
        .finally(() => {
          deletingBlockIdsRef.current.delete(blockId);
          setDeletingBlockIds((current) => {
            if (!current.has(blockId)) return current;
            const next = new Set(current);
            next.delete(blockId);
            return next;
          });
          if (
            !deletedBlockIdsRef.current.has(blockId) &&
            (pendingBlockCreatesRef.current.has(blockId) ||
              persistPatchRef.current.has(blockId) ||
              persistOutputRef.current.has(blockId))
          ) {
            void flushBlockPatch(blockId).catch(() => {});
          }
        });
    },
    [
      cancelBlockProcessIdentityTracker,
      clearLineAIConversationForSession,
      enqueueBlockWrite,
      flushBlockPatch,
      focusBlock,
      getVisibleBlocks,
      outputStore,
      patchSessionView,
      t,
    ]
  );

  const navigateToManagementLine = useCallback(
    async (action: Extract<BlockTermManagementDispatchAction, { kind: "view-line" }>): Promise<void> => {
      managementNavigationAbortRef.current?.abort();
      managementNavigationRef.current.invalidate();
      const controller = new AbortController();
      managementNavigationAbortRef.current = controller;
      const throwIfAborted = () => {
        if (!controller.signal.aborted) return;
        const error = new Error("management navigation was superseded");
        error.name = "AbortError";
        throw error;
      };

      try {
        const sessionState = useSessionStore.getState();
        const knownSessions = sessionState.sessions;
        const currentWorkspaceId = sessionState.currentSessionId;
        const currentWorkspace = currentWorkspaceId
          ? knownSessions.find((session) => session.id === currentWorkspaceId) || {
              id: currentWorkspaceId,
              user_id: "",
              name: "Workspace",
              position: 0,
              created_at: 0,
              updated_at: 0,
            }
          : null;
        const currentInventory = currentWorkspace
          ? createLocalBlockTermWorkspaceInventory(
              currentWorkspace,
              Math.max(
                0,
                knownSessions.findIndex((session) => session.id === currentWorkspace.id)
              ),
              useFrameStore.getState().groups,
              useTerminalStore.getState().terminalsByGroup
            )
          : null;
        const loaded = await loadBlockTermWorkspaceSearchTargets(
          { currentWorkspaceId, currentInventory },
          controller.signal,
          {
            listSessions: (page, pageSize, signal) => sessionApi.list(page, pageSize, { signal }),
            getSession: (id, signal) => sessionApi.get(id, { signal, touch: false }),
            listTerminals: (workspaceId, signal) => terminalApi.list({ workspace_session_id: workspaceId }, { signal }),
          }
        );
        throwIfAborted();

        const workspaces = new Map<
          string,
          { id: string; name: string; order: number; screens: BlockTermWorkspaceSearchTarget[] }
        >();
        for (const target of loaded.targets) {
          const workspace = workspaces.get(target.workspaceId);
          if (workspace) {
            workspace.screens.push(target);
          } else {
            workspaces.set(target.workspaceId, {
              id: target.workspaceId,
              name: target.workspaceName,
              order: target.workspaceOrder,
              screens: [target],
            });
          }
        }
        const workspace = resolveBlockTermManagementReference(
          action.workspaceRef,
          [...workspaces.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
          "workspace"
        );
        const screenCandidates = workspace.screens
          .map((target) => ({ id: target.tabId, name: target.tabName, target }))
          .sort(
            (left, right) =>
              left.target.groupOrder - right.target.groupOrder ||
              left.target.tabOrder - right.target.tabOrder ||
              left.id.localeCompare(right.id)
          );
        const screen = resolveBlockTermManagementReference(action.screenRef, screenCandidates, "screen");
        const { blocks } = await blockTermApi.list(screen.id);
        throwIfAborted();
        const block = resolveBlockTermManagementLine(blocks, action.lineRef);
        const entry: BlockTermHistoryEntry = {
          id: block.id,
          terminalId: screen.id,
          workspaceSessionId: workspace.id,
          groupId: screen.target.groupId,
          runtimeType: block.runtimeType,
          ...(block.runtimeType === "ssh" && block.sshProfileId ? { sshProfileId: block.sshProfileId } : {}),
          lineNum: block.lineNum,
          command: block.command,
          cwd: block.cwd,
          createdAt: block.createdAt,
          starred: block.starred,
        };
        const dependencies: BlockTermWorkspaceNavigationDependencies = {
          switchSession: (workspaceId) => useSessionStore.getState().switchSession(workspaceId),
          getSessionState: () => useSessionStore.getState(),
          getFrameState: () => useFrameStore.getState(),
          getTerminalState: () => useTerminalStore.getState(),
          setActiveTerminal: (targetGroupId, terminalId) =>
            useTerminalStore.getState().setActiveId(targetGroupId, terminalId),
          setActiveGroup: (targetGroupId) => useFrameStore.getState().setActiveGroup(targetGroupId),
        };
        const navigation = await activateBlockTermHistoryTarget(
          entry,
          screen.target,
          managementNavigationRef.current,
          dependencies
        );
        if (navigation.status === "superseded") return;
        if (navigation.status === "failed") throw new Error("failed to switch workspace");
        if (navigation.status === "unavailable") throw new Error("target workspace, screen, or line is unavailable");
      } finally {
        if (managementNavigationAbortRef.current === controller) managementNavigationAbortRef.current = null;
      }
    },
    []
  );

  const handleManagementCommand = useCallback(
    (sessionId: string, result: BlockTermManagementCommandResult): void => {
      const requestScopeGeneration = scopeGenerationRef.current;
      const workspaceState = useSessionStore.getState();
      const requestWorkspaceRevision = workspaceState.workspaceRevision;
      const requestWorkspaceSessionId = workspaceState.currentSessionId;

      const isManagementScopeCurrent = (): boolean =>
        scopeGenerationRef.current === requestScopeGeneration &&
        isCurrentWorkspaceTransition(requestWorkspaceRevision, requestWorkspaceSessionId, true) &&
        useFrameStore.getState().groups.some((group) => group.id === groupId);

      const getCurrentSession = (): BlockTermSession | null => {
        if (!isManagementScopeCurrent()) return null;
        return sessionsRef.current.find((session) => session.id === sessionId) || null;
      };

      const getSnapshot = () => {
        const session = getCurrentSession();
        if (!session) return null;
        const activeBlockId = sessionActiveBlockRef.current[sessionId] ?? session.activeBlockId;
        const terminalInventory = useTerminalStore.getState().getTerminals(groupId);
        const orderedSessions = orderBlockTermTerminalsByWorkspace(sessionsRef.current, terminalInventory);
        const independentBindings: BlockTermManagementIndependentBinding[] = [];
        for (const block of session.blocks) {
          const status = blockStatusRef.current[block.id] ?? block.status;
          if (
            block.kind !== "command" ||
            block.archived ||
            (status !== "running" && status !== "streaming") ||
            block.terminalId !== sessionId ||
            !independentBlockIdsRef.current.has(block.id)
          ) {
            continue;
          }
          const binding = blockTokenRef.current[block.id];
          const runtime = blockRuntimesRef.current.get(block.id);
          if (
            !binding ||
            binding.sessionId !== sessionId ||
            !binding.token.trim() ||
            !runtime ||
            runtime.sessionId !== sessionId ||
            runtime.blockId !== block.id ||
            runtime.blockToken !== binding.token ||
            runtime.scopeGeneration !== requestScopeGeneration ||
            !runtime.allowReconnect
          ) {
            continue;
          }
          independentBindings.push({
            sessionId,
            blockId: block.id,
            blockToken: binding.token,
            scopeGeneration: requestScopeGeneration,
          });
        }
        return {
          sessionId,
          scopeGeneration: requestScopeGeneration,
          workspaceSessionId: requestWorkspaceSessionId,
          groupId,
          sessions: orderedSessions.map((item) => ({
            id: item.id,
            name: item.name,
            tabColor: item.tabColor,
            tabIcon: item.tabIcon,
            cwd: item.cwd,
            runtimeType: item.runtimeType,
            sshProfileId: item.sshProfileId,
            cols: item.cols,
            rows: item.rows,
            status: item.status,
          })),
          sessionStatus: session.status,
          activeBlockId,
          selectedBlockId: session.selectedBlockId,
          blocks: session.blocks.map((block) => ({
            ...block,
            status: blockStatusRef.current[block.id] ?? block.status,
          })),
          independentBindings,
          view: viewBySessionRef.current[sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE,
        };
      };

      const snapshot = getSnapshot();
      if (!snapshot) return;
      const dispatch = planBlockTermManagementDispatch(result, snapshot);
      if (dispatch.kind === "error") {
        toast.error(dispatch.message);
        return;
      }
      if (dispatch.kind !== "plan") return;
      // A parsed, plannable management command is consumed by BlockTerm rather
      // than the shell. Preserve drafts for parse/planning errors above, but do
      // not leave a successfully accepted command in the prompt.
      setDraft(sessionId, "");

      const reportStaleAction = (commandName: string, blockId?: string): void => {
        // Workspace transitions invalidate every planned action. The
        // transition itself owns user feedback; avoid one toast per block.
        if (!isManagementScopeCurrent()) return;
        const target = blockId ? ` '${blockId}'` : "";
        toast.error(`/${commandName} target${target} is no longer available`);
      };

      const getCurrentBlock = (blockId: string): { session: BlockTermSession; block: BlockTermBlock } | null => {
        const session = getCurrentSession();
        const block = session?.blocks.find((item) => item.id === blockId);
        return session && block ? { session, block } : null;
      };

      const isDeletable = (session: BlockTermSession, block: BlockTermBlock): boolean =>
        session.activeBlockId !== block.id &&
        sessionActiveBlockRef.current[session.id] !== block.id &&
        !isActiveBlockStatus(blockStatusRef.current[block.id] ?? block.status) &&
        !deletingBlockIdsRef.current.has(block.id) &&
        !deletedBlockIdsRef.current.has(block.id);

      const executeAction = async (action: BlockTermManagementDispatchAction): Promise<void> => {
        if (!isManagementScopeCurrent()) return;
        if (action.sessionId !== sessionId) return;
        switch (action.kind) {
          case "set-connection": {
            if (!getCurrentSession()) {
              reportStaleAction(dispatch.commandName);
              return;
            }
            if (action.runtimeType === "ssh") {
              const reference = action.sshProfileId?.trim();
              if (!reference) {
                reportStaleAction(dispatch.commandName);
                return;
              }
              let profiles: Awaited<ReturnType<typeof sshApi.listProfiles>>["profiles"];
              try {
                profiles = (await sshApi.listProfiles()).profiles;
              } catch (error) {
                if (isManagementScopeCurrent()) {
                  toast.error(error instanceof Error ? error.message : "Unable to load SSH profiles");
                }
                return;
              }
              if (!isManagementScopeCurrent()) return;
              const resolution = resolveBlockTermSSHProfileReference(profiles, reference);
              if (resolution.kind === "error") {
                toast.error(resolution.message);
                return;
              }
              await setNextConnectionContext(sessionId, {
                runtimeType: "ssh",
                sshProfileId: resolution.profile.id,
              });
              return;
            }
            await setNextConnectionContext(sessionId, { runtimeType: "local" });
            return;
          }
          case "open-connection-selector":
            if (!getCurrentSession()) {
              reportStaleAction(dispatch.commandName);
              return;
            }
            sshSelectionScopeRef.current = {
              sessionId,
              scopeGeneration: requestScopeGeneration,
              workspaceRevision: requestWorkspaceRevision,
              workspaceSessionId: requestWorkspaceSessionId,
            };
            setSSHSelectionSessionId(sessionId);
            setSSHDialogOpen(true);
            return;
          case "delete-blocks":
            for (const blockId of action.blockIds) {
              if (!isManagementScopeCurrent()) return;
              const current = getCurrentBlock(blockId);
              if (!current || !isDeletable(current.session, current.block)) {
                reportStaleAction(dispatch.commandName, blockId);
                continue;
              }
              await deleteBlock(blockId, sessionId);
            }
            return;
          case "archive-blocks":
            for (const blockId of action.blockIds) {
              const current = getCurrentBlock(blockId);
              if (!current || deletedBlockIdsRef.current.has(blockId) || deletingBlockIdsRef.current.has(blockId)) {
                reportStaleAction(dispatch.commandName, blockId);
                continue;
              }
              toggleBlockArchived(sessionId, blockId, true);
            }
            return;
          case "signal": {
            const current = getCurrentBlock(action.blockId);
            const status = current ? (blockStatusRef.current[action.blockId] ?? current.block.status) : undefined;
            if (
              !current ||
              current.block.kind !== "command" ||
              status !== "running" ||
              deletedBlockIdsRef.current.has(action.blockId) ||
              deletingBlockIdsRef.current.has(action.blockId) ||
              (!independentBlockIdsRef.current.has(action.blockId) &&
                (current.session.activeBlockId !== action.blockId ||
                  sessionActiveBlockRef.current[sessionId] !== action.blockId))
            ) {
              reportStaleAction(dispatch.commandName, action.blockId);
              return;
            }
            if (current.block.runtimeType === "ssh" && action.signal !== "INT") {
              toast.error(`/${dispatch.commandName} supports only INT for SSH command blocks`);
              return;
            }
            if (!interruptSession(sessionId, action.blockId, [action.signal])) {
              toast.error(`/${dispatch.commandName} could not send ${action.signal} to the active command`);
            }
            return;
          }
          case "focus-block": {
            const current = getCurrentBlock(action.blockId);
            if (!current || current.block.archived || deletedBlockIdsRef.current.has(action.blockId)) {
              reportStaleAction(dispatch.commandName, action.blockId);
              return;
            }
            selectBlock(sessionId, action.blockId);
            if (activeSessionIdRef.current !== sessionId) {
              const currentView = viewBySessionRef.current[sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
              const area =
                currentView.sidebar.open && currentView.sidebar.blockId === action.blockId ? "sidebar" : "main";
              const focus =
                (area === "sidebar" || !current.block.collapsed) &&
                shouldUseBlockTermTerminalRenderer(current.block.renderer)
                  ? "terminal"
                  : (area === "sidebar" || !current.block.collapsed) && current.block.renderer === "code"
                    ? "editor"
                    : "container";
              sessionFocusTargetRef.current[sessionId] = { type: "block", blockId: action.blockId, area, focus };
              selectSession(sessionId, "restore");
            } else {
              focusBlock(action.blockId);
            }
            return;
          }
          case "update-block": {
            const current = getCurrentBlock(action.blockId);
            if (
              !current ||
              deletedBlockIdsRef.current.has(action.blockId) ||
              deletingBlockIdsRef.current.has(action.blockId)
            ) {
              reportStaleAction(dispatch.commandName, action.blockId);
              return;
            }
            const patch = action.patch;
            if (patch.archived !== undefined) {
              toggleBlockArchived(sessionId, action.blockId, patch.archived);
            }
            if (patch.pinned !== undefined) {
              toggleBlockPinned(sessionId, action.blockId, patch.pinned);
            }
            const remainingPatch = { ...patch };
            delete remainingPatch.archived;
            delete remainingPatch.pinned;
            if (Object.keys(remainingPatch).length > 0) updateBlockState(sessionId, action.blockId, remainingPatch);
            return;
          }
          case "restart-block": {
            const current = getCurrentBlock(action.blockId);
            if (
              !current ||
              current.block.kind !== "command" ||
              current.block.renderer === "openai" ||
              isActiveBlockStatus(blockStatusRef.current[action.blockId] ?? current.block.status) ||
              current.session.status !== "ready"
            ) {
              reportStaleAction(dispatch.commandName, action.blockId);
              return;
            }
            void restartBlock(sessionId, current.block);
            return;
          }
          case "open-bookmark": {
            const current = getCurrentBlock(action.blockId);
            if (!current || current.block.kind !== "command" || !current.block.command.trim()) {
              reportStaleAction(dispatch.commandName, action.blockId);
              return;
            }
            openBookmarkCreate(current.block.command);
            return;
          }
          case "switch-renderer": {
            const current = getCurrentBlock(action.blockId);
            if (
              !current ||
              current.block.kind !== "command" ||
              isActiveBlockStatus(blockStatusRef.current[action.blockId] ?? current.block.status) ||
              deletedBlockIdsRef.current.has(action.blockId) ||
              deletingBlockIdsRef.current.has(action.blockId)
            ) {
              reportStaleAction(dispatch.commandName, action.blockId);
              return;
            }
            switchBlockRenderer(sessionId, current.block, action.renderer);
            return;
          }
          case "update-view": {
            const current = getCurrentSession();
            if (!current) return;
            const view = viewBySessionRef.current[sessionId] || DEFAULT_BLOCKTERM_VIEW_STATE;
            const targetBlockId =
              action.patch.sidebar.blockId !== undefined ? action.patch.sidebar.blockId : view.sidebar.blockId;
            const movingBlockIds = [
              ...new Set([view.sidebar.blockId, targetBlockId].filter((id): id is string => !!id)),
            ];
            if (action.patch.sidebar.open === true) {
              const target = targetBlockId ? current.blocks.find((block) => block.id === targetBlockId) : null;
              if (targetBlockId && (!target || !isSidebarEligibleBlock(sessionId, target))) {
                reportStaleAction(dispatch.commandName, targetBlockId || undefined);
                return;
              }
              closeLineAI(sessionId);
            }
            void patchSessionView(sessionId, action.patch, movingBlockIds);
            return;
          }
          case "create-screen": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName);
              return;
            }
            const created = await createSession({ name: action.name, activate: action.activate });
            if (!created && isManagementScopeCurrent()) reportStaleAction(dispatch.commandName);
            return;
          }
          case "select-screen": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const target = sessionsRef.current.find((item) => item.id === action.targetSessionId);
            if (!target) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            selectSession(target.id);
            return;
          }
          case "update-screen-settings": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const target = sessionsRef.current.find((item) => item.id === action.targetSessionId);
            if (!target) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const settingsPatch = buildBlockTermManagementScreenSettingsPatch(action.settings);
            await enqueueWorkspaceMutation(async () => {
              if (!isManagementScopeCurrent()) throw new Error("screen settings target is no longer available");
              await terminalApi.updateSettings(target.id, {
                ...(settingsPatch.name !== undefined ? { name: settingsPatch.name } : {}),
                ...(settingsPatch.tabColor !== undefined ? { tab_color: settingsPatch.tabColor } : {}),
                ...(settingsPatch.tabIcon !== undefined ? { tab_icon: settingsPatch.tabIcon } : {}),
              });
              if (!isManagementScopeCurrent()) return;
              setSessions((items) =>
                items.map((item) => (item.id === target.id ? { ...item, ...settingsPatch } : item))
              );
              updateTerminal(groupId, target.id, settingsPatch);
            });
            return;
          }
          case "reorder-screen": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const current = orderBlockTermTerminalsByWorkspace(
              sessionsRef.current,
              useTerminalStore.getState().getTerminals(groupId)
            );
            const target = current.find((item) => item.id === action.targetSessionId);
            const anchorSessionId = resolveBlockTermManagementScreenReorderAnchor(current, action.targetIndex);
            const anchor = anchorSessionId ? current.find((item) => item.id === anchorSessionId) : null;
            if (!target || !anchor) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            handleSessionReorder(target.id, anchor.id);
            return;
          }
          case "set-screen-view": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const target = sessionsRef.current.find((item) => item.id === action.targetSessionId);
            if (!target) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            if (action.selectedBlockId) {
              const selected = target.blocks.find((block) => block.id === action.selectedBlockId && !block.archived);
              if (!selected) {
                reportStaleAction(dispatch.commandName, action.selectedBlockId);
                return;
              }
              setShowRunningOnly(false);
              setShowStarredOnly(false);
              selectBlock(target.id, selected.id);
            }
            if (action.anchorBlockId) {
              const anchor = target.blocks.find((block) => block.id === action.anchorBlockId && !block.archived);
              if (!anchor) {
                reportStaleAction(dispatch.commandName, action.anchorBlockId);
                return;
              }
              setShowRunningOnly(false);
              setShowStarredOnly(false);
              window.requestAnimationFrame(() => {
                const index = visibleOrderedBlocksRef.current.findIndex((block) => block.id === anchor.id);
                if (index >= 0) blockVirtualizer.scrollToIndex(index, { align: "end" });
                window.requestAnimationFrame(() => {
                  const scroll = blockScrollRef.current;
                  const element = blockElementRefs.current.get(anchor.id);
                  if (!scroll || !element) return;
                  const currentOffset = scroll.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
                  scroll.scrollTop += (action.anchorOffset || 0) - currentOffset;
                });
              });
            }
            if (action.focus === "input") {
              sessionFocusTargetRef.current[target.id] = { type: "input" };
              commandInputRef.current?.focus({ preventScroll: true });
            } else if (action.focus === "command") {
              const blockId = action.selectedBlockId || target.selectedBlockId;
              const block = blockId ? target.blocks.find((item) => item.id === blockId && !item.archived) : null;
              if (!block) {
                reportStaleAction(dispatch.commandName, blockId || undefined);
                return;
              }
              const view = viewBySessionRef.current[target.id] || DEFAULT_BLOCKTERM_VIEW_STATE;
              const area = view.sidebar.open && view.sidebar.blockId === block.id ? "sidebar" : "main";
              const focus =
                (area === "sidebar" || !block.collapsed) && shouldUseBlockTermTerminalRenderer(block.renderer)
                  ? "terminal"
                  : (area === "sidebar" || !block.collapsed) && block.renderer === "code"
                    ? "editor"
                    : "container";
              sessionFocusTargetRef.current[target.id] = { type: "block", blockId: block.id, area, focus };
              pendingSessionFocusRef.current = { sessionId: target.id, mode: "restore" };
              window.requestAnimationFrame(() => sessionFocusAttemptRef.current());
            }
            return;
          }
          case "show-screen-info":
            toast.info(`#${action.screen.index} ${action.screen.name}`, {
              description: `${action.screen.runtimeType} · ${action.screen.status} · ${action.screen.cols}x${action.screen.rows} · ${action.screen.cwd}`,
            });
            return;
          case "show-screen-list":
            toast.info(`/${dispatch.commandName}`, {
              description: action.screens
                .map(
                  (screen) =>
                    `#${screen.index} ${screen.name} · ${screen.runtimeType} · ${screen.status} · ${screen.cols}x${screen.rows}`
                )
                .join(" | "),
            });
            return;
          case "resize-screen": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const target = sessionsRef.current.find((item) => item.id === action.targetSessionId);
            if (!target || !resizeSession(target.id, action.cols, action.rows)) {
              toast.error(`/${dispatch.commandName} requires a connected terminal`);
              return;
            }
            setSessionPatch(target.id, { cols: action.cols, rows: action.rows });
            for (const childTarget of action.childTargets || []) {
              if (!isManagementScopeCurrent()) return;
              const current = getCurrentBlock(childTarget.blockId);
              const binding = blockTokenRef.current[childTarget.blockId];
              const runtime = blockRuntimesRef.current.get(childTarget.blockId);
              const status = current
                ? (blockStatusRef.current[childTarget.blockId] ?? current.block.status)
                : undefined;
              const targetScopeMatches =
                childTarget.scopeGeneration === undefined || childTarget.scopeGeneration === requestScopeGeneration;
              if (
                !current ||
                current.session.id !== target.id ||
                current.block.kind !== "command" ||
                current.block.archived ||
                current.block.terminalId !== target.id ||
                !status ||
                !isActiveBlockStatus(status) ||
                !independentBlockIdsRef.current.has(childTarget.blockId) ||
                !targetScopeMatches ||
                !binding ||
                binding.sessionId !== target.id ||
                binding.token !== childTarget.blockToken ||
                !runtime ||
                runtime.sessionId !== target.id ||
                runtime.blockId !== childTarget.blockId ||
                runtime.blockToken !== childTarget.blockToken ||
                runtime.scopeGeneration !== requestScopeGeneration ||
                !runtime.allowReconnect
              ) {
                reportStaleAction(dispatch.commandName, childTarget.blockId);
                continue;
              }
              if (!resizeBlockRuntime(target.id, childTarget.blockId, action.cols, action.rows)) {
                reportStaleAction(dispatch.commandName, childTarget.blockId);
              }
            }
            return;
          }
          case "delete-screen": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const ordered = orderBlockTermTerminalsByWorkspace(
              sessionsRef.current,
              useTerminalStore.getState().getTerminals(groupId)
            );
            const target = ordered.find((item) => item.id === action.targetSessionId);
            if (!target) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            if (ordered.length <= 1) {
              toast.error(`/${dispatch.commandName} cannot delete the only BlockTerm screen`);
              return;
            }
            const targetWasActive = activeSessionIdRef.current === target.id;
            const nextSessionId = targetWasActive
              ? resolveBlockTermSessionAfterClose(
                  ordered.map((item) => item.id),
                  target.id
                )
              : activeSessionIdRef.current;
            await enqueueWorkspaceMutation(async () => {
              if (!isManagementScopeCurrent()) throw new Error("screen delete target is no longer available");
              await closeIndependentBlockRuntimes(target.id, new Set(target.blocks.map((block) => block.id)));
              await Promise.allSettled(
                target.blocks
                  .filter((block) => block.renderer === "openai" && block.status === "streaming")
                  .map((block) => blockTermModelApi.cancel(block.id))
              );
              cancelProcessIdentityTracker(target.id);
              const runtime = runtimesRef.current.get(target.id);
              if (runtime) {
                runtime.allowReconnect = false;
                clearBlockTermTransitionTimer(runtime);
                runtime.transitionPrimaryBinding = null;
                if (runtime.ws) {
                  runtime.ws.onclose = null;
                  runtime.ws.close();
                  runtime.ws = null;
                }
              }
              const reconnectTimer = reconnectTimersRef.current.get(target.id);
              if (reconnectTimer) clearTimeout(reconnectTimer);
              reconnectTimersRef.current.delete(target.id);
              try {
                await terminalApi.delete(target.id);
              } catch (error) {
                if (runtime && isManagementScopeCurrent()) {
                  runtime.allowReconnect = true;
                  connectSession(target.id, requestScopeGeneration);
                }
                throw error;
              }
              if (!isManagementScopeCurrent()) return;

              clearNextConnectionContext(target.id);
              delete nextConnectionCwdWatermarkRef.current[target.id];
              runtimesRef.current.delete(target.id);
              sessionCommandChainsRef.current.delete(target.id);
              runtimeInfoWriteChainsRef.current.delete(target.id);
              delete sessionActiveBlockRef.current[target.id];
              delete interruptedOutputBlockRef.current[target.id];
              delete nextLineNumRef.current[target.id];
              delete persistedLoadRequestRef.current[target.id];
              delete persistedLoadPromiseRef.current[target.id];
              delete persistedBlocksLoadedGenerationRef.current[target.id];
              delete historyLoadRequestRef.current[target.id];
              delete sessionFocusTargetRef.current[target.id];
              for (const block of target.blocks) {
                deletedBlockIdsRef.current.add(block.id);
                deletingBlockIdsRef.current.delete(block.id);
                cancelBlockProcessIdentityTracker(block.id);
                capturedProcessIdentityBlockIdsRef.current.delete(block.id);
                clearBlockTermRendererCache(block.id);
                const persistTimer = persistTimersRef.current.get(block.id);
                if (persistTimer) clearTimeout(persistTimer);
                persistTimersRef.current.delete(block.id);
                const heightTimer = presentationHeightTimersRef.current.get(block.id);
                if (heightTimer) clearTimeout(heightTimer);
                presentationHeightTimersRef.current.delete(block.id);
                presentationHeightPendingRef.current.delete(block.id);
                pendingBlockCreatesRef.current.delete(block.id);
                createBlockRequestsRef.current.delete(block.id);
                persistPatchRef.current.delete(block.id);
                persistOutputRef.current.delete(block.id);
                blockWriteChainsRef.current.delete(block.id);
                stopSequencesRef.current.get(block.id)?.cancel();
                stopSequencesRef.current.delete(block.id);
                interruptedBlocksRef.current.delete(block.id);
                blockElementRefs.current.delete(block.id);
                sidebarBlockElementRefs.current.delete(block.id);
                const terminalRuntime = xtermRefs.current.get(block.id);
                if (terminalRuntime) {
                  disposeTerminalRuntime(terminalRuntime);
                  xtermRefs.current.delete(block.id);
                }
                outputStore.delete(block.id);
                delete outputRef.current[block.id];
                delete terminalRawRef.current[block.id];
                delete modeRef.current[block.id];
                delete blockStatusRef.current[block.id];
                delete blockTokenRef.current[block.id];
                independentBlockIdsRef.current.delete(block.id);
                forgetBlockTermRuntimeBinding(target.id, block.id);
                delete blockOutputPhaseRef.current[block.id];
                delete blockRestartTransitionRef.current[block.id];
                delete rawTargetCursorRef.current[block.id];
                delete rawAcknowledgedTargetCursorRef.current[block.id];
                delete blockCompletionCursorRef.current[block.id];
              }
              setUnavailableModelStreams((current) => {
                if (!target.blocks.some((block) => current.has(block.id))) return current;
                const next = new Set(current);
                for (const block of target.blocks) next.delete(block.id);
                return next;
              });
              setDeletingBlockIds((current) => {
                if (!target.blocks.some((block) => current.has(block.id))) return current;
                const next = new Set(current);
                for (const block of target.blocks) next.delete(block.id);
                return next;
              });
              setFullscreenBlockId((current) =>
                current && target.blocks.some((block) => block.id === current) ? null : current
              );
              clearLineAIConversationForSession(target.id);
              setInputExpandedBySession((current) => {
                if (!(target.id in current)) return current;
                const next = { ...current };
                delete next[target.id];
                return next;
              });
              setViewBySession((current) => {
                if (!(target.id in current)) return current;
                const next = { ...current };
                delete next[target.id];
                return next;
              });
              removeTerminal(groupId, target.id);
              setSessions((items) => items.filter((item) => item.id !== target.id));
              if (targetWasActive) {
                cancelSessionFocusRetry();
                pendingBlockFocusRef.current = null;
                activeSessionIdRef.current = nextSessionId;
                pendingSessionFocusRef.current = nextSessionId ? { sessionId: nextSessionId, mode: "restore" } : null;
                setActiveSessionId(nextSessionId);
                setActiveTerminalId(groupId, nextSessionId);
              }
            });
            return;
          }
          case "reset-session-runtime": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const target = sessionsRef.current.find((item) => item.id === action.targetSessionId);
            if (!target || target.status !== "ready" || (sessionActiveBlockRef.current[target.id] ?? null) !== null) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            if (target.runtimeType !== "local") {
              toast.error("/reset is only supported for local BlockTerm terminals");
              return;
            }
            if (action.shell) {
              toast.error("/reset shell= is unsupported because BlockTerm resets the terminal's configured shell");
              return;
            }
            await closeIndependentBlockRuntimes(target.id, new Set(target.blocks.map((block) => block.id)));
            cancelProcessIdentityTracker(target.id);
            flushTerminalParser(target.id);
            const runtime = runtimesRef.current.get(target.id);
            if (runtime) {
              runtime.allowReconnect = false;
              runtime.echoConfigured = false;
              clearBlockTermTransitionTimer(runtime);
              runtime.transitionPrimaryBinding = null;
              if (runtime.ws) {
                runtime.ws.onclose = null;
                runtime.ws.close();
                runtime.ws = null;
              }
              runtime.decoder = new TextDecoder("utf-8", { fatal: false });
              runtime.parseBuffer = new Uint8Array();
            }
            const reconnectTimer = reconnectTimersRef.current.get(target.id);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimersRef.current.delete(target.id);
            setSessionPatch(target.id, { status: "connecting", activeBlockId: null, shellIntegration: false });
            let resetResult: Awaited<ReturnType<typeof terminalApi.reset>>;
            try {
              resetResult = await terminalApi.reset(target.id);
            } catch (error) {
              if (runtime && isManagementScopeCurrent()) {
                runtime.allowReconnect = true;
                connectSession(target.id, requestScopeGeneration);
              }
              throw error;
            }
            if (!isManagementScopeCurrent()) return;
            const terminal = resetResult.terminal;
            sessionActiveBlockRef.current[target.id] = null;
            interruptedOutputBlockRef.current[target.id] = null;
            setSessionPatch(target.id, {
              name: terminal.name,
              tabColor: terminal.tab_color || "",
              tabIcon: terminal.tab_icon || "",
              cwd: terminal.current_cwd || terminal.cwd || target.cwd,
              runtimeType: terminal.runtime_type === "ssh" ? "ssh" : "local",
              cols: terminal.cols || target.cols,
              rows: terminal.rows || target.rows,
              shellType: terminal.shell_type || undefined,
              shellState: terminal.shell_state || "ready",
              shellIntegration: terminal.shell_integration,
              completion: terminal.capabilities?.completion === true,
              lastCommand: terminal.last_command || undefined,
              lastCommandExitCode: terminal.last_command_exit_code ?? null,
              status: terminal.status === "running" ? "connecting" : terminal.status,
              activeBlockId: null,
            });
            updateTerminal(groupId, target.id, {
              name: terminal.name,
              tabColor: terminal.tab_color || "",
              tabIcon: terminal.tab_icon || "",
              status: terminal.status,
              cwd: terminal.cwd,
              currentCwd: terminal.current_cwd,
              runtimeType: terminal.runtime_type,
              readonly: terminal.readonly,
              capabilities: terminal.capabilities,
              shellType: terminal.shell_type,
              shellState: terminal.shell_state,
              shellIntegration: terminal.shell_integration,
              lastCommand: terminal.last_command,
              lastCommandExitCode: terminal.last_command_exit_code ?? null,
            });
            setTerminalStatus(groupId, target.id, terminal.status);
            if (terminal.status === "running") {
              if (runtime) runtime.allowReconnect = true;
              connectSession(target.id, requestScopeGeneration);
            }
            if (action.verbose) {
              toast.success(`/reset ${terminal.name}`, {
                description: `${terminal.shell_type || terminal.shell} · ${terminal.current_cwd || terminal.cwd}`,
              });
            }
            return;
          }
          case "sync-session-state":
          case "reset-session-cwd": {
            if (action.workspaceSessionId !== requestWorkspaceSessionId || action.groupId !== groupId) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            const target = sessionsRef.current.find((item) => item.id === action.targetSessionId);
            if (
              !target ||
              target.status !== "ready" ||
              target.activeBlockId !== null ||
              (sessionActiveBlockRef.current[target.id] ?? null) !== null
            ) {
              reportStaleAction(dispatch.commandName, action.targetSessionId);
              return;
            }
            await runCommandRef.current(target.id, action.command, true, "");
            return;
          }
          case "view-line":
            await navigateToManagementLine(action);
            return;
        }
      };

      void (async () => {
        for (const action of dispatch.actions) {
          if (!isManagementScopeCurrent()) return;
          try {
            await executeAction(action);
          } catch (error) {
            if (!isManagementScopeCurrent()) return;
            const message = error instanceof Error ? error.message : "management action failed";
            if (error instanceof Error && error.name === "AbortError") return;
            toast.error(`/${dispatch.commandName} ${message}`);
            return;
          }
        }
      })();
    },
    [
      closeLineAI,
      closeIndependentBlockRuntimes,
      deleteBlock,
      createSession,
      connectSession,
      focusBlock,
      groupId,
      handleSessionReorder,
      navigateToManagementLine,
      openBookmarkCreate,
      patchSessionView,
      restartBlock,
      selectBlock,
      selectSession,
      interruptSession,
      isSidebarEligibleBlock,
      setDraft,
      switchBlockRenderer,
      toggleBlockArchived,
      toggleBlockPinned,
      updateBlockState,
      blockVirtualizer,
      cancelProcessIdentityTracker,
      cancelSessionFocusRetry,
      clearLineAIConversationForSession,
      clearNextConnectionContext,
      disposeTerminalRuntime,
      flushTerminalParser,
      outputStore,
      removeTerminal,
      resizeBlockRuntime,
      resizeSession,
      setActiveTerminalId,
      setSessionPatch,
      setNextConnectionContext,
      setTerminalStatus,
      updateTerminal,
    ]
  );
  managementCommandHandlerRef.current = handleManagementCommand;

  const handleDesktopShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        historyDialogOpen ||
        keymapDialogOpen ||
        sshDialogOpen ||
        bookmarkDialogOpen ||
        hasOpenBlockTermDesktopShortcutModal(document)
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const commandInputTarget = target === commandInputRef.current;
      const shortcut = resolveBlockTermDesktopShortcutForTarget(event, target, {
        commandInput: commandInputTarget,
        keymap: blockTermKeymap,
        macPlatform: isBlockTermMacPlatform(navigator),
      });
      if (!shortcut) return;

      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && !isBlockTermDesktopShortcutRepeatable(shortcut)) return;

      const sessionItems = sessionsRef.current;
      const sessionId = activeSessionIdRef.current;
      const session = sessionItems.find((item) => item.id === sessionId) || null;

      switch (shortcut.type) {
        case "new-session":
          void createSession();
          return;
        case "close-session":
          if (session && sessionItems.length > 1) void closeSession(session.id);
          return;
        case "select-session": {
          const targetSession = sessionItems[shortcut.index];
          if (targetSession) selectSession(targetSession.id);
          return;
        }
        case "previous-session":
        case "next-session": {
          if (sessionItems.length === 0) return;
          const currentIndex = Math.max(
            0,
            sessionItems.findIndex((item) => item.id === sessionId)
          );
          const offset = shortcut.type === "previous-session" ? -1 : 1;
          const nextIndex = (currentIndex + offset + sessionItems.length) % sessionItems.length;
          selectSession(sessionItems[nextIndex].id);
          return;
        }
        case "focus-input": {
          closeCompletion();
          const input = commandInputRef.current;
          if (input && !input.disabled) input.focus();
          return;
        }
        case "focus-selected-block": {
          closeCompletion();
          const blockId = session?.selectedBlockId;
          if (!blockId) return;
          const block = session.blocks.find((item) => item.id === blockId);
          if (!block) return;
          const currentView = viewBySessionRef.current[session.id] || DEFAULT_BLOCKTERM_VIEW_STATE;
          const area = currentView.sidebar.open && currentView.sidebar.blockId === blockId ? "sidebar" : "main";
          const focus =
            (area === "sidebar" || !block.collapsed) && shouldUseBlockTermTerminalRenderer(block.renderer)
              ? "terminal"
              : (area === "sidebar" || !block.collapsed) && block.renderer === "code"
                ? "editor"
                : "container";
          const terminalRuntime = xtermRefs.current.get(blockId);
          if (terminalRuntime && !terminalRuntime.disposed) terminalRuntime.terminal.focus();
          else {
            const blockElement = sidebarBlockElementRefs.current.get(blockId) || blockElementRefs.current.get(blockId);
            const editorInput = blockElement?.querySelector<HTMLElement>(".monaco-editor textarea");
            if (focus === "editor" && blockElement && editorInput) {
              editorInput.focus({ preventScroll: true });
              blockElement.scrollIntoView({ block: "nearest", inline: "nearest" });
            } else if (focus === "container" && blockElement) {
              blockElement.focus({ preventScroll: true });
              blockElement.scrollIntoView({ block: "nearest", inline: "nearest" });
            } else {
              const pending = { sessionId: session.id, mode: "restore" as const };
              cancelSessionFocusRetry();
              pendingBlockFocusRef.current = null;
              sessionFocusTargetRef.current[session.id] = { type: "block", blockId, area, focus };
              pendingSessionFocusRef.current = pending;
              sessionFocusAttemptRef.current();
            }
          }
          return;
        }
        case "rerun-selected-command": {
          const block = session?.blocks.find((item) => item.id === session.selectedBlockId);
          if (
            session &&
            block &&
            !deletingBlockIdsRef.current.has(block.id) &&
            block.kind === "command" &&
            block.renderer !== "openai" &&
            !isActiveBlockStatus(block.status)
          ) {
            void restartBlock(session.id, block);
          }
          return;
        }
        case "rerun-last-command": {
          const block = session?.blocks
            .filter(
              (item) =>
                !item.archived &&
                !deletingBlockIdsRef.current.has(item.id) &&
                item.kind === "command" &&
                item.renderer !== "openai" &&
                !isActiveBlockStatus(item.status) &&
                item.command.trim()
            )
            .reduce<BlockTermBlock | null>(
              (latest, item) => (!latest || (item.lineNum ?? 0) > (latest.lineNum ?? 0) ? item : latest),
              null
            );
          if (session && block) void restartBlock(session.id, block);
          return;
        }
        case "previous-block":
        case "next-block": {
          if (!session) return;
          closeCompletion();
          const visibleBlocks = visibleOrderedBlocksRef.current;
          if (visibleBlocks.length === 0) return;
          const currentBlockId = session.selectedBlockId;
          if (currentBlockId && visibleBlocks.some((block) => block.id === currentBlockId)) {
            const nextId = moveSelection(
              session.id,
              currentBlockId,
              shortcut.type === "previous-block" ? "ArrowUp" : "ArrowDown"
            );
            if (nextId && !commandInputTarget) focusBlock(nextId);
            return;
          }
          const nextId =
            shortcut.type === "previous-block" ? visibleBlocks[visibleBlocks.length - 1].id : visibleBlocks[0].id;
          selectBlock(session.id, nextId);
          if (!commandInputTarget) focusBlock(nextId);
          return;
        }
        case "delete-selected-block": {
          const block = session?.blocks.find((item) => item.id === session.selectedBlockId);
          if (
            session &&
            block &&
            (!isActiveBlockStatus(block.status) || (block.status === "running" && session.status !== "running"))
          ) {
            deleteBlock(block.id, session.id);
          }
          return;
        }
        case "toggle-sidebar": {
          if (!session) return;
          if (lineAIViewBySessionRef.current[session.id]?.open) {
            closeLineAI(session.id);
            return;
          }
          const currentView = viewBySessionRef.current[session.id] || DEFAULT_BLOCKTERM_VIEW_STATE;
          if (!currentView.sidebar.open) {
            const candidateId = currentView.sidebar.blockId || session.selectedBlockId;
            const candidate = session.blocks.find((block) => block.id === candidateId);
            if (!candidate || !isSidebarEligibleBlock(session.id, candidate)) return;
          }
          setSidebarOpen(session.id, !currentView.sidebar.open);
          return;
        }
        case "open-bookmarks":
          openBookmarkManager();
          return;
        case "open-history":
          closeCompletion();
          setHistoryDialogOpen(true);
          return;
      }
    },
    [
      bookmarkDialogOpen,
      blockTermKeymap,
      cancelSessionFocusRetry,
      closeLineAI,
      closeCompletion,
      closeSession,
      createSession,
      deleteBlock,
      focusBlock,
      historyDialogOpen,
      keymapDialogOpen,
      moveSelection,
      openBookmarkManager,
      restartBlock,
      selectBlock,
      selectSession,
      setSidebarOpen,
      sshDialogOpen,
      isSidebarEligibleBlock,
    ]
  );
  desktopShortcutHandlerRef.current = handleDesktopShortcut;

  useEffect(() => {
    const listener = (event: KeyboardEvent) => desktopShortcutHandlerRef.current(event);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  const copyBlockOutput = useCallback(
    async (block: BlockTermBlock) => {
      let snapshot = outputStore.getSnapshot(block.id);
      if (snapshot.status !== "ready") {
        try {
          snapshot = await ensureBlockOutputLoaded(block.id);
        } catch {
          // Preserve the previous command fallback when output cannot be loaded.
        }
      }
      await navigator.clipboard.writeText(snapshot.value || block.command);
      setCopiedId(block.id);
      setTimeout(() => setCopiedId(null), 1200);
    },
    [ensureBlockOutputLoaded, outputStore]
  );

  const copyFullBlockOutput = useCallback(
    async (block: BlockTermBlock) => {
      let value = outputStore.getFullValue(block.id);
      try {
        await flushBlockPersistence([block.id]);
        const fullOutput = await blockTermApi.getOutput(block.id);
        value = fullOutput.value || value;
      } catch (error) {
        if (!value) {
          toast.error(error instanceof Error ? error.message : t("plugin.blockTerm.copyOutputFailed"));
          return;
        }
      }
      try {
        await navigator.clipboard.writeText(value || block.command);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("plugin.blockTerm.copyOutputFailed"));
        return;
      }
      setCopiedFullOutputId(block.id);
      setTimeout(() => setCopiedFullOutputId(null), 1200);
    },
    [flushBlockPersistence, outputStore, t]
  );

  const canRecoverTerminalRawOutput = useCallback((blockId: string): boolean => {
    const block = sessionsRef.current.flatMap((session) => session.blocks).find((item) => item.id === blockId);
    const effectiveStatus = blockStatusRef.current[blockId] ?? block?.status;
    if (!block || !shouldUseBlockTermTerminalRenderer(block.renderer)) return false;
    const activeSessionId = Object.entries(sessionActiveBlockRef.current).find(([, id]) => id === blockId)?.[0];
    const activeSession = activeSessionId
      ? sessionsRef.current.find((session) => session.id === activeSessionId)
      : undefined;
    const binding = blockTokenRef.current[blockId];
    const blockRuntime = blockRuntimesRef.current.get(blockId);
    const isIndependentLiveOwner =
      effectiveStatus === "running" &&
      !!binding &&
      !!blockRuntime &&
      blockRuntime.sessionId === binding.sessionId &&
      blockRuntime.blockToken === binding.token &&
      blockRuntime.scopeGeneration === scopeGenerationRef.current &&
      blockRuntime.allowReconnect;
    const isLiveOwner =
      isIndependentLiveOwner ||
      (effectiveStatus === "running" &&
        !!activeSession &&
        activeSession.status === "running" &&
        activeSession.activeBlockId === blockId);
    if (isLiveOwner) return false;
    const tailSessionId = Object.entries(interruptedOutputBlockRef.current).find(([, id]) => id === blockId)?.[0];
    if (!tailSessionId) return true;
    // A retained tail is recoverable only while it is not competing with a
    // newer active owner. Once that owner exists, the start boundary is the
    // release point and stale tail bytes must not be fetched into its view.
    const tailSession = sessionsRef.current.find((session) => session.id === tailSessionId);
    const tailOwnerId = sessionActiveBlockRef.current[tailSessionId];
    const tailOwnerStatus = tailOwnerId
      ? (blockStatusRef.current[tailOwnerId] ?? tailSession?.blocks.find((item) => item.id === tailOwnerId)?.status)
      : undefined;
    const hasLiveTailOwner =
      !!tailOwnerId &&
      tailOwnerStatus === "running" &&
      tailSession?.status === "running" &&
      tailSession.activeBlockId === tailOwnerId;
    return !hasLiveTailOwner;
  }, []);

  const syncTerminalRawOutput = useCallback(
    async (blockId: string): Promise<void> => {
      const runtime = xtermRefs.current.get(blockId);
      if (!runtime || runtime.disposed || !canRecoverTerminalRawOutput(blockId)) return;
      if (
        runtime.rawSynced &&
        hasAcknowledgedBlockTermRawTarget(runtime.rawAcknowledgedTargetCursor, runtime.rawTargetCursor)
      )
        return;
      if (runtime.rawSyncInFlight) {
        runtime.rawSyncPending = true;
        return runtime.rawSyncInFlight;
      }
      const now = Date.now();
      if (runtime.rawSyncStartedAt === 0) runtime.rawSyncStartedAt = now;
      if (now - runtime.rawSyncStartedAt >= RAW_SYNC_MAX_WAIT_MS) {
        // A completion target must never be declared settled merely because a
        // timeout elapsed. A later target update or remount can retry the
        // barrier request. Historical blocks without a target have no such
        // byte-level acknowledgement requirement.
        if (runtime.rawTargetCursor === null) {
          runtime.rawSynced = true;
          runtime.rawSettled = true;
        }
        runtime.rawSyncPending = false;
        return;
      }
      runtime.rawSyncPending = false;
      const requestedTarget = runtime.rawTargetCursor;
      const controller = new AbortController();
      runtime.rawSyncController = controller;
      const request = (async () => {
        try {
          const chunk = await blockTermApi.getRawOutput(blockId, controller.signal, runtime.rawCursor ?? undefined);
          const current = xtermRefs.current.get(blockId);
          if (
            controller.signal.aborted ||
            current !== runtime ||
            runtime.disposed ||
            !canRecoverTerminalRawOutput(blockId)
          )
            return;
          const resolved = resolveBlockTermTerminalWrite(runtime.rawCursor, chunk);
          if (resolved.reset || resolved.data.length > 0) {
            const written = await writeTerminalData(runtime, resolved.data, resolved.reset);
            if (
              !written ||
              controller.signal.aborted ||
              xtermRefs.current.get(blockId) !== runtime ||
              runtime.disposed ||
              !canRecoverTerminalRawOutput(blockId)
            )
              return;
            terminalRawRef.current[blockId] = resolved.reset
              ? appendBlockTermTerminalBytes(new Uint8Array(), resolved.data, runtime.maxPtySize)
              : appendBlockTermTerminalBytes(
                  terminalRawRef.current[blockId] || new Uint8Array(),
                  resolved.data,
                  runtime.maxPtySize
                );
          }
          runtime.rawCursor = resolved.cursor;
          // GET /raw-output crosses the recorder FIFO barrier before reading
          // segments. A successful response therefore acknowledges all raw
          // bytes preceding the captured completion watermark, even when the
          // response is empty or has no segment cursor headers.
          runtime.rawAcknowledgedTargetCursor = mergeBlockTermRawTarget(
            runtime.rawAcknowledgedTargetCursor,
            requestedTarget
          );
          rawAcknowledgedTargetCursorRef.current[blockId] = runtime.rawAcknowledgedTargetCursor;
          runtime.rawSettled = hasAcknowledgedBlockTermRawTarget(
            runtime.rawAcknowledgedTargetCursor,
            runtime.rawTargetCursor
          );
          runtime.rawSynced = runtime.rawSettled;
          if (!runtime.rawSettled) runtime.rawSyncPending = true;
        } catch {
          if (controller.signal.aborted) return;
          const current = xtermRefs.current.get(blockId);
          if (current !== runtime || runtime.disposed || !canRecoverTerminalRawOutput(blockId)) return;
          if (!runtime.rawFallbackApplied) {
            runtime.rawFallbackApplied = true;
            try {
              const snapshot = await ensureBlockOutputLoaded(blockId);
              if (
                controller.signal.aborted ||
                xtermRefs.current.get(blockId) !== runtime ||
                runtime.disposed ||
                !canRecoverTerminalRawOutput(blockId)
              )
                return;
              const snapshotBytes = new TextEncoder().encode(snapshot.value);
              const written = await writeTerminalData(runtime, snapshot.value, true);
              if (
                !written ||
                controller.signal.aborted ||
                xtermRefs.current.get(blockId) !== runtime ||
                runtime.disposed ||
                !canRecoverTerminalRawOutput(blockId)
              )
                return;
              runtime.rawCursor = null;
              terminalRawRef.current[blockId] = appendBlockTermTerminalBytes(
                new Uint8Array(),
                snapshotBytes,
                runtime.maxPtySize
              );
            } catch {
              // Keep the mounted terminal empty when neither raw nor legacy output is available.
            }
          }
          // Legacy text fallback is useful for display, but it does not cross
          // the raw recorder barrier and therefore cannot acknowledge a
          // completion target. Keep retrying a targeted sync until a future
          // request succeeds.
          if (runtime.rawTargetCursor === null) {
            runtime.rawSettled = true;
            runtime.rawSynced = true;
          } else {
            runtime.rawSettled = false;
            runtime.rawSynced = false;
            runtime.rawSyncPending = true;
          }
        } finally {
          if (runtime.rawSyncController === controller) runtime.rawSyncController = null;
          runtime.rawSyncInFlight = null;
          if (runtime.rawSyncPending && !runtime.disposed && !runtime.rawSynced && runtime.rawSyncTimer === null) {
            runtime.rawSyncPending = false;
            runtime.rawSyncTimer = setTimeout(() => {
              runtime.rawSyncTimer = null;
              void syncTerminalRawOutput(blockId);
            }, RAW_SYNC_INTERVAL_MS);
          }
        }
      })();
      runtime.rawSyncInFlight = request;
      return request;
    },
    [canRecoverTerminalRawOutput, ensureBlockOutputLoaded]
  );

  const requestTerminalRawSync = useCallback(
    (blockId: string, delay = 0) => {
      const runtime = xtermRefs.current.get(blockId);
      if (!runtime || runtime.disposed || runtime.rawSynced || !canRecoverTerminalRawOutput(blockId)) return;
      if (runtime.rawSyncInFlight) {
        runtime.rawSyncPending = true;
        return;
      }
      if (runtime.rawSyncTimer !== null) return;
      runtime.rawSyncTimer = setTimeout(() => {
        runtime.rawSyncTimer = null;
        void syncTerminalRawOutput(blockId);
      }, delay);
    },
    [canRecoverTerminalRawOutput, syncTerminalRawOutput]
  );

  // Queue callbacks are created before the terminal renderer callback. Keep a
  // live ref so completion/release events that arrive while no renderer is
  // mounted can trigger the eventual mount's raw recovery.
  requestTerminalRawSyncRef.current = requestTerminalRawSync;

  const resizeMountedTerminal = useCallback(
    (blockId: string) => {
      const runtime = xtermRefs.current.get(blockId);
      if (!runtime || runtime.disposed) return;
      resizeTerminalColumns(runtime);
      const binding = blockTokenRef.current[blockId];
      const sessionId =
        binding?.sessionId ||
        Object.entries(sessionActiveBlockRef.current).find(([, activeBlockId]) => activeBlockId === blockId)?.[0];
      if (!sessionId) return;
      const cols = runtime.terminal.cols;
      const rows = runtime.terminal.rows;
      if (binding?.sessionId === sessionId) {
        resizeBlockRuntime(sessionId, blockId, cols, rows);
        return;
      }
      resizeSession(sessionId, cols, rows);
    },
    [resizeBlockRuntime, resizeSession]
  );

  const hydrateMountedTerminal = useCallback((blockId: string, value: string) => {
    const runtime = xtermRefs.current.get(blockId);
    if (!runtime || runtime.disposed || runtime.hasLiveWrites) return;
    const block = sessionsRef.current.flatMap((session) => session.blocks).find((item) => item.id === blockId);
    const status = blockStatusRef.current[blockId] ?? block?.status;
    const binding = blockTokenRef.current[blockId];
    const ownerSessionId =
      binding?.sessionId ||
      Object.entries(sessionActiveBlockRef.current).find(([, activeBlockId]) => activeBlockId === blockId)?.[0];
    const ownerSession = ownerSessionId
      ? sessionsRef.current.find((session) => session.id === ownerSessionId)
      : undefined;
    const blockRuntime = blockRuntimesRef.current.get(blockId);
    const independentActive =
      !!binding &&
      binding.sessionId === ownerSessionId &&
      (status === "running" || status === "streaming") &&
      !!blockRuntime &&
      blockRuntime.scopeGeneration === scopeGenerationRef.current &&
      blockRuntime.allowReconnect;
    const active =
      independentActive ||
      (status === "running" && ownerSession?.status === "running" && ownerSession.activeBlockId === blockId);
    const retainedTail = status === "interrupted" && Object.values(interruptedOutputBlockRef.current).includes(blockId);
    if (!active && !retainedTail) return;
    const raw = terminalRawRef.current[blockId];
    if ((!raw || raw.length === 0) && !value) return;
    runtime.hasLiveWrites = true;
    const hydration = getBlockTermTerminalHydrationValue(raw, value);
    if (typeof hydration === "string") {
      terminalRawRef.current[blockId] = appendBlockTermTerminalBytes(
        new Uint8Array(),
        new TextEncoder().encode(hydration),
        runtime.maxPtySize
      );
    }
    void writeTerminalData(runtime, hydration);
  }, []);

  const mountTerminal = useCallback(
    (
      blockId: string,
      element: HTMLDivElement,
      _isActive: boolean,
      flexRows: boolean,
      maxRows: number,
      maxPtySize: number,
      isRunning: boolean,
      onMetrics: (usedRows: number, cellHeight: number | null) => void
    ) => {
      if (xtermRefs.current.has(blockId)) return;
      const binding = blockTokenRef.current[blockId];
      const ownerSessionId =
        binding?.sessionId ||
        Object.entries(sessionActiveBlockRef.current).find(([, activeBlockId]) => activeBlockId === blockId)?.[0];
      const ownerSession = ownerSessionId
        ? sessionsRef.current.find((session) => session.id === ownerSessionId)
        : undefined;
      const effectiveStatus =
        blockStatusRef.current[blockId] ??
        sessionsRef.current.flatMap((session) => session.blocks).find((block) => block.id === blockId)?.status;
      const blockRuntime = blockRuntimesRef.current.get(blockId);
      const independentActive =
        !!binding &&
        binding.sessionId === ownerSessionId &&
        (effectiveStatus === "running" || effectiveStatus === "streaming") &&
        !!blockRuntime &&
        blockRuntime.scopeGeneration === scopeGenerationRef.current &&
        blockRuntime.allowReconnect &&
        blockRuntime.ws?.readyState === WebSocket.OPEN;
      const active =
        independentActive ||
        (!!ownerSession &&
          ownerSession.status === "running" &&
          ownerSession.activeBlockId === blockId &&
          effectiveStatus === "running");
      const retainedTail =
        effectiveStatus === "interrupted" && Object.values(interruptedOutputBlockRef.current).includes(blockId);
      const terminal = new XTerm({
        allowProposedApi: true,
        convertEol: BLOCKTERM_TERMINAL_CONVERT_EOL,
        cursorBlink: active,
        disableStdin: !active,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        ...getBlockTermTerminalRowsOption(maxRows, DEFAULT_ROWS),
        scrollback: 4000,
        theme: getXtermTheme(theme),
      });
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(element);
      terminal.textarea?.setAttribute("id", `blockterm-output-${blockId}`);
      terminal.textarea?.setAttribute("name", `blockterm-output-${blockId}`);
      const initialUsedRows = getBlockTermTerminalInitialUsedRows(flexRows, isRunning, maxRows);
      const runtime: TerminalRuntime = {
        blockId,
        fitAddon,
        terminal,
        disposed: false,
        flexRows,
        isRunning,
        maxRows,
        maxPtySize,
        usedRows: initialUsedRows,
        cellHeight: null,
        onMetrics,
        rawCursor: null,
        rawTargetCursor: rawTargetCursorRef.current[blockId] ?? null,
        rawAcknowledgedTargetCursor: rawAcknowledgedTargetCursorRef.current[blockId] ?? null,
        rawSyncController: null,
        rawSyncInFlight: null,
        rawSyncPending: false,
        rawSyncTimer: null,
        rawSynced: false,
        rawSettled: false,
        rawSyncStartedAt: 0,
        rawFallbackApplied: false,
        hasLiveWrites: false,
        pendingWriteResolutions: new Set(),
      };
      terminal.onData((data) => {
        const currentBinding = blockTokenRef.current[blockId];
        const sessionId =
          currentBinding?.sessionId ||
          Object.entries(sessionActiveBlockRef.current).find(([, activeBlockId]) => activeBlockId === blockId)?.[0];
        if (!sessionId) return;
        const session = sessionsRef.current.find((item) => item.id === sessionId);
        if (!session || session.status === "connecting" || session.status === "exited" || session.status === "closed")
          return;
        const currentStatus =
          blockStatusRef.current[blockId] ?? session.blocks.find((item) => item.id === blockId)?.status;
        if (currentBinding?.sessionId === sessionId) {
          // Once a block has an explicit route, never send its input through
          // the parent session websocket while the block socket reconnects.
          if (currentStatus !== "running" && currentStatus !== "streaming") return;
          sendInput(sessionId, data, blockId, currentBinding.token);
          return;
        }
        if (session.activeBlockId !== blockId && sessionActiveBlockRef.current[sessionId] !== blockId) return;
        sendInput(sessionId, data);
      });
      xtermRefs.current.set(blockId, runtime);
      resizeTerminalColumns(runtime);
      getBlockTermTerminalTestHook()?.mount?.(blockId, terminal);
      const liveAttached = active || retainedTail;
      if (liveAttached) {
        const snapshot = outputStore.getSnapshot(blockId).value || outputRef.current[blockId] || "";
        const raw = terminalRawRef.current[blockId];
        if ((raw && raw.length > 0) || snapshot) {
          runtime.hasLiveWrites = true;
          const hydration = getBlockTermTerminalHydrationValue(raw, snapshot);
          if (typeof hydration === "string") {
            terminalRawRef.current[blockId] = appendBlockTermTerminalBytes(
              new Uint8Array(),
              new TextEncoder().encode(hydration),
              runtime.maxPtySize
            );
          }
          void writeTerminalData(runtime, hydration);
        }
      } else {
        requestTerminalRawSync(blockId);
      }
      setTimeout(() => {
        if (xtermRefs.current.get(blockId) !== runtime || runtime.disposed) return;
        resizeTerminalColumns(runtime);
      }, 50);
    },
    [outputStore, requestTerminalRawSync, sendInput, theme]
  );

  const unmountTerminal = useCallback((blockId: string) => {
    const runtime = xtermRefs.current.get(blockId);
    if (!runtime) return;
    disposeTerminalRuntime(runtime);
    xtermRefs.current.delete(blockId);
  }, []);

  useEffect(() => {
    for (const [blockId, runtime] of xtermRefs.current.entries()) {
      const binding = blockTokenRef.current[blockId];
      const sessionId =
        binding?.sessionId ||
        Object.entries(sessionActiveBlockRef.current).find(([, activeBlockId]) => activeBlockId === blockId)?.[0];
      const effectiveStatus =
        blockStatusRef.current[blockId] ??
        sessionsRef.current.flatMap((session) => session.blocks).find((block) => block.id === blockId)?.status;
      const blockRuntime = blockRuntimesRef.current.get(blockId);
      const independentActive =
        !!binding &&
        binding.sessionId === sessionId &&
        (effectiveStatus === "running" || effectiveStatus === "streaming") &&
        !!blockRuntime &&
        blockRuntime.scopeGeneration === scopeGenerationRef.current &&
        blockRuntime.allowReconnect &&
        blockRuntime.ws?.readyState === WebSocket.OPEN;
      const active =
        independentActive ||
        (!!sessionId &&
          sessionsRef.current.some(
            (session) =>
              session.id === sessionId &&
              session.status === "running" &&
              session.activeBlockId === blockId &&
              effectiveStatus === "running"
          ));
      runtime.terminal.options.theme = getXtermTheme(theme);
      runtime.terminal.options.disableStdin = !active;
      runtime.terminal.options.cursorBlink = active;
      runtime.isRunning = effectiveStatus === "running" || effectiveStatus === "streaming";
      setTimeout(() => {
        if (xtermRefs.current.get(blockId) !== runtime || runtime.disposed) return;
        resizeTerminalColumns(runtime);
      }, 0);
      if (canRecoverTerminalRawOutput(blockId)) {
        requestTerminalRawSync(blockId, runtime.hasLiveWrites && !runtime.rawSettled ? 100 : 0);
      }
    }
  }, [canRecoverTerminalRawOutput, theme, sessions, fullscreenBlockId, requestTerminalRawSync]);

  const topBarConfig = useMemo(() => {
    if (historyCenterOpen) {
      return {
        show: true,
        leftButtons: [
          {
            icon: <ArrowLeft size={18} />,
            title: t("terminal.backToTerminal"),
            onClick: () => setHistoryCenterOpen(false),
          },
        ],
        centerContent: <span className="text-sm font-medium text-ide-text">{t("plugin.blockTerm.historyCenter")}</span>,
        rightButtons: [],
      };
    }
    return {
      show: true,
      centerContent: (
        <div className="flex items-center gap-2 min-w-0">
          <Server size={16} className="text-ide-accent shrink-0" />
          <span className="text-sm font-medium text-ide-text shrink-0">{t("plugin.blockTerm.title")}</span>
          {workspaceSession && (
            <span className="max-w-[14rem] truncate text-xs text-ide-mute" title={workspaceDisplayName}>
              {workspaceDisplayName}
            </span>
          )}
          {activeSession && (
            <span className="text-xs text-ide-mute truncate hidden sm:inline">
              /{getCompactPath(activeSession.cwd)}
            </span>
          )}
        </div>
      ),
      rightButtons: [
        {
          icon: <Keyboard size={16} />,
          title: t("plugin.blockTerm.keymap.title"),
          onClick: () => setKeymapDialogOpen(true),
        },
        {
          icon: <Settings2 size={16} />,
          title: t("plugin.blockTerm.workspaceSettings.title"),
          onClick: () => setWorkspaceSettingsOpen(true),
        },
        {
          icon: <Plus size={16} />,
          title: t("plugin.blockTerm.newSession"),
          onClick: () => void createSession(),
        },
        {
          icon: <Server size={16} />,
          title: t("terminal.ssh.openDialog"),
          onClick: openSSHSessionDialog,
        },
      ],
    };
  }, [
    activeSession,
    createSession,
    historyCenterOpen,
    openSSHSessionDialog,
    t,
    workspaceDisplayName,
    workspaceSession,
  ]);

  usePageTopBar(topBarConfig, [topBarConfig]);

  if (historyCenterOpen) {
    return (
      <BlockTermHistoryCenter
        groupId={groupId}
        onBack={() => setHistoryCenterOpen(false)}
        onUseCommand={useHistoryCommand}
        onHistoryStarredChange={(entry, starred) => {
          const liveSession = sessionsRef.current.find((session) =>
            session.blocks.some((block) => block.id === entry.id)
          );
          if (liveSession) updateSessionBlock(liveSession.id, entry.id, { starred });
        }}
      />
    );
  }

  return (
    <div
      data-blockterm-page
      data-blockterm-render-session-id={activeSession?.id ?? undefined}
      className="h-full bg-ide-bg text-ide-text flex flex-col overflow-hidden"
      onFocusCapture={(event) => {
        const sessionId = activeSession?.id;
        if (!sessionId) return;
        const target = event.target as HTMLElement;
        if (target === commandInputRef.current) {
          sessionFocusTargetRef.current[sessionId] = { type: "input" };
          return;
        }
        const blockElement = target.closest<HTMLElement>("[data-block-id]");
        const blockId = blockElement?.getAttribute("data-block-id");
        if (blockId && event.currentTarget.contains(blockElement)) {
          const area = blockElement?.dataset.blocktermBlockArea === "sidebar" ? "sidebar" : "main";
          const focus = target.closest(".xterm")
            ? "terminal"
            : target.closest(".monaco-editor")
              ? "editor"
              : "container";
          sessionFocusTargetRef.current[sessionId] = { type: "block", blockId, area, focus };
        }
      }}
    >
      <div className="flex h-12 shrink-0 touch-pan-x items-center gap-2 overflow-x-auto border-b border-ide-border bg-ide-panel px-2 custom-scrollbar md:h-10">
        <button
          type="button"
          data-blockterm-workspace-settings
          data-drag-ignore
          className="flex h-12 min-w-0 max-w-[14rem] shrink-0 items-center gap-1.5 border-r border-ide-border pr-2 text-left text-xs text-ide-mute hover:text-ide-text md:h-7"
          title={t("plugin.blockTerm.workspaceSettings.title")}
          aria-label={t("plugin.blockTerm.workspaceSettings.title")}
          onClick={() => setWorkspaceSettingsOpen(true)}
        >
          <Layers size={13} className="shrink-0 text-ide-accent" />
          <span className="truncate">{workspaceDisplayName}</span>
        </button>
        {orderedSessions.map((session) => {
          const active = session.id === activeSession?.id;
          return (
            <div
              key={session.id}
              data-blockterm-session-id={session.id}
              data-blockterm-session-tab={session.id}
              {...sessionReorder.bindItem(session.id)}
              style={sessionReorder.getItemStyle(session.id)}
              className={`flex h-12 shrink-0 items-center border md:h-7 ${
                active
                  ? "border-ide-accent bg-ide-bg text-ide-accent"
                  : "border-ide-border bg-transparent text-ide-mute hover:bg-ide-bg hover:text-ide-text"
              } ${
                sessionReorder.activeId === session.id ? "z-10 cursor-grabbing opacity-95 shadow-sm" : ""
              } ${sessionReorder.overId === session.id ? "ring-1 ring-ide-accent" : ""}`}
            >
              <button
                type="button"
                aria-pressed={active}
                className="flex h-11 min-w-0 shrink-0 cursor-pointer select-none items-center gap-1 bg-transparent pl-2 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ide-accent md:h-full md:gap-2 md:pr-2"
                onClick={() => selectSession(session.id)}
              >
                <BlockTermSessionIcon icon={session.tabIcon} color={session.tabColor} size={13} />
                <span className="max-w-[120px] truncate">{session.name}</span>
                <span className="hidden sm:inline text-[10px] opacity-70">/{getCompactPath(session.cwd)}</span>
              </button>
              <button
                type="button"
                data-drag-ignore
                data-blockterm-session-settings={session.id}
                className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text md:size-auto md:p-0.5"
                title={t("plugin.blockTerm.sessionSettings.title")}
                aria-label={`${t("plugin.blockTerm.sessionSettings.title")}: ${session.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setSessionSettingsId(session.id);
                }}
              >
                <MoreHorizontal size={12} />
              </button>
              {sessions.length > 1 && (
                <button
                  type="button"
                  data-drag-ignore
                  className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-red-500 md:size-auto md:p-0.5"
                  title={`${t("common.close")} ${session.name}`}
                  aria-label={`${t("common.close")} ${session.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeSession(session.id);
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div ref={blockLayoutRef} className="flex min-h-0 flex-1">
        <div
          data-blockterm-main-pane
          className={`flex min-w-0 flex-1 flex-col ${sidebarDragging ? "select-none" : ""}`}
        >
          <div
            ref={blockScrollRef}
            data-blockterm-main-scroll
            className="min-h-0 flex-1 overflow-y-auto px-2 py-2 custom-scrollbar sm:px-4"
          >
            {!activeSession ? null : (
              <div ref={blockContentRef} className="flex w-full flex-col pb-4">
                <div className="flex min-h-11 items-center justify-end gap-1 border-b border-ide-border md:h-8 md:min-h-0">
                  {!rightSidebarOpen && (
                    <button
                      type="button"
                      data-blockterm-sidebar-open
                      className="flex size-11 items-center justify-center border border-ide-border text-ide-mute hover:bg-ide-panel hover:text-ide-text disabled:opacity-40 md:size-7"
                      title={t("plugin.blockTerm.openSidebar")}
                      aria-label={t("plugin.blockTerm.openSidebar")}
                      disabled={
                        !sidebarOpenCandidate ||
                        !isSidebarEligibleBlock(activeSession.id, sidebarOpenCandidate) ||
                        deletingBlockIds.has(sidebarOpenCandidate.id)
                      }
                      onClick={() => setSidebarOpen(activeSession.id, true)}
                    >
                      <PanelRightOpen size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    data-blockterm-filter-running
                    aria-pressed={showRunningOnly}
                    className={`flex size-11 items-center justify-center border md:size-7 ${
                      showRunningOnly
                        ? "border-ide-accent text-ide-accent bg-ide-accent/10"
                        : "border-ide-border text-ide-mute hover:text-ide-text hover:bg-ide-panel"
                    }`}
                    title={
                      showRunningOnly
                        ? t("plugin.blockTerm.disableRunningFilter")
                        : t("plugin.blockTerm.showRunningOnly")
                    }
                    onClick={() => applyBlockFilters(!showRunningOnly, showStarredOnly)}
                  >
                    <Activity size={13} />
                  </button>
                  <button
                    type="button"
                    data-blockterm-filter-starred
                    aria-pressed={showStarredOnly}
                    className={`flex size-11 items-center justify-center border md:size-7 ${
                      showStarredOnly
                        ? "border-ide-accent text-ide-accent bg-ide-accent/10"
                        : "border-ide-border text-ide-mute hover:text-ide-text hover:bg-ide-panel"
                    }`}
                    title={
                      showStarredOnly
                        ? t("plugin.blockTerm.disableStarredFilter")
                        : t("plugin.blockTerm.showStarredOnly")
                    }
                    onClick={() => applyBlockFilters(showRunningOnly, !showStarredOnly)}
                  >
                    <Star size={13} />
                  </button>
                  <button
                    type="button"
                    className={`flex min-h-11 min-w-11 items-center gap-1.5 border px-2 text-[11px] md:h-7 md:min-h-0 md:min-w-0 ${
                      showArchived
                        ? "border-ide-accent text-ide-accent bg-ide-accent/10"
                        : "border-ide-border text-ide-mute hover:text-ide-text hover:bg-ide-panel"
                    }`}
                    title={showArchived ? t("plugin.blockTerm.hideArchived") : t("plugin.blockTerm.showArchived")}
                    onClick={toggleArchivedVisibility}
                  >
                    <Archive size={13} />
                    <span className="hidden sm:inline">
                      {showArchived ? t("plugin.blockTerm.hideArchived") : t("plugin.blockTerm.showArchived")}
                    </span>
                  </button>
                </div>
                {visibleOrderedBlocks.length > 0 && (
                  <div
                    data-blockterm-virtual-list
                    className="relative w-full"
                    style={{ height: `${blockVirtualizer.getTotalSize()}px` }}
                  >
                    {virtualBlockRows.map((virtualRow) => {
                      const block = visibleOrderedBlocks[virtualRow.index];
                      if (!block) return null;
                      // A command can remain persisted as running when its PTY died
                      // before the end frame was received. Ended sessions are
                      // read-only, so never expose a stop action for that stale block.
                      const isIndependentPtyRunning = isCurrentIndependentBlockOwner(activeSession.id, block.id);
                      const isLegacyPtyRunning =
                        block.status === "running" &&
                        activeSession.status === "running" &&
                        activeSession.activeBlockId === block.id &&
                        sessionActiveBlockRef.current[activeSession.id] === block.id;
                      const isPtyRunning = isIndependentPtyRunning || isLegacyPtyRunning;
                      const isModelStreaming =
                        block.renderer === "openai" &&
                        canControlBlockTermModelStream(block.status, unavailableModelStreams.has(block.id));
                      const isRunning = isPtyRunning || isModelStreaming;
                      const isDeleting = deletingBlockIds.has(block.id);
                      const isSelected = activeSession.selectedBlockId === block.id;
                      const duration = isDeleting
                        ? t("plugin.blockTerm.deletingBlock")
                        : block.finishedAt
                          ? `${((block.finishedAt - block.startedAt) / 1000).toFixed(1)}s`
                          : isRunning
                            ? t("plugin.blockTerm.running")
                            : "";
                      const lifecycleMetadata = block.kind === "command" ? getBlockTermLifecycleMetadata(block) : [];
                      return (
                        <div
                          key={block.id}
                          data-index={virtualRow.index}
                          ref={(element) => measureBlockElement(element, activeSession.id, block)}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <div
                            data-block-id={block.id}
                            data-blockterm-block-area="main"
                            data-blockterm-status={block.status}
                            data-blockterm-deleting={isDeleting || undefined}
                            ref={(element) => {
                              if (element) blockElementRefs.current.set(block.id, element);
                              else blockElementRefs.current.delete(block.id);
                            }}
                            role="button"
                            aria-pressed={isSelected}
                            tabIndex={0}
                            onClick={(event) => {
                              const selection = window.getSelection();
                              if (
                                selection &&
                                !selection.isCollapsed &&
                                selection.toString().trim() &&
                                selection.anchorNode &&
                                event.currentTarget.contains(selection.anchorNode)
                              )
                                return;
                              selectBlock(activeSession.id, block.id);
                            }}
                            onKeyDown={(event) => {
                              // Nested controls own their keyboard events. Only handle
                              // block navigation when the block itself has focus.
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                selectBlock(activeSession.id, block.id);
                                return;
                              }
                              if (
                                event.key === "ArrowUp" ||
                                event.key === "ArrowDown" ||
                                event.key === "Home" ||
                                event.key === "End" ||
                                event.key === "PageUp" ||
                                event.key === "PageDown"
                              ) {
                                event.preventDefault();
                                const key = event.key as BlockNavigationKey;
                                const nextId = moveSelection(activeSession.id, block.id, key);
                                if (nextId) {
                                  const scrollPosition = key === "Home" ? "start" : key === "End" ? "end" : "nearest";
                                  focusBlock(nextId, scrollPosition);
                                }
                              }
                              if (event.key === "Delete" && !isRunning && !isDeleting) {
                                event.preventDefault();
                                if (!event.repeat) deleteBlock(block.id, activeSession.id);
                              }
                            }}
                            className={`group relative border-b border-ide-border bg-transparent outline-none transition-colors hover:bg-ide-panel/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ide-accent ${
                              isSelected ? "bg-ide-panel/50 ring-1 ring-inset ring-ide-accent/50" : ""
                            } ${block.archived ? "opacity-60" : ""}`}
                          >
                            <span
                              aria-hidden="true"
                              data-blockterm-status-rail={block.status}
                              className={`absolute inset-y-0 left-0 w-0.5 ${
                                block.kind === "note" ? "bg-ide-border" : blockStatusRailClass(block.status)
                              }`}
                            />
                            <div className="flex flex-wrap items-start gap-2 py-2 pl-4 pr-1 md:flex-nowrap">
                              <span className="text-[11px] text-ide-mute font-mono pt-0.5 shrink-0">
                                {block.kind === "note" ? "#" : "~ ›"}
                              </span>
                              <div className="flex-1 min-w-0">
                                {block.kind === "note" ? (
                                  <pre className="select-text text-xs sm:text-sm whitespace-pre-wrap break-words text-ide-text">
                                    {block.text}
                                  </pre>
                                ) : (
                                  <>
                                    <pre className="select-text text-xs sm:text-sm whitespace-pre-wrap break-words font-mono text-ide-text">
                                      {block.command}
                                    </pre>
                                    {lifecycleMetadata.length > 0 && (
                                      <div
                                        data-blockterm-lifecycle-metadata
                                        className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] leading-4 font-mono text-ide-mute"
                                      >
                                        {lifecycleMetadata.map((item) => (
                                          <span key={item}>{item}</span>
                                        ))}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                              <div className="flex w-full min-w-0 shrink-0 items-center justify-end gap-0.5 md:w-auto">
                                {block.kind !== "note" && (
                                  <span className={`hidden sm:inline text-[11px] ${blockStatusClass(block.status)}`}>
                                    {duration}
                                    {block.exitCode !== null ? ` · ${block.exitCode}` : ""}
                                  </span>
                                )}
                                {isRunning ? (
                                  <button
                                    type="button"
                                    className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-yellow-500 md:size-7"
                                    title={t("plugin.blockTerm.stop")}
                                    onClick={() =>
                                      isModelStreaming
                                        ? void stopModelRun(block.id)
                                        : stopSession(activeSession.id, block.id)
                                    }
                                  >
                                    <Square size={14} />
                                  </button>
                                ) : block.kind === "command" && block.renderer !== "openai" ? (
                                  <button
                                    type="button"
                                    className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text disabled:opacity-40 md:size-7"
                                    title={t("plugin.blockTerm.rerun")}
                                    onClick={() => void restartBlock(activeSession.id, block)}
                                    disabled={isDeleting || activeSession.status !== "ready"}
                                  >
                                    <RotateCcw size={14} />
                                  </button>
                                ) : null}
                                {block.kind !== "note" && (
                                  <button
                                    type="button"
                                    className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text disabled:cursor-wait disabled:opacity-40 md:size-7"
                                    title={
                                      block.collapsed ? t("plugin.blockTerm.expand") : t("plugin.blockTerm.collapse")
                                    }
                                    disabled={isDeleting}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      updateBlockState(activeSession.id, block.id, { collapsed: !block.collapsed });
                                    }}
                                  >
                                    {block.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                                  </button>
                                )}
                                {block.kind === "command" && (
                                  <BlockTermRendererMenu
                                    block={block}
                                    disabled={isRunning || isDeleting}
                                    onSelect={(renderer) => switchBlockRenderer(activeSession.id, block, renderer)}
                                  />
                                )}
                                {isSelected &&
                                  (activeSession.status === "ready" || activeSession.status === "running") &&
                                  block.kind !== "note" &&
                                  !block.archived &&
                                  !isRunning && (
                                    <button
                                      type="button"
                                      data-blockterm-line-ai-open={block.id}
                                      className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text disabled:opacity-40 md:size-7"
                                      title={t("plugin.blockTerm.lineAI.ask")}
                                      aria-label={t("plugin.blockTerm.lineAI.ask")}
                                      disabled={isDeleting}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openLineAI(activeSession.id, block.id);
                                      }}
                                    >
                                      <Sparkles size={14} />
                                    </button>
                                  )}
                                <button
                                  type="button"
                                  data-blockterm-sidebar-add={block.id}
                                  className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text disabled:opacity-40 md:size-7"
                                  title={t("plugin.blockTerm.moveToSidebar")}
                                  aria-label={t("plugin.blockTerm.moveToSidebar")}
                                  disabled={!isSidebarEligibleBlock(activeSession.id, block) || isDeleting}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    moveBlockToSidebar(activeSession.id, block.id);
                                  }}
                                >
                                  <PanelRight size={14} />
                                </button>
                                <BlockTermMoreMenu
                                  block={block}
                                  isRunning={isRunning}
                                  isDeleting={isDeleting}
                                  copied={copiedId === block.id}
                                  copiedFullOutput={copiedFullOutputId === block.id}
                                  onCopyOutput={() => void copyBlockOutput(block)}
                                  onCopyFullOutput={() => void copyFullBlockOutput(block)}
                                  onTogglePinned={() => toggleBlockPinned(activeSession.id, block.id, !block.pinned)}
                                  onSaveBookmark={() => openBookmarkCreate(block.command)}
                                  onToggleStarred={() =>
                                    !deletingBlockIdsRef.current.has(block.id) &&
                                    updateBlockState(activeSession.id, block.id, { starred: !block.starred })
                                  }
                                  onToggleArchived={() =>
                                    toggleBlockArchived(activeSession.id, block.id, !block.archived)
                                  }
                                  onDelete={() => deleteBlock(block.id, activeSession.id)}
                                />
                              </div>
                            </div>
                            {block.kind !== "note" && !block.collapsed && (
                              <BlockTermOutputView
                                block={block}
                                fullscreen={fullscreenBlockId === block.id}
                                isActive={isPtyRunning}
                                runtimeType={block.runtimeType}
                                terminalId={activeSession.id}
                                outputStore={outputStore}
                                loadOutput={ensureBlockOutputLoaded}
                                onMountTerminal={mountTerminal}
                                onUnmountTerminal={unmountTerminal}
                                onHydrateTerminal={hydrateMountedTerminal}
                                onResizeTerminal={resizeMountedTerminal}
                                onModelEvent={(blockId, patch) => handleModelEvent(activeSession.id, blockId, patch)}
                                onModelStreamUnavailable={handleModelStreamUnavailable}
                                onToggleFullscreen={() =>
                                  setFullscreenBlockId((current) => (current === block.id ? null : block.id))
                                }
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          {activeSession && (
            <div
              ref={commandDockRef}
              data-blockterm-command-dock
              className="relative z-20 shrink-0 border-t border-ide-border bg-ide-panel"
            >
              <div className="border-l-2 border-transparent bg-ide-panel focus-within:border-ide-accent">
                <div className="flex flex-wrap items-start gap-2 px-3 py-2 md:flex-nowrap">
                  <span className="text-[11px] text-ide-mute font-mono pt-1 shrink-0">~ ›</span>
                  <div className="relative flex-1 min-w-0">
                    {completionState?.sessionId === activeSession.id && (
                      <div
                        id={`blockterm-completions-${activeSession.id}`}
                        role="listbox"
                        aria-label={t("plugin.blockTerm.completions")}
                        className="absolute inset-x-0 bottom-full z-30 mb-1 max-h-52 overflow-y-auto custom-scrollbar border border-ide-border bg-ide-panel shadow-sm"
                      >
                        {completionState.loading ? (
                          <div className="h-8 flex items-center justify-center text-ide-mute">
                            <Loader2
                              size={14}
                              className="animate-spin"
                              aria-label={t("plugin.blockTerm.loadingCompletions")}
                            />
                          </div>
                        ) : (
                          completionState.candidates.map((candidate, index) => {
                            const selected = completionState.selectedIndex === index;
                            const commandCandidate = completionState.commandCandidates?.[index];
                            const kind = candidate.isDirectory
                              ? "directory"
                              : commandCandidate
                                ? "command"
                                : completionState.context.kind;
                            const kindLabel = t(`plugin.blockTerm.completionKind.${kind}`);
                            return (
                              <button
                                key={`${kind}:${candidate.value}`}
                                id={`blockterm-completion-${activeSession.id}-${index}`}
                                ref={(element) => {
                                  if (element) completionOptionRefs.current.set(index, element);
                                  else completionOptionRefs.current.delete(index);
                                }}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                tabIndex={-1}
                                className={`flex min-h-11 w-full items-center gap-2 border-b border-ide-border px-2 text-left font-mono text-xs last:border-b-0 md:h-8 md:min-h-0 ${
                                  selected
                                    ? "bg-ide-bg text-ide-accent"
                                    : "bg-transparent text-ide-text hover:bg-ide-bg"
                                }`}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => applyCompletionCandidate(candidate)}
                              >
                                <span className="shrink-0 text-ide-mute" title={kindLabel}>
                                  {candidate.isDirectory ? (
                                    <Folder size={13} />
                                  ) : completionState.context.kind === "command" ? (
                                    <Terminal size={13} />
                                  ) : (
                                    <File size={13} />
                                  )}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{candidate.display}</span>
                                {commandCandidate?.description && (
                                  <span className="max-w-[52%] shrink-0 truncate text-ide-mute">
                                    {commandCandidate.description}
                                  </span>
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                    {ghostCompletion?.sessionId === activeSession.id &&
                      ghostCompletion.scopeGeneration === scopeGenerationRef.current &&
                      ghostCompletion.context.draft === activeSession.draft &&
                      ghostCompletion.text && (
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words px-0 text-sm leading-normal font-mono"
                        >
                          <span className="text-transparent">{activeSession.draft}</span>
                          <span className="text-ide-mute/60">{ghostCompletion.text}</span>
                        </div>
                      )}
                    <textarea
                      key={activeSession.id}
                      id={`blockterm-command-${activeSession.id}`}
                      name="blockterm-command"
                      ref={commandInputRef}
                      role="combobox"
                      aria-label={t("plugin.blockTerm.placeholder")}
                      aria-autocomplete="list"
                      value={activeSession.draft}
                      onChange={(event) => {
                        setDraft(activeSession.id, event.target.value);
                        updateGhostCompletion(activeSession.id, event.target.value, event.currentTarget.selectionStart);
                      }}
                      onClick={(event) => {
                        closeCompletion();
                        updateGhostCompletion(
                          activeSession.id,
                          event.currentTarget.value,
                          event.currentTarget.selectionStart
                        );
                      }}
                      onSelect={(event) => {
                        updateGhostCompletion(
                          activeSession.id,
                          event.currentTarget.value,
                          event.currentTarget.selectionStart
                        );
                      }}
                      onBlur={() => closeCompletion()}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        const currentCompletion =
                          completionState?.sessionId === activeSession.id ? completionState : null;
                        const noModifiers = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
                        const currentGhost =
                          ghostCompletion?.sessionId === activeSession.id &&
                          ghostCompletion.scopeGeneration === scopeGenerationRef.current &&
                          ghostCompletion.context.draft === event.currentTarget.value &&
                          ghostCompletion.context.cursor === event.currentTarget.selectionStart &&
                          event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
                          ghostCompletion.text
                            ? ghostCompletion
                            : null;
                        if (currentGhost && event.key === "ArrowRight" && noModifiers) {
                          event.preventDefault();
                          applyCompletionEdit(activeSession.id, {
                            draft: `${event.currentTarget.value}${currentGhost.text}`,
                            cursor: event.currentTarget.value.length + currentGhost.text.length,
                          });
                          return;
                        }
                        if (currentCompletion && event.key === "Escape") {
                          event.preventDefault();
                          closeCompletion();
                          return;
                        }
                        if (
                          currentCompletion &&
                          !currentCompletion.loading &&
                          currentCompletion.candidates.length > 0
                        ) {
                          if ((event.key === "ArrowUp" || event.key === "ArrowDown") && noModifiers) {
                            event.preventDefault();
                            setCompletionState((current) =>
                              current
                                ? {
                                    ...current,
                                    selectedIndex: moveBlockTermCompletionSelection(
                                      current.selectedIndex,
                                      current.candidates.length,
                                      event.key === "ArrowUp" ? "previous" : "next"
                                    ),
                                  }
                                : current
                            );
                            return;
                          }
                          if ((event.key === "Tab" || event.key === "Enter") && noModifiers) {
                            event.preventDefault();
                            applyCompletionCandidate(
                              currentCompletion.candidates[currentCompletion.selectedIndex] ||
                                currentCompletion.candidates[0]
                            );
                            return;
                          }
                        }
                        if (event.key === "Tab" && noModifiers) {
                          const target = event.currentTarget;
                          if (target.selectionStart !== target.selectionEnd) return;
                          event.preventDefault();
                          void requestCompletion(activeSession.id, target);
                          return;
                        }
                        const inputShortcut = resolveBlockTermInputShortcut(event, blockTermKeymap);
                        if (inputShortcut) {
                          const target = event.currentTarget;
                          event.preventDefault();
                          if (inputShortcut === "history-previous" || inputShortcut === "history-next") {
                            closeCompletion();
                            handleHistoryKey(
                              activeSession.id,
                              inputShortcut === "history-previous" ? "ArrowUp" : "ArrowDown"
                            );
                            return;
                          }
                          if (inputShortcut === "toggle-expanded") {
                            closeCompletion();
                            captureBlockScrollBottomAnchor(activeSession.id);
                            setInputExpandedBySession((current) => ({
                              ...current,
                              [activeSession.id]: !current[activeSession.id],
                            }));
                            return;
                          }
                          if (inputShortcut === "open-history") {
                            closeCompletion();
                            setHistoryDialogOpen(true);
                            return;
                          }
                          if (inputShortcut === "submit") {
                            closeCompletion();
                            void runCommand(activeSession.id, activeSession.draft);
                            return;
                          }
                          if (inputShortcut === "paste") {
                            closeCompletion();
                            const sessionId = activeSession.id;
                            const clipboard = navigator.clipboard;
                            if (!clipboard?.readText) return;
                            void clipboard
                              .readText()
                              .then((text) => {
                                const textarea = commandInputRef.current;
                                if (!textarea || activeSessionIdRef.current !== sessionId) return;
                                applyCompletionEdit(
                                  sessionId,
                                  insertBlockTermInputText(
                                    textarea.value,
                                    textarea.selectionStart,
                                    textarea.selectionEnd,
                                    text || ""
                                  )
                                );
                              })
                              .catch(() => {});
                            return;
                          }
                          const edit =
                            inputShortcut === "clear"
                              ? clearBlockTermInput()
                              : inputShortcut === "cut-line-left"
                                ? cutBlockTermInputLineLeft(target.value, target.selectionStart)
                                : inputShortcut === "cut-word-left"
                                  ? cutBlockTermInputWordLeft(target.value, target.selectionStart)
                                  : insertBlockTermInputText(
                                      target.value,
                                      target.selectionStart,
                                      target.selectionEnd,
                                      "\n"
                                    );
                          if (edit.clipboardText !== undefined) {
                            const clipboard = navigator.clipboard;
                            if (clipboard?.writeText) void clipboard.writeText(edit.clipboardText).catch(() => {});
                          }
                          applyCompletionEdit(activeSession.id, edit);
                          return;
                        }
                        if (
                          (event.key === "ArrowUp" || event.key === "ArrowDown") &&
                          !event.shiftKey &&
                          !event.ctrlKey &&
                          !event.metaKey
                        ) {
                          const target = event.currentTarget;
                          const atStart = event.key === "ArrowUp" && target.selectionStart === 0;
                          const atEnd = event.key === "ArrowDown" && target.selectionEnd === target.value.length;
                          if (atStart || atEnd) {
                            event.preventDefault();
                            handleHistoryKey(activeSession.id, event.key);
                            return;
                          }
                        }
                      }}
                      disabled={activeSession.status !== "ready" && activeSession.status !== "running"}
                      rows={getBlockTermInputRows(
                        activeSession.draft,
                        Boolean(inputExpandedBySession[activeSession.id])
                      )}
                      aria-expanded={completionState?.sessionId === activeSession.id}
                      aria-controls={
                        completionState?.sessionId === activeSession.id
                          ? `blockterm-completions-${activeSession.id}`
                          : undefined
                      }
                      aria-activedescendant={
                        completionState?.sessionId === activeSession.id && !completionState.loading
                          ? `blockterm-completion-${activeSession.id}-${completionState.selectedIndex}`
                          : undefined
                      }
                      className="relative z-10 block max-h-[min(32dvh,12rem)] min-h-16 w-full resize-none overflow-y-auto bg-transparent text-base font-mono text-ide-text outline-none disabled:opacity-60 md:text-sm"
                      placeholder={t("plugin.blockTerm.placeholder")}
                    />
                  </div>
                  <div className="flex w-full shrink-0 justify-end gap-2 md:w-auto md:justify-start">
                    <button
                      type="button"
                      className="flex size-11 shrink-0 items-center justify-center border border-ide-border text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-8"
                      title={t("plugin.blockTerm.bookmarks")}
                      aria-label={t("plugin.blockTerm.bookmarks")}
                      onClick={openBookmarkManager}
                    >
                      <Bookmark size={14} />
                    </button>
                    <button
                      type="button"
                      className="flex size-11 shrink-0 items-center justify-center border border-ide-border text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-8"
                      title={t("plugin.blockTerm.commandHistory")}
                      aria-label={t("plugin.blockTerm.commandHistory")}
                      onClick={() => {
                        closeCompletion();
                        setHistoryDialogOpen(true);
                      }}
                    >
                      <History size={14} />
                    </button>
                    <button
                      type="button"
                      className="flex min-h-11 min-w-11 items-center gap-1.5 border border-ide-border bg-ide-accent px-2 text-ide-on-accent disabled:bg-ide-border disabled:text-ide-mute disabled:opacity-50 md:h-8 md:min-h-0 md:min-w-0"
                      onClick={() => void runCommand(activeSession.id, activeSession.draft)}
                      disabled={activeSession.status !== "ready" || !activeSession.draft.trim()}
                    >
                      <Play size={14} />
                      <span className="hidden sm:inline text-xs">{t("plugin.blockTerm.run")}</span>
                    </button>
                  </div>
                </div>
                <div className="px-3 pb-2 text-[11px] text-ide-mute font-mono truncate">
                  {activeSession.status === "connecting"
                    ? t("plugin.blockTerm.connecting")
                    : activeSession.status === "running"
                      ? t("plugin.blockTerm.running")
                      : activeSession.status === "exited" || activeSession.status === "closed"
                        ? t("plugin.blockTerm.disconnected")
                        : t("plugin.blockTerm.ready")}{" "}
                  · {activeSession.cwd}
                </div>
              </div>
            </div>
          )}
        </div>
        {activeSession && rightSidebarOpen && (
          <>
            <div
              data-blockterm-sidebar-resizer
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-valuemin={200}
              aria-valuemax={Math.max(200, blockViewportWidth - 200)}
              aria-valuenow={sidebarPaneWidth}
              aria-label={t("plugin.blockTerm.resizeSidebar")}
              aria-disabled={Boolean(!lineAISidebarOpen && sidebarBlock && deletingBlockIds.has(sidebarBlock.id))}
              className={`w-1 shrink-0 bg-ide-border touch-none ${
                !lineAISidebarOpen && sidebarBlock && deletingBlockIds.has(sidebarBlock.id)
                  ? "cursor-not-allowed opacity-40"
                  : "cursor-col-resize hover:bg-ide-accent"
              }`}
              onPointerDown={(event) => handleSidebarResizeStart(event, activeSession.id)}
              onPointerMove={handleSidebarResizeMove}
              onPointerUp={handleSidebarResizeEnd}
              onPointerCancel={handleSidebarResizeEnd}
            >
              <GripVertical size={12} className="mx-auto mt-2 text-ide-mute" />
            </div>
            <aside
              data-blockterm-sidebar
              aria-label={t("plugin.blockTerm.sidebar")}
              className="min-w-0 shrink-0 border-l border-ide-border bg-ide-bg flex flex-col"
              style={{ width: `${sidebarPaneWidth}px` }}
            >
              {lineAISidebarOpen && activeLineAISource ? (
                <BlockTermLineAIPanel
                  key={`${activeSession.id}:${activeLineAISource.id}`}
                  active
                  terminalId={activeSession.id}
                  sourceBlock={activeLineAISource}
                  onClose={() => closeLineAI(activeSession.id)}
                  onRefill={refillLineAICommand}
                  allocateLineNum={() => allocateLineAILineNum(activeSession.id)}
                />
              ) : (
                <>
                  <div className="flex min-h-11 w-full min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-ide-border bg-ide-panel pl-2 md:h-9 md:min-h-0 md:overflow-visible md:px-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-ide-text">
                      {sidebarBlock?.command || sidebarBlock?.text || t("plugin.blockTerm.sidebar")}
                    </span>
                    {sidebarBlock &&
                      activeSession.selectedBlockId === sidebarBlock.id &&
                      (activeSession.status === "ready" || activeSession.status === "running") &&
                      sidebarBlock.kind !== "note" &&
                      !isActiveBlockStatus(sidebarBlock.status) &&
                      !deletingBlockIds.has(sidebarBlock.id) && (
                        <button
                          type="button"
                          data-blockterm-line-ai-open={sidebarBlock.id}
                          className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text md:size-auto md:p-1.5"
                          title={t("plugin.blockTerm.lineAI.ask")}
                          aria-label={t("plugin.blockTerm.lineAI.ask")}
                          onClick={() => openLineAI(activeSession.id, sidebarBlock.id)}
                        >
                          <Sparkles size={14} />
                        </button>
                      )}
                    <button
                      type="button"
                      data-blockterm-sidebar-width={BLOCKTERM_SIDEBAR_DEFAULT_WIDTH}
                      aria-pressed={legalizedActiveView.sidebar.width === BLOCKTERM_SIDEBAR_DEFAULT_WIDTH}
                      className={`hidden shrink-0 items-center justify-center hover:bg-ide-bg md:flex md:size-auto md:p-1.5 ${
                        legalizedActiveView.sidebar.width === BLOCKTERM_SIDEBAR_DEFAULT_WIDTH
                          ? "text-ide-accent"
                          : "text-ide-mute hover:text-ide-text"
                      }`}
                      title={t("plugin.blockTerm.sidebarHalfWidth")}
                      aria-label={t("plugin.blockTerm.sidebarHalfWidth")}
                      disabled={Boolean(sidebarBlock && deletingBlockIds.has(sidebarBlock.id))}
                      onClick={() => setSidebarWidth(activeSession.id, BLOCKTERM_SIDEBAR_DEFAULT_WIDTH)}
                    >
                      <Columns2 size={14} />
                    </button>
                    <button
                      type="button"
                      data-blockterm-sidebar-width={BLOCKTERM_SIDEBAR_FIXED_WIDTH}
                      aria-pressed={legalizedActiveView.sidebar.width === BLOCKTERM_SIDEBAR_FIXED_WIDTH}
                      className={`hidden shrink-0 items-center justify-center hover:bg-ide-bg md:flex md:size-auto md:p-1.5 ${
                        legalizedActiveView.sidebar.width === BLOCKTERM_SIDEBAR_FIXED_WIDTH
                          ? "text-ide-accent"
                          : "text-ide-mute hover:text-ide-text"
                      }`}
                      title={t("plugin.blockTerm.sidebarFixedWidth")}
                      aria-label={t("plugin.blockTerm.sidebarFixedWidth")}
                      disabled={Boolean(sidebarBlock && deletingBlockIds.has(sidebarBlock.id))}
                      onClick={() => setSidebarWidth(activeSession.id, BLOCKTERM_SIDEBAR_FIXED_WIDTH)}
                    >
                      <PanelRight size={14} />
                    </button>
                    <button
                      type="button"
                      data-blockterm-sidebar-remove
                      className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-40 md:size-auto md:p-1.5"
                      title={t("plugin.blockTerm.moveToMain")}
                      aria-label={t("plugin.blockTerm.moveToMain")}
                      disabled={!sidebarBlock || deletingBlockIds.has(sidebarBlock.id)}
                      onClick={() => {
                        if (sidebarBlock) moveBlockToMain(activeSession.id, sidebarBlock.id);
                      }}
                    >
                      <PanelRightOpen size={14} />
                    </button>
                    <button
                      type="button"
                      data-blockterm-sidebar-close
                      className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-40 md:size-auto md:p-1.5"
                      title={t("plugin.blockTerm.closeSidebar")}
                      aria-label={t("plugin.blockTerm.closeSidebar")}
                      disabled={Boolean(sidebarBlock && deletingBlockIds.has(sidebarBlock.id))}
                      onClick={() => setSidebarOpen(activeSession.id, false)}
                    >
                      <PanelRightClose size={14} />
                    </button>
                  </div>
                  <div
                    key={`${activeSession.id}:${sidebarBlock?.id ?? "empty"}`}
                    data-block-id={sidebarBlock?.id}
                    data-blockterm-block-area="sidebar"
                    ref={(element) => {
                      if (!sidebarBlock) return;
                      if (element) sidebarBlockElementRefs.current.set(sidebarBlock.id, element);
                      else sidebarBlockElementRefs.current.delete(sidebarBlock.id);
                    }}
                    role={sidebarBlock ? "button" : undefined}
                    tabIndex={sidebarBlock ? 0 : undefined}
                    onClick={(event) => {
                      if (!sidebarBlock) return;
                      const selection = window.getSelection();
                      if (
                        selection &&
                        !selection.isCollapsed &&
                        selection.toString().trim() &&
                        selection.anchorNode &&
                        event.currentTarget.contains(selection.anchorNode)
                      )
                        return;
                      selectBlock(activeSession.id, sidebarBlock.id);
                    }}
                    onKeyDown={(event) => {
                      if (!sidebarBlock || event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectBlock(activeSession.id, sidebarBlock.id);
                      }
                    }}
                    className="min-h-0 flex-1 overflow-y-auto custom-scrollbar outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ide-accent"
                  >
                    {sidebarBody?.kind === "note" ? (
                      <pre
                        data-blockterm-sidebar-note
                        className="select-text p-3 text-xs sm:text-sm whitespace-pre-wrap break-words text-ide-text"
                      >
                        {sidebarBody.text}
                      </pre>
                    ) : sidebarBlock ? (
                      <BlockTermOutputView
                        block={sidebarBlock}
                        fullscreen={false}
                        isActive={false}
                        runtimeType={sidebarBlock.runtimeType}
                        terminalId={activeSession.id}
                        outputStore={outputStore}
                        loadOutput={ensureBlockOutputLoaded}
                        onMountTerminal={mountTerminal}
                        onUnmountTerminal={unmountTerminal}
                        onHydrateTerminal={hydrateMountedTerminal}
                        onResizeTerminal={resizeMountedTerminal}
                        onModelEvent={(blockId, patch) => handleModelEvent(activeSession.id, blockId, patch)}
                        onModelStreamUnavailable={handleModelStreamUnavailable}
                        onToggleFullscreen={() => setFullscreenBlockId(sidebarBlock.id)}
                      />
                    ) : (
                      <div className="p-3 text-xs text-ide-mute">{t("plugin.blockTerm.sidebarEmpty")}</div>
                    )}
                  </div>
                </>
              )}
            </aside>
          </>
        )}
      </div>
      <BlockTermHistoryDialog
        open={historyDialogOpen}
        onOpenChange={setHistoryDialogOpen}
        onOpenCenter={() => {
          setHistoryDialogOpen(false);
          setHistoryCenterOpen(true);
        }}
        onSelect={(command) => {
          if (activeSession) setDraft(activeSession.id, command);
        }}
      />
      <BlockTermKeymapDialog open={keymapDialogOpen} onOpenChange={setKeymapDialogOpen} />
      <SSHConnectionDialog
        open={sshDialogOpen}
        onOpenChange={handleSSHDialogOpenChange}
        onCreateTerminal={createSSHSession}
        selectionOnly={sshSelectionSessionId !== null}
        onSelectProfile={selectSSHConnection}
      />
      <BlockTermWorkspaceSettingsDialog
        open={workspaceSettingsOpen}
        initialName={workspaceDisplayName}
        onOpenChange={setWorkspaceSettingsOpen}
        onSave={handleSaveWorkspaceSettings}
      />
      <BlockTermSessionSettingsDialog
        open={sessionSettingsId !== null}
        initialValues={
          sessionSettingsId
            ? (() => {
                const session = sessions.find((item) => item.id === sessionSettingsId);
                return session
                  ? {
                      name: session.name,
                      tabColor: normalizeBlockTermTabColor(session.tabColor),
                      tabIcon: normalizeBlockTermTabIcon(session.tabIcon),
                    }
                  : null;
              })()
            : null
        }
        onOpenChange={(open) => {
          if (!open) setSessionSettingsId(null);
        }}
        onSave={handleSaveSessionSettings}
      />
      <BlockTermBookmarkDialog
        open={bookmarkDialogOpen}
        initialCommand={bookmarkInitialCommand}
        onOpenChange={(open) => {
          setBookmarkDialogOpen(open);
          if (!open) setBookmarkInitialCommand(undefined);
        }}
        onUseCommand={useBookmarkCommand}
      />
    </div>
  );
};

export default BlockTermPage;
