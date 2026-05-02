export const BLOCKTERM_KEYMAP_SETTING_KEY = "blockterm.keybindings";

export type BlockTermKeymapScope = "app" | "desktop" | "input";

export type BlockTermKeymapAppAction = { type: "open-tab-search" } | { type: "select-workspace"; index: number };

export type BlockTermKeymapDesktopAction =
  | { type: "new-session" }
  | { type: "close-session" }
  | { type: "select-session"; index: number }
  | { type: "previous-session" }
  | { type: "next-session" }
  | { type: "focus-input" }
  | { type: "focus-selected-block" }
  | { type: "rerun-selected-command" }
  | { type: "rerun-last-command" }
  | { type: "previous-block" }
  | { type: "next-block" }
  | { type: "delete-selected-block" }
  | { type: "toggle-sidebar" }
  | { type: "open-bookmarks" }
  | { type: "open-history" };

export type BlockTermKeymapInputAction =
  | "clear"
  | "cut-line-left"
  | "cut-word-left"
  | "paste"
  | "history-previous"
  | "history-next"
  | "insert-newline"
  | "toggle-expanded"
  | "open-history"
  | "submit";

export type BlockTermKeymapAction =
  | { scope: "app"; action: BlockTermKeymapAppAction }
  | { scope: "desktop"; action: BlockTermKeymapDesktopAction }
  | { scope: "input"; action: BlockTermKeymapInputAction };

export interface BlockTermKeybinding {
  command: string;
  keys: string[];
  commandStr?: string[];
  info?: string;
}

export interface BlockTermKeymapCommandDefinition {
  command: string;
  aliases?: string[];
  scope: BlockTermKeymapScope;
  keys: string[];
  action: BlockTermKeymapAction["action"];
  labelKey: string;
}

export type BlockTermKeymapDiagnosticKind =
  | "invalid-config"
  | "invalid-entry"
  | "invalid-key"
  | "unknown-command"
  | "duplicate-command"
  | "conflict";

export interface BlockTermKeymapDiagnostic {
  kind: BlockTermKeymapDiagnosticKind;
  command?: string;
  conflictsWith?: string;
  key?: string;
  message: string;
}

export interface BlockTermKeymap {
  bindings: readonly BlockTermKeybinding[];
  byCommand: ReadonlyMap<string, BlockTermKeybinding>;
  diagnostics: readonly BlockTermKeymapDiagnostic[];
}

export interface BlockTermKeymapParseResult {
  keymap: BlockTermKeymap;
  userBindings: readonly BlockTermKeybinding[];
  diagnostics: readonly BlockTermKeymapDiagnostic[];
  valid: boolean;
}

