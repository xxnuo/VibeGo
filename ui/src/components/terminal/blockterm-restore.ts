import type { BlockTermApiPatch } from "@/api/blockterm";
import type { BlockMode, BlockStatus, BlockTermBlock } from "@/components/terminal/blockterm-model";

export interface BlockTermRestoreScope {
  groupId: string;
  workspaceSessionId?: string;
}

export type BlockTermRestoredOwnerBlock = Pick<
  BlockTermBlock,
  "id" | "terminalId" | "status" | "lineNum" | "startedAt"
>;

export interface BlockTermRestoredOwnerResolution {
  activeBlockId: string | null;
  releasedBlockId: string | null;
}

export interface BlockTermTerminalRestoreOptions<T> {
  load: () => Promise<readonly T[]>;
  restore: (terminals: readonly T[]) => Promise<void> | void;
  create: () => Promise<void> | void;
}

export type BlockTermInventoryLoadOutcome<T> =
  | { kind: "loaded"; blocks: readonly T[] }
  | { kind: "stale" }
  | { kind: "failed"; error: unknown };

export interface BlockTermInventoryLoadRequest<T> {
  scopeGeneration: number;
  requestId: number;
  promise: Promise<BlockTermInventoryLoadOutcome<T>>;
}

export function getLoadedBlockTermInventory<T>(outcome: BlockTermInventoryLoadOutcome<T>): readonly T[] | null {
  return outcome.kind === "loaded" ? outcome.blocks : null;
}

export async function followSupersedingBlockTermInventoryLoad<T>(
  outcome: BlockTermInventoryLoadOutcome<T>,
  request: BlockTermInventoryLoadRequest<T>,
  getLatestRequest: () => BlockTermInventoryLoadRequest<T> | undefined
): Promise<BlockTermInventoryLoadOutcome<T>> {
  let currentOutcome = outcome;
  let currentRequest = request;
  const followedRequests = new Set([request.promise]);

  while (currentOutcome.kind === "stale") {
    const latestRequest = getLatestRequest();
    if (
      !latestRequest ||
      latestRequest.scopeGeneration !== request.scopeGeneration ||
      latestRequest.requestId <= currentRequest.requestId ||
      followedRequests.has(latestRequest.promise)
    ) {
      return currentOutcome;
    }
    followedRequests.add(latestRequest.promise);
    currentRequest = latestRequest;
    currentOutcome = await latestRequest.promise;
  }

  return currentOutcome;
}

export async function restoreBlockTermTerminalInventory<T>(
  options: BlockTermTerminalRestoreOptions<T>
): Promise<"restored" | "created"> {
  const terminals = await options.load();
  if (terminals.length > 0) {
    await options.restore(terminals);
    return "restored";
  }
  await options.create();
  return "created";
}

export function isBlockTermConnectionContinuationCurrent<
  T extends { scopeGeneration: number; connectionToken: number },
>(current: T | null | undefined, scopeGeneration: number, connectionToken: number): current is T {
  return current?.scopeGeneration === scopeGeneration && current.connectionToken === connectionToken;
}

/**
 * The terminal list endpoint treats an omitted workspace id as an unscoped
 * query. BlockTerm restore must still keep workspace-owned terminals out of
 * that view, so compare empty and missing ids as the same unscoped value.
 */
export function isBlockTermTerminalInRestoreScope(
  terminalWorkspaceSessionId: string | null | undefined,
  workspaceSessionId: string | null | undefined
): boolean {
  return (terminalWorkspaceSessionId || "") === (workspaceSessionId || "");
}

export function isBlockTermRootTerminalInRestoreScope(
  terminalWorkspaceSessionId: string | null | undefined,
  workspaceSessionId: string | null | undefined,
  parentId: string | null | undefined
): boolean {
  return !parentId && isBlockTermTerminalInRestoreScope(terminalWorkspaceSessionId, workspaceSessionId);
}

export function resolveBlockTermActiveSessionId(
  terminalIds: readonly string[],
  preferredId: string | null | undefined
): string | null {
  if (preferredId && terminalIds.includes(preferredId)) return preferredId;
  return terminalIds[0] || null;
}

export function getBlockTermRestoreScopeKey(groupId: string, workspaceSessionId: string | null): string {
  return JSON.stringify([groupId, workspaceSessionId || ""]);
}

export function getBlockTermRestoreScope(
  groupId: string,
  workspaceSessionId: string | null,
  sessionInitialized: boolean,
  sessionLoading: boolean
): BlockTermRestoreScope | null {
  if (!sessionInitialized || sessionLoading) return null;
  return {
    groupId,
    workspaceSessionId: workspaceSessionId || undefined,
  };
}

export function isBlockTermRestoreScopeCurrent(
  scope: BlockTermRestoreScope,
  workspaceSessionId: string | null
): boolean {
  return (scope.workspaceSessionId || null) === (workspaceSessionId || null);
}

