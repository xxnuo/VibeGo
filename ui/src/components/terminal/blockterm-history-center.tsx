import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  LoaderCircle,
  MinusSquare,
  Play,
  Search,
  Square,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";
import { type BlockTermHistoryEntry, type BlockTermHistoryOutputResult, blockTermApi } from "@/api/blockterm";
import { createRendererFileClient } from "@/api/file";
import { type TerminalInfo, terminalApi } from "@/api/terminal";
import { useDialog } from "@/components/common";
import { type BlockTermBlock, stripAnsiForText } from "@/components/terminal/blockterm-model";
import { getIntlLocale, useTranslation } from "@/lib/i18n";
import { useAppStore, useFrameStore, useTerminalStore } from "@/stores";
import { useSessionStore } from "@/stores/session-store";
import { activateBlockTermHistoryTarget } from "./blockterm-history-navigation";
import {
  getBlockTermHistoryTerminalHeight,
  getBlockTermHistoryXtermTheme,
  resolveBlockTermHistoryTerminalCols,
  resolveBlockTermHistoryTerminalRows,
} from "./blockterm-history-preview";
import {
  BLOCKTERM_HISTORY_MAX_SELECTION,
  blockTermHistoryEntryToTarget,
  buildBlockTermHistoryPurgeTargets,
  collectBlockTermHistoryFilterOptions,
  toggleAllLoadedBlockTermHistory,
  toggleBlockTermHistorySelection,
} from "./blockterm-history-selection";
import BlockTermRendererHost from "./blockterm-renderer-host";
import { BLOCKTERM_TERMINAL_CONVERT_EOL, shouldUseBlockTermTerminalRenderer } from "./blockterm-terminal-output";
import {
  BlockTermWorkspaceNavigationCoordinator,
  type BlockTermWorkspaceNavigationDependencies,
  type BlockTermWorkspaceNavigationResult,
} from "./blockterm-workspace-navigation";
import type { BlockTermWorkspaceSearchTarget } from "./blockterm-workspace-search";

interface BlockTermHistoryCenterProps {
  groupId: string;
  onBack: () => void;
  onHistoryStarredChange?: (entry: BlockTermHistoryEntry, starred: boolean) => void;
  onUseCommand?: (command: string) => void;
}

const PAGE_SIZE = 100;

interface BlockTermHistoryOutputState {
  data?: Uint8Array;
  cursor?: number | null;
  loading?: boolean;
  failed?: boolean;
}

function historyEntryToBlock(
  entry: BlockTermHistoryEntry,
  output: Pick<BlockTermHistoryOutputResult, "data" | "cursor">
): BlockTermBlock {
  const value = new TextDecoder().decode(output.data);
  return {
    id: entry.id,
    terminalId: entry.terminalId,
    lineNum: entry.lineNum,
    kind: entry.kind ?? "command",
    command: entry.command,
    text: entry.text ?? "",
    runtimeType: entry.runtimeType === "ssh" ? "ssh" : "local",
    ...(entry.runtimeType === "ssh" && entry.sshProfileId ? { sshProfileId: entry.sshProfileId } : {}),
    output: value,
    outputSize: output.data.byteLength,
    outputCursor: output.cursor ?? entry.outputCursor ?? null,
    cmdPid: entry.cmdPid ?? null,
    remotePid: entry.remotePid ?? null,
    termCols: entry.termCols ?? 0,
    termRows: entry.termRows ?? 0,
    termFlexRows: entry.termFlexRows ?? false,
    termMaxPtySize: entry.termMaxPtySize ?? 0,
    beforeStateJson: entry.beforeStateJson,
    afterStateJson: entry.afterStateJson,
    status: entry.status ?? "success",
    mode: entry.mode ?? "text",
    cwd: entry.cwd,
    exitCode: entry.exitCode ?? null,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt ?? entry.createdAt,
    finishedAt: entry.finishedAt,
    collapsed: false,
    pinned: false,
    archived: false,
    starred: entry.starred,
    renderer: entry.renderer,
    stateJson: entry.stateJson,
    presentationJson: entry.presentationJson,
  };
}

