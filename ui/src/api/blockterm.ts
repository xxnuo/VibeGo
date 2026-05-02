import { API_BASE, type ApiErrorBody, getAuthHeaders, request } from "@/api/request";
import {
  type BlockMode,
  type BlockStatus,
  type BlockTermBlock,
  type BlockTermCompletionCandidate,
  type BlockTermCompletionKind,
  type BlockTermKind,
  type BlockTermRuntimeType,
  decodeBase64Text,
  encodeUtf8Base64,
  normalizeBlockTermRuntimeType,
  normalizeBlockTermSSHProfileId,
} from "@/components/terminal/blockterm-model";
import { BLOCKTERM_OUTPUT_MAX_BYTES } from "@/components/terminal/blockterm-output-limits";
import { type BlockTermRendererSelection } from "@/components/terminal/blockterm-renderer-registry";

export { BLOCKTERM_OUTPUT_MAX_BYTES } from "@/components/terminal/blockterm-output-limits";
export type { BlockTermRendererSwitchResolution } from "@/components/terminal/blockterm-renderer-registry";
export { resolveBlockTermRendererSwitch } from "@/components/terminal/blockterm-renderer-registry";

export interface BlockTermApiRecord {
  id: string;
  terminal_id: string;
  line_num?: number | null;
  kind?: string | null;
  command?: string | null;
  text?: string | null;
  cwd?: string | null;
  runtime_type?: string | null;
  ssh_profile_id?: string | null;
  status?: string | null;
  mode?: string | null;
  output?: string | null;
  output_size?: number | null;
  output_cursor?: number | null;
  cmd_pid?: number | null;
  remote_pid?: number | null;
  term_cols?: number | null;
  term_rows?: number | null;
  term_flex_rows?: boolean | null;
  term_max_pty_size?: number | null;
  before_state_json?: string | null;
  after_state_json?: string | null;
  exit_code?: number | null;
  started_at?: number | null;
  finished_at?: number | null;
  collapsed?: boolean;
  pinned?: boolean;
  archived?: boolean;
  starred?: boolean;
  favorite?: boolean;
  renderer?: string | null;
  state_json?: string | null;
  presentation_json?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
}

export interface BlockTermHistoryApiRecord {
  id: string;
  terminal_id: string;
  workspace_session_id?: string | null;
  group_id?: string | null;
  user_id?: string | null;
  runtime_type?: string | null;
  ssh_profile_id?: string | null;
  line_num?: number | null;
  kind?: string | null;
  command?: string | null;
  text?: string | null;
  cwd?: string | null;
  status?: string | null;
  mode?: string | null;
  output_cursor?: number | null;
  cmd_pid?: number | null;
  remote_pid?: number | null;
  term_cols?: number | null;
  term_rows?: number | null;
  term_flex_rows?: boolean | null;
  term_max_pty_size?: number | null;
  before_state_json?: string | null;
  after_state_json?: string | null;
  exit_code?: number | null;
  started_at?: number | null;
  finished_at?: number | null;
  renderer?: string | null;
  state_json?: string | null;
  presentation_json?: string | null;
  created_at?: number | null;
  starred?: boolean | null;
  snapshot_updated_at?: number | null;
  block_deleted_at?: number | null;
}

export interface BlockTermHistoryEntry {
  id: string;
  terminalId: string;
  workspaceSessionId?: string;
  groupId?: string;
  userId?: string;
  runtimeType: string;
  sshProfileId?: string;
  lineNum?: number;
  kind?: BlockTermKind;
  command: string;
  text?: string;
  cwd: string;
  status?: BlockStatus;
  mode?: BlockMode;
  outputCursor?: number | null;
  cmdPid?: number | null;
  remotePid?: number | null;
  termCols?: number;
  termRows?: number;
  termFlexRows?: boolean;
  termMaxPtySize?: number;
  beforeStateJson?: string;
  afterStateJson?: string;
  exitCode?: number | null;
  startedAt?: number;
  finishedAt?: number;
  renderer?: string;
  stateJson?: string;
  presentationJson?: string;
  createdAt: number;
  starred: boolean;
  snapshotUpdatedAt?: number;
  blockDeletedAt?: number;
}

