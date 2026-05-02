import { request } from "@/api/request";
import {
  type BlockTermNextConnectionState,
  type BlockTermSidebarState,
  type BlockTermViewState,
  sanitizeBlockTermViewState,
} from "@/components/terminal/blockterm-sidebar";

export interface BlockTermViewResponse {
  view: BlockTermViewState;
}

export interface BlockTermViewPatch {
  sidebar?: Partial<BlockTermSidebarState>;
  nextConnection?: BlockTermNextConnectionState | null;
}

export interface BlockTermViewRequestOptions {
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBlockTermViewResponse(value: unknown): BlockTermViewResponse {
  if (!isRecord(value) || !isRecord(value.view) || !isRecord(value.view.sidebar)) {
    throw new TypeError("Invalid BlockTerm view response");
  }
  const sidebar = value.view.sidebar;
  if (
    typeof sidebar.open !== "boolean" ||
    typeof sidebar.width !== "string" ||
    (sidebar.block_id !== null && typeof sidebar.block_id !== "string")
  ) {
    throw new TypeError("Invalid BlockTerm view response");
  }
  const rawNext = value.view.next_connection ?? value.view.nextConnection;
  return {
    view: sanitizeBlockTermViewState({
      sidebar: {
        open: sidebar.open,
        width: sidebar.width,
        block_id: sidebar.block_id,
      },
      next_connection: rawNext,
    }),
  };
}

function blockTermViewEndpoint(terminalId: string): string {
  return `/blockterm/sessions/${encodeURIComponent(terminalId)}/view`;
}

function blockTermViewPatchPayload(patch: BlockTermViewPatch): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (patch.sidebar !== undefined) {
    const sidebar: Record<string, unknown> = {};
    if (patch.sidebar.open !== undefined) sidebar.open = patch.sidebar.open;
    if (patch.sidebar.width !== undefined) sidebar.width = patch.sidebar.width;
    if (patch.sidebar.blockId !== undefined) sidebar.block_id = patch.sidebar.blockId;
    payload.sidebar = sidebar;
  }
  if (patch.nextConnection !== undefined) {
    payload.next_connection = patch.nextConnection
      ? {
          runtime_type: patch.nextConnection.runtimeType,
          ...(patch.nextConnection.sshProfileId ? { ssh_profile_id: patch.nextConnection.sshProfileId } : {}),
          ...(patch.nextConnection.cwd ? { cwd: patch.nextConnection.cwd } : {}),
        }
      : null;
  }
  return payload;
}

export async function getView(
  terminalId: string,
  options: BlockTermViewRequestOptions = {}
): Promise<BlockTermViewResponse> {
  const response = await request<unknown>(blockTermViewEndpoint(terminalId), { signal: options.signal });
  return normalizeBlockTermViewResponse(response);
}

export async function patchView(
  terminalId: string,
  patch: BlockTermViewPatch,
  options: BlockTermViewRequestOptions = {}
): Promise<BlockTermViewResponse> {
  const response = await request<unknown>(blockTermViewEndpoint(terminalId), {
    method: "PATCH",
    body: JSON.stringify(blockTermViewPatchPayload(patch)),
    signal: options.signal,
  });
  return normalizeBlockTermViewResponse(response);
}

export const blockTermViewApi = { getView, patchView };
