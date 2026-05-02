import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock3,
  Copy,
  Database,
  FolderOpen,
  FolderSearch,
  History,
  ListChecks,
  ListTree,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import React from "react";
import { toast } from "sonner";
import { aiSessionApi } from "@/api";
import SessionListItem from "@/components/ai-session/session-list-item";
import SessionMessageItem from "@/components/ai-session/session-message-item";
import SessionOutline from "@/components/ai-session/session-outline";
import {
  buildSessionOutlineItems,
  buildSessionSearchText,
  formatCount,
  formatDateTime,
  isLongAISessionMessage,
  providerLabels,
  providerOrder,
} from "@/components/ai-session/utils";
import { useDialog } from "@/components/common";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useFrameController } from "@/framework/frame/controller";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import type {
  AIDeleteRequest,
  AIListResponse,
  AIProviderConfig,
  AIProviderId,
  AIProviderStatus,
  AISessionConfig,
  AISessionMessage,
  AISessionMeta,
} from "@/types/ai-session";

type PanelView = "list" | "detail" | "settings";
type ProviderFilter = "all" | AIProviderId;

function defaultConfigValue(): AISessionConfig {
  return {
    providers: {
      claude: { enabled: true, paths: [] },
      codex: { enabled: true, paths: [] },
      gemini: { enabled: true, paths: [] },
      opencode: { enabled: true, paths: [] },
      openclaw: { enabled: true, paths: [] },
    },
    autoRescanOnOpen: false,
    cacheEnabled: true,
    showParseErrors: true,
  };
}

const DEFAULT_CONFIG = defaultConfigValue();

