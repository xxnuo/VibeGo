import { Layers, Loader2, Search, Terminal } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionApi } from "@/api/session";
import { terminalApi } from "@/api/terminal";
import { isBlockTermMacPlatform, resolveBlockTermAppShortcut } from "@/components/terminal/blockterm-app-keybindings";
import { hasOpenBlockTermDesktopShortcutModal } from "@/components/terminal/blockterm-desktop-keybindings";
import { BLOCKTERM_KEYMAP_SETTING_KEY, parseBlockTermKeymapConfig } from "@/components/terminal/blockterm-keymap";
import {
  isBlockTermWorkspaceAbortError,
  loadBlockTermWorkspaceSearchTargets,
} from "@/components/terminal/blockterm-workspace-loader";
import {
  BlockTermWorkspaceNavigationCoordinator,
  type BlockTermWorkspaceNavigationDependencies,
  type BlockTermWorkspaceNavigationResult,
} from "@/components/terminal/blockterm-workspace-navigation";
import {
  type BlockTermWorkspaceSearchTarget,
  buildBlockTermWorkspaceSearchTargets,
  createLocalBlockTermWorkspaceInventory,
  filterBlockTermWorkspaceSearchTargets,
} from "@/components/terminal/blockterm-workspace-search";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import { useAppStore } from "@/stores/app-store";
import { useFrameStore } from "@/stores/frame-store";
import { useSessionStore } from "@/stores/session-store";
import { useTerminalStore } from "@/stores/terminal-store";

