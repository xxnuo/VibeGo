import type { BlockTermHistoryEntry } from "@/api/blockterm";
import { clearBlockTermHistoryActivation, publishBlockTermHistoryActivation } from "./blockterm-history-selection";
import {
  BlockTermWorkspaceNavigationCoordinator,
  type BlockTermWorkspaceNavigationDependencies,
  type BlockTermWorkspaceNavigationResult,
} from "./blockterm-workspace-navigation";
import type { BlockTermWorkspaceSearchTarget } from "./blockterm-workspace-search";

export async function activateBlockTermHistoryTarget(
  entry: BlockTermHistoryEntry,
  target: BlockTermWorkspaceSearchTarget,
  coordinator: BlockTermWorkspaceNavigationCoordinator,
  dependencies: BlockTermWorkspaceNavigationDependencies
): Promise<BlockTermWorkspaceNavigationResult> {
  const activationRequest = publishBlockTermHistoryActivation(entry, target.workspaceId);
  try {
    const result = await coordinator.activateTarget(target, dependencies);
    if (result.status !== "activated") clearBlockTermHistoryActivation(activationRequest.requestId);
    return result;
  } catch (error) {
    clearBlockTermHistoryActivation(activationRequest.requestId);
    throw error;
  }
}
