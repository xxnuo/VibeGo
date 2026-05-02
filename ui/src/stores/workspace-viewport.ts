import type { WorkspaceState } from "@/api/session";
import type { WorkspaceSnapshot } from "@/api/workspace-sync";
import { frameFromInventory } from "./workspace-inventory";

const key = (id: string) => `vibego:viewport:${id}`;
const memory = new Map<string, Partial<WorkspaceState>>();

export function saveWorkspaceViewport(id: string, state: WorkspaceState) {
  const viewport = {
    activeGroupId: state.activeGroupId,
    activePages: Object.fromEntries(state.openGroups.map((group) => [group.id, group.activePageId])),
    activeTabs: Object.fromEntries(
      state.openGroups.flatMap((group) => group.pages.map((page) => [page.id, page.activeTabId]))
    ),
    activeToolTabs: Object.fromEntries(state.openTools.map((tool) => [tool.id, tool.activeTabId])),
    activeTerminalByGroup: state.activeTerminalByGroup,
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
  memory.set(id, {
    terminalLayouts: state.terminalLayouts,
    focusedIdByGroup: state.focusedIdByGroup,
    listManagerOpenByGroup: state.listManagerOpenByGroup,
  });
}

export function workspaceSnapshotState(snapshot: WorkspaceSnapshot): WorkspaceState {
  let viewport: Record<string, any> = {};
  try {
    viewport = JSON.parse(window.sessionStorage.getItem(key(snapshot.workspace.id)) || "{}");
  } catch {}
  const groups = frameFromInventory(snapshot, []);
  const terminalsByGroup: WorkspaceState["terminalsByGroup"] = {};
  for (const terminal of snapshot.terminals) {
    if (terminal.group_id)
      (terminalsByGroup[terminal.group_id] ||= []).push({
        id: terminal.id,
        name: terminal.name,
        parentId: terminal.parent_id || undefined,
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
  return {
    workspaceNameOverride: snapshot.workspace.name,
    openGroups: groups
      .filter((group) => group.type === "group")
      .map((group) => ({
        ...group,
        activePageId: viewport.activePages?.[group.id] || group.activePageId,
        pages: group.pages.map((page) => ({
          ...page,
          activeTabId: viewport.activeTabs?.[page.id] || page.activeTabId,
        })),
      })),
    openTools: groups
      .filter((group) => group.type === "tool")
      .map((group) => ({ ...group, activeTabId: viewport.activeToolTabs?.[group.id] || group.activeTabId })),
    activeGroupId: viewport.activeGroupId || null,
    taskbarOrder: viewport.taskbarOrder || [],
    settingsOpen: viewport.settingsOpen === true,
    terminalsByGroup,
    activeTerminalByGroup: viewport.activeTerminalByGroup || {},
    terminalLayouts: {},
    focusedIdByGroup: {},
    listManagerOpenByGroup: {},
    fileManagerByGroup: {},
    ...memory.get(snapshot.workspace.id),
  };
}
