import { terminalApi } from "@/api/terminal";
import { useFrameStore } from "@/stores/frame-store";
import { useTerminalStore } from "@/stores/terminal-store";

type WorkspaceMutationEnqueuer = <T>(operation: () => Promise<T>) => Promise<T>;

let previousGroupIds: Set<string> = new Set();
let unsubscribe: (() => void) | null = null;
let workspaceMutationEnqueuer: WorkspaceMutationEnqueuer | null = null;

async function closeTerminals(terminalIds: string[]): Promise<void> {
  for (const terminalId of terminalIds) {
    await terminalApi.close(terminalId).catch(() => {});
  }
}

function enqueueTerminalCleanup(operation: () => Promise<void>): Promise<void> {
  return workspaceMutationEnqueuer ? workspaceMutationEnqueuer(operation) : operation();
}

export function initTerminalCleanup(enqueueWorkspaceMutation: WorkspaceMutationEnqueuer): void {
  workspaceMutationEnqueuer = enqueueWorkspaceMutation;
  if (unsubscribe) return;

  previousGroupIds = new Set(useFrameStore.getState().groups.map((g) => g.id));

  unsubscribe = useFrameStore.subscribe((state) => {
    const currentGroupIds = new Set(state.groups.map((g) => g.id));
    const removedGroupIds = [...previousGroupIds].filter((id) => !currentGroupIds.has(id));

    for (const groupId of removedGroupIds) {
      cleanupGroupTerminals(groupId);
    }

    previousGroupIds = currentGroupIds;
  });
}

export function cleanupGroupTerminals(groupId: string): void {
  const terminalState = useTerminalStore.getState();
  const terminalIds = Array.from(
    new Set((terminalState.terminalsByGroup[groupId] || []).map((terminal) => terminal.id))
  );
  terminalState.clearGroupData(groupId);
  if (terminalIds.length === 0) return;

  void enqueueTerminalCleanup(() => closeTerminals(terminalIds)).catch(() => {});
}

/**
 * Drop the browser-side terminal instances without ending their server-side
 * PTYs. Workspace switching uses this path so a later restore can attach to
 * the same sessions and replay their history.
 */
export function detachAllTerminals(): void {
  useTerminalStore.getState().reset();
}

/**
 * Explicitly close every terminal currently owned by the browser. This is
 * kept for destructive/full cleanup callers; workspace switching must use
 * detachAllTerminals instead.
 */
export async function cleanupAllTerminals(): Promise<void> {
  await enqueueTerminalCleanup(async () => {
    const terminalState = useTerminalStore.getState();
    const terminalIds = Array.from(
      new Set(
        Object.values(terminalState.terminalsByGroup).flatMap((terminals) => terminals.map((terminal) => terminal.id))
      )
    );
    terminalState.reset();
    await closeTerminals(terminalIds);
  });
}

export function destroyTerminalCleanup(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  workspaceMutationEnqueuer = null;
}
