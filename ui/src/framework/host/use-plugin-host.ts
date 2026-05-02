import { createContext, useContext, useEffect, useLayoutEffect, useMemo } from "react";
import { toast } from "sonner";
import { fileApi } from "@/api/file";
import { terminalApi } from "@/api/terminal";
import { useDialog } from "@/components/common/dialog-provider";
import { workbenchRegistry } from "@/framework/workbench/registry";
import { useContributedViewActions } from "@/framework/workbench/use-workbench-actions";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAppStore } from "@/stores/app-store";
import { getOrCreateFileManagerStore } from "@/stores/file-manager-store";
import { useFrameStore } from "@/stores/frame-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useSessionStore } from "@/stores/session-store";
import { getTerminalWorkspaceGroupIds } from "@/stores/session-workspace-guard";
import { useTerminalStore } from "@/stores/terminal-store";
import packageInfo from "../../../package.json";
import { commands } from "./command-service";
import { contextKeys } from "./context-key-service";
import { editorService } from "./editor-service";
import { pluginEvents } from "./event-bus";
import { createStatusBarItem } from "./status-bar-service";
import { createPluginStorage } from "./storage-service";
import { tasks } from "./task-service";
import type { PluginHostContextValue } from "./types";
import { createPluginUIService } from "./ui-service";

export const PluginHostScope = createContext<{ pluginId: string; groupId?: string; path?: string } | null>(null);

function useDisposable(factory: import("react").EffectCallback, deps: import("react").DependencyList = []) {
  useLayoutEffect(factory, deps);
}

