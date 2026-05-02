import { type BlockTermKeymap, resolveBlockTermKeymapAction } from "./blockterm-keymap.ts";

export type BlockTermInputShortcut =
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

export interface BlockTermInputKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface BlockTermInputEdit {
  draft: string;
  cursor: number;
  clipboardText?: string;
}

function clampCursor(draft: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return draft.length;
  return Math.max(0, Math.min(draft.length, Math.trunc(cursor)));
}

function normalizeSelection(draft: string, start: number, end: number): [number, number] {
  const normalizedStart = clampCursor(draft, start);
  const normalizedEnd = clampCursor(draft, end);
  return normalizedStart <= normalizedEnd ? [normalizedStart, normalizedEnd] : [normalizedEnd, normalizedStart];
}

export function resolveBlockTermInputShortcut(
  event: BlockTermInputKeyEvent,
  keymap?: BlockTermKeymap
): BlockTermInputShortcut | null {
  if (keymap) {
    const action = resolveBlockTermKeymapAction(event, keymap, {
      scope: "input",
      portableCommand: true,
      allowCodeFallback: true,
    });
    return action?.scope === "input" ? action.action : null;
  }
  const key = event.key.toLowerCase();
  const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (ctrlOnly) {
    if (key === "c") return "clear";
    if (key === "u") return "cut-line-left";
    if (key === "w") return "cut-word-left";
    if (key === "y") return "paste";
    if (key === "p") return "history-previous";
    if (key === "n") return "history-next";
  }
  if (
    event.key === "Enter" &&
    !event.metaKey &&
    !event.altKey &&
    ((event.shiftKey && !event.ctrlKey) || (event.ctrlKey && !event.shiftKey))
  ) {
    return "insert-newline";
  }
  if (key === "e" && !event.ctrlKey && !event.shiftKey && event.metaKey !== event.altKey) {
    return "toggle-expanded";
  }
  return null;
}

export function clearBlockTermInput(): BlockTermInputEdit {
  return { draft: "", cursor: 0 };
}

export function cutBlockTermInputLineLeft(draft: string, cursor: number): BlockTermInputEdit {
  const position = clampCursor(draft, cursor);
  return {
    draft: draft.slice(position),
    cursor: 0,
    clipboardText: draft.slice(0, position),
  };
}

export function cutBlockTermInputWordLeft(draft: string, cursor: number): BlockTermInputEdit {
  const position = clampCursor(draft, cursor);
  let cutStart = position - 1;
  let skippingSpaces = true;
  for (; cutStart >= 0; cutStart -= 1) {
    const char = draft[cutStart];
    if (char === " " && skippingSpaces) continue;
    skippingSpaces = false;
    if (char === " ") {
      cutStart += 1;
      break;
    }
  }
  if (cutStart < 0) cutStart = 0;
  return {
    draft: `${draft.slice(0, cutStart)}${draft.slice(position)}`,
    cursor: cutStart,
    clipboardText: draft.slice(cutStart, position),
  };
}

export function insertBlockTermInputText(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  text: string
): BlockTermInputEdit {
  const [start, end] = normalizeSelection(draft, selectionStart, selectionEnd);
  return {
    draft: `${draft.slice(0, start)}${text}${draft.slice(end)}`,
    cursor: start + text.length,
  };
}

export function getBlockTermInputRows(draft: string, expanded: boolean): number {
  if (expanded) return 8;
  return Math.min(8, Math.max(2, draft.split("\n").length));
}
