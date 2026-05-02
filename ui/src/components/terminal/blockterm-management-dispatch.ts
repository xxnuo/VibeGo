// Copyright 2026, VibeGo contributors
// SPDX-License-Identifier: Apache-2.0

import type { BlockTermManagementCommandResult } from "./blockterm-management.ts";
import type {
  BlockStatus,
  BlockTermBlock,
  BlockTermConnectionContext,
  BlockTermRuntimeType,
} from "./blockterm-model.ts";
import { setBlockTermPresentationHeight } from "./blockterm-model.ts";
import { type BlockTermRendererSelection, resolveBlockTermRendererSwitch } from "./blockterm-renderer-registry.ts";
import {
  BLOCKTERM_TAB_COLORS,
  BLOCKTERM_TAB_ICONS,
  type BlockTermTabColor,
  type BlockTermTabIcon,
} from "./blockterm-session-settings.ts";
import type { BlockTermViewState } from "./blockterm-sidebar.ts";

export type BlockTermManagementDispatchBlock = Pick<
  BlockTermBlock,
  | "id"
  | "terminalId"
  | "lineNum"
  | "kind"
  | "command"
  | "runtimeType"
  | "status"
  | "archived"
  | "pinned"
  | "starred"
  | "collapsed"
  | "renderer"
  | "stateJson"
  | "presentationJson"
>;

/** Exact ownership proof for a command block whose PTY is independent of the
 * screen's parent runtime. The scope generation fences queued management
 * actions from a later workspace restore. */
export interface BlockTermManagementIndependentBinding {
  sessionId: string;
  blockId: string;
  blockToken: string;
  scopeGeneration?: number;
}

export interface BlockTermManagementResizeTarget {
  blockId: string;
  blockToken: string;
  scopeGeneration?: number;
}

export interface BlockTermManagementDispatchSession {
  id: string;
  name: string;
  tabColor?: string;
  tabIcon?: string;
  cwd: string;
  runtimeType: BlockTermRuntimeType;
  sshProfileId?: string;
  cols: number;
  rows: number;
  status: "connecting" | "ready" | "running" | "exited" | "closed";
}

export interface BlockTermManagementScreenSummary extends BlockTermManagementDispatchSession {
  index: number;
}

export interface BlockTermManagementScreenSettingsPatch {
  name?: string;
  tabColor?: string;
  tabIcon?: string;
}

export interface BlockTermManagementDispatchSnapshot {
  sessionId: string;
  /** Runtime scope generation captured with the snapshot, when available. */
  scopeGeneration?: number;
  /** Required for actions that can mutate or leave the current terminal tab. */
  workspaceSessionId?: string | null;
  /** Required for tab inventory mutations and cross-workspace navigation. */
  groupId?: string;
  /** Root BlockTerm terminal tabs in their durable display order. */
  sessions?: readonly BlockTermManagementDispatchSession[];
  sessionStatus: "connecting" | "ready" | "running" | "exited" | "closed";
  activeBlockId: string | null;
  selectedBlockId: string | null;
  blocks: readonly BlockTermManagementDispatchBlock[];
  /** Live independent child owners in this exact screen/scope. */
  independentBindings?: readonly BlockTermManagementIndependentBinding[];
  view: BlockTermViewState;
}

export type BlockTermManagementSignal = "INT" | "TERM" | "KILL";

export type BlockTermManagementDispatchAction =
  | {
      kind: "set-connection";
      sessionId: string;
      runtimeType: BlockTermRuntimeType;
      sshProfileId?: string;
    }
  | { kind: "open-connection-selector"; sessionId: string }
  | { kind: "delete-blocks"; sessionId: string; blockIds: string[] }
  | { kind: "archive-blocks"; sessionId: string; blockIds: string[] }
  | { kind: "signal"; sessionId: string; blockId: string; signal: BlockTermManagementSignal }
  | { kind: "focus-block"; sessionId: string; blockId: string }
  | {
      kind: "update-block";
      sessionId: string;
      blockId: string;
      patch: Partial<
        Pick<BlockTermBlock, "starred" | "pinned" | "archived" | "collapsed" | "stateJson" | "presentationJson">
      >;
    }
  | { kind: "restart-block"; sessionId: string; blockId: string }
  | { kind: "open-bookmark"; sessionId: string; blockId: string; command: string }
  | { kind: "switch-renderer"; sessionId: string; blockId: string; renderer: BlockTermRendererSelection }
  | { kind: "update-view"; sessionId: string; patch: { sidebar: Partial<BlockTermViewState["sidebar"]> } }
  | {
      kind: "create-screen";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      name?: string;
      activate: boolean;
    }
  | {
      kind: "select-screen";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
    }
  | {
      kind: "delete-screen";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
    }
  | {
      kind: "update-screen-settings";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
      settings: { name?: string; tabColor?: BlockTermTabColor; tabIcon?: BlockTermTabIcon };
    }
  | {
      kind: "reorder-screen";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
      targetIndex: number;
      anchorSessionId: string;
    }
  | {
      kind: "set-screen-view";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
      selectedBlockId?: string;
      anchorBlockId?: string;
      anchorOffset?: number;
      focus?: "input" | "command";
    }
  | {
      kind: "show-screen-info";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      screen: BlockTermManagementScreenSummary;
    }
  | {
      kind: "show-screen-list";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      screens: BlockTermManagementScreenSummary[];
    }
  | {
      kind: "resize-screen";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
      cols: number;
      rows: number;
      /** Independent command PTYs selected by include=/exclude=. */
      childTargets?: BlockTermManagementResizeTarget[];
    }
  | {
      kind: "reset-session-runtime";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
      shell?: string;
      verbose: boolean;
    }
  | {
      kind: "sync-session-state";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
      command: ":";
    }
  | {
      kind: "reset-session-cwd";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      targetSessionId: string;
      command: "cd ~";
    }
  | {
      kind: "view-line";
      sessionId: string;
      workspaceSessionId: string;
      groupId: string;
      workspaceRef: string;
      screenRef: string;
      lineRef: string;
    };

export interface BlockTermManagementDispatchPlan {
  kind: "plan";
  commandName: string;
  actions: BlockTermManagementDispatchAction[];
}

export interface BlockTermManagementDispatchNotApplicable {
  kind: "not-applicable";
  commandName?: string;
}

export type BlockTermManagementDispatchErrorCode =
  | "parser-error"
  | "unsupported"
  | "invalid-arguments"
  | "missing-scope"
  | "unknown-screen"
  | "session-busy"
  | "unknown-line"
  | "no-selected-line"
  | "not-active-line"
  | "invalid-signal"
  | "invalid-value";