interface ParsedKeyDescriptor {
  key: string;
  keyType: "key" | "code";
  cmd: boolean;
  option: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_BINDINGS = 64;
export const BLOCKTERM_KEYMAP_MAX_KEYS_PER_BINDING = 16;
const MAX_KEY_LENGTH = 80;
const MODIFIERS = new Set(["cmd", "option", "shift", "ctrl", "alt", "meta"]);

function app(
  command: string,
  keys: string[],
  action: BlockTermKeymapAppAction,
  labelKey: string
): BlockTermKeymapCommandDefinition {
  return { command, keys, action, scope: "app", labelKey };
}

function desktop(
  command: string,
  keys: string[],
  action: BlockTermKeymapDesktopAction,
  labelKey: string
): BlockTermKeymapCommandDefinition {
  return { command, keys, action, scope: "desktop", labelKey };
}

function input(
  command: string,
  keys: string[],
  action: BlockTermKeymapInputAction,
  labelKey: string
): BlockTermKeymapCommandDefinition {
  return { command, keys, action, scope: "input", labelKey };
}

const SESSION_SELECT_DEFINITIONS: BlockTermKeymapCommandDefinition[] = Array.from({ length: 9 }, (_, index) =>
  desktop(
    `app:selectTab-${index + 1}`,
    [`Cmd:${index + 1}`],
    { type: "select-session", index },
    "plugin.blockTerm.keymap.selectSession"
  )
);

const WORKSPACE_SELECT_DEFINITIONS: BlockTermKeymapCommandDefinition[] = Array.from({ length: 9 }, (_, index) =>
  app(
    `app:selectWorkspace-${index + 1}`,
    [`Cmd:Ctrl:${index + 1}`],
    { type: "select-workspace", index },
    "plugin.blockTerm.keymap.selectWorkspace"
  )
);

export const BLOCKTERM_KEYMAP_COMMAND_DEFINITIONS: readonly BlockTermKeymapCommandDefinition[] = [
  app("app:openTabSearchModal", ["Cmd:p"], { type: "open-tab-search" }, "plugin.blockTerm.keymap.openTabSearch"),
  ...WORKSPACE_SELECT_DEFINITIONS,
  desktop("app:newTab", ["Cmd:t"], { type: "new-session" }, "plugin.blockTerm.keymap.newSession"),
  desktop("app:closeCurrentTab", ["Cmd:w"], { type: "close-session" }, "plugin.blockTerm.keymap.closeSession"),
  ...SESSION_SELECT_DEFINITIONS,
  desktop("app:selectTabLeft", ["Cmd:["], { type: "previous-session" }, "plugin.blockTerm.keymap.previousSession"),
  desktop("app:selectTabRight", ["Cmd:]"], { type: "next-session" }, "plugin.blockTerm.keymap.nextSession"),
  desktop("app:focusCmdInput", ["Cmd:i"], { type: "focus-input" }, "plugin.blockTerm.keymap.focusInput"),
  desktop(
    "app:focusSelectedLine",
    ["Cmd:l"],
    { type: "focus-selected-block" },
    "plugin.blockTerm.keymap.focusSelectedBlock"
  ),
  desktop("app:restartCommand", ["Cmd:r"], { type: "rerun-selected-command" }, "plugin.blockTerm.keymap.rerunSelected"),
  desktop(
    "app:restartLastCommand",
    ["Cmd:Shift:r"],
    { type: "rerun-last-command" },
    "plugin.blockTerm.keymap.rerunLast"
  ),
  desktop(
    "app:selectLineAbove",
    ["Cmd:ArrowUp", "Cmd:PageUp"],
    { type: "previous-block" },
    "plugin.blockTerm.keymap.previousBlock"
  ),
  desktop(
    "app:selectLineBelow",
    ["Cmd:ArrowDown", "Cmd:PageDown"],
    { type: "next-block" },
    "plugin.blockTerm.keymap.nextBlock"
  ),
  desktop("app:deleteActiveLine", ["Cmd:d"], { type: "delete-selected-block" }, "plugin.blockTerm.keymap.deleteBlock"),
  desktop("app:toggleSidebar", ["Cmd:Ctrl:s"], { type: "toggle-sidebar" }, "plugin.blockTerm.keymap.toggleSidebar"),
  desktop("app:openBookmarksView", ["Cmd:b"], { type: "open-bookmarks" }, "plugin.blockTerm.keymap.openBookmarks"),
  desktop("app:openHistoryView", ["Cmd:h"], { type: "open-history" }, "plugin.blockTerm.keymap.openHistory"),
  input("cmdinput:clearInput", ["Ctrl:c"], "clear", "plugin.blockTerm.keymap.clearInput"),
  input("cmdinput:cutLineLeftOfCursor", ["Ctrl:u"], "cut-line-left", "plugin.blockTerm.keymap.cutLineLeft"),
  input("cmdinput:cutWordLeftOfCursor", ["Ctrl:w"], "cut-word-left", "plugin.blockTerm.keymap.cutWordLeft"),
  input("cmdinput:paste", ["Ctrl:y"], "paste", "plugin.blockTerm.keymap.paste"),
  input("cmdinput:previousHistoryItem", ["Ctrl:p"], "history-previous", "plugin.blockTerm.keymap.previousHistory"),
  input("cmdinput:nextHistoryItem", ["Ctrl:n"], "history-next", "plugin.blockTerm.keymap.nextHistory"),
  input(
    "generic:expandTextInput",
    ["Shift:Enter", "Ctrl:Enter"],
    "insert-newline",
    "plugin.blockTerm.keymap.insertNewline"
  ),
  input("cmdinput:expandInput", ["Cmd:e"], "toggle-expanded", "plugin.blockTerm.keymap.toggleExpanded"),
  input("cmdinput:openHistory", ["Ctrl:r"], "open-history", "plugin.blockTerm.keymap.openHistory"),
  input("generic:confirm", ["Enter"], "submit", "plugin.blockTerm.keymap.submit"),
];

const DEFINITION_BY_COMMAND = new Map<string, BlockTermKeymapCommandDefinition>();
const COMMAND_ALIASES = new Map<string, string>();
for (const definition of BLOCKTERM_KEYMAP_COMMAND_DEFINITIONS) {
  DEFINITION_BY_COMMAND.set(definition.command, definition);
  for (const alias of definition.aliases || []) COMMAND_ALIASES.set(alias, definition.command);
}

// Keep the older VibeGo names accepted while storing WaveTerm-compatible names.
for (const [alias, command] of [
  ["blockterm:new-session", "app:newTab"],
  ["blockterm:close-session", "app:closeCurrentTab"],
  ["blockterm:previous-session", "app:selectTabLeft"],
  ["blockterm:next-session", "app:selectTabRight"],
  ["blockterm:focus-input", "app:focusCmdInput"],
  ["blockterm:focus-selected-block", "app:focusSelectedLine"],
  ["blockterm:rerun-selected-command", "app:restartCommand"],
  ["blockterm:rerun-last-command", "app:restartLastCommand"],
  ["blockterm:previous-block", "app:selectLineAbove"],
  ["blockterm:next-block", "app:selectLineBelow"],
  ["blockterm:delete-selected-block", "app:deleteActiveLine"],
  ["blockterm:toggle-sidebar", "app:toggleSidebar"],
  ["blockterm:open-bookmarks", "app:openBookmarksView"],
  ["blockterm:open-history", "app:openHistoryView"],
  ["blockterm:clear-input", "cmdinput:clearInput"],
  ["blockterm:cut-line-left", "cmdinput:cutLineLeftOfCursor"],
  ["blockterm:cut-word-left", "cmdinput:cutWordLeftOfCursor"],
  ["blockterm:paste", "cmdinput:paste"],
  ["blockterm:history-previous", "cmdinput:previousHistoryItem"],
  ["blockterm:history-next", "cmdinput:nextHistoryItem"],
  ["blockterm:insert-newline", "generic:expandTextInput"],
  ["blockterm:toggle-expanded", "cmdinput:expandInput"],
  ["blockterm:open-input-history", "cmdinput:openHistory"],
  ["blockterm:submit", "generic:confirm"],
] as const) {
  COMMAND_ALIASES.set(alias, command);
}
for (let index = 1; index <= 9; index += 1) {
  COMMAND_ALIASES.set(`blockterm:select-session-${index}`, `app:selectTab-${index}`);
}

function supportsMacSessionFallback(command: string): boolean {
  return (
    command === "app:newTab" ||
    command === "app:closeCurrentTab" ||
    command === "app:selectTabLeft" ||
    command === "app:selectTabRight" ||
    /^app:selectTab-[1-9]$/u.test(command)
  );
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalCommand(command: string): string | null {
  if (DEFINITION_BY_COMMAND.has(command)) return command;
  return COMMAND_ALIASES.get(command) || null;
}

function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase();
  if (lower === "space" || key === " ") return " ";
  if (lower === "esc") return "escape";
  if (lower === "return") return "enter";
  return lower;
}

function formatKeyName(key: string): string {
  const normalized = normalizeKeyName(key);
  const names: Record<string, string> = {
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    backspace: "Backspace",
    delete: "Delete",
    end: "End",
    enter: "Enter",
    escape: "Escape",
    home: "Home",
    pagedown: "PageDown",
    pageup: "PageUp",
    tab: "Tab",
  };
  return names[normalized] || normalized;
}

function parseKeyDescriptor(source: string): ParsedKeyDescriptor | null {
  if (typeof source !== "string") return null;
  const trimmed = (source === " " ? "Space" : source.trim()).replace(/[()]/g, "");
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  let keyPart = "";
  const result: ParsedKeyDescriptor = {
    key: "",
    keyType: "key",
    cmd: false,
    option: false,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
  };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS.has(lower)) {
      if (lower === "cmd") result.cmd = true;
      else if (lower === "option") result.option = true;
      else if (lower === "ctrl") result.ctrl = true;
      else if (lower === "shift") result.shift = true;
      else if (lower === "alt") result.alt = true;
      else if (lower === "meta") result.meta = true;
      continue;
    }
    if (keyPart) return null;
    const codeMatch = /^c\{(.+)\}$/u.exec(part);
    if (codeMatch) {
      result.keyType = "code";
      result.key = codeMatch[1];
    } else {
      if (part.startsWith("c{")) return null;
      result.key = normalizeKeyName(part);
      if (part.length === 1 && /[A-Z]/u.test(part)) result.shift = true;
    }
    keyPart = part;
  }
  return result.key ? result : null;
}

