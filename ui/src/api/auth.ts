import { API_BASE, getAuthHeaders } from "@/api/request";

export interface AuthStatusResponse {
  need_login: boolean;
  username?: string;
  user_id?: string;
  session_id?: string;
}

export interface AuthLoginResponse {
  ok: boolean;
  session_id?: string;
  user_id?: string;
  username?: string;
  error?: string;
  remaining?: number;
  retry_after?: number;
}

export const authApi = {
  status: async (): Promise<AuthStatusResponse> => {
    const res = await fetch(`${API_BASE}/auth/status`);
    if (!res.ok) throw new Error("Failed to check auth status");
    return res.json();
  },

  login: async (key: string): Promise<AuthLoginResponse> => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    return res.json();
  },

  logout: async (): Promise<void> => {
    await fetch(`${API_BASE}/file/view-session/logout`, {
      method: "POST",
      headers: getAuthHeaders(),
    });
    await fetch(`${API_BASE}/auth/logout`, { method: "POST" });
  },
};
