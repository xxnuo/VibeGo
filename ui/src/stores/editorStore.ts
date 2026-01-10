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
  openFileTab: (fileId: string, title: string, type?: 'code' | 'diff', data?: EditorTab['data']) => void;
  closeTab: (id: string) => void;
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
  openFileTab: (fileId, title, type = 'code', data) => {
    const { tabs, addTab } = get();
    const tabId = type === 'diff' ? `diff-${fileId}` : `tab-${fileId}`;
    const exists = tabs.find((t) => t.id === tabId);
    if (exists) {
      set({ activeTabId: tabId });
      return;
    }
    addTab({
      id: tabId,
      fileId,
      title: type === 'diff' ? `${title} [DIFF]` : title,
      isDirty: false,
      type,
      data,
    });
  },
  closeTab: (id) => {
    const { tabs } = get();
    const newTabs = tabs.filter((t) => t.id !== id);
    const currentActive = get().activeTabId;
    let newActive = currentActive;
    if (currentActive === id) {
      newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
    }
    set({ tabs: newTabs, activeTabId: newActive });
  },
}));