export function normalizeBlockTermKeyDescriptor(source: string): string | null {
  const parsed = parseKeyDescriptor(source);
  if (!parsed) return null;
  const modifiers: string[] = [];
  if (parsed.cmd) modifiers.push("Cmd");
  if (parsed.option) modifiers.push("Option");
  if (parsed.ctrl) modifiers.push("Ctrl");
  if (parsed.alt) modifiers.push("Alt");
  if (parsed.meta) modifiers.push("Meta");
  if (parsed.shift) modifiers.push("Shift");
  const key = parsed.keyType === "code" ? `c{${parsed.key}}` : parsed.key === " " ? "Space" : formatKeyName(parsed.key);
  return [...modifiers, key].join(":");
}

function normalizeBinding(
  entry: unknown,
  diagnostics: BlockTermKeymapDiagnostic[],
  index: number
): BlockTermKeybinding | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    diagnostics.push({ kind: "invalid-entry", message: `keybinding entry ${index + 1} must be an object` });
    return null;
  }
  const value = entry as Record<string, unknown>;
  if (typeof value.command !== "string" || !value.command.trim()) {
    diagnostics.push({ kind: "invalid-entry", message: `keybinding entry ${index + 1} has no command` });
    return null;
  }
  const inputKeys = value.keys;
  if (!Array.isArray(inputKeys) || inputKeys.length > BLOCKTERM_KEYMAP_MAX_KEYS_PER_BINDING) {
    diagnostics.push({
      kind: "invalid-entry",
      command: value.command,
      message: `${value.command} keys must be an array of at most ${BLOCKTERM_KEYMAP_MAX_KEYS_PER_BINDING} items`,
    });
    return null;
  }
  const keys: string[] = [];
  for (const rawKey of inputKeys) {
    if (typeof rawKey !== "string" || rawKey.length > MAX_KEY_LENGTH) {
      diagnostics.push({
        kind: "invalid-key",
        command: value.command,
        message: `${value.command} contains an invalid key`,
      });
      continue;
    }
    const normalized = normalizeBlockTermKeyDescriptor(rawKey);
    if (!normalized) {
      diagnostics.push({
        kind: "invalid-key",
        command: value.command,
        key: rawKey,
        message: `${value.command} contains invalid key ${JSON.stringify(rawKey)}`,
      });
      continue;
    }
    if (!keys.includes(normalized)) keys.push(normalized);
  }
  const binding: BlockTermKeybinding = { command: value.command.trim(), keys };
  if (Array.isArray(value.commandStr) && value.commandStr.every((item) => typeof item === "string")) {
    binding.commandStr = value.commandStr.slice(0, 16) as string[];
  }
  if (typeof value.info === "string") binding.info = value.info.slice(0, 500);
  return binding;
}

