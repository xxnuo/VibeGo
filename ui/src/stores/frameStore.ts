import { create } from "zustand";
import type { ReactNode } from "react";

export type GroupType = "home" | "workspace" | "terminal" | "plugin" | "settings";

export type ViewType = "files" | "git" | "terminal";

export interface TopBarButton {
  icon: ReactNode;
  label?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface TopBarConfig {
  leftButtons?: TopBarButton[];
  centerContent?: string | ReactNode;
  rightButtons?: TopBarButton[];
  show?: boolean;
}

export interface BottomBarButton {
  icon: ReactNode;
  label?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface BottomMenuItem {
  id: string;
  icon: ReactNode;
  label: string;
  badge?: string | number;
  onClick?: () => void;
}

export interface BottomBarConfig {
  customItems?: BottomMenuItem[];
  activeItemId?: string;
  rightButtons?: BottomBarButton[];
  show?: boolean;
}

export type { PageFrameConfig, PageMenuConfig, PluginContext } from "@/plugins/registry";

export interface TabItem {
  id: string;
  title: string;
  icon?: string;
  data?: Record<string, unknown>;
  closable?: boolean;
  pinned?: boolean;
}

const EMPTY_TABS: TabItem[] = [];

export interface WorkspaceGroup {
  type: "workspace";
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
  type: "terminal";
  id: string;
  name: string;
  tabs: TabItem[];
  activeTabId: string | null;
}

export interface PluginGroup {
  type: "plugin";
  id: string;
  name: string;
  pluginId: string;
  tabs: TabItem[];
  activeTabId: string | null;
}

export interface SettingsGroup {
  type: "settings";
  id: string;
  name: string;
}

export interface HomeGroup {
  type: "home";
  id: string;
  name: string;
}

export type PageGroup =
  | HomeGroup
  | WorkspaceGroup
  | TerminalGroup
  | PluginGroup
  | SettingsGroup;

interface FrameState {
  groups: PageGroup[];
  activeGroupId: string | null;
  topBarConfig: TopBarConfig;
  bottomBarConfig: BottomBarConfig;
  pageMenuItems: import("@/plugins/registry").PageMenuConfig[];

  setTopBarConfig: (config: TopBarConfig) => void;
  setBottomBarConfig: (config: BottomBarConfig) => void;
  setPageMenuItems: (items: import("@/plugins/registry").PageMenuConfig[]) => void;
  initDefaultGroups: () => void;
  showHomePage: () => void;
  addWorkspaceGroup: (path: string, name?: string, id?: string) => string;
  addTerminalGroup: (name?: string) => void;
  addPluginGroup: (pluginId: string, name?: string) => void;
  addSettingsGroup: () => void;
  removeGroup: (id: string) => void;
  setActiveGroup: (id: string) => void;
  getActiveGroup: () => PageGroup | undefined;

  setWorkspaceView: (groupId: string, view: ViewType) => void;
  getCurrentView: () => ViewType | null;
  setCurrentView: (view: ViewType) => void;

  addTab: (groupId: string, tab: TabItem, view?: ViewType) => void;
  removeTab: (groupId: string, tabId: string, view?: ViewType) => void;
  setActiveTab: (
    groupId: string,
    tabId: string | null,
    view?: ViewType,
  ) => void;

  getCurrentTabs: () => TabItem[];
  getCurrentActiveTabId: () => string | null;
  setCurrentActiveTab: (tabId: string | null) => void;
  addCurrentTab: (tab: TabItem) => void;
  removeCurrentTab: (tabId: string) => void;