export interface BlockTermManagementDispatchError {
  kind: "error";
  commandName?: string;
  code: BlockTermManagementDispatchErrorCode;
  message: string;
}

export type BlockTermManagementDispatchResult =
  | BlockTermManagementDispatchPlan
  | BlockTermManagementDispatchNotApplicable
  | BlockTermManagementDispatchError;

type TargetResolution =
  | { ok: true; block: BlockTermManagementDispatchBlock; nextArg: number }
  | { ok: false; error: BlockTermManagementDispatchError };

type ScreenScopeResolution =
  | {
      ok: true;
      workspaceSessionId: string;
      groupId: string;
      sessions: readonly BlockTermManagementDispatchSession[];
      current: BlockTermManagementDispatchSession;
    }
  | { ok: false; error: BlockTermManagementDispatchError };

type ScreenResolution =
  | { ok: true; screen: BlockTermManagementDispatchSession; index: number }
  | { ok: false; error: BlockTermManagementDispatchError };

const ACTIVE_BLOCK_STATUSES = new Set<BlockStatus>(["running"]);
const ACTIVE_OR_STREAMING_BLOCK_STATUSES = new Set<BlockStatus>(["running", "streaming"]);
const BLOCKTERM_TAB_COLOR_SET = new Set<string>(BLOCKTERM_TAB_COLORS);
const BLOCKTERM_TAB_ICON_SET = new Set<string>(BLOCKTERM_TAB_ICONS);
const MAX_TERMINAL_NAME_LENGTH = 50;
const MAX_LINE_STATE_BYTES = 4 * 1024;
const MIN_TERMINAL_COLS = 10;
const MAX_TERMINAL_COLS = 1024;
const textEncoder = new TextEncoder();

function bindingMatchesSnapshot(
  snapshot: BlockTermManagementDispatchSnapshot,
  block: BlockTermManagementDispatchBlock,
  binding: BlockTermManagementIndependentBinding
): boolean {
  if (
    binding.sessionId !== snapshot.sessionId ||
    binding.blockId !== block.id ||
    !binding.blockToken.trim() ||
    (block.terminalId !== undefined && block.terminalId !== snapshot.sessionId)
  ) {
    return false;
  }
  // Older callers may omit the generation on both sides. When either side
  // supplies one, require an exact match instead of guessing ownership.
  if (snapshot.scopeGeneration !== undefined || binding.scopeGeneration !== undefined) {
    return snapshot.scopeGeneration !== undefined && binding.scopeGeneration === snapshot.scopeGeneration;
  }
  return true;
}

/** Returns whether a block is backed by a current independent child owner. */
export function isBlockTermManagementIndependentBlock(
  snapshot: BlockTermManagementDispatchSnapshot,
  block: BlockTermManagementDispatchBlock
): boolean {
  if (block.kind !== "command" || block.archived || !ACTIVE_OR_STREAMING_BLOCK_STATUSES.has(block.status)) return false;
  return (snapshot.independentBindings || []).some((binding) => bindingMatchesSnapshot(snapshot, block, binding));
}

function getIndependentBinding(
  snapshot: BlockTermManagementDispatchSnapshot,
  block: BlockTermManagementDispatchBlock
): BlockTermManagementIndependentBinding | null {
  return (
    (snapshot.independentBindings || []).find((binding) => bindingMatchesSnapshot(snapshot, block, binding)) || null
  );
}

function parseResizeReferences(
  commandName: string,
  key: "include" | "exclude",
  value: string,
  snapshot: BlockTermManagementDispatchSnapshot
): Set<string> | BlockTermManagementDispatchError {
  const references = value.split(",").map((item) => item.trim());
  if (references.length === 0 || references.some((reference) => !reference)) {
    return dispatchError(commandName, "invalid-value", `/screen:resize ${key}= must contain line or block references`);
  }
  const blockIds = new Set<string>();
  for (const reference of references) {
    const block = findBlockByReference(snapshot, reference);
    if (!block) {
      return dispatchError(commandName, "unknown-line", `/screen:resize cannot find ${key} line '${reference}'`);
    }
    blockIds.add(block.id);
  }
  return blockIds;
}

function connectionContext(runtimeType: BlockTermRuntimeType, sshProfileId?: string): BlockTermConnectionContext {
  const profile = sshProfileId?.trim();
  return runtimeType === "ssh" && profile ? { runtimeType, sshProfileId: profile } : { runtimeType };
}

export function buildBlockTermManagementScreenSettingsPatch(
  settings: Extract<BlockTermManagementDispatchAction, { kind: "update-screen-settings" }>["settings"]
): BlockTermManagementScreenSettingsPatch {
  return {
    ...(settings.name !== undefined ? { name: settings.name } : {}),
    ...(settings.tabColor !== undefined ? { tabColor: settings.tabColor === "default" ? "" : settings.tabColor } : {}),
    ...(settings.tabIcon !== undefined ? { tabIcon: settings.tabIcon === "default" ? "" : settings.tabIcon } : {}),
  };
}

export function resolveBlockTermManagementScreenReorderAnchor(
  sessions: readonly Pick<BlockTermManagementDispatchSession, "id">[],
  targetIndex: number
): string | null {
  return sessions[targetIndex - 1]?.id ?? null;
}

function isProtectedFromDeletion(
  block: BlockTermManagementDispatchBlock,
  snapshot: BlockTermManagementDispatchSnapshot
): boolean {
  return block.id === snapshot.activeBlockId || block.status === "running" || block.status === "streaming";
}

function dispatchError(
  commandName: string | undefined,
  code: BlockTermManagementDispatchErrorCode,
  message: string
): BlockTermManagementDispatchError {
  return { kind: "error", ...(commandName ? { commandName } : {}), code, message };
}

function plan(commandName: string, ...actions: BlockTermManagementDispatchAction[]): BlockTermManagementDispatchPlan {
  return { kind: "plan", commandName, actions };
}

function hasOnlyKwargs(
  commandName: string,
  kwargs: Record<string, string>,
  supported: readonly string[]
): BlockTermManagementDispatchError | null {
  const unknown = Object.keys(kwargs).find((key) => !supported.includes(key));
  return unknown ? dispatchError(commandName, "unsupported", `/${commandName} does not support '${unknown}='`) : null;
}

function parseBoolean(value: string): boolean | null {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return null;
  }
}

function parseStarValue(value: string): boolean | null {
  const boolean = parseBoolean(value);
  if (boolean !== null) return boolean;
  if (!/^(?:0|[1-5])$/u.test(value.trim())) return null;
  return Number(value) > 0;
}