function defaultBindings(): BlockTermKeybinding[] {
  return BLOCKTERM_KEYMAP_COMMAND_DEFINITIONS.map((definition) => ({
    command: definition.command,
    keys: [...definition.keys],
  }));
}

function actionForCommand(command: string): BlockTermKeymapAction | null {
  const definition = DEFINITION_BY_COMMAND.get(command);
  if (!definition) return null;
  return { scope: definition.scope, action: definition.action } as BlockTermKeymapAction;
}

function buildKeymap(
  userBindings: readonly BlockTermKeybinding[],
  diagnostics: BlockTermKeymapDiagnostic[]
): BlockTermKeymap {
  const merged = new Map<string, BlockTermKeybinding>();
  const userCommands = new Set<string>();
  for (const binding of defaultBindings()) merged.set(binding.command, binding);
  for (const binding of userBindings) {
    const command = canonicalCommand(binding.command);
    if (!command) {
      diagnostics.push({
        kind: "unknown-command",
        command: binding.command,
        message: `unknown keybinding command ${binding.command}`,
      });
      continue;
    }
    if (userCommands.has(command)) {
      diagnostics.push({
        kind: "duplicate-command",
        command,
        message: `${command} is configured more than once`,
      });
    }
    userCommands.add(command);
    // Aliases are accepted, but the effective representation is canonical.
    merged.set(command, { ...binding, command });
  }

  const bindings = [...merged.values()];
  const byCommand = new Map(bindings.map((binding) => [binding.command, binding]));
  const keyOwners = new Map<string, string>();
  for (const binding of bindings) {
    const definition = DEFINITION_BY_COMMAND.get(binding.command);
    if (!definition) continue;
    for (const key of binding.keys) {
      const signatures = getKeyConflictSignatures(key, supportsMacSessionFallback(binding.command));
      let conflictOwner: string | undefined;
      for (const signature of signatures) {
        const owner = keyOwners.get(`${definition.scope}:${signature}`);
        if (owner && owner !== binding.command) {
          conflictOwner = owner;
          break;
        }
      }
      if (conflictOwner) {
        diagnostics.push({
          kind: "conflict",
          command: binding.command,
          conflictsWith: conflictOwner,
          key,
          message: `${key} is also bound to ${conflictOwner}`,
        });
      }
      for (const signature of signatures) keyOwners.set(`${definition.scope}:${signature}`, binding.command);
    }
  }
  return { bindings, byCommand, diagnostics };
}

