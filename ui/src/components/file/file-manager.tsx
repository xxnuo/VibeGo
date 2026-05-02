import {
  AlertCircle,
  Archive,
  ChevronRight,
  Code,
  File,
  FileJson,
  FilePlus,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Image,
  Loader2,
  Music,
  Upload,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { fileApi } from "@/api/file";
import { useDialog } from "@/components/common";
import FileDetailSheet from "@/components/file/file-detail-sheet";
import FileManagerBreadcrumb from "@/components/file/file-manager-breadcrumb";
import FileManagerToolbar from "@/components/file/file-manager-toolbar";
import FileUploadPanel from "@/components/file/file-upload-panel";
import { useFrameController } from "@/framework/frame/controller";
import { getIntlLocale, type Locale, useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import {
  type FileItem,
  type FileManagerStoreApi,
  fileManagerStore,
  getOrCreateFileManagerStore,
} from "@/stores/file-manager-store";

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / k ** i).toFixed(1)) + " " + sizes[i];
}

function formatDate(dateStr: string, locale: Locale, t: (key: string) => string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) {
    return date.toLocaleTimeString(getIntlLocale(locale), { hour: "2-digit", minute: "2-digit" });
  } else if (days < 7) {
    return t("time.daysAgoShort").replace("{count}", String(days));
  }
  return date.toLocaleDateString(getIntlLocale(locale), { month: "short", day: "numeric" });
}

function getFileIcon(file: FileItem) {
  if (file.isDir) return <Folder size={20} className="text-ide-accent" />;
  const ext = file.extension?.toLowerCase();
  const iconClass = "text-ide-mute";
  switch (ext) {
    case ".jpg":
    case ".jpeg":
    case ".png":
    case ".gif":
    case ".svg":
    case ".webp":
      return <Image size={20} className={iconClass} />;
    case ".mp4":
    case ".mov":
    case ".avi":
    case ".mkv":
    case ".webm":
      return <Film size={20} className={iconClass} />;
    case ".mp3":
    case ".wav":
    case ".ogg":
    case ".flac":
      return <Music size={20} className={iconClass} />;
    case ".zip":
    case ".tar":
    case ".gz":
    case ".rar":
    case ".7z":
      return <Archive size={20} className={iconClass} />;
    case ".js":
    case ".ts":
    case ".jsx":
    case ".tsx":
    case ".go":
    case ".py":
    case ".rs":
      return <Code size={20} className={iconClass} />;
    case ".json":
    case ".yaml":
    case ".yml":
    case ".toml":
      return <FileJson size={20} className={iconClass} />;
    case ".md":
    case ".txt":
    case ".log":
      return <FileText size={20} className={iconClass} />;
    default:
      return <File size={20} className={iconClass} />;
  }
}

interface FileManagerProps {
  groupId?: string;
  initialPath?: string;
  onFileOpen?: (file: FileItem) => void;
  mode?: "default" | "directory-picker";
  store?: FileManagerStoreApi;
}

