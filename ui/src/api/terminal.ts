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

export interface TerminalInfo {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  status: string;
  pty_status: string;
  exit_code: number;
  history_size: number;
  created_at: number;
  updated_at: number;
}

export const terminalApi = {
  list: () => request<{ terminals: TerminalInfo[] }>("/terminal"),

  create: (opts?: {
    name?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }) =>
    request<{ ok: boolean; id: string; name: string }>("/terminal", {
      method: "POST",
      body: JSON.stringify(opts || {}),
    }),

  close: (id: string) =>
    request<{ ok: boolean }>("/terminal/close", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  wsUrl: (id: string) => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/terminal/ws/${id}`;
  },
};
