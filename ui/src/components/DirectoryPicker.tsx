import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  Folder,
  FolderOpen,
  ChevronRight,
  Home,
  ArrowUp,
  ChevronLeft,
  ChevronRight as Forward,
  Check,
} from "lucide-react";
import { fileApi, type FileInfo } from "@/api/file";
import { useTranslation, type Locale } from "@/lib/i18n";

interface DirectoryPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  locale: Locale;
}

const DirectoryPicker: React.FC<DirectoryPickerProps> = ({
  isOpen,
  onClose,
  onSelect,
  initialPath = ".",
  locale,
}) => {
  const t = useTranslation(locale);
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [directories, setDirectories] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [inputPath, setInputPath] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isEditing, setIsEditing] = useState(false);
  const historyIndexRef = useRef(historyIndex);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  const loadDirectories = useCallback(async (path: string, addToHistory = true) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fileApi.list(path);
      const dirs = res.files.filter((f) => f.isDir);
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      setDirectories(dirs);
      setCurrentPath(res.path);
      setInputPath(res.path);
      if (addToHistory) {
        setPathHistory((prev) => {
          const newHistory = prev.slice(0, historyIndexRef.current + 1);
          newHistory.push(res.path);
          return newHistory;
        });
        setHistoryIndex((prev) => prev + 1);
      }
    } catch (e) {
      setError((e as Error).message);
      setDirectories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setPathHistory([]);
      setHistoryIndex(-1);
      loadDirectories(initialPath);
    }
  }, [isOpen, initialPath, loadDirectories]);

  const handleNavigate = (path: string) => {
    loadDirectories(path);
  };

  const handleParent = () => {
    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
    handleNavigate(parent);
  };

  const handleBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      loadDirectories(pathHistory[newIndex], false);
    }
  };

  const handleForward = () => {
    if (historyIndex < pathHistory.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      loadDirectories(pathHistory[newIndex], false);
    }
  };

  const handleHome = () => {
    handleNavigate("/");
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputPath.trim()) {
      handleNavigate(inputPath.trim());
      setIsEditing(false);
    }
  };

  const handleSelect = () => {
    onSelect(currentPath);
    onClose();
  };

  const pathParts = currentPath === "/" ? [] : currentPath.split("/").filter(Boolean);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < pathHistory.length - 1;
  const canGoUp = currentPath !== "/";

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="fixed inset-0 sm:inset-4 sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[500px] sm:max-h-[80vh] sm:h-auto bg-ide-panel sm:border border-ide-border sm:rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-3 sm:p-4 border-b border-ide-border">
          <h3 className="font-bold text-ide-text text-sm sm:text-base">{t("directoryPicker.title")}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-ide-bg text-ide-mute hover:text-ide-text"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex items-center gap-1 p-2 border-b border-ide-border">
          <button
            onClick={handleBack}
            disabled={!canGoBack}
            className={`p-1.5 rounded-md transition-colors ${
              canGoBack
                ? "text-ide-text hover:bg-ide-bg"
                : "text-ide-mute/50 cursor-not-allowed"
            }`}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={handleParent}
            disabled={!canGoUp}
            className={`p-1.5 rounded-md transition-colors ${
              canGoUp
                ? "text-ide-text hover:bg-ide-bg"
                : "text-ide-mute/50 cursor-not-allowed"
            }`}
          >
            <ArrowUp size={18} />
          </button>
          <button
            onClick={handleForward}
            disabled={!canGoForward}
            className={`p-1.5 rounded-md transition-colors ${
              canGoForward
                ? "text-ide-text hover:bg-ide-bg"
                : "text-ide-mute/50 cursor-not-allowed"
            }`}
          >
            <Forward size={18} />
          </button>

          <div className="w-px h-5 bg-ide-border mx-1" />

          <button
            onClick={handleHome}
            className="shrink-0 p-1.5 rounded-md text-ide-mute hover:text-ide-accent hover:bg-ide-bg transition-colors"
          >
            <Home size={16} />
          </button>

          {isEditing ? (
            <form onSubmit={handleInputSubmit} className="flex-1 flex items-center gap-1">
              <input
                type="text"
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                autoFocus
                className="flex-1 px-2 py-1 bg-ide-bg border border-ide-accent rounded text-xs text-ide-text outline-none"
                placeholder={t("directoryPicker.enterPath")}
              />
              <button
                type="submit"
                className="p-1.5 rounded-md text-green-500 hover:bg-ide-bg transition-colors"
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setInputPath(currentPath);
                }}
                className="p-1.5 rounded-md text-red-500 hover:bg-ide-bg transition-colors"
              >
                <X size={16} />
              </button>
            </form>
          ) : (
            <div
              className="flex-1 flex items-center gap-0.5 overflow-x-auto no-scrollbar touch-pan-x"
              onClick={() => setIsEditing(true)}
            >
              {pathParts.length === 0 ? (
                <span className="px-2 py-1 text-xs text-ide-mute">/</span>
              ) : (
                pathParts.map((part, index) => (
                  <React.Fragment key={index}>
                    <ChevronRight size={14} className="shrink-0 text-ide-mute/50" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNavigate("/" + pathParts.slice(0, index + 1).join("/"));
                      }}
                      className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors truncate max-w-[100px] ${
                        index === pathParts.length - 1
                          ? "text-ide-accent bg-ide-accent/10"
                          : "text-ide-text hover:text-ide-accent hover:bg-ide-bg"
                      }`}
                    >
                      {part}
                    </button>
                  </React.Fragment>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-ide-mute">
              {t("common.loading")}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8 text-red-500 text-sm">
              {error}
            </div>
          ) : directories.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-ide-mute text-sm">
              {t("directoryPicker.noSubdirectories")}
            </div>
          ) : (
            <div className="space-y-1">
              {directories.map((dir) => (
                <button
                  key={dir.path}
                  onClick={() => handleNavigate(dir.path)}
                  className="w-full flex items-center gap-2 p-2 sm:p-3 rounded-lg hover:bg-ide-bg text-left group"
                >
                  <Folder size={18} className="text-ide-accent flex-shrink-0" />
                  <span className="text-ide-text truncate flex-1 text-sm">
                    {dir.name}
                  </span>
                  <ChevronRight
                    size={16}
                    className="text-ide-mute opacity-0 group-hover:opacity-100"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 sm:p-4 border-t border-ide-border">
          <div className="flex items-center gap-2 mb-3 p-2 bg-ide-bg rounded-lg">
            <FolderOpen size={18} className="text-ide-accent flex-shrink-0" />
            <span className="text-xs sm:text-sm text-ide-text truncate">{currentPath}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-lg border border-ide-border text-ide-text hover:bg-ide-bg text-sm"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSelect}
              className="flex-1 px-4 py-2.5 rounded-lg bg-ide-accent text-ide-bg font-medium hover:opacity-90 text-sm"
            >
              {t("common.select")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default DirectoryPicker;
