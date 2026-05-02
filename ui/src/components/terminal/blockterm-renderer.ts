// Copyright 2023, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import Papa from "papaparse";
import { blockTermModelNameFitsLimit } from "./blockterm-model-limits.ts";
import {
  type BlockTermMustacheVariables,
  blockTermMustacheStateFitsLimit,
  parseBlockTermMustacheVariables,
  validateBlockTermMustacheVariables,
} from "./blockterm-mustache.ts";
import {
  BLOCKTERM_RENDERER_NAMES,
  type BlockTermRendererCommandResolution,
  type BlockTermRendererName,
  blockTermRendererRegistry,
} from "./blockterm-renderer-registry.ts";

export type { BlockTermRendererName };
export { BLOCKTERM_RENDERER_NAMES, blockTermRendererRegistry };

export interface BlockTermRendererState {
  "prompt:source"?: "file" | "pty" | "model";
  "prompt:file"?: string;
  mode?: "edit" | "view";
  lang?: string;
  minimap?: boolean;
  variables?: BlockTermMustacheVariables;
  prompt?: string;
  model?: string;
  error?: string;
}

export interface BlockTermRendererSpec {
  renderer: BlockTermRendererName;
  /** WaveTerm renderer data source. PTY is the default for command renderers. */
  /** Omitted for legacy file states; treat omission as file. */
  source?: "file" | "pty" | "model";
  filePath: string;
  mode: "edit" | "view";
  lang?: string;
  minimap?: boolean;
  variables?: BlockTermMustacheVariables;
  prompt?: string;
  model?: string;
  error?: string;
}

export type BlockTermRendererCommandResult =
  | { kind: "none" }
  | { kind: "error"; commandName: string; message: string }
  | {
      kind: "renderer";
      commandName: string;
      renderer: BlockTermRendererName;
      stateJson: string;
      output: string;
      shouldFocus: boolean;
    };

