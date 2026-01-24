import React, { useCallback, useRef, useEffect } from "react";
import {
  X,
  Plus,
  RefreshCw,
  FolderOpen,
  GitGraph,
  FileText,
  FileDiff,
  Terminal,
  Box,
  Edit,
  Eye,
} from "lucide-react";
import {
  useFrameStore,
  type TabItem,
  type ViewType,
} from "@/stores/frameStore";
import { usePreviewStore, getPreviewType } from "@/stores/previewStore";

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
  terminal: <Terminal size={12} />,
};

const TabBar: React.FC<TabBarProps> = ({ onAction, onBackToList }) => {
  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const removeCurrentTab = useFrameStore((s) => s.removeCurrentTab);
  const pinTab = useFrameStore((s) => s.pinTab);
  const currentView = useFrameStore((s) => s.getCurrentView());

  const editMode = usePreviewStore((s) => s.editMode);
  const setEditMode = usePreviewStore((s) => s.setEditMode);
  const file = usePreviewStore((s) => s.file);

  const lastClickTime = useRef<Record<string, number>>({});
  const tabsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (activeTabId) {
      const tabElement = tabsRef.current.get(activeTabId);
      if (tabElement) {
        tabElement.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      }
    }
  }, [activeTabId]);

  const handleToggleEdit = useCallback(() => {
    if (!editMode && activeTabId) {
      pinTab(activeTabId);
    }
    setEditMode(!editMode);
  }, [editMode, activeTabId, pinTab, setEditMode]);

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      removeCurrentTab(tabId);
    },
    [removeCurrentTab],
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      const now = Date.now();
      const lastClick = lastClickTime.current[tabId] || 0;
      if (now - lastClick < 300) {
        pinTab(tabId);
      }
      lastClickTime.current[tabId] = now;
      setCurrentActiveTab(tabId);
    },
    [setCurrentActiveTab, pinTab],
  );

  const handleBackClick = useCallback(() => {
    setCurrentActiveTab(null);
    onBackToList?.();
  }, [setCurrentActiveTab, onBackToList]);

  const getTabIcon = (tab: TabItem) => {
    const type = (tab.data?.type as string) || "code";
    return TAB_ICONS[type] || TAB_ICONS.code;
  };

  const getViewIcon = () => {
    if (!activeGroup) return <FolderOpen size={18} />;
    if (activeGroup.type === "folder" && currentView) {
      return VIEW_ICONS[currentView];
    }
    if (activeGroup.type === "terminal") return <Terminal size={18} />;
    if (activeGroup.type === "plugin") return <Box size={18} />;
    return <FolderOpen size={18} />;
  };

  const isFilesView =
    activeGroup?.type === "folder" &&
    currentView === "files" &&
    activeTabId === null;
  const isGitView = activeGroup?.type === "folder" && currentView === "git";
  const showRefreshButton = isFilesView || isGitView;
  const showBackButton = activeGroup?.type === "folder" || tabs.length > 0;
  const showActionButton =
    activeGroup?.type !== "home" && activeGroup?.type !== "settings";

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isCodeFile =
    activeTab &&
    file &&
    (getPreviewType(file.mimeType, file.extension) === "code" ||
      getPreviewType(file.mimeType, file.extension) === "markdown");
  const showEditToggle = isCodeFile && activeTabId;
  const cornerButtonClass =
    "shrink-0 w-8 h-8 rounded-md text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors";

  return (
    <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center px-2 gap-2 shrink-0 transition-colors duration-300 overflow-hidden">
      {showBackButton && (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleBackClick}
            className={`${cornerButtonClass} ${activeTabId === null ? "bg-ide-accent text-ide-bg border-ide-accent" : ""}`}
            title="Back to List"
          >
            {getViewIcon()}
          </button>
          {tabs.length > 0 && (
            <div className="w-px h-5 bg-ide-border mx-1 shrink-0" />
          )}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar touch-pan-x h-full">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabsRef.current.set(tab.id, el);
                else tabsRef.current.delete(tab.id);
              }}
              onClick={() => handleTabClick(tab.id)}
              className={`shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer ${
                activeTabId === tab.id
                  ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                  : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
              }`}
            >
              {getTabIcon(tab)}
              <span
                className={`max-w-[80px] truncate font-medium ${!tab.pinned ? "italic" : ""}`}
              >
                {tab.title}
              </span>
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
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {showActionButton && (
          <>
            {showEditToggle ? (
              <button
                onClick={handleToggleEdit}
                className={`${cornerButtonClass} ${editMode ? "bg-ide-accent text-ide-bg border-ide-accent" : ""}`}
                title={editMode ? "View" : "Edit"}
              >
                {editMode ? <Eye size={18} /> : <Edit size={18} />}
              </button>
            ) : (
              <button
                onClick={onAction}
                className={cornerButtonClass}
                title={showRefreshButton ? "Refresh" : "New"}
              >
                {showRefreshButton ? (
                  <RefreshCw size={18} />
                ) : (
                  <Plus size={18} />
                )}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default TabBar;