const FileManager: React.FC<FileManagerProps> = ({
  groupId,
  initialPath = ".",
  onFileOpen,
  mode = "default",
  store,
}) => {
  const storeApi = store ?? (groupId ? getOrCreateFileManagerStore(groupId) : fileManagerStore);
  const {
    currentPath,
    initialized,
    setFiles,
    goToPath,
    loading,
    setLoading,
    error,
    setError,
    getSortedFiles,
    selectedFiles,
    selectionMode,
    toggleSelectFile,
    clearSelection,
    focusIndex,
    setFocusIndex,
    detailFile,
    setDetailFile,
    viewMode,
  } = useStore(storeApi);

  const { setPageMenuItems } = useFrameController();
  const locale = (useSettingsStore((s) => s.settings.locale) || "zh") as Locale;
  const t = useTranslation(locale);
  const dialog = useDialog();
  const [uploadOpen, setUploadOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const skipLoadPathRef = useRef<string | null>(null);

  const loadFiles = useCallback(
    async (path: string, initialize = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fileApi.list(path);
        if (initialize && res.path) {
          skipLoadPathRef.current = res.path;
          storeApi.setState({
            currentPath: res.path,
            rootPath: res.path,
            pathHistory: [res.path],
            historyIndex: 0,
            initialized: true,
          });
        }
        const files: FileItem[] = (res.files ?? []).map((f) => ({
          path: f.path,
          name: f.name,
          size: f.size,
          isDir: f.isDir,
          isSymlink: f.isSymlink,
          isHidden: f.isHidden,
          mode: f.mode,
          mimeType: f.mimeType,
          modTime: f.modTime,
          extension: f.extension,
        }));
        setFiles(files);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("fileManager.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [setFiles, setLoading, setError, storeApi, t]
  );

  useEffect(() => {
    if (!initialized) {
      loadFiles(initialPath, true);
      return;
    }
    if (skipLoadPathRef.current === currentPath) {
      skipLoadPathRef.current = null;
      return;
    }
    loadFiles(currentPath);
  }, [currentPath, initialPath, initialized, loadFiles]);

  const handleShowNewFileDialog = useCallback(async () => {
    const name = await dialog.prompt(t("fileManager.newFile"), { placeholder: t("fileManager.enterName") });
    if (name?.trim()) {
      try {
        await fileApi.create({ path: `${currentPath}/${name}`, isDir: false });
        loadFiles(currentPath);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("fileManager.createFileFailed"));
      }
    }
  }, [dialog, t, currentPath, loadFiles, setError]);

  const handleShowNewFolderDialog = useCallback(async () => {
    const name = await dialog.prompt(t("fileManager.newFolder"), { placeholder: t("fileManager.enterName") });
    if (name?.trim()) {
      try {
        await fileApi.mkdir(`${currentPath}/${name}`);
        loadFiles(currentPath);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("fileManager.createFolderFailed"));
      }
    }
  }, [dialog, t, currentPath, loadFiles, setError]);

  const handleShowRenameDialog = useCallback(
    async (file: FileItem) => {
      const name = await dialog.prompt(t("common.rename"), {
        defaultValue: file.name,
        placeholder: t("fileManager.enterName"),
      });
      if (name?.trim() && name !== file.name) {
        const dir = file.path.substring(0, file.path.lastIndexOf("/"));
        const newPath = `${dir}/${name}`;
        try {
          await fileApi.rename(file.path, newPath);
          setDetailFile(null);
          loadFiles(currentPath);
        } catch (e) {
          setError(e instanceof Error ? e.message : t("fileManager.renameFailed"));
        }
      }
    },
    [dialog, t, currentPath, loadFiles, setError, setDetailFile]
  );

  useEffect(() => {
    if (mode !== "default") {
      setPageMenuItems([]);
      return;
    }
    setPageMenuItems([
      {
        id: "upload",
        icon: <Upload size={20} />,
        label: t("fileManager.upload"),
        onClick: () => setUploadOpen(true),
      },
      {
        id: "new-file",
        icon: <FilePlus size={20} />,
        label: t("fileManager.newFile"),
        onClick: handleShowNewFileDialog,
      },
      {
        id: "new-folder",
        icon: <FolderPlus size={20} />,
        label: t("fileManager.newFolder"),
        onClick: handleShowNewFolderDialog,
      },
    ]);
    return () => setPageMenuItems([]);
  }, [mode, t, setPageMenuItems, handleShowNewFileDialog, handleShowNewFolderDialog]);

  const sortedFiles = getSortedFiles();
  const visibleFiles = mode === "directory-picker" ? sortedFiles.filter((file) => file.isDir) : sortedFiles;

  const handleFileClick = (file: FileItem) => {
    if (mode === "directory-picker") {
      if (file.isDir) {
        goToPath(file.path);
      }
      return;
    }
    if (selectionMode) {
      toggleSelectFile(file.path);
    } else if (file.isDir) {
      goToPath(file.path);
    } else {
      onFileOpen?.(file);
    }
  };

  const handleFileLongPress = (file: FileItem) => {
    if (mode !== "default") return;
    setDetailFile(file);
  };

  const handleRefresh = () => loadFiles(currentPath);

  const handleDelete = async (file: FileItem) => {
    const confirmed = await dialog.confirm(t("dialog.deleteFile").replace("{name}", file.name), undefined, {
      confirmVariant: "danger",
      confirmText: t("common.delete"),
    });
    if (!confirmed) return;
    try {
      await fileApi.delete(file.path);
      setDetailFile(null);
      loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.deleteFailed"));
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedFiles.size === 0) return;
    const confirmed = await dialog.confirm(
      t("dialog.deleteItems").replace("{count}", String(selectedFiles.size)),
      undefined,
      { confirmVariant: "danger", confirmText: t("common.delete") }
    );
    if (!confirmed) return;
    try {
      await fileApi.batchDelete(Array.from(selectedFiles));
      clearSelection();
      loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.deleteFailed"));
    }
  };

  useEffect(() => {
    if (focusIndex > Math.max(visibleFiles.length - 1, 0)) {
      setFocusIndex(Math.max(visibleFiles.length - 1, 0));
    }
  }, [focusIndex, visibleFiles.length, setFocusIndex]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setFocusIndex(Math.max(0, focusIndex - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setFocusIndex(Math.max(0, Math.min(visibleFiles.length - 1, focusIndex + 1)));
          break;
        case "Enter":
          e.preventDefault();
          if (visibleFiles[focusIndex]) handleFileClick(visibleFiles[focusIndex]);
          break;
        case "Backspace":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            storeApi.getState().goParent();
          }
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusIndex, handleFileClick, setFocusIndex, storeApi, visibleFiles]);

  return (
    <div className="h-full flex flex-col bg-ide-bg">
      <FileManagerBreadcrumb store={storeApi} />
      <FileManagerToolbar
        onRefresh={handleRefresh}
        onNewFile={handleShowNewFileDialog}
        onNewFolder={handleShowNewFolderDialog}
        onUpload={() => setUploadOpen(true)}
        onDeleteSelected={handleDeleteSelected}
        mode={mode}
        store={storeApi}
      />

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 text-red-500 text-xs">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-ide-accent" />
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-ide-mute">
            <Folder size={32} className="mb-2 opacity-50" />
            <span className="text-xs">
              {mode === "directory-picker" ? t("directoryPicker.noSubdirectories") : t("fileManager.emptyFolder")}
            </span>
          </div>
        ) : viewMode === "list" ? (
          <div className="divide-y divide-ide-border">
            {visibleFiles.map((file, index) => (
              <FileListItem
                key={file.path}
                file={file}
                dateText={formatDate(file.modTime, locale, t)}
                selected={selectedFiles.has(file.path)}
                focused={focusIndex === index}
                selectionMode={selectionMode}
                onClick={() => handleFileClick(file)}
                onLongPress={() => handleFileLongPress(file)}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 p-2">
            {visibleFiles.map((file, index) => (
              <FileGridItem
                key={file.path}
                file={file}
                selected={selectedFiles.has(file.path)}
                focused={focusIndex === index}
                selectionMode={selectionMode}
                onClick={() => handleFileClick(file)}
                onLongPress={() => handleFileLongPress(file)}
              />
            ))}
          </div>
        )}
      </div>

      {mode === "default" && (
        <>
          <FileUploadPanel
            open={uploadOpen}
            currentPath={currentPath}
            onOpenChange={setUploadOpen}
            onUploaded={handleRefresh}
          />
          <FileDetailSheet
            file={detailFile}
            open={!!detailFile}
            onClose={() => setDetailFile(null)}
            onDelete={handleDelete}
            onRename={handleShowRenameDialog}
          />
        </>
      )}
    </div>
  );
};

interface FileItemProps {
  file: FileItem;
  dateText?: string;
  selected: boolean;
  focused: boolean;
  selectionMode: boolean;
  onClick: () => void;
  onLongPress: () => void;
}

const FileListItem: React.FC<FileItemProps> = ({
  file,
  dateText,
  selected,
  focused,
  selectionMode,
  onClick,
  onLongPress,
}) => {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);

  const handleTouchStart = () => {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      longPressTimer.current = null;
      onLongPress();
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  return (
    <button
      type="button"
      onClick={() => {
        if (longPressTriggered.current) {
          longPressTriggered.current = false;
          return;
        }
        onClick();
      }}
      onTouchStart={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        handleTouchStart();
      }}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={(e) => {
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        onLongPress();
      }}
      className={`flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
        focused ? "bg-ide-accent/10" : ""
      } ${selected ? "bg-ide-accent/20" : "hover:bg-ide-panel"}`}
    >
      {selectionMode && (
        <div
          className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
            selected ? "bg-ide-accent border-ide-accent" : "border-ide-mute"
          }`}
        >
          {selected && <ChevronRight size={14} className="text-ide-bg" />}
        </div>
      )}
      {getFileIcon(file)}
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${file.isHidden ? "text-ide-mute" : "text-ide-text"}`}>{file.name}</div>
      </div>
      <div className="text-[10px] text-ide-mute shrink-0">{file.isDir ? "--" : formatFileSize(file.size)}</div>
      <div className="w-14 shrink-0 truncate text-right text-[10px] text-ide-mute tabular-nums">{dateText}</div>
      {file.isDir && <ChevronRight size={18} className="text-ide-mute shrink-0" />}
    </button>
  );
};

const FileGridItem: React.FC<FileItemProps> = ({ file, selected, focused, selectionMode, onClick, onLongPress }) => {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);

  const handleTouchStart = () => {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      longPressTimer.current = null;
      onLongPress();
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  return (
    <button
      type="button"
      onClick={() => {
        if (longPressTriggered.current) {
          longPressTriggered.current = false;
          return;
        }
        onClick();
      }}
      onTouchStart={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        handleTouchStart();
      }}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={(e) => {
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        onLongPress();
      }}
      className={`relative flex min-h-20 min-w-0 flex-col items-center gap-1 rounded-lg p-3 transition-colors ${
        focused ? "bg-ide-accent/10" : ""
      } ${selected ? "bg-ide-accent/20" : "hover:bg-ide-panel"}`}
    >
      {selectionMode && (
        <div
          className={`absolute top-1 right-1 w-4 h-4 rounded border-2 flex items-center justify-center ${
            selected ? "bg-ide-accent border-ide-accent" : "border-ide-mute"
          }`}
        />
      )}
      <div className="w-10 h-10 flex items-center justify-center">{getFileIcon(file)}</div>
      <div className={`text-[11px] text-center truncate w-full ${file.isHidden ? "text-ide-mute" : "text-ide-text"}`}>
        {file.name}
      </div>
    </button>
  );
};

export default FileManager;
