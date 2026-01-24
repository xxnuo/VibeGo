import React, { useRef, useEffect, useState } from "react";
import {
  ChevronRight,
  Home,
  ChevronLeft,
  ChevronRight as Forward,
  ChevronUp,
  Check,
  X,
} from "lucide-react";
import { useFileManagerStore } from "@/stores/fileManagerStore";

interface FileManagerBreadcrumbProps {
  className?: string;
}

const FileManagerBreadcrumb: React.FC<FileManagerBreadcrumbProps> = ({
  className = "",
}) => {
  const {
    currentPath,
    rootPath,
    historyIndex,
    pathHistory,
    goToPath,
    goBack,
    goForward,
    goParent,
  } = useFileManagerStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const pathParts =
    currentPath === "/" ? [] : currentPath.split("/").filter(Boolean);
  const displayParts = pathParts;

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < pathHistory.length - 1;
  const canGoUp = currentPath !== "/";

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [currentPath]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handlePartClick = (index: number) => {
    if (index === -1) {
      goToPath(rootPath);
    } else {
      const newPath = "/" + displayParts.slice(0, index + 1).join("/");
      goToPath(newPath);
    }
  };

  const handleLongPressStart = () => {
    longPressTimer.current = setTimeout(() => {
      setEditValue(currentPath);
      setIsEditing(true);
    }, 500);
  };

  const handleLongPressEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleEditSubmit = () => {
    if (editValue.trim() && editValue.trim() !== currentPath) {
      goToPath(editValue.trim());
    }
    setIsEditing(false);
  };

  const handleEditCancel = () => {
    setIsEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleEditSubmit();
    } else if (e.key === "Escape") {
      setIsEditing(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-1 h-10 px-2 bg-ide-panel border-b border-ide-border ${className}`}
    >
      <button
        onClick={goBack}
        disabled={!canGoBack}
        className={`p-1.5 rounded-md transition-colors ${
          canGoBack
            ? "text-ide-text hover:bg-ide-bg active:bg-ide-accent/20"
            : "text-ide-mute/50 cursor-not-allowed"
        }`}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        onClick={goParent}
        disabled={!canGoUp}
        className={`p-1.5 rounded-md transition-colors ${
          canGoUp
            ? "text-ide-text hover:bg-ide-bg active:bg-ide-accent/20"
            : "text-ide-mute/50 cursor-not-allowed"
        }`}
      >
        <ChevronUp size={18} />
      </button>
      <button
        onClick={goForward}
        disabled={!canGoForward}
        className={`p-1.5 rounded-md transition-colors ${
          canGoForward
            ? "text-ide-text hover:bg-ide-bg active:bg-ide-accent/20"
            : "text-ide-mute/50 cursor-not-allowed"
        }`}
      >
        <Forward size={18} />
      </button>

      <div className="w-px h-5 bg-ide-border mx-1" />

      <button
        onClick={() => handlePartClick(-1)}
        className="shrink-0 p-1.5 rounded-md text-ide-mute hover:text-ide-accent hover:bg-ide-bg transition-colors"
      >
        <Home size={18} />
      </button>

      {isEditing ? (
        <div className="flex-1 flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleEditKeyDown}
            className="flex-1 px-2 py-1 bg-ide-bg border border-ide-accent rounded text-xs text-ide-text outline-none"
          />
          <button
            onClick={handleEditSubmit}
            className="p-1.5 rounded-md text-green-500 hover:bg-ide-bg transition-colors"
          >
            <Check size={18} />
          </button>
          <button
            onClick={handleEditCancel}
            className="p-1.5 rounded-md text-red-500 hover:bg-ide-bg transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 flex items-center gap-0.5 overflow-x-auto no-scrollbar touch-pan-x"
          onTouchStart={handleLongPressStart}
          onTouchEnd={handleLongPressEnd}
          onTouchMove={handleLongPressEnd}
          onContextMenu={(e) => {
            e.preventDefault();
            setEditValue(currentPath);
            setIsEditing(true);
          }}
        >
          {displayParts.map((part, index) => (
            <React.Fragment key={index}>
              <ChevronRight size={14} className="shrink-0 text-ide-mute/50" />
              <button
                onClick={() => handlePartClick(index)}
                className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors truncate max-w-[120px] ${
                  index === displayParts.length - 1
                    ? "text-ide-accent bg-ide-accent/10"
                    : "text-ide-text hover:text-ide-accent hover:bg-ide-bg"
                }`}
              >
                {part}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

export default FileManagerBreadcrumb;
