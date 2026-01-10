import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Menu,
  Files,
  GitGraph,
  Terminal,
  Cpu,
  Wifi,
  FolderOpen,
  Box,
  Settings,
  Maximize,
  Minimize,
} from "lucide-react";
import {
  useFrameStore,
  type PageGroup,
  type ViewType,
  type BottomBarButton,
} from "@/stores/frameStore";

interface BottomBarProps {
  onMenuClick?: () => void;
}

const VIEW_ICONS: Record<ViewType, React.ReactNode> = {
  files: <Files size={16} />,
  git: <GitGraph size={16} />,
  terminal: <Terminal size={16} />,
};

const GROUP_TYPE_ICONS = {
  workspace: <FolderOpen size={16} />,
  terminal: <Terminal size={16} />,
  plugin: <Box size={16} />,
  settings: <Settings size={16} />,
};

interface GroupButtonProps {
  group: PageGroup;
  isActive: boolean;
  isExpanded: boolean;
  hasMultipleGroups: boolean;
  onGroupClick: (groupId: string) => void;
  onViewClick: (groupId: string, view: ViewType) => void;
}

const GroupButton: React.FC<GroupButtonProps> = ({
  group,
  isActive,
  isExpanded,
  hasMultipleGroups,
  onGroupClick,
  onViewClick,
}) => {
  if (group.type === "workspace") {
    if (isExpanded) {
      return (
        <div
          className={`flex h-full items-center gap-0.5 px-1 ${
            hasMultipleGroups
              ? "bg-ide-panel/70 border border-ide-border/30 rounded-md shadow-inner"
              : ""
          }`}
        >
          {(["files", "git", "terminal"] as ViewType[]).map((view) => (
            <button
              key={view}
              onClick={() => onViewClick(group.id, view)}
              className={`px-2 h-full rounded flex items-center transition-all ${
                isActive && group.activeView === view
                  ? "text-ide-accent"
                  : "text-ide-mute hover:text-ide-text"
              }`}
            >
              {VIEW_ICONS[view]}
            </button>
          ))}
        </div>
      );
    }
    return (
      <button
        onClick={() => onGroupClick(group.id)}
        className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
          isActive
            ? "bg-ide-panel text-ide-accent shadow-sm"
            : "text-ide-mute hover:text-ide-text"
        }`}
        title={group.name}
      >
        {GROUP_TYPE_ICONS.workspace}
      </button>
    );
  }

  return (
    <button
      onClick={() => onGroupClick(group.id)}
      className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
        isActive
          ? "bg-ide-panel text-ide-accent shadow-sm"
          : "text-ide-mute hover:text-ide-text"
      }`}
      title={group.name}
    >
      {GROUP_TYPE_ICONS[group.type] || GROUP_TYPE_ICONS.plugin}
    </button>
  );
};

const BottomBar: React.FC<BottomBarProps> = ({ onMenuClick }) => {
  const groups = useFrameStore((s) => s.groups);
  const activeGroupId = useFrameStore((s) => s.activeGroupId);
  const bottomBarConfig = useFrameStore((s) => s.bottomBarConfig);
  const setActiveGroup = useFrameStore((s) => s.setActiveGroup);
  const setWorkspaceView = useFrameStore((s) => s.setWorkspaceView);
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);

  const [compactMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastClickTime = useRef<Record<string, number>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const cornerButtonClass =
    "shrink-0 w-8 h-8 rounded-md text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors";

  const handleGroupClick = useCallback(
    (groupId: string) => {
      const now = Date.now();
      const lastClick = lastClickTime.current[groupId] || 0;

      if (now - lastClick < 300 && activeGroupId === groupId) {
        setCurrentActiveTab(null);
      }

      lastClickTime.current[groupId] = now;
      setActiveGroup(groupId);
    },
    [activeGroupId, setActiveGroup, setCurrentActiveTab],
  );

  const handleViewClick = useCallback(
    (groupId: string, view: ViewType) => {
      setActiveGroup(groupId);
      setWorkspaceView(groupId, view);
    },
    [setActiveGroup, setWorkspaceView],
  );

  const shouldExpand = (group: PageGroup) => {
    if (group.type !== "workspace") return false;
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
            icon: isFullscreen ? (
              <Minimize size={16} />
            ) : (
              <Maximize size={16} />
            ),
            label: isFullscreen ? "Exit Fullscreen" : "Fullscreen",
            onClick: handleToggleFullscreen,
            active: isFullscreen,
          },
        ];

  if (!bottomBarConfig.show) {
    return null;
  }

  const useCustomItems =
    bottomBarConfig.customItems && bottomBarConfig.customItems.length > 0;
  const hasMultipleGroups = groups.length > 1;

  return (
    <>
      <footer className="h-14 pb-safe bg-ide-panel border-t border-ide-border flex items-center justify-between z-20 shadow-[0_-5px_15px_rgba(0,0,0,0.1)]">
        <button
          onClick={onMenuClick}
          className="h-full px-4 flex items-center gap-3"
        >
          <div className={cornerButtonClass}>
            <Menu size={18} />
          </div>
        </button>

        <div
          ref={containerRef}
          className="flex h-10 bg-ide-bg rounded-lg p-1 border border-ide-border gap-1 overflow-x-auto no-scrollbar max-w-[70vw]"
        >
          {useCustomItems
            ? bottomBarConfig.customItems!.map((item) => (
                <button
                  key={item.id}
                  onClick={item.onClick}
                  className={`px-3 h-full rounded flex items-center gap-2 transition-all relative ${
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
              ))
            : groups.map((group) => (
                <GroupButton
                  key={group.id}
                  group={group}
                  isActive={activeGroupId === group.id}
                  isExpanded={shouldExpand(group)}
                  hasMultipleGroups={hasMultipleGroups}
                  onGroupClick={handleGroupClick}
                  onViewClick={handleViewClick}
                />
              ))}
        </div>

        <div className="flex items-center gap-2 px-4">
          <div className="flex items-center gap-2">
            {rightButtons.map((button, index) => (
              <button
                key={index}
                onClick={button.onClick}
                disabled={button.disabled}
                title={button.label}
                className={`${cornerButtonClass} ${button.label ? "px-3" : "w-8"} gap-1.5 text-xs ${button.active ? "bg-ide-accent text-ide-bg border-ide-accent" : ""} ${button.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span className="text-[16px] leading-none">{button.icon}</span>
                {button.label && (
                  <span className="hidden sm:inline">{button.label}</span>
                )}
              </button>
            ))}
          </div>
          <div className="hidden sm:flex items-center gap-3 text-ide-mute text-[10px] font-bold">
            <div className="flex items-center gap-1">
              <Cpu size={14} />
              <span>12%</span>
            </div>
            <div className="flex items-center gap-1 text-ide-accent animate-pulse">
              <Wifi size={14} />
              <span>ONLINE</span>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
};

export default BottomBar;
