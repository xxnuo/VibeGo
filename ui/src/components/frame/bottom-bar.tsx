import { Box, FolderOpen, Home, Maximize, Menu, Minimize, Plus, Settings } from "lucide-react";
import { motion } from "motion/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import NavIcon from "@/components/frame/nav-icon";
import { TaskbarItemMenu, TaskbarSortDialog, type TaskbarSortEntry } from "@/components/frame/taskbar-item-menu";
import WorkspaceHintBubble, {
  getWorkspaceGroupTitle,
  getWorkspacePath,
  useWorkspaceHint,
} from "@/components/frame/workspace-hint-bubble";
import { useReorderableList } from "@/hooks/use-reorderable-list";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pageRegistry } from "@/pages/registry";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import {
  type BottomBarButton,
  type BottomBarConfig,
  type GenericGroup,
  type PageGroup,
  type PageType,
  type ToolGroup,
  useFrameStore,
} from "@/stores/frame-store";

interface BottomBarProps {
  onMenuClick?: () => void;
  onNewPage?: () => void;
}

const GROUP_TYPE_ICONS = {
  home: <Home size={18} />,
  group: <FolderOpen size={18} />,
  tool: <Box size={18} />,
  settings: <Settings size={18} />,
};

const REORDER_TRANSITION = { type: "spring", stiffness: 520, damping: 42, mass: 0.7 } as const;

type TaskbarItem =
  | { id: string; type: "group"; group: PageGroup }
  | { id: string; type: "custom"; item: NonNullable<BottomBarConfig["customItems"]>[number] };

interface GroupButtonProps {
  group: PageGroup;
  isActive: boolean;
  isExpanded: boolean;
  hasMultipleGroups: boolean;
  getTitle: (group: PageGroup) => string;
  getPageTitle: (pageType: PageType) => string;
  onGroupClick: (group: PageGroup, target: HTMLElement) => void;
  onPageClick: (group: GenericGroup, pageId: string, target: HTMLElement) => void;
}

const getToolIcon = (pageId: string): React.ReactNode => {
  const page = pageRegistry.get(pageId);
  return <NavIcon icon={page?.icon} size={18} />;
};

const getPageTypeIcon = (pageType: PageType): React.ReactNode => {
  const page = pageRegistry.get(pageType);
  return <NavIcon icon={page?.icon} size={18} />;
};

