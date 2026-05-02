import { request } from "@/api/request";
import type { TerminalInfo } from "@/api/terminal";

export interface WorkspaceFolderEntity {
  id: string;
  workspace_id: string;
  path: string;
  name: string;
  position: number;
  data: string;
}
export interface WorkspaceToolEntity {
  id: string;
  workspace_id: string;
  page_id: string;
  name: string;
  position: number;
  data: string;
}
export interface WorkspaceTabEntity {
  id: string;
  workspace_id: string;
  folder_id: string;
  page_id: string;
  tab_type: "file" | "diff" | "preview" | "custom_editor";
  file_path: string;
  title: string;
  icon?: string;
  closable?: boolean;
  pinned: boolean;
  position: number;
  data: string;
}
export interface WorkspaceStorageEntity {
  workspace_id: string;
  plugin_id: string;
  scope: string;
  key: string;
  value: string;
}
export interface WorkspaceSnapshot {
  workspace: { id: string; name: string; revision: number; position?: number; data: string };
  folders: WorkspaceFolderEntity[];
  tools: WorkspaceToolEntity[];
  tabs: WorkspaceTabEntity[];
  storage: WorkspaceStorageEntity[];
  terminals: TerminalInfo[];
}
export interface ClientMutation<T = Record<string, unknown>> {
  id: string;
  workspace_id: string;
  client_id: string;
  type: string;
  payload: T;
  created_at: number;
  base_revision: number;
}
export interface MutationBroadcastEvent {
  type: "mutation:committed" | "workspace:snapshot";
  revision: number;
  client_id?: string;
  mutation?: ClientMutation;
  snapshot?: WorkspaceSnapshot;
}
export const workspaceApi = {
  getSnapshot: (id: string) => request<WorkspaceSnapshot>(`/workspace/${encodeURIComponent(id)}`),
  submitMutation: (mutation: ClientMutation) =>
    request<{ ok: boolean; revision: number; mutation_id: string; event: MutationBroadcastEvent }>(
      "/workspace/mutations",
      {
        method: "POST",
        body: JSON.stringify(mutation),
      }
    ),
  wsUrl: (workspaceId: string, after: number) => {
    const params = new URLSearchParams({ workspace_id: workspaceId, after: String(after) });
    const key = localStorage.getItem("vibego_auth_key");
    if (key) params.set("key", key);
    return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/workspace/events?${params}`;
  },
};
