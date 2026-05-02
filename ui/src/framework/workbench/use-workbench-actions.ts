import { type DependencyList, useLayoutEffect } from "react";
import { create } from "zustand";
import type { WorkbenchAction } from "./types";

interface WorkbenchActionState {
  editorActions: WorkbenchAction[];
  viewActions: WorkbenchAction[];
  setEditorActions: (actions: WorkbenchAction[]) => void;
  setViewActions: (actions: WorkbenchAction[]) => void;
}

export const useWorkbenchActionStore = create<WorkbenchActionState>((set) => ({
  editorActions: [],
  viewActions: [],
  setEditorActions: (actions) => set({ editorActions: actions }),
  setViewActions: (actions) => set({ viewActions: actions }),
}));

function useContributedActions(
  slot: "editorActions" | "viewActions",
  actions: WorkbenchAction[],
  deps: DependencyList
) {
  // 顶栏动作在绘制前生效，避免异步编辑器加载期间的被动提交交错。
  useLayoutEffect(() => {
    useWorkbenchActionStore.setState({ [slot]: actions });
    return () => {
      if (useWorkbenchActionStore.getState()[slot] === actions) {
        useWorkbenchActionStore.setState({ [slot]: [] });
      }
    };
  }, deps);
}

export function useContributedEditorActions(actions: WorkbenchAction[], deps: DependencyList = [actions]) {
  useContributedActions("editorActions", actions, deps);
}

export function useContributedViewActions(actions: WorkbenchAction[], deps: DependencyList = [actions]) {
  useContributedActions("viewActions", actions, deps);
}
