import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { ProgressAddon } from "@xterm/addon-progress";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import { Check, ChevronDown, ChevronUp, Copy, X } from "lucide-react";
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";
import { fileApi } from "@/api/file";
import { type TerminalCapabilities, terminalApi } from "@/api/terminal";
import { decodeBase64Bytes } from "@/components/terminal/blockterm-model";
import { getResolvedTerminalFontFamily } from "@/components/terminal/fonts";
import TerminalSelectionMenu from "@/components/terminal/terminal-selection-menu";
import { useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import {
  armTerminalBrowserUnloadGuard,
  setTerminalBrowserShortcutFocus,
} from "@/services/terminal-browser-shortcut-guard";
import { notifyTerminal } from "@/services/terminal-notification-service";
import {
  readTerminalSessionCache,
  type TerminalLifecycleState,
  writeTerminalSessionCache,
} from "@/services/terminal-session-cache";
import { type Theme, useAppStore } from "@/stores";

export interface TerminalInstanceHandle {
  sendInput: (data: string) => void;
  getSelection: () => string;
  paste: (text: string) => void;
  pasteFromClipboard: () => Promise<boolean>;
  pasteImageFiles: (files: File[]) => Promise<boolean>;
  clearSelection: () => void;
  selectAll: () => void;
  focus: () => void;
}

export interface TerminalInstanceStateUpdate {
  capabilities?: TerminalCapabilities;
  currentCwd?: string;
  lastCommand?: string;
  lastCommandExitCode?: number | null;
  readonly?: boolean;
  runtimeType?: string;
  shellIntegration?: boolean;
  shellState?: string;
  shellType?: string;
  status?: string;
}

interface TerminalInstanceProps {
  terminalId: string;
  terminalName: string;
  isActive: boolean;
  isFocused?: boolean;
  isExited?: boolean;
  initialCwd?: string;
  onExited?: () => void;
  onStateChange?: (state: TerminalInstanceStateUpdate) => void;
}

interface CallbackRefs {
  isActive: boolean;
  isFocused: boolean;
  isExited: boolean;
  isReadonly: boolean;
  onExited?: () => void;
  terminalName: string;
  t: (key: string) => string;
}

interface ParsedTerminalNotification {
  body: string;
  title: string;
}

interface SelectionMenuState {
  left: number;
  top: number;
}

type TerminalDisposable = { dispose: () => void };

type TerminalShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "preventDefault" | "shiftKey" | "type"
>;

const TERMINAL_CTRL_SHORTCUT_KEYS = new Set(["a", "d", "h", "j", "k", "l", "n", "o", "p", "r", "s", "t", "u", "w"]);
const TERMINAL_ALT_SHORTCUT_KEYS = new Set(["ArrowLeft", "ArrowRight"]);
const TERMINAL_FUNCTION_SHORTCUT_KEYS = new Set(["F5"]);
const SELECTION_MENU_WIDTH = 216;
const SELECTION_MENU_HEIGHT = 44;
const SELECTION_MENU_MARGIN = 8;
const DEFAULT_TERMINAL_CAPABILITIES: TerminalCapabilities = {
  completion: false,
  durable: false,
  resume: true,
  shell_integration: false,
  snapshot: true,
};

const normalizeShortcutKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const shouldPreventTerminalBrowserShortcut = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">
): boolean => {
  const key = normalizeShortcutKey(event.key);
  if (event.metaKey) {
    return false;
  }
  if (event.ctrlKey && !event.altKey && !event.shiftKey && TERMINAL_CTRL_SHORTCUT_KEYS.has(key)) {
    return true;
  }
  if (!event.ctrlKey && event.altKey && TERMINAL_ALT_SHORTCUT_KEYS.has(key)) {
    return true;
  }
  if (!event.ctrlKey && !event.altKey && TERMINAL_FUNCTION_SHORTCUT_KEYS.has(key)) {
    return true;
  }
  return false;
};

const shouldArmTerminalUnloadGuard = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">
): boolean => {
  const key = normalizeShortcutKey(event.key);
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "w" || key === "r")) {
    return true;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "F5") {
    return true;
  }
  if (!event.ctrlKey && !event.metaKey && event.altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
    return true;
  }
  return false;
};

const getTerminalShortcutInput = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">
): string | null => {
  const key = normalizeShortcutKey(event.key);
  if (
    !event.metaKey &&
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    key.length === 1 &&
    key >= "a" &&
    key <= "z"
  ) {
    if (key === "f") {
      return null;
    }
    return String.fromCharCode(key.charCodeAt(0) - 96);
  }
  if (!event.ctrlKey && !event.metaKey && event.altKey && key === "ArrowLeft") {
    return "\u001b[1;3D";
  }
  if (!event.ctrlKey && !event.metaKey && event.altKey && key === "ArrowRight") {
    return "\u001b[1;3C";
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "F5") {
    return "\u001b[15~";
  }
  return null;
};

const shouldCopyTerminalSelection = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
  hasSelection: boolean
): boolean => {
  if (!hasSelection) {
    return false;
  }
  const key = normalizeShortcutKey(event.key);
  if (event.metaKey && !event.ctrlKey && !event.altKey && key === "c") {
    return true;
  }
  if (!event.metaKey && event.ctrlKey && !event.altKey && (key === "c" || key === "Insert")) {
    return true;
  }
  return false;
};

const shouldPasteIntoTerminal = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">
): boolean => {
  const key = normalizeShortcutKey(event.key);
  if (event.metaKey && !event.ctrlKey && !event.altKey && key === "v") {
    return true;
  }
  if (!event.metaKey && event.ctrlKey && !event.altKey && key === "v") {
    return true;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey && key === "Insert") {
    return true;
  }
  return false;
};

const shouldEnableTerminalWebgl = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches) {
    return false;
  }
  if (navigator.maxTouchPoints > 0) {
    return false;
  }
  return true;
};