interface ShellWord {
  value: string;
  startsQuoted: boolean;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXTERNAL_URL_RE =
  /^(?:(?:https?|ftp|ftps|file|ws|wss|ssh|sftp):|[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:data|blob|javascript|vbscript|mailto|tel|urn|about):)/i;
const VALID_META_COMMAND_RE = /^\/([a-z_][a-z0-9_-]*)(?::([a-z][a-z0-9_-]*))?$/;
const MAX_CSV_ROWS = 5_000;
const MAX_CSV_COLUMNS = 200;
const MAX_CSV_CELL_LENGTH = 10_000;

export interface BlockTermCsvData {
  columns: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

function isExternalRendererUrl(value: string): boolean {
  return EXTERNAL_URL_RE.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function findClosingDelimiter(source: string, openingIndex: number, opening: string, closing: string): number {
  let depth = 1;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingBacktick(source: string, openingIndex: number): number {
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === "`") return index;
  }
  return -1;
}

function decodeAnsiQuoted(source: string): string {
  return source.replace(
    /\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|(.))/gs,
    (_match, hex, shortUnicode, longUnicode, octal, escaped) => {
      const code = hex || shortUnicode || longUnicode || octal;
      if (code) return String.fromCodePoint(Number.parseInt(code, octal ? 8 : 16));
      const escapes: Record<string, string> = {
        a: "\u0007",
        b: "\b",
        e: "\u001b",
        E: "\u001b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\u000b",
      };
      return escapes[escaped] ?? escaped;
    }
  );
}

function parseShellWords(source: string, preserveExpansions = false): { words: ShellWord[]; error?: string } {
  const words: ShellWord[] = [];
  let value = "";
  let quote: "'" | '"' | null = null;
  let startsQuoted = false;
  let started = false;

  const pushWord = () => {
    if (!started) return;
    words.push({ value, startsQuoted });
    value = "";
    startsQuoted = false;
    started = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === "'") {
      started = true;
      if (char === "'") quote = null;
      else value += char;
      continue;
    }
    if (quote === '"') {
      started = true;
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\") {
        index += 1;
        if (index >= source.length) return { words: [], error: "trailing escape" };
        const escaped = source[index];
        if (escaped !== "\n") value += '"\\$`'.includes(escaped) ? escaped : `\\${escaped}`;
        continue;
      }
      if (char === "$" && (source[index + 1] === "(" || source[index + 1] === "{")) {
        const openingIndex = index + 1;
        const closing = source[openingIndex] === "(" ? ")" : "}";
        const closingIndex = findClosingDelimiter(source, openingIndex, source[openingIndex], closing);
        if (closingIndex < 0) return { words: [], error: `unterminated ${source[openingIndex]} expansion` };
        if (preserveExpansions) value += source.slice(index, closingIndex + 1);
        index = closingIndex;
        continue;
      }
      if (char === "$" && /[A-Za-z_0-9@*#$?!-]/.test(source[index + 1] || "")) {
        let end = index + 2;
        if (/[A-Za-z_]/.test(source[index + 1])) {
          while (/[A-Za-z0-9_]/.test(source[end] || "")) end += 1;
        }
        if (preserveExpansions) value += source.slice(index, end);
        index = end - 1;
        continue;
      }
      if (char === "`") {
        const closingIndex = findClosingBacktick(source, index);
        if (closingIndex < 0) return { words: [], error: "unterminated command substitution" };
        if (preserveExpansions) value += source.slice(index, closingIndex + 1);
        index = closingIndex;
        continue;
      }
      value += char;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    if (char === "#" && !started) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      if (!started) startsQuoted = true;
      started = true;
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      if (index >= source.length) return { words: [], error: "trailing escape" };
      if (source[index] !== "\n") {
        started = true;
        value += source[index];
      }
      continue;
    }
    if (char === "$" && (source[index + 1] === "'" || source[index + 1] === '"')) {
      started = true;
      const quoteChar = source[index + 1];
      let closingIndex = index + 2;
      for (; closingIndex < source.length; closingIndex += 1) {
        if (source[closingIndex] === "\\") closingIndex += 1;
        else if (source[closingIndex] === quoteChar) break;
      }
      if (closingIndex >= source.length) return { words: [], error: "unterminated quote" };
      const quotedValue = source.slice(index + 2, closingIndex);
      value += quoteChar === "'" ? decodeAnsiQuoted(quotedValue) : quotedValue;
      index = closingIndex;
      continue;
    }
    if (char === "$" && (source[index + 1] === "(" || source[index + 1] === "{")) {
      started = true;
      const openingIndex = index + 1;
      const closing = source[openingIndex] === "(" ? ")" : "}";
      const closingIndex = findClosingDelimiter(source, openingIndex, source[openingIndex], closing);
      if (closingIndex < 0) return { words: [], error: `unterminated ${source[openingIndex]} expansion` };
      if (preserveExpansions) value += source.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }
    if (char === "$" && /[A-Za-z_0-9@*#$?!-]/.test(source[index + 1] || "")) {
      started = true;
      let end = index + 2;
      if (/[A-Za-z_]/.test(source[index + 1])) {
        while (/[A-Za-z0-9_]/.test(source[end] || "")) end += 1;
      }
      if (preserveExpansions) value += source.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char === "`") {
      started = true;
      const closingIndex = findClosingBacktick(source, index);
      if (closingIndex < 0) return { words: [], error: "unterminated command substitution" };
      if (preserveExpansions) value += source.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }
    if ((char === "<" || char === ">") && source[index + 1] === "(") {
      started = true;
      const closingIndex = findClosingDelimiter(source, index + 1, "(", ")");
      if (closingIndex < 0) return { words: [], error: "unterminated process substitution" };
      if (preserveExpansions) value += source.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }
    if ("|&;<>()\n".includes(char)) return { words: [], error: "shell operators are not supported" };
    started = true;
    value += char;
  }
  if (quote) return { words: [], error: "unterminated quote" };
  pushWord();
  return { words };
}

function parseBracketArgs(source: string): { kwargs: Map<string, string>; rest: string; error?: string } {
  const trimmed = source.trimStart();
  const kwargs = new Map<string, string>();
  if (!trimmed.startsWith("[")) return { kwargs, rest: source };
  let closingIndex = -1;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "]") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex < 0) return { kwargs, rest: "", error: "unmatched '[' found in command" };
  const rest = trimmed.slice(closingIndex + 1).trimStart();
  const parsed = parseShellWords(trimmed.slice(1, closingIndex), true);
  if (parsed.error) return { kwargs, rest, error: parsed.error };
  for (const word of parsed.words) {
    const equalsIndex = word.value.indexOf("=");
    const name = equalsIndex < 0 ? word.value : word.value.slice(0, equalsIndex);
    if (!IDENTIFIER_RE.test(name)) return { kwargs, rest, error: `invalid identifier ${name}` };
    const rawValue = equalsIndex < 0 ? "" : word.value.slice(equalsIndex + 1);
    kwargs.set(name, rawValue || "1");
  }
  return { kwargs, rest };
}

