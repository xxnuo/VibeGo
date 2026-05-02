import {
  type BlockTermKeymap,
  type BlockTermKeymapAppAction,
  resolveBlockTermKeymapAction,
} from "./blockterm-keymap.ts";

export interface BlockTermAppKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface BlockTermAppShortcutOptions {
  macPlatform?: boolean;
}

export function isBlockTermMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/iu.test(navigator.platform || navigator.userAgent || "");
}

export function resolveBlockTermAppShortcut(
  event: BlockTermAppKeyEvent,
  keymap: BlockTermKeymap,
  options: BlockTermAppShortcutOptions = {}
): BlockTermKeymapAppAction | null {
  const macPlatform = options.macPlatform ?? isBlockTermMacPlatform();
  const result = resolveBlockTermKeymapAction(event, keymap, {
    scope: "app",
    portableCommand: false,
    allowCodeFallback: true,
    macPlatform,
  });
  return result?.scope === "app" ? result.action : null;
}
