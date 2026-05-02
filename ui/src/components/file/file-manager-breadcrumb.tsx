import { Check, ChevronLeft, ChevronRight, ChevronUp, ChevronRight as Forward, Home, X } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { type FileManagerStoreApi, fileManagerStore } from "@/stores/file-manager-store";

interface FileManagerBreadcrumbProps {
  className?: string;
  store?: FileManagerStoreApi;
}

const FileManagerBreadcrumb: React.FC<FileManagerBreadcrumbProps> = ({ className = "", store }) => {
  const storeApi = store ?? fileManagerStore;
  const { currentPath, rootPath, historyIndex, pathHistory, goToPath, goBack, goForward, goParent } =
    useStore(storeApi);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pathInputId = useId();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const pathParts = currentPath === "/" ? [] : currentPath.split("/").filter(Boolean);
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
    <div className={`flex h-12 items-center gap-1 border-b border-ide-border bg-ide-panel px-2 md:h-10 ${className}`}>
      <button
        type="button"
        onClick={goBack}
        disabled={!canGoBack}
        title="Back"
        aria-label="Back"
        className={`flex size-11 shrink-0 items-center justify-center rounded-md transition-colors md:size-auto md:p-1.5 ${
          canGoBack ? "text-ide-text hover:bg-ide-bg active:bg-ide-accent/20" : "text-ide-mute/50 cursor-not-allowed"
        }`}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        type="button"
        onClick={goParent}
        disabled={!canGoUp}
        title="Parent directory"
        aria-label="Parent directory"
        className={`flex size-11 shrink-0 items-center justify-center rounded-md transition-colors md:size-auto md:p-1.5 ${
          canGoUp ? "text-ide-text hover:bg-ide-bg active:bg-ide-accent/20" : "text-ide-mute/50 cursor-not-allowed"
        }`}
      >
        <ChevronUp size={18} />
      </button>
      <button
        type="button"
        onClick={goForward}
        disabled={!canGoForward}
        title="Forward"
        aria-label="Forward"
        className={`flex size-11 shrink-0 items-center justify-center rounded-md transition-colors md:size-auto md:p-1.5 ${
          canGoForward ? "text-ide-text hover:bg-ide-bg active:bg-ide-accent/20" : "text-ide-mute/50 cursor-not-allowed"
        }`}
      >
        <Forward size={18} />
      </button>

      <div className="w-px h-5 bg-ide-border mx-1" />

      <button
        type="button"
        onClick={() => handlePartClick(-1)}
        title="Root directory"
        aria-label="Root directory"
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-ide-mute transition-colors hover:bg-ide-bg hover:text-ide-accent md:size-auto md:p-1.5"
      >
        <Home size={18} />
      </button>

      {isEditing ? (
        <div className="flex-1 flex items-center gap-1">
          <input
            ref={inputRef}
            id={pathInputId}
            name="path"
            type="text"
            aria-label="Current path"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleEditKeyDown}
            className="h-11 min-w-0 flex-1 rounded border border-ide-accent bg-ide-bg px-2 text-base text-ide-text outline-none md:h-auto md:py-1 md:text-xs"
          />
          <button
            type="button"
            onClick={handleEditSubmit}
            title="Apply path"
            aria-label="Apply path"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-green-500 transition-colors hover:bg-ide-bg md:size-auto md:p-1.5"
          >
            <Check size={18} />
          </button>
          <button
            type="button"
            onClick={handleEditCancel}
            title="Cancel path edit"
            aria-label="Cancel path edit"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-red-500 transition-colors hover:bg-ide-bg md:size-auto md:p-1.5"
          >
            <X size={18} />
          </button>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 flex items-center gap-0.5 overflow-x-auto custom-scrollbar touch-pan-x"
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
                type="button"
                onClick={() => handlePartClick(index)}
                aria-label={`Open ${part}`}
                className={`flex min-h-11 min-w-11 max-w-[120px] shrink-0 items-center truncate rounded-md px-2 text-xs font-medium transition-colors md:min-h-0 md:min-w-0 md:py-1 ${
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
