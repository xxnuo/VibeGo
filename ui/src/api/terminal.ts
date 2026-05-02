import { request } from "@/api/request";
import type { SSHAuthSecrets } from "@/api/ssh";

export type TerminalStatus = "running" | "exited" | "closed";

export interface TerminalCapabilities {
  resume: boolean;
  snapshot: boolean;
  shell_integration: boolean;
  durable: boolean;
  completion: boolean;
}

export interface TerminalInfo {
  id: string;
  name: string;
  tab_color?: string;
  tab_icon?: string;
  shell: string;
  cwd: string;
  current_cwd: string;
  cols: number;
  rows: number;
  runtime_type: string;
  ssh_profile_id?: string;
  readonly: boolean;
  capabilities: TerminalCapabilities;
  status: TerminalStatus;
  workspace_session_id: string;
  group_id: string;
  parent_id: string;
  exit_code: number;
  history_size: number;
  shell_type: string;
  shell_state: string;
  shell_integration: boolean;
  last_command: string;
  last_command_exit_code?: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Process identity exposed by a live runtime. The foreground PID is the
 * foreground process-group leader, not an arbitrary leaf of a pipeline.
 */
export interface TerminalProcessIdentity {
  shell_pid: number;
  shell_process_group_id: number | null;
  foreground_process_group_id: number | null;
  foreground_child_pid: number | null;
}

export const terminalApi = {
  list: (opts?: { workspace_session_id?: string; group_id?: string }, options?: { signal?: AbortSignal }) => {
    const params = new URLSearchParams();
    if (opts?.workspace_session_id) {
      params.set("workspace_session_id", opts.workspace_session_id);
    }
    if (opts?.group_id) {
      params.set("group_id", opts.group_id);
    }
    const qs = params.toString();
    return request<{ terminals: TerminalInfo[] }>(`/terminal${qs ? `?${qs}` : ""}`, {
      signal: options?.signal,
    });
  },

  create: (opts?: {
    name?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    workspace_session_id?: string;
    group_id?: string;
    parent_id?: string;
    runtime_type?: "local" | "ssh";
    ssh_profile_id?: string;
    ssh_auth?: SSHAuthSecrets;
  }) =>
    request<{ ok: boolean; id: string; name: string }>("/terminal", {
      method: "POST",
      body: JSON.stringify(opts || {}),
    }),

  syncWorkspace: (
    workspaceSessionId: string,
    terminals: Array<{ id: string; group_id: string; parent_id?: string }>,
    workspaceState?: {
      terminalsByGroup: Record<
        string,
        Array<{
          id: string;
          name: string;
          tabColor?: string;
          tabIcon?: string;
          pinned?: boolean;
          status?: TerminalStatus;
          parentId?: string;
        }>
      >;
      activeTerminalByGroup: Record<string, string | null>;
      listManagerOpenByGroup: Record<string, boolean>;
      terminalLayouts: Record<string, unknown>;
      focusedIdByGroup: Record<string, string | null>;
    }
  ) =>
    request<{ ok: boolean }>("/terminal/sync-workspace", {
      method: "POST",
      body: JSON.stringify({
        workspace_session_id: workspaceSessionId,
        terminals,
        workspace_state: workspaceState,
      }),
    }),

  rename: (id: string, name: string) =>
    request<{ ok: boolean }>("/terminal/rename", {
      method: "POST",
      body: JSON.stringify({ id, name }),
    }),

  updateSettings: (
    id: string,
    settings: {
      name?: string;
      tab_color?: string;
      tab_icon?: string;
    }
  ) => {
    const body = { ...settings };
    if (body.tab_color === "default") body.tab_color = "";
    if (body.tab_icon === "default") body.tab_icon = "";
    return request<{ ok: boolean }>(`/terminal/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  updateRuntimeInfo: (
    id: string,
    patch: {
      current_cwd?: string;
      shell_type?: string;
      shell_state?: string;
      shell_integration?: boolean;
      last_command?: string;
      last_command_exit_code?: number | null;
    }
  ) =>
    request<{ ok: boolean }>("/terminal/runtime-info", {
      method: "POST",
      body: JSON.stringify({ id, ...patch }),
    }),

  reset: (id: string) =>
    request<{ ok: boolean; terminal: TerminalInfo }>(`/terminal/${encodeURIComponent(id)}/reset`, {
      method: "POST",
    }),

  getProcessIdentity: (id: string, options?: { signal?: AbortSignal }) =>
    request<TerminalProcessIdentity>(`/terminal/${encodeURIComponent(id)}/process-identity`, {
      signal: options?.signal,
    }),

  close: (id: string) =>
    request<{ ok: boolean }>("/terminal/close", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  delete: (id: string) =>
    request<{ ok: boolean }>("/terminal/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  deleteBatch: (ids: string[]) =>
    request<{ ok: boolean; deleted: number }>("/terminal/delete-batch", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  wsUrl: (id: string, cursor?: number) => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const key = localStorage.getItem("vibego_auth_key");
    const params = new URLSearchParams();
    if (cursor !== undefined && cursor > 0) params.set("cursor", String(cursor));
    if (key) params.set("key", key);
    const qs = params.toString();
    return `${proto}//${window.location.host}/api/terminal/ws/${id}${qs ? `?${qs}` : ""}`;
  },
};