function parseSignal(value: string): BlockTermManagementSignal | null {
  const normalized = value.trim().toUpperCase();
  if (normalized === "INT" || normalized === "SIGINT" || normalized === "2") return "INT";
  if (normalized === "TERM" || normalized === "SIGTERM" || normalized === "15") return "TERM";
  if (normalized === "KILL" || normalized === "SIGKILL" || normalized === "9") return "KILL";
  return null;
}

function parseSidebarWidth(value: string): string | null {
  const match = /^([1-9][0-9]{0,3})(px|%)$/u.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (match[2] === "%") return amount >= 10 && amount <= 90 ? `${amount}%` : null;
  return amount >= 200 && amount <= 4000 ? `${amount}px` : null;
}

function requireScreenScope(commandName: string, snapshot: BlockTermManagementDispatchSnapshot): ScreenScopeResolution {
  const workspaceSessionId = snapshot.workspaceSessionId?.trim();
  const groupId = snapshot.groupId?.trim();
  const sessions = snapshot.sessions;
  if (!workspaceSessionId || !groupId || !sessions) {
    return {
      ok: false,
      error: dispatchError(
        commandName,
        "missing-scope",
        `/${commandName} requires the current workspace, terminal group, and ordered screen inventory`
      ),
    };
  }
  const current = sessions.find((session) => session.id === snapshot.sessionId);
  if (!current) {
    return {
      ok: false,
      error: dispatchError(commandName, "unknown-screen", `/${commandName} current screen is no longer available`),
    };
  }
  return { ok: true, workspaceSessionId, groupId, sessions, current };
}

function summarizeScreen(screen: BlockTermManagementDispatchSession, index: number): BlockTermManagementScreenSummary {
  return { ...screen, index: index + 1 };
}

function resolveScreenReference(
  commandName: string,
  reference: string,
  sessions: readonly BlockTermManagementDispatchSession[]
): ScreenResolution {
  if (/^[1-9][0-9]*$/u.test(reference)) {
    const index = Number(reference) - 1;
    if (Number.isSafeInteger(index) && sessions[index]) return { ok: true, screen: sessions[index], index };
  }
  const idIndex = sessions.findIndex((session) => session.id === reference);
  if (idIndex >= 0) return { ok: true, screen: sessions[idIndex], index: idIndex };

  const exactNameMatches = sessions
    .map((screen, index) => ({ screen, index }))
    .filter(({ screen }) => screen.name === reference);
  if (exactNameMatches.length === 1) return { ok: true, ...exactNameMatches[0] };
  if (exactNameMatches.length > 1) {
    return {
      ok: false,
      error: dispatchError(commandName, "unknown-screen", `/${commandName} screen name '${reference}' is ambiguous`),
    };
  }

  const prefixMatches = sessions
    .map((screen, index) => ({ screen, index }))
    .filter(({ screen }) => screen.name.startsWith(reference));
  if (prefixMatches.length === 1) return { ok: true, ...prefixMatches[0] };
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      error: dispatchError(commandName, "unknown-screen", `/${commandName} screen prefix '${reference}' is ambiguous`),
    };
  }
  return {
    ok: false,
    error: dispatchError(commandName, "unknown-screen", `/${commandName} cannot find screen '${reference}'`),
  };
}

function parseScreenIndex(
  commandName: string,
  value: string | undefined,
  sessions: readonly BlockTermManagementDispatchSession[]
): number | BlockTermManagementDispatchError {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value.trim())) {
    return dispatchError(commandName, "invalid-value", `/${commandName} requires a positive 1-based index=`);
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index > sessions.length) {
    return dispatchError(
      commandName,
      "invalid-value",
      `/${commandName} index must be between 1 and ${sessions.length}`
    );
  }
  return index;
}

function normalizeTerminalName(commandName: string, value: string): string | BlockTermManagementDispatchError {
  const name = value.trim();
  if (!name) return dispatchError(commandName, "invalid-value", `/${commandName} name cannot be empty`);
  if ([...name].length > MAX_TERMINAL_NAME_LENGTH) {
    return dispatchError(
      commandName,
      "invalid-value",
      `/${commandName} name must be at most ${MAX_TERMINAL_NAME_LENGTH} characters`
    );
  }
  return name;
}

function normalizeTabColor(commandName: string, value: string): BlockTermTabColor | BlockTermManagementDispatchError {
  const color = value.trim();
  return BLOCKTERM_TAB_COLOR_SET.has(color)
    ? (color as BlockTermTabColor)
    : dispatchError(commandName, "invalid-value", `/${commandName} has an invalid tabcolor=`);
}

function normalizeTabIcon(commandName: string, value: string): BlockTermTabIcon | BlockTermManagementDispatchError {
  const icon = value.trim();
  return BLOCKTERM_TAB_ICON_SET.has(icon)
    ? (icon as BlockTermTabIcon)
    : dispatchError(commandName, "invalid-value", `/${commandName} has an invalid tabicon=`);
}

function requireIdleSession(
  commandName: string,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchError | null {
  return snapshot.sessionStatus === "ready" && snapshot.activeBlockId === null
    ? null
    : dispatchError(commandName, "session-busy", `/${commandName} requires an idle, ready terminal`);
}

function findBlockByReference(
  snapshot: BlockTermManagementDispatchSnapshot,
  reference: string
): BlockTermManagementDispatchBlock | null {
  const byId = snapshot.blocks.find((block) => block.id === reference);
  if (byId) return byId;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(reference)) return null;
  const lineNum = Number(reference);
  if (!Number.isSafeInteger(lineNum)) return null;
  return snapshot.blocks.find((block) => block.lineNum === lineNum) || null;
}

function selectedBlock(snapshot: BlockTermManagementDispatchSnapshot): BlockTermManagementDispatchBlock | null {
  if (!snapshot.selectedBlockId) return null;
  return snapshot.blocks.find((block) => block.id === snapshot.selectedBlockId) || null;
}

function resolveTarget(
  commandName: string,
  snapshot: BlockTermManagementDispatchSnapshot,
  args: readonly string[],
  allowDefault: boolean,
  allowValueFirst: (value: string) => boolean = () => false
): TargetResolution {
  const firstArg = args[0];
  if (firstArg !== undefined) {
    const block = findBlockByReference(snapshot, firstArg);
    if (block) return { ok: true, block, nextArg: 1 };
    if (!allowDefault || !allowValueFirst(firstArg)) {
      return {
        ok: false,
        error: dispatchError(commandName, "unknown-line", `/${commandName} cannot find line '${firstArg}'`),
      };
    }
  }
  const block = selectedBlock(snapshot);
  if (!block) {
    return {
      ok: false,
      error: dispatchError(commandName, "no-selected-line", `/${commandName} requires a line or selected line`),
    };
  }
  return { ok: true, block, nextArg: 0 };
}

