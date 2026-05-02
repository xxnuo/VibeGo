import { create } from "zustand";
import { type TerminalCapabilities, terminalApi } from "@/api/terminal";
import { enqueueWorkspaceMutation } from "@/stores/workspace-mutation-queue";

export type TerminalStatus = "running" | "exited" | "closed";

export interface TerminalSession {
  id: string;
  name: string;
  tabColor?: string;
  tabIcon?: string;
  pinned?: boolean;
  status?: TerminalStatus;
  parentId?: string;
  runtimeType?: string;
  sshProfileId?: string;
  readonly?: boolean;
  capabilities?: TerminalCapabilities;
  cwd?: string;
  currentCwd?: string;
  shellType?: string;
  shellState?: string;
  shellIntegration?: boolean;
  lastCommand?: string;
  lastCommandExitCode?: number | null;
}

export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export interface TerminalLeaf {
  type: "terminal";
  terminalId: string;
}

export type LayoutNode = SplitNode | TerminalLeaf;

export interface ReorderTerminalPagesOptions {
  workspaceSessionId?: string;
}

const terminalReorderMutationVersions = new Map<string, number>();
const terminalReorderStates = new Map<string, { pendingCount: number; confirmedOrder: string[] }>();
let terminalStoreMutationEpoch = 0;

function getTerminalReorderMutationKey(workspaceSessionId: string, groupId: string): string {
  return `${workspaceSessionId}\u0000${groupId}`;
}

function sameTerminalOrder(left: readonly TerminalSession[], right: readonly TerminalSession[]): boolean {
  return left.length === right.length && left.every((terminal, index) => terminal.id === right[index]?.id);
}

function restoreTerminalOrder(
  current: readonly TerminalSession[],
  previousOrder: readonly { id: string }[]
): TerminalSession[] {
  const rank = new Map(previousOrder.map((terminal, index) => [terminal.id, index]));
  return current
    .map((terminal, index) => ({ terminal, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.terminal.id);
      const rightRank = rank.get(right.terminal.id);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ terminal }) => terminal);
}

function resolveTerminalRootId(terminal: TerminalSession, terminalsById: ReadonlyMap<string, TerminalSession>): string {
  let current = terminal;
  const visited = new Set<string>();
  while (current.parentId && terminalsById.has(current.parentId) && !visited.has(current.id)) {
    visited.add(current.id);
    current = terminalsById.get(current.parentId) as TerminalSession;
  }
  return current.id;
}

function reorderTerminalInventory(
  terminals: readonly TerminalSession[],
  fromId: string,
  toId: string
): TerminalSession[] {
  if (fromId === toId) return [...terminals];
  const terminalsById = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  const from = terminalsById.get(fromId);
  const to = terminalsById.get(toId);
  if (!from || !to) return [...terminals];

  const fromRootId = resolveTerminalRootId(from, terminalsById);
  const toRootId = resolveTerminalRootId(to, terminalsById);
  if (fromRootId === toRootId) return [...terminals];

  const terminalsByRoot = new Map<string, TerminalSession[]>();
  const rootOrder: string[] = [];
  for (const terminal of terminals) {
    const rootId = resolveTerminalRootId(terminal, terminalsById);
    if (!terminalsByRoot.has(rootId)) {
      terminalsByRoot.set(rootId, []);
      rootOrder.push(rootId);
    }
    terminalsByRoot.get(rootId)?.push(terminal);
  }

  const fromIndex = rootOrder.indexOf(fromRootId);
  const toIndex = rootOrder.indexOf(toRootId);
  if (fromIndex < 0 || toIndex < 0) return [...terminals];
  const nextRootOrder = [...rootOrder];
  const [movedRootId] = nextRootOrder.splice(fromIndex, 1);
  nextRootOrder.splice(toIndex, 0, movedRootId);
  return nextRootOrder.flatMap((rootId) => terminalsByRoot.get(rootId) || []);
}

