import type {
  CodexThread,
  CodexThreadItem,
  CodexThreadTurnsListResponse,
  CodexTurn,
  CodexTurnItemsView,
  CodexUserInput,
} from "@/types/codex";

export function isCodexTranscriptNearBottom(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 72
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function codexTranscriptSignature(turns: CodexTurn[]): string {
  return turns
    .map((turn) => {
      const items = (turn.items || []).map((item) => {
        const summaryLength = Array.isArray(item.summary)
          ? item.summary.reduce((total, value) => total + (typeof value === "string" ? value.length : 0), 0)
          : 0;
        const contentLength = Array.isArray(item.content)
          ? item.content.reduce<number>((total, value) => {
              if (typeof value === "string") return total + value.length;
              if (!value || typeof value !== "object") return total;
              const text = (value as { text?: unknown }).text;
              return total + (typeof text === "string" ? text.length : 0);
            }, 0)
          : 0;
        const diffLength = Array.isArray(item.changes)
          ? item.changes.reduce(
              (total, change) => total + (typeof change.diff === "string" ? change.diff.length : 0),
              0
            )
          : 0;
        const planSignature = JSON.stringify([
          typeof item.explanation === "string" ? item.explanation : null,
          ...(item.planSteps || []).map((step) => [step.step, step.status]),
        ]);
        return [
          item.id,
          item.type,
          item.status || "",
          typeof item.text === "string" ? item.text.length : 0,
          typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.length : 0,
          summaryLength,
          contentLength,
          diffLength,
          planSignature,
        ].join(":");
      });
      return [turn.id, turn.status, items.length, ...items].join(";");
    })
    .join("|");
}

function isCodexUserInput(entry: unknown): entry is CodexUserInput {
  return Boolean(entry && typeof entry === "object");
}

export function codexUserInputForRetry(item: CodexThreadItem, replacementText?: string): CodexUserInput[] {
  const entries: unknown[] = Array.isArray(item.content) ? item.content : [];
  const content = entries.filter(isCodexUserInput);
  if (content.length === 0 && typeof item.text === "string" && item.text.trim()) {
    return [
      {
        type: "text",
        text: replacementText === undefined ? item.text : replacementText.trim(),
        text_elements: [],
      },
    ];
  }
  if (replacementText === undefined) return content.map((entry) => ({ ...entry }));

  const replacement = replacementText.trim();
  const firstText = content.find((entry) => entry.type === "text");
  const nonText = content.filter((entry) => entry.type !== "text").map((entry) => ({ ...entry }));
  return [
    {
      ...(firstText || {}),
      type: "text",
      text: replacement,
      text_elements: [],
    },
    ...nonText,
  ];
}

export interface CodexRetryBranchPoint {
  previousTurnId: string | null;
  retainedTurns: CodexTurn[];
}

export interface CodexThreadSelectionSnapshot {
  threadId: string | null;
  epoch: number;
}

export function isCodexThreadSelectionCurrent(
  snapshot: CodexThreadSelectionSnapshot,
  currentThreadId: string | null,
  currentEpoch: number
): boolean {
  return snapshot.threadId === currentThreadId && snapshot.epoch === currentEpoch;
}

export function codexRetryBranchPoint(turns: CodexTurn[], turnId: string): CodexRetryBranchPoint | null {
  const turnIndex = turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex < 0) return null;
  return {
    previousTurnId: turnIndex > 0 ? turns[turnIndex - 1].id : null,
    retainedTurns: turns.slice(0, turnIndex),
  };
}

type CodexRetryCleanupRequest = (method: string, params?: unknown) => Promise<unknown>;

export async function cleanupCodexRetryBranch(
  request: CodexRetryCleanupRequest,
  threadId: string,
  knownActiveTurnId: string | null = null
): Promise<void> {
  const readActiveTurnId = async (): Promise<string | null> => {
    const response = (await request("thread/read", { threadId, includeTurns: true })) as {
      thread?: { turns?: CodexTurn[] };
    };
    return [...(response.thread?.turns || [])].reverse().find((turn) => turn.status === "inProgress")?.id || null;
  };

  let activeTurnId = knownActiveTurnId || (await readActiveTurnId());
  if (activeTurnId) {
    try {
      await request("turn/interrupt", { threadId, turnId: activeTurnId });
    } catch (interruptError) {
      const currentActiveTurnId = await readActiveTurnId();
      if (currentActiveTurnId === activeTurnId) throw interruptError;
      if (currentActiveTurnId) {
        activeTurnId = currentActiveTurnId;
        await request("turn/interrupt", { threadId, turnId: activeTurnId });
      }
    }
  }
  // A freshly forked thread may not have materialized a rollout yet. Codex
  // rejects `thread/archive` for that state, while `thread/delete` is the
  // lifecycle operation that also handles live, not-yet-persisted threads.
  await request("thread/delete", { threadId });
}

export function isCodexBeforeTurnForkUnsupported(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    code === -32602 &&
    typeof message === "string" &&
    /before[_ ]?turn[_ ]?id|beforeTurnId|exclude[_ ]?turns|excludeTurns|experimentalApi/i.test(message)
  );
}

export interface CodexHistoryPageRequest {
  cursor: string | null;
  limit: number;
  sortDirection: "desc";
  itemsView: Extract<CodexTurnItemsView, "full" | "summary">;
}

interface CodexHistoryPaginationOptions {
  initialPage?: CodexThreadTurnsListResponse | null;
  initialCursor?: string | null;
  pageSize?: number;
  isCancelled?: () => boolean;
  shouldDowngradeItemsView?: (error: unknown) => boolean;
}

