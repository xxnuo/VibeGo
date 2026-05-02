import type { PluginStorage } from "./types";

export function createPluginStorage(pluginId: string, workspaceId?: string): PluginStorage {
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
