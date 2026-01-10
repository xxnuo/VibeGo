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

export interface FileInfo {
  path: string;
  name: string;
  user: string;
  group: string;
  uid: string;
  gid: string;
  extension: string;
  content?: string;
  size: number;
  isDir: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  linkPath?: string;
  type?: string;
  mode: string;
  mimeType?: string;
  modTime: string;
  items?: FileInfo[];
  itemTotal: number;
}

export interface FileTree {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  extension: string;
  children?: FileTree[];
}

export interface SearchOptions {
  path: string;
  search?: string;
  containSub?: boolean;
  expand?: boolean;
  dir?: boolean;
  showHidden?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export const fileApi = {
  search: (opts: SearchOptions) =>
    request<FileInfo>('/file/search', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  tree: (opts: { path: string; showHidden?: boolean; dir?: boolean }) =>
    request<FileTree[]>('/file/tree', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  list: (path = '.') =>
    request<{ path: string; files: FileInfo[] }>(`/file/list?path=${encodeURIComponent(path)}`),

  read: (path: string) =>
    request<{ path: string; content: string; size: number }>(`/file/read?path=${encodeURIComponent(path)}`),

  write: (path: string, content: string) =>
    request<{ ok: boolean; path: string }>('/file/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),

  create: (opts: { path: string; content?: string; isDir?: boolean; mode?: number }) =>
    request<{ ok: boolean; path: string }>('/file/new', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  delete: (path: string) =>
    request<{ ok: boolean }>('/file/del', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  batchDelete: (paths: string[]) =>
    request<{ ok: boolean; errors?: string[] }>('/file/batch/del', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),

  rename: (oldName: string, newName: string) =>
    request<{ ok: boolean }>('/file/rename', {
      method: 'POST',
      body: JSON.stringify({ oldName, newName }),
    }),

  move: (opts: { type: 'move' | 'copy'; oldPaths: string[]; newPath: string; cover?: boolean }) =>
    request<{ ok: boolean }>('/file/move', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  copy: (srcPaths: string[], dstPath: string, cover = false) =>
    request<{ ok: boolean }>('/file/copy', {
      method: 'POST',
      body: JSON.stringify({ srcPaths, dstPath, cover }),
    }),

  mkdir: (path: string) =>
    request<{ ok: boolean; path: string }>('/file/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  info: (path: string) =>
    request<FileInfo>(`/file/info?path=${encodeURIComponent(path)}`),

  content: (path: string) =>
    request<FileInfo>('/file/content', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  save: (path: string, content: string) =>
    request<{ ok: boolean }>('/file/save', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),

  grep: (pattern: string, path = '.', limit = 100) =>
    request<{ matches: GrepMatch[] }>(
      `/file/grep?pattern=${encodeURIComponent(pattern)}&path=${encodeURIComponent(path)}&limit=${limit}`
    ),

  abs: (path: string) =>
    request<{ path: string }>(`/file/abs?path=${encodeURIComponent(path)}`),

  size: (path: string) =>
    request<{ path: string; size: number }>('/file/size', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  check: (path: string) =>
    request<{ exist: boolean; path?: string }>('/file/check', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  compress: (files: string[], dst: string, type: 'zip' | 'tar.gz', name: string) =>
    request<{ ok: boolean; path: string }>('/file/compress', {
      method: 'POST',
      body: JSON.stringify({ files, dst, type, name }),
    }),

  decompress: (path: string, dst: string, type: 'zip' | 'tar.gz') =>
    request<{ ok: boolean; path: string }>('/file/decompress', {
      method: 'POST',
      body: JSON.stringify({ path, dst, type }),
    }),

  downloadUrl: (path: string) =>
    `${API_BASE}/file/download?path=${encodeURIComponent(path)}`,
};