function parseLineBoolean(
  commandName: string,
  args: readonly string[],
  nextArg: number,
  defaultValue: boolean
): boolean | BlockTermManagementDispatchError {
  if (args.length === nextArg) return defaultValue;
  if (args.length !== nextArg + 1) {
    return dispatchError(commandName, "invalid-arguments", `/${commandName} accepts a line and one boolean value`);
  }
  const value = parseBoolean(args[nextArg]);
  return value === null
    ? dispatchError(commandName, "invalid-value", `/${commandName} requires a boolean value`)
    : value;
}

function requireNoArgs(commandName: string, args: readonly string[]): BlockTermManagementDispatchError | null {
  return args.length > 0
    ? dispatchError(commandName, "invalid-arguments", `/${commandName} does not accept positional arguments`)
    : null;
}

/**
 * `/connect` changes the connection context used by subsequently-created
 * blocks. It deliberately does not mutate the parent PTY or existing blocks.
 * A bare command is represented as a selector action so the page can reuse the
 * SSH profile dialog without making the pure dispatcher depend on network I/O.
 */
function planConnect(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const kwargError = hasOnlyKwargs(commandName, kwargs, ["runtime", "type", "profile", "profile_id", "ssh_profile_id"]);
  if (kwargError) return kwargError;
  if (args.length > 2) {
    return dispatchError(commandName, "invalid-arguments", "/connect accepts a runtime and optional SSH profile");
  }

  const runtimeKwarg = (kwargs.runtime ?? kwargs.type)?.trim().toLowerCase();
  const profileKwarg = (kwargs.ssh_profile_id ?? kwargs.profile_id ?? kwargs.profile)?.trim();
  const first = args[0]?.trim();
  const second = args[1]?.trim();
  if (args.some((value) => !value.trim())) {
    return dispatchError(commandName, "invalid-value", "/connect values cannot be empty");
  }

  let runtimeType: BlockTermRuntimeType | undefined;
  let profileId = profileKwarg;
  if (first?.toLowerCase() === "local") {
    runtimeType = "local";
    if (second) {
      return dispatchError(commandName, "invalid-arguments", "/connect local does not accept an SSH profile");
    }
  } else if (first?.toLowerCase() === "ssh") {
    runtimeType = "ssh";
    if (second) {
      if (profileId && profileId !== second) {
        return dispatchError(commandName, "invalid-arguments", "/connect has conflicting SSH profile values");
      }
      profileId = second;
    }
  } else if (first) {
    // WaveTerm accepts a remote name as the connection operand. In BlockTerm
    // that operand is an SSH profile id (profile names can still be selected by
    // the dialog), so preserve it verbatim for backend/profile validation.
    runtimeType = "ssh";
    if (second) {
      return dispatchError(commandName, "invalid-arguments", "/connect accepts one SSH profile");
    }
    if (profileId && profileId !== first) {
      return dispatchError(commandName, "invalid-arguments", "/connect has conflicting SSH profile values");
    }
    profileId = first;
  }

  if (runtimeKwarg) {
    if (runtimeKwarg !== "local" && runtimeKwarg !== "ssh") {
      return dispatchError(commandName, "invalid-value", "/connect runtime must be local or ssh");
    }
    if (runtimeType && runtimeType !== runtimeKwarg) {
      return dispatchError(commandName, "invalid-arguments", "/connect has conflicting runtime values");
    }
    runtimeType = runtimeKwarg;
  }

  if (runtimeType === undefined && profileId) runtimeType = "ssh";
  if (runtimeType === "local" && profileId) {
    return dispatchError(commandName, "invalid-value", "/connect local cannot include ssh_profile_id");
  }
  if (runtimeType === "ssh" && !profileId) {
    return dispatchError(commandName, "invalid-value", "/connect ssh requires an SSH profile id");
  }
  if (runtimeType === undefined) {
    return plan(commandName, { kind: "open-connection-selector", sessionId: snapshot.sessionId });
  }
  const context = connectionContext(runtimeType, profileId);
  return plan(commandName, {
    kind: "set-connection",
    sessionId: snapshot.sessionId,
    runtimeType: context.runtimeType,
    ...(context.sshProfileId ? { sshProfileId: context.sshProfileId } : {}),
  });
}

function planClear(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, ["archive"]);
  if (kwargError) return kwargError;
  const archive = kwargs.archive === undefined ? false : parseBoolean(kwargs.archive);
  if (archive === null) return dispatchError(commandName, "invalid-value", "/clear archive must be a boolean");
  const blockIds = snapshot.blocks
    .filter((block) => !isProtectedFromDeletion(block, snapshot))
    .map((block) => block.id);
  return archive
    ? plan(commandName, { kind: "archive-blocks", sessionId: snapshot.sessionId, blockIds })
    : plan(commandName, { kind: "delete-blocks", sessionId: snapshot.sessionId, blockIds });
}

function planSignal(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const kwargError = hasOnlyKwargs(commandName, kwargs, []);
  if (kwargError) return kwargError;
  if (args.length === 0 || args.length > 2) {
    return dispatchError(commandName, "invalid-arguments", "/signal requires a signal and optional line");
  }
  const target = resolveTarget(commandName, snapshot, args, true, (value) => /^[A-Za-z]+$/u.test(value));
  if (!target.ok) return target.error;
  if (args.length !== target.nextArg + 1) {
    return dispatchError(commandName, "invalid-arguments", "/signal requires exactly one signal");
  }
  const signal = parseSignal(args[target.nextArg]);
  if (!signal)
    return dispatchError(commandName, "invalid-signal", "/signal supports INT, TERM, KILL, or SIG equivalents");
  if (
    target.block.id !== snapshot.activeBlockId ||
    target.block.kind !== "command" ||
    !ACTIVE_BLOCK_STATUSES.has(target.block.status)
  ) {
    return dispatchError(commandName, "not-active-line", "/signal only applies to the current active command block");
  }
  if (target.block.runtimeType === "ssh" && signal !== "INT") {
    return dispatchError(commandName, "invalid-signal", "/signal supports only INT for SSH command blocks");
  }
  return plan(commandName, { kind: "signal", sessionId: snapshot.sessionId, blockId: target.block.id, signal });
}

function planResetCommand(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, ["shell", "verbose"]);
  if (kwargError) return kwargError;
  const idleError = requireIdleSession(commandName, snapshot);
  if (idleError) return idleError;
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  const verbose = kwargs.verbose === undefined ? false : parseBoolean(kwargs.verbose);
  if (verbose === null) return dispatchError(commandName, "invalid-value", "/reset verbose must be a boolean");
  const shell = kwargs.shell?.trim();
  if (kwargs.shell !== undefined && !shell) {
    return dispatchError(commandName, "invalid-value", "/reset shell cannot be empty");
  }
  return plan(commandName, {
    kind: "reset-session-runtime",
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    targetSessionId: snapshot.sessionId,
    ...(shell ? { shell } : {}),
    verbose,
  });
}

