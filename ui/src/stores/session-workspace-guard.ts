import { normalizeTerminalWorkspace } from "./terminal-layout.ts";
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
          (group.type === "tool" && group.pageId === "terminal") ||
          (group.type === "group" && group.pages?.some((page) => page.type === "terminal"))
      )
      .map((group) => group.id)
  );
}

export interface TerminalWorkspaceState {
  terminalsByGroup: Record<string, TerminalSession[]>;
  retiredTerminalIds?: string[];
  activeTerminalByGroup: Record<string, string | null>;
  listManagerOpenByGroup: Record<string, boolean>;
  terminalLayouts: Record<string, LayoutNode>;
  focusedIdByGroup: Record<string, string | null>;
}

export const sanitizeTerminalWorkspaceState = normalizeTerminalWorkspace;

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
