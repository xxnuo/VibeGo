import { FileDiff, FileText, Terminal, X } from "lucide-react";
import { motion } from "motion/react";
import React, { useCallback, useEffect, useRef } from "react";
import { useReorderableList } from "@/hooks/use-reorderable-list";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { type TabItem, useFrameStore } from "@/stores/frame-store";

const TAB_ICONS: Record<string, React.ReactNode> = {
  code: <FileText size={12} />,
  diff: <FileDiff size={12} />,
  terminal: <Terminal size={12} />,
};

const TabBar: React.FC = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const setCurrentActiveTab = useFrameStore((s) => s.setCurrentActiveTab);
  const removeCurrentTab = useFrameStore((s) => s.removeCurrentTab);
  const reorderCurrentTabs = useFrameStore((s) => s.reorderCurrentTabs);
  const pinTab = useFrameStore((s) => s.pinTab);
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

  const getTabIcon = (tab: TabItem) => {
    const type = (tab.data?.type as string) || "code";
    return TAB_ICONS[type] || TAB_ICONS.code;
  };

  return (
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
              "shrink-0 px-2 min-h-11 h-11 md:min-h-0 md:h-7 rounded-md flex items-center gap-1 text-xs border transition-all cursor-pointer relative",
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
                type="button"
                data-drag-ignore
                onClick={(e) => handleCloseTab(e, tab.id)}
                className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-sm hover:bg-ide-bg hover:text-red-500 md:size-5 md:min-h-0 md:min-w-0 md:rounded-full md:p-0.5"
                title={`${t("common.close")} ${tab.title}`}
                aria-label={`${t("common.close")} ${tab.title}`}
              >
                <X size={12} />
              </button>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
};

export default TabBar;