const encodeUtf8Base64 = (data: string): string => {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const getXtermTheme = (appTheme: Theme): ITheme => {
  const isDark = appTheme !== "light";

  if (appTheme === "hacker") {
    return {
      background: "#0d0208",
      foreground: "#00ff41",
      cursor: "#00ff41",
      selectionBackground: "rgba(0, 255, 65, 0.3)",
      black: "#0d0208",
      red: "#ff0000",
      green: "#00ff41",
      yellow: "#008f11",
      blue: "#003b00",
      magenta: "#bd00ff",
      cyan: "#00fdff",
      white: "#00ff41",
      brightBlack: "#003b00",
      brightRed: "#ff3e3e",
      brightGreen: "#00ff41",
      brightYellow: "#008f11",
      brightBlue: "#003b00",
      brightMagenta: "#bd00ff",
      brightCyan: "#00fdff",
      brightWhite: "#ffffff",
    };
  }

  if (appTheme === "ocean") {
    return {
      background: "#0a1628",
      foreground: "#e0f2fe",
      cursor: "#22d3ee",
      selectionBackground: "rgba(34, 211, 238, 0.3)",
      black: "#0a1628",
      red: "#f472b6",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e0f2fe",
      brightBlack: "#1a3a5c",
      brightRed: "#fb7185",
      brightGreen: "#6ee7b7",
      brightYellow: "#fcd34d",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#ffffff",
    };
  }

  if (appTheme === "sunset") {
    return {
      background: "#1a0f0a",
      foreground: "#fef3c7",
      cursor: "#f59e0b",
      selectionBackground: "rgba(245, 158, 11, 0.3)",
      black: "#1a0f0a",
      red: "#fb7185",
      green: "#a3e635",
      yellow: "#f59e0b",
      blue: "#60a5fa",
      magenta: "#e879f9",
      cyan: "#22d3ee",
      white: "#fef3c7",
      brightBlack: "#4a2c1a",
      brightRed: "#fda4af",
      brightGreen: "#bef264",
      brightYellow: "#fbbf24",
      brightBlue: "#93c5fd",
      brightMagenta: "#f0abfc",
      brightCyan: "#67e8f9",
      brightWhite: "#ffffff",
    };
  }

  if (appTheme === "nord") {
    return {
      background: "#2e3440",
      foreground: "#eceff4",
      cursor: "#88c0d0",
      selectionBackground: "rgba(136, 192, 208, 0.3)",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    };
  }

  if (appTheme === "solarized") {
    return {
      background: "#002b36",
      foreground: "#fdf6e3",
      cursor: "#b58900",
      selectionBackground: "rgba(181, 137, 0, 0.3)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#859900",
      brightYellow: "#b58900",
      brightBlue: "#268bd2",
      brightMagenta: "#6c71c4",
      brightCyan: "#2aa198",
      brightWhite: "#fdf6e3",
    };
  }

  if (isDark) {
    return {
      background: "#18181b",
      foreground: "#d4d4d8",
      cursor: "#a1a1aa",
      selectionBackground: "rgba(161, 161, 170, 0.3)",
      black: "#18181b",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#3b82f6",
      magenta: "#a855f7",
      cyan: "#06b6d4",
      white: "#d4d4d8",
      brightBlack: "#52525b",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#facc15",
      brightBlue: "#60a5fa",
      brightMagenta: "#c084fc",
      brightCyan: "#22d3ee",
      brightWhite: "#ffffff",
    };
  }

  return {
    background: "#ffffff",
    foreground: "#18181b",
    cursor: "#52525b",
    selectionBackground: "rgba(82, 82, 91, 0.3)",
    black: "#000000",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#a855f7",
    cyan: "#06b6d4",
    white: "#a1a1aa",
    brightBlack: "#52525b",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#facc15",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#22d3ee",
    brightWhite: "#18181b",
  };
};

const parseOsc9Notification = (data: string, defaultTitle: string): ParsedTerminalNotification | null => {
  const body = data.trim();
  const title = defaultTitle.trim();
  if (!title || !body) {
    return null;
  }
  return { title, body };
};

const parseOsc777Notification = (data: string): ParsedTerminalNotification | null => {
  const [command = "", title = "", ...bodyParts] = data.split(";");
  if (command !== "notify") {
    return null;
  }

  const normalizedTitle = title.trim();
  const body = bodyParts.join(";").trim();
  if (!normalizedTitle || !body) {
    return null;
  }

  return { title: normalizedTitle, body };
};

const decodeBase64Utf8 = (value: string): string => {
  return new TextDecoder().decode(decodeBase64Bytes(value));
};

const parseOsc7Path = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") {
      return null;
    }
    let path = decodeURIComponent(url.pathname);
    if (path.startsWith("//")) {
      path = path.slice(1);
    }
    if (/^\/[a-zA-Z]:[\\/]/.test(path)) {
      path = path.slice(1).replace(/\\/g, "/");
    }
    if (path.startsWith("/\\\\")) {
      path = path.slice(1);
    }
    return path || null;
  } catch {
    return null;
  }
};

const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

const getImageExtension = (file: File): string => {
  const fromMime = MIME_EXTENSION_MAP[file.type.toLowerCase()];
  if (fromMime) {
    return fromMime;
  }
  const match = file.name.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() || "png";
};

