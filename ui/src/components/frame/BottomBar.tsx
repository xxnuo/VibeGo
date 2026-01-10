import React, { useCallback, useRef, useState } from 'react';
import { Menu, Files, GitGraph, Terminal, Plus, Cpu, Wifi, FolderOpen, Box } from 'lucide-react';
import { useFrameStore, type PageGroup, type ViewType } from '@/stores/frameStore';

interface BottomBarProps {
  onMenuClick?: () => void;
  onAddGroup?: () => void;
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
};

interface GroupButtonProps {
  group: PageGroup;
  isActive: boolean;
  isExpanded: boolean;
  onGroupClick: (groupId: string) => void;
  onViewClick: (groupId: string, view: ViewType) => void;
}

const GroupButton: React.FC<GroupButtonProps> = ({
  group,
  isActive,
  isExpanded,
  onGroupClick,
  onViewClick,
}) => {
  if (group.type === 'workspace') {
    if (isExpanded) {
      return (
        <div className="flex h-full items-center gap-0.5 bg-ide-panel rounded px-1">
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
        onClick={() => onGroupClick(group.id)}
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
      onClick={() => onGroupClick(group.id)}
      className={`px-3 h-full rounded flex items-center gap-2 transition-all ${
        isActive ? 'bg-ide-panel text-ide-accent shadow-sm' : 'text-ide-mute hover:text-ide-text'
      }`}
      title={group.name}
    >
      {group.type === 'terminal' ? GROUP_TYPE_ICONS.terminal : GROUP_TYPE_ICONS.plugin}
    </button>
  );
};

const BottomBar: React.FC<BottomBarProps> = ({ onMenuClick, onAddGroup }) => {
  const groups = useFrameStore((s) => s.groups);
  const activeGroupId = useFrameStore((s) => s.activeGroupId);
  const setActiveGroup = useFrameStore((s) => s.setActiveGroup);
  const setWorkspaceView = useFrameStore((s) => s.setWorkspaceView);
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);

  const [compactMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastClickTime = useRef<Record<string, number>>({});

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

  const shouldExpand = (group: PageGroup) => {
    if (group.type !== 'workspace') return false;
    if (compactMode) return activeGroupId === group.id;
    return true;
  };

  return (
    <footer className="h-14 bg-ide-panel border-t border-ide-border flex items-center justify-between z-20 shadow-[0_-5px_15px_rgba(0,0,0,0.1)]">
      <button
        onClick={onMenuClick}
        className="h-full px-4 flex items-center gap-3 hover:bg-ide-bg transition-colors border-r border-ide-border group"
      >
        <div className="p-1.5 rounded-md border border-ide-border group-hover:border-ide-accent group-hover:text-ide-accent transition-colors">
          <Menu size={18} />
        </div>
        <span className="font-bold tracking-wider text-xs hidden sm:inline">MENU</span>
      </button>

      <div
        ref={containerRef}
        className="flex h-10 bg-ide-bg rounded-lg p-1 border border-ide-border gap-1 overflow-x-auto no-scrollbar max-w-[60vw]"
      >
        {groups.map((group) => (
          <GroupButton
            key={group.id}
            group={group}
            isActive={activeGroupId === group.id}
            isExpanded={shouldExpand(group)}
            onGroupClick={handleGroupClick}
            onViewClick={handleViewClick}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 px-4">
        <button
          onClick={onAddGroup}
          className="w-8 h-8 rounded-md flex items-center justify-center text-ide-mute hover:text-ide-accent hover:bg-ide-bg transition-all border border-ide-border"
          title="New group"
        >
          <Plus size={16} />
        </button>
        <div className="hidden sm:flex items-center gap-3 text-ide-mute text-[10px] font-bold ml-2">
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
  );
};

export default BottomBar;
