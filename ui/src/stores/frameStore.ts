import { create } from 'zustand';

export type GroupType = 'workspace' | 'terminal' | 'plugin';

export type ViewType = 'files' | 'git' | 'terminal';

export interface TabItem {
  id: string;
  title: string;
  icon?: string;
  data?: Record<string, unknown>;
  closable?: boolean;
}

const EMPTY_TABS: TabItem[] = [];

export interface WorkspaceGroup {
  type: 'workspace';
  id: string;
  name: string;
  path: string;
  activeView: ViewType;
  views: {
    files: { tabs: TabItem[]; activeTabId: string | null };
    git: { tabs: TabItem[]; activeTabId: string | null };
    terminal: { tabs: TabItem[]; activeTabId: string | null };
  };
}

export interface TerminalGroup {
  type: 'terminal';
  id: string;
  name: string;
  tabs: TabItem[];
  activeTabId: string | null;
}

export interface PluginGroup {
  type: 'plugin';
  id: string;
  name: string;
  pluginId: string;
  tabs: TabItem[];
  activeTabId: string | null;
}

export type PageGroup = WorkspaceGroup | TerminalGroup | PluginGroup;

interface FrameState {
  groups: PageGroup[];
  activeGroupId: string | null;

  initDefaultGroups: () => void;
  addWorkspaceGroup: (path: string, name?: string) => void;
  addTerminalGroup: (name?: string) => void;
  addPluginGroup: (pluginId: string, name?: string) => void;
  removeGroup: (id: string) => void;
  setActiveGroup: (id: string) => void;
  getActiveGroup: () => PageGroup | undefined;

  setWorkspaceView: (groupId: string, view: ViewType) => void;
  getCurrentView: () => ViewType | null;
  setCurrentView: (view: ViewType) => void;

  addTab: (groupId: string, tab: TabItem, view?: ViewType) => void;
  removeTab: (groupId: string, tabId: string, view?: ViewType) => void;
  setActiveTab: (groupId: string, tabId: string | null, view?: ViewType) => void;

  getCurrentTabs: () => TabItem[];
  getCurrentActiveTabId: () => string | null;
  setCurrentActiveTab: (tabId: string | null) => void;
  addCurrentTab: (tab: TabItem) => void;
  removeCurrentTab: (tabId: string) => void;
}

const createDefaultWorkspace = (path: string, name?: string): WorkspaceGroup => ({
  type: 'workspace',
  id: `workspace-${Date.now()}`,
  name: name || path.split('/').pop() || 'Workspace',
  path,
  activeView: 'files',
  views: {
    files: { tabs: [], activeTabId: null },
    git: { tabs: [], activeTabId: null },
    terminal: { tabs: [], activeTabId: null },
  },
});

const createTerminalGroup = (name?: string): TerminalGroup => ({
  type: 'terminal',
  id: `terminal-${Date.now()}`,
  name: name || 'Terminal',
  tabs: [],
  activeTabId: null,
});

const createPluginGroup = (pluginId: string, name?: string): PluginGroup => ({
  type: 'plugin',
  id: `plugin-${Date.now()}`,
  name: name || pluginId,
  pluginId,
  tabs: [],
  activeTabId: null,
});

const getGroupTabs = (group: PageGroup, view?: ViewType): TabItem[] => {
  if (group.type === 'workspace') {
    const v = view || group.activeView;
    return group.views[v].tabs;
  }
  return group.tabs;
};

const getGroupActiveTabId = (group: PageGroup, view?: ViewType): string | null => {
  if (group.type === 'workspace') {
    const v = view || group.activeView;
    return group.views[v].activeTabId;
  }
  return group.activeTabId;
};

