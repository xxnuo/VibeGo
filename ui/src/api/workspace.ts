const API_BASE = "/api";

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  return res.json();
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  is_pinned: boolean;
  last_open_at: number;
  created_at: number;
}

export interface WorkspaceDetail {
  id: string;
  user_id: string;
  name: string;
  path: string;
  state: string;
  is_pinned: boolean;
  last_open_at: number;
  created_at: number;
  updated_at: number;
}

export const workspaceApi = {
  list: (page = 1, pageSize = 20) =>
    request<{
      workspaces: WorkspaceInfo[];
      page: number;
      page_size: number;
      total: number;
    }>(`/workspace?page=${page}&page_size=${pageSize}`),

  recent: (limit = 10) =>
    request<{ workspaces: WorkspaceInfo[] }>(`/workspace/recent?limit=${limit}`),

  open: (path: string) =>
    request<{ ok: boolean; workspace: WorkspaceInfo }>("/workspace/open", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  get: (id: string) =>
    request<WorkspaceDetail>(`/workspace/${id}`),

  saveState: (id: string, state: string) =>
    request<{ ok: boolean }>(`/workspace/${id}/state`, {
      method: "PUT",
      body: JSON.stringify({ state }),
    }),

  togglePin: (id: string, isPinned: boolean) =>
    request<{ ok: boolean }>(`/workspace/${id}/pin`, {
      method: "PUT",
      body: JSON.stringify({ is_pinned: isPinned }),
    }),

  delete: (id: string) =>
    request<{ ok: boolean }>(`/workspace/${id}`, {
      method: "DELETE",
    }),
};
