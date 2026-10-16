import { motion } from "motion/react";
import React from "react";
import { TaskbarItemMenu } from "@/components/frame/taskbar-item-menu";
import type { TaskbarItem, useTaskbar } from "@/framework/workbench/use-taskbar";
import { cn } from "@/lib/utils";
import type { PageGroup } from "@/stores/frame-store";

type Taskbar = ReturnType<typeof useTaskbar>;

const REORDER_TRANSITION = { type: "spring", stiffness: 520, damping: 42, mass: 0.7 } as const;

const GroupButton: React.FC<{ group: PageGroup; taskbar: Taskbar }> = ({ group, taskbar }) => {
  const vertical = taskbar.orientation === "vertical";
  const isActive = taskbar.activeGroupId === group.id;
  const title = taskbar.getGroupTitle(group);
  return (
    <button
      type="button"
      onClick={(event) => taskbar.handleGroupClick(group, event.currentTarget)}
      className={
        vertical
          ? `w-12 h-12 rounded-xl flex items-center justify-center transition-all ${isActive ? "bg-ide-panel text-ide-accent shadow-sm" : "text-ide-mute hover:text-ide-text hover:bg-ide-panel/50"}`
          : `h-11 min-h-11 min-w-11 px-3 rounded flex items-center justify-center gap-2 transition-all ${isActive ? "bg-ide-panel text-ide-accent shadow-sm" : "text-ide-mute hover:text-ide-text"}`
      }
      title={title}
      aria-label={title}
      aria-pressed={isActive}
    >
      {taskbar.getGroupIcon(group)}
    </button>
  );
};

const TaskbarItemView: React.FC<{ item: TaskbarItem; taskbar: Taskbar }> = ({ item, taskbar }) => {
  const vertical = taskbar.orientation === "vertical";
  const isGroup = item.type === "group";
  const reorder = taskbar.taskbarReorder;
  return (
    <TaskbarItemMenu
      title={isGroup ? taskbar.getGroupTitle(item.group) : item.item.label}
      onActivate={() => taskbar.activateItem(item)}
      onClose={isGroup ? () => taskbar.closeGroup(item.group) : undefined}
      onCloseOthers={isGroup ? () => taskbar.closeAllGroups(item.group.id) : undefined}
      onCloseAll={isGroup ? () => taskbar.closeAllGroups() : undefined}
      onOpenTerminal={
        isGroup && item.group.type === "group" ? () => taskbar.openContextPage(item.group, "terminal") : undefined
      }
      onOpenGit={isGroup && item.group.type === "group" ? () => taskbar.openContextPage(item.group, "git") : undefined}
      onSort={taskbar.openSort}
      canClose={isGroup && !(item.group.type === "home" && taskbar.groups.length <= 1)}
      canCloseOthers={isGroup && taskbar.groups.some((group) => group.id !== item.group.id)}
      canCloseAll={isGroup && taskbar.groups.some((group) => !(group.type === "home" && taskbar.groups.length <= 1))}
    >
      <motion.div
        layout={reorder.activeId !== item.id}
        transition={REORDER_TRANSITION}
        {...reorder.bindItem(item.id)}
        style={reorder.getItemStyle(item.id)}
        className={cn(
          vertical ? "shrink-0 relative transition-transform" : "h-11 min-h-11 shrink-0 relative transition-transform",
          reorder.activeId === item.id && "z-50 opacity-95 shadow-lg cursor-grabbing",
          reorder.overId === item.id &&
            (vertical ? "ring-1 ring-ide-accent rounded-xl" : "ring-1 ring-ide-accent rounded-lg")
        )}
      >
        {isGroup ? (
          <GroupButton group={item.group} taskbar={taskbar} />
        ) : (
          <button
            type="button"
            onClick={item.item.onClick}
            className={
              vertical
                ? `w-12 h-12 rounded-xl flex items-center justify-center relative transition-all ${taskbar.bottomBarConfig.activeItemId === item.item.id ? "bg-ide-panel text-ide-accent shadow-sm border border-ide-border/50" : "text-ide-mute hover:text-ide-text hover:bg-ide-panel/50"}`
                : `h-11 min-h-11 min-w-11 px-3 rounded flex items-center justify-center gap-2 transition-all relative ${taskbar.bottomBarConfig.activeItemId === item.item.id ? "bg-ide-panel text-ide-accent shadow-sm" : "text-ide-mute hover:text-ide-text"}`
            }
            title={item.item.label}
            aria-label={vertical ? undefined : item.item.label}
          >
            {item.item.icon}
            {item.item.badge && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full px-1 min-w-[16px] h-4 flex items-center justify-center">
                {item.item.badge}
              </span>
            )}
          </button>
        )}
      </motion.div>
    </TaskbarItemMenu>
  );
};

export default TaskbarItemView;
