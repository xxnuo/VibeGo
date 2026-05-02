import type { BlockTermHistoryEntry, BlockTermHistoryTarget } from "@/api/blockterm";

export interface BlockTermHistoryActivationRequest {
  requestId: number;
  entry: BlockTermHistoryEntry;
  workspaceSessionId?: string;
}

let nextHistoryActivationRequestId = 0;
let pendingHistoryActivationRequest: BlockTermHistoryActivationRequest | null = null;
const historyActivationListeners = new Set<() => void>();

function notifyHistoryActivationListeners(): void {
  for (const listener of historyActivationListeners) listener();
}

export function getBlockTermHistoryActivationRequest(): BlockTermHistoryActivationRequest | null {
  return pendingHistoryActivationRequest;
}

export function subscribeBlockTermHistoryActivation(listener: () => void): () => void {
  historyActivationListeners.add(listener);
  return () => historyActivationListeners.delete(listener);
}

export function publishBlockTermHistoryActivation(
  entry: BlockTermHistoryEntry,
  workspaceSessionId?: string
): BlockTermHistoryActivationRequest {
  const request = {
    requestId: ++nextHistoryActivationRequestId,
    entry,
    workspaceSessionId,
  };
  pendingHistoryActivationRequest = request;
  notifyHistoryActivationListeners();
  return request;
}

export function clearBlockTermHistoryActivation(requestId?: number): void {
  if (requestId !== undefined && pendingHistoryActivationRequest?.requestId !== requestId) return;
  if (!pendingHistoryActivationRequest) return;
  pendingHistoryActivationRequest = null;
  notifyHistoryActivationListeners();
}

export const BLOCKTERM_HISTORY_MAX_SELECTION = 200;

export interface BlockTermHistorySelectionResult {
  selection: ReadonlySet<string>;
  limitExceeded: boolean;
}

export type BlockTermHistoryActivationState = "discard" | "wait" | "settle";

export function canSettleBlockTermHistoryActivation(
  blocks: readonly { id: string }[],
  targetId: string,
  inventoryLoaded: boolean
): boolean {
  return inventoryLoaded || blocks.some((block) => block.id === targetId);
}

export function resolveBlockTermHistoryActivationState(
  blocks: readonly { id: string }[],
  targetId: string,
  inventoryLoaded: boolean,
  targetTerminalId: string,
  activeTerminalId: string | null,
  requestGeneration: number,
  currentGeneration: number
): BlockTermHistoryActivationState {
  if (requestGeneration !== currentGeneration) return "discard";
  if (targetTerminalId !== activeTerminalId) return "wait";
  return canSettleBlockTermHistoryActivation(blocks, targetId, inventoryLoaded) ? "settle" : "wait";
}

export function shouldCancelBlockTermHistoryActivationForSession(
  targetTerminalId: string,
  selectedTerminalId: string,
  requestGeneration: number,
  currentGeneration: number
): boolean {
  return requestGeneration !== currentGeneration || targetTerminalId !== selectedTerminalId;
}

export function collectBlockTermHistoryFilterOptions(
  ...sources: ReadonlyArray<readonly (string | null | undefined)[]>
): string[] {
  const options = new Set<string>();
  for (const source of sources) {
    for (const value of source) {
      const normalized = value?.trim();
      if (normalized) options.add(normalized);
    }
  }
  return [...options];
}

export function blockTermHistoryEntryToTarget(entry: BlockTermHistoryEntry): BlockTermHistoryTarget {
  return {
    id: entry.id,
    terminalId: entry.terminalId,
    workspaceSessionId: entry.workspaceSessionId,
    groupId: entry.groupId,
    userId: entry.userId,
  };
}

export function toggleBlockTermHistorySelection(
  current: ReadonlySet<string>,
  id: string,
  maxSelection = BLOCKTERM_HISTORY_MAX_SELECTION
): BlockTermHistorySelectionResult {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
    return { selection: next, limitExceeded: false };
  }
  if (next.size >= maxSelection) return { selection: current, limitExceeded: true };
  next.add(id);
  return { selection: next, limitExceeded: false };
}

export function toggleAllLoadedBlockTermHistory(
  entries: readonly Pick<BlockTermHistoryEntry, "id">[],
  current: ReadonlySet<string>,
  maxSelection = BLOCKTERM_HISTORY_MAX_SELECTION
): BlockTermHistorySelectionResult {
  const loadedIds = entries.map((entry) => entry.id);
  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => current.has(id));
  if (allSelected) return { selection: new Set(), limitExceeded: false };
  if (loadedIds.length > maxSelection) return { selection: current, limitExceeded: true };
  return { selection: new Set(loadedIds), limitExceeded: false };
}

export function buildBlockTermHistoryPurgeTargets(
  entries: readonly BlockTermHistoryEntry[],
  selectedIds: ReadonlySet<string>
): BlockTermHistoryTarget[] {
  return entries.filter((entry) => selectedIds.has(entry.id)).map(blockTermHistoryEntryToTarget);
}