export function parseBlockTermKeymapConfig(value: string | null | undefined): BlockTermKeymapParseResult {
  const diagnostics: BlockTermKeymapDiagnostic[] = [];
  let parsed: unknown = [];
  let valid = true;
  if (value && value.trim()) {
    if (utf8Size(value) > MAX_CONFIG_BYTES) {
      diagnostics.push({
        kind: "invalid-config",
        message: `keybindings configuration is too large (max ${MAX_CONFIG_BYTES} bytes)`,
      });
      valid = false;
    } else {
      try {
        parsed = JSON.parse(value);
      } catch {
        diagnostics.push({ kind: "invalid-config", message: "keybindings configuration must be valid JSON" });
        valid = false;
      }
    }
  }
  if (!Array.isArray(parsed)) {
    diagnostics.push({ kind: "invalid-config", message: "keybindings configuration must be an array" });
    valid = false;
    parsed = [];
  }
  const userBindings: BlockTermKeybinding[] = [];
  if (Array.isArray(parsed)) {
    if (parsed.length > MAX_BINDINGS) {
      diagnostics.push({
        kind: "invalid-config",
        message: `keybindings configuration has more than ${MAX_BINDINGS} entries`,
      });
      valid = false;
    }
    for (const [index, entry] of parsed.slice(0, MAX_BINDINGS).entries()) {
      const normalized = normalizeBinding(entry, diagnostics, index);
      if (normalized) userBindings.push(normalized);
    }
  }
  const candidateKeymap = buildKeymap(userBindings, diagnostics);
  const configValid = valid && !diagnostics.some(isFatalBlockTermKeymapDiagnostic);
  return {
    keymap: configValid ? candidateKeymap : buildKeymap([], []),
    userBindings,
    diagnostics,
    valid: configValid,
  };
}