function buildTerminalReorderWorkspaceInventory(
  workspaceSessionId: string,
  terminalsByGroup: Record<string, TerminalSession[]>,
  targetGroupId: string,
  targetOrder: readonly TerminalSession[]
): Record<string, TerminalSession[]> {
  const result = Object.fromEntries(
    Object.entries(terminalsByGroup).map(([groupId, terminals]) => {
      if (groupId === targetGroupId) {
        return [groupId, restoreTerminalOrder(terminals, targetOrder)];
      }
      const pendingState = terminalReorderStates.get(getTerminalReorderMutationKey(workspaceSessionId, groupId));
      if (pendingState?.pendingCount) {
        return [
          groupId,
          restoreTerminalOrder(
            terminals,
            pendingState.confirmedOrder.map((id) => ({ id }))
          ),
        ];
      }
      return [groupId, terminals];
    })
  );
  if (!(targetGroupId in result)) {
    result[targetGroupId] = [];
  }
  return result;
}

/**
 * Reapply an in-flight optimistic order after a remote terminal list is
 * reconciled. The list response carries no ordering contract, so a late
 * refresh must not replace a drag operation that is still awaiting sync.
 */
export function preservePendingTerminalReorder(
  workspaceSessionId: string,
  currentTerminalsByGroup: Record<string, TerminalSession[]>,
  nextTerminalsByGroup: Record<string, TerminalSession[]>
): Record<string, TerminalSession[]> {
  if (!workspaceSessionId) return nextTerminalsByGroup;
  const result = { ...nextTerminalsByGroup };
  for (const [groupId, nextTerminals] of Object.entries(result)) {
    const pendingState = terminalReorderStates.get(getTerminalReorderMutationKey(workspaceSessionId, groupId));
    if (!pendingState?.pendingCount) continue;
    const optimistic = currentTerminalsByGroup[groupId] || pendingState.confirmedOrder.map((id) => ({ id, name: id }));
    result[groupId] = restoreTerminalOrder(nextTerminals, optimistic);
  }
  return result;
}

function findTerminalIds(node: LayoutNode): string[] {
  if (node.type === "terminal") return [node.terminalId];
  return [...findTerminalIds(node.first), ...findTerminalIds(node.second)];
}

function removeTerminalFromLayout(node: LayoutNode, terminalId: string): LayoutNode | null {
  if (node.type === "terminal") {
    return node.terminalId === terminalId ? null : node;
  }
  if (node.first.type === "terminal" && node.first.terminalId === terminalId) return node.second;
  if (node.second.type === "terminal" && node.second.terminalId === terminalId) return node.first;
  const newFirst = removeTerminalFromLayout(node.first, terminalId);
  if (newFirst !== node.first) return newFirst ? { ...node, first: newFirst } : node.second;
  const newSecond = removeTerminalFromLayout(node.second, terminalId);
  if (newSecond !== node.second) return newSecond ? { ...node, second: newSecond } : node.first;
  return node;
}

function splitTerminalInLayout(
  node: LayoutNode,
  terminalId: string,
  newTerminalId: string,
  direction: SplitDirection
): LayoutNode {
  if (node.type === "terminal") {
    if (node.terminalId === terminalId) {
      return {
        type: "split",
        direction,
        ratio: 0.5,
        first: node,
        second: { type: "terminal", terminalId: newTerminalId },
      };
    }
    return node;
  }
  return {
    ...node,
    first: splitTerminalInLayout(node.first, terminalId, newTerminalId, direction),
    second: splitTerminalInLayout(node.second, terminalId, newTerminalId, direction),
  };
}

function updateRatioAtPath(node: LayoutNode, path: number[], ratio: number): LayoutNode {
  if (path.length === 0 && node.type === "split") return { ...node, ratio };
  if (node.type !== "split" || path.length === 0) return node;
  const [head, ...rest] = path;
  if (head === 0) return { ...node, first: updateRatioAtPath(node.first, rest, ratio) };
  return { ...node, second: updateRatioAtPath(node.second, rest, ratio) };
}

