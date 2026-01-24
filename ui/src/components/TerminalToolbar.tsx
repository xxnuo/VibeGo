import React from "react";
import { Plus, LayoutList, Trash2 } from "lucide-react";
import type { TerminalSession } from "@/stores/terminalStore";
import TerminalTabs from "./TerminalTabs";

interface TerminalToolbarProps {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTerminal: () => void;
  onToggleListMode: () => void;
  isListMode: boolean;
  onClearAll?: () => void;
}

const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
  terminals,
  activeTerminalId,
  onTabClick,
  onTabClose,
  onNewTerminal,
  onToggleListMode,
  isListMode,
  onClearAll,
}) => {
  return (
    <div className="flex flex-col bg-ide-panel border-b border-ide-border">
      <div className="flex items-center gap-1 h-10 px-2">
        <div className="flex-1 overflow-hidden h-full flex items-center">
          {!isListMode ? (
            <TerminalTabs
              terminals={terminals}
              activeTerminalId={activeTerminalId}
              onTabClick={onTabClick}
              onTabClose={onTabClose}
            />
          ) : (
            <span className="text-sm font-medium text-ide-text ml-2">
              Terminals
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 pl-2 border-l border-ide-border ml-2">
          <button
            onClick={onToggleListMode}
            className={`p-2 rounded-md hover:bg-ide-bg ${
              isListMode ? "text-ide-mute" : "text-ide-accent"
            }`}
            title={isListMode ? "Back to Terminal" : "Terminal List"}
          >
            {isListMode ? (
              <LayoutList size={18} className="rotate-180" />
            ) : (
              <LayoutList size={18} />
            )}
          </button>

          <button
            onClick={onNewTerminal}
            className="p-2 rounded-md text-ide-mute hover:bg-ide-bg hover:text-ide-text"
            title="New Terminal"
          >
            <Plus size={18} />
          </button>

          {onClearAll && isListMode && terminals.length > 0 && (
            <button
              onClick={onClearAll}
              className="p-2 rounded-md text-ide-mute hover:bg-red-500/10 hover:text-red-500"
              title="Clear All"
            >
              <Trash2 size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default TerminalToolbar;
