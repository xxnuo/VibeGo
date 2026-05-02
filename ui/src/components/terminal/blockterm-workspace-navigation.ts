import type { PageGroup } from "@/stores/frame-store";
import type { TerminalSession } from "@/stores/terminal-store";
import {
  type BlockTermWorkspaceSearchTarget,
  resolveBlockTermWorkspaceNavigationTarget,
} from "./blockterm-workspace-search.ts";

export type BlockTermWorkspaceNavigationStatus = "activated" | "superseded" | "unavailable" | "failed";

export interface BlockTermWorkspaceNavigationResult {
  requestId: number;
  status: BlockTermWorkspaceNavigationStatus;
}

export interface BlockTermWorkspaceNavigationDependencies {
  switchSession: (workspaceId: string) => Promise<void>;
  getSessionState: () => {
    currentSessionId: string | null;
    loading: boolean;
    sessionInitialized: boolean;
  };
  getFrameState: () => {
    groups: PageGroup[];
    activeGroupId: string | null;
  };
  getTerminalState: () => {
    terminalsByGroup: Record<string, TerminalSession[]>;
    activeIdByGroup: Record<string, string | null>;
  };
  setActiveTerminal: (groupId: string, terminalId: string) => void;
  setActiveGroup: (groupId: string) => void;
}

function isWorkspaceReady(
  state: ReturnType<BlockTermWorkspaceNavigationDependencies["getSessionState"]>,
  workspaceId: string
): boolean {
  return state.currentSessionId === workspaceId && state.sessionInitialized && !state.loading;
}

export class BlockTermWorkspaceNavigationCoordinator {
  private revision = 0;

  invalidate(): void {
    this.revision += 1;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.revision;
  }

  private begin(): number {
    this.revision += 1;
    return this.revision;
  }

  private result(requestId: number, status: BlockTermWorkspaceNavigationStatus): BlockTermWorkspaceNavigationResult {
    return { requestId, status };
  }

  private async rollbackTargetFailure(
    requestId: number,
    status: "unavailable" | "failed",
    originWorkspaceId: string | null,
    targetWorkspaceId: string,
    dependencies: BlockTermWorkspaceNavigationDependencies
  ): Promise<BlockTermWorkspaceNavigationResult> {
    if (!this.isCurrent(requestId)) return this.result(requestId, "superseded");
    const currentWorkspaceId = dependencies.getSessionState().currentSessionId;
    if (originWorkspaceId && originWorkspaceId !== targetWorkspaceId && currentWorkspaceId !== originWorkspaceId) {
      try {
        await dependencies.switchSession(originWorkspaceId);
      } catch {
        // Preserve the original navigation failure if compensating restore fails.
      }
      if (!this.isCurrent(requestId)) return this.result(requestId, "superseded");
    }
    return this.result(requestId, status);
  }

  async activateWorkspace(
    workspaceId: string,
    dependencies: BlockTermWorkspaceNavigationDependencies
  ): Promise<BlockTermWorkspaceNavigationResult> {
    const requestId = this.begin();
    try {
      await dependencies.switchSession(workspaceId);
    } catch {
      return this.result(requestId, this.isCurrent(requestId) ? "failed" : "superseded");
    }
    if (!this.isCurrent(requestId)) return this.result(requestId, "superseded");
    return this.result(
      requestId,
      isWorkspaceReady(dependencies.getSessionState(), workspaceId) ? "activated" : "unavailable"
    );
  }

  async activateTarget(
    target: BlockTermWorkspaceSearchTarget,
    dependencies: BlockTermWorkspaceNavigationDependencies
  ): Promise<BlockTermWorkspaceNavigationResult> {
    const originWorkspaceId = dependencies.getSessionState().currentSessionId;
    const requestId = this.begin();
    try {
      if (!isWorkspaceReady(dependencies.getSessionState(), target.workspaceId)) {
        await dependencies.switchSession(target.workspaceId);
      }
    } catch {
      return this.rollbackTargetFailure(requestId, "failed", originWorkspaceId, target.workspaceId, dependencies);
    }
    if (!this.isCurrent(requestId)) return this.result(requestId, "superseded");
    if (!isWorkspaceReady(dependencies.getSessionState(), target.workspaceId)) {
      return this.rollbackTargetFailure(requestId, "unavailable", originWorkspaceId, target.workspaceId, dependencies);
    }

    const frameState = dependencies.getFrameState();
    const terminalState = dependencies.getTerminalState();
    const destination = resolveBlockTermWorkspaceNavigationTarget(
      frameState.groups,
      terminalState.terminalsByGroup,
      target
    );
    if (!destination) {
      return this.rollbackTargetFailure(requestId, "unavailable", originWorkspaceId, target.workspaceId, dependencies);
    }

    dependencies.setActiveTerminal(destination.groupId, destination.terminalId);
    dependencies.setActiveGroup(destination.groupId);
    if (!this.isCurrent(requestId)) return this.result(requestId, "superseded");

    const verifiedFrameState = dependencies.getFrameState();
    const verifiedTerminalState = dependencies.getTerminalState();
    const verifiedDestination = resolveBlockTermWorkspaceNavigationTarget(
      verifiedFrameState.groups,
      verifiedTerminalState.terminalsByGroup,
      target
    );
    if (
      !isWorkspaceReady(dependencies.getSessionState(), target.workspaceId) ||
      !verifiedDestination ||
      verifiedDestination.groupId !== destination.groupId ||
      verifiedDestination.terminalId !== destination.terminalId ||
      verifiedFrameState.activeGroupId !== destination.groupId ||
      verifiedTerminalState.activeIdByGroup[destination.groupId] !== destination.terminalId
    ) {
      return this.rollbackTargetFailure(requestId, "unavailable", originWorkspaceId, target.workspaceId, dependencies);
    }
    return this.result(requestId, "activated");
  }
}