function planSessionStateCommand(
  commandName: "sync" | "reset:cwd",
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, []);
  if (kwargError) return kwargError;
  const idleError = requireIdleSession(commandName, snapshot);
  if (idleError) return idleError;
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  const base = {
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    targetSessionId: snapshot.sessionId,
  };
  return commandName === "sync"
    ? plan(commandName, { kind: "sync-session-state", ...base, command: ":" })
    : plan(commandName, { kind: "reset-session-cwd", ...base, command: "cd ~" });
}

function planScreenSelect(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const kwargError = hasOnlyKwargs(commandName, kwargs, []);
  if (kwargError) return kwargError;
  if (args.length !== 1) {
    return dispatchError(commandName, "invalid-arguments", "/screen requires one screen name, index, or id");
  }
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  const target = resolveScreenReference(commandName, args[0], scope.sessions);
  if (!target.ok) return target.error;
  return plan(commandName, {
    kind: "select-screen",
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    targetSessionId: target.screen.id,
  });
}

function planScreenOpen(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, ["name", "activate"]);
  if (kwargError) return kwargError;
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  const activate = kwargs.activate === undefined ? true : parseBoolean(kwargs.activate);
  if (activate === null) {
    return dispatchError(commandName, "invalid-value", `/${commandName} activate must be a boolean`);
  }
  let name: string | undefined;
  if (kwargs.name !== undefined) {
    const normalized = normalizeTerminalName(commandName, kwargs.name);
    if (typeof normalized !== "string") return normalized;
    name = normalized;
  }
  return plan(commandName, {
    kind: "create-screen",
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    ...(name ? { name } : {}),
    activate,
  });
}

function planScreenDelete(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const kwargError = hasOnlyKwargs(commandName, kwargs, []);
  if (kwargError) return kwargError;
  if (args.length > 1) {
    return dispatchError(commandName, "invalid-arguments", `/${commandName} accepts one screen at most`);
  }
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  const target = args[0]
    ? resolveScreenReference(commandName, args[0], scope.sessions)
    : { ok: true as const, screen: scope.current, index: scope.sessions.indexOf(scope.current) };
  if (!target.ok) return target.error;
  return plan(commandName, {
    kind: "delete-screen",
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    targetSessionId: target.screen.id,
  });
}

function makeScreenReorderAction(
  snapshot: BlockTermManagementDispatchSnapshot,
  scope: Extract<ScreenScopeResolution, { ok: true }>,
  targetIndex: number
): BlockTermManagementDispatchAction {
  const anchorSessionId = resolveBlockTermManagementScreenReorderAnchor(scope.sessions, targetIndex);
  if (!anchorSessionId) throw new Error("validated screen index has no reorder anchor");
  return {
    kind: "reorder-screen",
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    targetSessionId: snapshot.sessionId,
    targetIndex,
    anchorSessionId,
  };
}

function planScreenReorder(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, ["index"]);
  if (kwargError) return kwargError;
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  const index = parseScreenIndex(commandName, kwargs.index, scope.sessions);
  if (typeof index !== "number") return index;
  return plan(commandName, makeScreenReorderAction(snapshot, scope, index));
}

function planScreenSet(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, [
    "name",
    "tabcolor",
    "tabicon",
    "pos",
    "focus",
    "line",
    "anchor",
    "sharename",
  ]);
  if (kwargError) return kwargError;
  if (kwargs.sharename !== undefined) {
    return dispatchError(commandName, "unsupported", "/screen:set sharename= is outside BlockTerm desktop scope");
  }
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  const actions: BlockTermManagementDispatchAction[] = [];
  const settings: { name?: string; tabColor?: BlockTermTabColor; tabIcon?: BlockTermTabIcon } = {};
  if (kwargs.name !== undefined) {
    const name = normalizeTerminalName(commandName, kwargs.name);
    if (typeof name !== "string") return name;
    settings.name = name;
  }
  if (kwargs.tabcolor !== undefined) {
    const color = normalizeTabColor(commandName, kwargs.tabcolor);
    if (typeof color !== "string") return color;
    settings.tabColor = color;
  }
  if (kwargs.tabicon !== undefined) {
    const icon = normalizeTabIcon(commandName, kwargs.tabicon);
    if (typeof icon !== "string") return icon;
    settings.tabIcon = icon;
  }
  if (Object.keys(settings).length > 0) {
    actions.push({
      kind: "update-screen-settings",
      sessionId: snapshot.sessionId,
      workspaceSessionId: scope.workspaceSessionId,
      groupId: scope.groupId,
      targetSessionId: snapshot.sessionId,
      settings,
    });
  }
  if (kwargs.pos !== undefined) {
    const index = parseScreenIndex(commandName, kwargs.pos, scope.sessions);
    if (typeof index !== "number") return index;
    actions.push(makeScreenReorderAction(snapshot, scope, index));
  }

  let selectedBlockId: string | undefined;
  if (kwargs.line !== undefined) {
    const block = findBlockByReference(snapshot, kwargs.line);
    if (!block) return dispatchError(commandName, "unknown-line", `/screen:set cannot find line '${kwargs.line}'`);
    if (block.archived) return dispatchError(commandName, "unsupported", "/screen:set cannot select an archived line");
    selectedBlockId = block.id;
  }
  let anchorBlockId: string | undefined;
  let anchorOffset: number | undefined;
  if (kwargs.anchor !== undefined) {
    const match = /^([^:]+)(?::(-?[0-9]+))?$/u.exec(kwargs.anchor.trim());
    if (!match) {
      return dispatchError(commandName, "invalid-value", "/screen:set anchor must be line or line:offset");
    }
    const block = findBlockByReference(snapshot, match[1]);
    if (!block) return dispatchError(commandName, "unknown-line", `/screen:set cannot find anchor line '${match[1]}'`);
    if (block.archived)
      return dispatchError(commandName, "unsupported", "/screen:set cannot anchor to an archived line");
    const offset = match[2] === undefined ? 0 : Number(match[2]);
    if (!Number.isSafeInteger(offset)) {
      return dispatchError(commandName, "invalid-value", "/screen:set anchor offset must be an integer");
    }
    anchorBlockId = block.id;
    anchorOffset = offset;
  }
  let focus: "input" | "command" | undefined;
  if (kwargs.focus !== undefined) {
    if (kwargs.focus === "input") focus = "input";
    else if (kwargs.focus === "cmd") focus = "command";
    else return dispatchError(commandName, "invalid-value", "/screen:set focus must be input or cmd");
  }
  if (selectedBlockId !== undefined || anchorBlockId !== undefined || focus !== undefined) {
    actions.push({
      kind: "set-screen-view",
      sessionId: snapshot.sessionId,
      workspaceSessionId: scope.workspaceSessionId,
      groupId: scope.groupId,
      targetSessionId: snapshot.sessionId,
      ...(selectedBlockId ? { selectedBlockId } : {}),
      ...(anchorBlockId ? { anchorBlockId, anchorOffset } : {}),
      ...(focus ? { focus } : {}),
    });
  }
  return actions.length > 0
    ? { kind: "plan", commandName, actions }
    : dispatchError(commandName, "invalid-arguments", "/screen:set requires at least one supported setting");
}

