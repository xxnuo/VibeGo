const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export interface GitRepo {
  id: string;
  path: string;
  remotes: string;
  created_at: number;
  updated_at: number;
}

export interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitDiff {
  path: string;
  old: string;
  new: string;
}

export const gitApi = {
  list: (page = 1, pageSize = 20) =>
    request<{ repos: GitRepo[]; page: number; page_size: number; total: number }>(
      `/git?page=${page}&page_size=${pageSize}`
    ),

  bind: (path: string, remotes?: string) =>
    request<{ ok: boolean; id: string }>('/git/bind', {
      method: 'POST',
      body: JSON.stringify({ path, remotes }),
    }),

  unbind: (id: string) =>
    request<{ ok: boolean }>(`/git/${id}`, { method: 'DELETE' }),

  init: (path: string) =>
    request<{ ok: boolean; id: string }>('/git/init', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  clone: (url: string, path: string) =>
    request<{ ok: boolean; id: string }>('/git/clone', {
      method: 'POST',
      body: JSON.stringify({ url, path }),
    }),

  status: (id: string) =>
    request<{ files: GitFileStatus[] }>(`/git/status?id=${id}`),

  log: (id: string, limit = 20) =>
    request<{ commits: GitCommit[] }>(`/git/log?id=${id}&limit=${limit}`),

  diff: (id: string, path: string) =>
    request<GitDiff>(`/git/diff?id=${id}&path=${encodeURIComponent(path)}`),

  show: (id: string, path: string, ref = 'HEAD') =>
    request<{ content: string }>(
      `/git/show?id=${id}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`
    ),

  add: (id: string, files: string[]) =>
    request<{ ok: boolean }>('/git/add', {
      method: 'POST',
      body: JSON.stringify({ id, files }),
    }),

  reset: (id: string, files?: string[]) =>
    request<{ ok: boolean; message: string }>('/git/reset', {
      method: 'POST',
      body: JSON.stringify({ id, files }),
    }),

  checkout: (id: string, files: string[]) =>
    request<{ ok: boolean }>('/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ id, files }),
    }),

  commit: (id: string, message: string, author?: string, email?: string) =>
    request<{ ok: boolean; hash: string }>('/git/commit', {
      method: 'POST',
      body: JSON.stringify({ id, message, author, email }),
    }),

  undoCommit: (id: string) =>
    request<{ ok: boolean; message: string }>('/git/undo-commit', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
};
