import React, { useEffect, useCallback, useState, useRef } from 'react';
import {
  File, Folder, ChevronRight, FileText, Image, Film, Music, Archive, Code, FileJson,
  AlertCircle, Loader2
} from 'lucide-react';
import { useFileManagerStore, type FileItem } from '@/stores/fileManagerStore';
import { fileApi } from '@/api/file';
import FileManagerBreadcrumb from './FileManagerBreadcrumb';
import FileManagerToolbar from './FileManagerToolbar';
import FileDetailSheet from './FileDetailSheet';

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (days < 7) {
    return `${days}d ago`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getFileIcon(file: FileItem) {
  if (file.isDir) return <Folder size={20} className="text-ide-accent" />;
  const ext = file.extension?.toLowerCase();
  const iconClass = "text-ide-mute";
  switch (ext) {
    case '.jpg': case '.jpeg': case '.png': case '.gif': case '.svg': case '.webp':
      return <Image size={20} className={iconClass} />;
    case '.mp4': case '.mov': case '.avi': case '.mkv': case '.webm':
      return <Film size={20} className={iconClass} />;
    case '.mp3': case '.wav': case '.ogg': case '.flac':
      return <Music size={20} className={iconClass} />;
    case '.zip': case '.tar': case '.gz': case '.rar': case '.7z':
      return <Archive size={20} className={iconClass} />;
    case '.js': case '.ts': case '.jsx': case '.tsx': case '.go': case '.py': case '.rs':
      return <Code size={20} className={iconClass} />;
    case '.json': case '.yaml': case '.yml': case '.toml':
      return <FileJson size={20} className={iconClass} />;
    case '.md': case '.txt': case '.log':
      return <FileText size={20} className={iconClass} />;
    default:
      return <File size={20} className={iconClass} />;
  }
}

interface FileManagerProps {
  initialPath?: string;
  onFileOpen?: (file: FileItem) => void;
}

const FileManager: React.FC<FileManagerProps> = ({ initialPath = '.', onFileOpen }) => {
  const {
    currentPath,
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
  } = useFileManagerStore();

  const [showNewDialog, setShowNewDialog] = useState<'file' | 'folder' | null>(null);
  const [newName, setNewName] = useState('');
  const [renameFile, setRenameFile] = useState<FileItem | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadFiles = useCallback(async (path: string, initialize = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fileApi.list(path);
      if (initialize && res.path) {
        useFileManagerStore.getState().setCurrentPath(res.path);
        useFileManagerStore.getState().setRootPath(res.path);
        useFileManagerStore.setState({
          pathHistory: [res.path],
          historyIndex: 0,
          initialized: true,
        });
      }
      const files: FileItem[] = res.files.map((f) => ({
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
      setError(e instanceof Error ? e.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [setFiles, setLoading, setError]);

  useEffect(() => {
    const { initialized } = useFileManagerStore.getState();
    if (!initialized) {
      loadFiles(initialPath, true);
    }
  }, []);

  useEffect(() => {
    loadFiles(currentPath);
  }, [currentPath, loadFiles]);

  const sortedFiles = getSortedFiles();

  const handleFileClick = (file: FileItem) => {
    if (selectionMode) {
      toggleSelectFile(file.path);
    } else if (file.isDir) {
      goToPath(file.path);
    } else {
      onFileOpen?.(file);
    }
  };

  const handleFileLongPress = (file: FileItem) => {
    setDetailFile(file);
  };

  const handleRefresh = () => loadFiles(currentPath);

  const handleNewFile = async () => {
    if (!newName.trim()) return;
    try {
      await fileApi.create({ path: `${currentPath}/${newName}`, isDir: false });
      setShowNewDialog(null);
      setNewName('');
      loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create file');
    }
  };

  const handleNewFolder = async () => {
    if (!newName.trim()) return;
    try {
      await fileApi.mkdir(`${currentPath}/${newName}`);
      setShowNewDialog(null);
      setNewName('');
      loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create folder');
    }
  };

  const handleDelete = async (file: FileItem) => {
    if (!confirm(`Delete "${file.name}"?`)) return;
    try {
      await fileApi.delete(file.path);
      setDetailFile(null);
      loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedFiles.size === 0) return;
    if (!confirm(`Delete ${selectedFiles.size} items?`)) return;
    try {
      await fileApi.batchDelete(Array.from(selectedFiles));
      clearSelection();
      loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const handleRename = async () => {
    if (!renameFile || !newName.trim()) return;
    const dir = renameFile.path.substring(0, renameFile.path.lastIndexOf('/'));
    const newPath = `${dir}/${newName}`;
    try {
      await fileApi.rename(renameFile.path, newPath);
      setRenameFile(null);
      setNewName('');
      setDetailFile(null);
      loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename');
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showNewDialog || renameFile) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setFocusIndex(Math.max(0, focusIndex - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setFocusIndex(Math.min(sortedFiles.length - 1, focusIndex + 1));
          break;
        case 'Enter':
          e.preventDefault();
          if (sortedFiles[focusIndex]) handleFileClick(sortedFiles[focusIndex]);
          break;
        case 'Backspace':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            useFileManagerStore.getState().goParent();
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusIndex, sortedFiles, showNewDialog, renameFile]);

  return (
    <div className="h-full flex flex-col bg-ide-bg">
      <FileManagerBreadcrumb />
      <FileManagerToolbar
        onRefresh={handleRefresh}
        onNewFile={() => { setShowNewDialog('file'); setNewName(''); }}
        onNewFolder={() => { setShowNewDialog('folder'); setNewName(''); }}
        onDeleteSelected={handleDeleteSelected}
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
        ) : sortedFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-ide-mute">
            <Folder size={32} className="mb-2 opacity-50" />
            <span className="text-xs">Empty folder</span>
          </div>
        ) : viewMode === 'list' ? (
          <div className="divide-y divide-ide-border">
            {sortedFiles.map((file, index) => (
              <FileListItem
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
        ) : (
          <div className="grid grid-cols-3 gap-2 p-2">
            {sortedFiles.map((file, index) => (
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

      <FileDetailSheet
        file={detailFile}
        open={!!detailFile}
        onClose={() => setDetailFile(null)}
        onDelete={handleDelete}
        onRename={(f) => { setRenameFile(f); setNewName(f.name); setDetailFile(null); }}
      />

      {(showNewDialog || renameFile) && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
          <div className="w-full max-w-md bg-ide-panel rounded-t-xl p-4">
            <h3 className="text-sm font-medium text-ide-text mb-3">
              {renameFile ? 'Rename' : showNewDialog === 'file' ? 'New File' : 'New Folder'}
            </h3>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Enter name..."
              className="w-full px-3 py-2 bg-ide-bg border border-ide-border rounded-md text-sm text-ide-text mb-3"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowNewDialog(null); setRenameFile(null); setNewName(''); }}
                className="flex-1 py-2 rounded-md bg-ide-bg text-ide-mute text-sm"
              >
                Cancel
              </button>
              <button
                onClick={renameFile ? handleRename : showNewDialog === 'file' ? handleNewFile : handleNewFolder}
                className="flex-1 py-2 rounded-md bg-ide-accent text-ide-bg text-sm font-medium"
              >
                {renameFile ? 'Rename' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface FileItemProps {
  file: FileItem;
  selected: boolean;
  focused: boolean;
  selectionMode: boolean;
  onClick: () => void;
  onLongPress: () => void;
}

const FileListItem: React.FC<FileItemProps> = ({
  file, selected, focused, selectionMode, onClick, onLongPress
}) => {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => onLongPress(), 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  return (
    <div
      onClick={onClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
      onContextMenu={(e) => { e.preventDefault(); onLongPress(); }}
      className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
        focused ? 'bg-ide-accent/10' : ''
      } ${selected ? 'bg-ide-accent/20' : 'hover:bg-ide-panel'}`}
    >
      {selectionMode && (
        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
          selected ? 'bg-ide-accent border-ide-accent' : 'border-ide-mute'
        }`}>
          {selected && <ChevronRight size={14} className="text-ide-bg" />}
        </div>
      )}
      {getFileIcon(file)}
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${file.isHidden ? 'text-ide-mute' : 'text-ide-text'}`}>
          {file.name}
        </div>
      </div>
      <div className="text-[10px] text-ide-mute shrink-0">
        {file.isDir ? '--' : formatFileSize(file.size)}
      </div>
      <div className="text-[10px] text-ide-mute shrink-0 w-12 text-right">
        {formatDate(file.modTime)}
      </div>
      {file.isDir && <ChevronRight size={16} className="text-ide-mute shrink-0" />}
    </div>
  );
};

const FileGridItem: React.FC<FileItemProps> = ({
  file, selected, focused, selectionMode, onClick, onLongPress
}) => {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => onLongPress(), 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  return (
    <div
      onClick={onClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
      onContextMenu={(e) => { e.preventDefault(); onLongPress(); }}
      className={`flex flex-col items-center gap-1 p-3 rounded-lg cursor-pointer transition-colors ${
        focused ? 'bg-ide-accent/10' : ''
      } ${selected ? 'bg-ide-accent/20' : 'hover:bg-ide-panel'}`}
    >
      {selectionMode && (
        <div className={`absolute top-1 right-1 w-4 h-4 rounded border-2 flex items-center justify-center ${
          selected ? 'bg-ide-accent border-ide-accent' : 'border-ide-mute'
        }`} />
      )}
      <div className="w-10 h-10 flex items-center justify-center">
        {getFileIcon(file)}
      </div>
      <div className={`text-[11px] text-center truncate w-full ${file.isHidden ? 'text-ide-mute' : 'text-ide-text'}`}>
        {file.name}
      </div>
    </div>
  );
};

export default FileManager;
