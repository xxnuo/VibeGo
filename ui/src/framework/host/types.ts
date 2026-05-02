import type { LucideIcon } from "lucide-react";
import type React from "react";
import type { WorkbenchAction } from "@/framework/workbench/types";
import type { FileItem } from "@/stores/file-manager-store";
import type { TabItem } from "@/stores/frame-store";

// ==========================================
// 1. 文件系统 (FS)
// ==========================================
export interface FileStat {
  size: number;
  isDir: boolean;
  modTime: string;
  extension: string;
}

export interface PluginHostFS {
  readText: (path: string) => Promise<string>;
  writeText: (path: string, content: string) => Promise<void>;
  list: (path: string) => Promise<FileItem[]>;
  stat: (path: string) => Promise<FileStat>;
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  delete: (path: string, options?: { recursive?: boolean }) => Promise<void>;
}

export interface PluginHostWorkspace {
  readonly currentPath: string | undefined;
  readonly groupId: string;
  readonly fs: PluginHostFS;
  openFolder: (path: string) => Promise<void>;
  openFile: (
    fileOrPath: FileItem | string,
    options?: { line?: number; column?: number; preview?: boolean; editorId?: string }
  ) => void;
  findFiles: (query: string, limit?: number) => Promise<FileItem[]>;
  refresh: () => Promise<void>;
}

// ==========================================
// 2. 编辑器与文档操作 (Editor & Document)
// ==========================================
export interface PluginHostEditor {
  readonly tabs: TabItem[];
  readonly activeTabId: string | null;
  readonly activeTab: TabItem | undefined;
  openTab: (tab: TabItem) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string | null) => void;
  pinTab: (tabId: string) => void;
  setDirty: (tabId: string, isDirty: boolean) => void;
  /** 在当前代码编辑器中插入或替换文本 (面向 AI 辅助编程) */
  insertText: (text: string) => void;
}

// ==========================================
// 3. 终端服务 (Terminal)
// ==========================================
export interface PluginHostTerminal {
  create: (options?: { name?: string; cwd?: string }) => Promise<string>;
  sendText: (terminalId: string, text: string, addNewline?: boolean) => void;
  open: (terminalId: string) => void;
  readonly activeTerminalId: string | null;
  list: () => import("@/stores/terminal-store").TerminalSession[];
  getActive: () => import("@/stores/terminal-store").TerminalSession | undefined;
}

// ==========================================
// 4. 后台任务服务 (Task Runner)
// ==========================================
export interface TaskExecution {
  id: string;
  command: string;
  kill: () => void;
  onDidOutput: (listener: (chunk: string) => void) => () => void;
  onDidExit: (listener: (code: number) => void) => () => void;
}

export interface PluginHostTasks {
  runTask: (options: { command: string; cwd?: string; title?: string }) => Promise<TaskExecution>;
  getActiveTasks: () => TaskExecution[];
}

// ==========================================
// 5. 存储持久化 (Storage / Memento)
// ==========================================
export interface PluginStorage {
  get: <T>(key: string, defaultValue?: T) => T;
  update: <T>(key: string, value: T) => Promise<void>;
  delete: (key: string) => Promise<void>;
  keys: () => string[];
}

// ==========================================
// 6. 上下文键服务 (Context Keys & When)
// ==========================================
export interface PluginHostContextKeys {
  set: (key: string, value: unknown) => void;
  get: <T>(key: string) => T | undefined;
  evalWhen: (whenClause?: string) => boolean;
}

// ==========================================
// 7. 跨插件服务调度 (Extension Registry)
// ==========================================
export interface PluginExtension<TExports = unknown> {
  id: string;
  name: string;
  isActive: boolean;
  exports?: TExports;
}

export interface PluginHostExtensions {
  getExtension: <T = unknown>(pluginId: string) => PluginExtension<T> | undefined;
  getAll: () => PluginExtension[];
}

// ==========================================
// 8. 状态栏服务 (StatusBar)
// ==========================================
export interface StatusBarItem {
  id: string;
  text: string;
  tooltip?: string;
  icon?: LucideIcon;
  color?: string;
  onClick?: () => void;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

export interface PluginHostStatusBar {
  createItem: (options: { id: string; alignment?: "left" | "right"; priority?: number }) => StatusBarItem;
}

// ==========================================
// 9. 命令与 UI 交互 (Commands & UI)
// ==========================================
export interface QuickPickItem {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
}

export interface PluginHostCommands {
  register: (id: string, handler: (...args: any[]) => any) => () => void;
  execute: <T = any>(id: string, ...args: any[]) => Promise<T>;
  getCommands: () => string[];
}

export interface PluginHostUI {
  toast: {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
    warning: (msg: string) => void;
  };
  alert: (title: string, message?: string) => Promise<void>;
  confirm: (
    title: string,
    message?: string,
    options?: { confirmText?: string; cancelText?: string; confirmVariant?: "default" | "danger"; signal?: AbortSignal }
  ) => Promise<boolean>;
  prompt: (
    title: string,
    options?: { defaultValue?: string; placeholder?: string; confirmText?: string; cancelText?: string }
  ) => Promise<string | null>;
  showQuickPick: <T extends QuickPickItem>(items: T[], options?: { placeholder?: string }) => Promise<T | null>;
  withProgress: <T>(
    options: { title: string; cancellable?: boolean },
    task: (progress: (percent: number, step?: string) => void, signal: AbortSignal) => Promise<T>
  ) => Promise<T>;
}

// ==========================================
// 10. 事件总线与环境能力 (Events & Env)
// ==========================================
export interface PluginHostEvents {
  onDidSaveDocument: (listener: (path: string) => void) => () => void;
  onDidChangeActiveTab: (listener: (tabId: string | null) => void) => () => void;
  onDidChangeWorkspace: (listener: (newPath: string | undefined) => void) => () => void;
  onDidChangeTheme: (listener: (theme: string) => void) => () => void;
}

export interface PluginHostEnv {
  clipboard: {
    readText: () => Promise<string>;
    writeText: (text: string) => Promise<void>;
  };
  openExternal: (url: string) => void;
  readonly isMobile: boolean;
  readonly theme: string;
  readonly locale: string;
  readonly version: string;
}

// ==========================================
// 统一宿主上下文接口 (PluginHostContextValue)
// ==========================================
export interface PluginHostContextValue {
  readonly workspace: PluginHostWorkspace;
  readonly editor: PluginHostEditor;
  readonly terminal: PluginHostTerminal;
  readonly tasks: PluginHostTasks;
  readonly statusBar: PluginHostStatusBar;
  readonly storage: {
    workspace: PluginStorage;
    global: PluginStorage;
  };
  readonly contextKeys: PluginHostContextKeys;
  readonly extensions: PluginHostExtensions;
  readonly commands: PluginHostCommands;
  readonly ui: PluginHostUI;
  readonly events: PluginHostEvents;
  readonly env: PluginHostEnv;
  useActions: (actions: WorkbenchAction[], deps?: React.DependencyList) => void;
  useDisposable: (factory: React.EffectCallback, deps?: React.DependencyList) => void;
}
