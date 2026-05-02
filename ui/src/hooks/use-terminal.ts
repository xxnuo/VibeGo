import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SSHAuthSecrets } from "@/api/ssh";
import { terminalApi } from "@/api/terminal";
import { cleanupSpeculativeTerminal } from "@/services/speculative-terminal-cleanup";
import { useFrameStore, useTerminalStore } from "@/stores";
import { enqueueWorkspaceMutation, isCurrentWorkspaceTransition, useSessionStore } from "@/stores/session-store";

export const terminalKeys = {
  all: ["terminals"] as const,
  list: () => [...terminalKeys.all, "list"] as const,
};

interface TerminalCreateScope {
  groupId: string;
  sessionId: string | null;
  workspaceRevision: number;
}

function captureTerminalCreateScope(groupId: string): TerminalCreateScope {
  const sessionState = useSessionStore.getState();
  return {
    groupId,
    sessionId: sessionState.currentSessionId,
    workspaceRevision: sessionState.workspaceRevision,
  };
}

function isTerminalScopeCurrent(scope: TerminalCreateScope): boolean {
  const groupExists = useFrameStore
    .getState()
    .groups.some(
      (group) =>
        group.type === "group" && group.id === scope.groupId && group.pages.some((page) => page.type === "terminal")
    );
  return (
    groupExists &&
    useSessionStore.getState().sessionInitialized &&
    isCurrentWorkspaceTransition(scope.workspaceRevision, scope.sessionId, true)
  );
}

export function useTerminalList() {
  return useQuery({
    queryKey: terminalKeys.list(),
    queryFn: () => terminalApi.list(),
  });
}

export function useTerminalCreate(groupId: string) {
  const queryClient = useQueryClient();
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const getTerminals = useTerminalStore((s) => s.getTerminals);

  return useMutation({
    mutationFn: (opts?: {
      name?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
      runtime_type?: "local" | "ssh";
      ssh_profile_id?: string;
      ssh_auth?: SSHAuthSecrets;
    }) => {
      const scope = captureTerminalCreateScope(groupId);
      return enqueueWorkspaceMutation(async () => {
        if (!isTerminalScopeCurrent(scope)) return null;

        const terminals = getTerminals(scope.groupId);
        const existingNumbers = terminals
          .map((terminal) => {
            const match = terminal.name.match(/^Terminal (\d+)$/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .filter((number) => number > 0);
        const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
        const result = await terminalApi.create({
          ...opts,
          name: opts?.name || `Terminal ${nextNumber}`,
          workspace_session_id: scope.sessionId || undefined,
          group_id: scope.groupId,
        });
        if (!isTerminalScopeCurrent(scope)) {
          await cleanupSpeculativeTerminal(result.id, terminalApi);
          return null;
        }
        addTerminal(scope.groupId, {
          id: result.id,
          name: result.name,
          cwd: opts?.cwd,
          runtimeType: opts?.runtime_type,
          sshProfileId: opts?.ssh_profile_id,
        });
        return result;
      });
    },
    onSuccess: (result) => {
      if (result) void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalClose(groupId: string) {
  const queryClient = useQueryClient();
  const setTerminalStatus = useTerminalStore((s) => s.setTerminalStatus);

  return useMutation({
    mutationFn: (id: string) => {
      const scope = captureTerminalCreateScope(groupId);
      return enqueueWorkspaceMutation(async () => {
        if (!isTerminalScopeCurrent(scope)) return false;
        await terminalApi.close(id);
        setTerminalStatus(scope.groupId, id, "closed");
        return true;
      });
    },
    onSuccess: (changed) => {
      if (changed) void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalRename(groupId: string) {
  const queryClient = useQueryClient();
  const renameTerminal = useTerminalStore((s) => s.renameTerminal);

  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => {
      const scope = captureTerminalCreateScope(groupId);
      return enqueueWorkspaceMutation(async () => {
        if (!isTerminalScopeCurrent(scope)) return false;
        await terminalApi.rename(id, name);
        renameTerminal(scope.groupId, id, name);
        return true;
      });
    },
    onSuccess: (changed) => {
      if (changed) void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalDelete(groupId: string) {
  const queryClient = useQueryClient();
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);

  return useMutation({
    mutationFn: (id: string) => {
      const scope = captureTerminalCreateScope(groupId);
      return enqueueWorkspaceMutation(async () => {
        if (!isTerminalScopeCurrent(scope)) return false;
        await terminalApi.delete(id);
        removeTerminal(scope.groupId, id);
        return true;
      });
    },
    onSuccess: (changed) => {
      if (changed) void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalDeleteBatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) =>
      enqueueWorkspaceMutation(async () => {
        const result = await terminalApi.deleteBatch(ids);
        const terminalStore = useTerminalStore.getState();
        const deletedIds = new Set(ids);
        for (const [groupId, terminals] of Object.entries(terminalStore.terminalsByGroup)) {
          for (const terminal of terminals) {
            if (deletedIds.has(terminal.id)) terminalStore.removeTerminal(groupId, terminal.id);
          }
        }
        return result;
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
    },
  });
}

export function useTerminalWsUrl(id: string) {
  return terminalApi.wsUrl(id);
}