const BlockTermHistoryTerminalPreview: React.FC<{
  block: BlockTermBlock;
  data: Uint8Array;
}> = ({ block, data }) => {
  const theme = useAppStore((state) => state.theme);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const cols = resolveBlockTermHistoryTerminalCols(block.termCols);
  const rows = resolveBlockTermHistoryTerminalRows(block.termRows);
  const height = getBlockTermHistoryTerminalHeight(rows);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const terminal = new XTerm({
      allowProposedApi: true,
      cols,
      convertEol: BLOCKTERM_TERMINAL_CONVERT_EOL,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      disableStdin: true,
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      rows,
      scrollback: 4000,
      theme: getBlockTermHistoryXtermTheme(theme),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(element);
    terminal.textarea?.setAttribute("aria-label", block.command);
    terminal.write(data);

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // The history row may have been collapsed before xterm measured it.
      }
    };
    const frame = window.requestAnimationFrame(fit);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            fit();
          });
    observer?.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      terminal.dispose();
    };
  }, [block.command, cols, data, rows, theme]);

  return (
    <div
      ref={elementRef}
      data-blockterm-history-terminal={block.id}
      className="min-w-0 overflow-hidden bg-ide-bg"
      style={{ height }}
    />
  );
};

const BlockTermHistoryOutputPreview: React.FC<{
  entry: BlockTermHistoryEntry;
  output: BlockTermHistoryOutputResult;
}> = ({ entry, output }) => {
  const block = useMemo(() => historyEntryToBlock(entry, output), [entry, output]);
  const fileClient = useMemo(
    () =>
      createRendererFileClient({
        runtimeType: entry.runtimeType === "ssh" ? "ssh" : "local",
        terminalId: entry.terminalId,
        blockId: entry.id,
        createdAt: entry.createdAt,
      }),
    [entry.createdAt, entry.id, entry.runtimeType, entry.terminalId]
  );
  const rawOutput = useCallback(
    async (_blockId: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return { data: output.data, startCursor: null, endCursor: output.cursor };
    },
    [output.cursor, output.data]
  );
  const fallback = (
    <pre className="max-h-64 min-h-6 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ide-mute">
      {stripAnsiForText(block.output)}
    </pre>
  );

  return (
    <div data-blockterm-history-output={entry.id}>
      {shouldUseBlockTermTerminalRenderer(block.renderer) ? (
        <BlockTermHistoryTerminalPreview block={block} data={output.data} />
      ) : (
        <BlockTermRendererHost
          block={block}
          fallback={fallback}
          fileClient={fileClient}
          rawOutput={rawOutput}
          readOnly
        />
      )}
    </div>
  );
};

