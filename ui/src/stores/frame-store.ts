import type { ReactNode } from "react";
import { create } from "zustand";
import { pageRegistry } from "@/pages/registry";
import { randomUUID } from "@/lib/uuid";
import { groupPayload, tabPayload } from "./workspace-inventory";

// Only the device that opens a terminal task starts its first PTY.
const terminalStartRequests = new Set<string>();
export function consumeTerminalStartRequest(groupId: string): boolean {
  return terminalStartRequests.delete(groupId);
}

export type FrameMutationAction = { type: string; payload: Record<string, unknown> };
export type FrameActionDispatcher = (action: FrameMutationAction) => void;
let frameActionDispatcher: FrameActionDispatcher | null = null;
export function setFrameActionDispatcher(dispatcher: FrameActionDispatcher | null) {
  frameActionDispatcher = dispatcher;
}
function dispatchFrame(type: string, payload: Record<string, unknown>) {
  frameActionDispatcher?.({ type, payload });
}
function dispatchGroup(type: string, groupId: string) {
  if (!frameActionDispatcher) return;
  const groups = useFrameStore.getState().groups;
  const group = groups.find((item) => item.id === groupId);
  if (group) dispatchFrame(type, groupPayload(group, groups.indexOf(group)));
}
function dispatchTab(type: string, groupId: string, tabId: string, pageId?: string) {
  if (!frameActionDispatcher) return;
  const group = useFrameStore.getState().groups.find((item) => item.id === groupId);
  if (!group || (group.type !== "group" && group.type !== "tool")) return;
  const tabs = getGroupTabs(group, pageId);
  const tab = tabs.find((item) => item.id === tabId);
  if (tab)
    dispatchFrame(
      type,
      tabPayload(groupId, group.type === "group" ? pageId || group.activePageId || "" : "", tab, tabs.indexOf(tab))
    );
}
function dispatchFolderOrder() {
  dispatchFrame("folder/reorder", {
    folder_ids: useFrameStore
      .getState()
      .groups.filter((group) => group.type === "group")
      .map((group) => group.id),
  });
}

export type GroupType = "home" | "group" | "tool" | "settings";

export type PageType = string;

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
  position?: number;
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
  data?: Record<string, unknown>;
}

export interface ToolGroup {
  type: "tool";
  id: string;
  name: string;
  pageId: string;
  tabs: TabItem[];
  activeTabId: string | null;
  data?: Record<string, unknown>;
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
  addTerminalGroup: (cwd?: string, name?: string, associatedFolderId?: string) => string;
  addGitGroup: (repoPath?: string, name?: string, associatedFolderId?: string) => string;
  updateGroupData: (groupId: string, data: Record<string, unknown>) => void;
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
  updateTab: (groupId: string, tabId: string, updates: Partial<TabItem>, pageId?: string) => void;
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
  const groupId = `group-${randomUUID()}`;
  const folderName = name || path.split("/").pop() || "Folder";
  return {
    type: "group",
    id: groupId,
    name: folderName,
    pages: [
      {
        id: `${groupId}-files`,
        type: "files",
        label: "Files",
        path,
        tabs: [],
        activeTabId: null,
      },
    ],
    activePageId: `${groupId}-files`,
  };
};

