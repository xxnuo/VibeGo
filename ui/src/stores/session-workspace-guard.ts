import type { LayoutNode, TerminalSession } from "./terminal-store";

export interface WorkspaceFrameGroup {
  id: string;
  type: string;
  pageId?: string;
  pages?: Array<{ type: string }>;
}

export interface WorkspaceSaveLatch {
  sessionId: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export function createWorkspaceSaveLatch(sessionId: string): WorkspaceSaveLatch {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => {});
  return { sessionId, promise, resolve, reject };
}

export function getTerminalWorkspaceGroupIds(groups: readonly WorkspaceFrameGroup[]): Set<string> {
  return new Set(
    groups
      .filter(
        (group) =>
          (group.type === "group" && group.pages?.some((page) => page.type === "terminal")) ||
          (group.type === "tool" && group.pageId === "blockterm")
      )
      .map((group) => group.id)
  );
}

export interface TerminalWorkspaceState {
  terminalsByGroup: Record<string, TerminalSession[]>;
  activeTerminalByGroup: Record<string, string | null>;
  listManagerOpenByGroup: Record<string, boolean>;
  terminalLayouts: Record<string, LayoutNode>;
  focusedIdByGroup: Record<string, string | null>;
}

function collectLayoutTerminalIds(node: LayoutNode): string[] {
  if (node.type === "terminal") {
    return [node.terminalId];
  }
  return [...collectLayoutTerminalIds(node.first), ...collectLayoutTerminalIds(node.second)];
}

function sanitizeLayoutNode(node: LayoutNode, validTerminalIds: Set<string>): LayoutNode | null {
  if (node.type === "terminal") {
    return validTerminalIds.has(node.terminalId) ? node : null;
  }

  const first = sanitizeLayoutNode(node.first, validTerminalIds);
  const second = sanitizeLayoutNode(node.second, validTerminalIds);

  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function sanitizeTerminalWorkspaceState(
  state: TerminalWorkspaceState,
  validGroupIds?: ReadonlySet<string>
): TerminalWorkspaceState {
  const terminalsByGroup: Record<string, TerminalSession[]> = {};
  const validTerminalIds = new Set<string>();

  for (const [groupId, terminals] of Object.entries(state.terminalsByGroup)) {
    if (validGroupIds && !validGroupIds.has(groupId)) continue;
    const deduped = new Map<string, TerminalSession>();
    for (const terminal of terminals) {
      if (!terminal.id || deduped.has(terminal.id)) continue;
      deduped.set(terminal.id, { ...terminal });
      validTerminalIds.add(terminal.id);
    }

    const groupTerminalIds = new Set(deduped.keys());
    terminalsByGroup[groupId] = Array.from(deduped.values()).map((terminal) => ({
      ...terminal,
      parentId:
        terminal.parentId && terminal.parentId !== terminal.id && groupTerminalIds.has(terminal.parentId)
          ? terminal.parentId
          : undefined,
    }));
  }

  const terminalLayouts: Record<string, LayoutNode> = {};
  for (const [rootId, layout] of Object.entries(state.terminalLayouts)) {
    const sanitized = sanitizeLayoutNode(layout, validTerminalIds);
    if (!sanitized) continue;
    const layoutTerminalIds = collectLayoutTerminalIds(sanitized);
    if (layoutTerminalIds.length === 0) continue;
    const nextRootId = validTerminalIds.has(rootId) ? rootId : layoutTerminalIds[0];
    terminalLayouts[nextRootId] = sanitized;
  }

  const activeTerminalByGroup: Record<string, string | null> = {};
  const focusedIdByGroup: Record<string, string | null> = {};
  const listManagerOpenByGroup: Record<string, boolean> = {};

  for (const [groupId, terminals] of Object.entries(terminalsByGroup)) {
    const groupTerminalIds = new Set(terminals.map((terminal) => terminal.id));
    const activeId = state.activeTerminalByGroup[groupId];
    const focusedId = state.focusedIdByGroup[groupId];
    activeTerminalByGroup[groupId] = activeId && groupTerminalIds.has(activeId) ? activeId : null;
    focusedIdByGroup[groupId] = focusedId && groupTerminalIds.has(focusedId) ? focusedId : null;
    listManagerOpenByGroup[groupId] =
      terminals.filter((terminal) => !terminal.parentId).length === 0 ? true : !!state.listManagerOpenByGroup[groupId];
  }

  return {
    terminalsByGroup,
    activeTerminalByGroup,
    listManagerOpenByGroup,
    terminalLayouts,
    focusedIdByGroup,
  };
}

export async function saveLatestWorkspaceSnapshot<T>(
  getMutationRevision: () => number,
  buildSnapshot: () => T,
  saveSnapshot: (snapshot: T) => Promise<void>
): Promise<void> {
  for (;;) {
    const mutationRevision = getMutationRevision();
    const snapshot = buildSnapshot();
    await saveSnapshot(snapshot);
    if (getMutationRevision() === mutationRevision) return;
  }
}
