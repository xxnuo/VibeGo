import type { BlockStatus, BlockTermBlock, BlockTermRuntimeType } from "./blockterm-model.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const BLOCKTERM_LINE_AI_DEFAULT_PROMPT_BYTES = 1 << 20;
export const BLOCKTERM_LINE_AI_DEFAULT_HISTORY_BYTES = 256 << 10;
export const BLOCKTERM_LINE_AI_MAX_HISTORY_MESSAGES = 40;
export const BLOCKTERM_LINE_AI_MAX_DISPLAY_COMMAND_BYTES = 32 << 10;
export const BLOCKTERM_LINE_AI_TRUNCATION_MARKER = "... [truncated] ...";

export type BlockTermLineAIRole = "user" | "assistant";

/** Message shape accepted by the multi-turn model API. */
export interface BlockTermLineAIMessage {
  role: BlockTermLineAIRole;
  content: string;
}

export interface BlockTermLineAIPromptOptions {
  maxBytes?: number;
  maxHistoryBytes?: number;
  maxHistoryMessages?: number;
}

export interface BlockTermLineAIPromptResult {
  /** Compatibility text for the existing `prompt` request field. */
  prompt: string;
  sourceBlockId: string;
  messages: BlockTermLineAIMessage[];
  truncated: boolean;
}

export interface BlockTermLineAIRunInput {
  id: string;
  terminalId: string;
  lineNum?: number;
  command: string;
  currentCommand: string;
  prompt: string;
  cwd: string;
  runtimeType?: BlockTermRuntimeType;
  sshProfileId?: string;
  model?: string;
  sourceBlockId: string;
  messages: BlockTermLineAIMessage[];
}

export interface BlockTermLineAICodeBlock {
  index: number;
  language: string;
  content: string;
  fence: "backtick" | "tilde";
}

export interface BlockTermLineAIRefillEdit {
  draft: string;
  cursor: number;
}

/** Preserve an ambiguous request ID, but allocate a fresh block for a confirmed failed run. */
export function buildBlockTermLineAIRetryInput(
  request: BlockTermLineAIRunInput,
  restart: boolean,
  nextId: string,
  nextLineNum?: number
): BlockTermLineAIRunInput {
  if (!restart) return request;
  const retry = { ...request, id: nextId };
  if (nextLineNum === undefined) delete retry.lineNum;
  else retry.lineNum = nextLineNum;
  return retry;
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function utf8PrefixSize(bytes: Uint8Array, maxBytes: number): number {
  if (bytes.byteLength <= maxBytes) return bytes.byteLength;
  if (maxBytes <= 0) return 0;
  let end = Math.min(maxBytes, bytes.byteLength);
  let start = end - 1;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
  const first = bytes[start];
  const sequenceLength =
    first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : (first & 0xf8) === 0xf0 ? 4 : 1;
  if (start + sequenceLength > end) end = start;
  return end;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value === "") return "";
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return textDecoder.decode(bytes.subarray(0, utf8PrefixSize(bytes, maxBytes)));
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value === "") return "";
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let start = Math.max(0, bytes.byteLength - maxBytes);
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return textDecoder.decode(bytes.subarray(start));
}

/** Truncate text by UTF-8 bytes without splitting a code point. */
export function truncateBlockTermLineAIText(
  value: string,
  maxBytes: number,
  marker = BLOCKTERM_LINE_AI_TRUNCATION_MARKER
): { value: string; truncated: boolean } {
  const limit = Math.max(0, Math.trunc(Number.isFinite(maxBytes) ? maxBytes : 0));
  if (byteLength(value) <= limit) return { value, truncated: false };
  if (limit === 0) return { value: "", truncated: true };
  const markerBytes = byteLength(marker);
  if (markerBytes >= limit) return { value: takeUtf8Prefix(marker, limit), truncated: true };
  const available = limit - markerBytes;
  return {
    value: `${takeUtf8Prefix(value, Math.ceil(available / 2))}${marker}${takeUtf8Suffix(value, Math.floor(available / 2))}`,
    truncated: true,
  };
}

function normalizeStatus(value: unknown): BlockStatus {
  switch (value) {
    case "running":
    case "streaming":
    case "success":
    case "error":
    case "interrupted":
      return value;
    default:
      return "success";
  }
}

