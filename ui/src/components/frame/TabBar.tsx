import React, { useCallback, useRef } from 'react';
import { X, Plus, RefreshCw, FolderOpen, GitGraph, FileText, FileDiff, Box, Terminal, Edit, Eye } from 'lucide-react';
import { useFrameStore, type TabItem, type ViewType, type HeaderButton, type HeaderButtonVariant } from '@/stores/frameStore';
import { usePreviewStore, getPreviewType } from '@/stores/previewStore';

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
  code: <FileText size={12} />,
  diff: <FileDiff size={12} />,
  terminal: <Box size={12} />,
};

const getButtonClass = (variant?: HeaderButtonVariant, isDefault = false) => {
  if (variant === 'accent' || isDefault) {
    return 'bg-ide-accent text-ide-bg border-ide-accent shadow-glow';
  }
  if (variant === 'outline') {
    return 'bg-transparent text-ide-mute border-ide-border hover:bg-ide-panel hover:text-ide-text';
  }
  return 'bg-transparent text-ide-mute border-transparent hover:bg-ide-panel hover:text-ide-text';
};

const HeaderButtonComponent: React.FC<{ button: HeaderButton; isActive?: boolean }> = ({ button, isActive }) => {
  const variant = isActive ? 'accent' : button.variant;
  return (
    <button
      onClick={button.onClick}
      className={`shrink-0 h-8 ${button.label ? 'px-3' : 'w-8'} flex items-center justify-center gap-1.5 rounded-md border transition-all text-xs ${getButtonClass(variant)}`}
    >
      {button.icon}
      {button.label && <span>{button.label}</span>}
    </button>
  );
};

const TabBar: React.FC<TabBarProps> = ({ onAction, onBackToList }) => {
  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const removeCurrentTab = useFrameStore((s) => s.removeCurrentTab);
  const pinTab = useFrameStore((s) => s.pinTab);
  const currentView = useFrameStore((s) => s.getCurrentView());
  const headerConfig = useFrameStore((s) => s.headerConfig);

  const editMode = usePreviewStore((s) => s.editMode);
  const setEditMode = usePreviewStore((s) => s.setEditMode);
  const file = usePreviewStore((s) => s.file);

  const lastClickTime = useRef<Record<string, number>>({});

  const handleToggleEdit = useCallback(() => {
    if (!editMode && activeTabId) {
      pinTab(activeTabId);
    }
    setEditMode(!editMode);
  }, [editMode, activeTabId, pinTab, setEditMode]);

  const handleCloseTab = useCallback((e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    removeCurrentTab(tabId);
  }, [removeCurrentTab]);

  const handleTabClick = useCallback((tabId: string) => {
    const now = Date.now();
    const lastClick = lastClickTime.current[tabId] || 0;
    if (now - lastClick < 300) {
      pinTab(tabId);
    }
    lastClickTime.current[tabId] = now;
    setCurrentActiveTab(tabId);
  }, [setCurrentActiveTab, pinTab]);

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

  const isFilesView = activeGroup?.type === 'workspace' && currentView === 'files' && activeTabId === null;
  const isGitView = activeGroup?.type === 'workspace' && currentView === 'git';
  const showRefreshButton = isFilesView || isGitView;
  const showBackButton = activeGroup?.type === 'workspace' || tabs.length > 0;

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isCodeFile = activeTab && file && (
    getPreviewType(file.mimeType, file.extension) === 'code' ||
    getPreviewType(file.mimeType, file.extension) === 'markdown'
  );
  const showEditToggle = isCodeFile && activeTabId;

  if (headerConfig) {
    return (
      <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center overflow-x-auto no-scrollbar px-2 gap-2 shrink-0 transition-colors duration-300">
        {headerConfig.leftButton && (
          <HeaderButtonComponent button={headerConfig.leftButton} isActive={headerConfig.leftButton.variant === 'accent'} />
        )}

        {headerConfig.title ? (
          <div className="flex-1 text-center">
            <span className="text-sm font-medium text-ide-text">{headerConfig.title}</span>
          </div>
        ) : headerConfig.showTabs !== false && tabs.length > 0 ? (
          <div className="flex items-center gap-2 flex-1 overflow-x-auto no-scrollbar">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                onClick={() => handleTabClick(tab.id)}
                className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
                  activeTabId === tab.id
                    ? 'bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm'
                    : 'bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text'
                }`}
              >
                {getTabIcon(tab)}
                <span className={`max-w-[80px] truncate font-medium ${!tab.pinned ? 'italic' : ''}`}>{tab.title}</span>
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
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {headerConfig.rightButton && (
          <HeaderButtonComponent button={headerConfig.rightButton} />
        )}
      </div>
    );
  }

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
          className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
            activeTabId === tab.id
              ? 'bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm'
              : 'bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text'
          }`}
        >
          {getTabIcon(tab)}
          <span className={`max-w-[80px] truncate font-medium ${!tab.pinned ? 'italic' : ''}`}>{tab.title}</span>
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

      <div className="ml-auto flex items-center gap-2">
        {showEditToggle && (
          <button
            onClick={handleToggleEdit}
            className={`shrink-0 h-8 px-3 rounded-md flex items-center gap-1.5 text-xs border transition-all ${
              editMode
                ? 'bg-ide-accent text-ide-bg border-ide-accent'
                : 'bg-transparent text-ide-mute border-ide-border hover:bg-ide-panel hover:text-ide-text'
            }`}
          >
            {editMode ? <Eye size={14} /> : <Edit size={14} />}
            {editMode ? 'View' : 'Edit'}
          </button>
        )}
        <button
          onClick={onAction}
          className="shrink-0 w-8 h-8 rounded-md text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors"
          title={showRefreshButton ? 'Refresh' : 'New'}
        >
          {showRefreshButton ? <RefreshCw size={18} /> : <Plus size={18} />}
        </button>
      </div>
    </div>
  );
};

export default TabBar;