  pinTab: (tabId: string) => void;
  openPreviewTab: (tab: TabItem) => void;
}

const createDefaultWorkspace = (
  path: string,
  name?: string,
): WorkspaceGroup => ({
  type: "workspace",
  id: `workspace-${Date.now()}`,
  name: name || path.split("/").pop() || "Workspace",
  path,
  activeView: "files",
  views: {
    files: { tabs: [], activeTabId: null },
    git: { tabs: [], activeTabId: null },
    terminal: { tabs: [], activeTabId: null },
  },
});

const createTerminalGroup = (name?: string): TerminalGroup => ({
  type: "terminal",
  id: `terminal-${Date.now()}`,
  name: name || "Terminal",
  tabs: [],
  activeTabId: null,
});

const createPluginGroup = (pluginId: string, name?: string): PluginGroup => ({
  type: "plugin",
  id: `plugin-${Date.now()}`,
  name: name || pluginId,
  pluginId,
  tabs: [],
  activeTabId: null,
});

const createSettingsGroup = (): SettingsGroup => ({
  type: "settings",
  id: "settings",
  name: "Settings",
});

const createHomeGroup = (): HomeGroup => ({
  type: "home",
  id: "home",
  name: "Home",
});

const getGroupTabs = (group: PageGroup, view?: ViewType): TabItem[] => {
  if (group.type === "workspace") {
    const v = view || group.activeView;
    return group.views[v].tabs;
  }
  if (group.type === "settings" || group.type === "home") {
    return EMPTY_TABS;
  }
  return group.tabs;
};

const getGroupActiveTabId = (
  group: PageGroup,
  view?: ViewType,
): string | null => {
  if (group.type === "workspace") {
    const v = view || group.activeView;
    return group.views[v].activeTabId;
  }
  if (group.type === "settings" || group.type === "home") {
    return null;
  }
  return group.activeTabId;
};

export const useFrameStore = create<FrameState>((set, get) => ({
  groups: [],
  activeGroupId: null,
  topBarConfig: { show: false },
  bottomBarConfig: { show: true },
  pageMenuItems: [],

  setTopBarConfig: (config) => set({ topBarConfig: config }),
  setBottomBarConfig: (config) => set({ bottomBarConfig: config }),
  setPageMenuItems: (items) => set({ pageMenuItems: items }),

  initDefaultGroups: () => {
    const homeGroup = createHomeGroup();
    set({ groups: [homeGroup], activeGroupId: homeGroup.id });
  },

  showHomePage: () => {
    const { groups } = get();
    const homeGroup = groups.find((g) => g.type === "home");
    if (homeGroup) {
      set({ activeGroupId: homeGroup.id });
    } else {
      const newHomeGroup = createHomeGroup();
      set((s) => ({
        groups: [newHomeGroup, ...s.groups],
        activeGroupId: newHomeGroup.id,
      }));
    }
  },

  addWorkspaceGroup: (path, name, id) => {
    const group = createDefaultWorkspace(path, name);
    if (id) group.id = id;
    set((s) => {
      const groupsWithoutHome = s.groups.filter((g) => g.type !== "home");
      return {
        groups: [...groupsWithoutHome, group],
        activeGroupId: group.id,
      };
    });
    return group.id;
  },

  addTerminalGroup: (name) => {
    const group = createTerminalGroup(name);
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
  },

  addPluginGroup: (pluginId, name) => {
    const group = createPluginGroup(pluginId, name);
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
  },

  addSettingsGroup: () => {
    const { groups } = get();
    const existing = groups.find((g) => g.type === "settings");
    if (existing) {
      set({ activeGroupId: existing.id });
      return;
    }
    const group = createSettingsGroup();
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
  },

  removeGroup: (id) =>
    set((s) => {
      if (id === "home") return s;
      const groups = s.groups.filter((g) => g.id !== id);
      let activeGroupId = s.activeGroupId;
      if (s.activeGroupId === id) {
        if (groups.length > 0) {
          activeGroupId = groups[0].id;
        } else {
          const homeGroup = createHomeGroup();
          return {
            groups: [homeGroup],
            activeGroupId: homeGroup.id,
          };
        }
      }
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
        g.type === "workspace" && g.id === groupId
          ? { ...g, activeView: view }
          : g,
      ),
    })),

  getCurrentView: () => {
    const group = get().getActiveGroup();
    if (!group) return null;
    if (group.type === "workspace") return group.activeView;
    if (group.type === "terminal") return "terminal";
    return null;
  },

  setCurrentView: (view) => {
    const { activeGroupId, setWorkspaceView, getActiveGroup } = get();
    const group = getActiveGroup();
    if (group?.type === "workspace" && activeGroupId) {
      setWorkspaceView(activeGroupId, view);
    }
  },

  addTab: (groupId, tab, view) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === "workspace") {
          const v = view || g.activeView;
          const viewData = g.views[v];
          const exists = viewData.tabs.find((t) => t.id === tab.id);
          if (exists) {
            return {
              ...g,
              views: { ...g.views, [v]: { ...viewData, activeTabId: tab.id } },
            };
          }
          return {
            ...g,
            views: {
              ...g.views,
              [v]: { tabs: [...viewData.tabs, tab], activeTabId: tab.id },
            },
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
        const exists = g.tabs.find((t: TabItem) => t.id === tab.id);
        if (exists) return { ...g, activeTabId: tab.id };
        return { ...g, tabs: [...g.tabs, tab], activeTabId: tab.id };
      }),
    })),

  removeTab: (groupId, tabId, view) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === "workspace") {
          const v = view || g.activeView;
          const viewData = g.views[v];
          const tabs = viewData.tabs.filter((t) => t.id !== tabId);
          const activeTabId =
            viewData.activeTabId === tabId
              ? tabs.length > 0
                ? tabs[tabs.length - 1].id
                : null
              : viewData.activeTabId;
          return { ...g, views: { ...g.views, [v]: { tabs, activeTabId } } };
        }
        if (g.type === "settings" || g.type === "home") return g;
        const tabs = g.tabs.filter((t: TabItem) => t.id !== tabId);
        const activeTabId =
          g.activeTabId === tabId
            ? tabs.length > 0
              ? tabs[tabs.length - 1].id
              : null
            : g.activeTabId;
        return { ...g, tabs, activeTabId };
      }),
    })),

  setActiveTab: (groupId, tabId, view) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === "workspace") {
          const v = view || g.activeView;
          return {
            ...g,
            views: { ...g.views, [v]: { ...g.views[v], activeTabId: tabId } },
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
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

  pinTab: (tabId) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== s.activeGroupId) return g;
        if (g.type === "workspace") {
          const v = g.activeView;
          const viewData = g.views[v];
          return {
            ...g,
            views: {
              ...g.views,
              [v]: {
                ...viewData,
                tabs: viewData.tabs.map((t) =>
                  t.id === tabId ? { ...t, pinned: true } : t,
                ),
              },
            },
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
        return {
          ...g,
          tabs: g.tabs.map((t: TabItem) =>
            t.id === tabId ? { ...t, pinned: true } : t,
          ),
        };
      }),
    })),

  openPreviewTab: (tab) => {
    const { activeGroupId } = get();
    if (!activeGroupId) return;

    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== activeGroupId) return g;

        if (g.type === "workspace") {
          const v = g.activeView;
          const viewData = g.views[v];
          const existingTab = viewData.tabs.find((t) => t.id === tab.id);
          if (existingTab) {
            return {
              ...g,
              views: { ...g.views, [v]: { ...viewData, activeTabId: tab.id } },
            };
          }
          const previewTabIndex = viewData.tabs.findIndex((t) => !t.pinned);
          let newTabs: TabItem[];
          if (previewTabIndex !== -1) {
            newTabs = viewData.tabs.map((t, i) =>
              i === previewTabIndex ? { ...tab, pinned: false } : t,
            );
          } else {
            newTabs = [...viewData.tabs, { ...tab, pinned: false }];
          }
          return {
            ...g,
            views: { ...g.views, [v]: { tabs: newTabs, activeTabId: tab.id } },
          };
        }

        if (g.type === "settings" || g.type === "home") return g;

        const existingTab = g.tabs.find((t: TabItem) => t.id === tab.id);
        if (existingTab) {
          return { ...g, activeTabId: tab.id };
        }
        const previewTabIndex = g.tabs.findIndex((t: TabItem) => !t.pinned);
        let newTabs: TabItem[];
        if (previewTabIndex !== -1) {
          newTabs = g.tabs.map((t: TabItem, i: number) =>
            i === previewTabIndex ? { ...tab, pinned: false } : t,
          );
        } else {
          newTabs = [...g.tabs, { ...tab, pinned: false }];
        }
        return { ...g, tabs: newTabs, activeTabId: tab.id };
      }),
    }));
  },
}));
