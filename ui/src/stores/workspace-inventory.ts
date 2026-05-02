import type { ClientMutation, WorkspaceSnapshot } from "@/api/workspace-sync";
import { pageRegistry } from "@/pages/registry";
import type { GroupPage, PageGroup, TabItem } from "./frame-store";
import { splitPageTasks } from "./page-tasks";

export function parseData(raw?: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function sharedTabData(data?: Record<string, unknown>) {
  const { isDirty: _dirty, line: _line, column: _column, ...shared } = data || {};
  return shared;
}
export function tabPayload(owner: string, pageId: string, tab: TabItem, position: number) {
  const data = sharedTabData(tab.data);
  return {
    id: tab.id,
    folder_id: owner,
    page_id: pageId,
    tab_type:
      data.editorId && data.editorId !== "default"
        ? "custom_editor"
        : data.type === "diff"
          ? "diff"
          : data.type === "preview"
            ? "preview"
            : data.type === "custom_editor"
              ? "custom_editor"
              : "file",
    title: tab.title,
    file_path: typeof data.path === "string" ? data.path : "",
    pinned: !!tab.pinned,
    icon: tab.icon,
    closable: tab.closable,
    position: tab.position ?? position,
    data,
  };
}

export function groupPayload(group: PageGroup, position: number): Record<string, unknown> {
  if (group.type === "group")
    return {
      id: group.id,
      name: group.name,
      position,
      path: group.pages.find((page) => page.type === "files")?.path || "",
      data: { ...group.data, pages: group.pages.map(({ tabs: _tabs, activeTabId: _active, ...page }) => page) },
    };
  if (group.type === "tool")
    return { id: group.id, name: group.name, page_id: group.pageId, position, data: group.data || {} };
  return {};
}

// Explicit import of an existing local workspace, used only when creating it.
export function actionsFromFrame(groups: PageGroup[]): MutationAction[] {
  const actions: MutationAction[] = [];
  groups.forEach((group, position) => {
    if (group.type !== "group" && group.type !== "tool") return;
    actions.push({ type: group.type === "group" ? "folder/add" : "tool/open", payload: groupPayload(group, position) });
    const pages = group.type === "group" ? group.pages : [{ id: "", tabs: group.tabs }];
    for (const page of pages)
      page.tabs.forEach((tab, index) =>
        actions.push({ type: "tab/open", payload: tabPayload(group.id, page.id, tab, index) })
      );
  });
  return actions;
}

export function inventoryFromFrame(
  groups: PageGroup[],
  workspaceId: string
): Pick<WorkspaceSnapshot, "folders" | "tools" | "tabs"> {
  const empty: WorkspaceSnapshot = {
    workspace: { id: workspaceId, name: "", revision: 0, data: "{}" },
    folders: [],
    tools: [],
    tabs: [],
    terminals: [],
    storage: [],
  };
  const { folders, tools, tabs } = actionsFromFrame(groups).reduce(
    (state, action) => reduceInventory(state, { ...action, workspace_id: workspaceId } as ClientMutation),
    empty
  );
  return { folders, tools, tabs };
}

export type MutationAction = { type: string; payload: Record<string, unknown> };
// The same reducer rebases queued local mutations over a reconnect snapshot.
export function reduceInventory(snapshot: WorkspaceSnapshot, mutation: ClientMutation): WorkspaceSnapshot {
  const p = { ...mutation.payload } as Record<string, any>;
  if ((mutation.type === "tab/pin" || mutation.type === "tab/close") && !p.folder_id) {
    const candidates = snapshot.tabs.filter((tab) => tab.id === p.id);
    if (candidates.length === 1) {
      p.folder_id = candidates[0].folder_id;
      p.page_id = candidates[0].page_id;
    }
  }
  const next = { ...snapshot };
  const entity: Record<string, any> = { ...p, workspace_id: mutation.workspace_id, data: JSON.stringify(p.data || {}) };
  if (mutation.type === "tab/open" && !entity.page_id) {
    const folder = snapshot.folders.find((folder) => folder.id === p.folder_id);
    const pages = folder ? parseData(folder.data).pages : undefined;
    entity.page_id = folder
      ? (Array.isArray(pages) ? pages.find((page) => page.type === "files")?.id : undefined) || `${folder.id}-files`
      : "";
  }
  switch (mutation.type) {
    case "workspace/rename":
      next.workspace = { ...next.workspace, name: p.name };
      break;
    case "workspace/reorder":
      next.workspace = { ...next.workspace, position: p.position };
      break;
    case "workspace/delete":
      next.folders = [];
      next.tools = [];
      next.tabs = [];
      next.terminals = [];
      break;
    case "folder/add":
      if (!next.folders.some((folder) => folder.id === p.id)) next.folders = [...next.folders, entity as any];
      break;
    case "tool/open":
      if (!next.tools.some((tool) => tool.id === p.id)) next.tools = [...next.tools, entity as any];
      break;
    case "folder/remove":
      next.folders = next.folders.filter((folder) => folder.id !== p.id);
      next.tabs = next.tabs.filter((tab) => tab.folder_id !== p.id);
      break;
    case "tool/close":
      next.tools = next.tools.filter((tool) => tool.id !== p.id);
      next.tabs = next.tabs.filter((tab) => tab.folder_id !== p.id);
      break;
    case "folder/update-data":
      next.folders = next.folders.map((folder) =>
        folder.id === p.id ? { ...folder, data: entity.data, path: p.path ?? "", name: p.name ?? "" } : folder
      );
      break;
    case "tool/update-data":
      next.tools = next.tools.map((tool) =>
        tool.id === p.id
          ? {
              ...tool,
              data: entity.data,
              ...(p.name ? { name: p.name } : {}),
              ...(typeof p.position === "number" ? { position: p.position } : {}),
            }
          : tool
      );
      break;
    case "folder/reorder": {
      const rank = new Map<string, number>((p.folder_ids as string[]).map((id, index) => [id, index]));
      next.folders = next.folders
        .map((folder) => ({ ...folder, position: rank.get(folder.id) ?? next.folders.length + folder.position }))
        .sort((a, b) => a.position - b.position);
      break;
    }
    case "tab/open":
      if (!next.tabs.some((tab) => tab.id === p.id && tab.folder_id === p.folder_id && tab.page_id === entity.page_id))
        next.tabs = [...next.tabs, entity as any];
      break;
    case "tab/update":
      next.tabs = next.tabs.map((tab) =>
        tab.id === p.id && tab.folder_id === p.folder_id && tab.page_id === (p.page_id || "") ? (entity as any) : tab
      );
      break;
    case "tab/close":
      next.tabs = next.tabs.filter(
        (tab) => !(tab.id === p.id && tab.folder_id === p.folder_id && (!p.page_id || tab.page_id === p.page_id))
      );
      break;
    case "tab/pin":
      next.tabs = next.tabs.map((tab) =>
        tab.id === p.id && tab.folder_id === p.folder_id && (!p.page_id || tab.page_id === p.page_id)
          ? { ...tab, pinned: p.pinned }
          : tab
      );
      break;
    case "terminal/open":
    case "terminal/update":
    case "terminal/close":
      if (Array.isArray(p.terminals)) next.terminals = p.terminals;
      break;
    case "plugin/storage-update": {
      next.storage = next.storage.filter(
        (item) => !(item.plugin_id === p.plugin_id && item.scope === (p.scope || "") && item.key === p.key)
      );
      if (!p.deleted)
        next.storage = [
          ...next.storage,
          {
            workspace_id: mutation.workspace_id,
            plugin_id: p.plugin_id,
            scope: p.scope || "",
            key: p.key,
            value: JSON.stringify(p.value),
          },
        ];
      break;
    }
  }
  return next;
}

export function frameFromInventory(snapshot: WorkspaceSnapshot, current: PageGroup[]): PageGroup[] {
  const tabsFor = (owner: string, pageId: string, oldTabs: TabItem[] = []) =>
    snapshot.tabs
      .filter((tab) => tab.folder_id === owner && tab.page_id === pageId)
      .sort((a, b) => a.position - b.position)
      .map((tab) => {
        const old = oldTabs.find((item) => item.id === tab.id);
        const data = parseData(tab.data);
        if (!data.type) data.type = tab.tab_type === "file" ? "code" : tab.tab_type;
        if (tab.file_path) data.path = tab.file_path;
        const result: TabItem = {
          id: tab.id,
          title: tab.title,
          pinned: tab.pinned,
          position: tab.position,
          ...(tab.icon ? { icon: tab.icon } : {}),
          ...(tab.closable !== undefined ? { closable: tab.closable } : {}),
          data: {
            ...data,
            ...(old?.data?.isDirty !== undefined ? { isDirty: old.data.isDirty } : {}),
            ...(old?.data?.line !== undefined ? { line: old.data.line, column: old.data.column } : {}),
          },
        };
        return old && JSON.stringify(old) === JSON.stringify(result) ? old : result;
      });
  const activeTab = (id: string | null | undefined, tabs: TabItem[]) =>
    id === null ? null : tabs.some((tab) => tab.id === id) ? id! : tabs[0]?.id || null;
  const assets: PageGroup[] = [...snapshot.folders]
    .sort((a, b) => a.position - b.position)
    .map((folder) => {
      const old = current.find((group) => group.id === folder.id);
      const data = parseData(folder.data);
      const savedPages = Array.isArray(data.pages) ? (data.pages as GroupPage[]) : [];
      const definitions = savedPages.length
        ? savedPages
        : ["files"].map((type) => ({
            id: `${folder.id}-${type}`,
            type,
            label: pageRegistry.get(type)?.name || type,
            path: folder.path,
          }));
      const pages = definitions.map((definition) => {
        const oldPage = old?.type === "group" ? old.pages.find((page) => page.id === definition.id) : undefined;
        const tabs = tabsFor(folder.id, definition.id, oldPage?.tabs);
        return { ...definition, tabs, activeTabId: activeTab(oldPage?.activeTabId, tabs) };
      });
      return {
        type: "group",
        id: folder.id,
        name: folder.name,
        data: Object.fromEntries(Object.entries(data).filter(([key]) => key !== "pages")),
        pages,
        activePageId:
          old?.type === "group" && pages.some((page) => page.id === old.activePageId)
            ? old.activePageId
            : pages[0]?.id || null,
      };
    });
  for (const tool of [...snapshot.tools].sort((a, b) => a.position - b.position)) {
    const old = current.find((group) => group.id === tool.id);
    const tabs = tabsFor(tool.id, "", old?.type === "tool" ? old.tabs : []);
    assets.push({
      type: "tool",
      id: tool.id,
      pageId: tool.page_id,
      name: tool.name,
      data: parseData(tool.data),
      tabs,
      activeTabId: activeTab(old?.type === "tool" ? old.activeTabId : null, tabs),
    });
  }
  const positions = new Map([...snapshot.folders, ...snapshot.tools].map((item) => [item.id, item.position]));
  assets.sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
  // Preserve local Home/Settings and focus. Shared additions never activate a group.
  return splitPageTasks([...current.filter((group) => group.type === "home" || group.type === "settings"), ...assets]);
}
