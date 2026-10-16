import {
  FilePlus,
  Files,
  FolderOpen,
  Globe,
  Home,
  Redo2,
  Replace,
  Save,
  Search,
  Settings,
  Sun,
  Undo2,
  XCircle,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import type { MenuContribution, MenuLocation, PluginManifest, WorkbenchPageDefinition } from "./types";

const shellMenus: MenuContribution[] = [
  ...[
    ["home", "common.home", Home],
    ["new-page", "common.newPage", FilePlus],
    ["open-folder", "common.openFolder", FolderOpen],
    ["settings", "common.settings", Settings],
    ["theme", "common.theme", Sun],
    ["language", "common.language", Globe],
  ].map(
    ([id, titleKey, icon], order) =>
      ({
        id,
        title: id,
        titleKey,
        icon,
        location: "project",
        command: id,
        section: "builtIn",
        order,
      }) as MenuContribution
  ),
  ...[
    ["save", "common.save", Save],
    ["save-as", "common.saveAs", Save],
    ["undo", "common.undo", Undo2],
    ["redo", "common.redo", Redo2],
    ["find", "common.find", Search],
    ["replace", "common.replace", Replace],
  ].map(
    ([id, titleKey, icon], order) =>
      ({
        id,
        title: id,
        titleKey,
        icon,
        location: "project",
        command: id,
        section: "editor",
        when: "editor.editMode && hasWorkspace",
        order,
      }) as MenuContribution
  ),
  {
    id: "close-folder",
    location: "project",
    title: "Close Folder",
    titleKey: "common.closeFolder",
    icon: XCircle,
    command: "close-folder",
    section: "context",
    when: "hasWorkspace",
  },
  {
    id: "close-page",
    location: "project",
    title: "Close Page",
    titleKey: "common.closePage",
    icon: XCircle,
    command: "close-page",
    section: "context",
    when: "!hasWorkspace && (activeGroupType != home || hasNonHomeGroups)",
  },
];
class WorkbenchRegistry {
  readonly commandHandlers = new Map<string, (...args: any[]) => any>();
  private pages = new Map<string, WorkbenchPageDefinition>();
  private plugins = new Map<string, PluginManifest>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getRevision = () => this.revision;
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  register(page: WorkbenchPageDefinition): void {
    this.pages.set(page.id, page);
    this.changed();
  }
  unregister(id: string): void {
    this.pages.delete(id);
    this.changed();
  }
  get(id: string) {
    return this.pages.get(id);
  }
  getAll() {
    return [...this.pages.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }
  getPlugins() {
    return [...this.plugins.values()];
  }
  getPlugin(id: string) {
    return this.plugins.get(id);
  }
  getOwner(pageId: string) {
    return (
      this.getPlugins().find((plugin) =>
        [...(plugin.contributions?.pages || []), ...(plugin.contributions?.workspaceViews || [])].some(
          (page) => page.id === pageId
        )
      )?.id || pageId
    );
  }
  registerPlugin(plugin: PluginManifest) {
    if (!plugin.id.trim()) throw new Error("Plugin ID is required");
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`);
    const pages = [...(plugin.contributions?.pages || []), ...(plugin.contributions?.workspaceViews || [])];
    if (new Set(pages.map((page) => page.id)).size !== pages.length || pages.some((page) => this.pages.has(page.id)))
      throw new Error("Page ID already registered");
    const commands = plugin.contributions?.commands || [];
    const editors = plugin.contributions?.customEditors || [];
    if (
      new Set(commands.map((command) => command.id)).size !== commands.length ||
      commands.some(
        (command) =>
          this.commandHandlers.has(command.id) ||
          this.getPlugins().some((plugin) =>
            plugin.contributions?.commands?.some((existing) => existing.id === command.id)
          )
      )
    )
      throw new Error("Command ID already registered");
    if (
      new Set(editors.map((editor) => editor.id)).size !== editors.length ||
      editors.some((editor) => this.getCustomEditors().some((existing) => existing.id === editor.id))
    )
      throw new Error("Editor ID already registered");
    if (plugin.contributions?.workspaceViews?.some((page) => page.category !== "workspace"))
      throw new Error("Workspace views require workspace category");
    this.plugins.set(plugin.id, plugin);
    for (const page of pages) this.pages.set(page.id, page);
    this.changed();
    return () => {
      if (this.plugins.get(plugin.id) !== plugin) return;
      this.plugins.delete(plugin.id);
      for (const page of pages) if (this.pages.get(page.id) === page) this.pages.delete(page.id);
      this.changed();
    };
  }
  getCustomEditors(extension?: string) {
    return this.getPlugins()
      .flatMap((plugin) =>
        (plugin.contributions?.customEditors || [])
          .filter(
            (editor) => !extension || editor.fileExtensions.some((ext) => ext.toLowerCase() === extension.toLowerCase())
          )
          .map((editor) => ({ ...editor, pluginId: plugin.id }))
      )
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
  getMenus(location: MenuLocation) {
    const entries = [
      ...shellMenus,
      ...this.getPlugins().flatMap((plugin) =>
        [...(plugin.contributions?.menu || []), ...(plugin.contributions?.menus || [])].map((item) => ({
          ...item,
          id: `${plugin.id}:${item.id}`,
        }))
      ),
    ];
    if (location === "new-page")
      entries.push(
        ...this.getAll()
          .filter((page) => page.id !== "home")
          .map((page) => ({
            id: page.id,
            location,
            title: page.name,
            titleKey: page.nameKey,
            icon: page.icon || Files,
            command: page.id === "files" ? "open-folder" : page.id === "terminal" ? "new-terminal" : `page:${page.id}`,
            order: (page.order ?? 100) + 10,
          }))
      );
    return entries.filter((item) => item.location === location).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }
}
export const workbenchRegistry = new WorkbenchRegistry();
export const pageRegistry = workbenchRegistry;
export function useWorkbenchRegistry() {
  useSyncExternalStore(workbenchRegistry.subscribe, workbenchRegistry.getRevision, workbenchRegistry.getRevision);
  return workbenchRegistry;
}
export function registerPage(page: WorkbenchPageDefinition) {
  workbenchRegistry.register(page);
}
export function unregisterPage(id: string) {
  workbenchRegistry.unregister(id);
}
export function definePlugin<T extends PluginManifest>(plugin: T): T {
  return plugin;
}
export function registerPlugin(plugin: PluginManifest) {
  return workbenchRegistry.registerPlugin(plugin);
}
