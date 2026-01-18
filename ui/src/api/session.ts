const API_BASE = "/api";

function getDeviceId(): string {
  let deviceId = localStorage.getItem("device_id");
  if (!deviceId) {
    deviceId = `device-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    localStorage.setItem("device_id", deviceId);
  }
  return deviceId;
}

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Device-ID": getDeviceId(),
      ...options?.headers,
    },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  return res.json();
}

export interface SessionInfo {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string;
  created_at: number;
  updated_at: number;
}

export interface SessionDetail {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string;
  state: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export const sessionApi = {
  list: (page = 1, pageSize = 20) =>
    request<{
      sessions: SessionInfo[];
      page: number;
      page_size: number;
      total: number;
    }>(`/session?page=${page}&page_size=${pageSize}`),

  create: (deviceId: string, deviceName: string) =>
    request<{ ok: boolean; id: string }>("/session", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, device_name: deviceName }),
    }),

  getCurrent: () => request<SessionDetail>("/session/current"),

  saveCurrentState: (state: string) =>
    request<{ ok: boolean }>("/session/current/state", {
      method: "PUT",
      body: JSON.stringify({ state }),
    }),

  get: (id: string) => request<SessionDetail>(`/session/${id}`),

  saveState: (id: string, state: string) =>
    request<{ ok: boolean }>(`/session/${id}/state`, {
      method: "PUT",
      body: JSON.stringify({ state }),
    }),

  delete: (id: string) =>
    request<{ ok: boolean }>(`/session/${id}`, {
      method: "DELETE",
    }),
};