const BlockTermWorkspaceNavigator: React.FC = () => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const keymapValue = useSettingsStore((state) => state.settings[BLOCKTERM_KEYMAP_SETTING_KEY] || "");
  const keymap = useMemo(() => parseBlockTermKeymapConfig(keymapValue).keymap, [keymapValue]);
  const sessions = useSessionStore((state) => state.sessions);
  const currentWorkspaceId = useSessionStore((state) => state.currentSessionId);
  const switchSession = useSessionStore((state) => state.switchSession);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<BlockTermWorkspaceSearchTarget[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [failedWorkspaceCount, setFailedWorkspaceCount] = useState(0);
  const [activationError, setActivationError] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const activatingIdRef = useRef<string | null>(null);
  const activationOriginWorkspaceRef = useRef<string | null>(null);
  const navigationRef = useRef(new BlockTermWorkspaceNavigationCoordinator());
  const resultRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const sessionsRef = useRef(sessions);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const filteredTargets = useMemo(() => filterBlockTermWorkspaceSearchTargets(targets, query), [query, targets]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, targets]);

  useEffect(() => {
    const selected = filteredTargets[selectedIndex];
    if (!selected) return;
    resultRefs.current.get(selected.id)?.scrollIntoView({ block: "nearest" });
  }, [filteredTargets, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setQuery("");
    setLoading(true);
    setLoadError(false);
    setFailedWorkspaceCount(0);
    setActivationError(false);
    const knownSessions = sessionsRef.current;
    const workspaceIdAtOpen = useSessionStore.getState().currentSessionId;
    const currentSession = workspaceIdAtOpen
      ? knownSessions.find((session) => session.id === workspaceIdAtOpen) || {
          id: workspaceIdAtOpen,
          user_id: "",
          name: "Workspace",
          position: 0,
          created_at: 0,
          updated_at: 0,
        }
      : null;
    const currentInventory = currentSession
      ? createLocalBlockTermWorkspaceInventory(
          currentSession,
          Math.max(
            0,
            knownSessions.findIndex((session) => session.id === currentSession.id)
          ),
          useFrameStore.getState().groups,
          useTerminalStore.getState().terminalsByGroup
        )
      : null;
    setTargets(currentInventory ? buildBlockTermWorkspaceSearchTargets([currentInventory], workspaceIdAtOpen) : []);
    void loadBlockTermWorkspaceSearchTargets(
      { currentWorkspaceId: workspaceIdAtOpen, currentInventory },
      controller.signal,
      {
        listSessions: (page, pageSize, signal) => sessionApi.list(page, pageSize, { signal }),
        getSession: (id, signal) => sessionApi.get(id, { signal, touch: false }),
        listTerminals: (workspaceId, signal) => terminalApi.list({ workspace_session_id: workspaceId }, { signal }),
      }
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setTargets(result.targets);
        setFailedWorkspaceCount(result.failedWorkspaceCount);
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isBlockTermWorkspaceAbortError(error)) setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open]);

  const getNavigationDependencies = useCallback(
    (): BlockTermWorkspaceNavigationDependencies => ({
      switchSession,
      getSessionState: () => useSessionStore.getState(),
      getFrameState: () => useFrameStore.getState(),
      getTerminalState: () => useTerminalStore.getState(),
      setActiveTerminal: (groupId, terminalId) => useTerminalStore.getState().setActiveId(groupId, terminalId),
      setActiveGroup: (groupId) => useFrameStore.getState().setActiveGroup(groupId),
    }),
    [switchSession]
  );

  const activateWorkspace = useCallback(
    async (workspaceId: string) => {
      const result = await navigationRef.current.activateWorkspace(workspaceId, getNavigationDependencies());
      if (navigationRef.current.isCurrent(result.requestId)) {
        activatingIdRef.current = null;
        activationOriginWorkspaceRef.current = null;
        setActivatingId(null);
      }
    },
    [getNavigationDependencies]
  );

  const activateTarget = useCallback(
    async (target: BlockTermWorkspaceSearchTarget) => {
      if (activatingIdRef.current === target.id) return;
      activatingIdRef.current = target.id;
      activationOriginWorkspaceRef.current = useSessionStore.getState().currentSessionId;
      setActivatingId(target.id);
      setActivationError(false);
      let result: BlockTermWorkspaceNavigationResult;
      try {
        result = await navigationRef.current.activateTarget(target, getNavigationDependencies());
      } catch {
        if (activatingIdRef.current === target.id) {
          activatingIdRef.current = null;
          activationOriginWorkspaceRef.current = null;
          setActivatingId(null);
          setActivationError(true);
        }
        return;
      }
      if (navigationRef.current.isCurrent(result.requestId)) {
        activatingIdRef.current = null;
        activationOriginWorkspaceRef.current = null;
        setActivatingId(null);
        if (result.status === "activated") {
          setOpen(false);
        } else if (result.status !== "superseded") {
          setActivationError(true);
        }
      }
    },
    [getNavigationDependencies]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const shortcut = resolveBlockTermAppShortcut(event, keymap, { macPlatform: isBlockTermMacPlatform() });
      if (!shortcut) return;
      if (hasOpenBlockTermDesktopShortcutModal(document)) {
        if (open && shortcut.type === "open-tab-search") {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (shortcut.type === "open-tab-search") {
        setOpen(true);
        return;
      }
      const targetWorkspace = useSessionStore.getState().sessions[shortcut.index];
      if (targetWorkspace) void activateWorkspace(targetWorkspace.id);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activateWorkspace, keymap, open]);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        const rollbackWorkspaceId = activatingIdRef.current ? activationOriginWorkspaceRef.current : null;
        navigationRef.current.invalidate();
        activatingIdRef.current = null;
        activationOriginWorkspaceRef.current = null;
        setActivatingId(null);
        setActivationError(false);
        if (rollbackWorkspaceId) void switchSession(rollbackWorkspaceId);
      }
    },
    [switchSession]
  );

  useEffect(() => () => navigationRef.current.invalidate(), []);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (filteredTargets.length === 0) return;
        setSelectedIndex((current) => Math.min(filteredTargets.length - 1, current + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (filteredTargets.length === 0) return;
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.repeat) return;
        const target = filteredTargets[selectedIndex];
        if (target) void activateTarget(target);
      }
    },
    [activateTarget, filteredTargets, selectedIndex]
  );

  const activeOptionId = filteredTargets[selectedIndex]
    ? `blockterm-workspace-search-option-${selectedIndex}`
    : undefined;

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        data-blockterm-workspace-search
        className="grid max-h-[min(82dvh,30rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-t-md border-ide-border bg-ide-panel p-0 text-ide-text md:w-[28.25rem] md:rounded-md"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("plugin.blockTerm.workspaceSearch.title")}</DialogTitle>
          <DialogDescription>{t("plugin.blockTerm.workspaceSearch.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex h-12 items-center gap-2 border-b border-ide-border px-3 pr-12">
          <Search size={16} className="shrink-0 text-ide-mute" />
          <input
            autoFocus
            type="text"
            role="combobox"
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, 400))}
            onKeyDown={handleInputKeyDown}
            placeholder={t("plugin.blockTerm.workspaceSearch.placeholder")}
            aria-label={t("plugin.blockTerm.workspaceSearch.placeholder")}
            aria-controls="blockterm-workspace-search-results"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-activedescendant={activeOptionId}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-ide-text outline-none placeholder:text-ide-mute"
          />
          {loading && <Loader2 size={14} className="shrink-0 animate-spin text-ide-mute" aria-hidden="true" />}
        </div>

        <div
          id="blockterm-workspace-search-results"
          role="listbox"
          aria-label={t("plugin.blockTerm.workspaceSearch.results")}
          aria-busy={loading}
          className="min-h-[18rem] overflow-y-auto overscroll-contain custom-scrollbar"
        >
          {loading && filteredTargets.length === 0 ? (
            <div className="flex h-full min-h-[18rem] items-center justify-center text-ide-mute">
              <Loader2 size={18} className="animate-spin" aria-label={t("common.loading")} />
            </div>
          ) : loadError && filteredTargets.length === 0 ? (
            <div className="flex min-h-[18rem] items-center justify-center px-6 text-center text-sm text-red-500">
              {t("plugin.blockTerm.workspaceSearch.loadFailed")}
            </div>
          ) : filteredTargets.length === 0 ? (
            <div className="flex min-h-[18rem] items-center justify-center px-6 text-center text-sm text-ide-mute">
              {t("plugin.blockTerm.workspaceSearch.empty")}
            </div>
          ) : (
            <div className="divide-y divide-ide-border">
              {filteredTargets.map((target, index) => {
                const selected = index === selectedIndex;
                const current = target.workspaceId === currentWorkspaceId;
                const activating = activatingId === target.id;
                return (
                  <button
                    key={target.id}
                    id={`blockterm-workspace-search-option-${index}`}
                    ref={(element) => {
                      if (element) resultRefs.current.set(target.id, element);
                      else resultRefs.current.delete(target.id);
                    }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-label={`${target.workspaceName} / ${target.tabName}`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={() => void activateTarget(target)}
                    className={`flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                      selected ? "bg-ide-accent/10" : "hover:bg-ide-bg"
                    }`}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center border border-ide-border bg-ide-bg text-ide-mute">
                      {activating ? <Loader2 size={15} className="animate-spin" /> : <Terminal size={15} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ide-text">{target.tabName}</span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ide-mute">
                        <Layers size={11} className="shrink-0" />
                        <span className="truncate">#{target.workspaceName}</span>
                        {current && (
                          <span className="shrink-0 text-ide-accent">
                            {t("plugin.blockTerm.workspaceSearch.currentWorkspace")}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {(activationError || loadError || failedWorkspaceCount > 0) && (
          <div
            role="status"
            className={`border-t px-3 py-2 text-xs ${
              activationError || loadError
                ? "border-red-500/40 bg-red-500/8 text-red-500"
                : "border-amber-500/40 bg-amber-500/8 text-amber-600 dark:text-amber-400"
            }`}
          >
            {activationError
              ? t("plugin.blockTerm.workspaceSearch.targetUnavailable")
              : loadError
                ? t("plugin.blockTerm.workspaceSearch.loadFailed")
                : t("plugin.blockTerm.workspaceSearch.partialFailure").replace("{count}", String(failedWorkspaceCount))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default BlockTermWorkspaceNavigator;
