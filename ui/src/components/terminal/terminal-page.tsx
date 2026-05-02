import { useQueryClient } from "@tanstack/react-query";
import { Columns, Edit2, Plus, Rows, Terminal, X, XCircle } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { terminalApi } from "@/api/terminal";
import { useDialog } from "@/components/common";
import type { KeyEvent } from "@/components/keyboard";
import { translateKeyEvent } from "@/components/keyboard";
import TerminalHistoryPage from "@/components/terminal/terminal-history-page";
import type { TerminalInstanceHandle, TerminalInstanceStateUpdate } from "@/components/terminal/terminal-instance";
import TerminalInstance from "@/components/terminal/terminal-instance";
import TerminalListManager from "@/components/terminal/terminal-list-manager";
import TerminalSplitView from "@/components/terminal/terminal-split-view";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { terminalKeys, useTerminalCreate, useTerminalRename } from "@/hooks/use-terminal";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";
import { useFrameStore } from "@/stores/frame-store";
import { useKeyboardStore } from "@/stores/keyboard-store";
import { syncTerminalWorkspaceState, useSessionStore } from "@/stores/session-store";
import { type LayoutNode, type SplitDirection, type TerminalSession, useTerminalStore } from "@/stores/terminal-store";

interface TerminalPageProps {
  groupId: string;
  cwd?: string;
}

const EMPTY_TERMINALS: TerminalSession[] = [];