function containsTerminal(node: LayoutNode, terminalId: string): boolean {
  if (node.type === "terminal") return node.terminalId === terminalId;
  return containsTerminal(node.first, terminalId) || containsTerminal(node.second, terminalId);
}

interface TerminalState {
  terminalsByGroup: Record<string, TerminalSession[]>;
  activeIdByGroup: Record<string, string | null>;
  listManagerOpenByGroup: Record<string, boolean>;
  terminalLayouts: Record<string, LayoutNode>;
  focusedIdByGroup: Record<string, string | null>;

  getTerminals: (groupId: string) => TerminalSession[];
  getRootTerminals: (groupId: string) => TerminalSession[];
  addTerminal: (groupId: string, terminal: TerminalSession) => void;
  removeTerminal: (groupId: string, terminalId: string) => void;
  clearAllTerminals: (groupId: string) => void;
  clearGroupData: (groupId: string) => void;
  getActiveId: (groupId: string) => string | null;
  setActiveId: (groupId: string, terminalId: string | null) => void;
  updateTerminal: (groupId: string, id: string, updates: Partial<TerminalSession>) => void;
  renameTerminal: (groupId: string, id: string, name: string) => void;
  pinTerminal: (groupId: string, id: string) => void;
  setTerminalStatus: (groupId: string, id: string, status: TerminalStatus) => void;
  isListManagerOpen: (groupId: string) => boolean;
  setListManagerOpen: (groupId: string, open: boolean) => void;

  getActiveLayout: (groupId: string) => LayoutNode | null;
  setTerminalLayout: (rootId: string, layout: LayoutNode | null) => void;
  bulkSetTerminalLayouts: (layouts: Record<string, LayoutNode>) => void;
  getFocusedId: (groupId: string) => string | null;
  setFocusedId: (groupId: string, terminalId: string | null) => void;
  getTerminalPageIds: (groupId: string, terminalId: string) => string[];
  reorderTerminalPages: (
    groupId: string,
    fromId: string,
    toId: string,
    options?: ReorderTerminalPagesOptions
  ) => Promise<boolean>;
  splitTerminal: (rootId: string, targetPaneId: string, newTerminalId: string, direction: SplitDirection) => void;
  closeFromLayout: (groupId: string, terminalId: string) => void;
  removeTerminalPage: (groupId: string, terminalId: string) => void;
  updateSplitRatio: (groupId: string, path: number[], ratio: number) => void;
  isSplit: (groupId: string) => boolean;
  getActiveLayoutTerminalIds: (groupId: string) => string[];
  getRootIdForTerminal: (groupId: string, terminalId: string) => string | null;

  reset: () => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminalsByGroup: {},
  activeIdByGroup: {},
  listManagerOpenByGroup: {},
  terminalLayouts: {},
  focusedIdByGroup: {},

  getTerminals: (groupId) => get().terminalsByGroup[groupId] || [],

  getRootTerminals: (groupId) => (get().terminalsByGroup[groupId] || []).filter((t) => !t.parentId),

  addTerminal: (groupId, terminal) =>
    set((s) => {
      const newTerminal = { ...terminal, status: "running" as TerminalStatus };
      const newTerminals = [...(s.terminalsByGroup[groupId] || []), newTerminal];

      if (terminal.parentId) {
        return { terminalsByGroup: { ...s.terminalsByGroup, [groupId]: newTerminals } };
      }

      return {
        terminalsByGroup: { ...s.terminalsByGroup, [groupId]: newTerminals },
        activeIdByGroup: { ...s.activeIdByGroup, [groupId]: terminal.id },
        listManagerOpenByGroup: { ...s.listManagerOpenByGroup, [groupId]: false },
        terminalLayouts: { ...s.terminalLayouts, [terminal.id]: { type: "terminal", terminalId: terminal.id } },
        focusedIdByGroup: { ...s.focusedIdByGroup, [groupId]: terminal.id },
      };
    }),

