import "@xterm/xterm/css/xterm.css";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Copy,
  CornerDownLeft,
  Download,
  Ellipsis,
  History as HistoryIcon,
  Plus,
  RotateCcw,
  Search,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type FileInfo, fileApi } from "@/api/file";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { useFrameStore } from "@/stores/frame-store";
import { resolveBlockTermCommandCompletion } from "../terminal/blockterm-command-completion";
import { BlockActionMenu } from "./action-menu";
import { type Block, coreApi, decode, type Session, type TerminalEvent } from "./api";
import { blockNavigationKey, navigateBlock } from "./block-navigation";
import { BlockOutput, HighlightedCommand } from "./block-output";
import { blockDuration, blockStatus } from "./block-status";
import { deleteCommandText, insertCommandText } from "./command-edit";
import { CompletionOverlay } from "./completion-overlay";
import { ControlLease } from "./control-lease";
import { BlockEngine, LIVE_SEARCH_LIMIT } from "./engine";
import { HistoryPager } from "./history-pager";
import { canNavigateHistory, InputHistory } from "./input-history";
import { InputQueue } from "./input-queue";
import { compactLiveViewport } from "./live-viewport";
import { collectOutput } from "./output-download";
import {
  countOutputMatches,
  hasOutputMatch,
  nextOutputMatch,
  type OutputSearchEntry,
  type OutputSearchTarget,
  outputMatchOrdinal,
} from "./output-search";
import {
  applyPathCandidate,
  explicitCompletionEdit,
  type PathCandidate,
  type PathCompletionContext,
  pathCandidates,
  pathCompletionContext,
} from "./path-completion";
import { type CopyPoint, type CopySection, copyOutputRange } from "./range-copy";
import { isScrollNavigationKey, ScrollFollow } from "./scroll-follow";
import { SessionControls } from "./session-controls";
import { hasSnapshotText } from "./snapshot-text";
import { useSessionDraft } from "./use-session-draft";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function BlockTermCorePage({ groupId, cwd }: { groupId: string; cwd?: string }) {
  return <BlockTermGroup key={groupId} groupId={groupId} cwd={cwd} />;
}

