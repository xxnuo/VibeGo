import type { SessionInfo, WorkspaceState } from "@/api/session";
import type { TerminalInfo } from "@/api/terminal";
import type { PageGroup } from "@/stores/frame-store";
import type { TerminalSession } from "@/stores/terminal-store";

export const BLOCKTERM_WORKSPACE_SEARCH_LIMIT = 100;

export interface BlockTermWorkspaceInventory {
  workspaceId: string;
  workspaceName: string;
  workspaceOrder: number;
  groups: Array<{
    groupId: string;
    groupOrder: number;
    tabs: Array<{
      tabId: string;
      tabName: string;
      tabOrder: number;
      status?: string;
    }>;
  }>;
}

export interface BlockTermWorkspaceSearchTarget {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceOrder: number;
  groupId: string;
  groupOrder: number;
  tabId: string;
  tabName: string;
  tabOrder: number;
  status?: string;
}

interface BlockTermWorkspaceGroupSource {
  id: string;
  pageId: string;
}

function targetId(workspaceId: string, groupId: string, tabId: string): string {
  return JSON.stringify([workspaceId, groupId, tabId]);
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeLiveTerminal(terminal: TerminalInfo) {
  return {
    id: terminal.id,
    name: terminal.name,
    parentId: terminal.parent_id || undefined,
    status: terminal.status,
    createdAt: terminal.created_at || 0,
  };
}

function createInventory(
  session: Pick<SessionInfo, "id" | "name">,
  workspaceOrder: number,
  groups: readonly BlockTermWorkspaceGroupSource[],
  persistedByGroup: Readonly<Record<string, readonly TerminalSession[] | undefined>>,
  liveTerminals?: readonly TerminalInfo[]
): BlockTermWorkspaceInventory {
  const liveByGroup = new Map<string, ReturnType<typeof normalizeLiveTerminal>[]>();
  for (const terminal of liveTerminals || []) {
    if (terminal.parent_id) continue;
    const list = liveByGroup.get(terminal.group_id) || [];
    list.push(normalizeLiveTerminal(terminal));
    liveByGroup.set(terminal.group_id, list);
  }

  return {
    workspaceId: session.id,
    workspaceName: session.name,
    workspaceOrder,
    groups: groups
      .filter((group) => group.pageId === "blockterm")
      .map((group, groupOrder) => {
        const persisted = (persistedByGroup[group.id] || []).filter((terminal) => !terminal.parentId);
        const live = liveByGroup.get(group.id) || [];
        const liveById = new Map(live.map((terminal) => [terminal.id, terminal]));
        const persistedIds = new Set(persisted.map((terminal) => terminal.id));
        const ordered = liveTerminals
          ? [
              ...persisted.flatMap((terminal) => {
                const current = liveById.get(terminal.id);
                return current ? [current] : [];
              }),
              ...live
                .filter((terminal) => !persistedIds.has(terminal.id))
                .sort((left, right) => left.createdAt - right.createdAt || compareStableText(left.id, right.id)),
            ]
          : persisted.map((terminal, index) => ({
              id: terminal.id,
              name: terminal.name,
              parentId: terminal.parentId,
              status: terminal.status,
              createdAt: index,
            }));
        return {
          groupId: group.id,
          groupOrder,
          tabs: ordered.map((terminal, tabOrder) => ({
            tabId: terminal.id,
            tabName: terminal.name,
            tabOrder,
            status: terminal.status,
          })),
        };
      }),
  };
}

export function createRemoteBlockTermWorkspaceInventory(
  session: Pick<SessionInfo, "id" | "name">,
  workspaceOrder: number,
  state: Pick<WorkspaceState, "openTools" | "terminalsByGroup">,
  liveTerminals?: readonly TerminalInfo[]
): BlockTermWorkspaceInventory {
  return createInventory(session, workspaceOrder, state.openTools, state.terminalsByGroup, liveTerminals);
}

export function createLocalBlockTermWorkspaceInventory(
  session: Pick<SessionInfo, "id" | "name">,
  workspaceOrder: number,
  groups: readonly PageGroup[],
  terminalsByGroup: Readonly<Record<string, readonly TerminalSession[] | undefined>>
): BlockTermWorkspaceInventory {
  return createInventory(
    session,
    workspaceOrder,
    groups.flatMap((group) => (group.type === "tool" ? [{ id: group.id, pageId: group.pageId }] : [])),
    terminalsByGroup
  );
}

export function buildBlockTermWorkspaceSearchTargets(
  inventories: readonly BlockTermWorkspaceInventory[],
  currentWorkspaceId: string | null,
  limit = Number.POSITIVE_INFINITY
): BlockTermWorkspaceSearchTarget[] {
  const targets = inventories
    .flatMap((inventory) =>
      inventory.groups.flatMap((group) =>
        group.tabs.map((tab) => ({
          id: targetId(inventory.workspaceId, group.groupId, tab.tabId),
          workspaceId: inventory.workspaceId,
          workspaceName: inventory.workspaceName,
          workspaceOrder: inventory.workspaceOrder,
          groupId: group.groupId,
          groupOrder: group.groupOrder,
          tabId: tab.tabId,
          tabName: tab.tabName,
          tabOrder: tab.tabOrder,
          status: tab.status,
        }))
      )
    )
    .sort((left, right) => {
      const leftCurrent = left.workspaceId === currentWorkspaceId ? 0 : 1;
      const rightCurrent = right.workspaceId === currentWorkspaceId ? 0 : 1;
      return (
        leftCurrent - rightCurrent ||
        left.workspaceOrder - right.workspaceOrder ||
        left.groupOrder - right.groupOrder ||
        left.tabOrder - right.tabOrder ||
        compareStableText(left.id, right.id)
      );
    });
  return Number.isFinite(limit) ? targets.slice(0, Math.max(0, Math.trunc(limit))) : targets;
}

export function filterBlockTermWorkspaceSearchTargets(
  targets: readonly BlockTermWorkspaceSearchTarget[],
  query: string,
  limit = BLOCKTERM_WORKSPACE_SEARCH_LIMIT
): BlockTermWorkspaceSearchTarget[] {
  const normalized = query.trim().toLocaleLowerCase();
  let filtered: BlockTermWorkspaceSearchTarget[];
  if (!normalized) {
    filtered = [...targets];
  } else {
    const slashIndex = normalized.indexOf("/");
    if (slashIndex >= 0) {
      const workspaceQuery = normalized.slice(0, slashIndex).trim();
      const tabQuery = normalized.slice(slashIndex + 1).trim();
      filtered = targets.filter(
        (target) =>
          target.workspaceName.toLocaleLowerCase().includes(workspaceQuery) &&
          target.tabName.toLocaleLowerCase().includes(tabQuery)
      );
    } else {
      filtered = targets.filter((target) => {
        return (
          target.workspaceName.toLocaleLowerCase().includes(normalized) ||
          target.tabName.toLocaleLowerCase().includes(normalized)
        );
      });
    }
  }
  return Number.isFinite(limit) ? filtered.slice(0, Math.max(0, Math.trunc(limit))) : filtered;
}

export function resolveBlockTermWorkspaceNavigationTarget(
  groups: readonly PageGroup[],
  terminalsByGroup: Readonly<Record<string, readonly TerminalSession[] | undefined>>,
  target: Pick<BlockTermWorkspaceSearchTarget, "groupId" | "tabId">
): { groupId: string; terminalId: string } | null {
  const blockTermGroupIds = groups.flatMap((group) =>
    group.type === "tool" && group.pageId === "blockterm" ? [group.id] : []
  );
  const candidateGroupIds = blockTermGroupIds.includes(target.groupId)
    ? [target.groupId]
    : blockTermGroupIds.length === 1
      ? blockTermGroupIds
      : [];
  for (const groupId of candidateGroupIds) {
    const terminal = (terminalsByGroup[groupId] || []).find((item) => item.id === target.tabId && !item.parentId);
    if (terminal) return { groupId, terminalId: terminal.id };
  }
  return null;
}

export function resolveRequestedBlockTermSessionId(
  requestedId: string | null | undefined,
  currentId: string | null | undefined,
  sessionIds: readonly string[]
): string | null {
  if (!requestedId || requestedId === currentId || !sessionIds.includes(requestedId)) return null;
  return requestedId;
}
