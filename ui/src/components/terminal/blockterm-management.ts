// Copyright 2026, VibeGo contributors
// SPDX-License-Identifier: Apache-2.0

/** Pure parser for BlockTerm's WaveTerm-compatible management commands. */

export const MAX_BLOCKTERM_MANAGEMENT_INPUT_BYTES = 64 * 1024;
export const MAX_BLOCKTERM_MANAGEMENT_TOKEN_BYTES = 16 * 1024;
export const MAX_BLOCKTERM_MANAGEMENT_TOKENS = 256;
export const MAX_BLOCKTERM_MANAGEMENT_KWARGS = 128;

const ROOT_COMMANDS = new Set(["run", "clear", "signal", "connect", "sync"]);
const NAMESPACE_ROOT_COMMANDS = new Set(["reset", "screen"]);
const NAMESPACE_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  reset: new Set(["cwd"]),
  screen: new Set([
    "archive",
    "delete",
    "new",
    "open",
    "reorder",
    "reset",
    "resize",
    "set",
    "show",
    "showall",
    "termtheme",
    "webshare",
  ]),
  line: new Set([
    "show",
    "star",
    "bookmark",
    "pin",
    "archive",
    "delete",
    "setheight",
    "view",
    "set",
    "restart",
    "minimize",
  ]),
  sidebar: new Set(["open", "close", "add", "remove"]),
};

const UNSUPPORTED_COMMAND_MESSAGES: Readonly<Record<string, string>> = {
  "screen:archive": "/screen:archive is unsupported because BlockTerm terminals do not have an archive state",
  "screen:reset": "/screen:reset is unsupported because BlockTerm cannot replace a terminal's remote context in place",
  "screen:termtheme": "/screen:termtheme is unsupported because BlockTerm has no per-terminal theme setting",
  "screen:webshare": "/screen:webshare is unsupported because WaveTerm websharing is no longer available",
};

const MANAGEMENT_WORD_RE = /^\/([a-z_][a-z0-9_-]*)(?::([a-z][a-z0-9_-]*))?$/u;
const MANAGEMENT_NAMESPACE_PREFIX_RE = /^\/(?:line|reset|screen|sidebar)(?::|$)/u;
const KNOWN_COMMAND_AFTER_BRACKET_RE =
  /(?:^|\s)\/(?:run|clear|signal|connect|reset|sync|screen|line|sidebar)(?::|\s|$)/u;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const OPERATOR_CHARS = new Set([";", "|", "&", "<", ">", "(", ")", "\n", "\r"]);
const textEncoder = new TextEncoder();

export type BlockTermManagementParseErrorCode =
  | "input-too-large"
  | "token-too-large"
  | "too-many-tokens"
  | "too-many-kwargs"
  | "unterminated-quote"
  | "trailing-escape"
  | "unsupported-operator"
  | "invalid-bracket-args"
  | "invalid-kwarg"
  | "invalid-command"
  | "missing-command"
  | "missing-subcommand"
  | "unknown-subcommand";

export interface BlockTermManagementParseError {
  kind: "error";
  raw: string;
  code: BlockTermManagementParseErrorCode;
  message: string;
  commandName?: string;
  /** UTF-16 source offset, when the error can be located precisely. */
  position?: number;
}

export interface BlockTermManagementCommandBase {
  raw: string;
  /** Root name, e.g. `line` for `/line:set`. */
  name: string;
  /** Full name without the leading slash, e.g. `line:set`. */
  commandName: string;
  subcommand?: string;
  args: string[];
  kwargs: Record<string, string>;
}

export interface BlockTermManagementCommand extends BlockTermManagementCommandBase {
  kind: "management";
  name: "run" | "clear" | "signal" | "connect" | "reset" | "sync" | "screen" | "line" | "sidebar";
  /** Exact shell text following `/run`, without reparsing or reconstruction. */
  command?: string;
}

