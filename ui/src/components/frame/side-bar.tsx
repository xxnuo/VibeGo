import { Menu, Plus } from "lucide-react";
import React from "react";
import { TaskbarSortDialog } from "@/components/frame/taskbar-item-menu";
import TaskbarItemView from "@/components/frame/taskbar-item-view";
import WorkspaceHintBubble from "@/components/frame/workspace-hint-bubble";
import { useTaskbar } from "@/framework/workbench/use-taskbar";

interface SideBarProps {
  onMenuClick?: () => void;
  onNewPage?: () => void;
}

const SideBar: React.FC<SideBarProps> = ({ onMenuClick, onNewPage }) => {
  const taskbar = useTaskbar({ orientation: "vertical" });
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
  } = taskbar;
  const actionButtonClass =
    "w-12 h-12 rounded-xl text-ide-mute hover:bg-ide-panel hover:text-ide-text flex items-center justify-center transition-colors";

  if (!bottomBarConfig.show) return null;

  return (
    <>
      <aside className="hidden md:flex w-14 h-full flex-col items-center py-4 bg-ide-panel border-r border-ide-border z-20 shadow-[5px_0_15px_rgba(0,0,0,0.1)] gap-4">
        <button onClick={onMenuClick} className={actionButtonClass} title={t("common.menu") || "Menu"}>
          <Menu size={24} />
        </button>

        <div className="w-10 h-px bg-ide-border/50 shrink-0" />

        <div className="flex-1 flex flex-col gap-2 overflow-y-auto no-scrollbar w-full px-2 items-center">
          {orderedItems.map((item) => (
            <TaskbarItemView key={item.id} item={item} taskbar={taskbar} />
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
      <TaskbarSortDialog
        open={sortOpen}
        title={t("common.sort")}
        entries={sortEntries}
        onOpenChange={setSortOpen}
        onApply={(order) => setTaskbarOrder(order)}
      />
      <WorkspaceHintBubble hint={workspaceHint} />
    </>
  );
};

export default SideBar;