export function serializeBlockTermKeymapBindings(bindings: readonly BlockTermKeybinding[]): string {
  return JSON.stringify(
    bindings.map((binding) => ({
      command: binding.command,
      keys: binding.keys.map((key) => normalizeBlockTermKeyDescriptor(key) || key),
      ...(binding.commandStr ? { commandStr: binding.commandStr } : {}),
      ...(binding.info ? { info: binding.info } : {}),
    }))
  );
}

export function serializeBlockTermKeymapOverrides(bindings: readonly BlockTermKeybinding[]): string {
  return serializeBlockTermKeymapBindings(createBlockTermKeymapOverrides(bindings));
}

function codeToLogicalKey(code: string): string {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Semicolon") return ";";
  if (code === "Quote") return "'";
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  if (code === "Minus") return "-";
  if (code === "Equal") return "=";
  if (code === "Backquote") return "`";
  if (code === "Space") return " ";
  return code.toLowerCase();
}

export function getBlockTermKeyDescriptorFromEvent(
  event: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  options: { macPlatform?: boolean; keyType?: "key" | "code" } = {}
): string | null {
  if (["control", "meta", "alt", "shift"].includes(event.key.toLowerCase())) return null;
  const modifiers: string[] = [];
  if (options.macPlatform) {
    if (event.metaKey) modifiers.push("Cmd");
    if (event.altKey) modifiers.push("Option");
  } else {
    if (event.altKey) modifiers.push("Cmd");
    if (event.metaKey) modifiers.push("Option");
  }
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.shiftKey) modifiers.push("Shift");
  if (options.keyType === "code") {
    if (!event.code) return null;
    return normalizeBlockTermKeyDescriptor([...modifiers, `c{${event.code}}`].join(":"));
  }
  const codeKey = event.code ? codeToLogicalKey(event.code) : "";
  const alteredMacOptionKey =
    options.macPlatform && event.altKey && event.key.length === 1 && Boolean(event.code) && event.key !== codeKey;
  if (alteredMacOptionKey) {
    return normalizeBlockTermKeyDescriptor([...modifiers, `c{${event.code}}`].join(":"));
  }
  const key = normalizeKeyName(event.key);
  const logicalDescriptor = normalizeBlockTermKeyDescriptor([...modifiers, key === " " ? "Space" : key].join(":"));
  if (logicalDescriptor || !event.code) return logicalDescriptor;
  return normalizeBlockTermKeyDescriptor([...modifiers, `c{${event.code}}`].join(":"));
}

function eventKey(
  event: { key: string; code?: string },
  descriptor: ParsedKeyDescriptor,
  useCodeFallback: boolean
): string {
  if (descriptor.keyType === "code") return (event.code || "").toLowerCase();
  if (useCodeFallback && event.code && descriptor.key.length === 1) return codeToLogicalKey(event.code);
  return normalizeKeyName(event.key || "");
}