export interface BlockTermManagementUnsupportedCommand extends BlockTermManagementCommandBase {
  kind: "unsupported";
  name: "connect" | "screen";
  code: "unsupported";
  supported: false;
  message: string;
}

export interface BlockTermShellCommand {
  kind: "shell";
  raw: string;
  command: string;
}

export type BlockTermManagementCommandResult =
  | BlockTermManagementCommand
  | BlockTermManagementUnsupportedCommand
  | BlockTermManagementParseError
  | BlockTermShellCommand;

export interface BlockTermManagementToken {
  value: string;
  startsQuoted: boolean;
  start: number;
  end: number;
}

export type BlockTermManagementTokenizeResult =
  | { ok: true; tokens: BlockTermManagementToken[] }
  | {
      ok: false;
      code: Extract<
        BlockTermManagementParseErrorCode,
        "token-too-large" | "too-many-tokens" | "unterminated-quote" | "trailing-escape" | "unsupported-operator"
      >;
      position: number;
      detail?: string;
    };

interface CommandEnvelope {
  commandSource: string;
  commandOffset: number;
  bracketSource?: string;
  bracketOffset?: number;
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function makeError(
  raw: string,
  code: BlockTermManagementParseErrorCode,
  message: string,
  commandName?: string,
  position?: number
): BlockTermManagementParseError {
  return {
    kind: "error",
    raw,
    code,
    message,
    ...(commandName ? { commandName } : {}),
    ...(position === undefined ? {} : { position }),
  };
}

function isManagementParseError(
  value: Record<string, string> | BlockTermManagementParseError
): value is BlockTermManagementParseError {
  return value.kind === "error";
}

function syntaxMessage(code: BlockTermManagementParseErrorCode, detail?: string): string {
  switch (code) {
    case "unterminated-quote":
      return "unterminated quote in management command";
    case "trailing-escape":
      return "trailing escape in management command";
    case "unsupported-operator":
      return `shell operator${detail ? ` ${JSON.stringify(detail)}` : ""} is not supported in a management command`;
    case "token-too-large":
      return `management argument is too large (max ${MAX_BLOCKTERM_MANAGEMENT_TOKEN_BYTES} bytes)`;
    case "too-many-tokens":
      return `management command has too many arguments (max ${MAX_BLOCKTERM_MANAGEMENT_TOKENS})`;
    default:
      return "malformed management command";
  }
}

function decodeAnsiEscape(source: string): string {
  return source.replace(
    /\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|(.))/gs,
    (_match, hex, shortUnicode, longUnicode, octal, escaped) => {
      const digits = hex || shortUnicode || longUnicode || octal;
      if (digits) {
        const codePoint = Number.parseInt(digits, octal ? 8 : 16);
        return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      }
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

/**
 * Parse shell-like words without evaluating variables or substitutions.
 * Operators are rejected because management arguments are data, not another
 * shell program. `/run` uses a separate raw-body validator.
 */
export function tokenizeBlockTermManagement(source: string): BlockTermManagementTokenizeResult {
  const tokens: BlockTermManagementToken[] = [];
  let value = "";
  let start = -1;
  let startsQuoted = false;
  let started = false;
  let quote: "single" | "double" | "ansi" | null = null;
  let escaped = false;
  let ansiRaw = "";

  const fail = (
    code: Extract<
      BlockTermManagementParseErrorCode,
      "token-too-large" | "too-many-tokens" | "unterminated-quote" | "trailing-escape" | "unsupported-operator"
    >,
    position: number,
    detail?: string
  ): BlockTermManagementTokenizeResult => ({
    ok: false,
    code,
    position,
    ...(detail ? { detail } : {}),
  });

  const push = (end: number): BlockTermManagementTokenizeResult | null => {
    if (!started) return null;
    if (utf8ByteLength(value) > MAX_BLOCKTERM_MANAGEMENT_TOKEN_BYTES) return fail("token-too-large", start);
    tokens.push({ value, startsQuoted, start, end });
    if (tokens.length > MAX_BLOCKTERM_MANAGEMENT_TOKENS) return fail("too-many-tokens", start);
    value = "";
    start = -1;
    startsQuoted = false;
    started = false;
    return null;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === "single") {
      if (char === "'") quote = null;
      else value += char;
      continue;
    }
    if (quote === "double") {
      if (escaped) {
        escaped = false;
        if (char !== "\n") value += '"\\$`'.includes(char) ? char : `\\${char}`;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      } else {
        value += char;
      }
      continue;
    }
    if (quote === "ansi") {
      if (escaped) {
        ansiRaw += `\\${char}`;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "'") {
        value += decodeAnsiEscape(ansiRaw);
        ansiRaw = "";
        quote = null;
      } else {
        ansiRaw += char;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      if (char !== "\n") value += char;
      continue;
    }
    if (isWhitespace(char)) {
      const result = push(index);
      if (result) return result;
      continue;
    }
    if (OPERATOR_CHARS.has(char)) return fail("unsupported-operator", index, char);
    if (char === "#" && !started) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }

    if (start < 0) start = index;
    if (char === "'") {
      startsQuoted = !started;
      started = true;
      quote = "single";
    } else if (char === '"') {
      startsQuoted = !started;
      started = true;
      quote = "double";
    } else if (char === "$" && source[index + 1] === "'") {
      startsQuoted = !started;
      started = true;
      quote = "ansi";
      ansiRaw = "";
      index += 1;
    } else if (char === "\\") {
      started = true;
      escaped = true;
    } else {
      started = true;
      value += char;
    }
  }

  if (quote !== null) return fail("unterminated-quote", source.length);
  if (escaped) return fail("trailing-escape", Math.max(0, source.length - 1));
  const result = push(source.length);
  return result ?? { ok: true, tokens };
}

function findBracketClose(source: string, opening: number): number {
  let quote: "single" | "double" | "ansi" | null = null;
  let escaped = false;
  for (let index = opening + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "double" || quote === "ansi") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if ((quote === "double" && char === '"') || (quote === "ansi" && char === "'")) quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      quote = "single";
    } else if (char === '"') {
      quote = "double";
    } else if (char === "$" && source[index + 1] === "'") {
      quote = "ansi";
      index += 1;
    } else if (char === "]") {
      return index;
    }
  }
  return -1;
}

