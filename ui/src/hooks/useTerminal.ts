import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { terminalApi } from "@/api/terminal";
import { useTerminalStore } from "@/stores";

export const terminalKeys = {
  all: ["terminals"] as const,
  list: () => [...terminalKeys.all, "list"] as const,
};

export function useTerminalList() {
  return useQuery({
    queryKey: terminalKeys.list(),
    queryFn: () => terminalApi.list(),
  });
}

export function useTerminalCreate() {
  const queryClient = useQueryClient();
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  // We need to access frameStore here, but we can't use the hook inside the callback easily 
  // without importing the store directly since it's a zustand store.
  // Ideally we use useFrameStore.getState() inside the callback.

  return useMutation({
    mutationFn: (opts?: {
      name?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
    }) => terminalApi.create(opts),
    onSuccess: (data) => {
      const name = data.name || "Terminal";
      addTerminal({ id: data.id, name });

      // Sync with FrameStore
      // We import useFrameStore dynamically or assume it's available. 
      // Since this is a hook file, we can import the store at the top level.
      const { addCurrentTab } = require("@/stores/frameStore").useFrameStore.getState();
      addCurrentTab({
        id: data.id,
        title: name,
        data: { type: "terminal" },
        closable: true,
      });

      queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalClose() {
  const queryClient = useQueryClient();
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);

  return useMutation({
    mutationFn: (id: string) => terminalApi.close(id),
    onSuccess: (_, id) => {
      removeTerminal(id);

      // Sync with FrameStore
      const { removeCurrentTab } = require("@/stores/frameStore").useFrameStore.getState();
      removeCurrentTab(id);

      queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalWsUrl(id: string) {
  return terminalApi.wsUrl(id);
}
