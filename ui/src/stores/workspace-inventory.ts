import type { ClientMutation, WorkspaceSnapshot, WorkspaceTabEntity } from "@/api/workspace-sync";
import { pageRegistry } from "@/pages/registry";
import type { GroupPage, PageGroup, TabItem } from "./frame-store";

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
export function inventoryFromFrame(
  groups: PageGroup[],
  workspaceId: string
): Pick<WorkspaceSnapshot, "folders" | "tools" | "tabs"> {
  const folders: WorkspaceSnapshot["folders"] = [],
    tools: WorkspaceSnapshot["tools"] = [],
    tabs: WorkspaceSnapshot["tabs"] = [];
  const addTabs = (owner: string, pageId: string, items: TabItem[]) => {
    items.forEach((tab, position) => {
      const data = sharedTabData(tab.data);
      const kind =
        data.editorId && data.editorId !== "default"
          ? "custom_editor"
          : data.type === "diff"
            ? "diff"
            : data.type === "preview"
              ? "preview"
              : "file";
      tabs.push({
        id: tab.id,
        workspace_id: workspaceId,
        folder_id: owner,
        page_id: pageId,
        tab_type: kind,
        title: tab.title,
        file_path: typeof data.path === "string" ? data.path : "",
        pinned: !!tab.pinned,
        icon: tab.icon,
        closable: tab.closable,
        position,
        data: JSON.stringify(data),
      });
    });
  };
  groups.forEach((group, position) => {
    if (group.type === "group") {
      const pages = group.pages.map(({ tabs: _tabs, activeTabId: _active, ...page }) => page);
      folders.push({
        id: group.id,
        workspace_id: workspaceId,
        name: group.name,
        path: group.pages.find((page) => page.type === "files")?.path || "",
        position,
        data: JSON.stringify({ ...group.data, pages }),
      });
      for (const page of group.pages) addTabs(group.id, page.id, page.tabs);
    } else if (group.type === "tool") {
      tools.push({
        id: group.id,
        workspace_id: workspaceId,
        page_id: group.pageId,
        name: group.name,
        position,
        data: JSON.stringify(group.data || {}),
      });
      addTabs(group.id, "", group.tabs);
    }
  });
  return { folders, tools, tabs };
}

export type MutationAction = { type: string; payload: Record<string, unknown> };
const tabKey = (tab: WorkspaceTabEntity) => JSON.stringify([tab.folder_id, tab.page_id, tab.id]);
const tabPayload = (tab: WorkspaceTabEntity) => ({ ...tab, data: parseData(tab.data) });
export function diffInventory(
  before: ReturnType<typeof inventoryFromFrame>,
  after: ReturnType<typeof inventoryFromFrame>
): MutationAction[] {
  const actions: MutationAction[] = [];
  for (const [previous, next, open, close, update] of [
    [before.folders, after.folders, "folder/add", "folder/remove", "folder/update-data"],
    [before.tools, after.tools, "tool/open", "tool/close", "tool/update-data"],
  ] as const) {
    const oldById = new Map(previous.map((item) => [item.id, item]));
    const nextIds = new Set(next.map((item) => item.id));
    for (const item of previous) if (!nextIds.has(item.id)) actions.push({ type: close, payload: { id: item.id } });
    for (const item of next) {
      const old = oldById.get(item.id);
      if (!old) actions.push({ type: open, payload: { ...item, data: parseData(item.data) } });
      else if (
        old.data !== item.data ||
        old.name !== item.name ||
        ("path" in old && "path" in item && old.path !== item.path)
      )
        actions.push({ type: update, payload: { ...item, data: parseData(item.data) } });
    }
  }
  const beforeTabs = new Map(before.tabs.map((tab) => [tabKey(tab), tab]));
  const afterTabs = new Map(after.tabs.map((tab) => [tabKey(tab), tab]));
  for (const [key, tab] of beforeTabs)
    if (!afterTabs.has(key) && [...after.folders, ...after.tools].some((owner) => owner.id === tab.folder_id))
      actions.push({ type: "tab/close", payload: { id: tab.id, folder_id: tab.folder_id, page_id: tab.page_id } });
  for (const [key, tab] of afterTabs) {
    const old = beforeTabs.get(key);
    if (!old) actions.push({ type: "tab/open", payload: tabPayload(tab) });
    else if (JSON.stringify(old) !== JSON.stringify(tab))
      actions.push({
        type: JSON.stringify({ ...old, pinned: tab.pinned }) === JSON.stringify(tab) ? "tab/pin" : "tab/update",
        payload: tabPayload(tab),
      });
  }
  const oldIds = before.folders
    .map((folder) => folder.id)
    .filter((id) => after.folders.some((folder) => folder.id === id));
  const nextIds = after.folders
    .map((folder) => folder.id)
    .filter((id) => before.folders.some((folder) => folder.id === id));
  if (oldIds.join("\0") !== nextIds.join("\0"))
    actions.push({ type: "folder/reorder", payload: { folder_ids: after.folders.map((folder) => folder.id) } });
  return actions;
}

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
      next.folders = next.folders.map((folder) => (folder.id === p.id ? { ...folder, ...entity } : folder));
      break;
    case "tool/update-data":
      next.tools = next.tools.map((tool) =>
        tool.id === p.id ? { ...tool, data: entity.data, ...(p.name ? { name: p.name } : {}) } : tool
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
    tabs.some((tab) => tab.id === id) ? id! : tabs[0]?.id || null;
  const assets: PageGroup[] = [...snapshot.folders]
    .sort((a, b) => a.position - b.position)
    .map((folder) => {
      const old = current.find((group) => group.id === folder.id);
      const data = parseData(folder.data);
      const savedPages = Array.isArray(data.pages) ? (data.pages as GroupPage[]) : [];
      const definitions = savedPages.length
        ? savedPages
        : ["files", "git", "terminal"].map((type) => ({
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
  for (const tool of snapshot.tools) {
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
  // Preserve local Home/Settings and focus. Shared additions never activate a group.
  return [...current.filter((group) => group.type === "home" || group.type === "settings"), ...assets];
}
