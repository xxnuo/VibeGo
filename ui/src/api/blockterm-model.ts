import { type BlockTermApiRecord, blockTermRecordToModel } from "@/api/blockterm";
import { API_BASE, getAuthHeaders, request } from "@/api/request";
import type { BlockTermBlock } from "@/components/terminal/blockterm-model";

export interface ModelRunEvent {
  seq?: number;
  delta?: string;
  text?: string;
  snapshot?: string;
  status?: "streaming" | "success" | "error" | "interrupted";
  done?: boolean;
  error?: string;
}

export interface BlockTermModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BlockTermModelConfig {
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutSeconds: number;
  allowPrivateNetwork: boolean;
  apiTokenSet: boolean;
}

interface BlockTermModelConfigResponse {
  base_url: string;
  model: string;
  max_tokens: number;
  timeout_seconds: number;
  allow_private_network: boolean;
  api_token_set: boolean;
}

function normalizeConfig(response: BlockTermModelConfigResponse): BlockTermModelConfig {
  return {
    baseUrl: response.base_url,
    model: response.model,
    maxTokens: response.max_tokens,
    timeoutSeconds: response.timeout_seconds,
    allowPrivateNetwork: response.allow_private_network,
    apiTokenSet: response.api_token_set,
  };
}

export const blockTermModelApi = {
  getConfig: async () => normalizeConfig(await request<BlockTermModelConfigResponse>("/blockterm/model/config")),
  updateConfig: async (input: {
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    timeoutSeconds?: number;
    allowPrivateNetwork?: boolean;
    apiToken?: string;
  }) =>
    normalizeConfig(
      await request<BlockTermModelConfigResponse>("/blockterm/model/config", {
        method: "PUT",
        body: JSON.stringify({
          base_url: input.baseUrl,
          model: input.model,
          max_tokens: input.maxTokens,
          timeout_seconds: input.timeoutSeconds,
          allow_private_network: input.allowPrivateNetwork,
          api_token: input.apiToken,
        }),
      })
    ),
  resetConfig: async () =>
    normalizeConfig(await request<BlockTermModelConfigResponse>("/blockterm/model/config", { method: "DELETE" })),
  create: async (input: {
    id: string;
    terminalId: string;
    lineNum?: number;
    command: string;
    currentCommand?: string;
    prompt: string;
    cwd?: string;
    runtimeType?: "local" | "ssh";
    sshProfileId?: string;
    model?: string;
    sourceBlockId?: string;
    messages?: BlockTermModelMessage[];
  }): Promise<{ block: BlockTermBlock }> => {
    const response = await request<{ block: BlockTermApiRecord }>("/blockterm/model/runs", {
      method: "POST",
      body: JSON.stringify({
        id: input.id,
        terminal_id: input.terminalId,
        line_num: input.lineNum,
        command: input.command,
        current_command: input.currentCommand,
        prompt: input.prompt,
        cwd: input.cwd,
        runtime_type: input.runtimeType,
        ssh_profile_id: input.sshProfileId,
        model: input.model,
        messages: input.messages,
        context: input.sourceBlockId ? { source_block_id: input.sourceBlockId } : undefined,
      }),
    });
    return { block: blockTermRecordToModel(response.block) };
  },
  cancel: (id: string) =>
    request<{ ok: boolean }>(`/blockterm/model/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  eventsUrl: (id: string, after?: number) => {
    const query = after !== undefined ? `?after=${encodeURIComponent(String(after))}` : "";
    return `${API_BASE}/blockterm/model/runs/${encodeURIComponent(id)}/events${query}`;
  },
  authHeaders: getAuthHeaders,
};