const GroupButton: React.FC<GroupButtonProps> = ({
  group,
  isActive,
  isExpanded,
  hasMultipleGroups,
  getTitle,
  getPageTitle,
  onGroupClick,
  onPageClick,
}) => {
  if (group.type === "group") {
    const genericGroup = group as GenericGroup;
    const workspacePath = getWorkspacePath(genericGroup);
    const groupTitle = getWorkspaceGroupTitle(genericGroup);
    if (isExpanded) {
      return (
        <div
          className={`flex h-full items-center gap-0.5 px-1 ${
            hasMultipleGroups ? "bg-ide-panel/70 border border-ide-border/30 rounded-md shadow-inner" : ""
          }`}
        >
          {genericGroup.pages.map((page) => (
            <button
              key={page.id}
              onClick={(event) => onPageClick(genericGroup, page.id, event.currentTarget)}
              className={`px-2 h-full rounded flex items-center transition-all ${
                isActive && genericGroup.activePageId === page.id
                  ? "text-ide-accent"
                  : "text-ide-mute hover:text-ide-text"
              }`}
              title={workspacePath ? `${getPageTitle(page.type)} - ${workspacePath}` : getPageTitle(page.type)}
            >
              {getPageTypeIcon(page.type)}
            </button>
          ))}
        </div>
      );
    }
    return (
      <button
        onClick={(event) => onGroupClick(group, event.currentTarget)}
        className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
          isActive ? "bg-ide-panel text-ide-accent shadow-sm" : "text-ide-mute hover:text-ide-text"
        }`}
        title={groupTitle}
      >
        {GROUP_TYPE_ICONS.group}
      </button>
    );
  }

  if (group.type === "tool") {
    const toolGroup = group as ToolGroup;
    return (
      <button
        onClick={(event) => onGroupClick(group, event.currentTarget)}
        className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
          isActive ? "bg-ide-panel text-ide-accent shadow-sm" : "text-ide-mute hover:text-ide-text"
        }`}
        title={getTitle(group)}
      >
        {getToolIcon(toolGroup.pageId)}
      </button>
    );
  }

  return (
    <button
      onClick={(event) => onGroupClick(group, event.currentTarget)}
      className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
        isActive ? "bg-ide-panel text-ide-accent shadow-sm" : "text-ide-mute hover:text-ide-text"
      }`}
      title={getTitle(group)}
    >
      {GROUP_TYPE_ICONS[group.type] || GROUP_TYPE_ICONS.tool}
    </button>
  );
};

const BottomBar: React.FC<BottomBarProps> = ({ onMenuClick, onNewPage }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const groups = useFrameStore((s) => s.groups);
  const activeGroupId = useFrameStore((s) => s.activeGroupId);
  const bottomBarConfig = useFrameStore((s) => s.bottomBarConfig);
  const setActiveGroup = useFrameStore((s) => s.setActiveGroup);
  const setActivePage = useFrameStore((s) => s.setActivePage);
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const taskbarOrder = useFrameStore((s) => s.taskbarOrder);
  const reorderTaskbarItems = useFrameStore((s) => s.reorderTaskbarItems);
  const setTaskbarOrder = useFrameStore((s) => s.setTaskbarOrder);
  const removeGroup = useFrameStore((s) => s.removeGroup);
  const closeFolderGroup = useSessionStore((s) => s.closeFolderGroup);
  const isMobile = useIsMobile();
  const { hint: workspaceHint, showWorkspaceHint } = useWorkspaceHint("top");

  const [compactMode] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastClickTime = useRef<Record<string, number>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const cornerButtonClass =
    "shrink-0 w-8 h-8 rounded-md text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors";

  const handleGroupClick = useCallback(
    (group: PageGroup, target: HTMLElement) => {
      const now = Date.now();
      const lastClick = lastClickTime.current[group.id] || 0;

      if (group.type === "group") {
        showWorkspaceHint(group, target);
      }

      if (now - lastClick < 300 && activeGroupId === group.id) {
        setCurrentActiveTab(null);
      }

      lastClickTime.current[group.id] = now;
      setActiveGroup(group.id);
    },
    [activeGroupId, setActiveGroup, setCurrentActiveTab, showWorkspaceHint]
  );

  const handlePageClick = useCallback(
    (group: GenericGroup, pageId: string, target: HTMLElement) => {
      showWorkspaceHint(group, target);
      setActiveGroup(group.id);
      setActivePage(group.id, pageId);
    },
    [setActiveGroup, setActivePage, showWorkspaceHint]
  );

  const shouldExpand = (group: PageGroup) => {
    if (group.type !== "group") return false;
    if (compactMode) return activeGroupId === group.id;
    return true;
  };

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      return;
    }
    document.exitFullscreen?.();
  }, []);

  useEffect(() => {
    const handleChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    handleChange();
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const rightButtons: BottomBarButton[] =
    bottomBarConfig.rightButtons && bottomBarConfig.rightButtons.length > 0
      ? bottomBarConfig.rightButtons
      : [
          {
            icon: isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />,
            label: isFullscreen ? t("common.exitFullscreen") : t("common.fullscreen"),
            onClick: handleToggleFullscreen,
            active: isFullscreen,
          },
        ];

  const getPageTitle = useCallback(
    (pageType: PageType) => {
      switch (pageType) {
        case "files":
          return t("sidebar.files");
        case "git":
          return t("sidebar.git");
        case "terminal":
          return t("sidebar.terminal");
      }
    },
    [t]
  );

  const getGroupTitle = useCallback(
    (group: PageGroup) => {
      if (group.type === "home") return t("common.home");
      if (group.type === "settings") return t("common.settings");
      if (group.type === "tool") {
        const page = pageRegistry.get(group.pageId);
        if (page?.nameKey) {
          const translated = t(page.nameKey);
          if (translated !== page.nameKey) return translated;
        }
        return page?.name || group.name;
      }
      return group.name;
    },
    [t]
  );

  const useCustomItems = bottomBarConfig.customItems && bottomBarConfig.customItems.length > 0;
  const hasMultipleGroups = groups.length > 1;
  const isOnlyHome = groups.length === 1 && groups[0].type === "home";
  const showGroupBar = groups.length > 0 && !useCustomItems && !isOnlyHome;
  const visibleItems: TaskbarItem[] = [
    ...(showGroupBar ? groups.map((group): TaskbarItem => ({ id: `group:${group.id}`, type: "group", group })) : []),
    ...(useCustomItems
      ? bottomBarConfig.customItems!.map((item): TaskbarItem => ({ id: `custom:${item.id}`, type: "custom", item }))
      : []),
  ];
  const visibleIds = visibleItems.map((item) => item.id);
  const orderedItems = [
    ...taskbarOrder
      .map((id) => visibleItems.find((item) => item.id === id))
      .filter((item): item is TaskbarItem => Boolean(item)),
    ...visibleItems.filter((item) => !taskbarOrder.includes(item.id)),
  ];
  const taskbarReorder = useReorderableList({
    ids: visibleIds,
    axis: "x",
    onReorder: (fromId, toId) => reorderTaskbarItems(fromId, toId, visibleIds),
    disabled: isMobile || visibleIds.length < 2,
  });

  if (!bottomBarConfig.show) {
    return null;
  }

  const getDragProps = (id: string) => ({
    ...taskbarReorder.bindItem(id),
    style: taskbarReorder.getItemStyle(id),
    className: cn(
      "shrink-0 relative transition-transform",
      taskbarReorder.activeId === id && "z-50 opacity-95 shadow-lg cursor-grabbing",
      taskbarReorder.overId === id && "ring-1 ring-ide-accent rounded-lg"
    ),
  });

  const activateItem = (taskbarItem: TaskbarItem) => {
    if (taskbarItem.type === "custom") {
      taskbarItem.item.onClick?.();
      return;
    }
    setActiveGroup(taskbarItem.group.id);
  };

  const closeGroup = async (group: PageGroup) => {
    if (group.type === "home" && groups.length <= 1) return;
    if (group.type === "group") {
      await closeFolderGroup(group.id);
      return;
    }
    removeGroup(group.id);
  };

  const closeAllGroups = async (keepId?: string) => {
    const targets = groups.filter((group) => group.id !== keepId && !(group.type === "home" && groups.length <= 1));
    for (const group of targets) {
      await closeGroup(group);
    }
  };

  const sortEntries: TaskbarSortEntry[] = orderedItems.map((item) => {
    if (item.type === "custom") {
      return { id: item.id, title: item.item.label, icon: item.item.icon, badge: item.item.badge };
    }
    const group = item.group;
    const icon =
      group.type === "tool"
        ? getToolIcon(group.pageId)
        : group.type === "group"
          ? GROUP_TYPE_ICONS.group
          : GROUP_TYPE_ICONS[group.type] || GROUP_TYPE_ICONS.tool;
    return { id: item.id, title: getGroupTitle(group), icon };
  });

  const wrapTaskbarItem = (taskbarItem: TaskbarItem, element: React.ReactElement) => {
    const isGroup = taskbarItem.type === "group";
    const canClose = isGroup && !(taskbarItem.group.type === "home" && groups.length <= 1);
    const canCloseOthers = isGroup && groups.some((group) => group.id !== taskbarItem.group.id);
    const canCloseAll = isGroup && groups.some((group) => !(group.type === "home" && groups.length <= 1));
    return (
      <TaskbarItemMenu
        title={taskbarItem.type === "custom" ? taskbarItem.item.label : getGroupTitle(taskbarItem.group)}
        onActivate={() => activateItem(taskbarItem)}
        onClose={isGroup ? () => closeGroup(taskbarItem.group) : undefined}
        onCloseOthers={isGroup ? () => closeAllGroups(taskbarItem.group.id) : undefined}
        onCloseAll={isGroup ? () => closeAllGroups() : undefined}
        onSort={() => setSortOpen(true)}
        canClose={canClose}
        canCloseOthers={canCloseOthers}
        canCloseAll={canCloseAll}
      >
        {element}
      </TaskbarItemMenu>
    );
  };

  const renderItem = (taskbarItem: TaskbarItem) => {
    if (taskbarItem.type === "group") {
      const group = taskbarItem.group;
      return wrapTaskbarItem(
        taskbarItem,
        <motion.div
          key={taskbarItem.id}
          layout={taskbarReorder.activeId !== taskbarItem.id}
          transition={REORDER_TRANSITION}
          {...getDragProps(taskbarItem.id)}
        >
          <GroupButton
            group={group}
            isActive={activeGroupId === group.id}
            isExpanded={shouldExpand(group)}
            hasMultipleGroups={hasMultipleGroups}
            getTitle={getGroupTitle}
            getPageTitle={getPageTitle}
            onGroupClick={handleGroupClick}
            onPageClick={handlePageClick}
          />
        </motion.div>
      );
    }

    if (taskbarItem.type === "custom") {
      const item = taskbarItem.item;
      return wrapTaskbarItem(
        taskbarItem,
        <motion.div
          key={taskbarItem.id}
          layout={taskbarReorder.activeId !== taskbarItem.id}
          transition={REORDER_TRANSITION}
          {...getDragProps(taskbarItem.id)}
        >
          <button
            onClick={item.onClick}
            className={`px-3 h-10 rounded flex items-center gap-2 transition-all relative ${
              bottomBarConfig.activeItemId === item.id
                ? "bg-ide-panel text-ide-accent shadow-sm"
                : "text-ide-mute hover:text-ide-text"
            }`}
            title={item.label}
          >
            {item.icon}
            {item.badge && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full px-1 min-w-[16px] h-4 flex items-center justify-center">
                {item.badge}
              </span>
            )}
          </button>
        </motion.div>
      );
    }

    return null;
  };

  return (
    <>
      <footer className="md:hidden h-14 pb-safe bg-ide-panel border-t border-ide-border flex items-center justify-between z-20 shadow-[0_-5px_15px_rgba(0,0,0,0.1)] overflow-hidden">
        <button onClick={onMenuClick} className="h-full px-4 flex items-center gap-3">
          <div className={cornerButtonClass}>
            <Menu size={18} />
          </div>
        </button>

        <div
          ref={containerRef}
          className="flex h-10 bg-ide-bg rounded-lg p-1 border border-ide-border gap-1 overflow-x-auto custom-scrollbar touch-pan-x max-w-[70vw]"
        >
          {orderedItems.length > 0 ? (
            orderedItems.map(renderItem)
          ) : isOnlyHome && onNewPage ? (
            <button
              onClick={onNewPage}
              className="px-3 h-full rounded flex items-center gap-2 transition-all text-ide-mute hover:text-ide-accent"
              title={t("common.newPage")}
            >
              <Plus size={18} />
            </button>
          ) : (
            <div className="w-8" />
          )}
          {orderedItems.length > 0 && onNewPage && !useCustomItems && (
            <button
              onClick={onNewPage}
              className="px-3 h-full rounded flex items-center gap-2 transition-all text-ide-mute hover:text-ide-accent shrink-0"
              title={t("common.newPage")}
            >
              <Plus size={18} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 px-4">
          {rightButtons.map((button, index) => (
            <button
              key={index}
              onClick={button.onClick}
              disabled={button.disabled}
              title={button.label}
              className={`${cornerButtonClass} ${button.active ? "bg-ide-accent text-ide-bg border-ide-accent" : ""} ${button.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {button.icon}
            </button>
          ))}
        </div>
      </footer>
      <TaskbarSortDialog
        open={sortOpen}
        title={t("common.sort")}
        entries={sortEntries}
        onOpenChange={setSortOpen}
        onApply={(order) => setTaskbarOrder(order)}
      />
      <WorkspaceHintBubble hint={workspaceHint} />
    </>
  );
};

export default BottomBar;
