import { API_BASE, getAuthHeaders, request } from "@/api/request";

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

export interface UploadFileEntry {
  file: File;
  relativePath?: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadResult {
  ok: boolean;
  uploaded: string[];
  errors?: string[];
}

export const fileApi = {
  search: (opts: SearchOptions) =>
    request<FileInfo>("/file/search", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  tree: (opts: { path: string; showHidden?: boolean; dir?: boolean }) =>
    request<FileTree[]>("/file/tree", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  list: (path = ".") => request<{ path: string; files: FileInfo[] }>(`/file/list?path=${encodeURIComponent(path)}`),

  read: (path: string) =>
    request<{ path: string; content: string; size: number }>(`/file/read?path=${encodeURIComponent(path)}`),

  write: (path: string, content: string) =>
    request<{ ok: boolean; path: string }>("/file/write", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),

  create: (opts: { path: string; content?: string; isDir?: boolean; mode?: number }) =>
    request<{ ok: boolean; path: string }>("/file/new", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  delete: (path: string) =>
    request<{ ok: boolean }>("/file/del", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  batchDelete: (paths: string[]) =>
    request<{ ok: boolean; errors?: string[] }>("/file/batch/del", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),

  rename: (oldName: string, newName: string) =>
    request<{ ok: boolean }>("/file/rename", {
      method: "POST",
      body: JSON.stringify({ oldName, newName }),
    }),

  move: (opts: { type: "move" | "copy"; oldPaths: string[]; newPath: string; cover?: boolean }) =>
    request<{ ok: boolean }>("/file/move", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  copy: (srcPaths: string[], dstPath: string, cover = false) =>
    request<{ ok: boolean }>("/file/copy", {
      method: "POST",
      body: JSON.stringify({ srcPaths, dstPath, cover }),
    }),

  mkdir: (path: string) =>
    request<{ ok: boolean; path: string }>("/file/mkdir", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  info: (path: string) => request<FileInfo>(`/file/info?path=${encodeURIComponent(path)}`),

  content: (path: string) =>
    request<FileInfo>("/file/content", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  save: (path: string, content: string) =>
    request<{ ok: boolean }>("/file/save", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),

  grep: (pattern: string, path = ".", limit = 100) =>
    request<{ matches: GrepMatch[] }>(
      `/file/grep?pattern=${encodeURIComponent(pattern)}&path=${encodeURIComponent(path)}&limit=${limit}`
    ),

  abs: (path: string) => request<{ path: string }>(`/file/abs?path=${encodeURIComponent(path)}`),

  size: (path: string) =>
    request<{ path: string; size: number }>("/file/size", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  check: (path: string) =>
    request<{ exist: boolean; path?: string }>("/file/check", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  upload: (
    path: string,
    files: UploadFileEntry[],
    opts?: { overwrite?: boolean; onProgress?: (progress: UploadProgress) => void }
  ) =>
    new Promise<UploadResult>((resolve, reject) => {
      const form = new FormData();
      form.append("path", path);
      if (opts?.overwrite) form.append("overwrite", "true");
      for (const entry of files) {
        const relativePath = entry.relativePath || entry.file.webkitRelativePath || entry.file.name;
        form.append("relativePath", relativePath);
        form.append("file", entry.file, relativePath);
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/file/upload`);
      for (const [key, value] of Object.entries(getAuthHeaders())) {
        xhr.setRequestHeader(key, value);
      }
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        opts?.onProgress?.({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
        });
      };
      xhr.onload = () => {
        const data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as UploadResult);
          return;
        }
        reject(new Error(data.error || data.errors?.join("\n") || xhr.statusText || "Upload failed"));
      };
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(form);
    }),

  compress: (files: string[], dst: string, type: "zip" | "tar.gz", name: string) =>
    request<{ ok: boolean; path: string }>("/file/compress", {
      method: "POST",
      body: JSON.stringify({ files, dst, type, name }),
    }),

  decompress: (path: string, dst: string, type: "zip" | "tar.gz") =>
    request<{ ok: boolean; path: string }>("/file/decompress", {
      method: "POST",
      body: JSON.stringify({ path, dst, type }),
    }),

  downloadUrl: (path: string) => {
    const key = localStorage.getItem("vibego_auth_key");
    const params = new URLSearchParams({ path });
    if (key) params.set("key", key);
    return `${API_BASE}/file/download?${params.toString()}`;
  },
};