export function upsertCodexThread(threads: CodexThread[], thread: CodexThread): CodexThread[] {
  const index = threads.findIndex((item) => item.id === thread.id);
  const next =
    index === -1
      ? [thread, ...threads]
      : threads.map((item) => (item.id === thread.id ? { ...item, ...thread } : item));
  return next.sort((a, b) => {
    if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
    return (b.recencyAt || b.updatedAt || 0) - (a.recencyAt || a.updatedAt || 0);
  });
}

export function upsertCodexTurn(turns: CodexTurn[], turn: CodexTurn): CodexTurn[] {
  const index = turns.findIndex((item) => item.id === turn.id);
  if (index === -1) return [...turns, turn];
  return turns.map((item) => {
    if (item.id !== turn.id) return item;
    const incomingItems = Array.isArray(turn.items) ? turn.items : [];
    const incomingById = new Map(incomingItems.map((incoming) => [incoming.id, incoming]));
    const existingIds = new Set(item.items.map((existing) => existing.id));
    return {
      ...item,
      ...turn,
      items: [
        ...item.items.map((existing) => {
          const incoming = incomingById.get(existing.id);
          return incoming ? { ...existing, ...incoming } : existing;
        }),
        ...incomingItems.filter((incoming) => !existingIds.has(incoming.id)),
      ],
    };
  });
}

export function mergeCodexHistoryTurns(current: CodexTurn[], history: CodexTurn[]): CodexTurn[] {
  const currentById = new Map(current.map((turn) => [turn.id, turn]));
  const historyIds = new Set(history.map((turn) => turn.id));
  const mergedHistory = history.map((historicalTurn) => {
    const liveTurn = currentById.get(historicalTurn.id);
    if (!liveTurn) return historicalTurn;

    const liveItemsById = new Map(liveTurn.items.map((item) => [item.id, item]));
    const historicalItemIds = new Set(historicalTurn.items.map((item) => item.id));
    return {
      ...historicalTurn,
      ...liveTurn,
      items: [
        ...historicalTurn.items.map((item) => {
          const liveItem = liveItemsById.get(item.id);
          return liveItem ? { ...item, ...liveItem } : item;
        }),
        ...liveTurn.items.filter((item) => !historicalItemIds.has(item.id)),
      ],
    };
  });

  return [...mergedHistory, ...current.filter((turn) => !historyIds.has(turn.id))];
}

export async function paginateCodexThreadHistory(
  requestPage: (request: CodexHistoryPageRequest) => Promise<CodexThreadTurnsListResponse>,
  options: CodexHistoryPaginationOptions = {}
): Promise<CodexTurn[] | null> {
  const pageSize = Math.max(1, Math.floor(options.pageSize || 1));
  const initialPage = options.initialPage || null;
  const initialPageIsFull = Boolean(
    initialPage?.data.every((turn) => turn.itemsView === undefined || turn.itemsView === "full")
  );
  let page = initialPageIsFull ? initialPage : null;
  let cursor = page ? page.nextCursor || null : options.initialCursor || null;
  let itemsView: Extract<CodexTurnItemsView, "full" | "summary"> = "full";
  let downgraded = false;
  let turns: CodexTurn[] = [];
  const requestedCursors = new Set<string>();

  for (;;) {
    if (options.isCancelled?.()) return null;

    if (!page) {
      const cursorKey = cursor === null ? "<start>" : cursor;
      if (requestedCursors.has(cursorKey)) {
        throw new Error("Codex turn pagination cursor repeated");
      }
      requestedCursors.add(cursorKey);
      try {
        page = await requestPage({ cursor, limit: pageSize, sortDirection: "desc", itemsView });
      } catch (error) {
        if (!downgraded && itemsView === "full" && options.shouldDowngradeItemsView?.(error)) {
          downgraded = true;
          itemsView = "summary";
          requestedCursors.delete(cursorKey);
          continue;
        }
        throw error;
      }
      if (options.isCancelled?.()) return null;
    }

    for (const turn of page.data || []) turns = upsertCodexTurn(turns, turn);
    const nextCursor = page.nextCursor || null;
    page = null;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return turns.reverse();
}

export function upsertCodexItem(turns: CodexTurn[], turnId: string, item: CodexThreadItem): CodexTurn[] {
  let matched = false;
  const next = turns.map((turn) => {
    if (turn.id !== turnId) return turn;
    matched = true;
    const itemExists = turn.items.some((current) => current.id === item.id);
    return {
      ...turn,
      items: itemExists
        ? turn.items.map((current) => (current.id === item.id ? { ...current, ...item } : current))
        : [...turn.items, item],
    };
  });
  if (matched) return next;
  return [...next, { id: turnId, items: [item], status: "inProgress" }];
}

export function appendCodexItemText(
  turns: CodexTurn[],
  turnId: string,
  itemId: string,
  field: "text" | "aggregatedOutput",
  delta: string,
  fallbackType: string
): CodexTurn[] {
  const turn = turns.find((item) => item.id === turnId);
  const existing = turn?.items.find((item) => item.id === itemId);
  const current = typeof existing?.[field] === "string" ? String(existing[field]) : "";
  return upsertCodexItem(turns, turnId, {
    ...(existing || { id: itemId, type: fallbackType }),
    [field]: `${current}${delta}`,
  });
}

export function appendCodexReasoning(
  turns: CodexTurn[],
  turnId: string,
  itemId: string,
  index: number,
  delta: string,
  field: "summary" | "content"
): CodexTurn[] {
  const turn = turns.find((item) => item.id === turnId);
  const existing = turn?.items.find((item) => item.id === itemId);
  const values = Array.isArray(existing?.[field]) ? ([...existing[field]] as string[]) : [];
  while (values.length <= index) values.push("");
  values[index] = `${values[index] || ""}${delta}`;
  return upsertCodexItem(turns, turnId, {
    ...(existing || { id: itemId, type: "reasoning" }),
    [field]: values,
  });
}