export interface BlockTermHistoryQuery {
  terminalId?: string;
  workspaceSessionId?: string;
  groupId?: string;
  runtimeType?: string;
  starredOnly?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface BlockTermHistoryTarget {
  id: string;
  terminalId: string;
  workspaceSessionId?: string;
  groupId?: string;
  userId?: string;
}

export interface BlockTermHistoryResult {
  history: BlockTermHistoryEntry[];
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number;
}

interface BlockTermHistoryApiResponse {
  history?: BlockTermHistoryApiRecord[];
  offset?: number;
  limit?: number;
  has_more?: boolean;
  next_offset?: number;
}

export interface BlockTermBookmarkApiRecord {
  id: string;
  title?: string | null;
  description?: string | null;
  command?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
}

export interface BlockTermBookmark {
  id: string;
  title: string;
  description: string;
  command: string;
  createdAt: number;
  updatedAt: number;
}

export interface BlockTermBookmarkQuery {
  query?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface BlockTermBookmarkInput {
  title: string;
  description: string;
  command: string;
}

export type BlockTermBookmarkPatch = Partial<BlockTermBookmarkInput>;

export interface BlockTermCompletionQuery {
  terminalId: string;
  /** Full draft and UTF-16 cursor for the current completion protocol. */
  draft?: string;
  cursor?: number;
  prefix: string;
  kind: BlockTermCompletionKind;
  executableOnly?: boolean;
  /** Legacy callers may provide a cwd and the full text prefix instead. */
  cwd?: string;
  runtimeType?: BlockTermRuntimeType;
  sshProfileId?: string;
  wordPrefix?: string;
  signal?: AbortSignal;
}

export interface BlockTermCompletionResult {
  kind: BlockTermCompletionKind;
  prefix: string;
  commonPrefix: string;
  hasMore: boolean;
  candidates: BlockTermCompletionCandidate[];
}

interface LegacyBlockTermCompletionApiRecord {
  label?: string;
  kind?: string;
}

interface BlockTermCompletionApiResponse {
  kind?: string;
  prefix?: string;
  common_prefix?: string;
  has_more?: boolean;
  candidates?: Array<{
    value?: string;
    display?: string;
    is_directory?: boolean;
  }>;
  suggestions?: LegacyBlockTermCompletionApiRecord[];
}

export interface BlockTermApiPatch {
  kind?: "command" | "note" | "renderer";
  command?: string;
  text?: string;
  cwd?: string;
  runtimeType?: BlockTermRuntimeType;
  sshProfileId?: string | null;
  status?: BlockStatus;
  mode?: BlockMode;
  output?: string;
  cmdPid?: number | null;
  remotePid?: number | null;
  termCols?: number;
  termRows?: number;
  termFlexRows?: boolean;
  termMaxPtySize?: number;
  beforeStateJson?: string;
  afterStateJson?: string;
  exitCode?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  collapsed?: boolean;
  pinned?: boolean;
  archived?: boolean;
  starred?: boolean;
  // Keep unknown legacy renderer names round-trippable. New UI selections
  // should be created through resolveBlockTermRendererSwitch.
  renderer?: string;
  stateJson?: string;
  presentationJson?: string;
  lineNum?: number;
}

export interface BlockTermRendererSwitchPatch {
  renderer: BlockTermRendererSelection;
  stateJson: string;
}

export interface BlockTermApiCreate extends BlockTermApiPatch {
  id?: string;
  terminalId: string;
}

/** Starts a fresh lifecycle for an existing command block. */
export interface BlockTermRestartInput {
  token: string;
  independentRuntime?: boolean;
  mode: BlockMode;
  termCols: number;
  termRows: number;
  termFlexRows: boolean;
  termMaxPtySize: number;
  beforeStateJson: string;
}

export interface BlockTermListOptions {
  includeOutput?: boolean;
}

export interface BlockTermOutputResult {
  value: string;
  cursor: number | null;
}

export interface BlockTermRawOutputResult {
  data: Uint8Array;
  startCursor: number | null;
  endCursor: number | null;
}

export interface BlockTermHistoryOutputResult {
  data: Uint8Array;
  cursor: number | null;
}

export interface BlockTermRuntimeCapabilities {
  resume: boolean;
  snapshot: boolean;
  shell_integration: boolean;
  durable: boolean;
  completion: boolean;
}

export interface BlockTermRuntimeInfo {
  terminal_id: string;
  block_id: string;
  block_token: string;
  runtime_type: string;
  ssh_profile_id?: string;
  cwd: string;
  cols: number;
  rows: number;
  status: string;
  cursor: number;
  exit_code?: number;
  capabilities: BlockTermRuntimeCapabilities;
}

export interface BlockTermRuntimeCreateInput {
  terminalId: string;
  blockId: string;
  blockToken: string;
  runtimeType?: "local" | "ssh";
  sshProfileId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  command?: string;
  initialInput?: string;
}

export class BlockTermApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: ApiErrorBody = { error: message }
  ) {
    super(message);
    this.name = "BlockTermApiError";
  }
}

function parseOutputCursorHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
}

function timestampToMilliseconds(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return value > 10_000_000_000 ? value : value * 1000;
}

