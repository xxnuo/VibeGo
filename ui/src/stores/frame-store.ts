import type { ReactNode } from "react";
import { create } from "zustand";
import { pageRegistry } from "@/pages/registry";

export type GroupType = "home" | "group" | "tool" | "settings";

export type PageType = "files" | "git" | "terminal";

export interface PageMenuItem {
  id: string;
  icon: ReactNode;
  label: string;
  badge?: string | number;
  onClick?: () => void;
}

export interface TopBarButton {
  icon: ReactNode;
  label?: string;
  title?: string;
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

export interface TabItem {
  id: string;
  title: string;
  icon?: string;
  data?: Record<string, unknown>;
  closable?: boolean;
  pinned?: boolean;
}

const EMPTY_TABS: TabItem[] = [];

export interface GroupPage {
  id: string;
  type: PageType;
  label: string;
  path?: string;
  tabs: TabItem[];
  activeTabId: string | null;
}

export interface GenericGroup {
  type: "group";
  id: string;
  name: string;
  pages: GroupPage[];
  activePageId: string | null;
}

export interface ToolGroup {
  type: "tool";
  id: string;
  name: string;
  pageId: string;
  tabs: TabItem[];
  activeTabId: string | null;
}

export interface SettingsGroup {
  type: "settings";
  id: string;
  name: string;
  activeCategory?: string;
}

export interface HomeGroup {
  type: "home";
  id: string;
  name: string;
}

export type PageGroup = HomeGroup | GenericGroup | ToolGroup | SettingsGroup;

export type ViewType = PageType;

interface FrameState {
  groups: PageGroup[];
  activeGroupId: string | null;
  taskbarOrder: string[];
  topBarConfig: TopBarConfig;
  bottomBarConfig: BottomBarConfig;
  pageMenuItems: PageMenuItem[];

  setTopBarConfig: (config: TopBarConfig) => void;
  setBottomBarConfig: (config: BottomBarConfig) => void;
  setPageMenuItems: (items: PageMenuItem[]) => void;
  initDefaultGroups: () => void;
  showHomePage: () => void;
  addFolderGroup: (path: string, name?: string, id?: string) => string;
  replaceGroupState: (
    groupId: string,
    payload: {
      name?: string;
      pages: GroupPage[];
      activePageId: string | null;
    }
  ) => void;
  addToolGroup: (pageId: string, name?: string, id?: string) => void;
  addTerminalGroup: () => void;
  addSettingsGroup: () => void;
  openSettingsCategory: (category: string) => void;
  setSettingsActiveCategory: (category: string | undefined) => void;
  removeGroup: (id: string) => void;
  reorderGroups: (fromId: string, toId: string) => void;
  setTaskbarOrder: (order: string[]) => void;
  reorderTaskbarItems: (fromId: string, toId: string, visibleIds: string[]) => void;
  setActiveGroup: (id: string) => void;
  getActiveGroup: () => PageGroup | undefined;

  setActivePage: (groupId: string, pageId: string) => void;
  getCurrentPage: () => GroupPage | null;
  getCurrentPageType: () => PageType | null;

  addPageToGroup: (groupId: string, page: Omit<GroupPage, "tabs" | "activeTabId">) => void;
  removePageFromGroup: (groupId: string, pageId: string) => void;

  addTab: (groupId: string, tab: TabItem, pageId?: string) => void;
  removeTab: (groupId: string, tabId: string, pageId?: string) => void;
  setActiveTab: (groupId: string, tabId: string | null, pageId?: string) => void;

  getCurrentTabs: () => TabItem[];
  getCurrentActiveTabId: () => string | null;
  setCurrentActiveTab: (tabId: string | null) => void;
  addCurrentTab: (tab: TabItem) => void;
  removeCurrentTab: (tabId: string) => void;
  reorderCurrentTabs: (fromId: string, toId: string) => void;

  pinTab: (tabId: string) => void;
  openPreviewTab: (tab: TabItem) => void;

