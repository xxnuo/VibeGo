import { Box, FolderOpen, Home, Maximize, Minimize, Settings } from "lucide-react";
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import NavIcon from "@/components/frame/nav-icon";
import type { TaskbarSortEntry } from "@/components/frame/taskbar-item-menu";
import { getWorkspacePath, useWorkspaceHint } from "@/components/frame/workspace-hint-bubble";
import { useIsMobile } from "@/hooks/use-mobile";
import { useReorderableList } from "@/hooks/use-reorderable-list";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";
import { type BottomBarConfig, type PageGroup, type PageType, useFrameStore } from "@/stores/frame-store";
import { useSessionStore } from "@/stores/session-store";
import { pageRegistry } from "./registry";

export type TaskbarItem =
  | { id: string; type: "group"; group: PageGroup }
  | { id: string; type: "custom"; item: NonNullable<BottomBarConfig["customItems"]>[number] };

export interface UseTaskbarOptions {
  orientation: "vertical" | "horizontal";
}

const GROUP_ICONS = { home: Home, group: FolderOpen, tool: Box, settings: Settings };

export function useTaskbar({ orientation }: UseTaskbarOptions) {
  const vertical = orientation === "vertical";
  const iconSize = vertical ? 24 : 18;
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const groups = useFrameStore((s) => s.groups);
  const activeGroupId = useFrameStore((s) => s.activeGroupId);
  const bottomBarConfig = useFrameStore((s) => s.bottomBarConfig);
  const setActiveGroup = useFrameStore((s) => s.setActiveGroup);
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const taskbarOrder = useFrameStore((s) => s.taskbarOrder);
  const reorderTaskbarItems = useFrameStore((s) => s.reorderTaskbarItems);
  const setTaskbarOrder = useFrameStore((s) => s.setTaskbarOrder);
  const removeGroup = useFrameStore((s) => s.removeGroup);
  const closeFolderGroup = useSessionStore((s) => s.closeFolderGroup);
  const isMobile = useIsMobile();
  const { hint: workspaceHint, showWorkspaceHint } = useWorkspaceHint(vertical ? "right" : "top");
  const [sortOpen, setSortOpen] = useState(false);
  const sortRestoreFocusRef = useRef<HTMLElement | null>(null);
  const lastClickTime = useRef<Record<string, number>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleGroupClick = useCallback(
    (group: PageGroup, target: HTMLElement) => {
      const now = Date.now();
      const lastClick = lastClickTime.current[group.id] || 0;
      if (getWorkspacePath(group) && (vertical || activeGroupId === group.id)) {
        showWorkspaceHint(group, target);
      }
      if (activeGroupId === group.id && (vertical || now - lastClick < 300)) {
        setCurrentActiveTab(null);
      }
      lastClickTime.current[group.id] = now;
      setActiveGroup(group.id);
    },
    [activeGroupId, vertical, setActiveGroup, setCurrentActiveTab, showWorkspaceHint]
  );

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.(vertical ? undefined : { navigationUI: "hide" });
      return;
    }
    document.exitFullscreen?.();
  }, [vertical]);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    handleChange();
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const rightButtons = bottomBarConfig.rightButtons?.length
    ? bottomBarConfig.rightButtons
    : [
        {
          icon: createElement(isFullscreen ? Minimize : Maximize, { size: iconSize }),
          label: isFullscreen ? t("common.exitFullscreen") : t("common.fullscreen"),
          onClick: handleToggleFullscreen,
          active: isFullscreen,
          disabled: false,
        },
      ];

  const getPageTitle = useCallback(
    (pageType: PageType) => {
      const page = pageRegistry.get(pageType);
      const key = page?.nameKey || `sidebar.${pageType}`;
      const translated = t(key);
      return translated === key ? page?.name || pageType : translated;
    },
    [t]
  );
  const getGroupTitle = useCallback(
    (group: PageGroup) => {
      if (group.type === "home") return t("common.home");
      if (group.type === "settings") return t("common.settings");
      const pageId = group.type === "tool" ? group.pageId : group.pages[0]?.type || "files";
      const title = getPageTitle(pageId);
      const path = getWorkspacePath(group);
      return path ? `${title} - ${path}` : title;
    },
    [t, getPageTitle]
  );
  const getGroupIcon = useCallback(
    (group: PageGroup) =>
      group.type === "tool" || group.type === "group"
        ? createElement(NavIcon, {
            icon: pageRegistry.get(group.type === "tool" ? group.pageId : group.pages[0]?.type || "files")?.icon,
            size: iconSize,
          })
        : createElement(GROUP_ICONS[group.type], { size: iconSize }),
    [iconSize]
  );

  const useCustomItems = Boolean(bottomBarConfig.customItems?.length);
  const isOnlyHome = groups.length === 1 && groups[0].type === "home";
  const visibleItems = useMemo<TaskbarItem[]>(() => {
    if (useCustomItems) {
      return bottomBarConfig.customItems!.map((item) => ({ id: `custom:${item.id}`, type: "custom", item }));
    }
    if (!vertical && isOnlyHome) return [];
    return groups.map((group) => ({ id: `group:${group.id}`, type: "group", group }));
  }, [bottomBarConfig.customItems, groups, isOnlyHome, useCustomItems, vertical]);
  const visibleIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);
  const orderedItems = useMemo(
    () => [
      ...taskbarOrder
        .map((id) => visibleItems.find((item) => item.id === id))
        .filter((item): item is TaskbarItem => Boolean(item)),
      ...visibleItems.filter((item) => !taskbarOrder.includes(item.id)),
    ],
    [taskbarOrder, visibleItems]
  );
  const taskbarReorder = useReorderableList({
    ids: visibleIds,
    axis: vertical ? "y" : "x",
    onReorder: (fromId, toId) => reorderTaskbarItems(fromId, toId, visibleIds),
    disabled: (!vertical && isMobile) || visibleIds.length < 2,
  });

  const activateItem = (item: TaskbarItem) => {
    if (item.type === "custom") item.item.onClick?.();
    else setActiveGroup(item.group.id);
  };
  const closeGroup = async (group: PageGroup) => {
    if (group.type === "home" && groups.length <= 1) return;
    if (group.type === "group" && group.pages.some((page) => page.path)) {
      await closeFolderGroup(group.id);
      return;
    }
    removeGroup(group.id);
  };
  const closeAllGroups = async (keepId?: string) => {
    const targets = groups.filter((group) => group.id !== keepId && !(group.type === "home" && groups.length <= 1));
    for (const group of targets) await closeGroup(group);
  };
  const openSort = (restoreFocusTo?: HTMLElement | null) => {
    sortRestoreFocusRef.current = !vertical && restoreFocusTo?.isConnected ? restoreFocusTo : null;
    setSortOpen(true);
  };
  const sortEntries = useMemo<TaskbarSortEntry[]>(
    () =>
      orderedItems.map((item) =>
        item.type === "custom"
          ? { id: item.id, title: item.item.label, icon: item.item.icon, badge: item.item.badge }
          : { id: item.id, title: getGroupTitle(item.group), icon: getGroupIcon(item.group) }
      ),
    [getGroupIcon, getGroupTitle, orderedItems]
  );

  return {
    orientation,
    t,
    groups,
    activeGroupId,
    bottomBarConfig,
    orderedItems,
    visibleIds,
    useCustomItems,
    isOnlyHome,
    rightButtons,
    isFullscreen,
    sortOpen,
    setSortOpen,
    sortRestoreFocusRef,
    sortEntries,
    taskbarOrder,
    setTaskbarOrder,
    taskbarReorder,
    workspaceHint,
    handleGroupClick,
    handleToggleFullscreen,
    getGroupTitle,
    getGroupIcon,
    getPageTitle,
    activateItem,
    closeGroup,
    closeAllGroups,
    openSort,
    openContextPage: (group: PageGroup, page: "terminal" | "git") => {
      const path = getWorkspacePath(group);
      const frame = useFrameStore.getState();
      if (page === "terminal") frame.addTerminalGroup(path, undefined, group.id);
      else frame.addGitGroup(path, undefined, group.id);
    },
  };
}
