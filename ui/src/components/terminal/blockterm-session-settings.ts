export const BLOCKTERM_TAB_COLORS = [
  "default",
  "red",
  "orange",
  "yellow",
  "green",
  "mint",
  "cyan",
  "blue",
  "violet",
  "pink",
  "white",
] as const;

export const BLOCKTERM_TAB_ICONS = [
  "default",
  "square",
  "sparkle",
  "fire",
  "ghost",
  "cloud",
  "compass",
  "crown",
  "droplet",
  "graduation-cap",
  "heart",
  "file",
] as const;

export type BlockTermTabColor = (typeof BLOCKTERM_TAB_COLORS)[number];
export type BlockTermTabIcon = (typeof BLOCKTERM_TAB_ICONS)[number];

export interface BlockTermSettingsDialogSubmission {
  openGeneration: number;
  submissionGeneration: number;
}

export function createBlockTermSettingsDialogSubmissionGuard(initialOpen: boolean) {
  let open = initialOpen;
  let openGeneration = 0;
  let submissionGeneration = 0;

  return {
    syncOpen(nextOpen: boolean): void {
      if (nextOpen === open) return;
      open = nextOpen;
      openGeneration += 1;
    },
    begin(): BlockTermSettingsDialogSubmission {
      submissionGeneration += 1;
      return { openGeneration, submissionGeneration };
    },
    isCurrent(submission: BlockTermSettingsDialogSubmission): boolean {
      return (
        open && submission.openGeneration === openGeneration && submission.submissionGeneration === submissionGeneration
      );
    },
  };
}

const BLOCKTERM_TAB_COLOR_SET = new Set<string>(BLOCKTERM_TAB_COLORS);
const BLOCKTERM_TAB_ICON_SET = new Set<string>(BLOCKTERM_TAB_ICONS);

export function normalizeBlockTermTabColor(value: string | null | undefined): BlockTermTabColor {
  return value && BLOCKTERM_TAB_COLOR_SET.has(value) ? (value as BlockTermTabColor) : "default";
}

export function normalizeBlockTermTabIcon(value: string | null | undefined): BlockTermTabIcon {
  return value && BLOCKTERM_TAB_ICON_SET.has(value) ? (value as BlockTermTabIcon) : "default";
}

export function reorderBlockTermItems<T extends { id: string }>(
  items: readonly T[],
  fromId: string,
  toId: string
): T[] {
  if (fromId === toId) return [...items];
  const fromIndex = items.findIndex((item) => item.id === fromId);
  const toIndex = items.findIndex((item) => item.id === toId);
  if (fromIndex < 0 || toIndex < 0) return [...items];
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

interface TerminalTreeItem {
  id: string;
  parentId?: string | null;
}

function resolveTerminalRootId<T extends TerminalTreeItem>(terminal: T, terminalsById: ReadonlyMap<string, T>): string {
  let current = terminal;
  const visited = new Set<string>();
  while (current.parentId && terminalsById.has(current.parentId) && !visited.has(current.id)) {
    visited.add(current.id);
    current = terminalsById.get(current.parentId) as T;
  }
  return current.id;
}

/** Move a root terminal and every split descendant as one ordered tab unit. */
export function reorderBlockTermTerminalTree<T extends TerminalTreeItem>(
  terminals: readonly T[],
  fromId: string,
  toId: string
): T[] {
  const terminalsById = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  const from = terminalsById.get(fromId);
  const to = terminalsById.get(toId);
  if (!from || !to) return [...terminals];

  const fromRootId = resolveTerminalRootId(from, terminalsById);
  const toRootId = resolveTerminalRootId(to, terminalsById);
  if (fromRootId === toRootId) return [...terminals];

  const chunks = new Map<string, T[]>();
  const rootOrder: string[] = [];
  for (const terminal of terminals) {
    const rootId = resolveTerminalRootId(terminal, terminalsById);
    if (!chunks.has(rootId)) {
      chunks.set(rootId, []);
      rootOrder.push(rootId);
    }
    chunks.get(rootId)?.push(terminal);
  }

  const nextRootOrder = reorderBlockTermItems(
    rootOrder.map((id) => ({ id })),
    fromRootId,
    toRootId
  ).map((item) => item.id);
  return nextRootOrder.flatMap((rootId) => chunks.get(rootId) || []);
}

/** API lists are update-time ordered; workspace JSON remains the durable tab order. */
export function orderBlockTermTerminalsByWorkspace<T extends { id: string }>(
  terminals: readonly T[],
  workspaceTerminals: readonly TerminalTreeItem[]
): T[] {
  const rootOrder = workspaceTerminals.filter((terminal) => !terminal.parentId).map((terminal) => terminal.id);
  const rank = new Map(rootOrder.map((id, index) => [id, index]));
  return terminals
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

export function sameBlockTermOrder(left: readonly { id: string }[], right: readonly { id: string }[]): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
}

export function sameBlockTermSessionSettings(
  current: { name: string; tabColor?: string; tabIcon?: string } | null | undefined,
  expected: { name: string; tabColor: BlockTermTabColor; tabIcon: BlockTermTabIcon }
): boolean {
  return (
    !!current &&
    current.name === expected.name &&
    normalizeBlockTermTabColor(current.tabColor) === expected.tabColor &&
    normalizeBlockTermTabIcon(current.tabIcon) === expected.tabIcon
  );
}

export function shouldRollbackBlockTermMutation<T>(input: {
  mutationVersion: number;
  latestVersion: number;
  currentValue: T;
  optimisticValue: T;
  equals: (left: T, right: T) => boolean;
}): boolean {
  return input.mutationVersion === input.latestVersion && input.equals(input.currentValue, input.optimisticValue);
}