  removeTerminal: (groupId, terminalId) =>
    set((s) => {
      const terminals = s.terminalsByGroup[groupId] || [];
      const terminal = terminals.find((t) => t.id === terminalId);
      if (!terminal) return s;

      const isRoot = !terminal.parentId;
      let newTerminals = terminals.filter((t) => t.id !== terminalId);
      const newLayouts = { ...s.terminalLayouts };
      let activeId = s.activeIdByGroup[groupId];
      let focusedId = s.focusedIdByGroup[groupId];

      if (isRoot) {
        const layout = newLayouts[terminalId];
        if (layout && layout.type === "split") {
          const remaining = removeTerminalFromLayout(layout, terminalId);
          delete newLayouts[terminalId];
          if (remaining) {
            const ids = findTerminalIds(remaining);
            const newRootId = ids[0];
            newLayouts[newRootId] = remaining;
            newTerminals = newTerminals.map((t) => {
              if (t.id === newRootId) return { ...t, parentId: undefined };
              if (t.parentId === terminalId) return { ...t, parentId: newRootId };
              return t;
            });
            if (activeId === terminalId) activeId = newRootId;
            if (focusedId === terminalId) focusedId = ids[0];
          } else {
            const roots = newTerminals.filter((t) => !t.parentId);
            if (activeId === terminalId) activeId = roots.length > 0 ? roots[roots.length - 1].id : null;
            if (focusedId === terminalId) focusedId = activeId;
          }
        } else {
          delete newLayouts[terminalId];
          const childIds = new Set(newTerminals.filter((t) => t.parentId === terminalId).map((t) => t.id));
          if (childIds.size > 0) {
            newTerminals = newTerminals.filter((t) => !childIds.has(t.id));
            for (const cid of childIds) delete newLayouts[cid];
          }
          const roots = newTerminals.filter((t) => !t.parentId);
          if (activeId === terminalId) {
            activeId = roots.length > 0 ? roots[roots.length - 1].id : null;
          }
          if (focusedId === terminalId) focusedId = activeId;
        }
      } else {
        const rootId = terminal.parentId!;
        const rootLayout = newLayouts[rootId];
        if (rootLayout) {
          const updated = removeTerminalFromLayout(rootLayout, terminalId);
          if (updated) newLayouts[rootId] = updated;
          else delete newLayouts[rootId];
        }
        if (focusedId === terminalId) {
          const updatedLayout = newLayouts[rootId];
          if (updatedLayout) {
            const ids = findTerminalIds(updatedLayout);
            focusedId = ids[0] || rootId;
          } else {
            focusedId = rootId;
          }
        }
      }

      return {
        terminalsByGroup: { ...s.terminalsByGroup, [groupId]: newTerminals },
        activeIdByGroup: { ...s.activeIdByGroup, [groupId]: activeId },
        terminalLayouts: newLayouts,
        focusedIdByGroup: { ...s.focusedIdByGroup, [groupId]: focusedId },
      };
    }),

  clearAllTerminals: (groupId) =>
    set((s) => {
      const terminals = s.terminalsByGroup[groupId] || [];
      const newLayouts = { ...s.terminalLayouts };
      for (const t of terminals) delete newLayouts[t.id];
      return {
        terminalsByGroup: { ...s.terminalsByGroup, [groupId]: [] },
        activeIdByGroup: { ...s.activeIdByGroup, [groupId]: null },
        terminalLayouts: newLayouts,
        focusedIdByGroup: { ...s.focusedIdByGroup, [groupId]: null },
      };
    }),

