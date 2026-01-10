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

export const settingsApi = {
  list: () => request<Record<string, string>>("/settings/list"),

  get: (key: string) =>
    request<{ key: string; value: string }>(
      `/settings/get?key=${encodeURIComponent(key)}`,
    ),

  set: (key: string, value: string) =>
    request<{ ok: boolean }>("/settings/set", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    }),

  reset: () => request<{ ok: boolean }>("/settings/reset", { method: "POST" }),
};
