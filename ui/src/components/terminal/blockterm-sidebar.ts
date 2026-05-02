// Copyright 2023, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified by VibeGo contributors.

export const BLOCKTERM_SIDEBAR_DEFAULT_WIDTH = "50%";
export const BLOCKTERM_SIDEBAR_FIXED_WIDTH = "500px";
export const BLOCKTERM_SIDEBAR_MIN_PANE_WIDTH = 200;
export const BLOCKTERM_SIDEBAR_MAX_PIXEL_WIDTH = 4000;
export const BLOCKTERM_SIDEBAR_MAX_BLOCK_ID_BYTES = 256;

export interface BlockTermSidebarState {
  open: boolean;
  width: string;
  blockId: string | null;
}

export interface BlockTermViewState {
  sidebar: BlockTermSidebarState;
  nextConnection?: BlockTermNextConnectionState;
}

export interface BlockTermNextConnectionState {
  runtimeType: "local" | "ssh";
  sshProfileId?: string;
  cwd?: string;
}

export type BlockTermViewWriteResult = { ok: true; view: BlockTermViewState } | { ok: false };

export interface BlockTermViewWriteResolution {
  confirmed: BlockTermViewState;
  visible: BlockTermViewState;
}

export type BlockTermSidebarBody = { kind: "note"; text: string } | { kind: "output" };

export const DEFAULT_BLOCKTERM_VIEW_STATE: BlockTermViewState = Object.freeze({
  sidebar: Object.freeze({
    open: false,
    width: BLOCKTERM_SIDEBAR_DEFAULT_WIDTH,
    blockId: null,
  }),
});

function parseSidebarWidth(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^([1-9][0-9]{0,3})(px|%)$/u.exec(value);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (match[2] === "%") return numeric >= 10 && numeric <= 90 ? `${numeric}%` : null;
  return numeric >= BLOCKTERM_SIDEBAR_MIN_PANE_WIDTH && numeric <= BLOCKTERM_SIDEBAR_MAX_PIXEL_WIDTH
    ? `${numeric}px`
    : null;
}

function parseSidebarBlockId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return new TextEncoder().encode(value).byteLength <= BLOCKTERM_SIDEBAR_MAX_BLOCK_ID_BYTES ? value : null;
}

export function sanitizeBlockTermViewState(value: unknown): BlockTermViewState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_BLOCKTERM_VIEW_STATE;
  const rawSidebar = (value as { sidebar?: unknown }).sidebar;
  if (!rawSidebar || typeof rawSidebar !== "object" || Array.isArray(rawSidebar)) {
    return DEFAULT_BLOCKTERM_VIEW_STATE;
  }
  const sidebar = rawSidebar as Record<string, unknown>;
  let nextConnection: BlockTermNextConnectionState | null = null;
  const rawNext =
    (value as { next_connection?: unknown; nextConnection?: unknown }).next_connection ??
    (value as { nextConnection?: unknown }).nextConnection;
  if (rawNext && typeof rawNext === "object" && !Array.isArray(rawNext)) {
    const next = rawNext as Record<string, unknown>;
    const runtimeType =
      next.runtime_type === "ssh" || next.runtimeType === "ssh"
        ? "ssh"
        : next.runtime_type === "local" || next.runtimeType === "local"
          ? "local"
          : null;
    if (runtimeType) {
      const profile =
        typeof (next.ssh_profile_id ?? next.sshProfileId) === "string"
          ? String(next.ssh_profile_id ?? next.sshProfileId).trim()
          : "";
      const cwd = typeof next.cwd === "string" && next.cwd.trim() ? next.cwd : undefined;
      nextConnection =
        runtimeType === "ssh" && profile
          ? { runtimeType, sshProfileId: profile, ...(cwd ? { cwd } : {}) }
          : runtimeType === "local"
            ? { runtimeType, ...(cwd ? { cwd } : {}) }
            : null;
    }
  }
  return {
    sidebar: {
      open: sidebar.open === true,
      width: parseSidebarWidth(sidebar.width) || BLOCKTERM_SIDEBAR_DEFAULT_WIDTH,
      blockId: parseSidebarBlockId(sidebar.block_id ?? sidebar.blockId ?? sidebar.sidebarlineid),
    },
    ...(nextConnection ? { nextConnection } : {}),
  };
}

export function parseBlockTermViewJSON(value?: string | null): BlockTermViewState {
  if (!value) return DEFAULT_BLOCKTERM_VIEW_STATE;
  try {
    return sanitizeBlockTermViewState(JSON.parse(value));
  } catch {
    return DEFAULT_BLOCKTERM_VIEW_STATE;
  }
}

