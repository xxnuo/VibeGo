import { X } from "lucide-react";
import React, { useCallback, useRef } from "react";
import type { TerminalSession } from "@/stores/terminal-store";

interface TerminalTabsProps {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
}

const TerminalTabs: React.FC<TerminalTabsProps> = ({ terminals, activeTerminalId, onTabClick, onTabClose }) => {
  const tabsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      onTabClose(id);
    },
    [onTabClose]
  );

  return (
    <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar touch-pan-x h-full w-full">
      {terminals.map((terminal) => (
        <div
          key={terminal.id}
          ref={(el) => {
            if (el) tabsRef.current.set(terminal.id, el);
            else tabsRef.current.delete(terminal.id);
          }}
          onClick={() => onTabClick(terminal.id)}
          className={`group flex h-11 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md border px-2 text-xs transition-all md:h-7 md:px-3 ${
            activeTerminalId === terminal.id
              ? "bg-ide-bg border-ide-border text-ide-text shadow-sm"
              : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
          }`}
        >
          <span className={`max-w-[120px] truncate font-medium ${!terminal.pinned ? "italic" : ""}`}>
            {terminal.name}
          </span>
          <button
            type="button"
            onClick={(e) => handleCloseTab(e, terminal.id)}
            className="flex size-11 shrink-0 items-center justify-center rounded-sm text-ide-mute transition-opacity hover:bg-ide-panel hover:text-red-500 md:size-auto md:rounded-full md:p-0.5 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
            aria-label={`Close ${terminal.name}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default TerminalTabs;