function decodeOutput(value: string | null | undefined): string {
  if (!value) return "";
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return value;
  const decoded = decodeBase64Text(normalized);
  // The service serializes []byte as base64. Keep a plain-text fallback for
  // development servers that return the field without encoding. Invalid UTF-8
  // is a strong signal that a plain string was passed through unchanged.
  if (!decoded || decoded.includes("\uFFFD")) return value;
  try {
    const canonical = encodeUtf8Base64(decoded).replace(/=+$/, "");
    if (canonical !== normalized.replace(/=+$/, "")) return value;
  } catch {
    return value;
  }
  return decoded;
}

function normalizeStatus(value: string | null | undefined): BlockStatus {
  if (
    value === "success" ||
    value === "error" ||
    value === "interrupted" ||
    value === "running" ||
    value === "streaming"
  )
    return value;
  return "running";
}

function normalizeMode(value: string | null | undefined): BlockMode {
  return value === "terminal" ? "terminal" : "text";
}

function normalizeKind(value: string | null | undefined): BlockTermKind {
  return value === "note" || value === "renderer" ? value : "command";
}

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function blockTermRecordToModel(record: BlockTermApiRecord): BlockTermBlock {
  const startedAt = timestampToMilliseconds(record.started_at) ?? Date.now();
  const createdAt = timestampToMilliseconds(record.created_at) ?? startedAt;
  const output = decodeOutput(record.output);
  return {
    id: record.id,
    terminalId: record.terminal_id,
    lineNum: record.line_num ?? undefined,
    kind: record.kind === "note" || record.kind === "renderer" ? record.kind : "command",
    command: record.command || "",
    text: record.text || "",
    runtimeType: normalizeBlockTermRuntimeType(record.runtime_type),
    ...(normalizeBlockTermRuntimeType(record.runtime_type) === "ssh"
      ? (() => {
          const sshProfileId = normalizeBlockTermSSHProfileId(record.ssh_profile_id);
          return sshProfileId ? { sshProfileId } : {};
        })()
      : {}),
    output,
    outputSize:
      typeof record.output_size === "number" && Number.isSafeInteger(record.output_size) && record.output_size >= 0
        ? record.output_size
        : new TextEncoder().encode(output).byteLength,
    outputCursor:
      typeof record.output_cursor === "number" &&
      Number.isSafeInteger(record.output_cursor) &&
      record.output_cursor >= 0
        ? record.output_cursor
        : null,
    cmdPid:
      typeof record.cmd_pid === "number" && Number.isSafeInteger(record.cmd_pid) && record.cmd_pid > 0
        ? record.cmd_pid
        : null,
    remotePid:
      typeof record.remote_pid === "number" && Number.isSafeInteger(record.remote_pid) && record.remote_pid > 0
        ? record.remote_pid
        : null,
    termCols:
      typeof record.term_cols === "number" && Number.isSafeInteger(record.term_cols) && record.term_cols > 0
        ? record.term_cols
        : 0,
    termRows:
      typeof record.term_rows === "number" && Number.isSafeInteger(record.term_rows) && record.term_rows > 0
        ? record.term_rows
        : 0,
    termFlexRows: !!record.term_flex_rows,
    termMaxPtySize:
      typeof record.term_max_pty_size === "number" &&
      Number.isSafeInteger(record.term_max_pty_size) &&
      record.term_max_pty_size >= 0
        ? record.term_max_pty_size
        : 0,
    beforeStateJson: record.before_state_json || undefined,
    afterStateJson: record.after_state_json || undefined,
    status: normalizeStatus(record.status),
    mode: normalizeMode(record.mode),
    cwd: record.cwd || ".",
    exitCode: record.exit_code ?? null,
    createdAt,
    startedAt,
    finishedAt: timestampToMilliseconds(record.finished_at),
    collapsed: !!record.collapsed,
    pinned: !!record.pinned,
    archived: !!record.archived,
    starred: !!(record.starred ?? record.favorite),
    renderer: record.renderer || undefined,
    stateJson: record.state_json || undefined,
    presentationJson: record.presentation_json || undefined,
  };
}