function blockFailed(block: BlockTermBlock): boolean {
  const status = normalizeStatus(block.status);
  return (
    status === "error" || status === "interrupted" || (Number.isSafeInteger(block.exitCode) && block.exitCode !== 0)
  );
}

/** Build the default one-line user question without exposing block output. */
export function getBlockTermLineAIDefaultPrompt(block: BlockTermBlock): string {
  return blockFailed(block) ? "How should I fix this?" : "What should I do next?";
}

function normalizeMessage(message: BlockTermLineAIMessage): BlockTermLineAIMessage | null {
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
  if (typeof message.content !== "string" || message.content.length === 0) return null;
  return { role: message.role, content: message.content };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.max(1, Math.trunc(value as number));
}

function messageBytes(message: BlockTermLineAIMessage): number {
  return byteLength(JSON.stringify(message));
}

function fitMessage(message: BlockTermLineAIMessage, maxBytes: number): BlockTermLineAIMessage | null {
  if (maxBytes <= 0) return null;
  if (messageBytes(message) <= maxBytes) return message;
  let low = 0;
  let high = byteLength(message.content);
  let best: BlockTermLineAIMessage | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { role: message.role, content: truncateBlockTermLineAIText(message.content, middle).value };
    if (messageBytes(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best?.content ? best : null;
}

/**
 * Keep only recent valid turns, preserving order and never mutating the input.
 * The latest turn is preferentially retained and may be UTF-8 bounded.
 */
export function limitBlockTermLineAIHistory(
  input: readonly BlockTermLineAIMessage[],
  options: Pick<BlockTermLineAIPromptOptions, "maxHistoryBytes" | "maxHistoryMessages"> = {}
): { messages: BlockTermLineAIMessage[]; truncated: boolean } {
  const maxBytes = normalizePositiveInteger(options.maxHistoryBytes, BLOCKTERM_LINE_AI_DEFAULT_HISTORY_BYTES);
  const maxMessages = normalizePositiveInteger(options.maxHistoryMessages, BLOCKTERM_LINE_AI_MAX_HISTORY_MESSAGES);
  const normalized = input.map(normalizeMessage).filter((message): message is BlockTermLineAIMessage => !!message);
  const selected: BlockTermLineAIMessage[] = [];
  let usedBytes = 2;
  for (let index = normalized.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = normalized[index];
    if (!message) continue;
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const available = maxBytes - usedBytes - separatorBytes;
    if (available <= 0) break;
    const fitted = fitMessage(message, available);
    if (!fitted) break;
    selected.unshift(fitted);
    usedBytes += separatorBytes + messageBytes(fitted);
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return {
    messages: selected,
    truncated:
      normalized.length !== input.length ||
      selected.length < normalized.length ||
      selected.some((message, index) => {
        const original = normalized[normalized.length - selected.length + index];
        return message.role !== original?.role || message.content !== original.content;
      }),
  };
}

/** Build bounded multi-turn fields; block output is intentionally server-authoritative. */
export function buildBlockTermLineAIPrompt(
  sourceBlockId: string,
  messages: readonly BlockTermLineAIMessage[],
  options: BlockTermLineAIPromptOptions = {}
): BlockTermLineAIPromptResult {
  const maxBytes = normalizePositiveInteger(options.maxBytes, BLOCKTERM_LINE_AI_DEFAULT_PROMPT_BYTES);
  const history = limitBlockTermLineAIHistory(messages, {
    maxHistoryBytes: normalizePositiveInteger(options.maxHistoryBytes, BLOCKTERM_LINE_AI_DEFAULT_HISTORY_BYTES),
    maxHistoryMessages: options.maxHistoryMessages,
  });
  const boundedMessages = history.messages.map((message) => ({ ...message }));
  let latestUserIndex = -1;
  for (let index = boundedMessages.length - 1; index >= 0; index -= 1) {
    if (boundedMessages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const rawPrompt = latestUserIndex >= 0 ? boundedMessages[latestUserIndex]?.content || "" : "";
  const boundedPrompt = truncateBlockTermLineAIText(rawPrompt, maxBytes);
  if (latestUserIndex >= 0 && boundedMessages[latestUserIndex]) {
    boundedMessages[latestUserIndex] = { role: "user", content: boundedPrompt.value };
  }
  return {
    prompt: boundedPrompt.value,
    sourceBlockId,
    messages: boundedMessages,
    truncated: history.truncated || boundedPrompt.truncated,
  };
}

/** Construct the request shape expected by the extended model API. */
export function buildBlockTermLineAIRunInput(input: {
  id: string;
  terminalId: string;
  lineNum?: number;
  command?: string;
  selectedBlock: BlockTermBlock;
  userQuery?: string;
  history?: readonly BlockTermLineAIMessage[];
  cwd?: string;
  model?: string;
  promptOptions?: BlockTermLineAIPromptOptions;
}): BlockTermLineAIRunInput {
  const userQuery =
    input.userQuery && input.userQuery.trim() ? input.userQuery : getBlockTermLineAIDefaultPrompt(input.selectedBlock);
  const turns = [...(input.history || []), { role: "user" as const, content: userQuery }];
  const built = buildBlockTermLineAIPrompt(input.selectedBlock.id, turns, input.promptOptions);
  const displayCommand = input.command?.trim() || `/chat ${built.prompt}`;
  return {
    id: input.id,
    terminalId: input.terminalId,
    ...(input.lineNum !== undefined ? { lineNum: input.lineNum } : {}),
    command: truncateBlockTermLineAIText(displayCommand, BLOCKTERM_LINE_AI_MAX_DISPLAY_COMMAND_BYTES).value,
    currentCommand: "",
    prompt: built.prompt,
    cwd: input.cwd ?? input.selectedBlock.cwd ?? "",
    ...(input.selectedBlock.runtimeType === "local" || input.selectedBlock.runtimeType === "ssh"
      ? {
          runtimeType: input.selectedBlock.runtimeType,
          ...(input.selectedBlock.runtimeType === "ssh" && input.selectedBlock.sshProfileId
            ? { sshProfileId: input.selectedBlock.sshProfileId }
            : {}),
        }
      : {}),
    ...(input.model ? { model: input.model } : {}),
    sourceBlockId: built.sourceBlockId,
    messages: built.messages,
  };
}

interface FenceOpen {
  char: "`" | "~";
  length: number;
  language: string;
  content: string[];
}

function parseFenceOpen(line: string): FenceOpen | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;
  const run = match[2];
  if (run[0] === "`" && match[3].includes("`")) return null;
  return {
    char: run[0] as "`" | "~",
    length: run.length,
    language: match[3].trim().split(/\s+/u, 1)[0] || "",
    content: [],
  };
}

function isFenceClose(line: string, open: FenceOpen): boolean {
  const fence = open.char === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${fence}{${open.length},}\\s*$`, "u").test(line);
}

/** Parse Markdown fenced blocks; inline code and unclosed fences are ignored. */
export function extractBlockTermLineAICodeBlocks(markdown: string): BlockTermLineAICodeBlock[] {
  if (typeof markdown !== "string" || markdown === "") return [];
  const blocks: BlockTermLineAICodeBlock[] = [];
  let open: FenceOpen | null = null;
  for (const line of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    if (!open) {
      open = parseFenceOpen(line);
      continue;
    }
    if (isFenceClose(line, open)) {
      blocks.push({
        index: blocks.length,
        language: open.language,
        content: open.content.length > 0 ? `${open.content.join("\n")}\n` : "",
        fence: open.char === "`" ? "backtick" : "tilde",
      });
      open = null;
      continue;
    }
    open.content.push(line);
  }
  return blocks;
}

/** Return a draft edit for a selected fenced block, with cursor at its end. */
export function buildBlockTermLineAIRefillEdit(markdown: string, index: number): BlockTermLineAIRefillEdit | null {
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const block = extractBlockTermLineAICodeBlocks(markdown).find((candidate) => candidate.index === index);
  if (!block) return null;
  const draft = block.content.replace(/\n$/u, "");
  return { draft, cursor: draft.length };
}

/** Convenience accessor for callers that only need the text. */
export function getBlockTermLineAICodeForRefill(markdown: string, index: number): string | null {
  return buildBlockTermLineAIRefillEdit(markdown, index)?.draft ?? null;
}
