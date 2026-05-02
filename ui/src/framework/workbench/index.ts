export {
  definePlugin,
  pageRegistry,
  registerPage,
  registerPlugin,
  unregisterPage,
  useWorkbenchRegistry,
  workbenchRegistry,
} from "./registry";
export type {
  CommandContribution,
  CustomEditorDefinition,
  KeybindingContribution,
  MenuContribution,
  PageCategory,
  PageContext,
  PageId,
  PageViewProps,
  PluginConfiguration,
  PluginManifest,
  QuickOpenItem,
  QuickOpenProvider,
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
