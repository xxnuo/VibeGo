import { type BlockTermKeymap, resolveBlockTermKeymapAction } from "./blockterm-keymap.ts";

export type BlockTermDesktopShortcut =
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

export interface BlockTermDesktopKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type BlockTermSessionFocusTarget =
  | { type: "input" }
  | {
      type: "block";
      blockId: string;
      area: "main" | "sidebar";
      focus: "container" | "terminal" | "editor";
    };

interface BlockTermDesktopShortcutTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

export interface BlockTermDesktopShortcutOptions {
  allowAltCodeFallback?: boolean;
  allowMacSessionFallback?: boolean;
  keymap?: BlockTermKeymap;
}

interface BlockTermDesktopShortcutTargetOptions {
  commandInput?: boolean;
  macPlatform?: boolean;
}

interface BlockTermPlatformNavigator {
  platform?: string;
  userAgent?: string;
}

interface BlockTermDesktopShortcutModalRoot {
  querySelector: (selector: string) => unknown;
}

export const BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR = [
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="alert-dialog-content"][data-state="open"]',
  '[data-slot="sheet-content"][data-state="open"]',
  '[data-slot="drawer-content"][data-state="open"]',
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="dropdown-menu-sub-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="context-menu-sub-content"][data-state="open"]',
  '[data-slot="menubar-content"][data-state="open"]',
  '[data-slot="menubar-sub-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[data-slot="select-content"][data-state="open"]',
  '[data-slot="combobox-content"][data-open]',
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
].join(", ");

export function hasOpenBlockTermDesktopShortcutModal(root: BlockTermDesktopShortcutModalRoot): boolean {
  return Boolean(root.querySelector(BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR));
}

export function isBlockTermDesktopShortcutRepeatable(shortcut: BlockTermDesktopShortcut): boolean {
  return (
    shortcut.type === "previous-session" ||
    shortcut.type === "next-session" ||
    shortcut.type === "previous-block" ||
    shortcut.type === "next-block"
  );
}

export function shouldConfirmBlockTermSessionClose(blockCount: number): boolean {
  return blockCount >= 10;
}

export function resolveBlockTermSessionAfterClose(
  sessionIds: readonly string[],
  closingSessionId: string
): string | null {
  const closingIndex = sessionIds.indexOf(closingSessionId);
  if (closingIndex < 0) return null;
  return sessionIds[closingIndex + 1] || sessionIds[closingIndex - 1] || null;
}

export function resolveBlockTermSessionFocusTarget(
  storedTarget: BlockTermSessionFocusTarget,
  mainBlockIds: readonly string[],
  sidebarBlockId: string | null,
  selectedBlockId: string | null
): BlockTermSessionFocusTarget {
  if (storedTarget.type === "input") return storedTarget;
  if (
    (storedTarget.area === "main" && mainBlockIds.includes(storedTarget.blockId)) ||
    (storedTarget.area === "sidebar" && sidebarBlockId === storedTarget.blockId)
  ) {
    return storedTarget;
  }
  if (selectedBlockId && selectedBlockId === sidebarBlockId) {
    return { type: "block", blockId: selectedBlockId, area: "sidebar", focus: "container" };
  }
  if (selectedBlockId && mainBlockIds.includes(selectedBlockId)) {
    return { type: "block", blockId: selectedBlockId, area: "main", focus: "container" };
  }
  return { type: "input" };
}

function resolveBlockTermDesktopShortcutCodeKey(event: BlockTermDesktopKeyEvent): string | null {
  if (!event.code) return null;
  if (/^Key[A-Z]$/u.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit[1-9]$/u.test(event.code)) return event.code.slice(5);
  if (event.code === "BracketLeft") return "[";
  if (event.code === "BracketRight") return "]";
  return null;
}

function resolveBlockTermDesktopShortcutKey(event: BlockTermDesktopKeyEvent, useCodeFallback: boolean): string {
  const key = event.key.toLowerCase();
  return (useCodeFallback && resolveBlockTermDesktopShortcutCodeKey(event)) || key;
}

function resolveBlockTermSessionShortcut(key: string): BlockTermDesktopShortcut | null {
  if (/^[1-9]$/.test(key)) {
    return { type: "select-session", index: Number(key) - 1 };
  }
  switch (key) {
    case "t":
      return { type: "new-session" };
    case "w":
      return { type: "close-session" };
    case "[":
      return { type: "previous-session" };
    case "]":
      return { type: "next-session" };
    default:
      return null;
  }
}

