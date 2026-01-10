import React, { useCallback, useRef, useState } from 'react';
import { Menu, Files, GitGraph, Terminal, Cpu, Wifi, FolderOpen, Box, Settings, X } from 'lucide-react';
import { useFrameStore, type PageGroup, type ViewType } from '@/stores/frameStore';
import { useSettingsStore } from '@/lib/settings';
import { useTranslation, type Locale } from '@/lib/i18n';
import ContextSheet from '@/components/ui/ContextSheet';

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
  onGroupClick: (groupId: string) => void;
  onViewClick: (groupId: string, view: ViewType) => void;
  onLongPress: (group: PageGroup) => void;
}

const GroupButton: React.FC<GroupButtonProps> = ({
  group,
  isActive,
  isExpanded,
  onGroupClick,
  onViewClick,
  onLongPress,
}) => {
  const longPressTimer = useRef<number | null>(null);
  const isLongPress = useRef(false);

  const handleTouchStart = () => {
    isLongPress.current = false;
    longPressTimer.current = window.setTimeout(() => {
      isLongPress.current = true;
      onLongPress(group);
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onLongPress(group);
  };

  if (group.type === 'workspace') {
    if (isExpanded) {
      return (
        <div
          className="flex h-full items-center gap-0.5 bg-ide-panel rounded px-1"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          onContextMenu={handleContextMenu}
        >
          {(['files', 'git', 'terminal'] as ViewType[]).map((view) => (
            <button
              key={view}
              onClick={() => onViewClick(group.id, view)}
              className={`px-2 h-full rounded flex items-center transition-all ${
                isActive && group.activeView === view
                  ? 'text-ide-accent'
                  : 'text-ide-mute hover:text-ide-text'
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
        onClick={() => !isLongPress.current && onGroupClick(group.id)}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onContextMenu={handleContextMenu}
        className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
          isActive ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'
        }`}
        title={group.name}
      >
        {GROUP_TYPE_ICONS.workspace}
      </button>
    );
  }

  return (
    <button
      onClick={() => !isLongPress.current && onGroupClick(group.id)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={handleContextMenu}
      className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
        isActive ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'
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
  const removeGroup = useFrameStore((s) => s.removeGroup);

  const locale = (useSettingsStore((s) => s.settings.locale) || 'zh') as Locale;
  const t = useTranslation(locale);

  const [compactMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastClickTime = useRef<Record<string, number>>({});

  const [contextSheet, setContextSheet] = useState<{
    open: boolean;
    group: PageGroup | null;
  }>({ open: false, group: null });

  const handleGroupClick = useCallback((groupId: string) => {
    const now = Date.now();
    const lastClick = lastClickTime.current[groupId] || 0;

    if (now - lastClick < 300 && activeGroupId === groupId) {
      setCurrentActiveTab(null);
    }

    lastClickTime.current[groupId] = now;
    setActiveGroup(groupId);
  }, [activeGroupId, setActiveGroup, setCurrentActiveTab]);

  const handleViewClick = useCallback((groupId: string, view: ViewType) => {
    setActiveGroup(groupId);
    setWorkspaceView(groupId, view);
  }, [setActiveGroup, setWorkspaceView]);

  const handleLongPress = useCallback((group: PageGroup) => {
    setContextSheet({ open: true, group });
  }, []);

  const handleCloseContextSheet = useCallback(() => {
    setContextSheet({ open: false, group: null });
  }, []);

  const handleCloseGroup = useCallback(() => {
    if (contextSheet.group) {
      removeGroup(contextSheet.group.id);
    }
    handleCloseContextSheet();
  }, [contextSheet.group, removeGroup, handleCloseContextSheet]);

  const shouldExpand = (group: PageGroup) => {
    if (group.type !== 'workspace') return false;
    if (compactMode) return activeGroupId === group.id;
    return true;
  };

  const contextMenuItems = contextSheet.group ? [
    {
      icon: <X size={16} />,
      label: t('contextMenu.closeGroup'),
      onClick: handleCloseGroup,
      variant: 'danger' as const,
    },
  ] : [];

  if (!bottomBarConfig.show) {
    return null;
  }

  const useCustomItems = bottomBarConfig.customItems && bottomBarConfig.customItems.length > 0;

  return (
    <>
      <footer className="h-14 bg-ide-panel border-t border-ide-border flex items-center justify-between z-20 shadow-[0_-5px_15px_rgba(0,0,0,0.1)]">
        <button
          onClick={onMenuClick}
          className="h-full px-4 flex items-center gap-3 hover:bg-ide-bg transition-colors border-r border-ide-border group"
        >
          <div className="h-8 w-8 flex items-center justify-center rounded-md bg-transparent text-ide-mute border border-ide-border group-hover:border-ide-accent group-hover:text-ide-accent transition-colors">
            <Menu size={18} />
          </div>
        </button>

        <div
          ref={containerRef}
          className="flex h-10 bg-ide-bg rounded-lg p-1 border border-ide-border gap-1 overflow-x-auto no-scrollbar max-w-[60vw]"
        >
          {useCustomItems ? (
            bottomBarConfig.customItems!.map((item) => (
              <button
                key={item.id}
                onClick={item.onClick}
                className={`px-3 h-full rounded flex items-center gap-2 transition-all relative ${
                  bottomBarConfig.activeItemId === item.id
                    ? 'bg-ide-panel text-ide-accent shadow-sm'
                    : 'text-ide-mute hover:text-ide-text'
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
          ) : (
            groups.map((group) => (
              <GroupButton
                key={group.id}
                group={group}
                isActive={activeGroupId === group.id}
                isExpanded={shouldExpand(group)}
                onGroupClick={handleGroupClick}
                onViewClick={handleViewClick}
                onLongPress={handleLongPress}
              />
            ))
          )}
        </div>

        <div className="flex items-center gap-2 px-4">
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

      <ContextSheet
        open={contextSheet.open}
        onClose={handleCloseContextSheet}
        title={contextSheet.group?.name}
        items={contextMenuItems}
      />
    </>
  );
};

export default BottomBar;