export function serializeBlockTermViewState(value: unknown): string {
  const state = sanitizeBlockTermViewState(value);
  return JSON.stringify({
    sidebar: {
      open: state.sidebar.open,
      width: state.sidebar.width,
      block_id: state.sidebar.blockId,
    },
    ...(state.nextConnection
      ? {
          next_connection: {
            runtime_type: state.nextConnection.runtimeType,
            ...(state.nextConnection.sshProfileId ? { ssh_profile_id: state.nextConnection.sshProfileId } : {}),
            ...(state.nextConnection.cwd ? { cwd: state.nextConnection.cwd } : {}),
          },
        }
      : {}),
  });
}

export function setBlockTermNextConnectionState(
  view: BlockTermViewState,
  nextConnection: BlockTermNextConnectionState | null
): BlockTermViewState {
  return sanitizeBlockTermViewState({ ...view, nextConnection });
}

export function setBlockTermSidebarState(
  view: BlockTermViewState,
  patch: Partial<BlockTermSidebarState>
): BlockTermViewState {
  return sanitizeBlockTermViewState({ ...view, sidebar: { ...view.sidebar, ...patch } });
}

export function resolveBlockTermViewWrite(
  visible: BlockTermViewState,
  confirmed: BlockTermViewState,
  result: BlockTermViewWriteResult,
  isLatest: boolean
): BlockTermViewWriteResolution {
  const nextConfirmed = result.ok ? sanitizeBlockTermViewState(result.view) : sanitizeBlockTermViewState(confirmed);
  return {
    confirmed: nextConfirmed,
    visible: isLatest ? nextConfirmed : visible,
  };
}

export function isBlockTermViewScopeCurrent(requestScopeGeneration: number, currentScopeGeneration: number): boolean {
  return requestScopeGeneration === currentScopeGeneration;
}

export function queueBlockTermViewLoadAfterWrites(
  previousWrite: Promise<unknown>,
  load: () => Promise<void>
): Promise<void> {
  return previousWrite.catch(() => {}).then(load);
}

export function queueBlockTermViewWriteAfterLoad(
  previousWrite: Promise<void>,
  confirmedLoad: Promise<unknown>,
  write: () => Promise<void>
): Promise<void> {
  return previousWrite
    .catch(() => {})
    .then(() => confirmedLoad.catch(() => {}))
    .then(write);
}

export function resolveBlockTermSidebarBody(block: { kind: string; text?: string | null }): BlockTermSidebarBody {
  return block.kind === "note" ? { kind: "note", text: block.text || "" } : { kind: "output" };
}

export function resolveBlockTermSidebarWidth(containerWidth: number, targetWidth: string): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0;
  const roundedWidth = Math.floor(containerWidth);
  if (roundedWidth < BLOCKTERM_SIDEBAR_MIN_PANE_WIDTH * 2) return Math.max(0, Math.floor(roundedWidth / 2));

  const normalized = parseSidebarWidth(targetWidth) || BLOCKTERM_SIDEBAR_DEFAULT_WIDTH;
  const requested = normalized.endsWith("%")
    ? Math.floor((roundedWidth * Number.parseInt(normalized, 10)) / 100)
    : Number.parseInt(normalized, 10);
  return Math.min(
    roundedWidth - BLOCKTERM_SIDEBAR_MIN_PANE_WIDTH,
    Math.max(BLOCKTERM_SIDEBAR_MIN_PANE_WIDTH, requested)
  );
}

export function isBlockTermSidebarOwner(view: BlockTermViewState, blockId: string): boolean {
  return view.sidebar.open && view.sidebar.blockId === blockId;
}

export function partitionBlockTermSidebarBlocks<T extends { id: string }>(
  blocks: readonly T[],
  view: BlockTermViewState,
  sidebarEnabled: boolean
): { mainBlocks: T[]; sidebarBlock: T | null } {
  if (!sidebarEnabled || !view.sidebar.open || !view.sidebar.blockId) {
    return { mainBlocks: [...blocks], sidebarBlock: null };
  }
  const sidebarBlock = blocks.find((block) => block.id === view.sidebar.blockId) || null;
  if (!sidebarBlock) return { mainBlocks: [...blocks], sidebarBlock: null };
  return {
    mainBlocks: blocks.filter((block) => block.id !== sidebarBlock.id),
    sidebarBlock,
  };
}

export function legalizeBlockTermSidebarState(
  view: BlockTermViewState,
  blocks: readonly { id: string; archived?: boolean }[]
): BlockTermViewState {
  const owner = view.sidebar.blockId ? blocks.find((block) => block.id === view.sidebar.blockId) : undefined;
  if (owner && !owner.archived) return view;
  return setBlockTermSidebarState(view, { open: false, blockId: null });
}

export function shouldLegalizeBlockTermSidebarState(
  view: BlockTermViewState,
  blocks: readonly { id: string; archived?: boolean }[],
  blockInventoryLoaded: boolean
): boolean {
  if (!blockInventoryLoaded || !view.sidebar.blockId) return false;
  const owner = blocks.find((block) => block.id === view.sidebar.blockId);
  return !owner || owner.archived === true;
}