function planScreenShow(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot,
  all: boolean
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, []);
  if (kwargError) return kwargError;
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  if (all) {
    return plan(commandName, {
      kind: "show-screen-list",
      sessionId: snapshot.sessionId,
      workspaceSessionId: scope.workspaceSessionId,
      groupId: scope.groupId,
      screens: scope.sessions.map(summarizeScreen),
    });
  }
  const index = scope.sessions.findIndex((session) => session.id === snapshot.sessionId);
  return plan(commandName, {
    kind: "show-screen-info",
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    screen: summarizeScreen(scope.current, index),
  });
}

function planScreenResize(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;
  const kwargError = hasOnlyKwargs(commandName, kwargs, ["cols", "include", "exclude"]);
  if (kwargError) return kwargError;
  if (kwargs.cols === undefined || !/^[0-9]+$/u.test(kwargs.cols.trim())) {
    return dispatchError(commandName, "invalid-value", "/screen:resize requires numeric cols=");
  }
  const cols = Number(kwargs.cols);
  if (!Number.isSafeInteger(cols) || cols < MIN_TERMINAL_COLS || cols > MAX_TERMINAL_COLS) {
    return dispatchError(
      commandName,
      "invalid-value",
      `/screen:resize cols must be between ${MIN_TERMINAL_COLS} and ${MAX_TERMINAL_COLS}`
    );
  }
  const scope = requireScreenScope(commandName, snapshot);
  if (!scope.ok) return scope.error;
  if (!Number.isSafeInteger(scope.current.rows) || scope.current.rows < 2 || scope.current.rows > 1024) {
    return dispatchError(commandName, "missing-scope", "/screen:resize requires the current terminal row count");
  }
  let includedIds: Set<string> | undefined;
  if (kwargs.include !== undefined) {
    const parsed = parseResizeReferences(commandName, "include", kwargs.include, snapshot);
    if (!(parsed instanceof Set)) return parsed;
    includedIds = parsed;
  }
  let excludedIds: Set<string> | undefined;
  if (kwargs.exclude !== undefined) {
    const parsed = parseResizeReferences(commandName, "exclude", kwargs.exclude, snapshot);
    if (!(parsed instanceof Set)) return parsed;
    excludedIds = parsed;
  }

  const childTargets = snapshot.blocks
    .filter((block) => {
      if (!isBlockTermManagementIndependentBlock(snapshot, block)) return false;
      if (includedIds && !includedIds.has(block.id)) return false;
      return !excludedIds?.has(block.id);
    })
    .map((block) => {
      const binding = getIndependentBinding(snapshot, block);
      if (!binding) return null;
      return {
        blockId: block.id,
        blockToken: binding.blockToken,
        ...(binding.scopeGeneration !== undefined ? { scopeGeneration: binding.scopeGeneration } : {}),
      } satisfies BlockTermManagementResizeTarget;
    })
    .filter((target): target is BlockTermManagementResizeTarget => target !== null);

  return plan(commandName, {
    kind: "resize-screen",
    sessionId: snapshot.sessionId,
    workspaceSessionId: scope.workspaceSessionId,
    groupId: scope.groupId,
    targetSessionId: snapshot.sessionId,
    cols,
    rows: scope.current.rows,
    ...(childTargets.length > 0 ? { childTargets } : {}),
  });
}

function planScreenCommand(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  switch (commandName) {
    case "screen":
      return planScreenSelect(commandName, args, kwargs, snapshot);
    case "screen:open":
    case "screen:new":
      return planScreenOpen(commandName, args, kwargs, snapshot);
    case "screen:delete":
      return planScreenDelete(commandName, args, kwargs, snapshot);
    case "screen:set":
      return planScreenSet(commandName, args, kwargs, snapshot);
    case "screen:reorder":
      return planScreenReorder(commandName, args, kwargs, snapshot);
    case "screen:show":
      return planScreenShow(commandName, args, kwargs, snapshot, false);
    case "screen:showall":
      return planScreenShow(commandName, args, kwargs, snapshot, true);
    case "screen:resize":
      return planScreenResize(commandName, args, kwargs, snapshot);
    default:
      return dispatchError(commandName, "unsupported", `/${commandName} is not supported by BlockTerm`);
  }
}

function planLineShow(
  commandName: string,
  _args: readonly string[],
  _snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  return dispatchError(
    commandName,
    "unsupported",
    "/line:show requires a structured line metadata view that BlockTerm does not provide yet"
  );
}

function planLineFlag(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot,
  field: "starred" | "pinned" | "archived" | "collapsed"
): BlockTermManagementDispatchResult {
  const target = resolveTarget(commandName, snapshot, args, true, (value) => parseBoolean(value) !== null);
  if (!target.ok) return target.error;
  const value = parseLineBoolean(commandName, args, target.nextArg, true);
  if (typeof value !== "boolean") return value;
  return plan(commandName, {
    kind: "update-block",
    sessionId: snapshot.sessionId,
    blockId: target.block.id,
    patch: { [field]: value },
  });
}

function planLinePin(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  if (args.length < 1 || args.length > 2) {
    return dispatchError(commandName, "invalid-arguments", "/line:pin requires a line and optional boolean value");
  }
  const target = resolveTarget(commandName, snapshot, args, false);
  if (!target.ok) return target.error;
  const value = parseLineBoolean(commandName, args, target.nextArg, true);
  if (typeof value !== "boolean") return value;
  return plan(commandName, {
    kind: "update-block",
    sessionId: snapshot.sessionId,
    blockId: target.block.id,
    patch: { pinned: value },
  });
}