function extractCommandEnvelope(raw: string): CommandEnvelope | BlockTermManagementParseError | BlockTermShellCommand {
  let start = 0;
  while (start < raw.length && isWhitespace(raw[start])) start += 1;
  if (raw[start] !== "[") return { commandSource: raw.slice(start), commandOffset: start };

  const close = findBracketClose(raw, start);
  if (close < 0) {
    return KNOWN_COMMAND_AFTER_BRACKET_RE.test(raw.slice(start))
      ? makeError(raw, "invalid-bracket-args", "unmatched '[' found in management command", undefined, start)
      : { kind: "shell", raw, command: raw };
  }
  let commandOffset = close + 1;
  while (commandOffset < raw.length && isWhitespace(raw[commandOffset])) commandOffset += 1;
  return {
    commandSource: raw.slice(commandOffset),
    commandOffset,
    bracketSource: raw.slice(start + 1, close),
    bracketOffset: start + 1,
  };
}

function scanFirstBareWord(source: string): { word: string; end: number; restStart: number; operator?: string } | null {
  if (!source) return null;
  let end = 0;
  while (end < source.length && !isWhitespace(source[end]) && !OPERATOR_CHARS.has(source[end])) end += 1;
  if (end === 0) return null;
  const operator =
    end < source.length && OPERATOR_CHARS.has(source[end]) && !isWhitespace(source[end]) ? source[end] : undefined;
  let restStart = end;
  if (!operator) while (restStart < source.length && isWhitespace(source[restStart])) restStart += 1;
  return { word: source.slice(0, end), end, restStart, ...(operator ? { operator } : {}) };
}

