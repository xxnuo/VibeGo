import { request } from "@/api/request";
import type { CodexStatus } from "@/types/codex";

export const codexApi = {
  status: () => request<CodexStatus>("/codex/status"),

  wsUrl: () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const key = localStorage.getItem("vibego_auth_key");
    const params = new URLSearchParams();
    if (key) params.set("key", key);
    const query = params.toString();
    return `${protocol}//${window.location.host}/api/codex/ws${query ? `?${query}` : ""}`;
  },
};
