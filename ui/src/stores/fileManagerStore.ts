import { create } from 'zustand';

export interface FileItem {
  path: string;
  name: string;
  size: number;
  isDir: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  mode: string;
  mimeType?: string;
  modTime: string;
  extension: string;
}

export type SortField = 'name' | 'size' | 'modTime' | 'type';
export type SortOrder = 'asc' | 'desc';
export type ViewMode = 'list' | 'grid';

interface FileManagerState {
  currentPath: string;
  pathHistory: string[];
  historyIndex: number;
  files: FileItem[];
  selectedFiles: Set<string>;
  focusIndex: number;
  searchQuery: string;
  searchActive: boolean;
  sortField: SortField;
  sortOrder: SortOrder;
  showHidden: boolean;
  viewMode: ViewMode;
  selectionMode: boolean;
  loading: boolean;
  error: string | null;
  detailFile: FileItem | null;

  setCurrentPath: (path: string) => void;
  goToPath: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
  goParent: () => void;
  setFiles: (files: FileItem[]) => void;
  toggleSelectFile: (path: string) => void;
  selectFile: (path: string) => void;
  clearSelection: () => void;
  selectAll: () => void;
  setFocusIndex: (index: number) => void;
  setSearchQuery: (query: string) => void;
  setSearchActive: (active: boolean) => void;
  setSortField: (field: SortField) => void;
  setSortOrder: (order: SortOrder) => void;
  toggleSort: (field: SortField) => void;
  setShowHidden: (show: boolean) => void;
  toggleShowHidden: () => void;
  setViewMode: (mode: ViewMode) => void;
  setSelectionMode: (mode: boolean) => void;
  toggleSelectionMode: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setDetailFile: (file: FileItem | null) => void;
  getFilteredFiles: () => FileItem[];
  getSortedFiles: () => FileItem[];
}

export const useFileManagerStore = create<FileManagerState>((set, get) => ({
  currentPath: '.',
  pathHistory: ['.'],
  historyIndex: 0,
  files: [],
  selectedFiles: new Set<string>(),
  focusIndex: 0,
  searchQuery: '',
  searchActive: false,
  sortField: 'name',
  sortOrder: 'asc',
  showHidden: false,
  viewMode: 'list',
  selectionMode: false,
  loading: false,
  error: null,
  detailFile: null,

  setCurrentPath: (path) => set({ currentPath: path }),

  goToPath: (path) => {
    const { pathHistory, historyIndex } = get();
    const newHistory = pathHistory.slice(0, historyIndex + 1);
    newHistory.push(path);
    set({
      currentPath: path,
      pathHistory: newHistory,
      historyIndex: newHistory.length - 1,
      focusIndex: 0,
      searchQuery: '',
      searchActive: false,
    });
  },

  goBack: () => {
    const { pathHistory, historyIndex } = get();
    if (historyIndex > 0) {
      set({
        currentPath: pathHistory[historyIndex - 1],
        historyIndex: historyIndex - 1,
        focusIndex: 0,
      });
    }
  },

  goForward: () => {
    const { pathHistory, historyIndex } = get();
    if (historyIndex < pathHistory.length - 1) {
      set({
        currentPath: pathHistory[historyIndex + 1],
        historyIndex: historyIndex + 1,
        focusIndex: 0,
      });
    }
  },

  goParent: () => {
    const { currentPath, goToPath } = get();
    if (currentPath === '/' || currentPath === '.') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const parent = parts.length === 0 ? '/' : '/' + parts.join('/');
    goToPath(parent);
  },

  setFiles: (files) => set({ files }),

  toggleSelectFile: (path) => {
    const { selectedFiles } = get();
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
    }
    set({ selectedFiles: newSelected });
  },

  selectFile: (path) => {
    set({ selectedFiles: new Set([path]) });
  },

  clearSelection: () => set({ selectedFiles: new Set(), selectionMode: false }),

  selectAll: () => {
    const files = get().getSortedFiles();
    set({ selectedFiles: new Set(files.map((f) => f.path)) });
  },

  setFocusIndex: (index) => set({ focusIndex: index }),

  setSearchQuery: (query) => set({ searchQuery: query, focusIndex: 0 }),

  setSearchActive: (active) => set({ searchActive: active }),

  setSortField: (field) => set({ sortField: field }),

  setSortOrder: (order) => set({ sortOrder: order }),

  toggleSort: (field) => {
    const { sortField, sortOrder } = get();
    if (sortField === field) {
      set({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      set({ sortField: field, sortOrder: 'asc' });
    }
  },

  setShowHidden: (show) => set({ showHidden: show }),

  toggleShowHidden: () => set((s) => ({ showHidden: !s.showHidden })),

  setViewMode: (mode) => set({ viewMode: mode }),

  setSelectionMode: (mode) => set({ selectionMode: mode }),

  toggleSelectionMode: () => {
    const { selectionMode } = get();
    if (selectionMode) {
      set({ selectionMode: false, selectedFiles: new Set() });
    } else {
      set({ selectionMode: true });
    }
  },

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  setDetailFile: (file) => set({ detailFile: file }),

  getFilteredFiles: () => {
    const { files, showHidden, searchQuery } = get();
    return files.filter((f) => {
      if (!showHidden && f.isHidden) return false;
      if (searchQuery && !f.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  },

  getSortedFiles: () => {
    const { sortField, sortOrder } = get();
    const filtered = get().getFilteredFiles();

    return [...filtered].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;

      let cmp = 0;
      switch (sortField) {
        case 'name':
          cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'modTime':
          cmp = new Date(a.modTime).getTime() - new Date(b.modTime).getTime();
          break;
        case 'type':
          cmp = (a.extension || '').localeCompare(b.extension || '');
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  },
}));
