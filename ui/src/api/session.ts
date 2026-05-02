import { request } from "@/api/request";
import type { SortField, SortOrder, ViewMode } from "@/stores/file-manager-store";
import type { GroupPage } from "@/stores/frame-store";
import type { LayoutNode, TerminalSession } from "@/stores/terminal-store";

export interface SessionInfo {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceState {
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
  state: string;
  workspace_state: WorkspaceState;
  created_at: number;
  updated_at: number;
}

export const sessionApi = {
  list: (page = 1, pageSize = 50) =>
    request<{
      sessions: SessionInfo[];
      page: number;
      page_size: number;
      total: number;
    }>(`/session?page=${page}&page_size=${pageSize}`),

  create: (name: string) =>
    request<{ ok: boolean; id: string }>("/session", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  get: (id: string) => request<SessionDetail>(`/session/${id}`),

  update: (id: string, data: { name?: string }) =>
    request<{ ok: boolean }>(`/session/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  patchWorkspace: (
    id: string,
    data: Partial<
      Pick<
        WorkspaceState,
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
