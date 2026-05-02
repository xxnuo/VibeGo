import type { SessionDetail, SessionInfo } from "@/api/session";
import type { TerminalInfo } from "@/api/terminal";
import {
  type BlockTermWorkspaceInventory,
  type BlockTermWorkspaceSearchTarget,
  buildBlockTermWorkspaceSearchTargets,
  createRemoteBlockTermWorkspaceInventory,
} from "./blockterm-workspace-search.ts";

export const BLOCKTERM_WORKSPACE_PAGE_SIZE = 100;
export const BLOCKTERM_WORKSPACE_LOAD_CONCURRENCY = 6;

export interface BlockTermWorkspaceSearchLoadResult {
  targets: BlockTermWorkspaceSearchTarget[];
  failedWorkspaceCount: number;
}

export interface BlockTermWorkspaceSearchLoaderDependencies {
  listSessions: (
    page: number,
    pageSize: number,
    signal: AbortSignal
  ) => Promise<{
    sessions: SessionInfo[];
    page: number;
    page_size: number;
    total: number;
  }>;
  getSession: (id: string, signal: AbortSignal) => Promise<SessionDetail>;
  listTerminals: (workspaceId: string, signal: AbortSignal) => Promise<{ terminals: TerminalInfo[] }>;
}

export interface BlockTermWorkspaceSearchLoaderOptions {
  currentWorkspaceId: string | null;
  currentInventory?: BlockTermWorkspaceInventory | null;
  pageSize?: number;
  concurrency?: number;
}

export function isBlockTermWorkspaceAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: string } | null)?.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runnerCount = Math.min(Math.max(1, Math.trunc(concurrency) || 1), items.length);
  const runners = Array.from({ length: runnerCount }, async () => {
    while (nextIndex < items.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadRemoteInventory(
  session: SessionInfo,
  workspaceOrder: number,
  signal: AbortSignal,
  dependencies: BlockTermWorkspaceSearchLoaderDependencies
): Promise<{ inventory: BlockTermWorkspaceInventory | null; degraded: boolean }> {
  try {
    const detail = await dependencies.getSession(session.id, signal);
    throwIfAborted(signal);
    if (!detail.workspace_state.openTools.some((tool) => tool.pageId === "blockterm")) {
      return {
        inventory: createRemoteBlockTermWorkspaceInventory(session, workspaceOrder, detail.workspace_state),
        degraded: false,
      };
    }
    try {
      const terminalList = await dependencies.listTerminals(session.id, signal);
      throwIfAborted(signal);
      return {
        inventory: createRemoteBlockTermWorkspaceInventory(
          session,
          workspaceOrder,
          detail.workspace_state,
          terminalList.terminals
        ),
        degraded: false,
      };
    } catch (error) {
      if (isBlockTermWorkspaceAbortError(error)) throw error;
      return {
        inventory: createRemoteBlockTermWorkspaceInventory(session, workspaceOrder, detail.workspace_state),
        degraded: true,
      };
    }
  } catch (error) {
    if (isBlockTermWorkspaceAbortError(error)) throw error;
    return { inventory: null, degraded: true };
  }
}

export async function loadBlockTermWorkspaceSearchTargets(
  options: BlockTermWorkspaceSearchLoaderOptions,
  signal: AbortSignal,
  dependencies: BlockTermWorkspaceSearchLoaderDependencies
): Promise<BlockTermWorkspaceSearchLoadResult> {
  const inventories: BlockTermWorkspaceInventory[] = [];
  const seenWorkspaceIds = new Set<string>();
  let failedWorkspaceCount = 0;
  if (options.currentInventory) {
    inventories.push(options.currentInventory);
    seenWorkspaceIds.add(options.currentInventory.workspaceId);
  }

  const pageSize = Math.max(1, Math.trunc(options.pageSize || BLOCKTERM_WORKSPACE_PAGE_SIZE));
  const concurrency = Math.max(1, Math.trunc(options.concurrency || BLOCKTERM_WORKSPACE_LOAD_CONCURRENCY));
  let page = 1;
  while (true) {
    throwIfAborted(signal);
    const response = await dependencies.listSessions(page, pageSize, signal);
    throwIfAborted(signal);
    const total = Math.max(0, response.total);
    // Treat a stale or malformed response page as the requested page so an
    // endpoint that repeats page 1 cannot move the cursor backwards forever.
    const responsePage = Math.max(page, Math.max(1, response.page));
    const responsePageSize = Math.max(1, response.page_size);
    const pageStart = (responsePage - 1) * responsePageSize;
    const remoteSessions = response.sessions.flatMap((session, index) => {
      if (options.currentInventory?.workspaceId === session.id) {
        const inventoryIndex = inventories.findIndex((inventory) => inventory.workspaceId === session.id);
        if (inventoryIndex >= 0) {
          inventories[inventoryIndex] = {
            ...inventories[inventoryIndex],
            workspaceName: session.name,
            workspaceOrder: pageStart + index,
          };
        }
      }
      if (seenWorkspaceIds.has(session.id)) return [];
      seenWorkspaceIds.add(session.id);
      return [{ session, workspaceOrder: pageStart + index }];
    });
    const loaded = await mapWithConcurrency(remoteSessions, concurrency, signal, ({ session, workspaceOrder }) =>
      loadRemoteInventory(session, workspaceOrder, signal, dependencies)
    );
    for (const result of loaded) {
      if (result.inventory) inventories.push(result.inventory);
      if (result.degraded) failedWorkspaceCount += 1;
    }

    if (response.sessions.length === 0 || pageStart + response.sessions.length >= total) break;
    const nextPage = responsePage + 1;
    page = nextPage > page ? nextPage : page + 1;
  }

  return {
    targets: buildBlockTermWorkspaceSearchTargets(inventories, options.currentWorkspaceId),
    failedWorkspaceCount,
  };
}
