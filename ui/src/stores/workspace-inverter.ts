import type { ClientMutation, WorkspaceSnapshot } from "@/api/workspace-sync";
import { type MutationAction, parseData, reduceInventory } from "./workspace-inventory";

// Compute against the state immediately BEFORE the action. Destructive owner
// operations need several patches to restore their child tabs as well.
export function computeInvertedMutation(mutation: MutationAction, before: WorkspaceSnapshot): MutationAction[] {
  const p = mutation.payload;
  const folder = before.folders.find((item) => item.id === p.id);
  const tool = before.tools.find((item) => item.id === p.id);
  const tabs = before.tabs.filter(
    (item) =>
      item.id === p.id && (!p.folder_id || item.folder_id === p.folder_id) && (!p.page_id || item.page_id === p.page_id)
  );
  const restore = (type: string, entity: { data: string }) => ({
    type,
    payload: { ...entity, data: parseData(entity.data) },
  });
  const children = () => before.tabs.filter((tab) => tab.folder_id === p.id).map((tab) => restore("tab/open", tab));
  switch (mutation.type) {
    case "folder/add":
      return folder || tool ? [] : [{ type: "folder/remove", payload: { id: p.id } }];
    case "folder/remove":
      return folder ? [restore("folder/add", folder), ...children()] : [];
    case "folder/reorder":
      return [
        {
          type: "folder/reorder",
          payload: { folder_ids: [...before.folders].sort((a, b) => a.position - b.position).map((item) => item.id) },
        },
      ];
    case "folder/update-data":
      return folder ? [restore("folder/update-data", folder)] : [];
    case "tool/open":
      return tool || folder ? [] : [{ type: "tool/close", payload: { id: p.id } }];
    case "tool/close":
      return tool ? [restore("tool/open", tool), ...children()] : [];
    case "tool/update-data":
      return tool ? [restore("tool/update-data", tool)] : [];
    case "tab/open": {
      const owner = before.folders.find((item) => item.id === p.folder_id);
      const pages = owner ? parseData(owner.data).pages : undefined;
      const pageId =
        p.page_id ||
        (owner
          ? (Array.isArray(pages) ? pages.find((page) => page.type === "files")?.id : undefined) || `${owner.id}-files`
          : "");
      return before.tabs.some((tab) => tab.id === p.id && tab.folder_id === p.folder_id && tab.page_id === pageId)
        ? []
        : [{ type: "tab/close", payload: { id: p.id, folder_id: p.folder_id, page_id: pageId } }];
    }
    case "tab/close":
      return tabs.map((tab) => restore("tab/open", tab));
    case "tab/update":
      return tabs.map((tab) => restore("tab/update", tab));
    case "tab/pin":
      return tabs.map((tab) => ({
        type: "tab/pin",
        payload: { id: tab.id, folder_id: tab.folder_id, page_id: tab.page_id, pinned: tab.pinned },
      }));
    case "workspace/rename":
      return [{ type: "workspace/rename", payload: { name: before.workspace.name } }];
    default:
      return [];
  }
}

// Recompute inverses against the latest authority, so a rejected action cannot
// undo peer changes received while its HTTP request was in flight. The caller
// then replays the remaining outbox over this recovered state.
export function rollbackMutation(before: WorkspaceSnapshot, mutation: ClientMutation): WorkspaceSnapshot {
  const patches = computeInvertedMutation(mutation, before);
  if (!patches.length) return before;
  return patches.reduce(
    (state, patch) => reduceInventory(state, { ...mutation, ...patch }),
    reduceInventory(before, mutation)
  );
}