function commandInfo(word: string): { name: string; subcommand?: string; commandName: string } | null {
  const match = MANAGEMENT_WORD_RE.exec(word);
  if (!match) return null;
  const name = match[1];
  const subcommand = match[2];
  return {
    name,
    ...(subcommand ? { subcommand } : {}),
    commandName: subcommand ? `${name}:${subcommand}` : name,
  };
}

function defineKwarg(kwargs: Record<string, string>, key: string, value: string): boolean {
  if (!IDENTIFIER_RE.test(key) || DANGEROUS_KEYS.has(key)) return false;
  Object.defineProperty(kwargs, key, { configurable: true, enumerable: true, writable: true, value });
  return true;
}

function parseBracketKwargs(
  raw: string,
  source: string | undefined,
  offset: number | undefined,
  commandName: string
): Record<string, string> | BlockTermManagementParseError {
  const kwargs: Record<string, string> = {};
  if (source === undefined) return kwargs;
  const parsed = tokenizeBlockTermManagement(source);
  if (!parsed.ok) {
    return makeError(
      raw,
      parsed.code,
      syntaxMessage(parsed.code, parsed.detail),
      commandName,
      (offset ?? 0) + parsed.position
    );
  }
  for (const token of parsed.tokens) {
    const equals = token.value.indexOf("=");
    const key = equals < 0 ? token.value : token.value.slice(0, equals);
    const value = equals < 0 ? "1" : token.value.slice(equals + 1) || "1";
    if (!defineKwarg(kwargs, key, value)) {
      return makeError(
        raw,
        "invalid-kwarg",
        `invalid keyword argument name ${JSON.stringify(key)}`,
        commandName,
        (offset ?? 0) + token.start
      );
    }
    if (Object.keys(kwargs).length > MAX_BLOCKTERM_MANAGEMENT_KWARGS) {
      return makeError(
        raw,
        "too-many-kwargs",
        `management command has too many keyword arguments (max ${MAX_BLOCKTERM_MANAGEMENT_KWARGS})`,
        commandName,
        (offset ?? 0) + token.start
      );
    }
  }
  return kwargs;
}

function validateRawRunBody(raw: string, command: string): BlockTermManagementParseError | null {
  if (!command.trim()) return makeError(raw, "missing-command", "/run requires a shell command", "run");
  return null;
}

function parseArguments(
  raw: string,
  info: { name: string; subcommand?: string; commandName: string },
  source: string,
  offset: number,
  initialKwargs: Record<string, string>
): BlockTermManagementCommand | BlockTermManagementUnsupportedCommand | BlockTermManagementParseError {
  const parsed = tokenizeBlockTermManagement(source);
  if (!parsed.ok) {
    return makeError(
      raw,
      parsed.code,
      syntaxMessage(parsed.code, parsed.detail),
      info.commandName,
      offset + parsed.position
    );
  }
  const kwargs: Record<string, string> = {};
  for (const [key, value] of Object.entries(initialKwargs)) defineKwarg(kwargs, key, value);
  const args: string[] = [];
  for (const token of parsed.tokens) {
    const equals = token.value.indexOf("=");
    if (!token.startsQuoted && equals > 0) {
      const key = token.value.slice(0, equals);
      if (!defineKwarg(kwargs, key, token.value.slice(equals + 1))) {
        return makeError(
          raw,
          "invalid-kwarg",
          `invalid keyword argument name ${JSON.stringify(key)}`,
          info.commandName,
          offset + token.start
        );
      }
      if (Object.keys(kwargs).length > MAX_BLOCKTERM_MANAGEMENT_KWARGS) {
        return makeError(
          raw,
          "too-many-kwargs",
          `management command has too many keyword arguments (max ${MAX_BLOCKTERM_MANAGEMENT_KWARGS})`,
          info.commandName,
          offset + token.start
        );
      }
    } else {
      args.push(token.value);
    }
  }
  const base = {
    raw,
    name: info.name,
    commandName: info.commandName,
    ...(info.subcommand ? { subcommand: info.subcommand } : {}),
    args,
    kwargs,
  };
  const unsupportedMessage = UNSUPPORTED_COMMAND_MESSAGES[info.commandName];
  if (unsupportedMessage) {
    return {
      ...base,
      kind: "unsupported",
      name: info.name as BlockTermManagementUnsupportedCommand["name"],
      code: "unsupported",
      supported: false,
      message: unsupportedMessage,
    };
  }
  return { ...base, kind: "management", name: info.name as BlockTermManagementCommand["name"] };
}

