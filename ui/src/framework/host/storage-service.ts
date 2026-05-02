import type { PluginStorage } from "./types";
import { useWorkspaceSyncStore } from "@/stores/workspace-sync-store";
import { reduceInventory } from "@/stores/workspace-inventory";

export function createPluginStorage(pluginId: string, workspaceId?: string, scope = ""): PluginStorage {
  if (workspaceId !== undefined) {
    const entries = () => {
      const state = useWorkspaceSyncStore.getState();
      if (state.currentWorkspaceId !== workspaceId || !state.snapshot) return [];
      return state.outbox
        .filter((mutation) => mutation.workspace_id === workspaceId)
        .reduce(reduceInventory, state.snapshot)
        .storage.filter((item) => item.plugin_id === pluginId && item.scope === scope);
    };
    const update = async (key: string, value: unknown, deleted = false) => {
      if (useWorkspaceSyncStore.getState().currentWorkspaceId !== workspaceId) throw new Error("Workspace changed");
      await useWorkspaceSyncStore
        .getState()
        .dispatch("plugin/storage-update", {
          plugin_id: pluginId,
          scope,
          key,
          ...(deleted || value === undefined ? { deleted: true } : { value }),
        });
    };
    return {
      get<T>(key: string, defaultValue?: T): T {
        const item = entries().find((item) => item.key === key);
        return item ? (JSON.parse(item.value) as T) : (defaultValue as T);
      },
      update,
      delete: (key) => update(key, undefined, true),
      keys: () => entries().map((item) => item.key),
    };
  }
  const prefix = `vibego:plugin:${encodeURIComponent(pluginId)}:${workspaceId === undefined ? "global" : `workspace:${encodeURIComponent(workspaceId)}`}:`;
  return {
    get<T>(key: string, defaultValue?: T): T {
      const value = localStorage.getItem(prefix + encodeURIComponent(key));
      if (value === null) return defaultValue as T;
      try {
        return JSON.parse(value) as T;
      } catch {
        return defaultValue as T;
      }
    },
    async update(key, value) {
      if (value === undefined) localStorage.removeItem(prefix + encodeURIComponent(key));
      else localStorage.setItem(prefix + encodeURIComponent(key), JSON.stringify(value));
      window.dispatchEvent(new Event("plugin-storage-change"));
    },
    async delete(key) {
      localStorage.removeItem(prefix + encodeURIComponent(key));
      window.dispatchEvent(new Event("plugin-storage-change"));
    },
    keys() {
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => decodeURIComponent(key.slice(prefix.length)));
    },
  };
}