export interface BlockTermKeymapMatchOptions {
  scope: BlockTermKeymapScope;
  portableCommand?: boolean;
  allowCodeFallback?: boolean;
  allowMacSessionFallback?: boolean;
  macPlatform?: boolean;
}

function modifiersMatchOnPlatform(
  event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  descriptor: ParsedKeyDescriptor,
  macPlatform: boolean
): boolean {
  const command = macPlatform ? event.metaKey : event.altKey;
  const option = macPlatform ? event.altKey : event.metaKey;
  if (!descriptor.alt && descriptor.option !== option) return false;
  if (!descriptor.meta && descriptor.cmd !== command) return false;
  if (descriptor.shift !== event.shiftKey || descriptor.ctrl !== event.ctrlKey) return false;
  if (descriptor.alt && !event.altKey) return false;
  if (descriptor.meta && !event.metaKey) return false;
  return true;
}

function modifiersMatchEvent(
  event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  descriptor: ParsedKeyDescriptor,
  portableCommand: boolean,
  macPlatform?: boolean
): boolean {
  if (macPlatform !== undefined) return modifiersMatchOnPlatform(event, descriptor, macPlatform);
  if (modifiersMatchOnPlatform(event, descriptor, true)) return true;
  return portableCommand && modifiersMatchOnPlatform(event, descriptor, false);
}

function isBareCmdDescriptor(descriptor: ParsedKeyDescriptor): boolean {
  return (
    descriptor.cmd && !descriptor.option && !descriptor.ctrl && !descriptor.shift && !descriptor.alt && !descriptor.meta
  );
}

function logicalKeyToPhysicalCode(key: string): string | null {
  const normalized = normalizeKeyName(key);
  if (/^[a-z]$/u.test(normalized)) return `key${normalized}`;
  if (/^[0-9]$/u.test(normalized)) return `digit${normalized}`;
  const codes: Record<string, string> = {
    "[": "bracketleft",
    "]": "bracketright",
    ";": "semicolon",
    "'": "quote",
    ",": "comma",
    ".": "period",
    "/": "slash",
    "\\": "backslash",
    "-": "minus",
    "=": "equal",
    "`": "backquote",
    " ": "space",
  };
  return codes[normalized] || (/^[a-z][a-z0-9]*$/u.test(normalized) ? normalized : null);
}

function getMacSessionFallbackConflictSignatures(descriptor: ParsedKeyDescriptor): string[] {
  if (!isBareCmdDescriptor(descriptor)) return [];
  const logicalKey =
    descriptor.keyType === "code" ? codeToLogicalKey(descriptor.key) : normalizeKeyName(descriptor.key);
  const physicalCode =
    descriptor.keyType === "code" ? descriptor.key.toLowerCase() : logicalKeyToPhysicalCode(descriptor.key);
  if (descriptor.keyType === "key" && descriptor.key.length === 1 && !physicalCode) return [];
  return [`1100:key:${logicalKey}`, ...(physicalCode ? [`1100:code:${physicalCode}`] : [])];
}

function getKeyConflictSignatures(source: string, allowMacSessionFallback = false): string[] {
  const descriptor = parseKeyDescriptor(source);
  if (!descriptor) return [];
  const key = `${descriptor.keyType}:${descriptor.key.toLowerCase()}`;
  const signatures: string[] = [];
  for (const ctrlKey of [false, true]) {
    for (const shiftKey of [false, true]) {
      for (const metaKey of [false, true]) {
        for (const altKey of [false, true]) {
          if (!modifiersMatchEvent({ ctrlKey, shiftKey, metaKey, altKey }, descriptor, true)) continue;
          signatures.push(`${Number(ctrlKey)}${Number(shiftKey)}${Number(metaKey)}${Number(altKey)}:${key}`);
        }
      }
    }
  }
  if (allowMacSessionFallback) signatures.push(...getMacSessionFallbackConflictSignatures(descriptor));
  return [...new Set(signatures)];
}

