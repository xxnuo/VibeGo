import {
  Box,
  FolderOpen,
  Home,
  Maximize,
  Menu,
  Minimize,
  Plus,
  Settings,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import NavIcon from "@/components/frame/nav-icon";
import WorkspaceHintBubble, {
  getWorkspaceGroupTitle,
  getWorkspacePath,
  useWorkspaceHint,
} from "@/components/frame/workspace-hint-bubble";
import { useTranslation } from "@/lib/i18n";
import { pageRegistry } from "@/pages/registry";
import { useAppStore } from "@/stores/app-store";
import {
  type BottomBarButton,
  type GenericGroup,
  type PageGroup,
  type PageType,
  type ToolGroup,
  useFrameStore,
} from "@/stores/frame-store";

const PAGE_TYPE_ICONS: Record<PageType, React.ReactNode> = {
  files: <NavIcon icon={pageRegistry.get("files")?.icon} size={24} />,
  git: <NavIcon icon={pageRegistry.get("git")?.icon} size={24} />,
  terminal: <NavIcon icon={pageRegistry.get("terminal")?.icon} size={24} />,
};

interface SideBarProps {
  onMenuClick?: () => void;
  onNewPage?: () => void;
}

const GROUP_TYPE_ICONS = {
  home: <Home size={24} />,
  group: <FolderOpen size={24} />,
  tool: <Box size={24} />,
  settings: <Settings size={24} />,
};

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
  return <NavIcon icon={page?.icon} size={24} />;
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
          className={`flex flex-col w-full items-center gap-1 p-1 ${
            hasMultipleGroups ? "bg-ide-panel/70 border border-ide-border/30 rounded-xl shadow-inner" : ""
          }`}
        >
          {genericGroup.pages.map((page) => (
            <button
              key={page.id}
              onClick={(event) => onPageClick(genericGroup, page.id, event.currentTarget)}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                isActive && genericGroup.activePageId === page.id
                  ? "text-ide-accent bg-ide-panel"
                  : "text-ide-mute hover:text-ide-text hover:bg-ide-panel/50"
              }`}
              title={workspacePath ? `${getPageTitle(page.type)} - ${workspacePath}` : getPageTitle(page.type)}
            >
              {PAGE_TYPE_ICONS[page.type] || <Box size={24} />}
            </button>
          ))}
        </div>
      );
    }
    return (
      <button
        onClick={(event) => onGroupClick(group, event.currentTarget)}
        className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
          isActive
            ? "bg-ide-panel text-ide-accent shadow-sm"
            : "text-ide-mute hover:text-ide-text hover:bg-ide-panel/50"
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
        className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
          isActive
            ? "bg-ide-panel text-ide-accent shadow-sm"
            : "text-ide-mute hover:text-ide-text hover:bg-ide-panel/50"
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
      className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
        isActive ? "bg-ide-panel text-ide-accent shadow-sm" : "text-ide-mute hover:text-ide-text hover:bg-ide-panel/50"
      }`}
      title={getTitle(group)}
    >
      {GROUP_TYPE_ICONS[group.type] || GROUP_TYPE_ICONS.tool}
    </button>
  );
};

const SideBar: React.FC<SideBarProps> = ({ onMenuClick, onNewPage }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const groups = useFrameStore((s) => s.groups);
  const activeGroupId = useFrameStore((s) => s.activeGroupId);
  const bottomBarConfig = useFrameStore((s) => s.bottomBarConfig);
  const setActiveGroup = useFrameStore((s) => s.setActiveGroup);
  const setActivePage = useFrameStore((s) => s.setActivePage);
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const { hint: workspaceHint, showWorkspaceHint } = useWorkspaceHint("right");

  const [compactMode] = useState(false);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const actionButtonClass =
    "w-12 h-12 rounded-xl text-ide-mute hover:bg-ide-panel hover:text-ide-text flex items-center justify-center transition-colors";

  const handleGroupClick = useCallback(
    (group: PageGroup, target: HTMLElement) => {
      if (group.type === "group") {
        showWorkspaceHint(group, target);
      }
      if (activeGroupId === group.id) {
        setCurrentActiveTab(null);
      }
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
      document.documentElement.requestFullscreen?.();
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
            icon: isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />,
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
        default:
          return String(pageType);
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

  if (!bottomBarConfig.show) {
    return null;
  }

  const useCustomItems = bottomBarConfig.customItems && bottomBarConfig.customItems.length > 0;
  const hasMultipleGroups = groups.length > 1;

  return (
    <>
      <aside className="hidden md:flex w-16 h-full flex-col items-center py-4 bg-ide-panel border-r border-ide-border z-20 shadow-[5px_0_15px_rgba(0,0,0,0.1)] gap-4">
        <button onClick={onMenuClick} className={actionButtonClass} title={t("common.menu") || "Menu"}>
          <Menu size={24} />
        </button>

        <div className="w-10 h-px bg-ide-border/50 shrink-0" />

        <div className="flex-1 flex flex-col gap-2 overflow-y-auto no-scrollbar w-full px-2 items-center">
          {useCustomItems
            ? bottomBarConfig.customItems!.map((item) => (
                <button
                  key={item.id}
                  onClick={item.onClick}
                  className={`w-12 h-12 rounded-xl flex items-center justify-center relative transition-all ${
                    bottomBarConfig.activeItemId === item.id
                      ? "bg-ide-panel text-ide-accent shadow-sm border border-ide-border/50"
                      : "text-ide-mute hover:text-ide-text hover:bg-ide-panel/50"
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
              ))
            : groups.map((group) => (
                <GroupButton
                  key={group.id}
                  group={group}
                  isActive={activeGroupId === group.id}
                  isExpanded={shouldExpand(group)}
                  hasMultipleGroups={hasMultipleGroups}
                  getTitle={getGroupTitle}
                  getPageTitle={getPageTitle}
                  onGroupClick={handleGroupClick}
                  onPageClick={handlePageClick}
                />
              ))}

          {onNewPage && !useCustomItems && (
            <button
              onClick={onNewPage}
              className="w-12 h-12 rounded-xl flex items-center justify-center text-ide-mute hover:text-ide-accent hover:bg-ide-panel/50 transition-all mt-2"
              title={t("common.newPage")}
            >
              <Plus size={24} />
            </button>
          )}
        </div>

        <div className="w-10 h-px bg-ide-border/50 shrink-0" />

        <div className="flex flex-col gap-2 px-2 items-center">
          {rightButtons.map((button, index) => (
            <button
              key={index}
              onClick={button.onClick}
              disabled={button.disabled}
              title={button.label}
              className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
                button.active ? "bg-ide-accent text-ide-bg" : "text-ide-mute hover:bg-ide-panel hover:text-ide-text"
              } ${button.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {button.icon}
            </button>
          ))}
        </div>
      </aside>
      <WorkspaceHintBubble hint={workspaceHint} />
    </>
  );
};

export default SideBar;
