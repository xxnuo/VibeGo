import { Copy, Search, X } from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";

interface TerminalSelectionMenuProps {
  left: number;
  top: number;
  copyLabel: string;
  searchLabel: string;
  clearLabel: string;
  onCopy: () => void;
  onSearch: () => void;
  onClear: () => void;
}

const actionClassName =
  "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-2 text-[11px] font-medium text-ide-text transition-colors hover:bg-ide-bg/80 active:bg-ide-bg/80";

const TerminalSelectionMenu: React.FC<TerminalSelectionMenuProps> = ({
  left,
  top,
  copyLabel,
  searchLabel,
  clearLabel,
  onCopy,
  onSearch,
  onClear,
}) => {
  return (
    <div
      className="absolute z-20 w-[216px] max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-md border border-ide-border bg-ide-panel/96 p-1 shadow-lg backdrop-blur-sm"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1">
        <button type="button" onClick={onCopy} className={cn(actionClassName, "text-ide-accent")}>
          <Copy size={14} />
          <span>{copyLabel}</span>
        </button>
        <button type="button" onClick={onSearch} className={actionClassName}>
          <Search size={14} />
          <span>{searchLabel}</span>
        </button>
        <button type="button" onClick={onClear} className={actionClassName}>
          <X size={14} />
          <span>{clearLabel}</span>
        </button>
      </div>
    </div>
  );
};

export default TerminalSelectionMenu;