type RendererCommandMatch =
  | {
      kind: "renderer";
      name: string;
      explicit: boolean;
      resolution: BlockTermRendererCommandResolution<BlockTermRendererName>;
    }
  | { kind: "invalid-subcommand"; name: string; subcommand: string };

function matchRendererCommand(source: string): RendererCommandMatch | null {
  const trimmed = source.trim();
  const firstSpace = trimmed.indexOf(" ");
  const firstWord = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
  const direct = blockTermRendererRegistry.resolveCommand(firstWord);
  if (direct) return { kind: "renderer", name: firstWord, explicit: false, resolution: direct };
  const metaMatch = VALID_META_COMMAND_RE.exec(firstWord);
  const explicit = metaMatch ? blockTermRendererRegistry.resolveCommand(metaMatch[1]) : null;
  if (!metaMatch || !explicit) return null;
  if (metaMatch[2]) {
    return { kind: "invalid-subcommand", name: metaMatch[1], subcommand: metaMatch[2] };
  }
  return { kind: "renderer", name: metaMatch[1], explicit: true, resolution: explicit };
}

function resolveWaveBool(value: string): boolean {
  return value !== "" && value !== "0" && value !== "false";
}

export function parseBlockTermRendererCommand(command: string): BlockTermRendererCommandResult {
  const bracket = parseBracketArgs(command);
  const matchedCommand = matchRendererCommand(bracket.rest);
  if (!matchedCommand) return { kind: "none" };
  if (matchedCommand.kind === "invalid-subcommand") {
    return {
      kind: "error",
      commandName: matchedCommand.name,
      message: `invalid /${matchedCommand.name} subcommand '${matchedCommand.subcommand}'`,
    };
  }
  if (bracket.error) {
    return { kind: "error", commandName: matchedCommand.name, message: bracket.error };
  }

  const parsed = parseShellWords(bracket.rest);
  const { command: definition, renderer: rendererDefinition } = matchedCommand.resolution;
  const renderer = rendererDefinition.name;
  const commandName = matchedCommand.explicit ? matchedCommand.name : definition.name;
  if (parsed.error) return { kind: "error", commandName, message: parsed.error };
  if (parsed.words.length === 0) return { kind: "none" };

  const kwargs = new Map(bracket.kwargs);
  const positional: string[] = [];
  for (const word of parsed.words.slice(1)) {
    const equalsIndex = word.value.indexOf("=");
    const optionName = equalsIndex > 0 ? word.value.slice(0, equalsIndex) : "";
    if (!word.startsQuoted && equalsIndex > 0 && (renderer !== "openai" || optionName === "model")) {
      kwargs.set(word.value.slice(0, equalsIndex), word.value.slice(equalsIndex + 1));
    } else {
      positional.push(word.value);
    }
  }
  if (renderer === "openai") {
    // Only model= is command metadata. Other assignments are ordinary prompt
    // text and must survive parsing unchanged.
    const prompt = positional.join(" ").trim();
    if (!prompt) return { kind: "error", commandName, message: "chat requires a prompt" };
    const model = kwargs.get("model");
    if (model && !blockTermModelNameFitsLimit(model)) {
      return { kind: "error", commandName, message: "model is too long" };
    }
    return {
      kind: "renderer",
      commandName,
      renderer,
      stateJson: JSON.stringify({ "prompt:source": "model", ...(model ? { model } : {}) }),
      output: prompt,
      shouldFocus: definition.shouldFocus,
    };
  }
  const filePath = renderer === "mustache" ? kwargs.get("template") || positional[0] : positional[0];
  if (!filePath) {
    return { kind: "error", commandName, message: `${commandName} requires an argument (file name)` };
  }

  const state: BlockTermRendererState = { "prompt:file": filePath };
  if (renderer !== "media") state["prompt:source"] = "file";
  if (definition.mode) state.mode = definition.mode;
  if (renderer === "mustache") {
    const variableSource = kwargs.get("state_json") || kwargs.get("variables") || positional[1] || "{}";
    const variables = parseBlockTermMustacheVariables(variableSource);
    if (!variables.ok) return { kind: "error", commandName, message: variables.error };
    state.variables = variables.variables;
  }
  const lang = kwargs.get("lang");
  if (renderer === "code" && lang && lang.length <= 50) state.lang = lang;
  if (renderer === "code" && kwargs.has("minimap")) {
    state.minimap = resolveWaveBool(kwargs.get("minimap") || "");
  }

  const stateJson = JSON.stringify(state);
  if (renderer === "mustache" && !blockTermMustacheStateFitsLimit(stateJson)) {
    return { kind: "error", commandName, message: "renderer state_json is too large" };
  }
  return {
    kind: "renderer",
    commandName,
    renderer,
    stateJson,
    output: `${commandName} ${JSON.stringify(filePath)}`,
    shouldFocus: definition.shouldFocus,
  };
}