export function blockTermHistoryRecordToModel(record: BlockTermHistoryApiRecord): BlockTermHistoryEntry {
  const createdAt = timestampToMilliseconds(record.created_at) ?? Date.now();
  const entry: BlockTermHistoryEntry = {
    id: record.id,
    terminalId: record.terminal_id,
    workspaceSessionId:
      record.workspace_session_id === null || record.workspace_session_id === undefined
        ? undefined
        : record.workspace_session_id,
    groupId: record.group_id === null || record.group_id === undefined ? undefined : record.group_id,
    userId: record.user_id === null || record.user_id === undefined ? undefined : record.user_id,
    runtimeType: record.runtime_type || "local",
    lineNum: record.line_num ?? undefined,
    command: record.command || "",
    cwd: record.cwd || ".",
    createdAt,
    starred: !!record.starred,
  };
  const hasSnapshot = [
    record.ssh_profile_id,
    record.kind,
    record.text,
    record.status,
    record.mode,
    record.output_cursor,
    record.cmd_pid,
    record.remote_pid,
    record.term_cols,
    record.term_rows,
    record.term_flex_rows,
    record.term_max_pty_size,
    record.before_state_json,
    record.after_state_json,
    record.exit_code,
    record.started_at,
    record.finished_at,
    record.renderer,
    record.state_json,
    record.presentation_json,
    record.snapshot_updated_at,
    record.block_deleted_at,
  ].some((value) => value !== undefined && value !== null);
  if (hasSnapshot) {
    Object.assign(entry, {
      sshProfileId:
        record.ssh_profile_id === null || record.ssh_profile_id === undefined ? undefined : record.ssh_profile_id,
      kind: normalizeKind(record.kind),
      text: record.text || "",
      status: normalizeStatus(record.status),
      mode: normalizeMode(record.mode),
      outputCursor: normalizeNonNegativeInteger(record.output_cursor),
      cmdPid: normalizePositiveInteger(record.cmd_pid),
      remotePid: normalizePositiveInteger(record.remote_pid),
      termCols: normalizePositiveInteger(record.term_cols) ?? 0,
      termRows: normalizePositiveInteger(record.term_rows) ?? 0,
      termFlexRows: !!record.term_flex_rows,
      termMaxPtySize: normalizeNonNegativeInteger(record.term_max_pty_size) ?? 0,
      beforeStateJson: record.before_state_json || undefined,
      afterStateJson: record.after_state_json || undefined,
      exitCode: record.exit_code ?? null,
      startedAt: timestampToMilliseconds(record.started_at),
      finishedAt: timestampToMilliseconds(record.finished_at),
      renderer: record.renderer || undefined,
      stateJson: record.state_json || undefined,
      presentationJson: record.presentation_json || undefined,
      snapshotUpdatedAt: timestampToMilliseconds(record.snapshot_updated_at),
      blockDeletedAt: timestampToMilliseconds(record.block_deleted_at),
    });
  }
  return entry;
}

function blockTermHistoryTargetToPayload(target: BlockTermHistoryTarget): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: target.id,
    terminal_id: target.terminalId,
  };
  if (target.workspaceSessionId !== undefined) payload.workspace_session_id = target.workspaceSessionId;
  if (target.groupId !== undefined) payload.group_id = target.groupId;
  if (target.userId !== undefined) payload.user_id = target.userId;
  return payload;
}

export function blockTermBookmarkRecordToModel(record: BlockTermBookmarkApiRecord): BlockTermBookmark {
  return {
    id: record.id,
    title: record.title || "",
    description: record.description || "",
    command: record.command || "",
    createdAt: timestampToMilliseconds(record.created_at) ?? Date.now(),
    updatedAt: timestampToMilliseconds(record.updated_at) ?? Date.now(),
  };
}

function modelPatchToPayload(patch: BlockTermApiPatch): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (patch.kind !== undefined) payload.kind = patch.kind;
  if (patch.command !== undefined) payload.command = patch.command;
  if (patch.text !== undefined) payload.text = patch.text;
  if (patch.cwd !== undefined) payload.cwd = patch.cwd;
  if (patch.runtimeType !== undefined) payload.runtime_type = patch.runtimeType;
  if (patch.sshProfileId !== undefined) payload.ssh_profile_id = patch.sshProfileId ?? "";
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.mode !== undefined) payload.mode = patch.mode;
  if (patch.output !== undefined) payload.output = encodeUtf8Base64(patch.output);
  if (patch.cmdPid !== undefined) payload.cmd_pid = patch.cmdPid;
  if (patch.remotePid !== undefined) payload.remote_pid = patch.remotePid;
  if (patch.termCols !== undefined) payload.term_cols = patch.termCols;
  if (patch.termRows !== undefined) payload.term_rows = patch.termRows;
  if (patch.termFlexRows !== undefined) payload.term_flex_rows = patch.termFlexRows;
  if (patch.termMaxPtySize !== undefined) payload.term_max_pty_size = patch.termMaxPtySize;
  if (patch.beforeStateJson !== undefined) payload.before_state_json = patch.beforeStateJson;
  if (patch.afterStateJson !== undefined) payload.after_state_json = patch.afterStateJson;
  if (patch.exitCode !== undefined) payload.exit_code = patch.exitCode;
  if (patch.startedAt !== undefined)
    payload.started_at = patch.startedAt === null ? null : Math.round(patch.startedAt / 1000);
  if (patch.finishedAt !== undefined)
    payload.finished_at = patch.finishedAt === null ? null : Math.round(patch.finishedAt / 1000);
  if (patch.collapsed !== undefined) payload.collapsed = patch.collapsed;
  if (patch.pinned !== undefined) payload.pinned = patch.pinned;
  if (patch.archived !== undefined) payload.archived = patch.archived;
  if (patch.starred !== undefined) payload.starred = patch.starred;
  if (patch.renderer !== undefined) payload.renderer = patch.renderer;
  if (patch.stateJson !== undefined) payload.state_json = patch.stateJson;
  if (patch.presentationJson !== undefined) payload.presentation_json = patch.presentationJson;
  if (patch.lineNum !== undefined) payload.line_num = patch.lineNum;
  return payload;
}

