import { API_BASE, getAuthHeaders, request } from "@/api/request";
import { createSerialExecutor, type ViewSession } from "@/lib/view-session";

const runViewUrlRequest = createSerialExecutor();

export interface RendererFileClient {
  info: (path: string) => Promise<FileInfo>;
  read: (path: string) => Promise<{ path: string; content: string; size: number }>;
  check: (path: string) => Promise<{ exist: boolean; path?: string }>;
  save: (path: string, content: string) => Promise<{ ok: boolean }>;
  viewUrl: (path: string) => Promise<ViewSession>;
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

  viewUrl: async (path: string) => {
    const key = localStorage.getItem("vibego_auth_key");
    if (!key) {
      const params = new URLSearchParams({ path, inline: "1" });
      return { url: `${API_BASE}/file/download?${params.toString()}`, expiresAt: null } satisfies ViewSession;
    }
    return runViewUrlRequest(async () => {
      const result = await request<{ url: string; expires_at: number }>(
        `/file/view-url?path=${encodeURIComponent(path)}`
      );
      return { url: result.url, expiresAt: result.expires_at } satisfies ViewSession;
    });
  },
};

export interface RendererFileClientScope {
  runtimeType: "local" | "ssh";
  terminalId: string;
  blockId?: string;
  /** BlockTerm model timestamps are milliseconds; the API scope uses Unix seconds. */
  createdAt?: number;
}

function normalizeBlockCreatedAtSeconds(value: number | undefined): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return undefined;
  return Math.round((value as number) / 1000);
}

export function createRendererFileClient(scope: RendererFileClientScope): RendererFileClient;
export function createRendererFileClient(
  runtimeType: "local" | "ssh",
  terminalId: string,
  blockId?: string,
  createdAt?: number
): RendererFileClient;
export function createRendererFileClient(
  scopeOrRuntimeType: RendererFileClientScope | "local" | "ssh",
  legacyTerminalId?: string,
  legacyBlockId?: string,
  legacyCreatedAt?: number
): RendererFileClient {
  const scope: RendererFileClientScope =
    typeof scopeOrRuntimeType === "string"
      ? {
          runtimeType: scopeOrRuntimeType,
          terminalId: legacyTerminalId || "",
          blockId: legacyBlockId,
          createdAt: legacyCreatedAt,
        }
      : scopeOrRuntimeType;
  if (scope.runtimeType !== "ssh") return fileApi;
  const blockCreatedAt = normalizeBlockCreatedAtSeconds(scope.createdAt);
  const hasBlockScope = Boolean(scope.blockId && blockCreatedAt !== undefined);
  const query = (path: string) => {
    const params = new URLSearchParams({ terminal_id: scope.terminalId, path });
    if (hasBlockScope) {
      params.set("block_id", scope.blockId as string);
      params.set("block_created_at", String(blockCreatedAt));
    }
    return params.toString();
  };
  const body = (path: string, extra: Record<string, unknown> = {}) => ({
    terminal_id: scope.terminalId,
    path,
    ...(hasBlockScope ? { block_id: scope.blockId, block_created_at: blockCreatedAt } : {}),
    ...extra,
  });
  return {
    info: (path) => request<FileInfo>(`/file/remote/info?${query(path)}`),
    read: (path) => request<{ path: string; content: string; size: number }>(`/file/remote/read?${query(path)}`),
    check: (path) =>
      request<{ exist: boolean; path?: string }>("/file/remote/check", {
        method: "POST",
        body: JSON.stringify(body(path)),
      }),
    save: (path, content) =>
      request<{ ok: boolean }>("/file/remote/save", {
        method: "POST",
        body: JSON.stringify(body(path, { content })),
      }),
    viewUrl: (path) =>
      runViewUrlRequest(async () => {
        const result = await request<{ url: string; expires_at: number }>(`/file/remote/view-url?${query(path)}`);
        return { url: result.url, expiresAt: result.expires_at } satisfies ViewSession;
      }),
  };
}
