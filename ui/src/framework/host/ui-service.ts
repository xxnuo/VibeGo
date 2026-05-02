import { create } from "zustand";
import type { PluginHostUI, QuickPickItem } from "./types";

interface QuickPickRequest {
  id: string;
  items: QuickPickItem[];
  placeholder?: string;
  resolve: (item: QuickPickItem | null) => void;
}
interface ProgressRequest {
  id: string;
  title: string;
  percent: number;
  step?: string;
  cancellable?: boolean;
  controller: AbortController;
}
export const usePluginUIStore = create<{ picks: QuickPickRequest[]; progress: ProgressRequest[] }>(() => ({
  picks: [],
  progress: [],
}));
export const showQuickPick: PluginHostUI["showQuickPick"] = (items, options) =>
  new Promise((resolve) => {
    const id = crypto.randomUUID();
    const request: QuickPickRequest = {
      id,
      items,
      placeholder: options?.placeholder,
      resolve: (item) => {
        usePluginUIStore.setState((state) => ({ picks: state.picks.filter((pick) => pick.id !== id) }));
        resolve(item as (typeof items)[number] | null);
      },
    };
    usePluginUIStore.setState((state) => ({ picks: [...state.picks, request] }));
  });
export const withProgress: PluginHostUI["withProgress"] = async (options, task) => {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  usePluginUIStore.setState((state) => ({ progress: [...state.progress, { ...options, id, controller, percent: 0 }] }));
  try {
    return await task((percent, step) => {
      usePluginUIStore.setState((state) => ({
        progress: state.progress.map((item) =>
          item.id === id ? { ...item, percent: Math.max(0, Math.min(100, percent)), step } : item
        ),
      }));
    }, controller.signal);
  } finally {
    usePluginUIStore.setState((state) => ({ progress: state.progress.filter((item) => item.id !== id) }));
  }
};

export function createPluginUIService(
  track: (dispose: () => void) => () => void
): Pick<PluginHostUI, "showQuickPick" | "withProgress"> {
  return {
    showQuickPick(items, options) {
      const result = showQuickPick(items, options);
      const request = usePluginUIStore.getState().picks.at(-1)!;
      const remove = track(() => request.resolve(null));
      return result.finally(remove);
    },
    withProgress(options, task) {
      let remove = () => {};
      const result = withProgress(options, (progress, signal) => {
        const request = usePluginUIStore.getState().progress.find((item) => item.controller.signal === signal)!;
        remove = track(() => {
          request.controller.abort();
          usePluginUIStore.setState((state) => ({ progress: state.progress.filter((item) => item !== request) }));
        });
        return task(progress, signal);
      });
      return result.finally(() => remove());
    },
  };
}