export function keyDescriptorMatchesEvent(
  event: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  source: string,
  options: Pick<
    BlockTermKeymapMatchOptions,
    "portableCommand" | "allowCodeFallback" | "allowMacSessionFallback" | "macPlatform"
  > = {}
): boolean {
  const descriptor = parseKeyDescriptor(source);
  if (!descriptor) return false;
  const portableCommand = options.portableCommand !== false;
  const macFallback =
    Boolean(options.allowMacSessionFallback) &&
    isBareCmdDescriptor(descriptor) &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.altKey &&
    Boolean(event.code);
  if (!macFallback && !modifiersMatchEvent(event, descriptor, portableCommand, options.macPlatform)) return false;
  const actual = eventKey(
    event,
    descriptor,
    Boolean(
      (macFallback ||
        (options.allowCodeFallback && descriptor.cmd && event.altKey && !event.metaKey && !descriptor.option)) &&
        event.code
    )
  );
  const expected = descriptor.keyType === "code" ? descriptor.key.toLowerCase() : normalizeKeyName(descriptor.key);
  return actual === expected;
}

export function resolveBlockTermKeymapAction(
  event: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  keymap: BlockTermKeymap,
  options: BlockTermKeymapMatchOptions
): BlockTermKeymapAction | null {
  const matches: Array<{ action: BlockTermKeymapAction; order: number }> = [];
  keymap.bindings.forEach((binding, order) => {
    const definition = DEFINITION_BY_COMMAND.get(binding.command);
    if (!definition || definition.scope !== options.scope) return;
    const allowMacFallbackForBinding =
      options.allowMacSessionFallback && definition.scope === "desktop" && supportsMacSessionFallback(binding.command);
    if (
      binding.keys.some((key) =>
        keyDescriptorMatchesEvent(event, key, {
          ...options,
          allowMacSessionFallback: allowMacFallbackForBinding,
        })
      )
    ) {
      const action = actionForCommand(binding.command);
      if (action) matches.push({ action, order });
    }
  });
  return matches.length > 0 ? matches[matches.length - 1].action : null;
}

export function getBlockTermKeymapDefinition(command: string): BlockTermKeymapCommandDefinition | null {
  const canonical = canonicalCommand(command);
  return canonical ? DEFINITION_BY_COMMAND.get(canonical) || null : null;
}

export function getBlockTermKeymapDisplayBindings(
  keymap: BlockTermKeymap,
  scope?: BlockTermKeymapScope
): BlockTermKeybinding[] {
  return keymap.bindings
    .filter((binding) => {
      const definition = DEFINITION_BY_COMMAND.get(binding.command);
      return !scope || definition?.scope === scope;
    })
    .map((binding) => ({ ...binding, keys: [...binding.keys] }));
}

export function getBlockTermKeymapDefaults(): BlockTermKeybinding[] {
  return defaultBindings();
}

export function isFatalBlockTermKeymapDiagnostic(diagnostic: BlockTermKeymapDiagnostic): boolean {
  return diagnostic.kind !== "conflict";
}

export function createBlockTermKeymapOverrides(bindings: readonly BlockTermKeybinding[]): BlockTermKeybinding[] {
  const defaults = new Map(defaultBindings().map((binding) => [binding.command, binding.keys]));
  const overrides: BlockTermKeybinding[] = [];
  for (const binding of bindings) {
    const command = canonicalCommand(binding.command);
    if (!command) continue;
    const keys = binding.keys
      .map((key) => normalizeBlockTermKeyDescriptor(key))
      .filter((key): key is string => !!key)
      .filter((key, index, all) => all.indexOf(key) === index);
    const defaultKeys = defaults.get(command) || [];
    if (keys.length === defaultKeys.length && keys.every((key) => defaultKeys.includes(key))) continue;
    overrides.push({ command, keys });
  }
  return overrides;
}