export function resolveBlockTermRestoredOwner(input: {
  sessionId: string;
  currentActiveBlockId?: string | null;
  ended: boolean;
  blocks: readonly BlockTermRestoredOwnerBlock[];
}): BlockTermRestoredOwnerResolution {
  const currentActiveBlockId = input.currentActiveBlockId || null;
  const runningBlocks = input.ended
    ? []
    : input.blocks
        .filter((block) => block.terminalId === input.sessionId && block.status === "running")
        .sort((left, right) => {
          const lineDelta = (right.lineNum ?? -1) - (left.lineNum ?? -1);
          return lineDelta || right.startedAt - left.startedAt;
        });
  const activeBlockId =
    runningBlocks.find((block) => block.id === currentActiveBlockId)?.id || runningBlocks[0]?.id || null;
  return {
    activeBlockId,
    releasedBlockId: currentActiveBlockId && currentActiveBlockId !== activeBlockId ? currentActiveBlockId : null,
  };
}

export function mergeBlockTermPersistedBlock(input: {
  persisted: BlockTermBlock;
  existing?: BlockTermBlock;
  pendingPatch?: BlockTermApiPatch;
  localStatus?: BlockStatus;
  localMode?: BlockMode;
  outputSize: number;
  outputCursor: number | null;
}): BlockTermBlock {
  const { persisted, existing, pendingPatch } = input;
  const effectiveLocalStatus = input.localStatus ?? existing?.status;
  const adoptPersistedLifecycle =
    persisted.status !== "running" &&
    (pendingPatch?.status === undefined || pendingPatch.status === "running") &&
    (effectiveLocalStatus === undefined || effectiveLocalStatus === "running");
  const localStatus = resolveBlockTermRestoredStatus({
    persistedStatus: persisted.status,
    localStatus: effectiveLocalStatus,
    pendingStatus: pendingPatch?.status,
  });
  return {
    ...persisted,
    ...existing,
    output: "",
    outputSize: input.outputSize,
    outputCursor: input.outputCursor,
    cmdPid: pendingPatch?.cmdPid !== undefined ? pendingPatch.cmdPid : (existing?.cmdPid ?? persisted.cmdPid ?? null),
    remotePid:
      pendingPatch?.remotePid !== undefined
        ? pendingPatch.remotePid
        : (existing?.remotePid ?? persisted.remotePid ?? null),
    termCols: pendingPatch?.termCols ?? existing?.termCols ?? persisted.termCols ?? 0,
    termRows: pendingPatch?.termRows ?? existing?.termRows ?? persisted.termRows ?? 0,
    termFlexRows: pendingPatch?.termFlexRows ?? existing?.termFlexRows ?? persisted.termFlexRows ?? false,
    termMaxPtySize: pendingPatch?.termMaxPtySize ?? existing?.termMaxPtySize ?? persisted.termMaxPtySize ?? 0,
    beforeStateJson: pendingPatch?.beforeStateJson ?? existing?.beforeStateJson ?? persisted.beforeStateJson,
    afterStateJson:
      pendingPatch?.afterStateJson ??
      (adoptPersistedLifecycle ? persisted.afterStateJson : (existing?.afterStateJson ?? persisted.afterStateJson)),
    status: localStatus,
    mode: input.localMode || existing?.mode || persisted.mode,
    collapsed: pendingPatch?.collapsed ?? existing?.collapsed ?? persisted.collapsed,
    pinned: pendingPatch?.pinned ?? existing?.pinned ?? persisted.pinned,
    archived: pendingPatch?.archived ?? existing?.archived ?? persisted.archived,
    starred: pendingPatch?.starred ?? existing?.starred ?? persisted.starred,
    kind: pendingPatch?.kind ?? existing?.kind ?? persisted.kind,
    command: pendingPatch?.command ?? existing?.command ?? persisted.command,
    text: pendingPatch?.text ?? existing?.text ?? persisted.text,
    runtimeType: pendingPatch?.runtimeType ?? existing?.runtimeType ?? persisted.runtimeType,
    sshProfileId:
      pendingPatch?.sshProfileId !== undefined
        ? pendingPatch.sshProfileId || undefined
        : (existing?.sshProfileId ?? persisted.sshProfileId),
    cwd: pendingPatch?.cwd ?? (adoptPersistedLifecycle ? persisted.cwd : (existing?.cwd ?? persisted.cwd)),
    exitCode:
      pendingPatch?.exitCode !== undefined
        ? pendingPatch.exitCode
        : adoptPersistedLifecycle
          ? persisted.exitCode
          : existing?.exitCode !== undefined
            ? existing.exitCode
            : persisted.exitCode,
    startedAt: pendingPatch?.startedAt ?? existing?.startedAt ?? persisted.startedAt,
    finishedAt:
      pendingPatch?.finishedAt !== undefined
        ? (pendingPatch.finishedAt ?? undefined)
        : adoptPersistedLifecycle
          ? persisted.finishedAt
          : (existing?.finishedAt ?? persisted.finishedAt),
    renderer: pendingPatch?.renderer ?? existing?.renderer ?? persisted.renderer,
    stateJson: pendingPatch?.stateJson ?? existing?.stateJson ?? persisted.stateJson,
    presentationJson: pendingPatch?.presentationJson ?? existing?.presentationJson ?? persisted.presentationJson,
  };
}

export function resolveBlockTermRestoredStatus(input: {
  persistedStatus: BlockStatus;
  localStatus?: BlockStatus;
  pendingStatus?: BlockStatus;
}): BlockStatus {
  if (input.pendingStatus && input.pendingStatus !== "running") return input.pendingStatus;
  if (input.localStatus && input.localStatus !== "running") return input.localStatus;
  if (input.persistedStatus !== "running") return input.persistedStatus;
  return input.pendingStatus ?? input.localStatus ?? input.persistedStatus;
}
