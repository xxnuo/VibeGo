import React, { useCallback, useEffect } from "react";
import { useTerminalStore } from "@/stores/terminalStore";
import { useTerminalCreate, useTerminalClose } from "@/hooks/useTerminal";
import TerminalInstance from "./TerminalInstance";
import { useFrameStore } from "@/stores/frameStore";
import TerminalListManager from "./TerminalListManager";
import TerminalTabs from "./TerminalTabs";
import { Plus, ArrowLeft } from "lucide-react";

interface TerminalPageProps {
  cwd?: string;
}

const TerminalPage: React.FC<TerminalPageProps> = ({ cwd }) => {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTabId = useFrameStore((s) => {
    const group = s.groups.find((g) => g.id === s.activeGroupId);
    if (!group) return null;
    if (group.type === "folder") {
      return group.views[group.activeView].activeTabId;
    }
    if (group.type === "home" || group.type === "settings") return null;
    return group.activeTabId;
  });
  const setTopBarConfig = useFrameStore((s) => s.setTopBarConfig);
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);

  const isListManagerOpen = useTerminalStore((s) => s.isListManagerOpen);
  const setListManagerOpen = useTerminalStore((s) => s.setListManagerOpen);
  const renameTerminal = useTerminalStore((s) => s.renameTerminal);

  const createTerminalMutation = useTerminalCreate();
  const closeTerminalMutation = useTerminalClose();

  const handleNewTerminal = useCallback(() => {
    createTerminalMutation.mutate(
      { cwd },
      {
        onSuccess: () => {
          setListManagerOpen(false);
        },
      },
    );
  }, [createTerminalMutation, cwd, setListManagerOpen]);

  const handleClearAll = useCallback(() => {
    terminals.forEach((t) => {
      closeTerminalMutation.mutate(t.id);
    });
  }, [terminals, closeTerminalMutation]);

  // Set default state to list if not set (initial load)
  useEffect(() => {
    if (terminals.length === 0) {
      setListManagerOpen(true);
    }
  }, [terminals.length, setListManagerOpen]);

  // TopBar Configuration
  useEffect(() => {
    if (isListManagerOpen) {
      // List Mode: Simple Title
      setTopBarConfig({
        show: true,
        centerContent: (
          <div className="flex items-center gap-2 text-sm font-medium text-ide-text">
            Terminals
          </div>
        ),
        leftButtons: [],
        rightButtons: [
          {
            icon: <Plus size={16} />,
            label: "New",
            onClick: handleNewTerminal,
          },
        ],
      });
    } else {
      // Terminal Mode: Tabs in Center, List button
      setTopBarConfig({
        show: true,
        centerContent: (
          <TerminalTabs
            terminals={terminals}
            activeTerminalId={activeTabId}
            onTabClick={setCurrentActiveTab}
            onTabClose={(id) => closeTerminalMutation.mutate(id)}
          />
        ),
        leftButtons: [
          {
            icon: <ArrowLeft size={16} />,
            onClick: () => setListManagerOpen(true),
            label: "List",
          },
        ],
        rightButtons: [
          {
            icon: <Plus size={16} />,
            label: "New",
            onClick: handleNewTerminal,
          },
        ],
      });
    }
  }, [
    isListManagerOpen,
    setTopBarConfig,
    terminals,
    activeTabId,
    setCurrentActiveTab,
    closeTerminalMutation,
    handleNewTerminal,
    setListManagerOpen,
  ]);

  return (
    <div className="flex flex-col h-full bg-ide-bg">
      <div className="flex-1 relative overflow-hidden">
        {isListManagerOpen ? (
          <TerminalListManager
            terminals={terminals}
            activeTerminalId={activeTabId}
            onSelect={(id) => {
              setCurrentActiveTab(id);
              setListManagerOpen(false);
            }}
            onRename={renameTerminal}
            onDelete={(id) => closeTerminalMutation.mutate(id)}
            onClearAll={handleClearAll}
            onBack={() => {}}
            embedded={true}
          />
        ) : (
          <div className="flex-1 h-full relative">
            {terminals.length === 0 ? (
              <div className="flex items-center justify-center h-full text-ide-mute">
                <div className="text-center">
                  <p className="mb-2">No active terminals.</p>
                  <button
                    onClick={() => setListManagerOpen(true)}
                    className="text-ide-accent hover:underline text-sm"
                  >
                    Go to Terminal List
                  </button>
                </div>
              </div>
            ) : (
              terminals.map((terminal) => (
                <TerminalInstance
                  key={terminal.id}
                  terminalId={terminal.id}
                  isActive={terminal.id === activeTabId}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TerminalPage;