  setFolderView: (groupId: string, view: ViewType) => void;
  getCurrentView: () => ViewType | null;
  setCurrentView: (view: ViewType) => void;
}

const createFolderGroup = (path: string, name?: string): GenericGroup => {
  const groupId = `group-${Date.now()}`;
  const folderName = name || path.split("/").pop() || "Folder";
  return {
    type: "group",
    id: groupId,
    name: folderName,
    pages: [
      { id: `${groupId}-files`, type: "files", label: "Files", path, tabs: [], activeTabId: null },
      { id: `${groupId}-git`, type: "git", label: "Git", path, tabs: [], activeTabId: null },
      { id: `${groupId}-terminal`, type: "terminal", label: "Terminal", path, tabs: [], activeTabId: null },
    ],
    activePageId: `${groupId}-files`,
  };
};

const createToolGroup = (pageId: string, name?: string, id?: string): ToolGroup => ({
  type: "tool",
  id: id || `tool-${Date.now()}`,
  name: name || pageId,
  pageId,
  tabs: [],
  activeTabId: null,
});

const createSettingsGroup = (): SettingsGroup => ({
  type: "settings",
  id: "settings",
  name: "Settings",
  activeCategory: undefined,
});

const createHomeGroup = (): HomeGroup => ({
  type: "home",
  id: "home",
  name: "Home",
});

const getGroupTabs = (group: PageGroup, pageId?: string): TabItem[] => {
  if (group.type === "group") {
    const targetPageId = pageId || group.activePageId;
    const page = group.pages.find((p) => p.id === targetPageId);
    return page?.tabs || EMPTY_TABS;
  }
  if (group.type === "settings" || group.type === "home") {
    return EMPTY_TABS;
  }
  return group.tabs;
};

const getGroupActiveTabId = (group: PageGroup, pageId?: string): string | null => {
  if (group.type === "group") {
    const targetPageId = pageId || group.activePageId;
    const page = group.pages.find((p) => p.id === targetPageId);
    return page?.activeTabId || null;
  }
  if (group.type === "settings" || group.type === "home") {
    return null;
  }
  return group.activeTabId;
};

const getActivePage = (group: PageGroup): GroupPage | null => {
  if (group.type !== "group") return null;
  return group.pages.find((p) => p.id === group.activePageId) || null;
};

const reorderById = <T extends { id: string }>(items: T[], fromId: string, toId: string): T[] => {
  if (fromId === toId) return items;
  const fromIndex = items.findIndex((item) => item.id === fromId);
  const toIndex = items.findIndex((item) => item.id === toId);
  if (fromIndex === -1 || toIndex === -1) return items;
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
};

const reorderIds = (ids: string[], fromId: string, toId: string): string[] => {
  return reorderById(
    ids.map((id) => ({ id })),
    fromId,
    toId
  ).map((item) => item.id);
};

export const useFrameStore = create<FrameState>((set, get) => ({
  groups: [],
  activeGroupId: null,
  taskbarOrder: [],
  topBarConfig: { show: false },
  bottomBarConfig: { show: true },
  pageMenuItems: [],

  setTopBarConfig: (config) => set({ topBarConfig: config }),
  setBottomBarConfig: (config) => set({ bottomBarConfig: config }),
  setPageMenuItems: (items) => set({ pageMenuItems: items }),

  initDefaultGroups: () => {
    const homeGroup = createHomeGroup();
    set({ groups: [homeGroup], activeGroupId: homeGroup.id, taskbarOrder: [] });
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

  addFolderGroup: (path, name, id) => {
    const group = createFolderGroup(path, name);
    if (id) {
      group.id = id;
      group.pages = group.pages.map((p) => ({
        ...p,
        id: `${id}-${p.type}`,
      }));
      group.activePageId = `${id}-files`;
    }
    set((s) => {
      const groupsWithoutHome = s.groups.filter((g) => g.type !== "home");
      return {
        groups: [...groupsWithoutHome, group],
        activeGroupId: group.id,
      };
    });
    return group.id;
  },

  replaceGroupState: (groupId, payload) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.type !== "group" || g.id !== groupId) return g;
        const pages = payload.pages || [];
        const activePageExists = !!payload.activePageId && pages.some((p) => p.id === payload.activePageId);
        const fallbackActivePageId = pages.find((p) => p.type === "files")?.id || pages[0]?.id || null;
        return {
          ...g,
          name: payload.name || g.name,
          pages,
          activePageId: activePageExists ? payload.activePageId : fallbackActivePageId,
        };
      }),
    })),

  addToolGroup: (pageId, name, id) => {
    const { groups } = get();
    const pageDef = pageRegistry.get(pageId);
    if (pageDef?.singleton) {
      const existing = groups.find((g) => g.type === "tool" && (g as ToolGroup).pageId === pageId);
      if (existing) {
        set({ activeGroupId: existing.id });
        return;
      }
    }
    const group = createToolGroup(pageId, name, id);
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
  },

  addTerminalGroup: () => {
    const groupId = `terminal-${Date.now()}`;
    const group: GenericGroup = {
      type: "group",
      id: groupId,
      name: "Terminal",
      pages: [{ id: `${groupId}-terminal`, type: "terminal", label: "Terminal", tabs: [], activeTabId: null }],
      activePageId: `${groupId}-terminal`,
    };
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

  openSettingsCategory: (category) =>
    set((s) => {
      const existing = s.groups.find((g) => g.type === "settings");
      if (existing) {
        return {
          groups: s.groups.map((g) => (g.type === "settings" ? { ...g, activeCategory: category } : g)),
          activeGroupId: existing.id,
        };
      }
      const group = { ...createSettingsGroup(), activeCategory: category };
      return { groups: [...s.groups, group], activeGroupId: group.id };
    }),

  setSettingsActiveCategory: (category) =>
    set((s) => ({
      groups: s.groups.map((g) => (g.type === "settings" ? { ...g, activeCategory: category } : g)),
    })),

  removeGroup: (id) =>
    set((s) => {
      const remainingGroups = s.groups.filter((g) => g.id !== id);
      if (id === "home" && remainingGroups.length === 0) return s;
      if (remainingGroups.length === 0) {
        const homeGroup = createHomeGroup();
        return {
          groups: [homeGroup],
          activeGroupId: homeGroup.id,
        };
      }
      let activeGroupId = s.activeGroupId;
      if (s.activeGroupId === id) {
        activeGroupId = remainingGroups[0].id;
      }
      return {
        groups: remainingGroups,
        activeGroupId,
        taskbarOrder: s.taskbarOrder.filter((itemId) => itemId !== `group:${id}`),
      };
    }),

  reorderGroups: (fromId, toId) =>
    set((s) => ({
      groups: reorderById(s.groups, fromId, toId),
    })),

  setTaskbarOrder: (order) => set({ taskbarOrder: order }),

  reorderTaskbarItems: (fromId, toId, visibleIds) =>
    set((s) => {
      const current = s.taskbarOrder.length > 0 ? s.taskbarOrder : visibleIds;
      const known = current.filter((id) => visibleIds.includes(id));
      const appended = visibleIds.filter((id) => !known.includes(id));
      const taskbarOrder = reorderIds([...known, ...appended], fromId, toId);
      const fromGroup = fromId.startsWith("group:") ? fromId.slice(6) : null;
      const toGroup = toId.startsWith("group:") ? toId.slice(6) : null;
      return {
        taskbarOrder,
        groups: fromGroup && toGroup ? reorderById(s.groups, fromGroup, toGroup) : s.groups,
      };
    }),

  setActiveGroup: (id) => set({ activeGroupId: id }),

  getActiveGroup: () => {
    const { groups, activeGroupId } = get();
    return groups.find((g) => g.id === activeGroupId);
  },

  setActivePage: (groupId, pageId) =>
    set((s) => ({
      groups: s.groups.map((g) => (g.type === "group" && g.id === groupId ? { ...g, activePageId: pageId } : g)),
    })),

  getCurrentPage: () => {
    const group = get().getActiveGroup();
    if (!group) return null;
    return getActivePage(group);
  },

  getCurrentPageType: () => {
    const group = get().getActiveGroup();
    if (!group) return null;
    if (group.type === "group") {
      const page = getActivePage(group);
      return page?.type || null;
    }
    return null;
  },

  addPageToGroup: (groupId, page) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.type !== "group" || g.id !== groupId) return g;
        const exists = g.pages.find((p) => p.id === page.id);
        if (exists) return { ...g, activePageId: page.id };
        return {
          ...g,
          pages: [...g.pages, { ...page, tabs: [], activeTabId: null }],
          activePageId: page.id,
        };
      }),
    })),

  removePageFromGroup: (groupId, pageId) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.type !== "group" || g.id !== groupId) return g;
        const pages = g.pages.filter((p) => p.id !== pageId);
        const activePageId = g.activePageId === pageId ? (pages.length > 0 ? pages[0].id : null) : g.activePageId;
        return { ...g, pages, activePageId };
      }),
    })),

  setFolderView: (groupId, view) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.type !== "group" || g.id !== groupId) return g;
        const page = g.pages.find((p) => p.type === view);
        if (!page) return g;
        return { ...g, activePageId: page.id };
      }),
    })),

  getCurrentView: () => {
    const group = get().getActiveGroup();
    if (!group) return null;
    if (group.type === "group") {
      const page = getActivePage(group);
      return page?.type || null;
    }
    return null;
  },

  setCurrentView: (view) => {
    const { activeGroupId, setFolderView, getActiveGroup } = get();
    const group = getActiveGroup();
    if (group?.type === "group" && activeGroupId) {
      setFolderView(activeGroupId, view);
    }
  },

  addTab: (groupId, tab, pageId) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === "group") {
          const targetPageId = pageId || g.activePageId;
          return {
            ...g,
            pages: g.pages.map((p) => {
              if (p.id !== targetPageId) return p;
              const exists = p.tabs.find((t) => t.id === tab.id);
              if (exists) return { ...p, activeTabId: tab.id };
              return { ...p, tabs: [tab, ...p.tabs], activeTabId: tab.id };
            }),
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
        const exists = g.tabs.find((t: TabItem) => t.id === tab.id);
        if (exists) return { ...g, activeTabId: tab.id };
        return { ...g, tabs: [tab, ...g.tabs], activeTabId: tab.id };
      }),
    })),

  removeTab: (groupId, tabId, pageId) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === "group") {
          const targetPageId = pageId || g.activePageId;
          return {
            ...g,
            pages: g.pages.map((p) => {
              if (p.id !== targetPageId) return p;
              const removeIndex = p.tabs.findIndex((t) => t.id === tabId);
              const tabs = p.tabs.filter((t) => t.id !== tabId);
              const activeTabId =
                p.activeTabId === tabId
                  ? tabs.length > 0
                    ? tabs[Math.min(removeIndex, tabs.length - 1)].id
                    : null
                  : p.activeTabId;
              return { ...p, tabs, activeTabId };
            }),
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
        const removeIndex = g.tabs.findIndex((t: TabItem) => t.id === tabId);
        const tabs = g.tabs.filter((t: TabItem) => t.id !== tabId);
        const activeTabId =
          g.activeTabId === tabId
            ? tabs.length > 0
              ? tabs[Math.min(removeIndex, tabs.length - 1)].id
              : null
            : g.activeTabId;
        return { ...g, tabs, activeTabId };
      }),
    })),

  setActiveTab: (groupId, tabId, pageId) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.type === "group") {
          const targetPageId = pageId || g.activePageId;
          return {
            ...g,
            pages: g.pages.map((p) => (p.id !== targetPageId ? p : { ...p, activeTabId: tabId })),
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

  reorderCurrentTabs: (fromId, toId) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== s.activeGroupId) return g;
        if (g.type === "group") {
          return {
            ...g,
            pages: g.pages.map((p) =>
              p.id === g.activePageId ? { ...p, tabs: reorderById(p.tabs, fromId, toId) } : p
            ),
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
        return { ...g, tabs: reorderById(g.tabs, fromId, toId) };
      }),
    })),

  pinTab: (tabId) =>
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== s.activeGroupId) return g;
        if (g.type === "group") {
          return {
            ...g,
            pages: g.pages.map((p) =>
              p.id !== g.activePageId
                ? p
                : { ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, pinned: true } : t)) }
            ),
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
        return {
          ...g,
          tabs: g.tabs.map((t: TabItem) => (t.id === tabId ? { ...t, pinned: true } : t)),
        };
      }),
    })),

  openPreviewTab: (tab) => {
    const { activeGroupId } = get();
    if (!activeGroupId) return;

    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== activeGroupId) return g;

        if (g.type === "group") {
          return {
            ...g,
            pages: g.pages.map((p) => {
              if (p.id !== g.activePageId) return p;
              const existingTab = p.tabs.find((t) => t.id === tab.id);
              if (existingTab) return { ...p, activeTabId: tab.id };
              const previewTabIndex = p.tabs.findIndex((t) => !t.pinned);
              let newTabs: TabItem[];
              if (previewTabIndex !== -1) {
                newTabs = p.tabs.map((t, i) => (i === previewTabIndex ? { ...tab, pinned: false } : t));
              } else {
                newTabs = [{ ...tab, pinned: false }, ...p.tabs];
              }
              return { ...p, tabs: newTabs, activeTabId: tab.id };
            }),
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
          newTabs = g.tabs.map((t: TabItem, i: number) => (i === previewTabIndex ? { ...tab, pinned: false } : t));
        } else {
          newTabs = [{ ...tab, pinned: false }, ...g.tabs];
        }
        return { ...g, tabs: newTabs, activeTabId: tab.id };
      }),
    }));
  },
}));
