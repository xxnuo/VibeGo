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
  return useMutation({
    mutationFn: (opts?: {
      name?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
    }) => terminalApi.create(opts),
    onSuccess: (data) => {
      addTerminal({ id: data.id, name: data.name, history: [] });
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
      queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalWsUrl(id: string) {
  return terminalApi.wsUrl(id);
}
