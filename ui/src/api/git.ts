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
  init: (path: string) =>
    request<{ ok: boolean }>('/git/init', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  clone: (url: string, path: string) =>
    request<{ ok: boolean }>('/git/clone', {
      method: 'POST',
      body: JSON.stringify({ url, path }),
    }),

  status: (path: string) =>
    request<{ files: GitFileStatus[] }>('/git/status', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  log: (path: string, limit = 20) =>
    request<{ commits: GitCommit[] }>('/git/log', {
      method: 'POST',
      body: JSON.stringify({ path, limit }),
    }),

  diff: (path: string, filePath: string) =>
    request<GitDiff>('/git/diff', {
      method: 'POST',
      body: JSON.stringify({ path, filePath }),
    }),

  show: (path: string, filePath: string, ref = 'HEAD') =>
    request<{ content: string }>('/git/show', {
      method: 'POST',
      body: JSON.stringify({ path, filePath, ref }),
    }),

  add: (path: string, files: string[]) =>
    request<{ ok: boolean }>('/git/add', {
      method: 'POST',
      body: JSON.stringify({ path, files }),
    }),

  reset: (path: string, files?: string[]) =>
    request<{ ok: boolean }>('/git/reset', {
      method: 'POST',
      body: JSON.stringify({ path, files }),
    }),

  checkout: (path: string, files: string[]) =>
    request<{ ok: boolean }>('/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ path, files }),
    }),

  commit: (path: string, message: string, author?: string, email?: string) =>
    request<{ ok: boolean; hash: string }>('/git/commit', {
      method: 'POST',
      body: JSON.stringify({ path, message, author, email }),
    }),

  undo: (path: string) =>
    request<{ ok: boolean }>('/git/undo', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
};