export function resolveBlockTermRendererPath(cwd: string, filePath: string): string {
  if (!filePath || isExternalRendererUrl(filePath)) return filePath;
  const normalizedFile = filePath.replace(/\\/g, "/");
  if (normalizedFile === "~") return "~";
  if (normalizedFile.startsWith("~/")) {
    const suffix = normalizeRendererPath(normalizedFile.slice(2));
    return suffix === "." ? "~" : `~/${suffix}`;
  }
  if (normalizedFile.startsWith("/") || /^[A-Za-z]:\//.test(normalizedFile) || normalizedFile.startsWith("//")) {
    return normalizeRendererPath(normalizedFile);
  }
  const cwdWithSlashes = (cwd || ".").replace(/\\/g, "/");
  const normalizedCwd = cwdWithSlashes.replace(/\/+$/, "") || (cwdWithSlashes.startsWith("/") ? "/" : "");
  if (!normalizedCwd || normalizedCwd === ".") return normalizeRendererPath(normalizedFile);
  return normalizeRendererPath(`${normalizedCwd}${normalizedCwd.endsWith("/") ? "" : "/"}${normalizedFile}`);
}

function normalizeRendererPath(path: string): string {
  const drive = path.match(/^[A-Za-z]:/)?.[0] || "";
  const unc = !drive && path.startsWith("//");
  const absolute = !!drive || path.startsWith("/");
  const rest = drive ? path.slice(drive.length) : path;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  if (drive) return `${drive}/${parts.join("/")}`;
  if (unc) return `//${parts.join("/")}`;
  if (absolute) return `/${parts.join("/")}`;
  return parts.join("/") || ".";
}