const createToolGroup = (pageId: string, name?: string, id?: string): ToolGroup => ({
  type: "tool",
  id: id || `tool-${randomUUID()}`,
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
    terminalStartRequests.clear();
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
    dispatchGroup("folder/add", group.id);
    return group.id;
  },

  replaceGroupState: (groupId, payload) => {
    const group = get().groups.find((group) => group.id === groupId);
    if (group?.type === "group")
      for (const page of group.pages)
        for (const tab of page.tabs) dispatchFrame("tab/close", { id: tab.id, folder_id: groupId, page_id: page.id });
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.type !== "group" || g.id !== groupId) return g;
        const pages = payload.pages;
        const activePageExists = !!payload.activePageId && pages.some((p) => p.id === payload.activePageId);
        const fallbackActivePageId = pages.find((p) => p.type === "files")?.id || pages[0]?.id || null;
        return {
          ...g,
          name: payload.name || g.name,
          pages,
          activePageId: activePageExists ? payload.activePageId : fallbackActivePageId,
        };
      }),
    }));
    dispatchGroup("folder/update-data", groupId);
    for (const page of payload.pages) for (const tab of page.tabs) dispatchTab("tab/open", groupId, tab.id, page.id);
  },

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
    const group = createToolGroup(pageId, name, id || (pageDef?.singleton ? `tool-${pageId}` : undefined));
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
    dispatchGroup("tool/open", group.id);
  },

  addTerminalGroup: (cwd, name, associatedFolderId) => {
    const group = createToolGroup("terminal", name || "Terminal");
    terminalStartRequests.add(group.id);
    group.data = { cwd, associatedFolderId };
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
    dispatchGroup("tool/open", group.id);
    return group.id;
  },

  addGitGroup: (repoPath, name, associatedFolderId) => {
    const group = createToolGroup("git", name || "Git");
    group.data = { repoPath, associatedFolderId };
    set((s) => ({ groups: [...s.groups, group], activeGroupId: group.id }));
    dispatchGroup("tool/open", group.id);
    return group.id;
  },

  updateGroupData: (groupId, data) => {
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === groupId && (group.type === "group" || group.type === "tool") ? { ...group, data } : group
      ),
    }));
    const group = get().groups.find((group) => group.id === groupId);
    if (group?.type === "group" || group?.type === "tool")
      dispatchGroup(group.type === "group" ? "folder/update-data" : "tool/update-data", groupId);
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

  removeGroup: (id) => {
    terminalStartRequests.delete(id);
    const group = get().groups.find((group) => group.id === id);
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
    });
    if (group?.type === "group" || group?.type === "tool")
      dispatchFrame(group.type === "group" ? "folder/remove" : "tool/close", { id });
  },

  reorderGroups: (fromId, toId) => {
    set((s) => ({
      groups: reorderById(s.groups, fromId, toId),
    }));
    if (fromId !== toId) dispatchFolderOrder();
  },

  setTaskbarOrder: (order) => set({ taskbarOrder: order }),

  reorderTaskbarItems: (fromId, toId, visibleIds) => {
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
    });
    if (fromId !== toId && fromId.startsWith("group:") && toId.startsWith("group:")) dispatchFolderOrder();
  },

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
    return group.type === "tool" ? group.pageId : group.type;
  },

  addPageToGroup: (groupId, page) => {
    const frame = get();
    frame.addToolGroup(page.type, page.label, page.id);
    frame.updateGroupData(page.id, { path: page.path, associatedFolderId: groupId });
  },

  removePageFromGroup: (groupId, pageId) => {
    const group = get().groups.find((group) => group.id === groupId);
    if (group?.type === "group")
      for (const tab of getGroupTabs(group, pageId))
        dispatchFrame("tab/close", { id: tab.id, folder_id: groupId, page_id: pageId });
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.type !== "group" || g.id !== groupId) return g;
        const pages = g.pages.filter((p) => p.id !== pageId);
        const activePageId = g.activePageId === pageId ? (pages.length > 0 ? pages[0].id : null) : g.activePageId;
        return { ...g, pages, activePageId };
      }),
    }));
    dispatchGroup("folder/update-data", groupId);
  },

  setFolderView: (groupId, view) => {
    const frame = get();
    const group = frame.groups.find((group) => group.id === groupId);
    if (!group) return;
    if (group.type === "tool" && group.pageId === view) {
      frame.setActiveGroup(groupId);
      return;
    }
    if (group.type !== "group") return;
    const page = group.pages.find((page) => page.type === view);
    if (page) {
      frame.setActiveGroup(groupId);
      frame.setActivePage(groupId, page.id);
      return;
    }
    const existing = frame.groups.find(
      (task) => task.type === "tool" && task.pageId === view && task.data?.associatedFolderId === groupId
    );
    if (existing) {
      frame.setActiveGroup(existing.id);
      return;
    }
    const path = group.pages[0]?.path;
    if (view === "terminal") frame.addTerminalGroup(path, undefined, groupId);
    else if (view === "git") frame.addGitGroup(path, undefined, groupId);
    else {
      const id = `page:${groupId}:${view}`;
      frame.addToolGroup(view, pageRegistry.get(view)?.name || view, id);
      frame.updateGroupData(id, { path, associatedFolderId: groupId });
    }
  },

  getCurrentView: () => {
    const group = get().getActiveGroup();
    if (!group) return null;
    if (group.type === "group") {
      const page = getActivePage(group);
      return page?.type || null;
    }
    return group.type === "tool" ? group.pageId : group.type;
  },

  setCurrentView: (view) => {
    const { activeGroupId, setFolderView, getActiveGroup } = get();
    const group = getActiveGroup();
    if (group?.type === "group" && activeGroupId) {
      setFolderView(activeGroupId, view);
    }
  },

  addTab: (groupId, tab, pageId) => {
    const group = get().groups.find((group) => group.id === groupId);
    const existingTabs = group ? getGroupTabs(group, pageId) : [];
    const exists = existingTabs.some((item) => item.id === tab.id);
    tab = {
      ...tab,
      position: tab.position ?? Math.min(0, ...existingTabs.map((item, index) => item.position ?? index)) - 1,
    };
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
    }));
    if (!exists) dispatchTab("tab/open", groupId, tab.id, pageId);
  },

  updateTab: (groupId, tabId, updates, pageId) => {
    set((state) => ({
      groups: state.groups.map((group) => {
        if (group.id !== groupId) return group;
        const update = (tabs: TabItem[]) =>
          tabs.map((tab) => (tab.id === tabId ? { ...tab, ...updates, data: { ...tab.data, ...updates.data } } : tab));
        if (group.type === "group")
          return {
            ...group,
            pages: group.pages.map((page) =>
              page.id === (pageId || group.activePageId) ? { ...page, tabs: update(page.tabs) } : page
            ),
          };
        return group.type === "tool" ? { ...group, tabs: update(group.tabs) } : group;
      }),
    }));
    const keys = Object.keys(updates);
    const sharedData = Object.keys(updates.data || {}).some((key) => !["isDirty", "line", "column"].includes(key));
    if (keys.length === 1 && keys[0] === "pinned") dispatchTab("tab/pin", groupId, tabId, pageId);
    else if (keys.some((key) => key !== "data") || sharedData) dispatchTab("tab/update", groupId, tabId, pageId);
  },

  removeTab: (groupId, tabId, pageId) => {
    const group = get().groups.find((group) => group.id === groupId);
    const targetPage = group?.type === "group" ? pageId || group.activePageId || "" : "";
    const exists = group && getGroupTabs(group, pageId).some((tab) => tab.id === tabId);
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
    }));
    if (exists) dispatchFrame("tab/close", { id: tabId, folder_id: groupId, page_id: targetPage });
  },

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

  reorderCurrentTabs: (fromId, toId) => {
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== s.activeGroupId) return g;
        if (g.type === "group") {
          return {
            ...g,
            pages: g.pages.map((p) =>
              p.id === g.activePageId
                ? { ...p, tabs: reorderById(p.tabs, fromId, toId).map((tab, position) => ({ ...tab, position })) }
                : p
            ),
          };
        }
        if (g.type === "settings" || g.type === "home") return g;
        return { ...g, tabs: reorderById(g.tabs, fromId, toId).map((tab, position) => ({ ...tab, position })) };
      }),
    }));
    const group = get().getActiveGroup();
    if (group && fromId !== toId) for (const tab of getGroupTabs(group)) dispatchTab("tab/update", group.id, tab.id);
  },

  pinTab: (tabId) => {
    const group = get().getActiveGroup();
    if (group) get().updateTab(group.id, tabId, { pinned: true });
  },

  openPreviewTab: (tab) => {
    const group = get().getActiveGroup();
    if (!group || (group.type !== "group" && group.type !== "tool")) return;
    const tabs = getGroupTabs(group);
    if (tabs.some((item) => item.id === tab.id)) {
      get().setActiveTab(group.id, tab.id);
      return;
    }
    const preview = tabs.find((item) => !item.pinned);
    const position = preview
      ? (preview.position ?? tabs.indexOf(preview))
      : Math.min(0, ...tabs.map((item, index) => item.position ?? index)) - 1;
    const nextTab = { ...tab, pinned: false, position };
    const nextTabs = preview ? tabs.map((item) => (item.id === preview.id ? nextTab : item)) : [nextTab, ...tabs];
    set((state) => ({
      groups: state.groups.map((item) => {
        if (item.id !== group.id) return item;
        if (item.type === "tool") return { ...item, tabs: nextTabs, activeTabId: tab.id };
        if (item.type === "group")
          return {
            ...item,
            pages: item.pages.map((page) =>
              page.id === item.activePageId ? { ...page, tabs: nextTabs, activeTabId: tab.id } : page
            ),
          };
        return item;
      }),
    }));
    if (preview)
      dispatchFrame("tab/close", {
        id: preview.id,
        folder_id: group.id,
        page_id: group.type === "group" ? group.activePageId || "" : "",
      });
    dispatchTab("tab/open", group.id, tab.id);
  },
}));
