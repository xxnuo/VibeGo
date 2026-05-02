type Events = { save: string; tab: string | null; workspace: string | undefined; theme: string };
const listeners: { [K in keyof Events]: Set<(value: Events[K]) => void> } = {
  save: new Set(),
  tab: new Set(),
  workspace: new Set(),
  theme: new Set(),
};
export const pluginEvents = {
  on<K extends keyof Events>(name: K, listener: (value: Events[K]) => void) {
    listeners[name].add(listener);
    return () => {
      listeners[name].delete(listener);
    };
  },
  emit<K extends keyof Events>(name: K, value: Events[K]) {
    for (const listener of [...listeners[name]]) {
      try {
        void Promise.resolve(listener(value)).catch((error) => console.error("Plugin event listener failed", error));
      } catch (error) {
        console.error("Plugin event listener failed", error);
      }
    }
  },
};