export function resolveBlockTermDesktopShortcut(
  event: BlockTermDesktopKeyEvent,
  options: BlockTermDesktopShortcutOptions = {}
): BlockTermDesktopShortcut | null {
  if (options.keymap) {
    const action = resolveBlockTermKeymapAction(event, options.keymap, {
      scope: "desktop",
      portableCommand: true,
      allowCodeFallback: options.allowAltCodeFallback,
      allowMacSessionFallback: options.allowMacSessionFallback,
    });
    return action?.scope === "desktop" ? action.action : null;
  }
  const macSessionFallback =
    Boolean(options.allowMacSessionFallback) && event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
  if (macSessionFallback) {
    return resolveBlockTermSessionShortcut(resolveBlockTermDesktopShortcutKey(event, true));
  }

  const portableCommand = event.metaKey !== event.altKey;
  if (!portableCommand) return null;

  const key = resolveBlockTermDesktopShortcutKey(
    event,
    Boolean(options.allowAltCodeFallback) && event.altKey && !event.metaKey
  );
  if (event.shiftKey) {
    if (!event.ctrlKey && key === "r") return { type: "rerun-last-command" };
    return null;
  }
  if (event.ctrlKey) {
    if (key === "s") return { type: "toggle-sidebar" };
    return null;
  }

  const sessionShortcut = resolveBlockTermSessionShortcut(key);
  if (sessionShortcut) return sessionShortcut;

  switch (key) {
    case "i":
      return { type: "focus-input" };
    case "l":
      return { type: "focus-selected-block" };
    case "r":
      return { type: "rerun-selected-command" };
    case "arrowup":
    case "pageup":
      return { type: "previous-block" };
    case "arrowdown":
    case "pagedown":
      return { type: "next-block" };
    case "d":
      return { type: "delete-selected-block" };
    case "b":
      return { type: "open-bookmarks" };
    case "h":
      return { type: "open-history" };
    default:
      return null;
  }
}

export function isBlockTermDesktopShortcutEditingTarget(target: BlockTermDesktopShortcutTarget | null): boolean {
  if (!target) return false;
  if (target.closest?.(".xterm")) return true;
  const tagName = target.tagName?.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable) return true;
  return Boolean(target.closest?.(".monaco-editor, [data-blockterm-renderer]"));
}

export function shouldIgnoreBlockTermDesktopShortcutTarget(
  target: BlockTermDesktopShortcutTarget | null,
  shortcut: BlockTermDesktopShortcut,
  options: { commandInput?: boolean } = {}
): boolean {
  if (!target) return false;
  if (options.commandInput) return shortcut.type === "delete-selected-block";
  if (
    shortcut.type !== "focus-selected-block" &&
    shortcut.type !== "rerun-selected-command" &&
    shortcut.type !== "rerun-last-command" &&
    shortcut.type !== "previous-block" &&
    shortcut.type !== "next-block" &&
    shortcut.type !== "delete-selected-block" &&
    shortcut.type !== "toggle-sidebar"
  ) {
    return false;
  }
  if (target.closest?.(".xterm")) return false;
  return isBlockTermDesktopShortcutEditingTarget(target);
}

export function isBlockTermMacPlatform(navigatorLike: BlockTermPlatformNavigator): boolean {
  return /mac/iu.test(navigatorLike.platform || navigatorLike.userAgent || "");
}

export function resolveBlockTermDesktopShortcutForTarget(
  event: BlockTermDesktopKeyEvent,
  target: BlockTermDesktopShortcutTarget | null,
  options: BlockTermDesktopShortcutTargetOptions & { keymap?: BlockTermKeymap } = {}
): BlockTermDesktopShortcut | null {
  const editingTarget = isBlockTermDesktopShortcutEditingTarget(target);
  if (options.macPlatform && editingTarget && event.altKey && !event.metaKey && !event.ctrlKey) {
    return null;
  }
  if (options.commandInput && options.keymap) {
    const inputAction = resolveBlockTermKeymapAction(event, options.keymap, {
      scope: "input",
      portableCommand: true,
      allowCodeFallback: true,
    });
    if (inputAction) return null;
  }
  const shortcut = resolveBlockTermDesktopShortcut(event, {
    allowAltCodeFallback: !editingTarget,
    allowMacSessionFallback: options.macPlatform,
    keymap: options.keymap,
  });
  if (!shortcut || shouldIgnoreBlockTermDesktopShortcutTarget(target, shortcut, options)) return null;
  return shortcut;
}