export const useFrameStore = create<FrameState>((set, get) => ({
  groups: [],
  activeGroupId: null,

  initDefaultGroups: () => {
    const { groups } = get();
    if (groups.length === 0) {
      const defaultWorkspace = createDefaultWorkspace('.', 'Project');
      defaultWorkspace.id = 'default-workspace';
      set({ groups: [defaultWorkspace], activeGroupId: 'default-workspace' });
    }
  },

  addWorkspaceGroup: (path, name) => {
    const group = createDefaultWorkspace(path, name);
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
  },

  addTerminalGroup: (name) => {
    const group = createTerminalGroup(name);
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
  },

  addPluginGroup: (pluginId, name) => {
    const group = createPluginGroup(pluginId, name);
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
  },

  removeGroup: (id) =>
    set((s) => {
      const groups = s.groups.filter((g) => g.id !== id);
      const activeGroupId =
        s.activeGroupId === id
          ? groups.length > 0 ? groups[0].id : null
          : s.activeGroupId;
      return { groups, activeGroupId };
    }),

  setActiveGroup: (id) => set({ activeGroupId: id }),

  getActiveGroup: () => {
    const { groups, activeGroupId } = get();
    return groups.find((g) => g.id === activeGroupId);
  },

  setWorkspaceView: (groupId, view) =>
    set((s) => ({
      groups: s.groups.map((g) =>
        g.type === 'workspace' && g.id === groupId ? { ...g, activeView: view } : g
      ),
    })),

  getCurrentView: () => {
    const group = get().getActiveGroup();
    if (!group) return null;
    if (group.type === 'workspace') return group.activeView;
    if (group.type === 'terminal') return 'terminal';
    return null;
  },

  setCurrentView: (view) => {
    const { activeGroupId, setWorkspaceView, getActiveGroup } = get();
    const group = getActiveGroup();
    if (group?.type === 'workspace' && activeGroupId) {
      setWorkspaceView(activeGroupId, view);
    }
  },

  addTab: (groupId, tab, view) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === 'workspace') {
          const v = view || g.activeView;
          const viewData = g.views[v];
          const exists = viewData.tabs.find((t) => t.id === tab.id);
          if (exists) {
            return { ...g, views: { ...g.views, [v]: { ...viewData, activeTabId: tab.id } } };
          }
          return {
            ...g,
            views: {
              ...g.views,
              [v]: { tabs: [...viewData.tabs, tab], activeTabId: tab.id },
            },
          };
        }
        const exists = g.tabs.find((t) => t.id === tab.id);
        if (exists) return { ...g, activeTabId: tab.id };
        return { ...g, tabs: [...g.tabs, tab], activeTabId: tab.id };
      }),
    })),

  removeTab: (groupId, tabId, view) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === 'workspace') {
          const v = view || g.activeView;
          const viewData = g.views[v];
          const tabs = viewData.tabs.filter((t) => t.id !== tabId);
          const activeTabId = viewData.activeTabId === tabId
            ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
            : viewData.activeTabId;
          return { ...g, views: { ...g.views, [v]: { tabs, activeTabId } } };
        }
        const tabs = g.tabs.filter((t) => t.id !== tabId);
        const activeTabId = g.activeTabId === tabId
          ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
          : g.activeTabId;
        return { ...g, tabs, activeTabId };
      }),
    })),

  setActiveTab: (groupId, tabId, view) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === 'workspace') {
          const v = view || g.activeView;
          return { ...g, views: { ...g.views, [v]: { ...g.views[v], activeTabId: tabId } } };
        }
        return { ...g, activeTabId: tabId };
      }),
    })),

  getCurrentTabs: () => {
    const group = get().getActiveGroup();
    if (!group) return EMPTY_TABS;
    return getGroupTabs(group);
  },

  getCurrentActiveTabId: () => {
    const group = get().getActiveGroup();
    if (!group) return null;
    return getGroupActiveTabId(group);
  },

  setCurrentActiveTab: (tabId) => {
    const { activeGroupId, setActiveTab } = get();
    if (activeGroupId) setActiveTab(activeGroupId, tabId);
  },

  addCurrentTab: (tab) => {
    const { activeGroupId, addTab } = get();
    if (activeGroupId) addTab(activeGroupId, tab);
  },

  removeCurrentTab: (tabId) => {
    const { activeGroupId, removeTab } = get();
    if (activeGroupId) removeTab(activeGroupId, tabId);
  },
}));