export function parseBlockTermRendererState(
  renderer: string | undefined,
  stateJson: string | undefined,
  cwd: string
): BlockTermRendererSpec | null {
  const rendererDefinition = blockTermRendererRegistry.get(renderer);
  if (!rendererDefinition) return null;
  const rendererName = rendererDefinition.name;
  let parsed: unknown;
  try {
    parsed = stateJson ? JSON.parse(stateJson) : {};
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const state = parsed as Record<string, unknown>;
  const rawFilePath = state["prompt:file"];
  if (rawFilePath !== undefined && (typeof rawFilePath !== "string" || !rawFilePath)) return null;
  const sourceValue = state["prompt:source"];
  if (sourceValue !== undefined && sourceValue !== "file" && sourceValue !== "pty" && sourceValue !== "model")
    return null;
  if (sourceValue === "model" && rendererName !== "openai") return null;
  if (rendererName === "openai") {
    if (state.model !== undefined && (typeof state.model !== "string" || !blockTermModelNameFitsLimit(state.model)))
      return null;
    const error =
      typeof state.error === "string" && new TextEncoder().encode(state.error).byteLength <= 2 * 1024
        ? state.error
        : undefined;
    return {
      renderer: rendererName,
      source: "model",
      filePath: "",
      mode: "view",
      model: typeof state.model === "string" ? state.model : undefined,
      ...(typeof state.prompt === "string" ? { prompt: state.prompt } : {}),
      ...(error ? { error } : {}),
    };
  }
  // Older file renderer blocks omitted prompt:source (media did so by
  // default). Preserve that representation while allowing new command
  // renderers to omit the source and consume their raw PTY output.
  const source: "file" | "pty" | "model" =
    sourceValue || (typeof rawFilePath === "string" && rawFilePath ? "file" : "pty");
  if (source === "file") {
    if (typeof rawFilePath !== "string" || !rawFilePath || isExternalRendererUrl(rawFilePath)) return null;
  } else if (rawFilePath !== undefined) {
    // A PTY renderer has no file identity. Reject mixed state instead of
    // silently rendering a different resource than the persisted source.
    return null;
  }
  if (state.mode !== undefined && state.mode !== "edit" && state.mode !== "view") return null;
  if (state.lang !== undefined && (typeof state.lang !== "string" || state.lang.length > 50)) return null;
  if (state.minimap !== undefined && typeof state.minimap !== "boolean") return null;
  let variables: BlockTermMustacheVariables | undefined;
  if (rendererName === "mustache") {
    if (!blockTermMustacheStateFitsLimit(stateJson ?? "")) return null;
    const rawVariables = state.variables ?? {};
    if (validateBlockTermMustacheVariables(rawVariables)) return null;
    variables = rawVariables as BlockTermMustacheVariables;
  } else if (state.variables !== undefined) {
    return null;
  }
  const mode = state.mode === "edit" ? "edit" : "view";
  const lang = typeof state.lang === "string" && state.lang.length <= 50 ? state.lang : undefined;
  const minimap = typeof state.minimap === "boolean" ? state.minimap : undefined;
  return {
    renderer: rendererName,
    ...(source === "pty" ? { source } : {}),
    filePath: source === "file" ? resolveBlockTermRendererPath(cwd, rawFilePath as string) : "",
    mode,
    lang,
    minimap,
    ...(variables ? { variables } : {}),
  };
}

export function resolveRendererRelativeResource(filePath: string, resource: string): string | null {
  const trimmed = resource.trim();
  if (!trimmed || trimmed.startsWith("#")) return trimmed;
  if (isExternalRendererUrl(trimmed) || trimmed.startsWith("//")) return null;
  const slashIndex = filePath.lastIndexOf("/");
  const base = slashIndex >= 0 ? filePath.slice(0, slashIndex) : ".";
  return resolveBlockTermRendererPath(base, trimmed);
}

function uniqueCsvColumns(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = value || `Column ${index + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function parseBlockTermCsv(content: string): BlockTermCsvData {
  const trimmed = content.trim();
  if (!trimmed) return { columns: [], rows: [], totalRows: 0, truncated: false };
  const result = Papa.parse<string[]>(trimmed, { skipEmptyLines: "greedy" });
  const sourceRows = result.data;
  const rawRows = sourceRows.slice(0, MAX_CSV_ROWS + 1).map((row) => row.slice(0, MAX_CSV_COLUMNS));
  if (rawRows.length === 0) return { columns: [], rows: [], totalRows: 0, truncated: false };
  const hasHeader = /^[A-Za-z"]/.test(trimmed.split(/\r?\n/, 1)[0] || "");
  const width = Math.min(
    MAX_CSV_COLUMNS,
    rawRows.reduce((max, row) => Math.max(max, row.length), 0)
  );
  const columns = hasHeader
    ? uniqueCsvColumns(Array.from({ length: width }, (_, index) => String(rawRows[0]?.[index] ?? "")))
    : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const dataRows = (hasHeader ? rawRows.slice(1) : rawRows).map((row) =>
    Array.from({ length: width }, (_, index) => String(row[index] ?? "").slice(0, MAX_CSV_CELL_LENGTH))
  );
  const totalRows = Math.max(0, sourceRows.length - (hasHeader ? 1 : 0));
  return {
    columns,
    rows: dataRows.slice(0, MAX_CSV_ROWS),
    totalRows,
    truncated: totalRows > MAX_CSV_ROWS || sourceRows.some((row) => row.length > MAX_CSV_COLUMNS),
  };
}
