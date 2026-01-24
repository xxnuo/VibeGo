import React, { useCallback, useEffect, useMemo } from "react";
import { useTerminalStore, type TerminalSession } from "@/stores/terminalStore";
import { useTerminalClose, useTerminalCreate } from "@/hooks/useTerminal";
import { usePageTopBar } from "@/hooks/usePageTopBar";
import TerminalInstance from "./TerminalInstance";
import TerminalListManager from "./TerminalListManager";
import { Plus, X, Terminal } from "lucide-react";

interface TerminalPageProps {
  groupId: string;
  cwd?: string;
}

const EMPTY_TERMINALS: TerminalSession[] = [];

const TerminalPage: React.FC<TerminalPageProps> = ({ groupId, cwd }) => {
  const terminals = useTerminalStore(
    (s) => s.terminalsByGroup[groupId] || EMPTY_TERMINALS,
  );
  const activeTerminalId = useTerminalStore(
    (s) => s.activeIdByGroup[groupId] ?? null,
  );
  const listManagerOpen = useTerminalStore(
    (s) => s.listManagerOpenByGroup[groupId] ?? true,
  );

  const setActiveId = useTerminalStore((s) => s.setActiveId);
  const setListManagerOpen = useTerminalStore((s) => s.setListManagerOpen);
  const renameTerminal = useTerminalStore((s) => s.renameTerminal);

  const closeTerminalMutation = useTerminalClose(groupId);
  const createTerminalMutation = useTerminalCreate(groupId);

  const handleClearAll = useCallback(() => {
    terminals.forEach((t) => {
      closeTerminalMutation.mutate(t.id);
    });
  }, [terminals, closeTerminalMutation]);

  const handleCreateTerminal = useCallback(() => {
    createTerminalMutation.mutate({ cwd });
  }, [createTerminalMutation, cwd]);

  const handleToggleListManager = useCallback(() => {
    if (listManagerOpen) {
      // Closing the manager - ensure we have an active terminal
      if (terminals.length === 0) {
        return; // Cannot close if no terminals
      }

      // If no active terminal is selected, select the last one
      if (!activeTerminalId) {
        const lastTerminal = terminals[terminals.length - 1];
        setActiveId(groupId, lastTerminal.id);
      }
    }
    setListManagerOpen(groupId, !listManagerOpen);
  }, [
    groupId,
    listManagerOpen,
    setListManagerOpen,
    terminals,
    activeTerminalId,
    setActiveId,
  ]);

  const handleCloseTerminal = useCallback(
    (e: React.MouseEvent, terminalId: string) => {
      e.stopPropagation();
      closeTerminalMutation.mutate(terminalId);
    },
    [closeTerminalMutation],
  );

  useEffect(() => {
    if (terminals.length === 0) {
      setListManagerOpen(groupId, true);
    }
  }, [terminals.length, setListManagerOpen, groupId]);

  const handleTabClick = useCallback(
    (terminalId: string) => {
      setActiveId(groupId, terminalId);
    },
    [groupId, setActiveId],
  );

  const displayTerminals = useMemo(() => [...terminals].reverse(), [terminals]);

  const topBarConfig = useMemo(() => {
    return {
      show: true,
      leftButtons: [
        {
          icon: <Terminal size={16} />,
          onClick: handleToggleListManager,
          active: listManagerOpen,
          // Add styling to match file browser button if needed,
          // but TopBar handles 'active' style.
          // User complaint about "missing border" might imply they want
          // the button to look like a specific "toggle" state.
          // The TopBar 'active' class has 'border-ide-accent'.
        },
      ],
      centerContent:
        terminals.length > 0 ? (
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar touch-pan-x h-full">
            {displayTerminals.map((terminal) => {
              const isActive =
                !listManagerOpen && terminal.id === activeTerminalId;
              return (
                <div
                  key={terminal.id}
                  onClick={() => handleTabClick(terminal.id)}
                  className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
                    isActive
                      ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                      : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
                  }`}
                >
                  <Terminal size={12} />
                  <span
                    className={`max-w-[80px] truncate font-medium ${!terminal.pinned ? "italic" : ""}`}
                  >
                    {terminal.name}
                  </span>
                  <button
                    onClick={(e) => handleCloseTerminal(e, terminal.id)}
                    className="hover:text-red-500 rounded-full p-0.5 hover:bg-ide-bg"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null,
      rightButtons: [
        {
          icon: <Plus size={16} />,
          onClick: handleCreateTerminal,
        },
      ],
    };
  }, [
    handleToggleListManager,
    handleCreateTerminal,
    handleTabClick,
    listManagerOpen,
    terminals,
    displayTerminals,
    activeTerminalId,
    handleCloseTerminal,
  ]);

  usePageTopBar(topBarConfig, [topBarConfig]);

  return (
    <div className="flex flex-col h-full bg-ide-bg">
      <div className="flex-1 relative overflow-hidden">
        {listManagerOpen ? (
          <TerminalListManager
            terminals={terminals}
            activeTerminalId={activeTerminalId}
            onSelect={(id) => {
              setActiveId(groupId, id);
              setListManagerOpen(groupId, false);
            }}
            onRename={(id, name) => renameTerminal(groupId, id, name)}
            onDelete={(id) => closeTerminalMutation.mutate(id)}
            onClearAll={handleClearAll}
            onBack={() => {}}
            embedded={true}
          />
        ) : (
          terminals.map((terminal) => (
            <TerminalInstance
              key={terminal.id}
              terminalId={terminal.id}
              isActive={terminal.id === activeTerminalId}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default TerminalPage;
