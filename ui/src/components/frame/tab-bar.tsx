import { Box, Edit, Eye, FileDiff, FileText, FolderOpen, GitGraph, RefreshCw, Terminal, X } from "lucide-react";
import { motion } from "motion/react";
import React, { useCallback, useEffect, useRef } from "react";
import { useDefaultPageCloseButton } from "@/hooks/use-default-page-close-button";
import { useReorderableList } from "@/hooks/use-reorderable-list";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { type TabItem, useFrameStore, type ViewType } from "@/stores/frame-store";
import { getPreviewType, usePreviewStore } from "@/stores/preview-store";

interface TabBarProps {
  onRefresh?: () => void;
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

const TabBar: React.FC<TabBarProps> = ({ onRefresh, onBackToList }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const removeCurrentTab = useFrameStore((s) => s.removeCurrentTab);
  const reorderCurrentTabs = useFrameStore((s) => s.reorderCurrentTabs);
  const pinTab = useFrameStore((s) => s.pinTab);
  const currentView = useFrameStore((s) => s.getCurrentView());
  const defaultCloseButton = useDefaultPageCloseButton();

  const editMode = usePreviewStore((s) => s.editMode);
  const setEditMode = usePreviewStore((s) => s.setEditMode);
  const file = usePreviewStore((s) => s.file);

  const lastClickTime = useRef<Record<string, number>>({});
  const tabsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabIds = tabs.map((tab) => tab.id);
  const tabReorder = useReorderableList({
    ids: tabIds,
    axis: "x",
    onReorder: reorderCurrentTabs,
    disabled: tabs.length < 2,
  });

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
    [removeCurrentTab]
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
    [setCurrentActiveTab, pinTab]
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
    if (activeGroup.type === "group" && currentView) {
      return VIEW_ICONS[currentView];
    }
    if (activeGroup.type === "tool") return <Box size={18} />;
    return <FolderOpen size={18} />;
  };

  const showBackButton = activeGroup?.type === "group" || tabs.length > 0;
  const showDefaultCloseButton = !showBackButton && Boolean(defaultCloseButton);
  const showActionButton = activeGroup?.type !== "home" && activeGroup?.type !== "settings";

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
      {(showBackButton || showDefaultCloseButton) && (
        <div className="flex items-center gap-2 shrink-0">
          {showBackButton ? (
            <button
              type="button"
              onClick={handleBackClick}
              className={`${cornerButtonClass} ${activeTabId === null ? "bg-ide-accent text-ide-bg border-ide-accent" : ""}`}
              title={t("common.backToList")}
            >
              {getViewIcon()}
            </button>
          ) : (
            <button
              type="button"
              onClick={defaultCloseButton?.onClick}
              disabled={defaultCloseButton?.disabled}
              className={cornerButtonClass}
              title={defaultCloseButton?.title || defaultCloseButton?.label}
              aria-label={defaultCloseButton?.title || defaultCloseButton?.label}
            >
              {defaultCloseButton?.icon}
            </button>
          )}
          {tabs.length > 0 && <div className="w-px h-5 bg-ide-border mx-1 shrink-0" />}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar touch-pan-x h-full">
          {tabs.map((tab) => (
            <motion.div
              key={tab.id}
              layout={tabReorder.activeId !== tab.id}
              transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
              {...tabReorder.bindItem(tab.id)}
              ref={(el) => {
                if (el) tabsRef.current.set(tab.id, el);
                else tabsRef.current.delete(tab.id);
              }}
              onClick={() => handleTabClick(tab.id)}
              style={tabReorder.getItemStyle(tab.id)}
              className={cn(
                "shrink-0 px-2 h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer relative",
                tabReorder.activeId === tab.id && "opacity-95 shadow-lg cursor-grabbing",
                tabReorder.activeId && tabReorder.overId === tab.id && "ring-1 ring-ide-accent",
                activeTabId === tab.id
                  ? "bg-ide-panel border-ide-accent text-ide-accent border-b-2 shadow-sm"
                  : "bg-transparent border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
              )}
            >
              {getTabIcon(tab)}
              <span className={`max-w-[80px] truncate font-medium ${!tab.pinned ? "italic" : ""}`}>{tab.title}</span>
              {tab.closable !== false && (
                <button
                  data-drag-ignore
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className="hover:text-red-500 rounded-full p-0.5 hover:bg-ide-bg"
                >
                  <X size={12} />
                </button>
              )}
            </motion.div>
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
                title={editMode ? t("common.view") : t("common.edit")}
              >
                {editMode ? <Eye size={18} /> : <Edit size={18} />}
              </button>
            ) : (
              <button onClick={onRefresh} className={cornerButtonClass} title={t("common.refresh")}>
                <RefreshCw size={18} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default TabBar;