const BlockTermHistoryCenter: React.FC<BlockTermHistoryCenterProps> = ({
  groupId,
  onBack,
  onHistoryStarredChange,
  onUseCommand,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const dialog = useDialog();
  const currentWorkspaceSessionId = useSessionStore((state) => state.currentSessionId);
  const workspaceSessions = useSessionStore((state) => state.sessions);
  const switchSession = useSessionStore((state) => state.switchSession);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [query, setQuery] = useState("");
  const [workspaceSessionId, setWorkspaceSessionId] = useState("");
  const [filterGroupId, setFilterGroupId] = useState("");
  const [runtimeType, setRuntimeType] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const [entries, setEntries] = useState<BlockTermHistoryEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, BlockTermHistoryOutputState>>({});
  const [navigationPendingId, setNavigationPendingId] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<"failed" | "unavailable" | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [starPendingIds, setStarPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const navigationRef = useRef(new BlockTermWorkspaceNavigationCoordinator());
  const mountedRef = useRef(true);
  const historyRevisionRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const outputAbortRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    void terminalApi
      .list(undefined, { signal: controller.signal })
      .then((result) => setTerminals(result.terminals || []))
      .catch(() => {
        if (!controller.signal.aborted) setTerminals([]);
      });
    return () => controller.abort();
  }, []);

  const sessionOptions = useMemo(
    () =>
      collectBlockTermHistoryFilterOptions(
        workspaceSessions.map((session) => session.id),
        terminals.map((item) => item.workspace_session_id),
        entries.map((entry) => entry.workspaceSessionId),
        [currentWorkspaceSessionId, workspaceSessionId]
      ),
    [currentWorkspaceSessionId, entries, terminals, workspaceSessionId, workspaceSessions]
  );
  const groupOptions = useMemo(
    () =>
      collectBlockTermHistoryFilterOptions(
        terminals.map((item) => item.group_id),
        entries.map((entry) => entry.groupId),
        [groupId, filterGroupId]
      ),
    [entries, filterGroupId, groupId, terminals]
  );
  const runtimeOptions = useMemo(
    () =>
      collectBlockTermHistoryFilterOptions(
        ["local", "ssh"],
        terminals.map((item) => item.runtime_type),
        entries.map((entry) => entry.runtimeType),
        [runtimeType]
      ),
    [entries, runtimeType, terminals]
  );
  const allLoadedSelected = entries.length > 0 && entries.every((entry) => selectedIds.has(entry.id));
  const someLoadedSelected = entries.some((entry) => selectedIds.has(entry.id));

  useEffect(() => {
    const revision = historyRevisionRef.current + 1;
    historyRevisionRef.current = revision;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    for (const controller of outputAbortRef.current.values()) controller.abort();
    outputAbortRef.current.clear();
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setEntries([]);
    setOffset(0);
    setHasMore(false);
    setExpandedId(null);
    setOutputs({});
    setSelectedIds(new Set());
    setPurgeError(false);
    const timer = window.setTimeout(() => {
      void blockTermApi
        .listHistory({
          query: query || undefined,
          workspaceSessionId: workspaceSessionId || undefined,
          groupId: filterGroupId || undefined,
          runtimeType: runtimeType || undefined,
          starredOnly,
          limit: PAGE_SIZE,
          offset: 0,
          signal: controller.signal,
        })
        .then((result) => {
          if (controller.signal.aborted || historyRevisionRef.current !== revision) return;
          setEntries(result.history);
          setHasMore(result.hasMore);
          setOffset(result.nextOffset);
          setLoading(false);
        })
        .catch(() => {
          if (!controller.signal.aborted && historyRevisionRef.current === revision) {
            setError(true);
            setLoading(false);
          }
        });
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filterGroupId, query, refreshNonce, runtimeType, starredOnly, workspaceSessionId]);

  const loadMore = () => {
    if (loading || !hasMore || loadMoreAbortRef.current) return;
    const revision = historyRevisionRef.current;
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    setError(false);
    void blockTermApi
      .listHistory({
        query: query || undefined,
        workspaceSessionId: workspaceSessionId || undefined,
        groupId: filterGroupId || undefined,
        runtimeType: runtimeType || undefined,
        starredOnly,
        limit: PAGE_SIZE,
        offset,
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted || historyRevisionRef.current !== revision) return;
        setEntries((current) => {
          const known = new Set(current.map((item) => item.id));
          return [...current, ...result.history.filter((item) => !known.has(item.id))];
        });
        setHasMore(result.hasMore);
        setOffset(result.nextOffset);
      })
      .catch(() => {
        if (!controller.signal.aborted && historyRevisionRef.current === revision) setError(true);
      })
      .finally(() => {
        if (loadMoreAbortRef.current !== controller) return;
        loadMoreAbortRef.current = null;
        if (controller.signal.aborted || historyRevisionRef.current !== revision) return;
        setLoading(false);
      });
  };

  const applySelectionResult = useCallback(
    (result: { selection: ReadonlySet<string>; limitExceeded: boolean }) => {
      if (result.limitExceeded) {
        toast.error(
          t("plugin.blockTerm.historySelectionLimit").replace("{count}", String(BLOCKTERM_HISTORY_MAX_SELECTION))
        );
        return;
      }
      setSelectedIds(result.selection);
      setPurgeError(false);
    },
    [t]
  );

  const toggleSelection = useCallback(
    (id: string) => {
      applySelectionResult(toggleBlockTermHistorySelection(selectedIds, id));
    },
    [applySelectionResult, selectedIds]
  );

  const toggleAllLoaded = useCallback(() => {
    applySelectionResult(toggleAllLoadedBlockTermHistory(entries, selectedIds));
  }, [applySelectionResult, entries, selectedIds]);

  const toggleHistoryStarred = useCallback(
    async (entry: BlockTermHistoryEntry) => {
      if (starPendingIds.has(entry.id) || purging) return;
      const starred = !entry.starred;
      setStarPendingIds((current) => new Set(current).add(entry.id));
      try {
        const result = await blockTermApi.updateHistoryStarred(blockTermHistoryEntryToTarget(entry), starred);
        onHistoryStarredChange?.(entry, result.history.starred);
        if (!mountedRef.current) return;
        if (starredOnly && !result.history.starred) {
          setRefreshNonce((current) => current + 1);
        } else {
          setEntries((current) => current.map((item) => (item.id === entry.id ? result.history : item)));
        }
      } catch {
        if (mountedRef.current) toast.error(t("plugin.blockTerm.historyFavoriteFailed"));
      } finally {
        if (mountedRef.current) {
          setStarPendingIds((current) => {
            const next = new Set(current);
            next.delete(entry.id);
            return next;
          });
        }
      }
    },
    [onHistoryStarredChange, purging, starPendingIds, starredOnly, t]
  );

  const copyCommand = useCallback(
    async (command: string) => {
      try {
        await navigator.clipboard.writeText(command);
        toast.success(t("plugin.blockTerm.historyCommandCopied"));
      } catch {
        toast.error(t("plugin.blockTerm.historyCommandCopyFailed"));
      }
    },
    [t]
  );

  const purgeSelectedHistory = useCallback(async () => {
    if (purging || selectedIds.size === 0) return;
    const targets = buildBlockTermHistoryPurgeTargets(entries, selectedIds);
    if (targets.length !== selectedIds.size) {
      setPurgeError(true);
      return;
    }
    const count = targets.length;
    const confirmed = await dialog.confirm(
      t("plugin.blockTerm.historyPurgeTitle"),
      t("plugin.blockTerm.historyPurgeConfirm").replace("{count}", String(count)),
      {
        confirmText: t("plugin.blockTerm.historyPurgeAction"),
        confirmVariant: "danger",
      }
    );
    if (!confirmed || !mountedRef.current) return;
    setPurging(true);
    setPurgeError(false);
    try {
      const result = await blockTermApi.purgeHistory(targets);
      if (!mountedRef.current) return;
      const purgedIDs = new Set(result.purgedIds);
      if (purgedIDs.size !== count || targets.some((target) => !purgedIDs.has(target.id))) {
        throw new Error("history purge response was incomplete");
      }
      setSelectedIds(new Set());
      setRefreshNonce((current) => current + 1);
      toast.success(t("plugin.blockTerm.historyPurged").replace("{count}", String(count)));
    } catch {
      if (mountedRef.current) setPurgeError(true);
    } finally {
      if (mountedRef.current) setPurging(false);
    }
  }, [dialog, entries, purging, selectedIds, t]);

  const toggleOutput = (entry: BlockTermHistoryEntry) => {
    if (expandedId === entry.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(entry.id);
    if (outputs[entry.id] && !outputs[entry.id].failed) return;
    outputAbortRef.current.get(entry.id)?.abort();
    const revision = historyRevisionRef.current;
    const controller = new AbortController();
    outputAbortRef.current.set(entry.id, controller);
    setOutputs((current) => ({ ...current, [entry.id]: { loading: true } }));
    void blockTermApi
      .getHistoryOutput(blockTermHistoryEntryToTarget(entry), controller.signal)
      .then((result) => {
        if (controller.signal.aborted || historyRevisionRef.current !== revision) return;
        setOutputs((current) => ({ ...current, [entry.id]: result }));
      })
      .catch(() => {
        if (!controller.signal.aborted && historyRevisionRef.current === revision) {
          setOutputs((current) => ({ ...current, [entry.id]: { failed: true } }));
        }
      })
      .finally(() => {
        if (outputAbortRef.current.get(entry.id) === controller) outputAbortRef.current.delete(entry.id);
      });
  };

  const getNavigationDependencies = useCallback(
    (): BlockTermWorkspaceNavigationDependencies => ({
      switchSession,
      getSessionState: () => useSessionStore.getState(),
      getFrameState: () => useFrameStore.getState(),
      getTerminalState: () => useTerminalStore.getState(),
      setActiveTerminal: (targetGroupId, terminalId) =>
        useTerminalStore.getState().setActiveId(targetGroupId, terminalId),
      setActiveGroup: (targetGroupId) => useFrameStore.getState().setActiveGroup(targetGroupId),
    }),
    [switchSession]
  );

  const buildNavigationTarget = useCallback(
    (entry: BlockTermHistoryEntry): BlockTermWorkspaceSearchTarget | null => {
      const terminal = terminals.find((item) => item.id === entry.terminalId);
      const workspaceId = entry.workspaceSessionId || terminal?.workspace_session_id || currentWorkspaceSessionId;
      if (!workspaceId) return null;
      const targetGroupId = entry.groupId || terminal?.group_id || groupId;
      const workspaceIndex = workspaceSessions.findIndex((session) => session.id === workspaceId);
      const groupTerminals = terminals.filter(
        (item) => item.workspace_session_id === workspaceId && item.group_id === targetGroupId && !item.parent_id
      );
      const terminalIndex = groupTerminals.findIndex((item) => item.id === entry.terminalId);
      const targetId = JSON.stringify([workspaceId, targetGroupId, entry.terminalId]);
      return {
        id: targetId,
        workspaceId,
        workspaceName: workspaceSessions.find((session) => session.id === workspaceId)?.name || workspaceId,
        workspaceOrder: workspaceIndex >= 0 ? workspaceIndex : Number.MAX_SAFE_INTEGER,
        groupId: targetGroupId,
        groupOrder: 0,
        tabId: entry.terminalId,
        tabName: terminal?.name || entry.terminalId,
        tabOrder: terminalIndex >= 0 ? terminalIndex : Number.MAX_SAFE_INTEGER,
        status: terminal?.status,
      };
    },
    [currentWorkspaceSessionId, groupId, terminals, workspaceSessions]
  );

  const openHistoryEntry = useCallback(
    async (entry: BlockTermHistoryEntry) => {
      const target = buildNavigationTarget(entry);
      if (!target) {
        setNavigationError("unavailable");
        return;
      }
      setNavigationError(null);
      setNavigationPendingId(target.id);
      let result: BlockTermWorkspaceNavigationResult;
      try {
        result = await activateBlockTermHistoryTarget(
          entry,
          target,
          navigationRef.current,
          getNavigationDependencies()
        );
      } catch {
        if (!mountedRef.current) return;
        setNavigationPendingId(null);
        setNavigationError("failed");
        return;
      }
      if (!navigationRef.current.isCurrent(result.requestId)) return;
      if (result.status === "activated") {
        if (mountedRef.current) {
          setNavigationPendingId(null);
          onBack();
        }
      } else if (result.status === "failed") {
        if (mountedRef.current) {
          setNavigationPendingId(null);
          setNavigationError("failed");
        }
      } else if (result.status === "unavailable") {
        if (mountedRef.current) {
          setNavigationPendingId(null);
          setNavigationError("unavailable");
        }
      }
    },
    [buildNavigationTarget, getNavigationDependencies, onBack]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadMoreAbortRef.current?.abort();
      for (const controller of outputAbortRef.current.values()) controller.abort();
      outputAbortRef.current.clear();
    };
  }, []);

  return (
    <div data-blockterm-history-center className="flex h-full min-h-0 flex-col bg-ide-panel text-ide-text">
      <div className="flex flex-wrap items-center gap-2 border-b border-ide-border bg-ide-bg p-3">
        <div className="flex min-h-11 min-w-0 basis-full flex-1 items-center gap-2 border border-ide-border bg-ide-panel px-2 sm:min-h-0 sm:min-w-[14rem] sm:basis-auto">
          <Search size={14} className="text-ide-mute" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={purging}
            placeholder={t("plugin.blockTerm.searchHistory")}
            aria-label={t("plugin.blockTerm.searchHistory")}
            className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none sm:h-8 sm:text-sm"
          />
        </div>
        <select
          value={workspaceSessionId}
          onChange={(event) => setWorkspaceSessionId(event.target.value)}
          disabled={purging}
          className="h-11 min-w-0 max-w-full basis-full border border-ide-border bg-ide-panel px-2 text-base sm:h-8 sm:max-w-[14rem] sm:basis-auto sm:flex-none sm:text-xs"
        >
          <option value="">{t("plugin.blockTerm.allWorkspaces")}</option>
          {sessionOptions.map((id) => (
            <option key={id} value={id}>
              {id === currentWorkspaceSessionId ? `${id} (${t("plugin.blockTerm.currentFilter")})` : id}
            </option>
          ))}
        </select>
        <select
          value={filterGroupId}
          onChange={(event) => setFilterGroupId(event.target.value)}
          disabled={purging}
          className="h-11 min-w-0 max-w-full basis-full border border-ide-border bg-ide-panel px-2 text-base sm:h-8 sm:max-w-[12rem] sm:basis-auto sm:flex-none sm:text-xs"
        >
          <option value="">{t("plugin.blockTerm.allGroups")}</option>
          {groupOptions.map((id) => (
            <option key={id} value={id}>
              {id === groupId ? `${id} (${t("plugin.blockTerm.currentFilter")})` : id}
            </option>
          ))}
        </select>
        <select
          value={runtimeType}
          onChange={(event) => setRuntimeType(event.target.value)}
          disabled={purging}
          className="h-11 min-w-0 max-w-full basis-full border border-ide-border bg-ide-panel px-2 text-base sm:h-8 sm:max-w-[10rem] sm:basis-auto sm:flex-none sm:text-xs"
        >
          <option value="">{t("plugin.blockTerm.allRemotes")}</option>
          {runtimeOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-blockterm-history-starred-filter
          aria-pressed={starredOnly}
          onClick={() => setStarredOnly((current) => !current)}
          disabled={purging}
          className={`flex min-h-11 basis-full items-center justify-center gap-1.5 border px-3 text-xs sm:h-8 sm:min-h-0 sm:basis-auto sm:px-2 ${
            starredOnly
              ? "border-ide-accent bg-ide-accent/10 text-ide-accent"
              : "border-ide-border bg-ide-panel text-ide-mute hover:text-ide-text"
          }`}
        >
          <Star size={13} className={starredOnly ? "fill-current" : undefined} />
          {t("plugin.blockTerm.favorite")}
        </button>
      </div>
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-ide-border bg-ide-panel px-2 sm:h-10 sm:px-3">
        <button
          type="button"
          data-blockterm-history-select-all
          onClick={toggleAllLoaded}
          disabled={entries.length === 0 || purging}
          title={
            allLoadedSelected ? t("plugin.blockTerm.clearHistorySelection") : t("plugin.blockTerm.selectLoadedHistory")
          }
          aria-label={
            allLoadedSelected ? t("plugin.blockTerm.clearHistorySelection") : t("plugin.blockTerm.selectLoadedHistory")
          }
          className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:text-ide-text disabled:opacity-40 sm:size-7"
        >
          {allLoadedSelected ? (
            <CheckSquare2 size={16} className="text-ide-accent" />
          ) : someLoadedSelected ? (
            <MinusSquare size={16} className="text-ide-accent" />
          ) : (
            <Square size={16} />
          )}
        </button>
        <span data-blockterm-history-selected-count className="text-xs text-ide-mute">
          {t("plugin.blockTerm.historySelectedCount").replace("{count}", String(selectedIds.size))}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          data-blockterm-history-purge
          onClick={() => void purgeSelectedHistory()}
          disabled={selectedIds.size === 0 || purging}
          title={t("plugin.blockTerm.historyPurgeAction")}
          className="flex min-h-11 items-center gap-1.5 px-2 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-40 sm:h-8 sm:min-h-0"
        >
          {purging ? <LoaderCircle size={14} className="animate-spin" /> : <Trash2 size={14} />}
          {t("plugin.blockTerm.historyPurgeAction")}
        </button>
      </div>
      {navigationError && (
        <div className="border-b border-ide-border bg-ide-bg px-3 py-2 text-xs text-red-500" role="alert">
          {navigationError === "failed"
            ? t("plugin.blockTerm.historyNavigationFailed")
            : t("plugin.blockTerm.historyNavigationUnavailable")}
        </div>
      )}
      {purgeError && (
        <div className="border-b border-ide-border bg-red-500/5 px-3 py-2 text-xs text-red-500" role="alert">
          {t("plugin.blockTerm.historyPurgeFailed")}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-ide-mute">
            <LoaderCircle size={16} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : error && entries.length === 0 ? (
          <div className="py-12 text-center text-sm text-red-500">{t("plugin.blockTerm.historySearchFailed")}</div>
        ) : entries.length === 0 ? (
          <div className="py-12 text-center text-sm text-ide-mute">{t("plugin.blockTerm.historyEmpty")}</div>
        ) : (
          entries.map((entry) => {
            const output = outputs[entry.id];
            const selected = selectedIds.has(entry.id);
            const starPending = starPendingIds.has(entry.id);
            return (
              <div
                key={entry.id}
                data-blockterm-history-entry={entry.id}
                data-selected={selected || undefined}
                className={`border-b border-ide-border px-3 py-2 ${selected ? "bg-ide-accent/5" : ""}`}
              >
                <div className="flex flex-wrap items-start gap-0 sm:flex-nowrap sm:gap-2">
                  <button
                    type="button"
                    data-blockterm-history-select={entry.id}
                    onClick={() => toggleSelection(entry.id)}
                    disabled={purging}
                    aria-pressed={selected}
                    aria-label={
                      selected ? t("plugin.blockTerm.deselectHistoryEntry") : t("plugin.blockTerm.selectHistoryEntry")
                    }
                    className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:text-ide-text disabled:opacity-40 sm:mt-0.5 sm:size-5"
                  >
                    {selected ? <CheckSquare2 size={14} className="text-ide-accent" /> : <Square size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleOutput(entry)}
                    disabled={purging}
                    aria-label={t("plugin.blockTerm.toggleOutput")}
                    className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:text-ide-text sm:mt-0.5 sm:size-5"
                  >
                    {expandedId === entry.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button
                    type="button"
                    data-blockterm-history-activate={entry.id}
                    onClick={() => void openHistoryEntry(entry)}
                    disabled={navigationPendingId !== null || purging}
                    className="min-h-11 min-w-0 flex-1 overflow-hidden py-1 text-left hover:bg-ide-bg sm:min-h-0 sm:py-0"
                  >
                    <div className="flex items-center gap-2">
                      {navigationPendingId === buildNavigationTarget(entry)?.id ? (
                        <LoaderCircle size={13} className="shrink-0 animate-spin text-ide-mute" />
                      ) : (
                        <History size={13} className="shrink-0 text-ide-mute" />
                      )}
                      <pre className="min-w-0 max-w-full whitespace-pre-wrap break-all font-mono text-xs">
                        {entry.command}
                      </pre>
                    </div>
                    <div className="mt-1 flex min-w-0 max-w-full flex-wrap gap-x-3 text-[11px] text-ide-mute">
                      <span className="min-w-0 max-w-full break-all">
                        {terminals.find((item) => item.id === entry.terminalId)?.name || entry.terminalId}
                      </span>
                      <span>{entry.runtimeType}</span>
                      {entry.status && <span data-blockterm-history-status={entry.status}>{entry.status}</span>}
                      <span data-blockterm-history-renderer={entry.renderer || "terminal"}>
                        {entry.renderer || "terminal"}
                      </span>
                      {entry.sshProfileId && <span className="break-all font-mono">{entry.sshProfileId}</span>}
                      {entry.remotePid !== null && entry.remotePid !== undefined && (
                        <span className="font-mono">remote pid {entry.remotePid}</span>
                      )}
                      <span className="min-w-0 max-w-full break-all font-mono">{entry.cwd}</span>
                      <span>{new Date(entry.createdAt).toLocaleString(getIntlLocale(locale))}</span>
                    </div>
                  </button>
                  <div className="flex w-full shrink-0 justify-end sm:w-auto">
                    <button
                      type="button"
                      data-blockterm-history-star={entry.id}
                      onClick={() => void toggleHistoryStarred(entry)}
                      disabled={starPending || purging}
                      aria-pressed={entry.starred}
                      aria-label={entry.starred ? t("plugin.blockTerm.unfavorite") : t("plugin.blockTerm.favorite")}
                      title={entry.starred ? t("plugin.blockTerm.unfavorite") : t("plugin.blockTerm.favorite")}
                      className={`flex size-11 shrink-0 items-center justify-center sm:mt-0.5 sm:size-5 ${
                        entry.starred ? "text-ide-accent" : "text-ide-mute hover:text-ide-text"
                      } disabled:opacity-50`}
                    >
                      {starPending ? (
                        <LoaderCircle size={14} className="animate-spin" />
                      ) : entry.starred ? (
                        <StarOff size={14} />
                      ) : (
                        <Star size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      data-blockterm-history-copy={entry.id}
                      onClick={() => void copyCommand(entry.command)}
                      disabled={!entry.command || purging}
                      title={t("common.copy")}
                      aria-label={t("common.copy")}
                      className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:text-ide-text disabled:opacity-40 sm:mt-0.5 sm:size-5"
                    >
                      <Copy size={14} />
                    </button>
                    {onUseCommand && (
                      <button
                        type="button"
                        data-blockterm-history-use={entry.id}
                        onClick={() => onUseCommand(entry.command)}
                        disabled={!entry.command || purging}
                        title={t("plugin.blockTerm.useHistoryCommand")}
                        aria-label={t("plugin.blockTerm.useHistoryCommand")}
                        className="flex size-11 shrink-0 items-center justify-center text-ide-mute hover:text-ide-text disabled:opacity-40 sm:mt-0.5 sm:size-5"
                      >
                        <Play size={14} />
                      </button>
                    )}
                  </div>
                </div>
                {expandedId === entry.id && (
                  <div className="ml-6 mt-2 border-l border-ide-border pl-3">
                    {output?.loading ? (
                      <LoaderCircle size={14} className="animate-spin text-ide-mute" />
                    ) : output?.failed ? (
                      <span className="text-xs text-ide-mute">{t("plugin.blockTerm.outputUnavailable")}</span>
                    ) : output?.data !== undefined ? (
                      <BlockTermHistoryOutputPreview
                        entry={entry}
                        output={{ data: output.data, cursor: output.cursor ?? null }}
                      />
                    ) : (
                      <span className="text-xs text-ide-mute">{t("plugin.blockTerm.outputUnavailable")}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        {error && entries.length > 0 && (
          <div className="border-t border-ide-border px-3 py-2 text-center text-xs text-red-500" role="alert">
            {t("plugin.blockTerm.loadMoreHistoryFailed")}
          </div>
        )}
        {hasMore && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="flex min-h-11 w-full items-center justify-center gap-2 border-t border-ide-border text-xs text-ide-mute hover:bg-ide-bg sm:h-10 sm:min-h-0"
          >
            {loading && <LoaderCircle size={14} className="animate-spin" />}
            {t("plugin.blockTerm.loadMoreHistory")}
          </button>
        )}
      </div>
    </div>
  );
};

export default BlockTermHistoryCenter;