/**
 * Parse BlockTerm input. Unknown commands and quoted/escaped command names are
 * returned as shell input with their original text intact.
 */
export function parseBlockTermManagementCommand(input: string): BlockTermManagementCommandResult {
  if (typeof input !== "string") {
    return makeError(String(input), "invalid-command", "management command must be a string");
  }
  const raw = input;
  if (utf8ByteLength(raw) > MAX_BLOCKTERM_MANAGEMENT_INPUT_BYTES) {
    return makeError(
      raw,
      "input-too-large",
      `management input is too large (max ${MAX_BLOCKTERM_MANAGEMENT_INPUT_BYTES} bytes)`
    );
  }
  if (!raw.trim()) return { kind: "shell", raw, command: raw };

  const envelope = extractCommandEnvelope(raw);
  if ("kind" in envelope) return envelope;
  const first = scanFirstBareWord(envelope.commandSource);
  if (!first) return { kind: "shell", raw, command: raw };

  const info = commandInfo(first.word);
  if (!info) {
    return MANAGEMENT_NAMESPACE_PREFIX_RE.test(first.word)
      ? makeError(raw, "invalid-command", `invalid management command ${JSON.stringify(first.word)}`)
      : { kind: "shell", raw, command: raw };
  }
  const namespace = NAMESPACE_COMMANDS[info.name];
  if (!ROOT_COMMANDS.has(info.name) && !namespace) return { kind: "shell", raw, command: raw };
  if (first.operator) {
    return makeError(
      raw,
      "unsupported-operator",
      syntaxMessage("unsupported-operator", first.operator),
      info.commandName,
      envelope.commandOffset + first.end
    );
  }
  if (ROOT_COMMANDS.has(info.name) && info.subcommand) {
    return makeError(
      raw,
      "unknown-subcommand",
      `unknown /${info.name} subcommand '${info.subcommand}'`,
      info.commandName
    );
  }
  if (namespace && !info.subcommand && !NAMESPACE_ROOT_COMMANDS.has(info.name)) {
    return makeError(raw, "missing-subcommand", `/${info.name} requires a subcommand`, info.commandName);
  }
  if (namespace && info.subcommand && !namespace.has(info.subcommand)) {
    return makeError(
      raw,
      "unknown-subcommand",
      `unknown /${info.name} subcommand '${info.subcommand}'`,
      info.commandName
    );
  }

  const bracketKwargs = parseBracketKwargs(raw, envelope.bracketSource, envelope.bracketOffset, info.commandName);
  if (isManagementParseError(bracketKwargs)) return bracketKwargs;
  const remainder = envelope.commandSource.slice(first.restStart);
  if (info.name === "run") {
    const error = validateRawRunBody(raw, remainder);
    if (error) return error;
    return {
      kind: "management",
      raw,
      name: "run",
      commandName: "run",
      args: [remainder],
      kwargs: bracketKwargs,
      command: remainder,
    };
  }
  return parseArguments(raw, info, remainder, envelope.commandOffset + first.restStart, bracketKwargs);
}

export const parseBlockTermManagement = parseBlockTermManagementCommand;

export function isBlockTermManagementResult(
  result: BlockTermManagementCommandResult
): result is BlockTermManagementCommand | BlockTermManagementUnsupportedCommand {
  return result.kind === "management" || result.kind === "unsupported";
}
