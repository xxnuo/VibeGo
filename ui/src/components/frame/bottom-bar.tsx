import { Menu, Plus } from "lucide-react";
import React from "react";
import { TaskbarSortDialog } from "@/components/frame/taskbar-item-menu";
import TaskbarItemView from "@/components/frame/taskbar-item-view";
import WorkspaceHintBubble from "@/components/frame/workspace-hint-bubble";
import { useTaskbar } from "@/framework/workbench/use-taskbar";

interface BottomBarProps {
  onMenuClick?: () => void;
  onNewPage?: () => void;
}

const BottomBar: React.FC<BottomBarProps> = ({ onMenuClick, onNewPage }) => {
  const taskbar = useTaskbar({ orientation: "horizontal" });
  const {
    t,
    bottomBarConfig,
    orderedItems,
    useCustomItems,
    rightButtons,
    sortOpen,
    sortEntries,
    setSortOpen,
    setTaskbarOrder,
    workspaceHint,
    isOnlyHome,
    sortRestoreFocusRef,
  } = taskbar;
  const cornerButtonClass =
    "shrink-0 w-11 h-11 rounded-md text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors";

  if (!bottomBarConfig.show) return null;

  return (
    <>
      <footer className="md:hidden h-[calc(3.5rem_+_env(safe-area-inset-bottom))] min-h-[calc(3.5rem_+_env(safe-area-inset-bottom))] items-center gap-2 overflow-hidden border-t border-ide-border bg-ide-panel pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)] shadow-[0_-5px_15px_rgba(0,0,0,0.1)] z-20 flex">
        <button
          type="button"
          onClick={onMenuClick}
          className={cornerButtonClass}
          title={t("common.menu") || "Menu"}
          aria-label={t("common.menu") || "Menu"}
        >
          <Menu size={18} />
        </button>

        <div className="flex h-[46px] min-h-[46px] min-w-0 flex-1 gap-1 overflow-x-auto rounded-md border border-ide-border bg-ide-bg custom-scrollbar touch-pan-x">
          {orderedItems.length > 0 ? (
            orderedItems.map((item) => <TaskbarItemView key={item.id} item={item} taskbar={taskbar} />)
          ) : isOnlyHome && onNewPage ? (
            <button
              type="button"
              onClick={onNewPage}
              className="h-11 min-h-11 min-w-11 px-3 rounded flex items-center justify-center gap-2 transition-all text-ide-mute hover:text-ide-accent"
              title={t("common.newPage")}
              aria-label={t("common.newPage")}
            >
              <Plus size={18} />
            </button>
          ) : (
            <div className="w-11" />
          )}
          {orderedItems.length > 0 && onNewPage && !useCustomItems && (
            <button
              type="button"
              onClick={onNewPage}
              className="h-11 min-h-11 min-w-11 px-3 rounded flex items-center justify-center gap-2 transition-all text-ide-mute hover:text-ide-accent shrink-0"
              title={t("common.newPage")}
              aria-label={t("common.newPage")}
            >
              <Plus size={18} />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {rightButtons.map((button, index) => (
            <button
              key={index}
              type="button"
              onClick={button.onClick}
              disabled={button.disabled}
              title={button.label}
              aria-label={button.label}
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
        restoreFocusRef={sortRestoreFocusRef}
      />
      <WorkspaceHintBubble hint={workspaceHint} />
    </>
  );
};

export default BottomBar;