export function usePluginHost(pluginId?: string): PluginHostContextValue {
  const scope = useContext(PluginHostScope);
  const frame = useFrameStore();
  const app = useAppStore();
  const mobile = useIsMobile();
  const dialog = useDialog();
  const plugin = pluginId || scope?.pluginId || "workbench";
  const groupId = scope?.groupId || frame.activeGroupId || "home";
  const group = frame.groups.find((group) => group.id === groupId);
  const path =
    scope?.path || (group?.type === "group" ? group.pages.find((page) => page.type === "files")?.path : undefined);
  const workspaceId = `${useSessionStore((state) => state.currentSessionId) || "local"}:${groupId}`;
  const terminals = useTerminalStore();
  const disposables = useMemo(() => new Set<() => void>(), [plugin, workspaceId]);
  useEffect(
    () => () => {
      for (const dispose of disposables) dispose();
      disposables.clear();
    },
    [disposables]
  );
  const own = (dispose: () => void) => {
    const cleanup = () => {
      disposables.delete(cleanup);
      dispose();
    };
    disposables.add(cleanup);
    return cleanup;
  };
  const pluginUI = createPluginUIService((dispose) => {
    disposables.add(dispose);
    return () => {
      disposables.delete(dispose);
    };
  });

  return useMemo<PluginHostContextValue>(
    () => ({
      workspace: {
        currentPath: path,
        groupId,
        fs: {
          readText: async (path) => (await fileApi.read(path)).content,
          writeText: async (path, content) => {
            await fileApi.write(path, content);
          },
          list: async (path) => (await fileApi.list(path)).files,
          stat: (path) => fileApi.info(path),
          exists: async (path) => (await fileApi.check(path)).exist,
          mkdir: async (path) => {
            await fileApi.mkdir(path);
          },
          delete: async (path, options) => {
            await fileApi.delete(path, { recursive: options?.recursive ?? false });
          },
        },
        openFolder: async (path) => {
          await useSessionStore.getState().openFolder(path);
        },
        openFile(fileOrPath, options) {
          const frame = useFrameStore.getState();
          const group = frame.groups.find((group) => group.id === groupId);
          if (group?.type !== "group") throw new Error("A folder workspace is required");
          const page = group.pages.find((page) => page.type === "files");
          if (!page) throw new Error("Files view unavailable");
          const file =
            typeof fileOrPath === "string"
              ? {
                  path: fileOrPath,
                  name: fileOrPath.split(/[\\/]/).pop() || fileOrPath,
                  extension: fileOrPath.match(/\.[^./\\]+$/)?.[0] || "",
                  size: 0,
                  isDir: false,
                  isSymlink: false,
                  isHidden: false,
                  mode: "",
                  modTime: "",
                }
              : fileOrPath;
          frame.setActiveGroup(groupId);
          frame.setActivePage(groupId, page.id);
          const tab = {
            id: `tab-${file.path}`,
            title: file.name,
            pinned: !options?.preview,
            data: { type: "code", path: file.path, file, ...options },
          };
          if (options?.preview) frame.openPreviewTab(tab);
          else frame.addTab(groupId, tab, page.id);
          frame.updateTab(groupId, tab.id, { data: tab.data, ...(!options?.preview ? { pinned: true } : {}) }, page.id);
          frame.setActiveTab(groupId, tab.id, page.id);
        },
        findFiles: async (query, limit = 100) =>
          (await fileApi.search({ path: path || ".", search: query, containSub: true, pageSize: limit })).items || [],
        refresh: async () => {
          const store = getOrCreateFileManagerStore(groupId);
          const result = await fileApi.list(store.getState().initialized ? store.getState().currentPath : path || ".");
          store.getState().setFiles(result.files);
        },
      },
      editor: {
        tabs:
          group?.type === "group"
            ? group.pages.find((page) => page.id === group.activePageId)?.tabs || []
            : group?.type === "tool"
              ? group.tabs
              : [],
        activeTabId:
          group?.type === "group"
            ? group.pages.find((page) => page.id === group.activePageId)?.activeTabId || null
            : group?.type === "tool"
              ? group.activeTabId
              : null,
        get activeTab() {
          return this.tabs.find((tab) => tab.id === this.activeTabId);
        },
        openTab: (tab) => useFrameStore.getState().addTab(groupId, tab),
        closeTab: (id) => useFrameStore.getState().removeTab(groupId, id),
        setActiveTab: (id) => useFrameStore.getState().setActiveTab(groupId, id),
        pinTab: (id) => useFrameStore.getState().updateTab(groupId, id, { pinned: true }),
        setDirty(id, dirty) {
          const state = useFrameStore.getState();
          const group = state.groups.find((group) => group.id === groupId);
          const tabs =
            group?.type === "group"
              ? group.pages.find((page) => page.id === group.activePageId)?.tabs
              : group?.type === "tool"
                ? group.tabs
                : [];
          const tab = tabs?.find((tab) => tab.id === id);
          if (tab) state.updateTab(groupId, id, { data: { isDirty: dirty } });
          if (state.getCurrentActiveTabId() === id) usePreviewStore.getState().setIsDirty(dirty);
        },
        insertText(text) {
          const frame = useFrameStore.getState();
          const id = frame.getCurrentActiveTabId();
          if (id) frame.pinTab(id);
          usePreviewStore.getState().setEditMode(true);
          editorService.insertText(text);
        },
      },
      terminal: {
        async create(options) {
          let owner = useFrameStore.getState().groups.find((group) => group.id === groupId);
          if (owner?.type !== "group" || !owner.pages.some((page) => page.type === "terminal")) {
            useFrameStore.getState().addTerminalGroup();
            owner = useFrameStore.getState().getActiveGroup();
          }
          if (!owner || owner.type !== "group") throw new Error("Terminal workspace unavailable");
          const sessionId = useSessionStore.getState().currentSessionId;
          const result = await terminalApi.create({
            ...options,
            cwd: options?.cwd || path,
            group_id: owner.id,
            workspace_session_id: sessionId || undefined,
          });
          const session = useSessionStore.getState();
          if (
            session.currentSessionId !== sessionId ||
            session.loading ||
            !getTerminalWorkspaceGroupIds(useFrameStore.getState().groups).has(owner.id)
          ) {
            await terminalApi.delete(result.id);
            throw new Error("Workspace changed while creating terminal");
          }
          useTerminalStore.getState().addTerminal(owner.id, { id: result.id, name: result.name });
          return result.id;
        },
        sendText(id, text, addNewline = true) {
          const socket = new WebSocket(terminalApi.wsUrl(id));
          socket.addEventListener(
            "open",
            () => {
              socket.send(
                JSON.stringify({
                  type: "input",
                  data: btoa(
                    Array.from(new TextEncoder().encode(text + (addNewline ? "\r" : "")), (byte) =>
                      String.fromCharCode(byte)
                    ).join("")
                  ),
                })
              );
              socket.close();
            },
            { once: true }
          );
          socket.addEventListener(
            "error",
            () => {
              toast.error("Terminal input failed");
              socket.close();
            },
            { once: true }
          );
        },
        open(id) {
          const owner = Object.entries(useTerminalStore.getState().terminalsByGroup).find(([, terminals]) =>
            terminals.some((terminal) => terminal.id === id)
          );
          if (!owner) throw new Error("Terminal unavailable");
          const frame = useFrameStore.getState();
          frame.setActiveGroup(owner[0]);
          frame.setFolderView(owner[0], "terminal");
          useTerminalStore.getState().setActiveId(owner[0], id);
        },
        activeTerminalId: terminals.getActiveId(groupId),
        list: () => useTerminalStore.getState().getTerminals(groupId),
        getActive: () => {
          const state = useTerminalStore.getState();
          return state.getTerminals(groupId).find((terminal) => terminal.id === state.getActiveId(groupId));
        },
      },
      tasks: { ...tasks, runTask: (options) => tasks.runTask({ ...options, cwd: options.cwd || path }) },
      statusBar: {
        createItem(options) {
          const item = createStatusBarItem(plugin, options, groupId);
          own(item.dispose);
          return item;
        },
      },
      storage: { workspace: createPluginStorage(plugin, workspaceId), global: createPluginStorage(plugin) },
      contextKeys,
      extensions: {
        getExtension<T>(id: string) {
          const manifest = workbenchRegistry.getPlugin(id);
          const page = workbenchRegistry.get(id);
          return manifest || page
            ? { id, name: manifest?.name || page!.name, isActive: true, exports: manifest?.exports as T | undefined }
            : undefined;
        },
        getAll: () => {
          const plugins = workbenchRegistry.getPlugins();
          return [
            ...plugins.map((plugin) => ({ id: plugin.id, name: plugin.name, isActive: true, exports: plugin.exports })),
            ...workbenchRegistry
              .getAll()
              .filter(
                (page) =>
                  !plugins.some(
                    (plugin) =>
                      plugin.id === page.id ||
                      [...(plugin.contributions?.pages || []), ...(plugin.contributions?.workspaceViews || [])].some(
                        (view) => view.id === page.id
                      )
                  )
              )
              .map((page) => ({ id: page.id, name: page.name, isActive: true })),
          ];
        },
      },
      commands: { ...commands, register: (id, handler) => own(commands.register(id, handler)) },
      ui: { ...dialog, toast, ...pluginUI },
      events: {
        onDidSaveDocument: (listener) => own(pluginEvents.on("save", listener)),
        onDidChangeActiveTab: (listener) => own(pluginEvents.on("tab", listener)),
        onDidChangeWorkspace: (listener) => own(pluginEvents.on("workspace", listener)),
        onDidChangeTheme: (listener) => own(pluginEvents.on("theme", listener)),
      },
      env: {
        clipboard: {
          readText: async () => navigator.clipboard.readText(),
          writeText: async (text) => navigator.clipboard.writeText(text),
        },
        openExternal: (url) => {
          const parsed = new URL(url);
          if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) throw new Error("Unsupported URL");
          window.open(parsed.href, "_blank", "noopener,noreferrer");
        },
        isMobile: mobile,
        theme: app.theme,
        locale: app.locale,
        version: packageInfo.version,
      },
      useActions: useContributedViewActions,
      useDisposable,
    }),
    [plugin, workspaceId, groupId, path, group, terminals, app.theme, app.locale, mobile, dialog]
  );
}