function planLineStar(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const target = resolveTarget(commandName, snapshot, args, true, (value) => parseStarValue(value) !== null);
  if (!target.ok) return target.error;
  const value =
    args.length === target.nextArg
      ? true
      : args.length === target.nextArg + 1
        ? parseStarValue(args[target.nextArg])
        : null;
  if (value === null) {
    return dispatchError(
      commandName,
      "invalid-value",
      "/line:star accepts 0 through 5; BlockTerm stores 0 as unstarred and 1-5 as starred"
    );
  }
  return plan(commandName, {
    kind: "update-block",
    sessionId: snapshot.sessionId,
    blockId: target.block.id,
    patch: { starred: value },
  });
}

function planLineBookmark(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  if (args.length !== 1) {
    return dispatchError(commandName, "invalid-arguments", "/line:bookmark requires exactly one line");
  }
  const target = resolveTarget(commandName, snapshot, args, false);
  if (!target.ok) return target.error;
  const command = target.block.command.trim();
  if (!command || target.block.kind !== "command") {
    return dispatchError(commandName, "unsupported", "/line:bookmark only supports command blocks");
  }
  return plan(commandName, { kind: "open-bookmark", sessionId: snapshot.sessionId, blockId: target.block.id, command });
}

function planLineDelete(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const references = args.length > 0 ? args : snapshot.selectedBlockId ? [snapshot.selectedBlockId] : [];
  if (references.length === 0) {
    return dispatchError(commandName, "no-selected-line", "/line:delete requires a line or selected line");
  }
  const ids: string[] = [];
  for (const reference of references) {
    const block = findBlockByReference(snapshot, reference);
    if (!block) return dispatchError(commandName, "unknown-line", `/${commandName} cannot find line '${reference}'`);
    if (isProtectedFromDeletion(block, snapshot)) {
      return dispatchError(commandName, "not-active-line", "/line:delete cannot delete an active or running block");
    }
    if (!ids.includes(block.id)) ids.push(block.id);
  }
  return plan(commandName, { kind: "delete-blocks", sessionId: snapshot.sessionId, blockIds: ids });
}

function planLineSetHeight(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  if (args.length !== 2) {
    return dispatchError(commandName, "invalid-arguments", "/line:setheight requires a line and height");
  }
  const target = resolveTarget(commandName, snapshot, args, false);
  if (!target.ok) return target.error;
  const heightArg = args[target.nextArg];
  const height = Number(heightArg);
  if (!Number.isSafeInteger(height) || height < 0 || height > 10_000) {
    return dispatchError(commandName, "invalid-value", "/line:setheight requires an integer from 0 through 10000");
  }
  return plan(commandName, {
    kind: "update-block",
    sessionId: snapshot.sessionId,
    blockId: target.block.id,
    patch: { presentationJson: setBlockTermPresentationHeight(target.block.presentationJson, height) },
  });
}

function planLineRestart(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const target = resolveTarget(commandName, snapshot, args, true);
  if (!target.ok) return target.error;
  if (args.length !== target.nextArg) {
    return dispatchError(commandName, "invalid-arguments", `/${commandName} accepts one line at most`);
  }
  if (
    snapshot.sessionStatus !== "ready" ||
    snapshot.activeBlockId !== null ||
    target.block.kind !== "command" ||
    target.block.renderer === "openai" ||
    target.block.status === "running" ||
    target.block.status === "streaming"
  ) {
    return dispatchError(
      commandName,
      "unsupported",
      "/line:restart cannot restart this block in the current session state"
    );
  }
  return plan(commandName, { kind: "restart-block", sessionId: snapshot.sessionId, blockId: target.block.id });
}

