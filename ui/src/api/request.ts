const API_BASE = "/api";
const AUTH_KEY_STORAGE = "vibego_auth_key";

export interface ApiErrorBody {
  error?: string;
  code?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: ApiErrorBody
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getAuthHeaders(): Record<string, string> {
  const key = localStorage.getItem(AUTH_KEY_STORAGE);
  if (key) {
    return { Authorization: `Bearer ${key}` };
  }
  return {};
}

export async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const { headers, ...init } = options || {};
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("Content-Type")) requestHeaders.set("Content-Type", "application/json");
  for (const [name, value] of Object.entries(getAuthHeaders())) {
    if (!requestHeaders.has(name)) requestHeaders.set(name, value);
  }
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...init,
    headers: requestHeaders,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as ApiErrorBody;
    throw new ApiError(body.error || "Request failed", res.status, body);
  }
  return res.json();
}

export { API_BASE };