const getPasteTimestamp = (): string => {
  const date = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const createPastedImageFileName = (file: File, index: number): string => {
  const ext = getImageExtension(file);
  const random = Math.random().toString(36).slice(2, 8);
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `vibego-paste-${getPasteTimestamp()}-${random}${suffix}.${ext}`;
};

const joinPath = (base: string, path: string): string => {
  const trimmedBase = base.trim() || ".";
  if (trimmedBase === "." || trimmedBase === "/") {
    return trimmedBase === "/" ? `/${path}` : path;
  }
  return `${trimmedBase.replace(/[\\/]+$/, "")}/${path}`;
};

const TerminalInstance = React.forwardRef<TerminalInstanceHandle, TerminalInstanceProps>(
  (
    { terminalId, terminalName, isActive, isFocused = isActive, isExited = false, initialCwd, onExited, onStateChange },
    ref
  ) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    const oscHandlersRef = useRef<TerminalDisposable[]>([]);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectAttemptsRef = useRef(0);
    const wasOpenRef = useRef(false);
    const initializedRef = useRef(false);
    const isUnmountingRef = useRef(false);
    const lastCursorRef = useRef(0);
    const lastAckCursorRef = useRef(0);
    const replayServerDoneRef = useRef(false);
    const pendingReplayWritesRef = useRef(0);
    const inputReadyRef = useRef(false);
    const lifecycleRef = useRef<TerminalLifecycleState>(isExited ? "exited" : "hydrating");
    const cacheHydratedRef = useRef(false);
    const cacheSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedCursorRef = useRef(0);
    const readonlyRef = useRef(isExited);
    const capabilitiesRef = useRef<TerminalCapabilities>(DEFAULT_TERMINAL_CAPABILITIES);
    const onStateChangeRef = useRef<TerminalInstanceProps["onStateChange"]>(onStateChange);
    const currentCwdRef = useRef(initialCwd || "");
    const initialCwdRef = useRef(initialCwd || "");
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const callbacksRef = useRef<CallbackRefs>({
      isActive,
      isFocused,
      isExited,
      isReadonly: isExited,
      onExited,
      terminalName,
      t: (key: string) => key,
    });

    const [searchVisible, setSearchVisible] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [searchRegex, setSearchRegex] = useState(false);
    const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const searchVisibleRef = useRef(false);
    const openSearchRef = useRef<() => void>(() => {});
    const closeSearchRef = useRef<() => void>(() => {});
    const selectionAnchorRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const selectionMenuFrameRef = useRef<number | null>(null);

    const [progress, setProgress] = useState<{ value: number; state: 0 | 1 | 2 | 3 | 4 } | null>(null);
    const [copySuccess, setCopySuccess] = useState(false);
    const [lifecycleState, setLifecycleState] = useState<TerminalLifecycleState>(isExited ? "exited" : "hydrating");
    const progressAddonRef = useRef<ProgressAddon | null>(null);

    const theme = useAppStore((s) => s.theme);
    const locale = useAppStore((s) => s.locale);
    const terminalFontFamily = useSettingsStore((s) => s.settings.terminalFontFamily);
    const terminalFontFallbackFamily = useSettingsStore((s) => s.settings.terminalFontFallbackFamily);
    const t = useTranslation(locale);

    useEffect(() => {
      onStateChangeRef.current = onStateChange;
    }, [onStateChange]);

    useEffect(() => {
      initialCwdRef.current = initialCwd || "";
      if (!currentCwdRef.current && initialCwd) {
        currentCwdRef.current = initialCwd;
      }
    }, [initialCwd]);

    const disposeOscHandlers = () => {
      oscHandlersRef.current.forEach((handler) => handler.dispose());
      oscHandlersRef.current = [];
    };

    const updateRuntimeInfo = useCallback(
      (patch: Parameters<typeof terminalApi.updateRuntimeInfo>[1]) => {
        void terminalApi.updateRuntimeInfo(terminalId, patch).catch(() => {});
      },
      [terminalId]
    );

    const emitStateChange = useCallback((state: TerminalInstanceStateUpdate) => {
      if (state.currentCwd !== undefined) {
        currentCwdRef.current = state.currentCwd;
      }
      onStateChangeRef.current?.(state);
    }, []);

    const setLifecycle = useCallback((next: TerminalLifecycleState) => {
      lifecycleRef.current = next;
      setLifecycleState(next);
    }, []);

    const clearCacheSaveTimer = useCallback(() => {
      if (cacheSaveTimerRef.current) {
        clearTimeout(cacheSaveTimerRef.current);
        cacheSaveTimerRef.current = null;
      }
    }, []);

    const persistTerminalCache = useCallback(async () => {
      const terminal = terminalRef.current;
      const serializeAddon = serializeAddonRef.current;
      if (!terminal || !serializeAddon || !cacheHydratedRef.current) {
        return;
      }
      if (capabilitiesRef.current.snapshot === false) {
        return;
      }
      const serialized = serializeAddon.serialize();
      if (!serialized) {
        return;
      }
      await writeTerminalSessionCache({
        terminalId,
        serialized,
        cursor: lastCursorRef.current,
        cols: terminal.cols,
        rows: terminal.rows,
        status: callbacksRef.current.isExited ? "exited" : "running",
        updatedAt: Date.now(),
      });
      lastSavedCursorRef.current = lastCursorRef.current;
    }, [terminalId]);

    const scheduleCacheSave = useCallback(
      (force = false) => {
        if (!cacheHydratedRef.current) {
          return;
        }
        if (capabilitiesRef.current.snapshot === false) {
          return;
        }
        if (!force && Math.max(0, lastCursorRef.current - lastSavedCursorRef.current) < 64 * 1024) {
          return;
        }
        clearCacheSaveTimer();
        cacheSaveTimerRef.current = setTimeout(
          () => {
            cacheSaveTimerRef.current = null;
            void persistTerminalCache();
          },
          force ? 0 : 5000
        );
      },
      [clearCacheSaveTimer, persistTerminalCache]
    );

    const handleOscNotification = useCallback(
      (data: string, parser: (value: string) => ParsedTerminalNotification | null) => {
        if (!inputReadyRef.current) {
          return true;
        }

        const notification = parser(data);
        if (!notification) {
          return true;
        }

        const currentCallbacks = callbacksRef.current;
        if (currentCallbacks.isExited || currentCallbacks.isReadonly) {
          return true;
        }

        notifyTerminal({
          body: notification.body,
          isActive: currentCallbacks.isFocused,
          terminalId,
          title: notification.title,
        });

        return true;
      },
      [terminalId]
    );

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const cancelSelectionMenuFrame = useCallback(() => {
      if (selectionMenuFrameRef.current !== null) {
        cancelAnimationFrame(selectionMenuFrameRef.current);
        selectionMenuFrameRef.current = null;
      }
    }, []);

    const hideSelectionMenu = useCallback(() => {
      cancelSelectionMenuFrame();
      setSelectionMenu(null);
    }, [cancelSelectionMenuFrame]);

    const clearTerminalSelection = useCallback(() => {
      terminalRef.current?.clearSelection();
      hideSelectionMenu();
    }, [hideSelectionMenu]);

    const getDomSelectionRect = useCallback((): DOMRect | null => {
      const wrapper = wrapperRef.current;
      if (!wrapper) {
        return null;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
      }
      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      if (!(ancestor instanceof Node) || !wrapper.contains(ancestor)) {
        return null;
      }
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
      if (rects.length === 0) {
        return null;
      }
      const wrapperRect = wrapper.getBoundingClientRect();
      const visibleRects = rects.filter(
        (rect) =>
          rect.bottom >= wrapperRect.top &&
          rect.top <= wrapperRect.bottom &&
          rect.right >= wrapperRect.left &&
          rect.left <= wrapperRect.right
      );
      if (visibleRects.length === 0) {
        return null;
      }
      const left = Math.min(...visibleRects.map((rect) => rect.left));
      const right = Math.max(...visibleRects.map((rect) => rect.right));
      const top = Math.min(...visibleRects.map((rect) => rect.top));
      const bottom = Math.max(...visibleRects.map((rect) => rect.bottom));
      return new DOMRect(left, top, right - left, bottom - top);
    }, []);

    const getTerminalSelectionRect = useCallback((terminal: Terminal): DOMRect | null => {
      const screenElement = containerRef.current?.querySelector(".xterm-screen");
      if (!(screenElement instanceof HTMLElement)) {
        return null;
      }
      const selection = terminal.getSelectionPosition();
      if (!selection) {
        return null;
      }
      const screenRect = screenElement.getBoundingClientRect();
      const cellWidth = screenRect.width / Math.max(terminal.cols, 1);
      const cellHeight = screenRect.height / Math.max(terminal.rows, 1);
      if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) {
        return null;
      }
      const viewportY = terminal.buffer.active.viewportY;
      const startRow = selection.start.y - viewportY;
      const endRow = selection.end.y - viewportY;
      if (endRow < 0 || startRow > terminal.rows - 1) {
        return null;
      }
      const visibleRow = clamp(startRow, 0, terminal.rows - 1);
      const top = screenRect.top + visibleRow * cellHeight;
      const bottom = top + cellHeight;
      if (startRow === endRow && startRow >= 0 && startRow < terminal.rows) {
        const startCol = clamp(selection.start.x, 0, terminal.cols - 1);
        const endCol = clamp(Math.max(selection.end.x, selection.start.x + 1), 1, terminal.cols);
        const left = screenRect.left + startCol * cellWidth;
        const right = screenRect.left + endCol * cellWidth;
        return new DOMRect(left, top, Math.max(right - left, cellWidth), bottom - top);
      }
      const left = screenRect.left + clamp(selection.start.x, 0, terminal.cols - 1) * cellWidth;
      return new DOMRect(left, top, Math.max(screenRect.right - left, cellWidth), bottom - top);
    }, []);

    const updateSelectionMenu = useCallback(() => {
      const wrapper = wrapperRef.current;
      const terminal = terminalRef.current;
      if (!wrapper || !terminal || !terminal.hasSelection()) {
        setSelectionMenu(null);
        return;
      }
      const selectionText = terminal.getSelection();
      if (!selectionText) {
        setSelectionMenu(null);
        return;
      }
      const wrapperRect = wrapper.getBoundingClientRect();
      const selectionRect = getDomSelectionRect() ?? getTerminalSelectionRect(terminal);
      const fallbackX = selectionAnchorRef.current?.clientX ?? wrapperRect.left + wrapperRect.width / 2;
      const fallbackY = selectionAnchorRef.current?.clientY ?? wrapperRect.top + wrapperRect.height / 2;
      const anchorX = selectionRect ? selectionRect.left + selectionRect.width / 2 : fallbackX;
      const anchorTop = selectionRect ? selectionRect.top : fallbackY;
      const anchorBottom = selectionRect ? selectionRect.bottom : fallbackY;
      const halfWidth = SELECTION_MENU_WIDTH / 2;
      const leftMin = Math.min(halfWidth + SELECTION_MENU_MARGIN, wrapperRect.width / 2);
      const leftMax = Math.max(wrapperRect.width - halfWidth - SELECTION_MENU_MARGIN, leftMin);
      const left = clamp(anchorX - wrapperRect.left, leftMin, leftMax);
      let top = anchorTop - wrapperRect.top - SELECTION_MENU_HEIGHT - 10;
      if (top < SELECTION_MENU_MARGIN) {
        top = anchorBottom - wrapperRect.top + 10;
      }
      const maxTop = Math.max(
        wrapperRect.height - SELECTION_MENU_HEIGHT - SELECTION_MENU_MARGIN,
        SELECTION_MENU_MARGIN
      );
      setSelectionMenu({
        left,
        top: clamp(top, SELECTION_MENU_MARGIN, maxTop),
      });
    }, [getDomSelectionRect, getTerminalSelectionRect]);

    const queueSelectionMenuUpdate = useCallback(() => {
      cancelSelectionMenuFrame();
      selectionMenuFrameRef.current = requestAnimationFrame(() => {
        selectionMenuFrameRef.current = null;
        updateSelectionMenu();
      });
    }, [cancelSelectionMenuFrame, updateSelectionMenu]);

    const connectWebSocket = useCallback(
      (terminal: Terminal) => {
        clearReconnectTimer();
        setLifecycle(cacheHydratedRef.current ? "replaying" : "hydrating");

        if (wsRef.current) {
          const prev = wsRef.current;
          wsRef.current = null;
          prev.onopen = null;
          prev.onmessage = null;
          prev.onclose = null;
          prev.onerror = null;
          try {
            prev.close();
          } catch {}
        }

        replayServerDoneRef.current = false;
        pendingReplayWritesRef.current = 0;
        inputReadyRef.current = false;
        terminal.options.cursorBlink = false;
        terminal.options.disableStdin = true;

        const cursor = lastAckCursorRef.current > 0 ? lastAckCursorRef.current : undefined;
        const wsUrl = terminalApi.wsUrl(terminalId, cursor);
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        const sendAck = (cursorValue: number) => {
          if (!Number.isFinite(cursorValue) || cursorValue <= lastAckCursorRef.current) {
            return;
          }
          lastAckCursorRef.current = cursorValue;
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "ack", cursor: cursorValue }));
            } catch {}
          }
        };

        const tryEnableInput = () => {
          if (!replayServerDoneRef.current) return;
          if (pendingReplayWritesRef.current > 0) return;
          if (callbacksRef.current.isExited) return;
          if (readonlyRef.current) return;
          if (inputReadyRef.current) return;
          inputReadyRef.current = true;
          terminal.options.cursorBlink = true;
          terminal.options.disableStdin = false;
          setLifecycle("live");
          if (callbacksRef.current.isFocused) {
            terminal.focus();
          }
        };

        ws.onopen = () => {
          if (wsRef.current !== ws) return;
          wasOpenRef.current = true;
          reconnectAttemptsRef.current = 0;
          if (terminalRef.current && fitAddonRef.current) {
            fitAddonRef.current.fit();
            const { cols, rows } = terminalRef.current;
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        };

        ws.onmessage = (event) => {
          if (wsRef.current !== ws) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "replay" || msg.type === "output") {
              const hasCursor = typeof msg.cursor === "number" && Number.isFinite(msg.cursor);
              const cursorValue = hasCursor ? msg.cursor : undefined;
              if (cursorValue !== undefined && !msg.reset && cursorValue <= lastCursorRef.current) {
                return;
              }
              if (msg.reset) {
                terminal.reset();
                pendingReplayWritesRef.current = 0;
                lastSavedCursorRef.current = 0;
              }

              let hasOutput = false;
              try {
                if (typeof msg.data === "string" && msg.data.length > 0) {
                  const bytes = decodeBase64Bytes(msg.data);
                  hasOutput = bytes.length > 0;
                  if (hasOutput && msg.type === "replay") {
                    pendingReplayWritesRef.current += 1;
                  }
                  terminal.write(bytes, () => {
                    if (cursorValue !== undefined) {
                      lastCursorRef.current = cursorValue;
                      sendAck(cursorValue);
                      scheduleCacheSave();
                    }
                    if (hasOutput && msg.type === "replay") {
                      pendingReplayWritesRef.current = Math.max(0, pendingReplayWritesRef.current - 1);
                    }
                    tryEnableInput();
                  });
                }
              } catch (e) {
                console.warn("Failed to decode base64:", e);
              }
              if (!hasOutput && cursorValue !== undefined) {
                lastCursorRef.current = cursorValue;
                sendAck(cursorValue);
                scheduleCacheSave();
              }
            } else if (msg.type === "replay_done") {
              replayServerDoneRef.current = true;
              cacheHydratedRef.current = true;
              tryEnableInput();
              scheduleCacheSave(true);
            } else if (msg.type === "state") {
              if (typeof msg.cursor === "number" && Number.isFinite(msg.cursor) && msg.cursor > lastCursorRef.current) {
                lastCursorRef.current = msg.cursor;
              }
              if (typeof msg.current_cwd === "string") {
                currentCwdRef.current = msg.current_cwd;
              }
              readonlyRef.current = !!msg.readonly || msg.status !== "running";
              capabilitiesRef.current = (msg.capabilities || capabilitiesRef.current) as TerminalCapabilities;
              emitStateChange({
                capabilities: capabilitiesRef.current,
                currentCwd: typeof msg.current_cwd === "string" ? msg.current_cwd : undefined,
                lastCommand: typeof msg.last_command === "string" ? msg.last_command : undefined,
                lastCommandExitCode: typeof msg.last_command_exit_code === "number" ? msg.last_command_exit_code : null,
                readonly: readonlyRef.current,
                runtimeType: typeof msg.runtime_type === "string" ? msg.runtime_type : undefined,
                shellIntegration: typeof msg.shell_integration === "boolean" ? msg.shell_integration : undefined,
                shellState: typeof msg.shell_state === "string" ? msg.shell_state : undefined,
                shellType: typeof msg.shell_type === "string" ? msg.shell_type : undefined,
                status: typeof msg.status === "string" ? msg.status : undefined,
              });
              if (typeof msg.status === "string" && msg.status !== "running") {
                terminal.options.cursorBlink = false;
                terminal.options.disableStdin = true;
                callbacksRef.current.isExited = true;
                inputReadyRef.current = false;
                setLifecycle("exited");
                scheduleCacheSave(true);
              }
            } else if (msg.type === "pty_exited") {
              const { t: translate, onExited: exitCallback } = callbacksRef.current;
              terminal.write(`\r\n[${translate("terminal.processExited")}]\r\n`);
              terminal.options.cursorBlink = false;
              terminal.options.disableStdin = true;
              callbacksRef.current.isExited = true;
              readonlyRef.current = true;
              inputReadyRef.current = false;
              setLifecycle("exited");
              scheduleCacheSave(true);
              clearReconnectTimer();
              try {
                ws.close();
              } catch {}
              exitCallback?.();
            }
          } catch (e) {
            console.warn("Failed to parse WebSocket message:", e);
          }
        };

        ws.onclose = () => {
          if (wsRef.current !== ws) return;
          wsRef.current = null;
          inputReadyRef.current = false;
          if (isUnmountingRef.current) return;
          if (callbacksRef.current.isExited) return;

          if (wasOpenRef.current) {
            wasOpenRef.current = false;
            const { t: translate } = callbacksRef.current;
            terminal.write(`\r\n[${translate("terminal.connectionClosed")}]\r\n`);
          }

          terminal.options.cursorBlink = false;
          terminal.options.disableStdin = true;
          setLifecycle("reconnecting");

          const attempt = reconnectAttemptsRef.current;
          reconnectAttemptsRef.current = attempt + 1;
          const baseDelay = 400;
          const maxDelay = 10_000;
          const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
          reconnectTimerRef.current = setTimeout(() => {
            if (isUnmountingRef.current) return;
            if (callbacksRef.current.isExited) return;
            connectWebSocket(terminal);
          }, delay);
        };

        ws.onerror = () => {
          if (wsRef.current !== ws) return;
          const { t: translate } = callbacksRef.current;
          terminal.write(`\r\n[${translate("terminal.connectionError")}]\r\n`);
          try {
            ws.close();
          } catch {}
        };
      },
      [scheduleCacheSave, setLifecycle, terminalId]
    );

    const openSearch = useCallback(() => {
      hideSelectionMenu();
      setSearchVisible(true);
      searchVisibleRef.current = true;
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }, [hideSelectionMenu]);

    const closeSearch = useCallback(() => {
      setSearchVisible(false);
      searchVisibleRef.current = false;
      terminalRef.current?.focus();
    }, []);

    openSearchRef.current = openSearch;
    closeSearchRef.current = closeSearch;

    const handleSearchNext = useCallback(() => {
      if (!searchAddonRef.current || !searchTerm) return;
      searchAddonRef.current.findNext(searchTerm, { caseSensitive: searchCaseSensitive, regex: searchRegex });
    }, [searchTerm, searchCaseSensitive, searchRegex]);

    const handleSearchPrev = useCallback(() => {
      if (!searchAddonRef.current || !searchTerm) return;
      searchAddonRef.current.findPrevious(searchTerm, { caseSensitive: searchCaseSensitive, regex: searchRegex });
    }, [searchTerm, searchCaseSensitive, searchRegex]);

    const syncBrowserShortcutFocus = useCallback(() => {
      const hasFocusedTerminalInput =
        isFocused &&
        !!wrapperRef.current &&
        document.activeElement instanceof Node &&
        wrapperRef.current.contains(document.activeElement);
      setTerminalBrowserShortcutFocus(terminalId, hasFocusedTerminalInput);
    }, [isFocused, terminalId]);

    const sendTerminalInput = useCallback(
      (data: string) => {
        if (callbacksRef.current.isExited || callbacksRef.current.isReadonly) return;
        if (!inputReadyRef.current) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        hideSelectionMenu();
        wsRef.current.send(
          JSON.stringify({
            type: "input",
            data: encodeUtf8Base64(data),
          })
        );
      },
      [hideSelectionMenu]
    );

    const pasteTextFromClipboard = useCallback(async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && terminalRef.current) {
          terminalRef.current.paste(text);
          return true;
        }
      } catch {}
      return false;
    }, []);

    const pasteImageFiles = useCallback(
      async (files: File[]) => {
        const images = files.filter((file) => file.type.startsWith("image/"));
        if (images.length === 0) {
          return false;
        }
        const targetDir = joinPath(currentCwdRef.current || initialCwdRef.current || ".", ".vibego/pasted-images");
        const toastId = `terminal-paste-image-${terminalId}`;
        toast.loading(t("terminal.pasteImageUploading"), { id: toastId });
        try {
          const entries = images.map((file, index) => ({
            file,
            relativePath: createPastedImageFileName(file, index),
          }));
          const result = await fileApi.upload(targetDir, entries, { overwrite: false });
          if (!result.uploaded.length) {
            throw new Error(result.errors?.join("\n") || t("terminal.pasteImageFailed"));
          }
          terminalRef.current?.paste(result.uploaded.join(" "));
          toast.success(t("terminal.pasteImageInserted"), { id: toastId });
          return true;
        } catch (e) {
          toast.error(e instanceof Error ? e.message : t("terminal.pasteImageFailed"), { id: toastId });
          return false;
        }
      },
      [t, terminalId]
    );

    const readClipboardImages = useCallback(async (): Promise<File[] | null> => {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
        return null;
      }
      try {
        const items = await navigator.clipboard.read();
        const files: File[] = [];
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith("image/"));
          if (!imageType) {
            continue;
          }
          const blob = await item.getType(imageType);
          files.push(new File([blob], `clipboard.${MIME_EXTENSION_MAP[imageType] || "png"}`, { type: imageType }));
        }
        return files;
      } catch {
        return null;
      }
    }, []);

    const pasteFromClipboard = useCallback(async () => {
      const images = await readClipboardImages();
      if (images && images.length > 0) {
        return pasteImageFiles(images);
      }
      return pasteTextFromClipboard();
    }, [pasteImageFiles, pasteTextFromClipboard, readClipboardImages]);

    const pasteFromClipboardOrPicker = useCallback(async () => {
      const images = await readClipboardImages();
      if (images && images.length > 0) {
        return pasteImageFiles(images);
      }
      const pastedText = await pasteTextFromClipboard();
      if (pastedText || images) {
        return pastedText;
      }
      fileInputRef.current?.click();
      return false;
    }, [pasteImageFiles, pasteTextFromClipboard, readClipboardImages]);

    useImperativeHandle(
      ref,
      () => ({
        sendInput: sendTerminalInput,
        getSelection: () => terminalRef.current?.getSelection() ?? "",
        paste: (text: string) => {
          if (callbacksRef.current.isExited || callbacksRef.current.isReadonly) return;
          if (terminalRef.current) terminalRef.current.paste(text);
        },
        pasteFromClipboard: pasteFromClipboardOrPicker,
        pasteImageFiles,
        clearSelection: () => clearTerminalSelection(),
        selectAll: () => {
          const terminal = terminalRef.current;
          if (terminal) terminal.selectAll();
        },
        focus: () => terminalRef.current?.focus(),
      }),
      [sendTerminalInput, pasteFromClipboardOrPicker, pasteImageFiles, clearTerminalSelection]
    );

    const handleSelectionCopy = useCallback(() => {
      const text = terminalRef.current?.getSelection();
      if (!text) {
        hideSelectionMenu();
        return;
      }
      void navigator.clipboard.writeText(text).catch(() => {});
      clearTerminalSelection();
      terminalRef.current?.focus();
    }, [clearTerminalSelection, hideSelectionMenu]);

    const handleSelectionSearch = useCallback(() => {
      const text = terminalRef.current?.getSelection();
      if (!text) {
        hideSelectionMenu();
        return;
      }
      setSearchTerm(text);
      clearTerminalSelection();
      openSearchRef.current();
    }, [clearTerminalSelection, hideSelectionMenu]);

    const isFocusInsideInstance = useCallback(
      (target: EventTarget | null) => {
        if (!isFocused || !wrapperRef.current) {
          return false;
        }
        if (target instanceof Node && wrapperRef.current.contains(target)) {
          return true;
        }
        const activeElement = document.activeElement;
        return activeElement instanceof Node && wrapperRef.current.contains(activeElement);
      },
      [isFocused]
    );

    useEffect(() => {
      const handleWindowKeyDown = (event: KeyboardEvent) => {
        if (!isFocusInsideInstance(event.target)) {
          return;
        }
        const key = normalizeShortcutKey(event.key);
        if ((event.ctrlKey || event.metaKey) && key === "f") {
          event.preventDefault();
          return;
        }
        if (shouldArmTerminalUnloadGuard(event)) {
          armTerminalBrowserUnloadGuard();
        }
        if (shouldPreventTerminalBrowserShortcut(event)) {
          event.preventDefault();
        }
      };

      window.addEventListener("keydown", handleWindowKeyDown, true);
      return () => window.removeEventListener("keydown", handleWindowKeyDown, true);
    }, [isFocusInsideInstance]);

    useEffect(() => {
      syncBrowserShortcutFocus();
      return () => setTerminalBrowserShortcutFocus(terminalId, false);
    }, [syncBrowserShortcutFocus, terminalId]);

    useEffect(() => {
      if (!selectionMenu) {
        return;
      }
      const handleResize = () => queueSelectionMenuUpdate();
      const handleSelectionChange = () => queueSelectionMenuUpdate();
      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) {
          hideSelectionMenu();
          return;
        }
        if (wrapperRef.current?.contains(target)) {
          return;
        }
        hideSelectionMenu();
      };
      window.addEventListener("resize", handleResize);
      document.addEventListener("selectionchange", handleSelectionChange);
      window.addEventListener("pointerdown", handlePointerDown, true);
      return () => {
        window.removeEventListener("resize", handleResize);
        document.removeEventListener("selectionchange", handleSelectionChange);
        window.removeEventListener("pointerdown", handlePointerDown, true);
      };
    }, [hideSelectionMenu, queueSelectionMenuUpdate, selectionMenu]);

    useEffect(() => {
      callbacksRef.current = {
        isActive,
        isFocused,
        isExited,
        isReadonly: readonlyRef.current,
        onExited,
        terminalName,
        t,
      };
      if (isExited && terminalRef.current) {
        terminalRef.current.options.cursorBlink = false;
        terminalRef.current.options.disableStdin = true;
        readonlyRef.current = true;
        setLifecycle("exited");
      }
      if (isExited) {
        inputReadyRef.current = false;
        clearReconnectTimer();
        if (wsRef.current) {
          const ws = wsRef.current;
          wsRef.current = null;
          ws.onopen = null;
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          try {
            ws.close();
          } catch {}
        }
      }
    }, [isActive, isFocused, isExited, onExited, setLifecycle, t, terminalName]);

    useEffect(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = getXtermTheme(theme);
      }
    }, [theme]);

    useEffect(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal) return;
      terminal.options.fontFamily = getResolvedTerminalFontFamily(terminalFontFamily, terminalFontFallbackFamily);
      requestAnimationFrame(() => fitAddon?.fit());
    }, [terminalFontFamily, terminalFontFallbackFamily]);

    useEffect(() => {
      if (!searchAddonRef.current || !searchTerm) return;
      searchAddonRef.current.findNext(searchTerm, { caseSensitive: searchCaseSensitive, regex: searchRegex });
    }, [searchTerm, searchCaseSensitive, searchRegex]);

    useEffect(() => {
      if (!containerRef.current || initializedRef.current) return;

      initializedRef.current = true;
      isUnmountingRef.current = false;
      lastCursorRef.current = 0;
      lastAckCursorRef.current = 0;
      replayServerDoneRef.current = false;
      pendingReplayWritesRef.current = 0;
      inputReadyRef.current = false;
      lastSavedCursorRef.current = 0;
      cacheHydratedRef.current = false;
      readonlyRef.current = isExited;
      capabilitiesRef.current = DEFAULT_TERMINAL_CAPABILITIES;
      setLifecycle(isExited ? "exited" : "hydrating");

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: getResolvedTerminalFontFamily(terminalFontFamily, terminalFontFallbackFamily),
        theme: getXtermTheme(theme),
        scrollback: 5000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      const serializeAddon = new SerializeAddon();
      const unicode11Addon = new Unicode11Addon();
      const webLinksAddon = new WebLinksAddon();
      const clipboardAddon = new ClipboardAddon();
      const imageAddon = new ImageAddon();
      const progressAddon = new ProgressAddon();

      terminal.loadAddon(unicode11Addon);
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.loadAddon(serializeAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.loadAddon(clipboardAddon);
      terminal.loadAddon(imageAddon);
      terminal.loadAddon(progressAddon);

      progressAddon.onChange((p) => {
        if (p.state === 0) {
          setProgress(null);
        } else {
          setProgress({ value: p.value, state: p.state });
        }
      });

      terminal.open(containerRef.current);
      terminal.textarea?.setAttribute("id", `terminal-input-${terminalId}`);
      terminal.textarea?.setAttribute("name", `terminal-input-${terminalId}`);
      terminal.unicode.activeVersion = "11";

      if (shouldEnableTerminalWebgl()) {
        try {
          const webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
          });
          terminal.loadAddon(webglAddon);
          try {
            const ligaturesAddon = new LigaturesAddon();
            terminal.loadAddon(ligaturesAddon);
          } catch {}
        } catch {}
      }

      fitAddon.fit();

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      serializeAddonRef.current = serializeAddon;
      progressAddonRef.current = progressAddon;

      void readTerminalSessionCache(terminalId).then((cache) => {
        if (isUnmountingRef.current) {
          return;
        }
        if (!cache?.serialized) {
          cacheHydratedRef.current = true;
          connectWebSocket(terminal);
          return;
        }
        terminal.write(cache.serialized, () => {
          lastCursorRef.current = cache.cursor;
          lastAckCursorRef.current = cache.cursor;
          lastSavedCursorRef.current = cache.cursor;
          cacheHydratedRef.current = true;
          setLifecycle("replaying");
          connectWebSocket(terminal);
        });
      });

      oscHandlersRef.current = [
        terminal.parser.registerOscHandler(7, (data) => {
          const cwd = parseOsc7Path(data);
          if (cwd) {
            updateRuntimeInfo({ current_cwd: cwd });
            emitStateChange({ currentCwd: cwd });
          }
          return true;
        }),
        terminal.parser.registerOscHandler(52, (data) => {
          if (!document.hasFocus()) {
            return true;
          }
          const separatorIndex = data.indexOf(";");
          if (separatorIndex === -1) {
            return true;
          }
          const base64Data = data.slice(separatorIndex + 1).replace(/\s+/g, "");
          if (!base64Data || base64Data === "?" || base64Data.length > 128 * 1024) {
            return true;
          }
          try {
            const text = decodeBase64Utf8(base64Data);
            if (new TextEncoder().encode(text).length > 75 * 1024) {
              return true;
            }
            void navigator.clipboard.writeText(text).catch(() => {});
          } catch {}
          return true;
        }),
        terminal.parser.registerOscHandler(16162, (data) => {
          const [command = "", ...rest] = data.split(";");
          let payload: Record<string, unknown> = {};
          if (rest.length > 0) {
            try {
              payload = JSON.parse(rest.join(";")) as Record<string, unknown>;
            } catch {}
          }
          if (command === "A") {
            updateRuntimeInfo({ shell_state: "ready", shell_integration: true });
            emitStateChange({ shellIntegration: true, shellState: "ready" });
          } else if (command === "C") {
            let lastCommand: string | undefined;
            if (typeof payload.cmd64 === "string") {
              try {
                lastCommand = decodeBase64Utf8(payload.cmd64);
              } catch {}
            }
            updateRuntimeInfo({
              shell_state: "running-command",
              shell_integration: true,
              last_command: lastCommand,
            });
            emitStateChange({
              lastCommand,
              shellIntegration: true,
              shellState: "running-command",
            });
          } else if (command === "M") {
            const shellType = typeof payload.shell === "string" ? payload.shell : undefined;
            const shellIntegration = typeof payload.integration === "boolean" ? payload.integration : true;
            updateRuntimeInfo({
              shell_type: shellType,
              shell_integration: shellIntegration,
            });
            emitStateChange({ shellIntegration, shellType });
          } else if (command === "D") {
            const lastCommandExitCode =
              typeof payload.exitcode === "number" && Number.isFinite(payload.exitcode) ? payload.exitcode : null;
            updateRuntimeInfo({
              shell_state: "ready",
              last_command_exit_code: lastCommandExitCode,
            });
            emitStateChange({ lastCommandExitCode, shellState: "ready" });
          } else if (command === "R") {
            updateRuntimeInfo({ shell_state: "", shell_integration: false });
            emitStateChange({ shellIntegration: false, shellState: "" });
          }
          return true;
        }),
        terminal.parser.registerOscHandler(9, (data) => {
          const defaultTitle = callbacksRef.current.terminalName.trim() || callbacksRef.current.t("sidebar.terminal");
          return handleOscNotification(data, (value) => parseOsc9Notification(value, defaultTitle));
        }),
        terminal.parser.registerOscHandler(777, (data) => {
          return handleOscNotification(data, parseOsc777Notification);
        }),
      ];

      terminal.attachCustomKeyEventHandler((event) => {
        const key = normalizeShortcutKey(event.key);
        if ((event.ctrlKey || event.metaKey) && key === "f" && event.type === "keydown") {
          event.preventDefault();
          openSearchRef.current();
          return false;
        }
        if (event.type === "keydown" && shouldArmTerminalUnloadGuard(event)) {
          armTerminalBrowserUnloadGuard();
        }
        if (event.type === "keydown" && shouldCopyTerminalSelection(event, terminal.hasSelection())) {
          const selection = terminal.getSelection();
          if (selection) {
            event.preventDefault();
            hideSelectionMenu();
            void navigator.clipboard.writeText(selection).catch(() => {});
            return false;
          }
        }
        if (event.type === "keydown" && shouldPasteIntoTerminal(event)) {
          event.preventDefault();
          void pasteFromClipboard();
          return false;
        }
        const manualInput = event.type === "keydown" ? getTerminalShortcutInput(event) : null;
        if (manualInput) {
          event.preventDefault();
          sendTerminalInput(manualInput);
          return false;
        }
        if (shouldPreventTerminalBrowserShortcut(event as TerminalShortcutEvent)) {
          event.preventDefault();
        }
        if (event.key === "Escape" && event.type === "keydown" && searchVisibleRef.current) {
          closeSearchRef.current();
          return false;
        }
        return true;
      });

      terminal.onSelectionChange(() => {
        queueSelectionMenuUpdate();
      });

      terminal.onScroll(() => {
        if (terminal.hasSelection()) {
          queueSelectionMenuUpdate();
        } else {
          hideSelectionMenu();
        }
      });

      terminal.onData((data) => {
        if (callbacksRef.current.isExited) return;
        if (!inputReadyRef.current) return;
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const msg = {
            type: "input",
            data: encodeUtf8Base64(data),
          };
          wsRef.current.send(JSON.stringify(msg));
        }
      });

      return () => {
        isUnmountingRef.current = true;
        inputReadyRef.current = false;
        cancelSelectionMenuFrame();
        clearReconnectTimer();
        clearCacheSaveTimer();
        void persistTerminalCache();
        if (wsRef.current) {
          const ws = wsRef.current;
          wsRef.current = null;
          ws.onopen = null;
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          try {
            ws.close();
          } catch {}
        }
        disposeOscHandlers();
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        serializeAddonRef.current = null;
        progressAddonRef.current = null;
        initializedRef.current = false;
      };
    }, [
      cancelSelectionMenuFrame,
      clearCacheSaveTimer,
      connectWebSocket,
      handleOscNotification,
      hideSelectionMenu,
      pasteFromClipboard,
      persistTerminalCache,
      queueSelectionMenuUpdate,
      setLifecycle,
      terminalId,
      isExited,
    ]);

    useEffect(() => {
      if (isActive && fitAddonRef.current && terminalRef.current) {
        setTimeout(() => {
          fitAddonRef.current?.fit();

          if (wsRef.current?.readyState === WebSocket.OPEN && terminalRef.current) {
            const { cols, rows } = terminalRef.current;
            wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        }, 50);
      }
    }, [isActive]);

    useEffect(() => {
      const handlePersist = () => {
        if (document.visibilityState && document.visibilityState !== "hidden") {
          return;
        }
        void persistTerminalCache();
      };
      window.addEventListener("beforeunload", handlePersist);
      document.addEventListener("visibilitychange", handlePersist);
      return () => {
        window.removeEventListener("beforeunload", handlePersist);
        document.removeEventListener("visibilitychange", handlePersist);
      };
    }, [persistTerminalCache]);

    useEffect(() => {
      if (!isActive || !isFocused || isExited || !terminalRef.current) {
        return;
      }
      const timer = setTimeout(() => {
        terminalRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }, [isActive, isFocused, isExited]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || !fitAddonRef.current) return;

      const observer = new ResizeObserver(() => {
        if (isActive && fitAddonRef.current) {
          fitAddonRef.current.fit();
          if (wsRef.current?.readyState === WebSocket.OPEN && terminalRef.current) {
            const { cols, rows } = terminalRef.current;
            wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        }
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, [isActive]);

    const touchStartRef = useRef<{ y: number } | null>(null);
    const touchAccumRef = useRef(0);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length === 2) {
          const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          touchStartRef.current = { y };
          touchAccumRef.current = 0;
        } else {
          touchStartRef.current = null;
        }
      };

      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length !== 2 || !touchStartRef.current) return;
        e.preventDefault();
        const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const delta = touchStartRef.current.y - y;
        touchAccumRef.current += delta;
        touchStartRef.current.y = y;
        const fontSize = terminalRef.current?.options.fontSize ?? 14;
        const lineHeight = terminalRef.current?.options.lineHeight ?? 1;
        const linePixels = fontSize * lineHeight;
        const lines = Math.round(touchAccumRef.current / linePixels);
        if (lines !== 0 && terminalRef.current) {
          terminalRef.current.scrollLines(lines);
          touchAccumRef.current -= lines * linePixels;
        }
      };

      const onTouchEnd = (e: TouchEvent) => {
        if (e.touches.length < 2) {
          touchStartRef.current = null;
          touchAccumRef.current = 0;
        }
      };

      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: false });
      container.addEventListener("touchend", onTouchEnd, { passive: true });

      return () => {
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
        container.removeEventListener("touchend", onTouchEnd);
      };
    }, []);

    return (
      <div
        ref={wrapperRef}
        className="absolute inset-0"
        style={{
          display: isActive ? "block" : "none",
          backgroundColor: getXtermTheme(theme).background,
        }}
        onKeyDownCapture={(e) => {
          const key = normalizeShortcutKey(e.key);
          if ((e.ctrlKey || e.metaKey) && key === "f") {
            e.preventDefault();
            e.stopPropagation();
            openSearchRef.current();
            return;
          }
          if (shouldArmTerminalUnloadGuard(e.nativeEvent)) {
            armTerminalBrowserUnloadGuard();
          }
          if (shouldPreventTerminalBrowserShortcut(e.nativeEvent)) {
            e.preventDefault();
          }
        }}
        onFocusCapture={() => setTerminalBrowserShortcutFocus(terminalId, true)}
        onBlurCapture={() => setTimeout(syncBrowserShortcutFocus, 0)}
        onPasteCapture={(e) => {
          const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          if (files.length === 0) {
            return;
          }
          e.preventDefault();
          void pasteImageFiles(files);
        }}
        onPointerUpCapture={(e) => {
          selectionAnchorRef.current = { clientX: e.clientX, clientY: e.clientY };
          queueSelectionMenuUpdate();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          id={`terminal-image-upload-${terminalId}`}
          name={`terminal-image-upload-${terminalId}`}
          accept="image/*"
          multiple
          className="hidden"
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            if (files.length > 0) {
              void pasteImageFiles(files);
            }
          }}
        />
        <div
          ref={containerRef}
          className="absolute inset-0 [&_.xterm]:!p-0 [&_.xterm]:!m-0 [&_.xterm-viewport]:!p-0 [&_.xterm-screen]:!p-0 [&_.xterm-screen]:!m-0"
        />
        {selectionMenu && (
          <TerminalSelectionMenu
            left={selectionMenu.left}
            top={selectionMenu.top}
            copyLabel={t("common.copy")}
            searchLabel={t("common.search")}
            clearLabel={t("common.clear")}
            onCopy={handleSelectionCopy}
            onSearch={handleSelectionSearch}
            onClear={clearTerminalSelection}
          />
        )}
        {progress && (
          <div className="absolute bottom-0 left-0 right-0 z-10">
            <div
              className={`h-0.5 transition-all duration-300 ${
                progress.state === 2 ? "bg-red-500" : progress.state === 4 ? "bg-yellow-500" : "bg-blue-500"
              }`}
              style={{
                width: progress.state === 3 ? "100%" : `${progress.value}%`,
                animation: progress.state === 3 ? "pulse 1.5s ease-in-out infinite" : undefined,
              }}
            />
          </div>
        )}
        {lifecycleState !== "live" && (
          <div
            className={`absolute left-2 bottom-2 z-10 rounded border px-2 py-1 text-[10px] font-medium shadow-sm backdrop-blur-sm ${
              lifecycleState === "exited"
                ? "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-300"
                : "border-transparent bg-ide-panel/90 text-ide-mute"
            }`}
          >
            {lifecycleState === "exited" ? t("terminal.closed") : lifecycleState}
          </div>
        )}
        {searchVisible && (
          <div className="absolute top-2 right-2 z-10 flex w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] min-w-0 flex-wrap items-center gap-0 overflow-hidden rounded-md border border-ide-border bg-ide-panel/95 px-2 py-1.5 shadow-lg backdrop-blur-sm md:w-auto md:flex-nowrap md:gap-1.5 md:overflow-x-auto">
            <input
              ref={searchInputRef}
              type="text"
              id={`terminal-search-${terminalId}`}
              name={`terminal-search-${terminalId}`}
              aria-label="Search terminal output"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.shiftKey ? handleSearchPrev() : handleSearchNext();
                } else if (e.key === "Escape") {
                  closeSearch();
                }
              }}
              placeholder="Search..."
              className="h-11 w-full min-w-0 shrink-0 basis-full bg-transparent text-base text-ide-text outline-none placeholder:text-ide-mute/50 md:w-40 md:basis-auto md:text-xs"
            />
            <button
              type="button"
              onClick={() => setSearchCaseSensitive((v) => !v)}
              title="Case Sensitive"
              aria-label="Case Sensitive"
              className={`flex size-11 shrink-0 items-center justify-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors md:size-auto md:px-1.5 md:py-0.5 ${searchCaseSensitive ? "bg-ide-accent text-white" : "text-ide-mute hover:text-ide-text hover:bg-ide-bg"}`}
            >
              Aa
            </button>
            <button
              type="button"
              onClick={() => setSearchRegex((v) => !v)}
              title="Use Regex"
              aria-label="Use Regex"
              className={`flex size-11 shrink-0 items-center justify-center rounded px-1.5 py-0.5 font-mono text-xs transition-colors md:size-auto md:px-1.5 md:py-0.5 ${searchRegex ? "bg-ide-accent text-white" : "text-ide-mute hover:text-ide-text hover:bg-ide-bg"}`}
            >
              .*
            </button>
            <div className="hidden h-4 w-px bg-ide-border md:block" />
            <button
              type="button"
              onClick={handleSearchPrev}
              title="Previous (Shift+Enter)"
              aria-label="Previous search result"
              className="flex size-11 shrink-0 items-center justify-center rounded p-0.5 text-ide-mute transition-colors hover:text-ide-text hover:bg-ide-bg md:size-auto"
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              onClick={handleSearchNext}
              title="Next (Enter)"
              aria-label="Next search result"
              className="flex size-11 shrink-0 items-center justify-center rounded p-0.5 text-ide-mute transition-colors hover:text-ide-text hover:bg-ide-bg md:size-auto"
            >
              <ChevronDown size={14} />
            </button>
            <div className="hidden h-4 w-px bg-ide-border md:block" />
            <button
              type="button"
              onClick={() => {
                const text = serializeAddonRef.current?.serialize();
                if (!text) return;
                navigator.clipboard.writeText(text).then(() => {
                  setCopySuccess(true);
                  setTimeout(() => setCopySuccess(false), 1500);
                });
              }}
              title="Copy all output"
              aria-label="Copy all output"
              className="flex size-11 shrink-0 items-center justify-center rounded p-0.5 text-ide-mute transition-colors hover:text-ide-text hover:bg-ide-bg md:size-auto"
            >
              {copySuccess ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
            </button>
            <button
              type="button"
              onClick={closeSearch}
              title="Close (Escape)"
              aria-label="Close search"
              className="flex size-11 shrink-0 items-center justify-center rounded p-0.5 text-ide-mute transition-colors hover:text-ide-text hover:bg-ide-bg md:size-auto"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    );
  }
);

TerminalInstance.displayName = "TerminalInstance";

export default TerminalInstance;