function validateLineState(
  commandName: string,
  block: BlockTermManagementDispatchBlock,
  renderer: string,
  stateJson: string
): string | BlockTermManagementDispatchError {
  if (textEncoder.encode(stateJson).byteLength > MAX_LINE_STATE_BYTES) {
    return dispatchError(commandName, "invalid-value", `/line:set state must be at most ${MAX_LINE_STATE_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(stateJson);
  } catch {
    return dispatchError(commandName, "invalid-value", "/line:set state must be a valid JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return dispatchError(commandName, "invalid-value", "/line:set state must be a valid JSON object");
  }
  if (renderer === "openai") {
    return dispatchError(commandName, "unsupported", "/line:set cannot mutate model-owned OpenAI block state");
  }
  if (block.kind === "command" && (renderer === "terminal" || renderer === "none" || renderer === "")) {
    return dispatchError(
      commandName,
      "unsupported",
      "/line:set state is unavailable for BlockTerm terminal and none command renderers"
    );
  }
  if (block.kind === "command") {
    const state = value as Record<string, unknown>;
    if ("prompt:file" in state || ("prompt:source" in state && state["prompt:source"] !== "pty")) {
      return dispatchError(
        commandName,
        "unsupported",
        "/line:set command renderer state must use prompt:source=pty and cannot set prompt:file"
      );
    }
  }
  return stateJson;
}

function planLineSet(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const kwargError = hasOnlyKwargs(commandName, kwargs, ["view", "renderer", "state"]);
  if (kwargError) return kwargError;
  if (args.length !== 1) {
    return dispatchError(commandName, "invalid-arguments", "/line:set requires exactly one line");
  }
  if (kwargs.view !== undefined && kwargs.renderer !== undefined) {
    return dispatchError(commandName, "invalid-arguments", "/line:set accepts one renderer value");
  }
  const renderer = kwargs.view ?? kwargs.renderer;
  if (renderer === undefined && kwargs.state === undefined) {
    return dispatchError(commandName, "invalid-arguments", "/line:set requires view=, renderer=, or state=");
  }
  const target = resolveTarget(commandName, snapshot, args, false);
  if (!target.ok) return target.error;
  const actions: BlockTermManagementDispatchAction[] = [];
  if (renderer !== undefined) {
    const resolution = resolveBlockTermRendererSwitch(target.block, renderer);
    if (!resolution.ok) {
      return dispatchError(
        commandName,
        "unsupported",
        `/${commandName} cannot set renderer '${renderer}' on this block`
      );
    }
    actions.push({
      kind: "switch-renderer",
      sessionId: snapshot.sessionId,
      blockId: target.block.id,
      renderer: resolution.patch.renderer,
    });
  }
  if (kwargs.state !== undefined) {
    const state = validateLineState(
      commandName,
      target.block,
      renderer ?? target.block.renderer ?? "terminal",
      kwargs.state
    );
    if (typeof state !== "string") return state;
    actions.push({
      kind: "update-block",
      sessionId: snapshot.sessionId,
      blockId: target.block.id,
      patch: { stateJson: state },
    });
  }
  return { kind: "plan", commandName, actions };
}

function planLineView(
  commandName: string,
  args: readonly string[],
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  if (args.length === 1) {
    const target = resolveTarget(commandName, snapshot, args, false);
    if (!target.ok) return target.error;
    if (target.block.archived) {
      return dispatchError(
        commandName,
        "unsupported",
        "/line:view cannot focus an archived line in the current screen"
      );
    }
    return plan(commandName, { kind: "focus-block", sessionId: snapshot.sessionId, blockId: target.block.id });
  }
  if (args.length === 3) {
    const scope = requireScreenScope(commandName, snapshot);
    if (!scope.ok) return scope.error;
    return plan(commandName, {
      kind: "view-line",
      sessionId: snapshot.sessionId,
      workspaceSessionId: scope.workspaceSessionId,
      groupId: scope.groupId,
      workspaceRef: args[0],
      screenRef: args[1],
      lineRef: args[2],
    });
  }
  return dispatchError(
    commandName,
    "invalid-arguments",
    "/line:view requires either one current-screen line or workspace, screen, and line"
  );
}

function planLineCommand(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const kwargError = hasOnlyKwargs(
    commandName,
    kwargs,
    commandName === "line:set" ? ["view", "renderer", "state"] : []
  );
  if (kwargError) return kwargError;
  switch (commandName) {
    case "line:show":
      return planLineShow(commandName, args, snapshot);
    case "line:view":
      return planLineView(commandName, args, snapshot);
    case "line:star":
      return planLineStar(commandName, args, snapshot);
    case "line:pin":
      return planLinePin(commandName, args, snapshot);
    case "line:archive":
      return planLineFlag(commandName, args, snapshot, "archived");
    case "line:minimize":
      return planLineFlag(commandName, args, snapshot, "collapsed");
    case "line:bookmark":
      return planLineBookmark(commandName, args, snapshot);
    case "line:delete":
      return planLineDelete(commandName, args, snapshot);
    case "line:setheight":
      return planLineSetHeight(commandName, args, snapshot);
    case "line:restart":
      return planLineRestart(commandName, args, snapshot);
    case "line:set":
      return planLineSet(commandName, args, kwargs, snapshot);
    default:
      return dispatchError(commandName, "unsupported", `/${commandName} is not supported by BlockTerm`);
  }
}

function planSidebarCommand(
  commandName: string,
  args: readonly string[],
  kwargs: Record<string, string>,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  const supportedKwargs =
    commandName === "sidebar:add" ? ["line", "width"] : commandName === "sidebar:open" ? ["width"] : [];
  const kwargError = hasOnlyKwargs(commandName, kwargs, supportedKwargs);
  if (kwargError) return kwargError;
  const argumentError = requireNoArgs(commandName, args);
  if (argumentError) return argumentError;

  if (commandName === "sidebar:close") {
    return plan(commandName, {
      kind: "update-view",
      sessionId: snapshot.sessionId,
      patch: { sidebar: { open: false } },
    });
  }
  if (commandName === "sidebar:remove") {
    return plan(commandName, {
      kind: "update-view",
      sessionId: snapshot.sessionId,
      patch: { sidebar: { open: false, blockId: null } },
    });
  }

  const width = kwargs.width === undefined ? undefined : parseSidebarWidth(kwargs.width);
  if (kwargs.width !== undefined && width === null) {
    return dispatchError(commandName, "invalid-value", "/sidebar width must be 10-90% or 200-4000px");
  }
  if (commandName === "sidebar:open") {
    return plan(commandName, {
      kind: "update-view",
      sessionId: snapshot.sessionId,
      patch: { sidebar: { open: true, ...(width ? { width } : {}) } },
    });
  }

  const lineArg = kwargs.line?.trim();
  if (!lineArg) {
    return dispatchError(commandName, "invalid-arguments", "/sidebar:add requires line=");
  }
  const target = resolveTarget(commandName, snapshot, [lineArg], false);
  if (!target.ok) return target.error;
  if (target.block.archived) {
    return dispatchError(commandName, "unsupported", "/sidebar cannot display an archived line");
  }
  if (
    (target.block.id === snapshot.activeBlockId || ACTIVE_OR_STREAMING_BLOCK_STATUSES.has(target.block.status)) &&
    !isBlockTermManagementIndependentBlock(snapshot, target.block)
  ) {
    return dispatchError(
      commandName,
      "unsupported",
      "/sidebar:add cannot move a running block without an independent PTY owner"
    );
  }
  return plan(commandName, {
    kind: "update-view",
    sessionId: snapshot.sessionId,
    patch: { sidebar: { open: true, blockId: target.block.id, ...(width ? { width } : {}) } },
  });
}

/**
 * Converts an already parsed management command into page-level work. The
 * caller owns all side effects and must revalidate its scope and lifecycle
 * bindings immediately before executing every planned action.
 */
export function planBlockTermManagementDispatch(
  result: BlockTermManagementCommandResult,
  snapshot: BlockTermManagementDispatchSnapshot
): BlockTermManagementDispatchResult {
  if (result.kind === "shell") return { kind: "not-applicable" };
  if (result.kind === "error") return dispatchError(result.commandName, "parser-error", result.message);
  if (result.kind === "unsupported") return dispatchError(result.commandName, "unsupported", result.message);

  switch (result.commandName) {
    case "connect":
      return planConnect(result.commandName, result.args, result.kwargs, snapshot);
    case "clear":
      return planClear(result.commandName, result.args, result.kwargs, snapshot);
    case "signal":
      return planSignal(result.commandName, result.args, result.kwargs, snapshot);
    case "reset":
      return planResetCommand(result.commandName, result.args, result.kwargs, snapshot);
    case "reset:cwd":
      return planSessionStateCommand(result.commandName, result.args, result.kwargs, snapshot);
    case "sync":
      return planSessionStateCommand(result.commandName, result.args, result.kwargs, snapshot);
    case "screen":
    case "screen:open":
    case "screen:new":
    case "screen:delete":
    case "screen:set":
    case "screen:reorder":
    case "screen:show":
    case "screen:showall":
    case "screen:resize":
      return planScreenCommand(result.commandName, result.args, result.kwargs, snapshot);
    case "line:show":
    case "line:star":
    case "line:bookmark":
    case "line:pin":
    case "line:archive":
    case "line:delete":
    case "line:setheight":
    case "line:view":
    case "line:set":
    case "line:restart":
    case "line:minimize":
      return planLineCommand(result.commandName, result.args, result.kwargs, snapshot);
    case "sidebar:open":
    case "sidebar:close":
    case "sidebar:add":
    case "sidebar:remove":
      return planSidebarCommand(result.commandName, result.args, result.kwargs, snapshot);
    default:
      return { kind: "not-applicable", commandName: result.commandName };
  }
}