function getCompactTerminalLocation(value?: string): string {
  if (!value) return "";
  const normalized = value.replace(/[\\/]+$/, "");
  if (!normalized) return value;
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function collectLayoutTerminalIds(layout: LayoutNode | null): string[] {
  if (!layout) {
    return [];
  }
  if (layout.type === "terminal") {
    return [layout.terminalId];
  }
  return [...collectLayoutTerminalIds(layout.first), ...collectLayoutTerminalIds(layout.second)];
}

const TerminalPage: React.FC<TerminalPageProps> = ({ groupId, cwd }) => {
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const terminals = useTerminalStore((s) => s.terminalsByGroup[groupId] || EMPTY_TERMINALS);
  const terminalsByGroup = useTerminalStore((s) => s.terminalsByGroup);
  const activeIdByGroup = useTerminalStore((s) => s.activeIdByGroup);
  const listManagerOpenByGroup = useTerminalStore((s) => s.listManagerOpenByGroup);
  const terminalLayouts = useTerminalStore((s) => s.terminalLayouts);
  const focusedIdByGroup = useTerminalStore((s) => s.focusedIdByGroup);
  const activeTerminalId = useTerminalStore((s) => s.activeIdByGroup[groupId] ?? null);
  const listManagerOpen = useTerminalStore((s) => s.listManagerOpenByGroup[groupId] ?? true);
  const focusedId = useTerminalStore((s) => s.focusedIdByGroup[groupId] ?? null);
  const [showHistory, setShowHistory] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalRefsMap = useRef<Map<string, TerminalInstanceHandle>>(new Map());

  const setPageMenuItems = useFrameStore((s) => s.setPageMenuItems);
  const setActiveId = useTerminalStore((s) => s.setActiveId);
  const setListManagerOpen = useTerminalStore((s) => s.setListManagerOpen);
  const setTerminalStatus = useTerminalStore((s) => s.setTerminalStatus);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const removeTerminalPage = useTerminalStore((s) => s.removeTerminalPage);
  const setFocusedId = useTerminalStore((s) => s.setFocusedId);
  const getTerminalPageIds = useTerminalStore((s) => s.getTerminalPageIds);
  const splitTerminalInStore = useTerminalStore((s) => s.splitTerminal);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const updateSplitRatio = useTerminalStore((s) => s.updateSplitRatio);

  const createTerminalMutation = useTerminalCreate(groupId);
  const renameTerminalMutation = useTerminalRename(groupId);

  const rootTerminals = useMemo(() => terminals.filter((t) => !t.parentId), [terminals]);
  const displayTerminals = useMemo(() => [...rootTerminals].reverse(), [rootTerminals]);
  const terminalStatusMap = useMemo(
    () => new Map(terminals.map((terminal) => [terminal.id, terminal.status])),
    [terminals]
  );
  const activeLayout = useMemo(() => {
    if (!activeTerminalId) {
      return null;
    }
    return terminalLayouts[activeTerminalId] ?? null;
  }, [activeTerminalId, terminalLayouts]);
  const activeLayoutTerminalIds = useMemo(() => collectLayoutTerminalIds(activeLayout), [activeLayout]);
  const hasSplit = activeLayout?.type === "split";

  const handleTerminalExited = useCallback(
    (terminalId: string) => {
      setTerminalStatus(groupId, terminalId, "exited");
      void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
    [groupId, queryClient, setTerminalStatus]
  );

  const closeTerminalIds = useCallback(
    async (terminalIds: string[]) => {
      const runningIds = Array.from(new Set(terminalIds)).filter(
        (terminalId) => terminalStatusMap.get(terminalId) === "running"
      );
      if (runningIds.length === 0) return;
      const results = await Promise.allSettled(runningIds.map((terminalId) => terminalApi.close(terminalId)));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
      await queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
    [queryClient, terminalStatusMap]
  );

  const confirmCloseRunningTerminals = useCallback(
    async (terminalIds: string[]) => {
      const runningCount = Array.from(new Set(terminalIds)).filter(
        (terminalId) => terminalStatusMap.get(terminalId) === "running"
      ).length;
      if (runningCount === 0) return true;
      return dialog.confirm(
        runningCount > 1 ? t("terminal.closeRunningTitleMany") : t("terminal.closeRunningTitle"),
        t("terminal.closeRunningConfirm").replace("{count}", String(runningCount)),
        { confirmText: t("common.close"), confirmVariant: "danger" }
      );
    },
    [dialog, t, terminalStatusMap]
  );

  const handleCloseTerminalPages = useCallback(
    async (terminalIds: string[], options?: { skipRunningConfirm?: boolean }) => {
      const pageTerminalIds = Array.from(
        new Set(terminalIds.flatMap((terminalId) => getTerminalPageIds(groupId, terminalId)))
      );
      if (pageTerminalIds.length === 0) return;
      if (!options?.skipRunningConfirm) {
        const confirmed = await confirmCloseRunningTerminals(pageTerminalIds);
        if (!confirmed) return;
      }
      try {
        await closeTerminalIds(pageTerminalIds);
        terminalIds.forEach((terminalId) => removeTerminalPage(groupId, terminalId));
      } catch (e) {
        await dialog.alert(e instanceof Error ? e.message : t("terminal.closeFailed"));
      }
    },
    [closeTerminalIds, confirmCloseRunningTerminals, dialog, getTerminalPageIds, groupId, removeTerminalPage, t]
  );

  const handleClearAll = useCallback(async () => {
    await handleCloseTerminalPages(
      rootTerminals.map((terminal) => terminal.id),
      { skipRunningConfirm: true }
    );
  }, [handleCloseTerminalPages, rootTerminals]);

  const handleCreateTerminal = useCallback(() => {
    createTerminalMutation.mutate({ cwd });
  }, [createTerminalMutation, cwd]);

  const handleToggleListManager = useCallback(() => {
    if (listManagerOpen) {
      if (rootTerminals.length === 0) return;
      if (!activeTerminalId) {
        const last = rootTerminals[rootTerminals.length - 1];
        setActiveId(groupId, last.id);
      }
    }
    setListManagerOpen(groupId, !listManagerOpen);
  }, [groupId, listManagerOpen, setListManagerOpen, rootTerminals, activeTerminalId, setActiveId]);

  useEffect(() => {
    if (rootTerminals.length === 0) {
      setListManagerOpen(groupId, true);
    }
  }, [rootTerminals.length, setListManagerOpen, groupId]);

  const handleTabClick = useCallback(
    (terminalId: string) => {
      setActiveId(groupId, terminalId);
    },
    [groupId, setActiveId]
  );

  const focusedTerminal = useMemo(
    () => terminals.find((terminal) => terminal.id === focusedId) ?? null,
    [focusedId, terminals]
  );

  const persistTerminalRename = useCallback(
    async (terminalId: string, name: string) => {
      try {
        await renameTerminalMutation.mutateAsync({ id: terminalId, name });
      } catch (e) {
        await dialog.alert(e instanceof Error ? e.message : t("terminal.renameFailed"));
        throw e;
      }
    },
    [dialog, renameTerminalMutation, t]
  );

  const handleRenameTerminal = useCallback(
    async (terminalId: string, currentName: string) => {
      const nextName = await dialog.prompt(t("common.rename"), { defaultValue: currentName });
      const trimmedName = nextName?.trim();
      if (!trimmedName || trimmedName === currentName) return;
      await persistTerminalRename(terminalId, trimmedName);
    },
    [dialog, persistTerminalRename, t]
  );

  const getNextTerminalName = useCallback(() => {
    const nums = terminals
      .map((t) => {
        const m = t.name.match(/^Terminal (\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      })
      .filter((n) => n > 0);
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `Terminal ${next}`;
  }, [terminals]);

  const handleSplit = useCallback(
    async (direction: SplitDirection) => {
      const targetId = focusedId || activeTerminalId;
      if (!targetId) return;
      const rootId = useTerminalStore.getState().getRootIdForTerminal(groupId, targetId) || targetId;
      const name = getNextTerminalName();
      try {
        const result = await terminalApi.create({
          cwd,
          name,
          workspace_session_id: currentSessionId || undefined,
          group_id: groupId,
          parent_id: rootId,
        });
        addTerminal(groupId, { id: result.id, name: result.name, parentId: rootId });
        splitTerminalInStore(rootId, targetId, result.id, direction);
        setFocusedId(groupId, result.id);
      } catch {}
    },
    [
      focusedId,
      activeTerminalId,
      groupId,
      cwd,
      currentSessionId,
      addTerminal,
      splitTerminalInStore,
      setFocusedId,
      getNextTerminalName,
    ]
  );

  const handleCloseSplit = useCallback(() => {
    const targetId = focusedId;
    if (!targetId || !hasSplit) return;
    const closeSplit = async () => {
      const confirmed = await confirmCloseRunningTerminals([targetId]);
      if (!confirmed) return;
      try {
        await closeTerminalIds([targetId]);
        removeTerminal(groupId, targetId);
      } catch (e) {
        await dialog.alert(e instanceof Error ? e.message : t("terminal.closeFailed"));
      }
    };
    void closeSplit();
  }, [closeTerminalIds, confirmCloseRunningTerminals, dialog, focusedId, groupId, hasSplit, removeTerminal, t]);

  const handleDeleteTerminalPage = useCallback(
    async (terminalId: string) => {
      try {
        await terminalApi.delete(terminalId);
        await queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
        removeTerminalPage(groupId, terminalId);
      } catch (e) {
        await dialog.alert(e instanceof Error ? e.message : t("terminal.deleteFailed"));
      }
    },
    [dialog, groupId, queryClient, removeTerminalPage, t]
  );

  const handleRatioChange = useCallback(
    (path: number[], ratio: number) => {
      updateSplitRatio(groupId, path, ratio);
    },
    [groupId, updateSplitRatio]
  );

  const handleFocusPane = useCallback(
    (terminalId: string) => {
      setFocusedId(groupId, terminalId);
    },
    [groupId, setFocusedId]
  );

  const handleTerminalStateChange = useCallback(
    (terminalId: string, state: TerminalInstanceStateUpdate) => {
      const updates: Partial<TerminalSession> = {};
      if (state.capabilities) updates.capabilities = state.capabilities;
      if (state.currentCwd !== undefined) updates.currentCwd = state.currentCwd;
      if (state.lastCommand !== undefined) updates.lastCommand = state.lastCommand;
      if (state.lastCommandExitCode !== undefined) updates.lastCommandExitCode = state.lastCommandExitCode;
      if (state.readonly !== undefined) updates.readonly = state.readonly;
      if (state.runtimeType !== undefined) updates.runtimeType = state.runtimeType;
      if (state.shellIntegration !== undefined) updates.shellIntegration = state.shellIntegration;
      if (state.shellState !== undefined) updates.shellState = state.shellState;
      if (state.shellType !== undefined) updates.shellType = state.shellType;
      if (state.status === "running" || state.status === "exited" || state.status === "closed") {
        updates.status = state.status;
      }
      if (Object.keys(updates).length > 0) {
        useTerminalStore.getState().updateTerminal(groupId, terminalId, updates);
      }
    },
    [groupId]
  );

  const makeTerminalExitedHandler = useCallback(
    (terminalId: string) => () => handleTerminalExited(terminalId),
    [handleTerminalExited]
  );

  const makeTerminalStateChangeHandler = useCallback(
    (terminalId: string) => (state: TerminalInstanceStateUpdate) => handleTerminalStateChange(terminalId, state),
    [handleTerminalStateChange]
  );

  useEffect(() => {
    if (!currentSessionId) {
      return;
    }
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void syncTerminalWorkspaceState(currentSessionId, {
        terminalsByGroup,
        activeTerminalByGroup: activeIdByGroup,
        listManagerOpenByGroup,
        terminalLayouts,
        focusedIdByGroup,
      });
    }, 300);

    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [currentSessionId, terminalsByGroup, activeIdByGroup, listManagerOpenByGroup, terminalLayouts, focusedIdByGroup]);

  useEffect(() => {
    if (activeLayoutTerminalIds.length <= 1) {
      return;
    }
    const exitedIds = activeLayoutTerminalIds.filter((terminalId) => terminalStatusMap.get(terminalId) !== "running");
    if (exitedIds.length === 0) {
      return;
    }
    exitedIds.forEach((terminalId) => {
      removeTerminal(groupId, terminalId);
    });
  }, [activeLayoutTerminalIds, groupId, removeTerminal, terminalStatusMap]);

  const pageMenuItems = useMemo(() => {
    if (showHistory || listManagerOpen || !focusedTerminal) {
      return [];
    }
    const items = [
      {
        id: "rename-terminal",
        icon: <Edit2 size={18} />,
        label: t("common.rename"),
        onClick: () => {
          void handleRenameTerminal(focusedTerminal.id, focusedTerminal.name);
        },
      },
      {
        id: "split-down",
        icon: <Rows size={18} />,
        label: t("terminal.splitDown"),
        onClick: () => {
          void handleSplit("vertical");
        },
      },
      {
        id: "split-right",
        icon: <Columns size={18} />,
        label: t("terminal.splitRight"),
        onClick: () => {
          void handleSplit("horizontal");
        },
      },
    ];
    if (hasSplit) {
      items.push({
        id: "close-split",
        icon: <XCircle size={18} />,
        label: t("terminal.closeSplit"),
        onClick: () => {
          void handleCloseSplit();
        },
      });
    }
    return items;
  }, [focusedTerminal, handleRenameTerminal, handleSplit, handleCloseSplit, hasSplit, listManagerOpen, showHistory, t]);

  useEffect(() => {
    setPageMenuItems(pageMenuItems);
  }, [pageMenuItems, setPageMenuItems]);

  useEffect(() => {
    return () => {
      setPageMenuItems([]);
    };
  }, [setPageMenuItems]);

  const topBarConfig = useMemo(() => {
    return {
      show: true,
      leftButtons: [{ icon: <Terminal size={18} />, onClick: handleToggleListManager, active: listManagerOpen }],
      centerContent:
        rootTerminals.length > 0 ? (
          <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar touch-pan-x h-full">
            {displayTerminals.map((terminal) => {
              const isActive = !listManagerOpen && terminal.id === activeTerminalId;
              const isClosed = terminal.status !== "running";
              return (
                <div
                  key={terminal.id}
                  onClick={() => handleTabClick(terminal.id)}
                  className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
                    isActive
                      ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                      : isClosed
                        ? "bg-transparent border-transparent text-ide-mute/50 hover:bg-ide-panel/50 hover:text-ide-mute"
                        : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
                  }`}
                >
                  <Terminal size={12} />
                  <span className={`max-w-[80px] truncate font-medium ${!terminal.pinned ? "italic" : ""}`}>
                    {terminal.name}
                  </span>
                  {isActive && terminal.currentCwd && (
                    <span
                      className="hidden max-w-[88px] truncate text-[11px] text-ide-mute md:inline"
                      title={terminal.currentCwd}
                    >
                      /{getCompactTerminalLocation(terminal.currentCwd)}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCloseTerminalPages([terminal.id]);
                    }}
                    className="hover:text-red-500 rounded-full p-0.5 hover:bg-ide-bg"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null,
      rightButtons: [{ icon: <Plus size={18} />, onClick: handleCreateTerminal }],
    };
  }, [
    handleToggleListManager,
    handleCreateTerminal,
    handleTabClick,
    listManagerOpen,
    rootTerminals,
    displayTerminals,
    activeTerminalId,
    handleCloseTerminalPages,
  ]);

  const activeTopBarConfig = showHistory ? undefined : topBarConfig;
  usePageTopBar(activeTopBarConfig, [activeTopBarConfig]);

  const getFocusedTerminalRef = useCallback((): TerminalInstanceHandle | null => {
    const targetId = focusedId || activeTerminalId;
    if (!targetId) return null;
    return terminalRefsMap.current.get(targetId) ?? null;
  }, [focusedId, activeTerminalId]);

  const handleVirtualKeyEvent = useCallback(
    (event: KeyEvent) => {
      const action = translateKeyEvent(event);
      const handle = getFocusedTerminalRef();
      if (!handle) return false;

      switch (action.type) {
        case "input":
          handle.sendInput(action.data);
          return true;
        case "copy": {
          const text = handle.getSelection();
          if (text) void navigator.clipboard.writeText(text);
          return true;
        }
        case "paste":
          void handle.pasteFromClipboard();
          return true;
        case "cut": {
          const sel = handle.getSelection();
          if (sel) {
            void navigator.clipboard.writeText(sel);
            handle.sendInput("\x18");
          }
          return true;
        }
        case "undo":
          handle.sendInput("\x1a");
          return true;
        case "select":
          handle.selectAll();
          return true;
      }
      return false;
    },
    [getFocusedTerminalRef]
  );

  const registerHandler = useKeyboardStore((s) => s.registerHandler);

  useEffect(() => {
    return registerHandler((e) => {
      const active = document.activeElement;
      if (!active || !active.classList.contains("xterm-helper-textarea")) return false;

      // Only handle if this terminal page instance owns the focused terminal
      const handle = getFocusedTerminalRef();
      if (!handle) return false;

      return handleVirtualKeyEvent(e);
    });
  }, [registerHandler, handleVirtualKeyEvent, getFocusedTerminalRef]);

  const setTerminalRef = useCallback(
    (id: string) => (ref: TerminalInstanceHandle | null) => {
      if (ref) {
        terminalRefsMap.current.set(id, ref);
      } else {
        terminalRefsMap.current.delete(id);
      }
    },
    []
  );

  if (showHistory) {
    return <TerminalHistoryPage onBack={() => setShowHistory(false)} />;
  }

  return (
    <div className="flex flex-col h-full bg-ide-bg">
      <div className="flex-1 relative overflow-hidden">
        {listManagerOpen ? (
          <TerminalListManager
            terminals={rootTerminals}
            activeTerminalId={activeTerminalId}
            onSelect={(id) => {
              setActiveId(groupId, id);
              setListManagerOpen(groupId, false);
            }}
            onRename={persistTerminalRename}
            onClose={(id) => {
              void handleCloseTerminalPages([id]);
            }}
            onDelete={(id) => {
              void handleDeleteTerminalPage(id);
            }}
            onClearAll={() => {
              void handleClearAll();
            }}
            onBack={() => {}}
            onManageHistory={() => setShowHistory(true)}
            embedded={true}
          />
        ) : activeLayout ? (
          hasSplit ? (
            <TerminalSplitView
              layout={activeLayout}
              groupId={groupId}
              focusedId={focusedId}
              terminals={terminals}
              onFocus={handleFocusPane}
              onExited={handleTerminalExited}
              onStateChange={handleTerminalStateChange}
              onRatioChange={handleRatioChange}
              setTerminalRef={setTerminalRef}
            />
          ) : (
            terminals.map((terminal) => (
              <TerminalInstance
                key={terminal.id}
                ref={setTerminalRef(terminal.id)}
                terminalId={terminal.id}
                terminalName={terminal.name}
                isActive={terminal.id === activeTerminalId}
                isExited={terminal.status !== "running"}
                initialCwd={terminal.currentCwd || cwd}
                onExited={makeTerminalExitedHandler(terminal.id)}
                onStateChange={makeTerminalStateChangeHandler(terminal.id)}
              />
            ))
          )
        ) : (
          terminals.map((terminal) => (
            <TerminalInstance
              key={terminal.id}
              ref={setTerminalRef(terminal.id)}
              terminalId={terminal.id}
              terminalName={terminal.name}
              isActive={terminal.id === activeTerminalId}
              isExited={terminal.status !== "running"}
              initialCwd={terminal.currentCwd || cwd}
              onExited={makeTerminalExitedHandler(terminal.id)}
              onStateChange={makeTerminalStateChangeHandler(terminal.id)}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default TerminalPage;
