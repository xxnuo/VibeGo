import { create } from 'zustand';
import type { FileNode } from '@/types';

interface FileState {
  fileTree: FileNode[];
  currentPath: string;
  selectedFileId: string | null;
  expandedFolders: Set<string>;

  setFileTree: (tree: FileNode[]) => void;
  setCurrentPath: (path: string) => void;
  setSelectedFileId: (id: string | null) => void;
  toggleFolder: (id: string) => void;
  expandFolder: (id: string) => void;
  collapseFolder: (id: string) => void;
}

export const useFileStore = create<FileState>((set) => ({
  fileTree: [],
  currentPath: '.',
  selectedFileId: null,
  expandedFolders: new Set<string>(),

  setFileTree: (tree) => set({ fileTree: tree }),
  setCurrentPath: (path) => set({ currentPath: path }),
  setSelectedFileId: (id) => set({ selectedFileId: id }),
  toggleFolder: (id) =>
    set((s) => {
      const next = new Set(s.expandedFolders);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedFolders: next };
    }),
  expandFolder: (id) =>
    set((s) => {
      const next = new Set(s.expandedFolders);
      next.add(id);
      return { expandedFolders: next };
    }),
  collapseFolder: (id) =>
    set((s) => {
      const next = new Set(s.expandedFolders);
      next.delete(id);
      return { expandedFolders: next };
    }),
}));
