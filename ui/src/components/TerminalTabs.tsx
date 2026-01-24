import React, { useRef, useCallback } from "react";
import { X } from "lucide-react";
import type { TerminalSession } from "@/stores/terminalStore";

interface TerminalTabsProps {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
}

const TerminalTabs: React.FC<TerminalTabsProps> = ({
  terminals,
  activeTerminalId,
  onTabClick,
  onTabClose,
}) => {
  const tabsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      onTabClose(id);
    },
    [onTabClose],
  );

  return (
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar touch-pan-x h-full w-full">
      {terminals.map((terminal) => (
        <div
          key={terminal.id}
          ref={(el) => {
            if (el) tabsRef.current.set(terminal.id, el);
            else tabsRef.current.delete(terminal.id);
          }}
          onClick={() => onTabClick(terminal.id)}
          className={`group shrink-0 px-3 h-7 rounded-md flex items-center gap-2 text-xs border transition-all cursor-pointer select-none ${
            activeTerminalId === terminal.id
              ? "bg-ide-bg border-ide-border text-ide-text shadow-sm"
              : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
          }`}
        >
          <span
            className={`max-w-[120px] truncate font-medium ${
              !terminal.pinned ? "italic" : ""
            }`}
          >
            {terminal.name}
          </span>
          <button
            onClick={(e) => handleCloseTab(e, terminal.id)}
            className="hover:text-red-500 rounded-full p-0.5 hover:bg-ide-panel opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default TerminalTabs;
