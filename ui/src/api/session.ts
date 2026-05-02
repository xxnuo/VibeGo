import { request } from "@/api/request";
import type { SortField, SortOrder, ViewMode } from "@/stores/file-manager-store";
import type { GroupPage } from "@/stores/frame-store";
import type { LayoutNode, TerminalSession } from "@/stores/terminal-store";

export interface SessionInfo {
  id: string;
  user_id: string;
  name: string;
  position?: number;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceState {
  workspaceNameOverride?: string | null;
  openGroups: Array<{
    id: string;
    name: string;
    pages: GroupPage[];
    activePageId: string | null;
  }>;
  openTools: Array<{
    id: string;
    pageId: string;
    name: string;
    tabs?: GroupPage["tabs"];
    activeTabId?: string | null;
  }>;
  taskbarOrder: string[];
  terminalsByGroup: Record<string, TerminalSession[]>;
  activeTerminalByGroup: Record<string, string | null>;
  listManagerOpenByGroup: Record<string, boolean>;
  terminalLayouts: Record<string, LayoutNode>;
  focusedIdByGroup: Record<string, string | null>;
  settingsOpen: boolean;
  activeGroupId: string | null;
  fileManagerByGroup: Record<
    string,
    {
      currentPath: string;
      rootPath: string;
      pathHistory: string[];
      historyIndex: number;
      searchQuery: string;
      searchActive: boolean;
      sortField: SortField;
      sortOrder: SortOrder;
      showHidden: boolean;
      viewMode: ViewMode;
    }
  >;
}

export interface SessionDetail {
  id: string;
  user_id: string;
  name: string;
  position?: number;
  state: string;
  workspace_state: WorkspaceState;
  created_at: number;
  updated_at: number;
}

export const sessionApi = {
  list: (page = 1, pageSize = 50, options?: { signal?: AbortSignal }) =>
    request<{
      sessions: SessionInfo[];
      page: number;
      page_size: number;
      total: number;
    }>(`/session?page=${page}&page_size=${pageSize}`, { signal: options?.signal }),

  create: (name: string) =>
    request<{ ok: boolean; id: string }>("/session", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  get: (id: string, options?: { signal?: AbortSignal; touch?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.touch === false) params.set("touch", "false");
    const query = params.toString();
    return request<SessionDetail>(`/session/${id}${query ? `?${query}` : ""}`, { signal: options?.signal });
  },

  update: (id: string, data: { name?: string; workspaceNameOverride?: string | null }) =>
    request<{ ok: boolean }>(`/session/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  reorder: (ids: string[]) =>
    request<{ ok: boolean }>("/session/reorder", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  patchWorkspace: (
    id: string,
    data: Partial<
      Pick<
        WorkspaceState,
        | "workspaceNameOverride"
        | "openGroups"
        | "openTools"
        | "taskbarOrder"
        | "terminalsByGroup"
        | "activeTerminalByGroup"
        | "listManagerOpenByGroup"
        | "terminalLayouts"
        | "focusedIdByGroup"
        | "settingsOpen"
        | "activeGroupId"
        | "fileManagerByGroup"
      >
    >
  ) =>
    request<{ ok: boolean }>(`/session/${id}/workspace`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ ok: boolean }>(`/session/${id}`, {
      method: "DELETE",
    }),
};