function useAISessionData() {
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState("");
  const [response, setResponse] = React.useState<AIListResponse | null>(null);

  const requestList = React.useCallback((mode: "list" | "rescan") => {
    return mode === "rescan" ? aiSessionApi.rescan() : aiSessionApi.list();
  }, []);

  const load = React.useCallback(
    async (mode: "list" | "rescan" = "list") => {
      const setBusy = mode === "rescan" ? setRefreshing : setLoading;
      setBusy(true);
      setError("");
      try {
        const next = await requestList(mode);
        setResponse(next);
        return next;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        setError(message);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [requestList]
  );

  React.useEffect(() => {
    void load("list").catch(() => {});
  }, [load]);

  return { loading, refreshing, error, response, load, setResponse };
}

const AISessionManagerPage: React.FC = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const dialog = useDialog();
  const isMobile = useIsMobile();
  const openFolder = useSessionStore((s) => s.openFolder);
  const { setPageMenuItems } = useFrameController();
  const { loading, refreshing, error, response, load, setResponse } = useAISessionData();

  const sessions = response?.sessions || [];
  const providerStatus = response?.providerStatus || [];
  const config = response?.config || DEFAULT_CONFIG;

  const [providerFilter, setProviderFilter] = React.useState<ProviderFilter>("all");
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<PanelView>("list");
  const [selectedSourcePath, setSelectedSourcePath] = React.useState("");
  const [detailSearch, setDetailSearch] = React.useState("");
  const [messages, setMessages] = React.useState<AISessionMessage[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState("");
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [configDraft, setConfigDraft] = React.useState<AISessionConfig>(config);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [collapsedProviders, setCollapsedProviders] = React.useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [checkedKeys, setCheckedKeys] = React.useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = React.useState<AISessionMeta[]>([]);
  const [deleting, setDeleting] = React.useState(false);
  const [pullDistance, setPullDistance] = React.useState(0);
  const [detailHeaderCollapsed, setDetailHeaderCollapsed] = React.useState(false);
  const [detailHeaderHeight, setDetailHeaderHeight] = React.useState(0);
  const [expandedMessageIndexes, setExpandedMessageIndexes] = React.useState<Set<number>>(new Set());

  const detailHeaderRef = React.useRef<HTMLDivElement | null>(null);
  const listScrollRef = React.useRef<HTMLDivElement | null>(null);
  const listScrollTopRef = React.useRef(0);
  const listFocusSourcePathRef = React.useRef("");
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const detailTouchStateRef = React.useRef({ startY: 0, armed: false });
  const pullStateRef = React.useRef<{ startY: number; pulling: boolean; triggered: boolean }>({
    startY: 0,
    pulling: false,
    triggered: false,
  });
  const [activeMessageIndex, setActiveMessageIndex] = React.useState<number | null>(null);

  React.useEffect(() => {
    setConfigDraft(config);
  }, [config]);

  const filteredSessions = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (providerFilter !== "all" && session.providerId !== providerFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return buildSessionSearchText(session).toLowerCase().includes(needle);
    });
  }, [providerFilter, query, sessions]);

  const sessionKey = React.useCallback(
    (session: AISessionMeta) => `${session.providerId}:${session.sessionId}:${session.sourcePath}`,
    []
  );

  const selectedSession =
    filteredSessions.find((item) => item.sourcePath === selectedSourcePath) ||
    sessions.find((item) => item.sourcePath === selectedSourcePath) ||
    null;

  React.useEffect(() => {
    if (!selectedSession) {
      if (!isMobile && filteredSessions.length > 0) {
        setSelectedSourcePath(filteredSessions[0].sourcePath);
        setView("detail");
      } else if (filteredSessions.length === 0) {
        setSelectedSourcePath("");
        if (isMobile) {
          setView("list");
        }
      }
    }
  }, [filteredSessions, isMobile, selectedSession]);

  React.useEffect(() => {
    if (!selectedSession) {
      setMessages([]);
      setDetailError("");
      setDetailSearch("");
      setDetailHeaderCollapsed(false);
      setExpandedMessageIndexes(new Set());
      return;
    }
    setDetailHeaderCollapsed(false);
    setExpandedMessageIndexes(new Set());
    setDetailLoading(true);
    setDetailError("");
    void aiSessionApi
      .messages(selectedSession.providerId, selectedSession.sourcePath)
      .then((result) => {
        setMessages(result.messages);
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = 0;
        }
      })
      .catch((err) => {
        setMessages([]);
        setDetailError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => {
        setDetailLoading(false);
      });
  }, [selectedSession]);

  React.useEffect(() => {
    const visibleKeys = new Set(filteredSessions.map(sessionKey));
    setCheckedKeys((current) => {
      if (current.size === 0) {
        return current;
      }
      const next = new Set<string>();
      let changed = false;
      current.forEach((key) => {
        if (visibleKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [filteredSessions, sessionKey]);

  const matchedMessageCount = React.useMemo(() => {
    const needle = detailSearch.trim().toLowerCase();
    if (!needle) {
      return 0;
    }
    return messages.filter((message) => message.content.toLowerCase().includes(needle)).length;
  }, [detailSearch, messages]);

  const outlineItems = React.useMemo(() => buildSessionOutlineItems(messages), [messages]);

  const longMessageIndexes = React.useMemo(
    () => messages.flatMap((message, index) => (isLongAISessionMessage(message.content) ? [index] : [])),
    [messages]
  );

  const expandAllMessages = React.useCallback(() => {
    setExpandedMessageIndexes(new Set(longMessageIndexes));
  }, [longMessageIndexes]);

  const collapseAllMessages = React.useCallback(() => {
    setExpandedMessageIndexes(new Set());
  }, []);

  const setMessageExpanded = React.useCallback((index: number, expanded: boolean) => {
    setExpandedMessageIndexes((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(index);
      } else {
        next.delete(index);
      }
      return next;
    });
  }, []);

  React.useLayoutEffect(() => {
    if (!isMobile || view !== "detail") {
      setDetailHeaderHeight(0);
      return;
    }
    const element = detailHeaderRef.current;
    if (!element) {
      return;
    }
    const update = () => {
      setDetailHeaderHeight(element.getBoundingClientRect().height);
    };
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(element);
    return () => observer.disconnect();
  }, [detailSearch, isMobile, outlineItems.length, selectedSession, view]);

  const providerLookup = React.useMemo(() => {
    const lookup = new Map<string, AIProviderStatus>();
    for (const item of providerStatus) {
      lookup.set(item.providerId, item);
    }
    return lookup;
  }, [providerStatus]);

  const selectedDeletableSessions = React.useMemo(
    () => filteredSessions.filter((session) => checkedKeys.has(sessionKey(session))),
    [checkedKeys, filteredSessions, sessionKey]
  );

  const allFilteredSelected =
    filteredSessions.length > 0 && filteredSessions.every((session) => checkedKeys.has(sessionKey(session)));

  const pullReady = pullDistance >= 72;

  const triggerRefresh = React.useCallback(async () => {
    try {
      await load("rescan");
    } catch {
      toast.error(t("plugin.aiSessionManager.loadFailed"));
    }
  }, [load, t]);

  const topBarTitle =
    isMobile && view === "detail" && selectedSession
      ? selectedSession.title || selectedSession.sessionId
      : view === "settings"
        ? t("plugin.aiSessionManager.settings")
        : t("plugin.aiSessionManager.name");

  usePageTopBar(
    {
      show: true,
      leftButtons:
        isMobile && view !== "list"
          ? [
              {
                icon: <ChevronLeft size={18} />,
                title: t("common.backToList"),
                onClick: () => setView("list"),
              },
            ]
          : undefined,
      centerContent: topBarTitle,
      rightButtons: [
        {
          icon: refreshing ? <RefreshCw size={18} className="animate-spin" /> : <RefreshCw size={18} />,
          title: t("common.refresh"),
          onClick: () => {
            void triggerRefresh();
          },
        },
      ],
    },
    [isMobile, topBarTitle, refreshing, view, selectedSession, triggerRefresh, t]
  );

  React.useLayoutEffect(() => {
    if (!isMobile || view !== "list") {
      return;
    }
    const container = listScrollRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = listScrollTopRef.current;
    const sourcePath = listFocusSourcePathRef.current;
    if (!sourcePath) {
      return;
    }
    const selectedButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-ai-session-source-path]")
    ).find((button) => button.dataset.aiSessionSourcePath === sourcePath);
    selectedButton?.focus({ preventScroll: true });
  }, [filteredSessions, isMobile, view]);

  React.useEffect(() => {
    if (view !== "detail" || !selectedSession || longMessageIndexes.length === 0) {
      setPageMenuItems([]);
      return;
    }
    setPageMenuItems([
      {
        id: "ai-session-expand-all-messages",
        icon: <ChevronDown size={20} />,
        label: t("plugin.aiSessionManager.expandAllMessages"),
        onClick: expandAllMessages,
      },
      {
        id: "ai-session-collapse-all-messages",
        icon: <ChevronUp size={20} />,
        label: t("plugin.aiSessionManager.collapseAllMessages"),
        onClick: collapseAllMessages,
      },
    ]);
    return () => setPageMenuItems([]);
  }, [collapseAllMessages, expandAllMessages, longMessageIndexes.length, selectedSession, setPageMenuItems, t, view]);

  React.useEffect(() => {
    if (!isMobile || view !== "list") {
      setPullDistance(0);
      pullStateRef.current = { startY: 0, pulling: false, triggered: false };
      return;
    }
    const container = listScrollRef.current;
    if (!container) {
      return;
    }
    const onTouchStart = (event: TouchEvent) => {
      if (container.scrollTop > 0 || refreshing || selectionMode) {
        pullStateRef.current = { startY: 0, pulling: false, triggered: false };
        return;
      }
      pullStateRef.current = {
        startY: event.touches[0]?.clientY || 0,
        pulling: true,
        triggered: false,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      const state = pullStateRef.current;
      if (!state.pulling || refreshing) {
        return;
      }
      if (container.scrollTop > 0) {
        state.pulling = false;
        setPullDistance(0);
        return;
      }
      const currentY = event.touches[0]?.clientY || 0;
      const delta = currentY - state.startY;
      if (delta <= 0) {
        setPullDistance(0);
        return;
      }
      event.preventDefault();
      setPullDistance(Math.min(delta * 0.45, 96));
    };
    const finishPull = () => {
      const shouldRefresh = pullReady && !refreshing && !pullStateRef.current.triggered;
      pullStateRef.current = { startY: 0, pulling: false, triggered: shouldRefresh };
      setPullDistance(0);
      if (shouldRefresh) {
        void triggerRefresh().finally(() => {
          pullStateRef.current.triggered = false;
        });
      }
    };
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", finishPull, { passive: true });
    container.addEventListener("touchcancel", finishPull, { passive: true });
    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", finishPull);
      container.removeEventListener("touchcancel", finishPull);
    };
  }, [isMobile, view, refreshing, selectionMode, pullReady, triggerRefresh]);

  React.useEffect(() => {
    if (!isMobile || view !== "detail") {
      setDetailHeaderCollapsed(false);
      detailTouchStateRef.current = { startY: 0, armed: false };
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const onTouchStart = (event: TouchEvent) => {
      detailTouchStateRef.current = {
        startY: event.touches[0]?.clientY || 0,
        armed: container.scrollTop <= 0,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!detailHeaderCollapsed) {
        return;
      }
      const state = detailTouchStateRef.current;
      const currentY = event.touches[0]?.clientY || 0;
      const delta = currentY - state.startY;
      if (container.scrollTop <= 0 && state.armed && delta > 24) {
        setDetailHeaderCollapsed(false);
        state.armed = false;
      }
    };
    const onScroll = () => {
      const top = container.scrollTop;
      if (top <= 12) {
        detailTouchStateRef.current.armed = true;
      } else if (top > 72) {
        setDetailHeaderCollapsed(true);
        detailTouchStateRef.current.armed = false;
      }
    };
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("scroll", onScroll);
    };
  }, [detailHeaderCollapsed, isMobile, view, selectedSession]);

  const detailHeaderTransition = {
    type: "spring",
    stiffness: 240,
    damping: 30,
    mass: 0.92,
  } as const;

  const updateProviderConfig = (providerId: AIProviderId, updater: (current: AIProviderConfig) => AIProviderConfig) => {
    setConfigDraft((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [providerId]: updater(current.providers[providerId] || { enabled: true, paths: [] }),
      },
    }));
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const saved = await aiSessionApi.saveConfig(configDraft);
      const next = await aiSessionApi.rescan();
      setConfigDraft(saved);
      setResponse(next);
      setView("list");
      toast.success(t("plugin.aiSessionManager.configSaved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("plugin.aiSessionManager.saveFailed"));
    } finally {
      setSavingConfig(false);
    }
  };

  const copyText = React.useCallback(
    async (text: string, successKey: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(t(successKey));
      } catch {
        toast.error(t("plugin.aiSessionManager.copyFailed"));
      }
    },
    [t]
  );

  const openProjectDir = async () => {
    if (!selectedSession?.projectDir) {
      return;
    }
    try {
      await openFolder(selectedSession.projectDir);
      toast.success(t("plugin.aiSessionManager.projectOpened"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("plugin.aiSessionManager.openProjectFailed"));
    }
  };

  const applyDeleteResult = React.useCallback(
    (items: AIDeleteRequest[]) => {
      const removedKeys = new Set(items.map((item) => `${item.providerId}:${item.sessionId}:${item.sourcePath}`));
      setResponse((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          sessions: current.sessions.filter((session) => !removedKeys.has(sessionKey(session))),
        };
      });
      setCheckedKeys((current) => {
        const next = new Set(current);
        removedKeys.forEach((key) => next.delete(key));
        return next;
      });
      if (selectedSession && removedKeys.has(sessionKey(selectedSession))) {
        const nextVisible = filteredSessions.find((session) => !removedKeys.has(sessionKey(session)));
        setSelectedSourcePath(nextVisible?.sourcePath || "");
      }
    },
    [filteredSessions, selectedSession, sessionKey]
  );

  const deleteSelectedSessions = async () => {
    if (deleteTargets.length === 0) {
      return;
    }
    setDeleting(true);
    const payload = deleteTargets.map((session) => ({
      providerId: session.providerId,
      sessionId: session.sessionId,
      sourcePath: session.sourcePath,
    }));
    try {
      if (payload.length === 1) {
        await aiSessionApi.delete(payload[0]);
        applyDeleteResult(payload);
        toast.success(t("plugin.aiSessionManager.deleteSuccess"));
      } else {
        const result = await aiSessionApi.deleteMany(payload);
        const successItems = result.filter((item) => item.success);
        if (successItems.length > 0) {
          applyDeleteResult(successItems);
          toast.success(formatCount(t("plugin.aiSessionManager.batchDeleteSuccess"), successItems.length));
        }
        const failedItems = result.filter((item) => !item.success);
        if (failedItems.length > 0) {
          toast.error(failedItems[0].error || t("plugin.aiSessionManager.deleteFailed"));
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("plugin.aiSessionManager.deleteFailed"));
    } finally {
      setDeleteTargets([]);
      setDeleting(false);
      if (selectionMode && checkedKeys.size === 0) {
        setSelectionMode(false);
      }
    }
  };

  const requestDelete = async (items: AISessionMeta[]) => {
    if (items.length === 0) {
      return;
    }
    const confirmed = await dialog.confirm(
      items.length === 1
        ? t("plugin.aiSessionManager.deleteConfirm")
        : formatCount(t("plugin.aiSessionManager.batchDeleteConfirm"), items.length),
      undefined,
      { confirmVariant: "danger", confirmText: t("common.delete") }
    );
    if (!confirmed) {
      return;
    }
    setDeleteTargets(items);
  };

  React.useEffect(() => {
    if (deleteTargets.length > 0 && !deleting) {
      void deleteSelectedSessions();
    }
  }, [deleteTargets, deleting]);

  const scrollToMessage = (index: number) => {
    document.getElementById(`ai-session-message-${index}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveMessageIndex(index);
    setOutlineOpen(false);
    window.setTimeout(() => setActiveMessageIndex(null), 1500);
  };

  const toggleCollapsed = (providerId: string) => {
    setCollapsedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const allEnabled = providerOrder.every((id) => (configDraft.providers[id] || { enabled: true }).enabled);

  const renderList = () => (
    <div className="flex h-full min-h-0 flex-col border-r border-ide-border bg-ide-bg">
      <div className="border-b border-ide-border px-3 py-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg border border-ide-border bg-ide-panel px-3 py-2">
            <div className="text-ide-mute">{t("plugin.aiSessionManager.totalSessions")}</div>
            <div className="mt-1 flex items-center justify-between gap-2 text-base font-semibold text-ide-text">
              <span>{filteredSessions.length}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setView((current) => (current === "settings" ? "list" : "settings"))}
                className={cn("size-11 md:size-6", "text-ide-mute hover:text-ide-text")}
                aria-label={
                  view === "settings"
                    ? t("plugin.aiSessionManager.backToSessions")
                    : t("plugin.aiSessionManager.settings")
                }
              >
                {view === "settings" ? <History size={12} /> : <Settings2 size={12} />}
              </Button>
            </div>
          </div>
          <div className="rounded-lg border border-ide-border bg-ide-panel px-3 py-2">
            <div className="text-ide-mute">{t("plugin.aiSessionManager.sourceMode")}</div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs font-medium text-ide-text">
              <div className="flex items-center gap-1.5">
                <Database size={14} className="text-ide-accent" />
                <span>
                  {response?.fromCache ? t("plugin.aiSessionManager.cached") : t("plugin.aiSessionManager.live")}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => void triggerRefresh()}
                disabled={refreshing}
                className={cn("size-11 md:size-6", "text-ide-mute hover:text-ide-text")}
                aria-label={t("common.refresh")}
              >
                {refreshing ? <Spinner className="size-3.5" /> : <RefreshCw size={12} />}
              </Button>
            </div>
          </div>
        </div>
        <div className="relative mt-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ide-mute" />
          <input
            type="search"
            name="ai-session-search"
            aria-label={t("plugin.aiSessionManager.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("plugin.aiSessionManager.searchPlaceholder")}
            className={cn(
              "w-full rounded-md border border-ide-border bg-ide-panel pl-9 pr-3 text-sm text-ide-text placeholder:text-ide-mute outline-none transition-colors focus:border-ide-accent",
              isMobile ? "h-11 text-base" : "h-9"
            )}
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex gap-2 overflow-x-auto pb-0.5 custom-scrollbar">
            <button
              type="button"
              onClick={() => setProviderFilter("all")}
              className={cn(
                "shrink-0 rounded-md border px-2.5 text-xs transition-colors",
                isMobile ? "min-h-11 min-w-11" : "py-1",
                providerFilter === "all"
                  ? "border-ide-accent bg-ide-accent/10 text-ide-accent"
                  : "border-ide-border bg-ide-panel text-ide-mute hover:bg-ide-bg hover:text-ide-text"
              )}
            >
              {t("plugin.aiSessionManager.allProviders")}
            </button>
            {providerOrder.map((providerId) => (
              <button
                key={providerId}
                type="button"
                onClick={() => setProviderFilter(providerId)}
                className={cn(
                  "shrink-0 rounded-md border px-2.5 text-xs transition-colors",
                  isMobile ? "min-h-11 min-w-11" : "py-1",
                  providerFilter === providerId
                    ? "border-ide-accent bg-ide-accent/10 text-ide-accent"
                    : "border-ide-border bg-ide-panel text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                )}
              >
                {providerLabels[providerId]}
              </button>
            ))}
          </div>
          {filteredSessions.length > 0 ? (
            <Button
              variant={selectionMode ? "secondary" : "ghost"}
              size="icon-xs"
              onClick={() => {
                if (selectionMode) {
                  setSelectionMode(false);
                  setCheckedKeys(new Set());
                } else {
                  setSelectionMode(true);
                }
              }}
              className="size-11 md:size-6"
              aria-label={selectionMode ? t("plugin.aiSessionManager.clearSelection") : t("common.select")}
              aria-pressed={selectionMode}
            >
              <ListChecks size={14} />
            </Button>
          ) : null}
        </div>
        {selectionMode ? (
          <div className="mt-3 rounded-md border border-ide-border bg-ide-panel px-3 py-2 text-xs text-ide-mute">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {formatCount(t("plugin.aiSessionManager.selectedCount"), selectedDeletableSessions.length)}
              </Badge>
              <button
                type="button"
                className="inline-flex min-h-11 items-center px-2 text-left text-ide-text hover:text-ide-accent md:min-h-0 md:px-0"
                onClick={() => {
                  setCheckedKeys((current) => {
                    const next = new Set(current);
                    if (allFilteredSelected) {
                      filteredSessions.forEach((session) => next.delete(sessionKey(session)));
                    } else {
                      filteredSessions.forEach((session) => next.add(sessionKey(session)));
                    }
                    return next;
                  });
                }}
              >
                {allFilteredSelected
                  ? t("plugin.aiSessionManager.clearFilteredSelection")
                  : t("plugin.aiSessionManager.selectAllFiltered")}
              </button>
              <button
                type="button"
                className="inline-flex min-h-11 items-center px-2 text-left text-ide-text hover:text-ide-accent md:min-h-0 md:px-0"
                onClick={() => setCheckedKeys(new Set())}
              >
                {t("plugin.aiSessionManager.clearSelection")}
              </button>
              <button
                type="button"
                className="inline-flex min-h-11 items-center px-2 text-left text-red-400 hover:text-red-300 disabled:opacity-50 md:min-h-0 md:px-0"
                disabled={selectedDeletableSessions.length === 0}
                onClick={() => void requestDelete(selectedDeletableSessions)}
              >
                {t("plugin.aiSessionManager.deleteSelected")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div
        ref={listScrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          listScrollTopRef.current = event.currentTarget.scrollTop;
        }}
      >
        {isMobile ? (
          <div
            className="overflow-hidden transition-[max-height,opacity,padding] duration-200"
            style={{
              maxHeight: pullDistance > 0 || refreshing ? 44 : 0,
              opacity: pullDistance > 0 || refreshing ? 1 : 0,
              paddingTop: pullDistance > 0 || refreshing ? 8 : 0,
            }}
          >
            <div className="flex items-center justify-center gap-2 text-xs text-ide-mute">
              {refreshing ? (
                <Spinner className="size-3.5" />
              ) : (
                <RefreshCw size={12} className={cn(pullReady ? "text-ide-text" : "")} />
              )}
              <span>
                {refreshing
                  ? t("common.refresh")
                  : pullReady
                    ? t("plugin.aiSessionManager.releaseToRefresh")
                    : t("plugin.aiSessionManager.pullToRefresh")}
              </span>
            </div>
          </div>
        ) : null}
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-ide-mute">{t("common.loading")}</div>
        ) : error ? (
          <div className="m-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
        ) : filteredSessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-ide-mute">
            <History size={28} className="mb-3 opacity-60" />
            <div className="text-sm">{t("plugin.aiSessionManager.empty")}</div>
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {filteredSessions.map((session) => (
              <SessionListItem
                key={sessionKey(session)}
                active={session.sourcePath === selectedSourcePath && (!isMobile || view === "detail")}
                canDelete={Boolean(session.sourcePath)}
                isChecked={checkedKeys.has(sessionKey(session))}
                locale={locale}
                query={query}
                selectionMode={selectionMode}
                session={session}
                t={t}
                onSelect={(item) => {
                  listScrollTopRef.current = listScrollRef.current?.scrollTop || 0;
                  listFocusSourcePathRef.current = item.sourcePath;
                  setSelectedSourcePath(item.sourcePath);
                  setView("detail");
                }}
                onToggleChecked={(checked) => {
                  const key = sessionKey(session);
                  setCheckedKeys((current) => {
                    const next = new Set(current);
                    if (checked) {
                      next.add(key);
                    } else {
                      next.delete(key);
                    }
                    return next;
                  });
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderSettings = () => (
    <div className="flex h-full min-h-0 flex-col bg-ide-bg">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-ide-mute">
            {t("plugin.aiSessionManager.generalSettings")}
          </div>
          <div className="rounded-lg border border-ide-border bg-ide-panel">
            {[
              [
                "autoRescanOnOpen",
                "plugin.aiSessionManager.autoRescanOnOpen",
                "plugin.aiSessionManager.autoRescanOnOpenDesc",
              ],
              ["cacheEnabled", "plugin.aiSessionManager.cacheEnabled", "plugin.aiSessionManager.cacheEnabledDesc"],
              [
                "showParseErrors",
                "plugin.aiSessionManager.showParseErrors",
                "plugin.aiSessionManager.showParseErrorsDesc",
              ],
            ].map(([key, label, desc], index, arr) => {
              const checked = configDraft[key as keyof AISessionConfig] as boolean;
              return (
                <div
                  key={key}
                  className={cn(
                    "flex items-center justify-between gap-4 px-4 py-3",
                    index < arr.length - 1 ? "border-b border-ide-border" : ""
                  )}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ide-text">{t(label)}</div>
                    <div className="mt-0.5 text-xs leading-5 text-ide-mute">{t(desc)}</div>
                  </div>
                  <button
                    type="button"
                    aria-pressed={checked}
                    onClick={() =>
                      setConfigDraft((current) => ({
                        ...current,
                        [key]: !checked,
                      }))
                    }
                    className={cn(
                      "relative inline-flex shrink-0 rounded-full border transition-colors duration-200 focus:outline-none focus:border-ide-accent",
                      isMobile ? "h-11 w-14" : "h-7 w-12",
                      checked
                        ? "border-ide-accent bg-ide-accent/12"
                        : "border-ide-border bg-ide-panel hover:border-ide-mute/40"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border shadow-sm transition-all duration-200",
                        checked
                          ? `${isMobile ? "translate-x-7" : "translate-x-5"} border-ide-accent bg-ide-accent`
                          : "translate-x-0 border-ide-border bg-white"
                      )}
                    />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-ide-mute">
              {t("plugin.aiSessionManager.providerSettings")}
            </div>
            <button
              type="button"
              onClick={() => {
                const nextEnabled = !allEnabled;
                setConfigDraft((current) => {
                  const next = { ...current, providers: { ...current.providers } };
                  for (const id of providerOrder) {
                    next.providers[id] = {
                      ...(next.providers[id] || { enabled: true, paths: [] }),
                      enabled: nextEnabled,
                    };
                  }
                  return next;
                });
              }}
              className={cn(
                "rounded-md border border-ide-border bg-ide-panel px-2.5 text-[11px] text-ide-mute transition-colors hover:bg-ide-bg hover:text-ide-text",
                isMobile ? "min-h-11" : "py-1"
              )}
            >
              {allEnabled ? t("plugin.aiSessionManager.disableAll") : t("plugin.aiSessionManager.enableAll")}
            </button>
          </div>

          <div className="space-y-3">
            {providerOrder.map((providerId) => {
              const providerConfig = configDraft.providers[providerId] || { enabled: true, paths: [] };
              const status = providerLookup.get(providerId);
              const collapsed = collapsedProviders.has(providerId);
              const hasErrors = (status?.errorCount || 0) > 0;
              return (
                <div key={providerId} className="rounded-lg border border-ide-border bg-ide-panel">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(providerId)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-4 text-left",
                      isMobile ? "min-h-14 py-2" : "py-3"
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm font-semibold text-ide-text">{providerLabels[providerId]}</div>
                      <span
                        className={cn(
                          "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]",
                          providerConfig.enabled
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                            : "border-ide-border bg-ide-bg text-ide-mute"
                        )}
                      >
                        {providerConfig.enabled
                          ? t("plugin.aiSessionManager.enabled")
                          : t("plugin.aiSessionManager.disabled")}
                      </span>
                      {hasErrors ? (
                        <span className="shrink-0 rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-400">
                          {formatCount(t("plugin.aiSessionManager.errorCount"), status?.errorCount || 0)}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ide-mute">
                        {formatCount(t("plugin.aiSessionManager.sessionCount"), status?.sessionCount || 0)}
                      </span>
                      <ChevronDown
                        size={16}
                        className={cn("text-ide-mute transition-transform duration-200", collapsed ? "-rotate-90" : "")}
                      />
                    </div>
                  </button>
                  {!collapsed ? (
                    <>
                      <div className="border-t border-ide-border px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ide-mute">
                            <span
                              className={cn("inline-flex items-center gap-1", !status?.available ? "text-red-400" : "")}
                            >
                              {!status?.available ? <AlertTriangle size={12} /> : null}
                              {status?.available
                                ? t("plugin.aiSessionManager.pathAvailable")
                                : t("plugin.aiSessionManager.pathUnavailable")}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateProviderConfig(providerId, (current) => ({
                                ...current,
                                enabled: !current.enabled,
                              }));
                            }}
                            className={cn(
                              "shrink-0 rounded-md border px-3 text-xs transition-colors",
                              isMobile ? "min-h-11" : "h-8",
                              providerConfig.enabled
                                ? "border-ide-accent/50 bg-ide-accent/10 text-ide-accent"
                                : "border-ide-border bg-ide-bg text-ide-mute hover:text-ide-text"
                            )}
                          >
                            {providerConfig.enabled
                              ? t("plugin.aiSessionManager.disableProvider")
                              : t("plugin.aiSessionManager.enableProvider")}
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2 border-t border-ide-border px-4 py-3">
                        {(providerConfig.paths.length > 0 ? providerConfig.paths : [""]).map((path, index) => (
                          <div key={`${providerId}-${index}`} className="flex gap-2">
                            <input
                              id={`ai-provider-path-${providerId}-${index}`}
                              name={`ai-provider-path-${providerId}-${index}`}
                              aria-label={`${providerLabels[providerId]} ${t("plugin.aiSessionManager.pathPlaceholder")} ${index + 1}`}
                              value={path}
                              onChange={(event) =>
                                updateProviderConfig(providerId, (current) => ({
                                  ...current,
                                  paths:
                                    current.paths.length === 0
                                      ? [event.target.value]
                                      : current.paths.map((item, itemIndex) =>
                                          itemIndex === index ? event.target.value : item
                                        ),
                                }))
                              }
                              placeholder={status?.paths?.[0] || t("plugin.aiSessionManager.pathPlaceholder")}
                              className={cn(
                                "min-w-0 flex-1 rounded-md border border-ide-border bg-ide-bg px-3 text-sm text-ide-text placeholder:text-ide-mute outline-none transition-colors focus:border-ide-accent",
                                isMobile ? "h-11 text-base" : "h-9"
                              )}
                            />
                            {providerConfig.paths.length > 0 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  updateProviderConfig(providerId, (current) => ({
                                    ...current,
                                    paths: current.paths.filter((_, itemIndex) => itemIndex !== index),
                                  }))
                                }
                                className={cn(
                                  "shrink-0 rounded-md border border-red-500/30 bg-red-500/10 px-3 text-xs text-red-400",
                                  isMobile ? "min-h-11" : "h-9"
                                )}
                              >
                                {t("common.delete")}
                              </button>
                            ) : null}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            updateProviderConfig(providerId, (current) => ({
                              ...current,
                              paths: [...current.paths, ""],
                            }))
                          }
                          className={cn(
                            "rounded-md border border-ide-border bg-ide-bg px-3 text-xs text-ide-text transition-colors hover:bg-ide-panel",
                            isMobile ? "min-h-11" : "h-8"
                          )}
                        >
                          {t("plugin.aiSessionManager.addPath")}
                        </button>
                        <div className="mt-1 flex items-center gap-2 rounded-md border border-ide-border bg-ide-bg px-3 py-2 text-xs">
                          <FolderSearch size={14} className="shrink-0 text-ide-accent" />
                          <span className="text-ide-mute">{t("plugin.aiSessionManager.currentResolvedPath")}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-ide-text">
                            {status?.paths?.[0] || "-"}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="border-t border-ide-border bg-ide-bg/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setConfigDraft(config);
              setView("list");
            }}
            className={cn(
              "rounded-md border border-ide-border bg-ide-panel px-4 text-sm text-ide-text transition-colors hover:bg-ide-bg",
              isMobile ? "min-h-11" : "h-9"
            )}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void saveConfig()}
            disabled={savingConfig}
            className={cn(
              "rounded-md border border-ide-accent bg-ide-accent px-4 text-sm font-medium text-ide-bg transition-colors hover:bg-ide-accent/90 disabled:opacity-60",
              isMobile ? "min-h-11" : "h-9"
            )}
          >
            {savingConfig ? t("common.loading") : t("plugin.aiSessionManager.saveConfig")}
          </button>
        </div>
      </div>
    </div>
  );

  const renderDetail = () => {
    if (!selectedSession) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-ide-mute">
          <History size={30} className="mb-3 opacity-60" />
          <div className="text-sm">{t("plugin.aiSessionManager.selectSession")}</div>
        </div>
      );
    }

    const detailHeaderBody = (
      <>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className={cn("font-semibold text-ide-text", isMobile ? "text-base leading-7" : "text-lg")}>
              {selectedSession.title || selectedSession.sessionId}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ide-mute">
              <span className="rounded-md border border-ide-border bg-ide-panel px-2 py-0.5">
                {providerLabels[selectedSession.providerId as AIProviderId] || selectedSession.providerId}
              </span>
              {selectedSession.projectDir ? (
                <span className="max-w-full truncate rounded-md border border-ide-border bg-ide-panel px-2 py-0.5">
                  {selectedSession.projectDir}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <Clock3 size={12} />
                {formatDateTime(selectedSession.lastActiveAt || selectedSession.createdAt, locale)}
              </span>
            </div>
          </div>
        </div>
        <div className={cn("mt-4 gap-2", isMobile ? "grid grid-cols-2" : "flex flex-wrap items-center")}>
          {isMobile && outlineItems.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOutlineOpen(true)}
              className={cn(
                "min-w-0 justify-start gap-1.5 rounded-lg border-ide-border bg-ide-panel px-3 text-xs text-ide-text shadow-none hover:bg-ide-bg",
                isMobile ? "min-h-11" : "h-9"
              )}
            >
              <ListTree size={13} />
              <span className="truncate">{t("plugin.aiSessionManager.outline")}</span>
            </Button>
          ) : null}
          {selectedSession.resumeCommand ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyText(selectedSession.resumeCommand || "", "plugin.aiSessionManager.resumeCopied")}
              className={cn(
                "min-w-0 justify-start gap-1.5 rounded-lg border-ide-border bg-ide-panel px-3 text-xs text-ide-text shadow-none hover:bg-ide-bg",
                isMobile ? "min-h-11" : "h-9"
              )}
            >
              <Copy size={13} />
              <span className="truncate">{t("plugin.aiSessionManager.copyResumeCommand")}</span>
            </Button>
          ) : null}
          {selectedSession.projectDir ? (
            <Button
              variant="outline"
              size="sm"
              onClick={openProjectDir}
              className={cn(
                "min-w-0 justify-start gap-1.5 rounded-lg border-ide-border bg-ide-panel px-3 text-xs text-ide-text shadow-none hover:bg-ide-bg",
                isMobile ? "min-h-11" : "h-9"
              )}
            >
              <FolderOpen size={13} />
              <span className="truncate">{t("plugin.aiSessionManager.openProject")}</span>
            </Button>
          ) : null}
          {selectedSession.projectDir ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyText(selectedSession.projectDir || "", "plugin.aiSessionManager.projectCopied")}
              className={cn(
                "min-w-0 justify-start gap-1.5 rounded-lg border-ide-border bg-ide-panel px-3 text-xs text-ide-text shadow-none hover:bg-ide-bg",
                isMobile ? "min-h-11" : "h-9"
              )}
            >
              <Copy size={13} />
              <span className="truncate">{t("plugin.aiSessionManager.copyProjectPath")}</span>
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void requestDelete([selectedSession])}
            className={cn(
              "min-w-0 justify-start gap-1.5 rounded-lg border-red-500/30 bg-red-500/10 px-3 text-xs text-red-400 shadow-none hover:bg-red-500/15 hover:text-red-300",
              isMobile ? "min-h-11" : "h-9",
              isMobile ? "col-span-2" : ""
            )}
          >
            <Trash2 size={13} />
            <span className="truncate">{t("plugin.aiSessionManager.deleteCurrent")}</span>
          </Button>
        </div>
        {selectedSession.parseError ? (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {selectedSession.parseError}
          </div>
        ) : null}
        <div className="relative mt-4">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ide-mute" />
          <input
            type="search"
            name="ai-session-detail-search"
            aria-label={t("plugin.aiSessionManager.searchInSession")}
            value={detailSearch}
            onChange={(event) => setDetailSearch(event.target.value)}
            placeholder={t("plugin.aiSessionManager.searchInSession")}
            className={cn(
              "w-full rounded-md border border-ide-border bg-ide-panel pl-9 pr-3 text-sm text-ide-text placeholder:text-ide-mute outline-none transition-colors focus:border-ide-accent",
              isMobile ? "h-11 text-base" : "h-9"
            )}
          />
        </div>
        {detailSearch.trim() ? (
          <div className="mt-2 text-xs text-ide-mute">
            {formatCount(t("plugin.aiSessionManager.matchedMessages"), matchedMessageCount)}
          </div>
        ) : null}
      </>
    );

    return (
      <div className="relative flex h-full min-h-0 flex-col bg-ide-bg">
        {isMobile ? (
          <>
            <AnimatePresence>
              {detailHeaderCollapsed ? (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex justify-center"
                >
                  <button
                    type="button"
                    onClick={() => setDetailHeaderCollapsed(false)}
                    className="pointer-events-auto inline-flex min-h-11 min-w-14 items-center justify-center rounded-b-lg border-x border-b border-ide-border bg-ide-panel/92 px-2.5 text-ide-mute shadow-[0_4px_10px_rgba(0,0,0,0.08)] backdrop-blur transition-colors hover:bg-ide-bg hover:text-ide-text"
                    aria-label={t("plugin.aiSessionManager.expandHeader")}
                    title={t("plugin.aiSessionManager.expandHeader")}
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
                      <path
                        d="M1 1L5 5L9 1"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <motion.div
              ref={detailHeaderRef}
              initial={false}
              animate={{
                y: detailHeaderCollapsed ? -(detailHeaderHeight + 12) : 0,
                opacity: detailHeaderCollapsed ? 0 : 1,
              }}
              transition={detailHeaderTransition}
              style={{ pointerEvents: detailHeaderCollapsed ? "none" : "auto" }}
              className="absolute left-0 right-0 top-0 z-10 border-b border-ide-border bg-ide-bg px-3 py-3"
            >
              {detailHeaderBody}
            </motion.div>
          </>
        ) : (
          <div ref={detailHeaderRef} className="border-b border-ide-border px-4 py-4">
            {detailHeaderBody}
          </div>
        )}
        <div
          className={cn(
            "grid min-h-0 flex-1 overflow-hidden",
            outlineItems.length > 0 ? "xl:grid-cols-[minmax(0,1fr)_240px]" : ""
          )}
        >
          <div className={cn("min-h-0 flex-1 min-w-0", !isMobile && outlineItems.length > 0 ? "min-w-0" : "")}>
            <motion.div
              ref={scrollContainerRef}
              initial={false}
              animate={{
                paddingTop: isMobile ? (detailHeaderCollapsed ? 28 : Math.max(detailHeaderHeight + 12, 12)) : 16,
              }}
              transition={detailHeaderTransition}
              className={cn(
                "ai-session-scrollbar min-h-0 h-full max-w-full overflow-y-auto",
                isMobile ? "px-3 pb-3" : "px-4 py-4"
              )}
            >
              {detailLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-ide-mute">
                  {t("common.loading")}
                </div>
              ) : detailError ? (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
                  {detailError}
                </div>
              ) : messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-ide-mute">
                  {t("plugin.aiSessionManager.emptyMessages")}
                </div>
              ) : (
                <div className="max-w-full space-y-3">
                  {messages.map((message, index) => (
                    <div key={`${message.role}-${index}`} id={`ai-session-message-${index}`} className="max-w-full">
                      <SessionMessageItem
                        active={activeMessageIndex === index}
                        expanded={expandedMessageIndexes.has(index)}
                        locale={locale}
                        message={message}
                        query={detailSearch}
                        t={t}
                        onCopy={(content) => void copyText(content, "plugin.aiSessionManager.messageCopied")}
                        onExpandedChange={(expanded) => setMessageExpanded(index, expanded)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </div>
          {!isMobile && outlineItems.length > 0 ? (
            <SessionOutline compact={false} items={outlineItems} t={t} onSelect={scrollToMessage} />
          ) : null}
        </div>
        <Sheet open={outlineOpen} onOpenChange={setOutlineOpen}>
          <SheetContent
            side="bottom"
            className="flex max-h-[75dvh] min-h-0 flex-col rounded-t-2xl border-ide-border bg-ide-bg p-0"
          >
            <SheetHeader className="border-b border-ide-border">
              <SheetTitle>{t("plugin.aiSessionManager.outline")}</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <SessionOutline compact items={outlineItems} t={t} onSelect={scrollToMessage} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  };

  const deletingDialog = (
    <AlertDialog open={deleting} onOpenChange={() => {}}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("plugin.aiSessionManager.deleting")}</AlertDialogTitle>
          <AlertDialogDescription>{t("common.loading")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled>{t("common.loading")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (isMobile) {
    return (
      <>
        {view === "settings" ? renderSettings() : view === "detail" ? renderDetail() : renderList()}
        {deletingDialog}
      </>
    );
  }

  return (
    <>
      <div className="grid h-full min-h-0 grid-cols-[minmax(300px,360px)_1fr] bg-ide-bg">
        {renderList()}
        {view === "settings" ? renderSettings() : renderDetail()}
      </div>
      {deletingDialog}
    </>
  );
};

export default AISessionManagerPage;
