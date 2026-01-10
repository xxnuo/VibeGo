export { default as AppFrame } from './AppFrame';
export { default as TopBar } from './TopBar';
export { default as TabBar } from './TabBar';
export { default as BottomBar } from './BottomBar';
export { default as NewGroupMenu } from './NewGroupMenu';
export {
  registerPage,
  unregisterPage,
  getPage,
  getPageByViewType,
  getAllPages,
  DEFAULT_PAGE_CONFIGS,
  type PageConfig,
  type PageComponentProps,
} from './PageRegistry.tsx';
