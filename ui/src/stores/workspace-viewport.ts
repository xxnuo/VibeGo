import type { WorkspaceState } from "@/api/session";
import type { WorkspaceSnapshot } from "@/api/workspace-sync";
import { frameFromInventory } from "./workspace-inventory";

const key = (id: string) => `vibego:viewport:${id}`;

export function saveWorkspaceViewport(id: string, state: WorkspaceState) {
  const viewport = {
    activeGroupId: state.activeGroupId,
    activePages: Object.fromEntries(state.openGroups.map((group) => [group.id, group.activePageId])),
    activeTabs: Object.fromEntries(
      state.openGroups.flatMap((group) => group.pages.map((page) => [page.id, page.activeTabId]))
    ),
    activeToolTabs: Object.fromEntries(state.openTools.map((tool) => [tool.id, tool.activeTabId])),
    activeTerminalByGroup: state.activeTerminalByGroup,
    terminalLayouts: state.terminalLayouts,
    focusedIdByGroup: state.focusedIdByGroup,
    listManagerOpenByGroup: state.listManagerOpenByGroup,
    terminalOrder: Object.fromEntries(
      Object.entries(state.terminalsByGroup).map(([id, terminals]) => [id, terminals.map((terminal) => terminal.id)])
    ),
    terminalPinned: Object.fromEntries(
      Object.values(state.terminalsByGroup)
        .flat()
        .map((terminal) => [terminal.id, terminal.pinned])
    ),
    settingsOpen: state.settingsOpen,
    taskbarOrder: state.taskbarOrder,
  };
  window.sessionStorage.setItem(key(id), JSON.stringify(viewport));
}

export function workspaceSnapshotState(snapshot: WorkspaceSnapshot): WorkspaceState {
  let viewport: Record<string, any> = {};
  try {
    viewport = JSON.parse(window.sessionStorage.getItem(key(snapshot.workspace.id)) || "{}");
  } catch {}
  const groups = frameFromInventory(snapshot, []);
  for (const group of groups) {
    if (group.type !== "tool" || typeof group.data?.sourceGroupId !== "string") continue;
    const source = group.data.sourceGroupId;
    const sourcePage = group.data.sourcePageId as string;
    if (viewport.activeGroupId === source && viewport.activePages?.[source] === sourcePage)
      viewport.activeGroupId = group.id;
    if (viewport.activeToolTabs?.[group.id] === undefined && viewport.activeTabs?.[sourcePage] !== undefined) {
      viewport.activeToolTabs = { ...viewport.activeToolTabs, [group.id]: viewport.activeTabs[sourcePage] };
    }
    if (group.pageId === "terminal" && viewport.activeTerminalByGroup?.[group.id] === undefined) {
      for (const field of ["activeTerminalByGroup", "terminalOrder"]) {
        if (viewport[field]?.[source] !== undefined)
          viewport[field] = { ...viewport[field], [group.id]: viewport[field][source] };
      }
    }
  }
  const order: string[] = viewport.taskbarOrder || [];
  viewport.taskbarOrder = order.flatMap((id) => {
    const source = id.startsWith("group:") ? id.slice(6) : undefined;
    const derived = groups.filter(
      (group) =>
        group.type === "tool" &&
        group.id !== source &&
        group.data?.sourceGroupId === source &&
        !order.includes(`group:${group.id}`)
    );
    return [id, ...derived.map((group) => `group:${group.id}`)];
  });
  const legacyTerminalOwners = new Map(
    groups.flatMap((group) =>
      group.type === "tool" && group.pageId === "terminal" && typeof group.data?.sourceGroupId === "string"
        ? [[group.data.sourceGroupId, group.id] as const]
        : []
    )
  );
  const terminalsByGroup: WorkspaceState["terminalsByGroup"] = {};
  for (const terminal of snapshot.terminals) {
    const groupId = legacyTerminalOwners.get(terminal.group_id) || terminal.group_id;
    if (groupId)
      (terminalsByGroup[groupId] ||= []).push({
        id: terminal.id,
        name: terminal.name,
        parentId: terminal.parent_id || undefined,
        splitGroupId: terminal.split_group_id || undefined,
        status: terminal.status as "running" | "closed" | "exited",
        pinned: viewport.terminalPinned?.[terminal.id],
      });
  }
  for (const [groupId, terminals] of Object.entries(terminalsByGroup)) {
    const rank = new Map<string, number>(
      (viewport.terminalOrder?.[groupId] || []).map((id: string, index: number) => [id, index])
    );
    terminals.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }
  const terminalLayouts: WorkspaceState["terminalLayouts"] = { ...viewport.terminalLayouts };
  for (const terminals of Object.values(terminalsByGroup)) {
    for (const root of terminals.filter((terminal) => !terminal.parentId)) {
      if (terminalLayouts[root.id]) continue;
      // Older viewports kept split layouts only in memory. Recover their panes from server ownership.
      terminalLayouts[root.id] = { type: "terminal", terminalId: root.id };
      for (const child of terminals.filter((terminal) => terminal.parentId === root.id)) {
        terminalLayouts[root.id] = {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: terminalLayouts[root.id],
          second: { type: "terminal", terminalId: child.id },
        };
      }
    }
  }
  return {
    workspaceNameOverride: snapshot.workspace.name,
    openGroups: groups
      .filter((group) => group.type === "group")
      .map((group) => ({
        ...group,
        activePageId: viewport.activePages?.[group.id] || group.activePageId,
        pages: group.pages.map((page) => ({
          ...page,
          activeTabId: viewport.activeTabs?.[page.id] !== undefined ? viewport.activeTabs[page.id] : page.activeTabId,
        })),
      })),
    openTools: groups
      .filter((group) => group.type === "tool")
      .map((group) => ({
        ...group,
        activeTabId:
          viewport.activeToolTabs?.[group.id] !== undefined ? viewport.activeToolTabs[group.id] : group.activeTabId,
      })),
    activeGroupId: viewport.activeGroupId || null,
    taskbarOrder: viewport.taskbarOrder || [],
    settingsOpen: viewport.settingsOpen === true,
    terminalsByGroup,
    activeTerminalByGroup: viewport.activeTerminalByGroup || {},
    terminalLayouts,
    focusedIdByGroup: viewport.focusedIdByGroup || {},
    listManagerOpenByGroup: viewport.listManagerOpenByGroup || {},
    fileManagerByGroup: {},
  };
}
