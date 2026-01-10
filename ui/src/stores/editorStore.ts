import { create } from 'zustand';
import type { EditorTab } from '@/types';

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  fileContents: Map<string, string>;

  setTabs: (tabs: EditorTab[]) => void;
  addTab: (tab: EditorTab) => void;
  removeTab: (id: string) => void;
  setActiveTabId: (id: string | null) => void;
  updateTab: (id: string, updates: Partial<EditorTab>) => void;
  setFileContent: (fileId: string, content: string) => void;
  getFileContent: (fileId: string) => string | undefined;
  markTabDirty: (id: string, dirty: boolean) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  fileContents: new Map(),

  setTabs: (tabs) => set({ tabs }),
  addTab: (tab) =>
    set((s) => {
      const exists = s.tabs.find((t) => t.id === tab.id);
      if (exists) return { activeTabId: tab.id };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),
  removeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id
          ? tabs.length > 0
            ? tabs[tabs.length - 1].id
            : null
          : s.activeTabId;
      return { tabs, activeTabId };
    }),
  setActiveTabId: (id) => set({ activeTabId: id }),
  updateTab: (id, updates) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  setFileContent: (fileId, content) =>
    set((s) => {
      const next = new Map(s.fileContents);
      next.set(fileId, content);
      return { fileContents: next };
    }),
  getFileContent: (fileId) => get().fileContents.get(fileId),
  markTabDirty: (id, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, isDirty: dirty } : t)),
    })),
}));
