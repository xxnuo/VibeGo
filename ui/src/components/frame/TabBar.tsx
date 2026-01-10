import React, { useCallback } from 'react';
import { X, Plus, RefreshCw, FolderOpen, GitGraph, FileText, FileDiff, Box, Terminal } from 'lucide-react';
import { useFrameStore, type TabItem, type ViewType } from '@/stores/frameStore';

interface TabBarProps {
  onAction?: () => void;
  onBackToList?: () => void;
}

const VIEW_ICONS: Record<ViewType, React.ReactNode> = {
  files: <FolderOpen size={18} />,
  git: <GitGraph size={18} />,
  terminal: <Terminal size={18} />,
};

const TAB_ICONS: Record<string, React.ReactNode> = {
  code: <FileText size={14} />,
  diff: <FileDiff size={14} />,
  terminal: <Box size={14} />,
};

const TabBar: React.FC<TabBarProps> = ({ onAction, onBackToList }) => {
  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const removeCurrentTab = useFrameStore((s) => s.removeCurrentTab);
  const currentView = useFrameStore((s) => s.getCurrentView());

  const handleCloseTab = useCallback((e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    removeCurrentTab(tabId);
  }, [removeCurrentTab]);

  const handleTabClick = useCallback((tabId: string) => {
    setCurrentActiveTab(tabId);
  }, [setCurrentActiveTab]);

  const handleBackClick = useCallback(() => {
    setCurrentActiveTab(null);
    onBackToList?.();
  }, [setCurrentActiveTab, onBackToList]);

  const getTabIcon = (tab: TabItem) => {
    const type = (tab.data?.type as string) || 'code';
    return TAB_ICONS[type] || TAB_ICONS.code;
  };

  const getViewIcon = () => {
    if (!activeGroup) return <FolderOpen size={18} />;
    if (activeGroup.type === 'workspace' && currentView) {
      return VIEW_ICONS[currentView];
    }
    if (activeGroup.type === 'terminal') return <Terminal size={18} />;
    if (activeGroup.type === 'plugin') return <Box size={18} />;
    return <FolderOpen size={18} />;
  };

  const isGitView = activeGroup?.type === 'workspace' && currentView === 'git';
  const showBackButton = activeGroup?.type === 'workspace' || tabs.length > 0;

  return (
    <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center overflow-x-auto no-scrollbar px-2 gap-2 shrink-0 transition-colors duration-300">
      {showBackButton && (
        <>
          <button
            onClick={handleBackClick}
            className={`shrink-0 h-8 w-8 flex items-center justify-center rounded-md border transition-all ${
              activeTabId === null
                ? 'bg-ide-accent text-ide-bg border-ide-accent shadow-glow'
                : 'bg-transparent text-ide-mute border-transparent hover:bg-ide-panel hover:text-ide-text'
            }`}
            title="Back to List"
          >
            {getViewIcon()}
          </button>
          {tabs.length > 0 && (
            <div className="w-px h-5 bg-ide-border mx-1 shrink-0" />
          )}
        </>
      )}

      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => handleTabClick(tab.id)}
          className={`shrink-0 px-3 h-8 rounded-md flex items-center gap-2 text-xs border transition-all cursor-pointer ${
            activeTabId === tab.id
              ? 'bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm'
              : 'bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text'
          }`}
        >
          {getTabIcon(tab)}
          <span className="max-w-[100px] truncate font-medium">{tab.title}</span>
          {tab.closable !== false && (
            <button
              onClick={(e) => handleCloseTab(e, tab.id)}
              className="hover:text-red-500 rounded-full p-0.5 hover:bg-ide-bg"
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}

      <button
        onClick={onAction}
        className="shrink-0 w-8 h-8 rounded-md ml-auto text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors"
        title={isGitView ? 'Refresh' : 'New'}
      >
        {isGitView ? <RefreshCw size={18} /> : <Plus size={18} />}
      </button>
    </div>
  );
};

export default TabBar;
