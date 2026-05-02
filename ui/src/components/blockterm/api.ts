import { request } from "@/api/request";
import { decodeBase64Bytes } from "./base64";

export interface Session {
  id: string;
  group_id: string;
  shell: string;
  cwd: string;
  phase: string;
  cols: number;
  rows: number;
  seq: number;
  resize_mode?: "screen" | "reflow-v1";
  error?: string;
  warning?: string;
  exit_code?: number;
  exit_signal?: string;
}

export interface Block {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  kind: string;
  status: string;
  exit_code: number | null;
  success?: boolean | null;
  native_exit_code?: number | null;
  shell_status?: number | null;
  created_at: number;
  started_at?: number;
  finished_at: number;
}

export interface TerminalEvent {
  session_id: string;
  seq: number;
  type: string;
  block_id?: string;
  data?: string;
}

const base = "/blockterm/v2/sessions";
export const bytes = decodeBase64Bytes;
export const decode = (data: string) => new TextDecoder().decode(bytes(data));
export const encode = (data: string) => {
  const value = new TextEncoder().encode(data);
  let result = "";
  for (let offset = 0; offset < value.length; offset += 8192)
    result += String.fromCharCode(...value.subarray(offset, offset + 8192));
  return btoa(result);
};
const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  request<T>(`${base}${path}`, { method: "POST", body: JSON.stringify(body), signal });

export const coreApi = {
  history: (group: string, q: string, cursor = "", signal?: AbortSignal) =>
    request<{ blocks: Block[]; has_more: boolean; next_cursor: string }>(
      `/blockterm/v2/history?${new URLSearchParams({ group_id: group, q, cursor })}`,
      { signal }
    ),
  output: (id: string, block: string, after = 0, signal?: AbortSignal, through?: number) =>
    request<{ events: TerminalEvent[]; has_more: boolean; through?: number }>(
      `${base}/${id}/blocks/${block}/output?after=${after}${through === undefined ? "" : `&through=${through}`}`,
      {
        signal,
      }
    ),
  list: (group: string, signal?: AbortSignal) =>
    request<{ sessions: Session[] }>(`${base}?group_id=${encodeURIComponent(group)}`, { signal }),
  create: (group: string, cwd?: string, shell?: string) =>
    post<Session>("", { group_id: group, cwd, shell, cols: 80, rows: 24 }),
  get: (id: string) => request<Session>(`${base}/${id}`),
  blocks: (id: string) => request<{ blocks: Block[] }>(`${base}/${id}/blocks`),
  claim: (id: string, owner: string) => post(`/${id}/control`, { owner }),
  release: (id: string, owner: string) =>
    request(`${base}/${id}/control?owner=${encodeURIComponent(owner)}`, { method: "DELETE", keepalive: true }),
  submit: (id: string, owner: string, requestId: string, command: string) =>
    post<Block>(`/${id}/submit`, { owner, request_id: requestId, command }),
  input: (id: string, owner: string, data: string, signal?: AbortSignal) =>
    post(`/${id}/input`, { owner, data: encode(data) }, signal),
  binary: (id: string, owner: string, data: string, signal?: AbortSignal) =>
    post(`/${id}/input`, { owner, data: btoa(data) }, signal),
  native: (id: string, owner: string, draft: string) => post(`/${id}/native`, { owner, draft }),
  resize: (id: string, owner: string, cols: number, rows: number) => post(`/${id}/resize`, { owner, cols, rows }),
  close: (id: string, owner: string) =>
    request(`${base}/${id}?owner=${encodeURIComponent(owner)}`, { method: "DELETE" }),
  events: (id: string, after: number) => {
    const url = new URL(`/api${base}/${id}/events`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("after", String(after));
    const key = localStorage.getItem("vibego_auth_key");
    if (key) url.searchParams.set("key", key);
    return url.toString();
  },
};
