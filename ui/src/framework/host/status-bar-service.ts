import { create } from "zustand";
import type { StatusBarItem } from "./types";
export type StatusEntry = StatusBarItem & {
  alignment: "left" | "right";
  priority: number;
  visible: boolean;
  groupId?: string;
};
export const useStatusBarStore = create<{ items: StatusEntry[] }>(() => ({ items: [] }));
export function createStatusBarItem(
  pluginId: string,
  options: { id: string; alignment?: "left" | "right"; priority?: number },
  groupId?: string
): StatusBarItem {
  const id = `${pluginId}:${groupId || "global"}:${options.id}`;
  const publish = () =>
    useStatusBarStore.setState((state) => {
      const items = [...state.items];
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) items.push(entry);
      else items[index] = entry;
      return { items };
    });
  const entry: StatusEntry = {
    id,
    text: "",
    alignment: options.alignment || "left",
    priority: options.priority || 0,
    visible: false,
    groupId,
    show() {
      entry.visible = true;
      publish();
    },
    hide() {
      entry.visible = false;
      publish();
    },
    dispose() {
      useStatusBarStore.setState((state) => ({ items: state.items.filter((item) => item !== entry) }));
    },
  };
  return new Proxy(entry, {
    set(target, key, value) {
      Reflect.set(target, key, value);
      if (target.visible) publish();
      return true;
    },
  });
}