function BlockTermGroup({ groupId, cwd }: { groupId: string; cwd?: string }) {
  const inFrame = useFrameStore((state) => state.groups.some((group) => group.id === groupId));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [shell, setShell] = useState("");
  const [listFailed, setListFailed] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);
  const creating = useRef(false);
  const updateSessionLabel = useCallback((session: Session) => {
    setSessions((current) => {
      const previous = current.find((item) => item.id === session.id);
      if (
        !previous ||
        (previous.cwd === session.cwd && previous.shell === session.shell && previous.phase === session.phase)
      )
        return current;
      return current.map((item) =>
        item.id === session.id ? { ...item, cwd: session.cwd, shell: session.shell, phase: session.phase } : item
      );
    });
    // Keep the selected bootstrap object stable: metadata updates must not reconnect the PTY.
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    coreApi
      .list(groupId, controller.signal)
      .then(({ sessions: list }) => {
        if (controller.signal.aborted) return;
        setSessions((current) => [...new Map([...current, ...list].map((item) => [item.id, item])).values()]);
        setSelected((current) => current ?? list.find((session) => session.phase !== "exited") ?? list[0] ?? null);
        setListFailed(false);
        setError("");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setListFailed(true);
          setError(message(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [groupId, listAttempt]);
  const create = useCallback(
    async (context?: { cwd: string; shell: string }) => {
      if (creating.current) return;
      creating.current = true;
      setLoading(true);
      try {
        const session = await coreApi.create(groupId, context?.cwd ?? cwd, context?.shell || shell || undefined);
        setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
        setSelected(session);
        setListFailed(false);
        setError("");
        try {
          const result = await coreApi.list(groupId);
          setSessions([session, ...result.sessions.filter((item) => item.id !== session.id)]);
        } catch (cause) {
          setListFailed(true);
          setError(`会话已创建，但列表刷新失败：${message(cause)}`);
        }
      } catch (cause) {
        setError(message(cause));
      } finally {
        creating.current = false;
        setLoading(false);
      }
    },
    [groupId, cwd, shell]
  );
  const topBar = useMemo(
    () => ({
      show: true,
      centerContent: (
        <SessionControls
          sessions={sessions}
          selectedId={selected?.id ?? ""}
          shell={shell}
          onSelect={(id) => setSelected(sessions.find((item) => item.id === id) ?? null)}
          onShellChange={setShell}
        />
      ),
      rightButtons: [{ icon: <Plus size={18} />, title: "新建会话", disabled: loading, onClick: () => void create() }],
    }),
    [sessions, selected?.id, shell, loading, create]
  );
  usePageTopBar(inFrame ? topBar : undefined, [inFrame, topBar]);
  return (
    <div data-blockterm-core className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      {!inFrame && (
        <div data-blockterm-local-toolbar className="flex min-h-11 items-center gap-2 border-b px-2">
          <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
          {topBar.centerContent}
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="新建会话"
            disabled={loading}
            onClick={() => void create()}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" className="border-b px-3 py-2 text-sm text-destructive">
          {error}
          {listFailed && (
            <Button
              variant="ghost"
              className="ml-2 min-h-11"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                setListAttempt((attempt) => attempt + 1);
              }}
            >
              重试加载会话
            </Button>
          )}
        </div>
      )}
      {selected ? (
        <SessionView
          key={selected.id}
          initial={selected}
          onSessionChange={updateSessionLabel}
          creating={loading}
          onNewSession={(session) => void create({ cwd: session.cwd, shell: session.shell })}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {loading ? "正在加载…" : listFailed ? "会话列表加载失败，请重试" : "新建会话以开始"}
        </div>
      )}
    </div>
  );
}

function SessionView({
  initial,
  creating,
  onNewSession,
  onSessionChange,
}: {
  initial: Session;
  creating: boolean;
  onNewSession: (session: Session) => void;
  onSessionChange: (session: Session) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const engine = useRef<BlockEngine | null>(null);
  const owner = useRef(crypto.randomUUID());
  const controlled = useRef(false);
  const [control, setControl] = useState(false);
  const [connected, setConnected] = useState(false);
  const [alternateScreen, setAlternateScreen] = useState(false);
  const [inspectHistory, setInspectHistory] = useState(false);
  const normalScroll = useRef<{ top: number; following: boolean } | null>(null);
  const [bellVisible, setBellVisible] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const retryStream = useRef<() => void>(() => {});
  const [session, setSession] = useState(initial);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [
    draft,
    setDraft,
    acknowledgeDraft,
    saveDraftSelection,
    restoreDraftSelection,
    travelDraft,
    beginDraftGroup,
    endDraftGroup,
    editDraftInput,
  ] = useSessionDraft(initial.group_id, initial.id);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<Block | null>(null);
  const [liveTargetQuery, setLiveTargetQuery] = useState<string | null>(null);
  const [outputTarget, setOutputTarget] = useState<(OutputSearchTarget & { query: string }) | null>(null);
  useEffect(() => setOutputTarget(null), [query]);
  const [liveMatch, setLiveMatch] = useState(false);
  const [liveResults, setLiveResults] = useState({ resultIndex: -1, resultCount: 0 });
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [copyMenu, setCopyMenu] = useState<Block | null>(null);
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null);
  const [completionMenu, setCompletionMenu] = useState<{
    draft: string;
    cwd: string;
    context: Pick<PathCompletionContext, "editor">;
    kind: "path" | "command";
    heading: string;
    directory?: string;
    files?: Pick<FileInfo, "name" | "isDir">[];
    items: (PathCandidate & { description?: string; category?: string })[];
    index: number;
    loading: boolean;
    error: string;
  } | null>(null);
  const completionRequest = useRef<AbortController | null>(null);
  const completionMenuId = useId();
  useEffect(() => () => completionRequest.current?.abort(), []);
  const [suggestionCursor, setSuggestionCursor] = useState<string | null>(null);
  const suggestionLayer = useRef<HTMLDivElement | null>(null);
  const updateSuggestionCursor = (node: HTMLTextAreaElement) => {
    setSuggestionCursor(
      !composing.current &&
        document.activeElement === node &&
        node.selectionStart === node.value.length &&
        node.selectionEnd === node.value.length
        ? node.value
        : null
    );
  };
  const [rerunBlock, setRerunBlock] = useState<Block | null>(null);
  const rerunEdit = useRef(false);
  const copyReturnFocus = useRef<HTMLElement | null>(null);
  const blockMenuAnchor = useRef<HTMLButtonElement | null>(null);
  const menuCommandAction = useRef<{ block: Block; action: "edit" | "rerun" | "search" } | null>(null);
  const copyVersion = useRef(0);
  useEffect(
    () => () => {
      copyVersion.current++;
    },
    []
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [focusedBlock, setFocusedBlock] = useState<string | null>(null);
  const [selectionBlocks, setSelectionBlocks] = useState<string[]>([]);
  const commandSpace = useRef<string | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const endpoint = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const block = element?.closest<HTMLElement>("[data-block-id]");
        return block && pane.current?.contains(block) ? block.dataset.blockId : undefined;
      };
      const ids =
        selection && !selection.isCollapsed
          ? [
              ...new Set(
                [endpoint(selection.anchorNode), endpoint(selection.focusNode)].filter((id): id is string => !!id)
              ),
            ]
          : [];
      setSelectionBlocks((previous) =>
        previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids
      );
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  const navigationFrame = useRef(0);
  const [pending, setPending] = useState(false);
  const inputRequestPending = useRef(false);
  const closeRequestPending = useRef(false);
  const [closing, setClosing] = useState(false);
  const killedInput = useRef("");
  const [focusAfterBlock, setFocusAfterBlock] = useState<string | null>(null);
  const [focusAfterNative, setFocusAfterNative] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => () => downloadController.current?.abort(), []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySelection, publishHistorySelection] = useState<string | null>(null);
  const historySelectionRef = useRef<string | null>(null);
  const setHistorySelection = useCallback((update: string | null | ((current: string | null) => string | null)) => {
    const next = typeof update === "function" ? update(historySelectionRef.current) : update;
    historySelectionRef.current = next;
    publishHistorySelection(next);
  }, []);
  const historyId = useId();
  const [nativeInput, setNativeInput] = useState(initial.phase === "compatible" || initial.phase === "editing");
  const nativeStarted = useRef(false);
  const [revision, setRevision] = useState(0);
  const [remoteHistory, setRemoteHistory] = useState<Block[]>([]);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const historyPager = useRef(new HistoryPager<Block>(coreApi.history));
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await historyPager.current.load();
      if (result && !result.signal.aborted) {
        setRemoteHistory(result.blocks);
        setHistoryMore(result.has_more);
      }
    } catch (cause) {
      setHistoryError(message(cause));
    } finally {
      setHistoryLoading(historyPager.current.loading);
    }
  }, []);
  const historyQuery = historyOpen ? draft : "";
  useEffect(() => {
    const pager = historyPager.current;
    pager.reset(initial.group_id, historyQuery);
    setRemoteHistory([]);
    setHistoryMore(false);
    setHistoryError("");
    setHistoryLoading(true);
    const timer = setTimeout(() => void loadHistory(), 150);
    return () => {
      clearTimeout(timer);
      pager.cancel();
    };
  }, [initial.group_id, historyQuery, loadHistory]);
  const inputHistory = useRef(new InputHistory());
  const travelInput = useCallback(
    (node: HTMLTextAreaElement, redo: boolean) => {
      saveDraftSelection(node);
      if (!travelDraft(redo)) return;
      inputHistory.current.reset();
      setHistorySelection(null);
      queueMicrotask(() => {
        if (input.current === node) restoreDraftSelection(node);
      });
    },
    [saveDraftSelection, travelDraft, restoreDraftSelection, setHistorySelection]
  );
  const attachInput = useCallback(
    (node: HTMLTextAreaElement | null) => {
      input.current = node;
      if (!node) return;
      restoreDraftSelection(node);
      const resizeInput = () => {
        const scrollTop = node.scrollTop;
        node.style.height = "0px";
        node.style.height = `${node.scrollHeight}px`;
        node.scrollTop = scrollTop;
        if (suggestionLayer.current) {
          suggestionLayer.current.style.width = `${node.clientWidth}px`;
          suggestionLayer.current.scrollTop = node.scrollTop;
        }
      };
      resizeInput();
      let width = node.parentElement?.clientWidth;
      const resize = new ResizeObserver(() => {
        const nextWidth = node.parentElement?.clientWidth;
        if (nextWidth === width) return;
        width = nextWidth;
        resizeInput();
      });
      if (node.parentElement) resize.observe(node.parentElement);
      const beforeInput = (event: InputEvent) => {
        if (event.isComposing || composing.current || node.disabled || node.readOnly) return;
        if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") {
          saveDraftSelection(node);
          return;
        }
        if (!event.cancelable) return;
        event.preventDefault();
        travelInput(node, event.inputType === "historyRedo");
      };
      node.addEventListener("beforeinput", beforeInput);
      return () => {
        resize.disconnect();
        node.removeEventListener("beforeinput", beforeInput);
        if (input.current === node) input.current = null;
      };
    },
    [restoreDraftSelection, saveDraftSelection, travelInput]
  );
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const scrollTop = node.scrollTop;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
    node.scrollTop = scrollTop;
  }, [draft]);
  const follow = useRef(new ScrollFollow());
  const scrollIntentUntil = useRef(0);
  const followCorrectionFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(followCorrectionFrame.current), []);
  const markScrollIntent = () => {
    scrollIntentUntil.current = performance.now() + 1500;
  };
  const [detached, setDetached] = useState(false);
  const outputContent = useRef<HTMLDivElement>(null);
  const followOutput = useCallback(() => {
    const node = scroll.current;
    if (!node) return;
    if (query || searchScope || copyMenu) return;
    const target = follow.current.target(node.scrollHeight - node.clientHeight);
    if (target !== null) {
      node.scrollTop = target;
      follow.current.applied(node.scrollTop);
    }
    setDetached(!follow.current.following);
  }, [query, searchScope, copyMenu]);
  const inputQueue = useRef(new InputQueue());
  const inputAbort = useRef<AbortController | null>(null);
  const submitRequest = useRef<{ id: string; command: string } | null>(null);
  const outputStopped = engine.current?.outputStopped ?? false;
  const ready = session.phase === "ready" && connected && !session.error && !outputStopped;
  const running = session.phase === "running" || session.phase === "submitted";
  const activeCommand = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      if (block.kind === "command" && (block.status === "running" || block.status === "submitted")) return block;
    }
    return null;
  }, [blocks]);
  const showLiveTerminal = session.phase !== "exited" && (running || nativeInput);
  const scopeIncludesLive = !searchScope || searchScope.id === engine.current?.current;
  const showScopedLiveTerminal = showLiveTerminal && scopeIncludesLive;
  const focusedAlternate = alternateScreen && showLiveTerminal && !query && !searchScope && !inspectHistory;
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    if (focusedAlternate) {
      node.scrollTop = 0;
      return;
    }
    if (alternateScreen || !normalScroll.current) return;
    const previous = normalScroll.current;
    normalScroll.current = null;
    if (query) return;
    const frame = requestAnimationFrame(() => {
      follow.current.following = previous.following;
      node.scrollTop = previous.following ? node.scrollHeight - node.clientHeight : previous.top;
      follow.current.applied(node.scrollTop);
      setDetached(!previous.following);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedAlternate, alternateScreen, query]);
  useEffect(() => {
    if (
      completionMenu &&
      (completionMenu.cwd !== session.cwd || showLiveTerminal || !ready || !control || historyOpen)
    ) {
      completionRequest.current?.abort();
      setCompletionMenu(null);
    }
  }, [completionMenu, session.cwd, showLiveTerminal, ready, control, historyOpen]);
  const liveFolded = !!engine.current?.current && collapsed.has(engine.current.current);
  const revealLiveOutput = useCallback(() => {
    const id = engine.current?.current;
    if (!id) return;
    setCollapsed((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);
  const focusLiveTerminal = useCallback(() => {
    setInspectHistory(false);
    setQuery("");
    setSearchScope(null);
    revealLiveOutput();
    const core = engine.current;
    requestAnimationFrame(() => {
      if (core && engine.current === core && controlled.current && !core.terminal.element?.closest("[inert]"))
        core.terminal.focus();
    });
  }, [revealLiveOutput]);
  const navigatingLive = !!query && liveTargetQuery === query && showScopedLiveTerminal;
  useEffect(() => setLiveTargetQuery(null), [query, showScopedLiveTerminal]);
  useEffect(() => {
    // Replay writes complete before revision advances, so search sees parsed cells.
    if (!revision) return;
    if (query) {
      follow.current.following = false;
      setDetached(true);
    }
    const found = engine.current?.searchOutput(showScopedLiveTerminal ? query : "") ?? false;
    setLiveMatch(found);
    if (!found) setLiveTargetQuery(null);
  }, [query, revision, showScopedLiveTerminal]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!revision) return;
    if (session.phase === "compatible" || session.phase === "editing") setNativeInput(true);
    if (running || session.phase === "editing") nativeStarted.current = true;
    if (ready && nativeStarted.current) {
      nativeStarted.current = false;
      if (nativeInput) setFocusAfterNative(true);
      setNativeInput(false);
    }
  }, [ready, running, session.phase, nativeInput, revision]);

  const sendInput = useCallback(
    (data: string, binary = false) => {
      const core = engine.current;
      const allowed = () =>
        !!core &&
        engine.current === core &&
        controlled.current &&
        !core.replaying &&
        (!core.outputStopped || (!binary && data === "\x03"));
      if (!allowed()) return;
      void inputQueue.current.enqueue(
        () =>
          binary
            ? coreApi.binary(initial.id, owner.current, data, inputAbort.current?.signal)
            : coreApi.input(initial.id, owner.current, data, inputAbort.current?.signal),
        allowed,
        (cause) => setError(message(cause)),
        data.length * 2
      );
    },
    [initial.id]
  );

  useEffect(() => {
    if (!host.current) return;
    const core = new BlockEngine(host.current, initial);
    const releaseViewport = compactLiveViewport(core.terminal, host.current);
    setStreamError(null);
    const inputController = new AbortController();
    inputAbort.current = inputController;
    core.terminal.options.disableStdin = true;
    core.terminal.attachCustomKeyEventHandler((event) => {
      if (
        core.outputStopped &&
        event.type === "keydown" &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.isComposing &&
        event.key.toLowerCase() === "c" &&
        !core.terminal.hasSelection()
      ) {
        event.preventDefault();
        sendInput("\x03");
        return false;
      }
      return true;
    });
    engine.current = core;
    const bufferMode = core.terminal.buffer.onBufferChange((buffer) => {
      const alternate = buffer.type === "alternate";
      if (alternate && !normalScroll.current) {
        normalScroll.current = { top: scroll.current?.scrollTop ?? 0, following: follow.current.following };
        follow.current.following = false;
        setDetached(false);
      }
      setAlternateScreen(alternate);
      if (!alternate) setInspectHistory(false);
    });
    let stopped = false;
    setBellVisible(false);
    let bellTimer: ReturnType<typeof setTimeout> | undefined;
    const bell = core.terminal.onBell(() => {
      if (stopped || core.replaying) return;
      setBellVisible(true);
      clearTimeout(bellTimer);
      bellTimer = setTimeout(() => {
        if (!stopped) setBellVisible(false);
      }, 3000);
    });
    const searchResults = core.onSearchResults((result) => {
      if (!stopped) setLiveResults(result);
    });
    let finished = false;
    let replayFailed = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let processing = Promise.resolve();
    const syncInput = () => {
      core.terminal.options.disableStdin =
        core.outputStopped || !controlled.current || core.replaying || socket?.readyState !== WebSocket.OPEN;
    };
    const publish = () => {
      if (stopped) return;
      core.publishBackground();
      setSession({ ...core.session });
      onSessionChange(core.session);
      const nextBlocks = [...core.blocks.values()];
      setBlocks((previous) =>
        previous.length === nextBlocks.length && previous.every((block, index) => block === nextBlocks[index])
          ? previous
          : nextBlocks
      );
      setRevision((value) => value + 1);
      if (
        !replayFailed &&
        !finished &&
        core.session.phase === "exited" &&
        core.cursor >= core.watermark &&
        core.watermark > 0
      ) {
        finished = true;
        clearInterval(lease);
        clearTimeout(retry);
        controller.stop();
        inputQueue.current.invalidate();
        controlled.current = false;
        core.terminal.options.disableStdin = true;
        setControl(false);
        socket?.close();
      }
      setConnected(!replayFailed && socket?.readyState === WebSocket.OPEN && core.cursor >= core.watermark);
      syncInput();
    };
    const createController = () => {
      const leaseOwner = crypto.randomUUID();
      owner.current = leaseOwner;
      return new ControlLease(
        () => coreApi.claim(initial.id, leaseOwner),
        () => coreApi.release(initial.id, leaseOwner),
        (value) => {
          if (!value) inputQueue.current.invalidate();
          controlled.current = value;
          syncInput();
          setControl(value);
        }
      );
    };
    let controller = createController();
    let suspended = false;
    if (initial.phase !== "exited") void controller.renew();
    const release = () => {
      suspended = true;
      controller.stop();
      inputQueue.current.invalidate();
      controlled.current = false;
      core.terminal.options.disableStdin = true;
      setControl(false);
    };
    const restore = () => {
      if (stopped || finished || replayFailed || core.session.phase === "exited" || !suspended) return;
      suspended = false;
      controller = createController();
      void controller.renew();
    };
    window.addEventListener("pagehide", release);
    window.addEventListener("pageshow", restore);
    const lease = setInterval(() => {
      if (!replayFailed && core.session.phase !== "exited") void controller.renew();
    }, 5000);
    const data = core.terminal.onData((value) => {
      if (!core.replaying) sendInput(value);
    });
    const binary = core.terminal.onBinary((value) => {
      if (!core.replaying) sendInput(value, true);
    });
    const connect = () => {
      if (stopped || finished || replayFailed) return;
      const connection = new WebSocket(coreApi.events(initial.id, core.cursor));
      socket = connection;
      connection.onmessage = (event) => {
        processing = processing
          .then(async () => {
            if (stopped || replayFailed || connection !== socket) return;
            const events = JSON.parse(event.data) as TerminalEvent[];
            for (const item of events) {
              if (stopped) return;
              if (item.type === "fault") throw new Error(item.data ? decode(item.data) : "输出读取失败");
              core.replaying = connection.readyState !== WebSocket.OPEN || item.seq <= core.watermark;
              await core.apply(item);
              if (core.session.phase === "running" || core.session.phase === "editing") nativeStarted.current = true;
            }
            core.replaying = connection.readyState !== WebSocket.OPEN || core.cursor < core.watermark;
            if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ ack: core.cursor }));
            publish();
          })
          .catch((cause) => {
            if (!stopped && connection === socket) {
              replayFailed = true;
              core.replaying = true;
              setStreamError(message(cause));
              clearTimeout(retry);
              controller.stop();
              inputQueue.current.invalidate();
              controlled.current = false;
              setControl(false);
              publish();
              connection.close();
            }
          });
      };
      connection.onclose = () => {
        if (stopped || finished || replayFailed || connection !== socket) return;
        inputQueue.current.invalidate();
        setConnected(false);
        core.replaying = true;
        syncInput();
        retry = setTimeout(
          () =>
            void processing.then(() => {
              if (!stopped && !finished && !replayFailed) connect();
            }),
          1000
        );
      };
    };
    retryStream.current = () => {
      void processing.then(() => {
        if (stopped || !replayFailed) return;
        replayFailed = false;
        setStreamError(null);
        controller = createController();
        if (!suspended && core.session.phase !== "exited") void controller.renew();
        connect();
      });
    };
    connect();
    return () => {
      stopped = true;
      releaseViewport();
      bufferMode.dispose();
      bell.dispose();
      clearTimeout(bellTimer);
      searchResults.dispose();
      inputQueue.current.invalidate();
      inputController.abort();
      controlled.current = false;
      clearInterval(lease);
      controller.stop();
      clearTimeout(retry);
      socket?.close();
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", restore);
      data.dispose();
      binary.dispose();
      void processing.finally(() => core.dispose());
      engine.current = null;
    };
  }, [initial, sendInput, onSessionChange]);

  useEffect(() => {
    if (!scroll.current || !control) return;
    let timer: ReturnType<typeof setTimeout>;
    const resize = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!controlled.current || engine.current?.session.phase === "exited") return;
        const terminal = engine.current?.terminal;
        const area = scroll.current;
        const container = pane.current;
        if (!area || !container) return;
        const screen = terminal?.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
        const cellWidth = terminal && screen?.width ? screen.width / terminal.cols : 7.83;
        const cellHeight = terminal && screen?.height ? screen.height / terminal.rows : 15.6;
        const searchHeight = host.current?.previousElementSibling?.getBoundingClientRect().height ?? 0;
        const cols = Math.max(2, Math.floor((area.clientWidth - 24) / cellWidth));
        const controlsHeight = [...container.children].reduce(
          (height, child) => height + (child === area ? 0 : child.getBoundingClientRect().height),
          0
        );
        // The editable prompt follows short output; PTY size still uses the available viewport.
        const availableHeight = Math.max(area.clientHeight, container.clientHeight - controlsHeight);
        const rows = Math.max(2, Math.floor((availableHeight - 16 - searchHeight) / cellHeight));
        if (terminal?.cols === cols && terminal.rows === rows) return;
        void coreApi.resize(initial.id, owner.current, cols, rows).catch((cause) => setError(message(cause)));
      }, 150);
    });
    const observed = new Set<Element>();
    const observeLayout = () => {
      const container = pane.current;
      if (!container) return;
      const current = new Set<Element>([container, ...container.children]);
      for (const child of observed) {
        if (!current.has(child)) {
          resize.unobserve(child);
          observed.delete(child);
        }
      }
      for (const child of current) {
        if (!observed.has(child)) {
          resize.observe(child);
          observed.add(child);
        }
      }
    };
    observeLayout();
    const layoutChildren = new MutationObserver(observeLayout);
    if (pane.current) layoutChildren.observe(pane.current, { childList: true });
    return () => {
      layoutChildren.disconnect();
      resize.disconnect();
      clearTimeout(timer);
    };
  }, [initial.id, control, query]);

  const visible = useMemo(() => {
    if (!revision) return [];
    return blocks.filter(
      (block) =>
        (!searchScope || block.id === searchScope.id) &&
        (block.command ||
          hasSnapshotText(engine.current?.snapshots.get(block.id)) ||
          hasSnapshotText(engine.current?.alternateSnapshots.get(block.id)) ||
          block.status === "running") &&
        (!query ||
          hasOutputMatch(
            [
              block.command ?? "",
              "\n",
              ...(engine.current?.outputTextChunks(block.id) ?? []),
              "\n",
              ...(engine.current?.alternateSnapshots.get(block.id)?.textChunks ?? []),
            ],
            query
          ))
    );
  }, [blocks, query, revision, searchScope]);
  const focusedIndex = visible.findIndex((block) => block.id === focusedBlock);
  const selectionStartIndex = visible.findIndex((block) => block.id === selectionBlocks[0]);
  const selectionEndIndex = visible.findIndex((block) => block.id === selectionBlocks[1]);
  const extractRange = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range);
      for (const index of [focusedIndex, selectionStartIndex, selectionEndIndex])
        if (index >= 0 && !indexes.includes(index)) indexes.push(index);
      indexes.sort((a, b) => a - b);
      return indexes;
    },
    [focusedIndex, selectionStartIndex, selectionEndIndex]
  );
  const virtual = useVirtualizer({
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true,
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 100,
    overscan: 3,
    rangeExtractor: extractRange,
    getItemKey: (index) => visible[index].id,
  });
  const searchIndex = visible.findIndex((block) => block.id === selectedBlock);
  const failedBlocks = useMemo(() => visible.filter((block) => blockStatus(block).failed), [visible]);
  const failedIndex = failedBlocks.findIndex((block) => block.id === selectedBlock);
  const foldableBlocks = visible.filter((block) => block.status !== "running" && block.status !== "submitted");
  const allFolded = foldableBlocks.length > 0 && foldableBlocks.every((block) => collapsed.has(block.id));
  const outputEntries = useMemo(() => {
    const entries: OutputSearchEntry[] = [];
    if (!query || !revision) return entries;
    for (const block of visible) {
      const commandCount = countOutputMatches(block, query);
      if (commandCount) entries.push({ block: block.id, screen: "command", count: commandCount });
      for (const screen of ["normal", "alternate"] as const) {
        const snapshot = (screen === "normal" ? engine.current?.snapshots : engine.current?.alternateSnapshots)?.get(
          block.id
        );
        const count = snapshot ? countOutputMatches(snapshot, query) : 0;
        if (count) entries.push({ block: block.id, screen, count });
      }
    }
    return entries;
  }, [visible, query, revision]);
  const activeOutputTarget = outputTarget?.query === query ? outputTarget : null;
  const outputTotal = outputEntries.reduce((sum, entry) => sum + entry.count, 0);
  const outputOrdinal = outputMatchOrdinal(outputEntries, activeOutputTarget);
  useEffect(() => {
    if (!activeOutputTarget) return;
    let frame = 0;
    let attempts = 0;
    const reveal = () => {
      const container = scroll.current;
      const target = container?.querySelector<HTMLElement>("[data-output-search-target]");
      if (!container || !target) {
        if (++attempts < 12) frame = requestAnimationFrame(reveal);
        return;
      }
      const position =
        activeOutputTarget.screen === "command" ? (target.querySelector("mark[data-active-match]") ?? target) : target;
      container.scrollTop +=
        position.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [activeOutputTarget]);
  const moveOutputSearch = (direction: 1 | -1) => {
    const core = engine.current;
    const enterLive = () => {
      if (!core?.searchOutput(query, direction > 0 ? "first" : "last")) return false;
      revealLiveOutput();
      setLiveTargetQuery(query);
      setOutputTarget(null);
      setSelectedBlock(null);
      follow.current.following = false;
      setDetached(true);
      requestAnimationFrame(() => {
        const container = scroll.current;
        if (container && host.current)
          container.scrollTop += host.current.getBoundingClientRect().top - container.getBoundingClientRect().top;
      });
      return true;
    };
    if (navigatingLive && core) {
      revealLiveOutput();
      const result = core.stepOutputSearch(query, direction > 0 ? "next" : "previous");
      setLiveMatch(result.found);
      if (result.found && (!result.wrapped || !outputTotal)) return;
    } else if (
      showScopedLiveTerminal &&
      liveMatch &&
      (!outputTotal || (direction > 0 ? outputOrdinal === outputTotal - 1 : outputOrdinal <= 0)) &&
      enterLive()
    )
      return;
    const target = nextOutputMatch(outputEntries, navigatingLive ? null : activeOutputTarget, direction);
    if (!target) return;
    setLiveTargetQuery(null);
    setOutputTarget({ ...target, query });
    setSelectedBlock(target.block);
    follow.current.following = false;
    setDetached(true);
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(target.block);
      return next;
    });
    virtual.scrollToIndex(
      visible.findIndex((block) => block.id === target.block),
      { align: "start" }
    );
  };
  const closeOutputSearch = () => {
    setQuery("");
    setSearchScope(null);
    setSelectedBlock(null);
    const previous = searchReturnFocus.current;
    searchReturnFocus.current = null;
    if (previous?.isConnected && !previous.closest("[inert]") && !previous.matches(":disabled"))
      previous.focus({ preventScroll: true });
    else if (showLiveTerminal && control && connected) focusLiveTerminal();
    else input.current?.focus({ preventScroll: true });
  };
  const moveFailure = (direction: number) => {
    if (!failedBlocks.length) return;
    if (alternateScreen) setInspectHistory(true);
    const index =
      failedIndex < 0
        ? direction > 0
          ? 0
          : failedBlocks.length - 1
        : (failedIndex + direction + failedBlocks.length) % failedBlocks.length;
    const id = failedBlocks[index].id;
    follow.current.following = false;
    setDetached(true);
    setLiveTargetQuery(null);
    setOutputTarget(null);
    setSelectedBlock(id);
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    requestAnimationFrame(() =>
      virtual.scrollToIndex(
        visible.findIndex((block) => block.id === id),
        { align: "start" }
      )
    );
  };
  const selectLocalMatch = (block: string, screen: "normal" | "alternate", index: number) => {
    setLiveTargetQuery(null);
    setOutputTarget({ block, screen, index, query });
    setSelectedBlock(block);
  };
  const moveLocalLiveSearch = (direction: "next" | "previous") => {
    const found = engine.current?.searchOutput(query, direction) ?? false;
    setLiveMatch(found);
    setLiveTargetQuery(found ? query : null);
    setOutputTarget(null);
    setSelectedBlock(null);
  };
  useEffect(() => () => cancelAnimationFrame(navigationFrame.current), []);
  useEffect(() => {
    const node = pane.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (composing.current || event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const block = target?.closest<HTMLElement>("[data-block-id]");
      if ((running || nativeInput) && !block) return;
      if (event.key === "Escape" && block) {
        event.preventDefault();
        cancelAnimationFrame(navigationFrame.current);
        setSelectedBlock(null);
        if (running || nativeInput) focusLiveTerminal();
        else input.current?.focus();
        return;
      }
      const action = blockNavigationKey(event, target === block);
      if (!action) return;
      const ids = visible.map((item) => item.id);
      if (
        action === "next" &&
        event.altKey &&
        block?.dataset.blockId === ids.at(-1) &&
        !running &&
        !nativeInput &&
        ready &&
        control
      ) {
        event.preventDefault();
        cancelAnimationFrame(navigationFrame.current);
        setSelectedBlock(null);
        input.current?.focus();
        return;
      }
      const id = navigateBlock(ids, block?.dataset.blockId ?? selectedBlock, action);
      if (!id) return;
      event.preventDefault();
      follow.current.following = false;
      setDetached(true);
      setSelectedBlock(id);
      virtual.scrollToIndex(ids.indexOf(id), { align: "start" });
      cancelAnimationFrame(navigationFrame.current);
      let attempts = 0;
      const focus = () => {
        const phase = engine.current?.session.phase;
        if (!phase || (!block && ["running", "submitted", "editing", "compatible"].includes(phase))) return;
        const element = [...node.querySelectorAll<HTMLElement>("[data-block-id]")].find(
          (item) => item.dataset.blockId === id
        );
        if (element) element.focus({ preventScroll: true });
        else if (++attempts < 12) navigationFrame.current = requestAnimationFrame(focus);
      };
      navigationFrame.current = requestAnimationFrame(focus);
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [visible, virtual, selectedBlock, running, nativeInput, ready, control, focusLiveTerminal]);
  useEffect(() => {
    if (!scroll.current || !outputContent.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(followOutput);
    });
    observer.observe(scroll.current);
    observer.observe(outputContent.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [followOutput]);
  useEffect(() => {
    if (!revision) return;
    const frame = requestAnimationFrame(followOutput);
    return () => cancelAnimationFrame(frame);
  }, [revision, followOutput]);

  useEffect(() => {
    if ((!focusAfterBlock && !focusAfterNative) || !ready || !control || showLiveTerminal) return;
    const completed = blocks.find((block) => block.id === focusAfterBlock);
    if (!focusAfterNative && (!completed || ["submitted", "running"].includes(completed.status))) return;
    setFocusAfterBlock(null);
    setFocusAfterNative(false);
    const active = document.activeElement;
    // Do not steal focus from search, history, another pane, or another app field.
    if (
      active === document.body ||
      active === input.current ||
      (active instanceof HTMLElement && host.current?.contains(active))
    ) {
      input.current?.focus({ preventScroll: true });
    }
  }, [focusAfterBlock, focusAfterNative, ready, control, showLiveTerminal, blocks]);

  const submit = async (command = draft) => {
    if (!ready || !control || inputRequestPending.current || !command.trim()) return;
    inputRequestPending.current = true;
    if (submitRequest.current?.command !== command) submitRequest.current = { id: crypto.randomUUID(), command };
    setPending(true);
    const clearSubmittedDraft = acknowledgeDraft(command);
    try {
      const accepted = await coreApi.submit(initial.id, owner.current, submitRequest.current.id, command);
      setFocusAfterBlock(accepted.id);
      clearSubmittedDraft();
      submitRequest.current = null;
      inputHistory.current.reset();
      setError("");
      scrollIntentUntil.current = 0;
      follow.current.resume();
      followOutput();
    } catch (cause) {
      setError(message(cause));
    } finally {
      inputRequestPending.current = false;
      setPending(false);
    }
  };
  const startShellCompletion = () => {
    if (!ready || !control || streamError || composing.current || inputRequestPending.current) return;
    inputRequestPending.current = true;
    completionRequest.current?.abort();
    setCompletionMenu(null);
    setPending(true);
    setHistoryOpen(false);
    setHistorySelection(null);
    setNativeInput(true);
    const submittedDraft = draft;
    const clearNativeDraft = acknowledgeDraft(submittedDraft);
    void coreApi
      .native(initial.id, owner.current, submittedDraft)
      .then(() => {
        clearNativeDraft();
        setError("");
      })
      .catch((cause) => {
        setNativeInput(false);
        setFocusAfterNative(true);
        setError(message(cause));
      })
      .finally(() => {
        inputRequestPending.current = false;
        setPending(false);
      });
    requestAnimationFrame(() => {
      const terminal = engine.current?.terminal;
      if (terminal?.element && !terminal.element.closest("[inert]")) terminal.focus();
    });
  };
  const applyCompletionEdit = (edit: { draft: string; cursor: number }) => {
    setDraft(edit.draft);
    inputHistory.current.reset();
    input.current?.focus();
    queueMicrotask(() => {
      if (input.current?.value === edit.draft) {
        input.current.setSelectionRange(edit.cursor, edit.cursor);
        saveDraftSelection(input.current);
      }
    });
  };
  const applyExplicitCompletion = (context: Pick<PathCompletionContext, "editor">, items: PathCandidate[]) => {
    const edit = explicitCompletionEdit(context, items);
    if (!edit) return;
    if (items.length === 1 && !items[0].directory) setCompletionMenu(null);
    applyCompletionEdit(edit);
  };
  const startCompletion = (nativeFallback = true) => {
    if (!ready || !control || streamError || composing.current || inputRequestPending.current) return;
    const node = input.current;
    const context =
      node && node.selectionStart === node.selectionEnd
        ? pathCompletionContext(draft, node.selectionStart, session.cwd, session.shell)
        : null;
    if (!context) {
      const command =
        node &&
        node.selectionStart === node.selectionEnd &&
        /^(bash|zsh)$/.test(session.shell.split(/[\\/]/).pop() ?? "")
          ? resolveBlockTermCommandCompletion(draft, node.selectionStart)
          : null;
      if (!command || command.context.hasContentSuffix) {
        completionRequest.current?.abort();
        setCompletionMenu(null);
        if (nativeFallback) startShellCompletion();
        return;
      }
      completionRequest.current?.abort();
      setHistoryOpen(false);
      setCompletionMenu({
        draft,
        cwd: session.cwd,
        kind: "command",
        heading: "内置命令建议",
        context: { editor: command.context },
        items: command.candidates.slice(0, 200).map((item) => ({
          label: item.display,
          value: item.value,
          directory: false,
          description: item.description,
          category: item.kind === "option" ? "选项" : "子命令",
        })),
        index: 0,
        loading: false,
        error: "",
      });
      node?.focus({ preventScroll: true });
      if (nativeFallback)
        applyExplicitCompletion(
          { editor: command.context },
          command.candidates.map((item) => ({ label: item.display, value: item.value, directory: false }))
        );
      return;
    }
    completionRequest.current?.abort();
    const request = new AbortController();
    completionRequest.current = request;
    setHistoryOpen(false);
    const files =
      completionMenu?.cwd === session.cwd && completionMenu.directory === context.directory
        ? completionMenu.files
        : undefined;
    setCompletionMenu({
      draft,
      cwd: session.cwd,
      kind: "path",
      heading: `路径补全 · ${context.directory}`,
      directory: context.directory,
      files,
      context,
      items: files ? pathCandidates(context, files) : [],
      index: 0,
      loading: !files,
      error: "",
    });
    node?.focus({ preventScroll: true });
    if (files) {
      if (nativeFallback) applyExplicitCompletion(context, pathCandidates(context, files));
      return;
    }
    void fileApi
      .list(context.directory, request.signal)
      .then(({ files }) => {
        if (request.signal.aborted || input.current?.value !== draft) return;
        setCompletionMenu((current) =>
          current && current.draft === draft
            ? {
                ...current,
                loading: false,
                files: files.map(({ name, isDir }) => ({ name, isDir })),
                items: pathCandidates(context, files),
              }
            : current
        );
        const activeInput = input.current;
        if (
          nativeFallback &&
          controlled.current &&
          engine.current?.session.cwd === session.cwd &&
          activeInput === document.activeElement &&
          activeInput?.selectionStart === context.editor.cursor &&
          activeInput.selectionEnd === context.editor.cursor
        )
          applyExplicitCompletion(context, pathCandidates(context, files));
      })
      .catch((cause) => {
        if (!request.signal.aborted)
          setCompletionMenu((current) => (current ? { ...current, loading: false, error: message(cause) } : null));
      });
  };
  useEffect(() => {
    if (completionMenu && completionMenu.draft !== draft && !historyOpen && !showLiveTerminal && ready && control)
      startCompletion(false);
  });
  const acceptCompletion = (candidate: PathCandidate) => {
    if (
      !completionMenu ||
      completionMenu.draft !== draft ||
      completionMenu.cwd !== session.cwd ||
      !ready ||
      !control ||
      composing.current
    )
      return;
    const edit = applyPathCandidate(completionMenu.context, candidate);
    if (!edit) return;
    if (!candidate.directory) setCompletionMenu(null);
    applyCompletionEdit(edit);
  };
  const history = useMemo(
    () => [
      ...new Set([
        ...blocks
          .filter((block) => block.command)
          .map((block) => block.command)
          .reverse(),
        ...remoteHistory.map((block) => block.command),
      ]),
    ],
    [blocks, remoteHistory]
  );
  const historyOptions = useMemo(() => {
    const query = draft.toLowerCase();
    return history.filter((command) => command.toLowerCase().includes(query));
  }, [history, draft]);
  const historySuggestion = useMemo(() => {
    if (
      !ready ||
      !control ||
      pending ||
      showLiveTerminal ||
      historyOpen ||
      completionMenu ||
      draft.length < 2 ||
      draft.includes("\n") ||
      dismissedSuggestion === draft
    )
      return null;
    return (
      history.find(
        (command) => command.length > draft.length && command.startsWith(draft) && !command.includes("\n")
      ) ?? null
    );
  }, [history, draft, ready, control, pending, showLiveTerminal, historyOpen, dismissedSuggestion, completionMenu]);
  const historyIndex = historySelection === null ? -1 : historyOptions.indexOf(historySelection);
  const reuseCommand = (command: string) => {
    inputHistory.current.reset();
    setDraft(command);
    setSelectedBlock(null);
    const node = input.current;
    node?.focus({ preventScroll: true });
    queueMicrotask(() => {
      if (!node?.isConnected || input.current !== node || node.value !== command || document.activeElement !== node)
        return;
      node.setSelectionRange(command.length, command.length);
      saveDraftSelection(node);
    });
  };
  const acceptHistory = (command: string) => {
    reuseCommand(command);
    setHistoryOpen(false);
    setHistorySelection(null);
  };
  useEffect(() => {
    if (historyOpen && historyIndex >= 0)
      document.getElementById(`${historyId}-${historyIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [historyOpen, historyIndex, historyId]);
  const copy = async (value: string, label = "命令和已渲染输出") => {
    const version = ++copyVersion.current;
    setCopyStatus("正在复制…");
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持剪贴板，请使用安全连接");
      await navigator.clipboard.writeText(value);
      if (version === copyVersion.current) setCopyStatus(`已复制${label}`);
    } catch (cause) {
      if (version === copyVersion.current) setCopyStatus(`复制失败：${message(cause)}`);
    }
  };
  const blockOutput = (id: string) => {
    const core = engine.current;
    const text = core?.outputText(id) ?? core?.snapshots.get(id)?.text ?? "";
    const alternate = core?.alternateSnapshots.get(id)?.text;
    return `${text}${alternate?.trim() ? `\n全屏程序最后画面\n${alternate}` : ""}`;
  };
  const download = async (block: Block) => {
    if (downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloadBytes(0);
    setDownloading(block.id);
    try {
      const chunks = await collectOutput(
        initial.id,
        block.id,
        (cursor, through) => coreApi.output(initial.id, block.id, cursor, controller.signal, through),
        undefined,
        controller.signal,
        (bytes) => {
          if (downloadController.current === controller) setDownloadBytes(bytes);
        }
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `blockterm-${block.id}.ansi`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (downloadController.current === controller) {
        downloadController.current = null;
        setDownloading(null);
      }
    }
  };

  return (
    <div
      ref={pane}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey) return;
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          if (event.target !== searchInput.current && event.target instanceof HTMLElement)
            searchReturnFocus.current = event.target;
          searchInput.current?.focus();
          searchInput.current?.select();
        }
      }}
    >
      <div className="flex min-h-11 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono" title={session.cwd}>
          {session.cwd}
        </span>
        <span>
          {streamError
            ? "同步失败"
            : session.phase === "exited"
              ? session.exit_signal
                ? `已结束 · 信号 ${session.exit_signal}`
                : session.exit_code === undefined
                  ? "已结束"
                  : `已结束 · 退出码 ${session.exit_code}`
              : closing
                ? "正在结束"
                : !connected
                  ? "重连中"
                  : !control
                    ? "只读"
                    : running
                      ? "运行中"
                      : ready
                        ? "就绪"
                        : "初始化"}
        </span>
        {bellVisible && (
          <span role="status" data-blockterm-bell className="shrink-0">
            终端响铃
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label="结束会话"
          disabled={!control || session.phase === "exited" || closing}
          aria-busy={closing && session.phase !== "exited"}
          onClick={() => {
            if (closeRequestPending.current) return;
            closeRequestPending.current = true;
            setClosing(true);
            void coreApi.close(initial.id, owner.current).then(
              () => setError(""),
              (cause) => {
                closeRequestPending.current = false;
                setClosing(false);
                setError(message(cause));
              }
            );
          }}
        >
          <Square className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label={
            alternateScreen
              ? focusedAlternate
                ? "查看历史输出"
                : "返回全屏程序"
              : allFolded
                ? "展开已结束块"
                : "折叠已结束块"
          }
          title={
            alternateScreen
              ? "浏览历史不会中断当前程序"
              : allFolded
                ? "展开当前列表中的已结束块"
                : "折叠当前列表中的已结束块，浏览命令总览"
          }
          disabled={!alternateScreen && foldableBlocks.length === 0}
          onClick={() => {
            if (alternateScreen) {
              if (!focusedAlternate) focusLiveTerminal();
              else {
                setInspectHistory(true);
                follow.current.following = false;
                setDetached(true);
                requestAnimationFrame(() => {
                  const node = scroll.current;
                  if (node) {
                    node.scrollTop = normalScroll.current?.top ?? 0;
                    follow.current.applied(node.scrollTop);
                  }
                });
              }
              return;
            }
            follow.current.following = false;
            setDetached(true);
            setCollapsed((previous) => {
              const next = new Set(previous);
              for (const block of foldableBlocks) {
                if (allFolded) next.delete(block.id);
                else next.add(block.id);
              }
              return next;
            });
          }}
        >
          {alternateScreen ? (
            focusedAlternate ? (
              <HistoryIcon className="size-4" />
            ) : (
              <TerminalIcon className="size-4" />
            )
          ) : allFolded ? (
            <ChevronsUpDown className="size-4" />
          ) : (
            <ChevronsDownUp className="size-4" />
          )}
        </Button>
        <Search className="size-4 shrink-0" />
        <input
          ref={searchInput}
          aria-label="搜索命令和输出"
          aria-keyshortcuts="Control+Shift+F Meta+Shift+F F3 Shift+F3"
          className="h-11 w-24 min-w-0 bg-transparent text-base sm:w-44 sm:text-sm"
          placeholder="搜索"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedBlock(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "F3" && query && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              moveOutputSearch(event.shiftKey ? -1 : 1);
            } else if (event.key === "Enter" && query) {
              event.preventDefault();
              moveOutputSearch(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              closeOutputSearch();
            }
          }}
        />
      </div>
      {searchScope && (
        <div data-search-scope className="flex min-h-11 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={searchScope.command || "后台输出"}>
            搜索范围：{searchScope.command || "后台输出"}
          </span>
          <Button variant="ghost" className="min-h-11 shrink-0" onClick={() => setSearchScope(null)}>
            搜索全部块
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="退出块内搜索"
            onClick={closeOutputSearch}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
      {!searchScope && failedBlocks.length > 0 && (
        <div data-failure-navigation className="flex min-h-11 items-center gap-2 border-b px-3 text-xs">
          <span className="min-w-0 flex-1 text-destructive" role="status">
            {query ? "匹配列表中的失败命令" : "失败命令"} {failedIndex + 1} / {failedBlocks.length}
          </span>
          <Button variant="ghost" className="min-h-11" aria-label="上一条失败命令" onClick={() => moveFailure(-1)}>
            上一条
          </Button>
          <Button variant="ghost" className="min-h-11" aria-label="下一条失败命令" onClick={() => moveFailure(1)}>
            下一条
          </Button>
        </div>
      )}
      {query && (
        <div
          data-search-navigation
          className="flex min-h-11 items-center gap-1 border-b px-3 text-xs text-muted-foreground"
        >
          <div className="min-w-0 flex-1 py-1">
            <span role="status" className="block">
              {navigatingLive
                ? "当前定位：实时输出"
                : searchScope && !visible.length && !liveMatch
                  ? "没有匹配命令块"
                  : `内容匹配 ${outputOrdinal + 1} / ${outputTotal}`}
            </span>
            {!searchScope && (
              <span role="status" className="block">
                {visible.length ? `命令块 ${searchIndex + 1} / ${visible.length}` : "没有匹配命令块"}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={searchScope ? "上一处块内匹配" : "上一处跨块匹配"}
            title="上一处匹配 · Shift+Enter / Shift+F3"
            disabled={!outputTotal && !(showScopedLiveTerminal && liveMatch)}
            onClick={() => moveOutputSearch(-1)}
          >
            <ChevronUp className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={searchScope ? "下一处块内匹配" : "下一处跨块匹配"}
            title="下一处匹配 · Enter / F3"
            disabled={!outputTotal && !(showScopedLiveTerminal && liveMatch)}
            onClick={() => moveOutputSearch(1)}
          >
            <ChevronDown className="size-4" />
          </Button>
          {!searchScope && (
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label="清除输出搜索"
              title="清除输出搜索 · Esc"
              onClick={closeOutputSearch}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      )}
      {[...new Set([session.error, error, streamError].filter(Boolean))].map((value) => (
        <div key={value} role="alert" className="border-b px-3 py-2 text-sm text-destructive">
          {value}
        </div>
      ))}
      {engine.current?.projectionLimited && (
        <div role="status" className="border-b px-3 py-2 text-sm text-muted-foreground">
          显示保护已忽略超长字形或控制序列；已保存的原始输出未被此保护改写。
        </div>
      )}
      {outputStopped && (
        <div role="status" className="border-b px-3 py-2 text-sm text-muted-foreground">
          输出记录已停止，当前画面不再更新。仅可中断程序或关闭会话；已记录内容仍可搜索和复制。
        </div>
      )}
      {streamError && (
        <div className="border-b px-3 py-1">
          <Button variant="ghost" className="min-h-11" onClick={() => retryStream.current()}>
            重试输出同步
          </Button>
        </div>
      )}
      {session.warning && (
        <div role="status" className="border-b px-3 py-2 text-sm text-muted-foreground">
          {session.warning}
        </div>
      )}
      <Dialog
        open={rerunBlock !== null}
        onOpenChange={(open) => {
          if (!open) setRerunBlock(null);
        }}
      >
        <DialogContent
          className="max-w-lg"
          onCloseAutoFocus={(event) => {
            if (rerunEdit.current) {
              event.preventDefault();
              rerunEdit.current = false;
              input.current?.focus({ preventScroll: true });
            } else if (copyReturnFocus.current?.isConnected) {
              event.preventDefault();
              copyReturnFocus.current.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>重新执行命令</DialogTitle>
            <DialogDescription>命令将由当前会话执行，不会自动切换到原来的目录。</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[35dvh] overflow-auto whitespace-pre-wrap break-all border-y py-3 font-mono text-sm">
            {rerunBlock?.command}
          </pre>
          <div className="min-w-0 space-y-2 text-xs text-muted-foreground">
            <div>
              执行目录：<span className="break-all font-mono">{session.cwd}</span>
            </div>
            {rerunBlock?.cwd && rerunBlock.cwd !== session.cwd && (
              <div role="status">
                目录已变化，原目录：<span className="break-all font-mono">{rerunBlock.cwd}</span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" className="min-h-11" onClick={() => setRerunBlock(null)}>
              取消
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!ready || !control || pending}
              onClick={() => {
                if (!rerunBlock) return;
                rerunEdit.current = true;
                reuseCommand(rerunBlock.command);
                setRerunBlock(null);
              }}
            >
              编辑后执行
            </Button>
            <Button
              className="min-h-11"
              disabled={!ready || !control || pending}
              onClick={() => {
                if (!rerunBlock) return;
                const command = rerunBlock.command;
                setRerunBlock(null);
                void submit(command);
              }}
            >
              立即执行
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <BlockActionMenu
        anchor={blockMenuAnchor}
        open={copyMenu !== null}
        onClose={() => setCopyMenu(null)}
        title="命令块操作"
        onCloseAutoFocus={(event) => {
          const action = menuCommandAction.current;
          menuCommandAction.current = null;
          if (action) {
            event.preventDefault();
            if (action.action === "search") {
              setSearchScope(action.block);
              setQuery("");
              setOutputTarget(null);
              setLiveTargetQuery(null);
              setSelectedBlock(action.block.id);
              setCollapsed((current) => {
                const next = new Set(current);
                next.delete(action.block.id);
                return next;
              });
              follow.current.following = false;
              setDetached(true);
              searchReturnFocus.current = copyReturnFocus.current;
              requestAnimationFrame(() => {
                virtual.scrollToIndex(0, { align: "start" });
                searchInput.current?.focus();
              });
            } else if (action.action === "edit") reuseCommand(action.block.command);
            else {
              rerunEdit.current = false;
              setRerunBlock(action.block);
            }
            return;
          }
          const target = copyReturnFocus.current;
          if (target?.isConnected && !target.closest("[inert]")) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
        items={
          copyMenu
            ? [
                ...(copyMenu.command
                  ? [
                      {
                        icon: <Copy className="size-4" />,
                        label: "仅复制命令",
                        onClick: () => void copy(copyMenu.command, "命令"),
                      },
                      {
                        icon: <TerminalIcon className="size-4" />,
                        label: "编辑命令",
                        disabled: !ready || !control || pending || showLiveTerminal,
                        onClick: () => {
                          menuCommandAction.current = { block: copyMenu, action: "edit" };
                        },
                      },
                      {
                        icon: <RotateCcw className="size-4" />,
                        label: "重新执行命令",
                        disabled: !ready || !control || pending,
                        onClick: () => {
                          menuCommandAction.current = { block: copyMenu, action: "rerun" };
                        },
                      },
                    ]
                  : []),
                {
                  icon: <Copy className="size-4" />,
                  label: "仅复制已渲染输出",
                  onClick: () => void copy(blockOutput(copyMenu.id), "已渲染输出"),
                },
                {
                  icon: <Copy className="size-4" />,
                  label: "复制命令和已渲染输出",
                  onClick: () => void copy(`${copyMenu.command}\n${blockOutput(copyMenu.id)}`),
                },
                {
                  icon: downloading === copyMenu.id ? <Square className="size-4" /> : <Download className="size-4" />,
                  label: downloading === copyMenu.id ? "取消输出下载" : "下载已记录的原始输出",
                  disabled: downloading !== null && downloading !== copyMenu.id,
                  onClick: () =>
                    downloading === copyMenu.id ? downloadController.current?.abort() : void download(copyMenu),
                },
                {
                  icon: <Search className="size-4" />,
                  label: "在此块中查找",
                  onClick: () => {
                    menuCommandAction.current = { block: copyMenu, action: "search" };
                  },
                },
              ]
            : []
        }
      />
      {downloading && (
        <div className="flex items-center gap-2 border-b px-3 py-2 text-sm text-muted-foreground">
          <span role="status" className="min-w-0 flex-1">
            正在下载原始输出：已读取 {downloadBytes.toLocaleString()} 字节
          </span>
          <Button variant="ghost" className="min-h-11 shrink-0" onClick={() => downloadController.current?.abort()}>
            取消下载
          </Button>
        </div>
      )}
      {copyStatus && (
        <div role="status" className="border-b px-3 py-2 text-sm text-muted-foreground">
          {copyStatus}
        </div>
      )}
      <div
        ref={scroll}
        data-blockterm-scroll
        data-alternate-screen={focusedAlternate || undefined}
        onCopy={(event) => {
          const selection = document.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
          const range = selection.getRangeAt(0);
          const endpoint = (node: Node, offset: number): CopyPoint | null => {
            const element = node instanceof Element ? node : node.parentElement;
            const command = element?.closest<HTMLElement>("[data-block-command]");
            if (command && event.currentTarget.contains(command)) {
              const block = command.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
              if (!block) return null;
              const prefix = document.createRange();
              prefix.selectNodeContents(command);
              prefix.setEnd(node, offset);
              return { block, screen: "command", row: 0, offset: prefix.toString().length };
            }
            const row = element?.closest<HTMLElement>("[data-output-row]");
            const screen = row?.closest<HTMLElement>("[data-output-screen]")?.dataset.outputScreen;
            const block = row?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
            if (!row || !event.currentTarget.contains(row) || !block || (screen !== "normal" && screen !== "alternate"))
              return null;
            const prefix = document.createRange();
            prefix.selectNodeContents(row);
            prefix.setEnd(node, offset);
            return { block, screen, row: Number(row.dataset.outputRow), offset: prefix.toString().length };
          };
          const start = endpoint(range.startContainer, range.startOffset);
          const end = endpoint(range.endContainer, range.endOffset);
          if (!start || !end) return;
          const sections: CopySection[] = [];
          for (const block of visible) {
            if (block.command) sections.push({ block: block.id, screen: "command", chunks: [block.command] });
            if (collapsed.has(block.id)) continue;
            for (const screen of ["normal", "alternate"] as const) {
              const snapshot = (
                screen === "normal" ? engine.current?.snapshots : engine.current?.alternateSnapshots
              )?.get(block.id);
              if (hasSnapshotText(snapshot)) sections.push({ block: block.id, screen, chunks: snapshot.textChunks });
            }
          }
          const text = copyOutputRange(sections, start, end);
          if (text === null) return;
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
          event.stopPropagation();
        }}
        onWheelCapture={(event) => {
          if (event.deltaY !== 0 && !event.ctrlKey && !event.shiftKey) markScrollIntent();
        }}
        onPointerDownCapture={markScrollIntent}
        onPointerMoveCapture={(event) => {
          if (event.buttons) markScrollIntent();
        }}
        onTouchMoveCapture={markScrollIntent}
        onKeyDownCapture={(event) => {
          if (isScrollNavigationKey(event.nativeEvent)) markScrollIntent();
        }}
        className={`min-h-0 overflow-auto [overflow-anchor:none] ${showLiveTerminal ? "flex-1" : "shrink"}`}
        onScroll={() => {
          const node = scroll.current;
          if (node && !query && !searchScope && !copyMenu && !focusedAlternate) {
            follow.current.observe(
              node.scrollTop,
              node.scrollHeight - node.clientHeight,
              performance.now() <= scrollIntentUntil.current
            );
            setDetached(!follow.current.following);
            if (alternateScreen && inspectHistory)
              normalScroll.current = { top: node.scrollTop, following: follow.current.following };
            if (follow.current.following && performance.now() > scrollIntentUntil.current) {
              cancelAnimationFrame(followCorrectionFrame.current);
              followCorrectionFrame.current = requestAnimationFrame(followOutput);
            }
          }
        }}
      >
        <div
          ref={outputContent}
          inert={focusedAlternate}
          aria-hidden={focusedAlternate}
          className={focusedAlternate ? "invisible relative w-full overflow-hidden" : "relative w-full"}
          style={{ height: focusedAlternate ? 0 : virtual.getTotalSize() }}
        >
          {virtual.getVirtualItems().map((item) => {
            const block = visible[item.index];
            const status = blockStatus(block);
            const duration = blockDuration(block, now);
            const folded = collapsed.has(block.id);
            const snapshot = engine.current?.snapshots.get(block.id);
            const alternate = engine.current?.alternateSnapshots.get(block.id);
            const copyBlock = () => copy(`${block.command}\n${blockOutput(block.id)}`);
            return (
              <section
                key={block.id}
                data-block-id={block.id}
                onClick={(event) => {
                  const target = event.target instanceof Element ? event.target : null;
                  if (
                    event.defaultPrevented ||
                    event.detail !== 1 ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
                    document.getSelection()?.isCollapsed === false ||
                    target?.closest("button, a, input, textarea, select, [role='button'], [contenteditable]")
                  )
                    return;
                  follow.current.following = false;
                  setDetached(true);
                  setSelectedBlock(block.id);
                  event.currentTarget.focus({ preventScroll: true });
                }}
                onFocusCapture={() => setFocusedBlock(block.id)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setFocusedBlock((current) => (current === block.id ? null : current));
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229 &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    ((event.key === "ContextMenu" && !event.shiftKey) || (event.key === "F10" && event.shiftKey))
                  ) {
                    const anchor = event.currentTarget.querySelector<HTMLButtonElement>("[data-block-menu-trigger]");
                    if (!anchor) return;
                    event.preventDefault();
                    event.stopPropagation();
                    blockMenuAnchor.current = anchor;
                    copyReturnFocus.current = event.currentTarget;
                    setCopyMenu(block);
                    return;
                  }
                  if (
                    event.target === event.currentTarget &&
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229 &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey &&
                    ready &&
                    control &&
                    !showLiveTerminal &&
                    block.command
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    reuseCommand(block.command);
                    return;
                  }
                  if (
                    event.target === event.currentTarget &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229 &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey &&
                    (event.key === "ArrowLeft" || event.key === "ArrowRight")
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    const collapse = event.key === "ArrowLeft";
                    follow.current.following = false;
                    setDetached(true);
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (collapse) next.add(block.id);
                      else next.delete(block.id);
                      return next;
                    });
                    return;
                  }
                  if (
                    event.target !== event.currentTarget ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229 ||
                    event.altKey ||
                    !event.shiftKey ||
                    !(event.ctrlKey || event.metaKey) ||
                    event.key.toLowerCase() !== "c"
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  void copyBlock();
                }}
                data-index={item.index}
                tabIndex={-1}
                aria-label={`命令块：${block.command || "后台输出"}`}
                aria-keyshortcuts="ArrowUp ArrowDown Home End ArrowLeft ArrowRight Enter Escape Shift+F10 ContextMenu"
                title="↑↓ 浏览命令块 · ←→ 折叠/展开 · Enter 复用命令 · Shift+F10 操作菜单 · Esc 返回输入"
                ref={virtual.measureElement}
                className={`absolute left-0 top-0 w-full min-w-0 border-b outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${selectedBlock === block.id ? "bg-muted/30" : ""}`}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start md:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <div className="col-start-1 row-start-1 flex min-h-11 min-w-0 items-start gap-1 px-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0"
                      aria-label={folded ? "展开输出" : "折叠输出"}
                      title="聚焦命令块后，按左方向键折叠、右方向键展开"
                      onClick={() =>
                        setCollapsed((previous) => {
                          const next = new Set(previous);
                          if (folded) next.delete(block.id);
                          else next.add(block.id);
                          return next;
                        })
                      }
                    >
                      {folded ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                    </Button>
                    {/* Native buttons suppress dragging to select their text. */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="min-h-11 min-w-0 flex-1 select-text whitespace-pre-wrap break-all py-3 text-left font-mono text-sm"
                      data-block-command={block.command ? true : undefined}
                      data-output-search-target={
                        (activeOutputTarget?.block === block.id && activeOutputTarget.screen === "command") || undefined
                      }
                      title="复用命令到输入框；聚焦命令块后也可按 Enter"
                      onBlur={() => {
                        if (commandSpace.current === block.id) commandSpace.current = null;
                      }}
                      onKeyDown={(event) => {
                        const plain =
                          !event.nativeEvent.isComposing &&
                          event.keyCode !== 229 &&
                          !event.altKey &&
                          !event.ctrlKey &&
                          !event.metaKey &&
                          !event.shiftKey;
                        if (!plain || event.key !== " ") commandSpace.current = null;
                        if (plain && (event.key === "Enter" || event.key === " ")) {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!event.repeat) {
                            if (event.key === " ") commandSpace.current = block.id;
                            else event.currentTarget.click();
                          }
                        }
                      }}
                      onKeyUp={(event) => {
                        if (event.key !== " ") return;
                        const armed = commandSpace.current === block.id;
                        commandSpace.current = null;
                        if (
                          armed &&
                          document.activeElement === event.currentTarget &&
                          !event.nativeEvent.isComposing &&
                          event.keyCode !== 229 &&
                          !event.altKey &&
                          !event.ctrlKey &&
                          !event.metaKey &&
                          !event.shiftKey
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.click();
                        }
                      }}
                      onClick={() => {
                        if (document.getSelection()?.isCollapsed === false) return;
                        reuseCommand(block.command);
                      }}
                    >
                      {block.command ? (
                        <HighlightedCommand
                          command={block.command}
                          query={query}
                          selected={
                            activeOutputTarget?.block === block.id && activeOutputTarget.screen === "command"
                              ? activeOutputTarget.index
                              : -1
                          }
                        />
                      ) : (
                        "后台输出"
                      )}
                    </div>
                  </div>
                  {!folded && (
                    <div
                      data-block-actions
                      className="col-span-2 col-start-1 row-start-2 flex min-h-6 min-w-0 items-center gap-1 px-3 pb-1 md:col-span-1 md:col-start-2 md:row-start-1 md:min-h-11 md:max-w-[min(45vw,32rem)] md:pb-0"
                    >
                      <span
                        className={`shrink-0 text-xs ${status.failed ? "text-destructive" : "text-muted-foreground"}`}
                        title={`退出码：${block.exit_code ?? "未知"}${block.native_exit_code == null ? "" : `；原生退出码：${block.native_exit_code}`}`}
                      >
                        {status.label}
                        {block.exit_code != null && block.exit_code !== 0 && ` (${block.exit_code})`}
                      </span>
                      <div className="flex min-w-0 flex-1 items-center gap-2 px-1 font-mono text-xs text-muted-foreground">
                        <span className="min-w-0 flex-1 truncate md:max-w-40" title={block.cwd}>
                          {block.cwd}
                        </span>
                        {block.shell_status != null && (
                          <span className="shrink-0" title="输入结束时的 Shell 状态，不是命令退出码">
                            shell {block.shell_status}
                          </span>
                        )}
                        {duration && (
                          <span
                            className="shrink-0"
                            title={`${block.started_at ? "执行耗时" : "提交后经过"} ${duration}`}
                          >
                            <span className="sr-only">{block.started_at ? "执行耗时 " : "提交后经过 "}</span>
                            {duration}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="col-start-2 row-start-1 mr-2 size-11 shrink-0 md:col-start-3"
                    aria-label="命令块操作"
                    data-block-menu-trigger
                    aria-haspopup="dialog"
                    title="复制、编辑、重跑、查找或下载输出"
                    onClick={(event) => {
                      copyReturnFocus.current = event.currentTarget;
                      blockMenuAnchor.current = event.currentTarget;
                      setCopyMenu(block);
                    }}
                  >
                    <Ellipsis className="size-4" />
                  </Button>
                </div>
                {folded && (
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-2 px-3 pb-2 text-left text-xs text-muted-foreground hover:bg-muted"
                    aria-label="展开此块输出"
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        next.delete(block.id);
                        return next;
                      })
                    }
                  >
                    <ChevronRight className="size-3 shrink-0" />
                    {status.label}
                    {block.exit_code != null && block.exit_code !== 0 ? ` (${block.exit_code})` : ""} ·{" "}
                    {showLiveTerminal && engine.current?.current === block.id
                      ? "实时输出已折叠"
                      : `已折叠 · ${(snapshot?.styledRows.length ?? 0) + (alternate?.styledRows.length ?? 0)} 行已渲染输出`}
                  </button>
                )}
                {!folded && snapshot && (
                  <div
                    className="px-3 pb-2"
                    data-output-screen="normal"
                    data-output-search-target={
                      (activeOutputTarget?.block === block.id && activeOutputTarget.screen === "normal") || undefined
                    }
                  >
                    <BlockOutput
                      snapshot={snapshot}
                      showSearchControls={!searchScope}
                      query={query}
                      onNavigate={(index) => selectLocalMatch(block.id, "normal", index)}
                      searchTarget={
                        activeOutputTarget?.block === block.id && activeOutputTarget.screen === "normal"
                          ? activeOutputTarget
                          : undefined
                      }
                    />
                  </div>
                )}
                {!folded && hasSnapshotText(alternate) && (
                  <div
                    className="px-3 pb-2"
                    data-output-screen="alternate"
                    data-output-search-target={
                      (activeOutputTarget?.block === block.id && activeOutputTarget.screen === "alternate") || undefined
                    }
                  >
                    <div className="py-1 text-xs text-muted-foreground">全屏程序最后画面</div>
                    <BlockOutput
                      snapshot={alternate}
                      showSearchControls={!searchScope}
                      query={query}
                      onNavigate={(index) => selectLocalMatch(block.id, "alternate", index)}
                      searchTarget={
                        activeOutputTarget?.block === block.id && activeOutputTarget.screen === "alternate"
                          ? activeOutputTarget
                          : undefined
                      }
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <div
          className={showScopedLiveTerminal && !liveFolded ? "px-3 py-2" : "h-0 overflow-hidden"}
          inert={!showScopedLiveTerminal || liveFolded}
          aria-hidden={!showScopedLiveTerminal || liveFolded}
        >
          {query && showLiveTerminal && (
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span className="w-full" role="status">
                {liveMatch ? "实时输出：已定位匹配" : "实时输出：没有匹配"}
              </span>
              {liveMatch && (
                <span role="status" className="w-full">
                  {liveResults.resultCount >= LIVE_SEARCH_LIMIT
                    ? `实时匹配至少 ${LIVE_SEARCH_LIMIT} 处，仅标记前 ${LIVE_SEARCH_LIMIT} 处`
                    : `实时匹配 ${liveResults.resultIndex + 1} / ${liveResults.resultCount}`}
                </span>
              )}
              {!searchScope && (
                <>
                  <Button variant="ghost" className="h-11" onClick={() => moveLocalLiveSearch("previous")}>
                    上一处实时匹配
                  </Button>
                  <Button variant="ghost" className="h-11" onClick={() => moveLocalLiveSearch("next")}>
                    下一处实时匹配
                  </Button>
                </>
              )}
            </div>
          )}
          <div ref={host} data-live-viewport className="min-w-0 overflow-x-auto overflow-y-hidden" />
        </div>
      </div>
      {detached && !focusedAlternate && (
        <Button
          variant="ghost"
          className="min-h-11 shrink-0 border-t"
          onClick={() => {
            setInspectHistory(false);
            revealLiveOutput();
            setQuery("");
            setSearchScope(null);
            engine.current?.searchOutput("");
            engine.current?.terminal.scrollToBottom();
            scrollIntentUntil.current = 0;
            follow.current.resume();
            requestAnimationFrame(followOutput);
          }}
        >
          <ChevronDown className="mr-1 size-4" />
          回到最新输出
        </Button>
      )}
      {completionMenu && (
        <CompletionOverlay anchor={input} bounds={pane}>
          <div className="flex min-h-11 items-center gap-2 px-3 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={completionMenu.heading}>
              {completionMenu.heading}
            </span>
            <Button variant="ghost" className="min-h-11" onClick={startShellCompletion}>
              使用原生 Shell 补全
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={completionMenu.kind === "path" ? "关闭路径补全" : "关闭命令补全"}
              onClick={() => {
                completionRequest.current?.abort();
                setCompletionMenu(null);
                input.current?.focus();
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div
            id={completionMenuId}
            role="listbox"
            aria-label={completionMenu.kind === "path" ? "路径补全候选" : "命令补全候选"}
            className="min-h-11 flex-1 overflow-y-auto"
          >
            {completionMenu.items.map((item, index) => (
              <button
                key={item.label}
                id={`${completionMenuId}-${index}`}
                role="option"
                aria-selected={index === completionMenu.index}
                className="flex min-h-11 w-full items-center gap-2 px-3 text-left font-mono text-sm hover:bg-muted aria-selected:bg-muted"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => acceptCompletion(item)}
              >
                <span className="min-w-0 flex-1 truncate" title={item.label}>
                  <span className="block truncate">{item.label}</span>
                  {item.description && (
                    <span className="block truncate font-sans text-xs text-muted-foreground" title={item.description}>
                      {item.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.category ?? (item.directory ? "目录" : "文件")}
                </span>
              </button>
            ))}
          </div>
          {completionMenu.loading && (
            <div role="status" className="px-3 py-2 text-sm">
              正在读取目录…
            </div>
          )}
          {completionMenu.error && (
            <div role="alert" className="px-3 py-2 text-sm text-destructive">
              {completionMenu.error}
            </div>
          )}
          {!completionMenu.loading && !completionMenu.error && !completionMenu.items.length && (
            <div role="status" className="px-3 py-2 text-sm">
              没有匹配路径，可使用原生 Shell 补全
            </div>
          )}
          <div className="px-3 py-2 text-xs text-muted-foreground">
            ↑↓ / Tab 选择 · Enter 填入 · Esc 关闭
            {completionMenu.items.length === 200 ? " · 最多显示 200 项，可输入更长前缀" : ""}
          </div>
        </CompletionOverlay>
      )}
      {historyOpen && (
        <div className="flex max-h-[45dvh] min-h-0 shrink-0 flex-col border-t bg-background">
          <div className="flex min-h-11 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={draft || "全部命令"}>
              {draft ? `匹配 “${draft}”` : "命令历史"} · {historyOptions.length}
              {historyMore ? "+" : ""} 条
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label="关闭命令历史"
              onClick={() => {
                setHistoryOpen(false);
                setHistorySelection(null);
                input.current?.focus();
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div
            id={historyId}
            className="min-h-11 flex-1 overflow-auto"
            role="listbox"
            aria-label="命令历史"
            aria-busy={historyLoading}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)
                return;
              if (event.key === "Escape") {
                event.preventDefault();
                setHistoryOpen(false);
                setHistorySelection(null);
                input.current?.focus();
              } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                const index = historyOptions.indexOf(historySelectionRef.current ?? "");
                const next = Math.max(
                  0,
                  Math.min(historyOptions.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))
                );
                if (historyOptions[next] !== undefined) {
                  event.preventDefault();
                  document.getElementById(`${historyId}-${next}`)?.focus();
                }
              }
            }}
          >
            {historyError && (
              <div className="flex items-center gap-2 px-3 text-sm">
                <span role="alert" className="min-w-0 flex-1 text-destructive">
                  {historyError}
                </span>
                <Button
                  variant="ghost"
                  className="min-h-11 shrink-0"
                  disabled={historyLoading}
                  onClick={() => void loadHistory()}
                >
                  重试历史加载
                </Button>
              </div>
            )}
            {historyOptions.map((command, index) => (
              <button
                key={command}
                id={`${historyId}-${index}`}
                role="option"
                aria-selected={historyIndex === index}
                type="button"
                className="block min-h-11 w-full truncate px-3 text-left font-mono text-sm hover:bg-muted aria-selected:bg-muted"
                title={command}
                onFocus={() => setHistorySelection(command)}
                onClick={() => acceptHistory(command)}
              >
                <HighlightedCommand command={command} query={draft} selected={-1} />
              </button>
            ))}
            {historyLoading && (
              <div role="status" className="px-3 py-3 text-sm text-muted-foreground">
                正在加载命令历史…
              </div>
            )}
            {!historyLoading && !historyError && historyOptions.length === 0 && (
              <div role="status" className="px-3 py-3 text-sm text-muted-foreground">
                {draft ? "没有匹配的命令" : "暂无命令历史"}
              </div>
            )}
            {historyMore && (
              <Button
                variant="ghost"
                className="min-h-11 w-full"
                disabled={historyLoading}
                onClick={() => void loadHistory()}
              >
                加载更多
              </Button>
            )}
          </div>
          {historyOptions.length > 0 && (
            <div className="shrink-0 border-t px-3 py-2">
              <div className="mb-1 text-xs text-muted-foreground">命令预览 · 选择后填入，不立即执行</div>
              <pre
                data-history-preview
                className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-sm"
              >
                {historyOptions[historyIndex < 0 ? 0 : historyIndex]}
              </pre>
            </div>
          )}
          <div className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">
            输入以筛选 · ↑↓ 选择 · Enter 填入 · Esc 关闭
          </div>
        </div>
      )}
      <div
        data-terminal-input-area
        className="shrink-0 border-t bg-background px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {showLiveTerminal && (
          <button
            type="button"
            data-running-command
            className="flex min-h-11 w-full min-w-0 items-center gap-2 text-left"
            aria-label="返回正在运行的终端"
            title={activeCommand?.command || "返回交互终端"}
            onClick={() => {
              setInspectHistory(false);
              revealLiveOutput();
              setQuery("");
              setSearchScope(null);
              engine.current?.searchOutput("");
              engine.current?.terminal.scrollToBottom();
              scrollIntentUntil.current = 0;
              follow.current.resume();
              setDetached(false);
              requestAnimationFrame(() => {
                const node = scroll.current;
                if (node) node.scrollTop = node.scrollHeight;
                if (control && connected && !streamError && !outputStopped) engine.current?.terminal.focus();
              });
            }}
          >
            <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{activeCommand?.command || "交互终端"}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {session.phase === "submitted" ? "待执行" : running ? "运行中" : "原生输入"}
              {liveFolded ? " · 输出已折叠" : ""}
              {activeCommand && blockDuration(activeCommand, now) ? ` · ${blockDuration(activeCommand, now)}` : ""}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
        {!showLiveTerminal && (
          <div
            data-command-context
            className="flex min-w-0 items-center gap-2 pb-1 font-mono text-xs text-muted-foreground"
          >
            <span className="min-w-0 flex-1 truncate" title={session.cwd}>
              {session.cwd}
            </span>
            <span className="shrink-0">{session.shell}</span>
          </div>
        )}
        {showLiveTerminal && !liveFolded && (
          <div role="group" aria-label="终端触控按键" className="grid grid-cols-6 gap-1 border-b pb-1">
            {[
              { label: "Esc", name: "终端 Escape 键", data: "\x1b" },
              { label: "Tab", name: "终端 Tab 键", data: "\t" },
              { label: "←", name: "终端向左键", arrow: "D" },
              { label: "↑", name: "终端向上键", arrow: "A" },
              { label: "↓", name: "终端向下键", arrow: "B" },
              { label: "→", name: "终端向右键", arrow: "C" },
            ].map((key) => (
              <Button
                key={key.name}
                variant="ghost"
                className="min-h-11 min-w-0 px-1 font-mono"
                aria-label={key.name}
                disabled={!control || !connected || !!streamError || outputStopped}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (composing.current) return;
                  const data =
                    key.data ??
                    `\x1b${engine.current?.terminal.modes.applicationCursorKeysMode ? "O" : "["}${key.arrow}`;
                  sendInput(data);
                }}
              >
                {key.label}
              </Button>
            ))}
          </div>
        )}
        {showLiveTerminal ? (
          <div key="terminal-controls" className="flex items-center gap-2">
            <button
              type="button"
              className="min-h-11 flex-1 text-left text-sm text-muted-foreground"
              disabled={!control || !connected}
              onClick={focusLiveTerminal}
            >
              {outputStopped
                ? "输出已停止 · Ctrl-C 中断或关闭会话"
                : streamError
                  ? "同步失败 · 请重试输出同步"
                  : !connected
                    ? "重连中 · 等待输出同步"
                    : control
                      ? "点击终端输入 · Ctrl-C 中断"
                      : "只读终端 · 等待控制权"}
            </button>
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={!control || !connected}
              onClick={() => sendInput("\x03")}
            >
              <Square className="mr-1 size-4" />
              中断
            </Button>
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={!control || !connected || outputStopped}
              onClick={() => sendInput("\x04")}
            >
              EOF
            </Button>
          </div>
        ) : (
          <div key="command-composer" className="flex flex-wrap items-end gap-x-2 sm:flex-nowrap">
            <span
              aria-hidden="true"
              className="flex h-11 shrink-0 self-start items-center font-mono text-muted-foreground"
            >
              ❯
            </span>
            <div className="relative min-w-0 flex-1 basis-[calc(100%-1.5rem)] sm:basis-0">
              {historySuggestion && suggestionCursor === draft && (
                <div
                  ref={(node) => {
                    suggestionLayer.current = node;
                    if (node && input.current) {
                      node.style.width = `${input.current.clientWidth}px`;
                      node.scrollTop = input.current.scrollTop;
                      node.scrollLeft = input.current.scrollLeft;
                    }
                  }}
                  data-inline-history-suggestion
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words py-2 font-mono text-base text-muted-foreground sm:text-sm"
                >
                  <span className="text-transparent">{draft}</span>
                  <span>{historySuggestion.slice(draft.length)}</span>
                </div>
              )}
              <textarea
                ref={attachInput}
                aria-label="命令输入"
                aria-controls={completionMenu ? completionMenuId : historyOpen ? historyId : undefined}
                aria-activedescendant={
                  completionMenu?.items.length
                    ? `${completionMenuId}-${completionMenu.index}`
                    : historyOpen && historyIndex >= 0
                      ? `${historyId}-${historyIndex}`
                      : undefined
                }
                className="relative block max-h-[min(35dvh,20rem)] min-h-11 w-full min-w-0 resize-none overflow-y-auto bg-transparent py-2 font-mono text-base outline-none sm:text-sm"
                rows={1}
                placeholder={session.phase === "exited" ? "会话已结束" : "输入命令"}
                value={draft}
                onFocus={(event) => {
                  setSelectedBlock(null);
                  updateSuggestionCursor(event.currentTarget);
                }}
                onScroll={(event) => {
                  if (suggestionLayer.current) {
                    suggestionLayer.current.scrollTop = event.currentTarget.scrollTop;
                    suggestionLayer.current.scrollLeft = event.currentTarget.scrollLeft;
                  }
                }}
                onCompositionStart={(event) => {
                  completionRequest.current?.abort();
                  setCompletionMenu(null);
                  saveDraftSelection(event.currentTarget);
                  beginDraftGroup();
                  composing.current = true;
                  setSuggestionCursor(null);
                }}
                onCompositionEnd={(event) => {
                  setDraft(event.currentTarget.value);
                  endDraftGroup();
                  composing.current = false;
                  updateSuggestionCursor(event.currentTarget);
                }}
                onSelect={(event) => {
                  saveDraftSelection(event.currentTarget);
                  updateSuggestionCursor(event.currentTarget);
                  if (
                    completionMenu &&
                    completionMenu.draft === event.currentTarget.value &&
                    (event.currentTarget.selectionStart !== completionMenu.context.editor.cursor ||
                      event.currentTarget.selectionEnd !== completionMenu.context.editor.cursor)
                  ) {
                    completionRequest.current?.abort();
                    setCompletionMenu(null);
                  }
                }}
                onBlur={(event) => {
                  composing.current = false;
                  endDraftGroup();
                  saveDraftSelection(event.currentTarget);
                  if (
                    !(
                      event.relatedTarget instanceof HTMLElement &&
                      event.relatedTarget.hasAttribute("data-accept-history")
                    )
                  )
                    setSuggestionCursor(null);
                }}
                title="Enter 执行，Shift+Enter 换行，↑ 历史命令，Tab 补全；Ctrl-U/K/W 删除至行首/行尾/前一词，Ctrl-Y 恢复删除内容；Alt-↑/↓ 切换命令块，Alt-Home/End 跳到首尾，Esc 返回输入"
                disabled={!control || !ready}
                onChange={(event) => {
                  editDraftInput(event.currentTarget, (event.nativeEvent as InputEvent).inputType ?? "");
                  setHistorySelection(null);
                  inputHistory.current.reset();
                  updateSuggestionCursor(event.currentTarget);
                }}
                onKeyDown={(event) => {
                  if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (completionMenu && !event.ctrlKey && !event.altKey && !event.metaKey) {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      completionRequest.current?.abort();
                      setCompletionMenu(null);
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      const item = completionMenu.items[completionMenu.index];
                      if (item) acceptCompletion(item);
                      return;
                    }
                    if (
                      event.key === "Tab" ||
                      (!event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp"))
                    ) {
                      event.preventDefault();
                      if (completionMenu.items.length) {
                        const direction = event.key === "ArrowUp" || event.shiftKey ? -1 : 1;
                        const index =
                          (completionMenu.index + direction + completionMenu.items.length) %
                          completionMenu.items.length;
                        setCompletionMenu({ ...completionMenu, index });
                        document.getElementById(`${completionMenuId}-${index}`)?.scrollIntoView({ block: "nearest" });
                      }
                      return;
                    }
                  }
                  if (historySuggestion && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDismissedSuggestion(draft);
                      return;
                    }
                    if (
                      event.key === "ArrowRight" &&
                      event.currentTarget.selectionStart === draft.length &&
                      event.currentTarget.selectionEnd === draft.length
                    ) {
                      event.preventDefault();
                      acceptHistory(historySuggestion);
                      return;
                    }
                  }
                  const controlOnly = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
                  if (event.key.toLowerCase() === "z" && !event.altKey && event.ctrlKey !== event.metaKey) {
                    event.preventDefault();
                    travelInput(event.currentTarget, event.shiftKey);
                    return;
                  }
                  if (historyOpen && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      const direction = event.key === "ArrowDown" ? 1 : -1;
                      setHistorySelection((current) => {
                        const index = current === null ? -1 : historyOptions.indexOf(current);
                        const next =
                          index < 0
                            ? direction === 1
                              ? 0
                              : historyOptions.length - 1
                            : Math.max(0, Math.min(historyOptions.length - 1, index + direction));
                        return historyOptions[next] ?? null;
                      });
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const index = historyOptions.indexOf(historySelectionRef.current ?? "");
                      const command = historyOptions[index < 0 ? 0 : index];
                      if (command !== undefined) acceptHistory(command);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setHistoryOpen(false);
                      setHistorySelection(null);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
                    event.preventDefault();
                    void submit();
                  } else if (controlOnly && event.key === "r") {
                    event.preventDefault();
                    setHistoryOpen((value) => !value);
                    setHistorySelection(null);
                  } else if (
                    event.key === "Tab" &&
                    !event.shiftKey &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    !event.metaKey
                  ) {
                    event.preventDefault();
                    startCompletion();
                  } else if (controlOnly && event.key === "d" && !draft) {
                    event.preventDefault();
                    sendInput("\x04");
                  } else if (
                    controlOnly &&
                    (event.key === "u" ||
                      event.key === "k" ||
                      event.key === "w" ||
                      event.key === "y" ||
                      event.key === "d" ||
                      event.key === "h")
                  ) {
                    event.preventDefault();
                    if (event.key === "y" && !killedInput.current) return;
                    const node = event.currentTarget;
                    saveDraftSelection(node);
                    const next =
                      event.key === "y"
                        ? insertCommandText(draft, node.selectionStart, node.selectionEnd, killedInput.current)
                        : deleteCommandText(draft, node.selectionStart, node.selectionEnd, event.key);
                    if (event.key !== "y" && event.key !== "d" && event.key !== "h" && next.text !== draft)
                      killedInput.current = draft.slice(next.cursor, next.cursor + draft.length - next.text.length);
                    inputHistory.current.reset();
                    setHistorySelection(null);
                    setDraft(next.text);
                    queueMicrotask(() => {
                      if (input.current !== node || node.value !== next.text) return;
                      node.setSelectionRange(next.cursor, next.cursor);
                      saveDraftSelection(node);
                    });
                  } else if (event.key === "Escape") setHistoryOpen(false);
                  else if (controlOnly && event.key === "c") {
                    if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) return;
                    event.preventDefault();
                    inputHistory.current.reset();
                    setDraft("");
                    sendInput("\x03");
                  } else if (
                    event.key === "ArrowUp" ||
                    event.key === "ArrowDown" ||
                    (controlOnly && (event.key === "p" || event.key === "n"))
                  ) {
                    const direction = event.key === "ArrowUp" || event.key === "p" ? 1 : -1;
                    const node = event.currentTarget;
                    if (
                      (controlOnly && (event.key === "p" || event.key === "n")) ||
                      (!event.ctrlKey &&
                        !event.shiftKey &&
                        !event.altKey &&
                        !event.metaKey &&
                        canNavigateHistory(draft, node.selectionStart, node.selectionEnd, direction))
                    ) {
                      event.preventDefault();
                      const next = inputHistory.current.moveWithSelection(direction, draft, history, {
                        start: node.selectionStart,
                        end: node.selectionEnd,
                        direction: node.selectionDirection,
                      });
                      setDraft(next.text);
                      // Apply after React commits the controlled value, before the next input event.
                      queueMicrotask(() => {
                        if (input.current !== node || node.value !== next.text) return;
                        node.setSelectionRange(next.selection.start, next.selection.end, next.selection.direction);
                        saveDraftSelection(node);
                      });
                    }
                  }
                }}
              />
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
              <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 text-xs text-muted-foreground">
                {session.phase === "exited" && <span>历史输出已保留</span>}
                {completionMenu || historyOpen ? (
                  <span>Enter 填入 · Esc 关闭</span>
                ) : historySuggestion && suggestionCursor === draft ? (
                  <button
                    type="button"
                    data-accept-history
                    aria-label="补全历史命令"
                    title={historySuggestion}
                    className="min-h-11 text-left hover:text-foreground"
                    onPointerDown={(event) => event.preventDefault()}
                    onBlur={(event) => {
                      if (event.relatedTarget !== input.current) setSuggestionCursor(null);
                    }}
                    onClick={() => {
                      if (!composing.current) acceptHistory(historySuggestion);
                    }}
                  >
                    → 接受历史建议 · Esc 忽略
                  </button>
                ) : (
                  <>
                    {ready && control && (
                      <span className="sr-only">
                        <span>Enter 执行</span>
                        <span>Shift+Enter 换行</span>
                        <span>↑ 历史命令</span>
                      </span>
                    )}
                  </>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label="命令历史"
                onClick={() => {
                  setHistoryOpen((value) => !value);
                  setHistorySelection(null);
                  input.current?.focus();
                }}
              >
                <Search className="size-4" />
              </Button>
              {session.phase === "exited" ? (
                <Button
                  className="min-h-11 shrink-0"
                  disabled={creating}
                  title={`使用 ${session.shell} 在 ${session.cwd} 新建会话，不重放历史命令`}
                  onClick={() => onNewSession(session)}
                >
                  在此目录新建终端
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    className="min-h-11 min-w-11 shrink-0 px-2"
                    aria-label="Shell 补全"
                    title="命令、路径候选或原生 Shell 补全 · Tab"
                    disabled={!ready || !control || pending || !!streamError}
                    onClick={() => startCompletion()}
                  >
                    补全
                  </Button>
                  <Button
                    size="icon"
                    className="size-11 shrink-0"
                    aria-label="执行命令"
                    disabled={!ready || !control || pending || !draft.trim()}
                    onClick={() => void submit()}
                  >
                    <CornerDownLeft className="size-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