  clearGroupData: (groupId) =>
    set((s) => {
      const terminals = s.terminalsByGroup[groupId] || [];
      const newLayouts = { ...s.terminalLayouts };
      for (const t of terminals) delete newLayouts[t.id];
      const { [groupId]: _t, ...restTerminals } = s.terminalsByGroup;
      const { [groupId]: _a, ...restActiveIds } = s.activeIdByGroup;
      const { [groupId]: _l, ...restListManager } = s.listManagerOpenByGroup;
      const { [groupId]: _f, ...restFocused } = s.focusedIdByGroup;
      return {
        terminalsByGroup: restTerminals,
        activeIdByGroup: restActiveIds,
        listManagerOpenByGroup: restListManager,
        terminalLayouts: newLayouts,
        focusedIdByGroup: restFocused,
      };
    }),

  getActiveId: (groupId) => get().activeIdByGroup[groupId] || null,

  setActiveId: (groupId, terminalId) =>
    set((s) => ({
      activeIdByGroup: { ...s.activeIdByGroup, [groupId]: terminalId },
      listManagerOpenByGroup: { ...s.listManagerOpenByGroup, [groupId]: false },
      focusedIdByGroup: { ...s.focusedIdByGroup, [groupId]: terminalId },
    })),

  updateTerminal: (groupId, id, updates) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: (s.terminalsByGroup[groupId] || []).map((t) => (t.id === id ? { ...t, ...updates } : t)),
      },
    })),

  renameTerminal: (groupId, id, name) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: (s.terminalsByGroup[groupId] || []).map((t) => (t.id === id ? { ...t, name } : t)),
      },
    })),

  pinTerminal: (groupId, id) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: (s.terminalsByGroup[groupId] || []).map((t) => (t.id === id ? { ...t, pinned: true } : t)),
      },
    })),

  setTerminalStatus: (groupId, id, status) =>
    set((s) => ({
      terminalsByGroup: {
        ...s.terminalsByGroup,
        [groupId]: (s.terminalsByGroup[groupId] || []).map((t) => (t.id === id ? { ...t, status } : t)),
      },
    })),

  isListManagerOpen: (groupId) => {
    const state = get().listManagerOpenByGroup[groupId];
    return state === undefined ? true : state;
  },

  setListManagerOpen: (groupId, open) =>
    set((s) => ({ listManagerOpenByGroup: { ...s.listManagerOpenByGroup, [groupId]: open } })),

  getActiveLayout: (groupId) => {
    const activeId = get().activeIdByGroup[groupId];
    if (!activeId) return null;
    return get().terminalLayouts[activeId] || null;
  },

  setTerminalLayout: (rootId, layout) =>
    set((s) => {
      const newLayouts = { ...s.terminalLayouts };
      if (layout) newLayouts[rootId] = layout;
      else delete newLayouts[rootId];
      return { terminalLayouts: newLayouts };
    }),

  bulkSetTerminalLayouts: (layouts) => set((s) => ({ terminalLayouts: { ...s.terminalLayouts, ...layouts } })),

  getFocusedId: (groupId) => get().focusedIdByGroup[groupId] || null,

  setFocusedId: (groupId, terminalId) =>
    set((s) => ({ focusedIdByGroup: { ...s.focusedIdByGroup, [groupId]: terminalId } })),

  getTerminalPageIds: (groupId, terminalId) => {
    const terminals = get().terminalsByGroup[groupId] || [];
    const terminal = terminals.find((item) => item.id === terminalId);
    if (!terminal) return [];
    const rootId = terminal.parentId || terminal.id;
    const layout = get().terminalLayouts[rootId];
    return layout ? findTerminalIds(layout) : [rootId];
  },

  reorderTerminalPages: async (groupId, fromId, toId, options) => {
    const previous = get().terminalsByGroup[groupId] || [];
    const optimistic = reorderTerminalInventory(previous, fromId, toId);
    if (sameTerminalOrder(previous, optimistic)) return false;

    const workspaceSessionId = options?.workspaceSessionId?.trim() || "";
    // A detached/local-only terminal still needs the optimistic reorder, but
    // there is no durable mutation to track or roll back.
    if (!workspaceSessionId) {
      set((state) => ({
        terminalsByGroup: { ...state.terminalsByGroup, [groupId]: optimistic },
      }));
      return true;
    }

    const mutationKey = getTerminalReorderMutationKey(workspaceSessionId, groupId);
    const mutationVersion = (terminalReorderMutationVersions.get(mutationKey) || 0) + 1;
    const mutationEpoch = terminalStoreMutationEpoch;
    let mutationState = terminalReorderStates.get(mutationKey);
    if (!mutationState || mutationState.pendingCount === 0) {
      mutationState = { pendingCount: 0, confirmedOrder: previous.map((terminal) => terminal.id) };
      terminalReorderStates.set(mutationKey, mutationState);
    }
    mutationState.pendingCount += 1;
    terminalReorderMutationVersions.set(mutationKey, mutationVersion);
    set((state) => ({
      terminalsByGroup: { ...state.terminalsByGroup, [groupId]: optimistic },
    }));

    try {
      const savedOrder = await enqueueWorkspaceMutation(async () => {
        if (terminalStoreMutationEpoch !== mutationEpoch) {
          throw new Error("terminal reorder superseded");
        }
        const currentState = get();
        const terminalsByGroup = buildTerminalReorderWorkspaceInventory(
          workspaceSessionId,
          currentState.terminalsByGroup,
          groupId,
          optimistic
        );
        const assignments = Object.entries(terminalsByGroup).flatMap(([ownerGroupId, terminals]) =>
          terminals.map((terminal) => ({
            id: terminal.id,
            group_id: ownerGroupId,
            parent_id: terminal.parentId,
          }))
        );
        await terminalApi.syncWorkspace(workspaceSessionId, assignments, {
          terminalsByGroup,
          activeTerminalByGroup: currentState.activeIdByGroup,
          listManagerOpenByGroup: currentState.listManagerOpenByGroup,
          terminalLayouts: currentState.terminalLayouts,
          focusedIdByGroup: currentState.focusedIdByGroup,
        });
        if (terminalStoreMutationEpoch !== mutationEpoch) {
          throw new Error("terminal reorder superseded");
        }
        const savedOrder = terminalsByGroup[groupId].map((terminal) => terminal.id);
        mutationState.confirmedOrder = savedOrder;
        return savedOrder;
      });
      if (terminalStoreMutationEpoch !== mutationEpoch) return false;
      mutationState.confirmedOrder = savedOrder;
      return true;
    } catch (error) {
      const current = get().terminalsByGroup[groupId] || [];
      if (
        terminalStoreMutationEpoch === mutationEpoch &&
        terminalReorderMutationVersions.get(mutationKey) === mutationVersion &&
        sameTerminalOrder(current, optimistic)
      ) {
        set((state) => ({
          terminalsByGroup: {
            ...state.terminalsByGroup,
            [groupId]: restoreTerminalOrder(
              state.terminalsByGroup[groupId] || [],
              mutationState.confirmedOrder.map((id) => ({ id }))
            ),
          },
        }));
        throw error;
      }
      return false;
    } finally {
      mutationState.pendingCount -= 1;
      if (mutationState.pendingCount === 0 && terminalReorderStates.get(mutationKey) === mutationState) {
        terminalReorderStates.delete(mutationKey);
        if (terminalReorderMutationVersions.get(mutationKey) === mutationVersion) {
          terminalReorderMutationVersions.delete(mutationKey);
        }
      }
    }
  },

  splitTerminal: (rootId, targetPaneId, newTerminalId, direction) =>
    set((s) => {
      const layout = s.terminalLayouts[rootId];
      if (!layout) return s;
      return {
        terminalLayouts: {
          ...s.terminalLayouts,
          [rootId]: splitTerminalInLayout(layout, targetPaneId, newTerminalId, direction),
        },
      };
    }),

  closeFromLayout: (groupId, terminalId) =>
    set((s) => {
      const newLayouts = { ...s.terminalLayouts };
      let focusedId = s.focusedIdByGroup[groupId];
      for (const [key, layout] of Object.entries(newLayouts)) {
        if (containsTerminal(layout, terminalId)) {
          const updated = removeTerminalFromLayout(layout, terminalId);
          if (updated) newLayouts[key] = updated;
          else delete newLayouts[key];
          break;
        }
      }
      if (focusedId === terminalId) {
        const activeId = s.activeIdByGroup[groupId];
        if (activeId && newLayouts[activeId]) {
          const ids = findTerminalIds(newLayouts[activeId]);
          focusedId = ids[0] || null;
        } else {
          focusedId = activeId;
        }
      }
      return { terminalLayouts: newLayouts, focusedIdByGroup: { ...s.focusedIdByGroup, [groupId]: focusedId } };
    }),

  removeTerminalPage: (groupId, terminalId) =>
    set((s) => {
      const terminals = s.terminalsByGroup[groupId] || [];
      const terminal = terminals.find((item) => item.id === terminalId);
      if (!terminal) return s;

      const rootId = terminal.parentId || terminal.id;
      const layout = s.terminalLayouts[rootId];
      const terminalIds = layout ? findTerminalIds(layout) : [rootId];
      const idsToRemove = new Set(terminalIds);
      const newTerminals = terminals.filter((item) => !idsToRemove.has(item.id));
      const newLayouts = { ...s.terminalLayouts };
      delete newLayouts[rootId];

      const roots = newTerminals.filter((item) => !item.parentId);
      let activeId = s.activeIdByGroup[groupId];
      if (!activeId || idsToRemove.has(activeId)) {
        activeId = roots.length > 0 ? roots[roots.length - 1].id : null;
      }

      let focusedId = s.focusedIdByGroup[groupId];
      if (!focusedId || idsToRemove.has(focusedId)) {
        if (activeId) {
          const activeLayout = newLayouts[activeId];
          focusedId = activeLayout ? findTerminalIds(activeLayout)[0] || activeId : activeId;
        } else {
          focusedId = null;
        }
      }

      return {
        terminalsByGroup: { ...s.terminalsByGroup, [groupId]: newTerminals },
        activeIdByGroup: { ...s.activeIdByGroup, [groupId]: activeId },
        terminalLayouts: newLayouts,
        focusedIdByGroup: { ...s.focusedIdByGroup, [groupId]: focusedId },
      };
    }),

  updateSplitRatio: (groupId, path, ratio) =>
    set((s) => {
      const activeId = s.activeIdByGroup[groupId];
      if (!activeId) return s;
      const layout = s.terminalLayouts[activeId];
      if (!layout) return s;
      return { terminalLayouts: { ...s.terminalLayouts, [activeId]: updateRatioAtPath(layout, path, ratio) } };
    }),

  isSplit: (groupId) => {
    const layout = get().getActiveLayout(groupId);
    return !!layout && layout.type === "split";
  },

  getActiveLayoutTerminalIds: (groupId) => {
    const layout = get().getActiveLayout(groupId);
    if (!layout) return [];
    return findTerminalIds(layout);
  },

  getRootIdForTerminal: (groupId, terminalId) => {
    const terminals = get().terminalsByGroup[groupId] || [];
    const t = terminals.find((x) => x.id === terminalId);
    return t?.parentId || terminalId;
  },

  reset: () => {
    terminalStoreMutationEpoch += 1;
    terminalReorderMutationVersions.clear();
    terminalReorderStates.clear();
    set({
      terminalsByGroup: {},
      activeIdByGroup: {},
      listManagerOpenByGroup: {},
      terminalLayouts: {},
      focusedIdByGroup: {},
    });
  },
}));
