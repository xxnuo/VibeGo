export { pageRegistry, registerPage, unregisterPage, workbenchRegistry } from "./registry";
export type {
  PageCategory,
  PageContext,
  PageId,
  PageViewProps,
  TabItem,
  WorkbenchAction,
  WorkbenchLocation,
  WorkbenchPageDefinition,
} from "./types";
export { type TaskbarItem, type UseTaskbarOptions, useTaskbar } from "./use-taskbar";
export {
  useContributedEditorActions,
  useContributedViewActions,
  useWorkbenchActionStore,
} from "./use-workbench-actions";