function normalizeListResponse(
  response: { blocks?: BlockTermApiRecord[]; deleted_block_ids?: string[] } | BlockTermApiRecord[]
): { blocks: BlockTermBlock[]; deletedBlockIds: string[] } {
  const records = Array.isArray(response) ? response : response.blocks || [];
  return {
    blocks: records.map(blockTermRecordToModel),
    deletedBlockIds: Array.isArray(response) ? [] : response.deleted_block_ids || [],
  };
}

function normalizeHistoryResponse(
  response: BlockTermHistoryApiResponse | BlockTermHistoryApiRecord[],
  query: BlockTermHistoryQuery
): BlockTermHistoryResult {
  const records = Array.isArray(response) ? response : response.history || [];
  const offset = Array.isArray(response)
    ? Math.max(0, Math.trunc(query.offset || 0))
    : Number.isSafeInteger(response.offset) && (response.offset || 0) >= 0
      ? (response.offset as number)
      : Math.max(0, Math.trunc(query.offset || 0));
  const limit = Array.isArray(response)
    ? Math.max(1, Math.trunc(query.limit || records.length || 100))
    : Number.isSafeInteger(response.limit) && (response.limit || 0) > 0
      ? (response.limit as number)
      : Math.max(1, Math.trunc(query.limit || records.length || 100));
  // Legacy servers ignore offset entirely, so missing pagination metadata must
  // be treated as a single finite page instead of repeatedly fetching page 1.
  const hasMore = !Array.isArray(response) && response.has_more === true;
  const nextOffset = Array.isArray(response)
    ? offset + records.length
    : Number.isSafeInteger(response.next_offset) && (response.next_offset || 0) >= offset
      ? (response.next_offset as number)
      : offset + records.length;
  return { history: records.map(blockTermHistoryRecordToModel), offset, limit, hasMore, nextOffset };
}

function normalizeBookmarkResponse(
  response: { bookmarks?: BlockTermBookmarkApiRecord[] } | BlockTermBookmarkApiRecord[]
): BlockTermBookmark[] {
  const records = Array.isArray(response) ? response : response.bookmarks || [];
  return records.map(blockTermBookmarkRecordToModel);
}

function blockTermCompletionCommonPrefix(candidates: readonly BlockTermCompletionCandidate[]): string {
  if (candidates.length === 0) return "";
  let prefix = Array.from(candidates[0].value);
  for (const candidate of candidates.slice(1)) {
    const value = Array.from(candidate.value);
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (prefix.length === 0) break;
  }
  return prefix.join("");
}

function normalizeCompletionResponse(
  response: BlockTermCompletionApiResponse,
  query: BlockTermCompletionQuery
): BlockTermCompletionResult {
  let candidates: BlockTermCompletionCandidate[] = (response.candidates || [])
    .filter((candidate): candidate is { value: string; display?: string; is_directory?: boolean } =>
      Boolean(candidate.value)
    )
    .map((candidate) => ({
      value: candidate.value,
      display: candidate.display || candidate.value,
      isDirectory: !!candidate.is_directory,
    }));
  if (candidates.length === 0 && response.suggestions) {
    candidates = response.suggestions
      .filter((suggestion): suggestion is { label: string; kind?: string } => Boolean(suggestion.label))
      .map((suggestion) => ({
        value: suggestion.label,
        display: suggestion.label,
        isDirectory: suggestion.kind === "directory",
      }));
  }
  return {
    kind: response.kind === "command" || response.kind === "file" ? response.kind : query.kind,
    prefix: typeof response.prefix === "string" ? response.prefix : (query.wordPrefix ?? query.prefix),
    commonPrefix:
      typeof response.common_prefix === "string" ? response.common_prefix : blockTermCompletionCommonPrefix(candidates),
    hasMore: !!response.has_more,
    candidates,
  };
}

