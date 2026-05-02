import type { TerminalWorkspaceState } from "./session-workspace-guard";
import type { LayoutNode, TerminalSession } from "./terminal-store";

export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;

export function clampSplitRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio)) : 0.5;
}

export function layoutTerminalIds(node: LayoutNode): string[] {
  return node.type === "terminal"
    ? [node.terminalId]
    : [...layoutTerminalIds(node.first), ...layoutTerminalIds(node.second)];
}

export function pruneTerminalLayout(
  node: LayoutNode,
  valid: ReadonlySet<string>,
  seen = new Set<string>()
): LayoutNode | null {
  if (node.type === "terminal") {
    if (!valid.has(node.terminalId) || seen.has(node.terminalId)) return null;
    seen.add(node.terminalId);
    return node;
  }
  const first = pruneTerminalLayout(node.first, valid, seen);
  const second = pruneTerminalLayout(node.second, valid, seen);
  if (!first) return second;
  if (!second) return first;
  return { ...node, ratio: clampSplitRatio(node.ratio), first, second };
}

export function balanceTerminalLayout(node: LayoutNode): LayoutNode {
  if (node.type === "terminal") return node;
  const first = balanceTerminalLayout(node.first);
  const second = balanceTerminalLayout(node.second);
  return { ...node, first, second, ratio: layoutTerminalIds(first).length / layoutTerminalIds(node).length };
}

// Runtime ancestry identifies a tab; the visible root is free to change as panes exit.
export function normalizeTerminalWorkspace(
  state: TerminalWorkspaceState,
  validGroupIds?: ReadonlySet<string>
): TerminalWorkspaceState {
  const result: TerminalWorkspaceState = {
    terminalsByGroup: {},
    activeTerminalByGroup: {},
    focusedIdByGroup: {},
    listManagerOpenByGroup: {},
    terminalLayouts: {},
  };
  const retired = new Set(state.retiredTerminalIds);
  for (const [groupId, inventory] of Object.entries(state.terminalsByGroup)) {
    if (validGroupIds && !validGroupIds.has(groupId)) continue;
    const byId = new Map(inventory.filter((item) => item.id).map((item) => [item.id, item]));
    const familyOf = (terminal: TerminalSession): string => {
      if (terminal.splitGroupId) return terminal.splitGroupId;
      let current = terminal;
      const visited = new Set<string>();
      while (current.parentId && !visited.has(current.id)) {
        visited.add(current.id);
        const parent = byId.get(current.parentId);
        if (!parent) return current.splitGroupId || current.parentId;
        current = parent;
      }
      if (visited.has(current.id)) return [...visited].sort()[0];
      return current.splitGroupId || current.id;
    };
    const families = new Map<string, TerminalSession[]>();
    for (const item of byId.values()) {
      const family = familyOf(item);
      const members = families.get(family) || [];
      members.push(item);
      families.set(family, members);
    }
    const roots = new Map<string, string>();
    const visible: TerminalSession[] = [];
    for (const [family, members] of families) {
      const split = members.length > 1 || members.some((item) => item.parentId || item.splitGroupId);
      const live = members.filter((item) => item.status !== "closed" && (!split || item.status !== "exited"));
      for (const item of members) if (!live.some((pane) => pane.id === item.id)) retired.add(item.id);
      if (!live.length) continue;
      const valid = new Set(live.map((item) => item.id));
      // Prefer the saved tree, including when its original root is now history-only.
      const candidates = Object.entries(state.terminalLayouts)
        .map(([id, tree]) => ({ id, tree, count: layoutTerminalIds(tree).filter((id) => valid.has(id)).length }))
        .filter((item) => item.count > 0)
        .sort((a, b) => b.count - a.count);
      const saved = candidates[0];
      let layout = saved ? pruneTerminalLayout(saved.tree, valid) : null;
      const rootId =
        saved && valid.has(saved.id)
          ? saved.id
          : (layout && layoutTerminalIds(layout)[0]) || live.find((item) => !item.parentId)?.id || live[0].id;
      const placed = new Set(layout ? layoutTerminalIds(layout) : []);
      for (const item of live) {
        if (placed.has(item.id)) continue;
        const leaf: LayoutNode = { type: "terminal", terminalId: item.id };
        layout = layout ? { type: "split", direction: "horizontal", ratio: 0.5, first: layout, second: leaf } : leaf;
        placed.add(item.id);
      }
      result.terminalLayouts[rootId] = layout!;
      roots.set(family, rootId);
      if (saved) roots.set(saved.id, rootId);
      for (const item of members) roots.set(item.id, rootId);
      for (const item of live)
        visible.push({
          ...item,
          parentId: item.id === rootId ? undefined : rootId,
          splitGroupId: split ? family : undefined,
        });
    }
    const active = state.activeTerminalByGroup[groupId];
    let activeId = active ? roots.get(active) || null : null;
    if (!activeId && active && byId.has(active)) {
      const order = [...families.keys()];
      const index = order.indexOf(familyOf(byId.get(active)!));
      const adjacent = [...order.slice(index + 1), ...order.slice(0, index).reverse()].find((id) => roots.has(id));
      activeId = adjacent ? roots.get(adjacent)! : null;
    }
    const focused = state.focusedIdByGroup[groupId];
    const activePanes = activeId ? layoutTerminalIds(result.terminalLayouts[activeId]) : [];
    const previousTree = active ? state.terminalLayouts[active] : undefined;
    const previousOrder = previousTree ? layoutTerminalIds(previousTree) : [];
    const focusedIndex = focused ? previousOrder.indexOf(focused) : -1;
    const neighbor =
      focusedIndex < 0
        ? undefined
        : [...previousOrder.slice(focusedIndex + 1), ...previousOrder.slice(0, focusedIndex).reverse()].find((id) =>
            activePanes.includes(id)
          );
    result.terminalsByGroup[groupId] = visible;
    result.activeTerminalByGroup[groupId] = activeId;
    result.focusedIdByGroup[groupId] =
      focused && activePanes.includes(focused) ? focused : neighbor || activePanes[0] || null;
    result.listManagerOpenByGroup[groupId] = !visible.length || !activeId || !!state.listManagerOpenByGroup[groupId];
  }
  result.retiredTerminalIds = [...retired];
  return result;
}

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TerminalPaneRect extends PaneRect {
  terminalId: string;
}
export interface TerminalDividerRect extends PaneRect {
  path: number[];
  vertical: boolean;
  ratio: number;
}

export function terminalLayoutRects(layout: LayoutNode, stacked = false) {
  const panes: TerminalPaneRect[] = [];
  const dividers: TerminalDividerRect[] = [];
  const visit = (node: LayoutNode, rect: PaneRect, path: number[]) => {
    if (node.type === "terminal") {
      panes.push({ ...rect, terminalId: node.terminalId });
      return;
    }
    const vertical = stacked || node.direction === "vertical";
    const ratio = clampSplitRatio(node.ratio);
    dividers.push({ ...rect, path, vertical, ratio });
    visit(
      node.first,
      { ...rect, width: rect.width * (vertical ? 1 : ratio), height: rect.height * (vertical ? ratio : 1) },
      [...path, 0]
    );
    visit(
      node.second,
      {
        x: rect.x + (vertical ? 0 : rect.width * ratio),
        y: rect.y + (vertical ? rect.height * ratio : 0),
        width: rect.width * (vertical ? 1 : 1 - ratio),
        height: rect.height * (vertical ? 1 - ratio : 1),
      },
      [...path, 1]
    );
  };
  visit(layout, { x: 0, y: 0, width: 1, height: 1 }, []);
  return { panes, dividers };
}