export const blockTermApi = {
  list: async (
    terminalId: string,
    options: BlockTermListOptions = {}
  ): Promise<{ blocks: BlockTermBlock[]; deletedBlockIds: string[] }> => {
    const params = new URLSearchParams({ terminal_id: terminalId });
    if (options.includeOutput !== undefined) params.set("include_output", options.includeOutput ? "1" : "0");
    const response = await request<
      { blocks?: BlockTermApiRecord[]; deleted_block_ids?: string[] } | BlockTermApiRecord[]
    >(`/blockterm/blocks?${params.toString()}`);
    return normalizeListResponse(response);
  },

  create: async (input: BlockTermApiCreate): Promise<{ block: BlockTermBlock }> => {
    const payload = modelPatchToPayload(input);
    payload.terminal_id = input.terminalId;
    if (input.id) payload.id = input.id;
    const response = await request<{ block: BlockTermApiRecord } | BlockTermApiRecord>("/blockterm/blocks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const record = "block" in response ? response.block : response;
    return { block: blockTermRecordToModel(record) };
  },

  createRuntime: (input: BlockTermRuntimeCreateInput) =>
    request<{ ok: boolean; runtime: BlockTermRuntimeInfo }>("/blockterm/runtime", {
      method: "POST",
      body: JSON.stringify({
        terminal_id: input.terminalId,
        block_id: input.blockId,
        block_token: input.blockToken,
        ...(input.runtimeType ? { runtime_type: input.runtimeType } : {}),
        ...(input.sshProfileId ? { ssh_profile_id: input.sshProfileId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.cols !== undefined ? { cols: input.cols } : {}),
        ...(input.rows !== undefined ? { rows: input.rows } : {}),
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.initialInput !== undefined ? { initial_input: encodeUtf8Base64(input.initialInput) } : {}),
      }),
    }),

  getRuntime: (terminalId: string, blockId: string, blockToken: string) => {
    const params = new URLSearchParams({ block_token: blockToken });
    return request<{ runtime: BlockTermRuntimeInfo }>(
      `/blockterm/runtime/${encodeURIComponent(terminalId)}/${encodeURIComponent(blockId)}?${params.toString()}`
    );
  },

  inputRuntime: (terminalId: string, blockId: string, blockToken: string, data: string) =>
    request<{ ok: boolean }>(
      `/blockterm/runtime/${encodeURIComponent(terminalId)}/${encodeURIComponent(blockId)}/input`,
      {
        method: "POST",
        body: JSON.stringify({ block_token: blockToken, data: encodeUtf8Base64(data) }),
      }
    ),

  resizeRuntime: (terminalId: string, blockId: string, blockToken: string, cols: number, rows: number) =>
    request<{ ok: boolean }>(
      `/blockterm/runtime/${encodeURIComponent(terminalId)}/${encodeURIComponent(blockId)}/resize`,
      {
        method: "POST",
        body: JSON.stringify({ block_token: blockToken, cols, rows }),
      }
    ),

  signalRuntime: (terminalId: string, blockId: string, blockToken: string, signal: "INT" | "TERM" | "KILL") =>
    request<{ ok: boolean }>(
      `/blockterm/runtime/${encodeURIComponent(terminalId)}/${encodeURIComponent(blockId)}/signal`,
      {
        method: "POST",
        body: JSON.stringify({ block_token: blockToken, signal }),
      }
    ),

  closeRuntime: (terminalId: string, blockId: string, blockToken: string) => {
    const params = new URLSearchParams({ block_token: blockToken });
    return request<{ ok: boolean }>(
      `/blockterm/runtime/${encodeURIComponent(terminalId)}/${encodeURIComponent(blockId)}?${params.toString()}`,
      { method: "DELETE" }
    );
  },

  runtimeWsUrl: (terminalId: string, blockId: string, blockToken: string, cursor?: number) => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const key = localStorage.getItem("vibego_auth_key");
    const params = new URLSearchParams({ block_token: blockToken });
    if (cursor !== undefined && Number.isSafeInteger(cursor) && cursor > 0) params.set("cursor", String(cursor));
    if (key) params.set("key", key);
    return `${proto}//${window.location.host}/api/blockterm/runtime/ws/${encodeURIComponent(terminalId)}/${encodeURIComponent(blockId)}?${params.toString()}`;
  },

  listHistory: async (query: BlockTermHistoryQuery = {}): Promise<BlockTermHistoryResult> => {
    const params = new URLSearchParams();
    if (query.terminalId) params.set("terminal_id", query.terminalId);
    if (query.workspaceSessionId) params.set("workspace_session_id", query.workspaceSessionId);
    if (query.groupId) params.set("group_id", query.groupId);
    if (query.runtimeType) params.set("runtime_type", query.runtimeType);
    if (query.starredOnly) params.set("starred", "1");
    if (query.query) params.set("q", query.query);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const suffix = params.toString();
    const response = await request<BlockTermHistoryApiResponse | BlockTermHistoryApiRecord[]>(
      `/blockterm/history${suffix ? `?${suffix}` : ""}`,
      { signal: query.signal }
    );
    return normalizeHistoryResponse(response, query);
  },

  updateHistoryStarred: async (
    target: BlockTermHistoryTarget,
    starred: boolean
  ): Promise<{ history: BlockTermHistoryEntry }> => {
    const payload = blockTermHistoryTargetToPayload(target);
    payload.starred = starred;
    const response = await request<{ history: BlockTermHistoryApiRecord } | BlockTermHistoryApiRecord>(
      `/blockterm/history/${encodeURIComponent(target.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      }
    );
    const record = "history" in response ? response.history : response;
    return { history: blockTermHistoryRecordToModel(record) };
  },

  purgeHistory: async (targets: readonly BlockTermHistoryTarget[]): Promise<{ purgedIds: string[] }> => {
    const response = await request<{ purged_ids?: string[] }>("/blockterm/history", {
      method: "DELETE",
      body: JSON.stringify({ targets: targets.map(blockTermHistoryTargetToPayload) }),
    });
    return { purgedIds: Array.isArray(response.purged_ids) ? response.purged_ids : [] };
  },

  getHistoryOutput: async (
    target: BlockTermHistoryTarget,
    signal?: AbortSignal
  ): Promise<BlockTermHistoryOutputResult> => {
    const params = new URLSearchParams({
      terminal_id: target.terminalId,
      workspace_session_id: target.workspaceSessionId ?? "",
      group_id: target.groupId ?? "",
      user_id: target.userId ?? "",
    });
    const response = await fetch(
      `${API_BASE}/blockterm/history/${encodeURIComponent(target.id)}/output?${params.toString()}`,
      {
        headers: getAuthHeaders(),
        signal,
      }
    );
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as ApiErrorBody;
      throw new BlockTermApiError(error.error || "Failed to load history output", response.status, error);
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      cursor: parseOutputCursorHeader(response.headers.get("X-BlockTerm-Output-Cursor")),
    };
  },

  listBookmarks: async (query: BlockTermBookmarkQuery = {}): Promise<{ bookmarks: BlockTermBookmark[] }> => {
    const params = new URLSearchParams();
    if (query.query) params.set("q", query.query);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.toString();
    const response = await request<{ bookmarks?: BlockTermBookmarkApiRecord[] } | BlockTermBookmarkApiRecord[]>(
      `/blockterm/bookmarks${suffix ? `?${suffix}` : ""}`,
      { signal: query.signal }
    );
    return { bookmarks: normalizeBookmarkResponse(response) };
  },

  createBookmark: async (input: BlockTermBookmarkInput): Promise<{ bookmark: BlockTermBookmark }> => {
    const response = await request<{ bookmark: BlockTermBookmarkApiRecord } | BlockTermBookmarkApiRecord>(
      "/blockterm/bookmarks",
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
    const record = "bookmark" in response ? response.bookmark : response;
    return { bookmark: blockTermBookmarkRecordToModel(record) };
  },

  updateBookmark: async (id: string, patch: BlockTermBookmarkPatch): Promise<{ bookmark: BlockTermBookmark }> => {
    const response = await request<{ bookmark: BlockTermBookmarkApiRecord } | BlockTermBookmarkApiRecord>(
      `/blockterm/bookmarks/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    );
    const record = "bookmark" in response ? response.bookmark : response;
    return { bookmark: blockTermBookmarkRecordToModel(record) };
  },

  removeBookmark: (id: string) =>
    request<{ ok: boolean }>(`/blockterm/bookmarks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  complete: async (query: BlockTermCompletionQuery): Promise<BlockTermCompletionResult> => {
    if (query.draft !== undefined && query.cursor !== undefined) {
      const response = await request<BlockTermCompletionApiResponse>("/blockterm/completion", {
        method: "POST",
        body: JSON.stringify({
          terminal_id: query.terminalId,
          draft: query.draft,
          cursor: query.cursor,
          prefix: query.prefix,
          kind: query.kind,
          executable_only: !!query.executableOnly,
          cwd: query.cwd,
          runtime_type: query.runtimeType,
          ssh_profile_id: query.sshProfileId,
        }),
        signal: query.signal,
      });
      return normalizeCompletionResponse(response, query);
    }

    const response = await request<BlockTermCompletionApiResponse>("/blockterm/completions", {
      method: "POST",
      body: JSON.stringify({
        terminal_id: query.terminalId,
        cwd: query.cwd,
        prefix: query.prefix,
      }),
      signal: query.signal,
    });
    return normalizeCompletionResponse(response, query);
  },

  update: async (id: string, patch: BlockTermApiPatch): Promise<{ block: BlockTermBlock }> => {
    const response = await request<{ block: BlockTermApiRecord } | BlockTermApiRecord>(
      `/blockterm/blocks/${encodeURIComponent(id)}?include_output=0`,
      {
        method: "PATCH",
        body: JSON.stringify(modelPatchToPayload(patch)),
      }
    );
    const record = "block" in response ? response.block : response;
    return { block: blockTermRecordToModel(record) };
  },

  restart: async (id: string, input: BlockTermRestartInput): Promise<{ block: BlockTermBlock }> => {
    const response = await request<{ block: BlockTermApiRecord } | BlockTermApiRecord>(
      `/blockterm/blocks/${encodeURIComponent(id)}/restart`,
      {
        method: "POST",
        body: JSON.stringify({
          token: input.token,
          ...(input.independentRuntime ? { independent_runtime: true } : {}),
          mode: input.mode,
          term_cols: input.termCols,
          term_rows: input.termRows,
          term_flex_rows: input.termFlexRows,
          term_max_pty_size: input.termMaxPtySize,
          before_state_json: input.beforeStateJson,
        }),
      }
    );
    const record = "block" in response ? response.block : response;
    return { block: blockTermRecordToModel(record) };
  },

  cancelRestart: async (id: string, token: string, independentRuntime = false): Promise<{ block: BlockTermBlock }> => {
    const response = await request<{ block: BlockTermApiRecord } | BlockTermApiRecord>(
      `/blockterm/blocks/${encodeURIComponent(id)}/restart/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ token, ...(independentRuntime ? { independent_runtime: true } : {}) }),
      }
    );
    const record = "block" in response ? response.block : response;
    return { block: blockTermRecordToModel(record) };
  },

  remove: (id: string) =>
    request<{ ok: boolean }>(`/blockterm/blocks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getOutput: async (id: string, signal?: AbortSignal): Promise<BlockTermOutputResult> => {
    const response = await fetch(`${API_BASE}/blockterm/blocks/${encodeURIComponent(id)}/output`, {
      headers: getAuthHeaders(),
      signal,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as ApiErrorBody;
      throw new BlockTermApiError(error.error || "Failed to load block output", response.status, error);
    }
    const cursor = parseOutputCursorHeader(response.headers.get("X-BlockTerm-Output-Cursor"));
    return { value: new TextDecoder().decode(await response.arrayBuffer()), cursor };
  },

  getRawOutput: async (id: string, signal?: AbortSignal, cursor?: number): Promise<BlockTermRawOutputResult> => {
    const query = Number.isSafeInteger(cursor) && (cursor ?? -1) >= 0 ? `?cursor=${cursor}` : "";
    const response = await fetch(`${API_BASE}/blockterm/blocks/${encodeURIComponent(id)}/raw-output${query}`, {
      headers: getAuthHeaders(),
      signal,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as ApiErrorBody;
      throw new BlockTermApiError(error.error || "Failed to load raw block output", response.status, error);
    }
    const endCursor =
      parseOutputCursorHeader(response.headers.get("X-BlockTerm-Output-End-Cursor")) ??
      parseOutputCursorHeader(response.headers.get("X-BlockTerm-Output-Cursor"));
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      startCursor: parseOutputCursorHeader(response.headers.get("X-BlockTerm-Output-Start-Cursor")),
      endCursor,
    };
  },

  putOutput: async (id: string, value: string, cursor: number, signal?: AbortSignal): Promise<void> => {
    const outputBytes = new TextEncoder().encode(value).byteLength;
    if (outputBytes > BLOCKTERM_OUTPUT_MAX_BYTES) {
      const message = `Block output is too large (max ${BLOCKTERM_OUTPUT_MAX_BYTES} bytes)`;
      throw new BlockTermApiError(message, 413, { error: message });
    }
    const response = await fetch(`${API_BASE}/blockterm/blocks/${encodeURIComponent(id)}/output`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-BlockTerm-Output-Cursor": String(cursor),
        ...getAuthHeaders(),
      },
      body: value,
      signal,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as ApiErrorBody;
      throw new BlockTermApiError(error.error || "Failed to persist block output", response.status, error);
    }
  },
};
