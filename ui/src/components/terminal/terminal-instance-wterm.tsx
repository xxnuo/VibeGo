import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "@wterm/react";
import type { TerminalHandle } from "@wterm/react";
import "@wterm/react/css";
import { terminalApi, type TerminalCapabilities } from "@/api/terminal";
import TerminalSelectionMenu from "@/components/terminal/terminal-selection-menu";
import { useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import {
  armTerminalBrowserUnloadGuard,
  setTerminalBrowserShortcutFocus,
} from "@/services/terminal-browser-shortcut-guard";
import { notifyTerminal } from "@/services/terminal-notification-service";
import { type Theme, useAppStore } from "@/stores";
import type {
  TerminalInstanceHandle,
  TerminalInstanceProps,
  TerminalInstanceStateUpdate,
} from "@/components/terminal/terminal-instance-types";

interface ParsedTerminalNotification {
  body: string;
  title: string;
}

interface SelectionMenuState {
  left: number;
  top: number;
}

const DEFAULT_TERMINAL_CAPABILITIES: TerminalCapabilities = {
  durable: false,
  resume: true,
  shell_integration: false,
  snapshot: false,
};

const normalizeShortcutKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const TERMINAL_CTRL_SHORTCUT_KEYS = new Set(["a", "d", "h", "j", "k", "l", "n", "o", "p", "r", "s", "t", "u", "w"]);
const TERMINAL_ALT_SHORTCUT_KEYS = new Set(["ArrowLeft", "ArrowRight"]);
const TERMINAL_FUNCTION_SHORTCUT_KEYS = new Set(["F5"]);
const SELECTION_MENU_WIDTH = 216;
const SELECTION_MENU_HEIGHT = 44;
const SELECTION_MENU_MARGIN = 8;

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

const shouldArmTerminalUnloadGuard = (event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">): boolean => {
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

const getWtermThemeClass = (theme: Theme): string => {
  if (theme === "solarized") return "theme-solarized-dark";
  if (theme === "light") return "theme-light";
  return "theme-monokai";
};

const getWtermThemeStyle = (theme: Theme): React.CSSProperties => {
  if (theme === "hacker") {
    return {
      ["--term-bg" as string]: "#0d0208",
      ["--term-fg" as string]: "#00ff41",
      ["--term-cursor" as string]: "#00ff41",
      ["--term-color-0" as string]: "#0d0208",
      ["--term-color-1" as string]: "#ff0000",
      ["--term-color-2" as string]: "#00ff41",
      ["--term-color-3" as string]: "#008f11",
      ["--term-color-4" as string]: "#003b00",
      ["--term-color-5" as string]: "#bd00ff",
      ["--term-color-6" as string]: "#00fdff",
      ["--term-color-7" as string]: "#00ff41",
      ["--term-color-8" as string]: "#003b00",
      ["--term-color-9" as string]: "#ff3e3e",
      ["--term-color-10" as string]: "#00ff41",
      ["--term-color-11" as string]: "#008f11",
      ["--term-color-12" as string]: "#003b00",
      ["--term-color-13" as string]: "#bd00ff",
      ["--term-color-14" as string]: "#00fdff",
      ["--term-color-15" as string]: "#ffffff",
    };
  }
  if (theme === "ocean") {
    return {
      ["--term-bg" as string]: "#0a1628",
      ["--term-fg" as string]: "#e0f2fe",
      ["--term-cursor" as string]: "#22d3ee",
    };
  }
  if (theme === "sunset") {
    return {
      ["--term-bg" as string]: "#1a0f0a",
      ["--term-fg" as string]: "#fef3c7",
      ["--term-cursor" as string]: "#f59e0b",
    };
  }
  if (theme === "nord") {
    return {
      ["--term-bg" as string]: "#2e3440",
      ["--term-fg" as string]: "#eceff4",
      ["--term-cursor" as string]: "#88c0d0",
    };
  }
  if (theme === "terminal") {
    return {
      ["--term-bg" as string]: "#111111",
      ["--term-fg" as string]: "#d1fae5",
      ["--term-cursor" as string]: "#34d399",
    };
  }
  if (theme === "dark") {
    return {
      ["--term-bg" as string]: "#18181b",
      ["--term-fg" as string]: "#d4d4d8",
      ["--term-cursor" as string]: "#a1a1aa",
    };
  }
  return {};
};

const encodeUtf8Base64 = (data: string): string => {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const decodeBase64Utf8 = (value: string): string => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
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

const TerminalInstanceWTerm = React.forwardRef<TerminalInstanceHandle, TerminalInstanceProps>(
  ({ terminalId, terminalName, isActive, isFocused = isActive, isExited = false, onExited, onStateChange }, ref) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<TerminalHandle | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectAttemptsRef = useRef(0);
    const wasOpenRef = useRef(false);
    const inputReadyRef = useRef(false);
    const readonlyRef = useRef(isExited);
    const destroyedRef = useRef(false);
    const currentColsRef = useRef(80);
    const currentRowsRef = useRef(24);
    const pendingEscapeRef = useRef("");
    const pendingWritesRef = useRef<string[]>([]);
    const terminalReadyRef = useRef(false);
    const currentCwdRef = useRef<string | undefined>(undefined);
    const lastCommandRef = useRef<string | undefined>(undefined);
    const shellStateRef = useRef<string | undefined>(undefined);
    const shellTypeRef = useRef<string | undefined>(undefined);
    const shellIntegrationRef = useRef(false);
    const capabilitiesRef = useRef<TerminalCapabilities>(DEFAULT_TERMINAL_CAPABILITIES);
    const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
    const [copySuccess, setCopySuccess] = useState(false);
    const selectionAnchorRef = useRef<{ clientX: number; clientY: number } | null>(null);

    const theme = useAppStore((s) => s.theme);
    const locale = useAppStore((s) => s.locale);
    const t = useTranslation(locale);
    const terminalFrontend = useSettingsStore((s) => s.settings.terminalFrontend || "xterm");

    const emitStateChange = useCallback(
      (state: TerminalInstanceStateUpdate) => {
        onStateChange?.(state);
      },
      [onStateChange]
    );

    const clearReconnectTimer = useCallback(() => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }, []);

    const clearSelection = useCallback(() => {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      setSelectionMenu(null);
    }, []);

    const getSelectionText = useCallback(() => {
      const wrapper = wrapperRef.current;
      const selection = window.getSelection();
      if (!wrapper || !selection || selection.rangeCount === 0) {
        return "";
      }
      const range = selection.getRangeAt(0);
      if (!wrapper.contains(range.commonAncestorContainer)) {
        return "";
      }
      return selection.toString();
    }, []);

    const queueSelectionMenuUpdate = useCallback(() => {
      requestAnimationFrame(() => {
        const wrapper = wrapperRef.current;
        const selection = window.getSelection();
        if (!wrapper || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setSelectionMenu(null);
          return;
        }
        const range = selection.getRangeAt(0);
        if (!wrapper.contains(range.commonAncestorContainer)) {
          setSelectionMenu(null);
          return;
        }
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
        if (rects.length === 0) {
          setSelectionMenu(null);
          return;
        }
        const wrapperRect = wrapper.getBoundingClientRect();
        const left = Math.min(...rects.map((rect) => rect.left));
        const right = Math.max(...rects.map((rect) => rect.right));
        const top = Math.min(...rects.map((rect) => rect.top));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        const anchorX = left + (right - left) / 2;
        const halfWidth = SELECTION_MENU_WIDTH / 2;
        const leftMin = Math.min(halfWidth + SELECTION_MENU_MARGIN, wrapperRect.width / 2);
        const leftMax = Math.max(wrapperRect.width - halfWidth - SELECTION_MENU_MARGIN, leftMin);
        let menuTop = top - wrapperRect.top - SELECTION_MENU_HEIGHT - 10;
        if (menuTop < SELECTION_MENU_MARGIN) {
          menuTop = bottom - wrapperRect.top + 10;
        }
        const maxTop = Math.max(wrapperRect.height - SELECTION_MENU_HEIGHT - SELECTION_MENU_MARGIN, SELECTION_MENU_MARGIN);
        setSelectionMenu({
          left: clamp(anchorX - wrapperRect.left, leftMin, leftMax),
          top: clamp(menuTop, SELECTION_MENU_MARGIN, maxTop),
        });
      });
    }, []);

    const writeToTerminal = useCallback((data: string) => {
      if (!data) {
        return;
      }
      if (!terminalReadyRef.current || !terminalRef.current) {
        pendingWritesRef.current.push(data);
        return;
      }
      terminalRef.current.write(data);
    }, []);

    const handleOscNotification = useCallback(
      (notification: ParsedTerminalNotification | null) => {
        if (!notification) {
          return;
        }
        notifyTerminal({
          body: notification.body,
          isActive: !!isFocused,
          terminalId,
          title: notification.title,
        });
      },
      [isFocused, terminalId]
    );

    const flushAnsiState = useCallback(
      (chunk: string) => {
        let data = pendingEscapeRef.current + chunk;
        pendingEscapeRef.current = "";
        let plain = "";
        let i = 0;
        while (i < data.length) {
          if (data[i] !== "\u001b") {
            plain += data[i];
            i += 1;
            continue;
          }
          if (i + 1 >= data.length) {
            pendingEscapeRef.current = data.slice(i);
            break;
          }
          const next = data[i + 1];
          if (next === "]") {
            const belIndex = data.indexOf("\u0007", i + 2);
            const stIndex = data.indexOf("\u001b\\", i + 2);
            let endIndex = -1;
            let endLength = 1;
            if (belIndex >= 0 && (stIndex < 0 || belIndex < stIndex)) {
              endIndex = belIndex;
              endLength = 1;
            } else if (stIndex >= 0) {
              endIndex = stIndex;
              endLength = 2;
            }
            if (endIndex < 0) {
              pendingEscapeRef.current = data.slice(i);
              break;
            }
            const content = data.slice(i + 2, endIndex);
            const sepIndex = content.indexOf(";");
            const code = sepIndex >= 0 ? content.slice(0, sepIndex) : content;
            const value = sepIndex >= 0 ? content.slice(sepIndex + 1) : "";
            if (code === "7") {
              const cwd = parseOsc7Path(value);
              if (cwd) {
                currentCwdRef.current = cwd;
                terminalApi.updateRuntimeInfo(terminalId, { current_cwd: cwd }).catch(() => {});
                emitStateChange({ currentCwd: cwd });
              }
            } else if (code === "9") {
              handleOscNotification(parseOsc9Notification(value, terminalName || t("sidebar.terminal")));
            } else if (code === "777") {
              handleOscNotification(parseOsc777Notification(value));
            } else if (code === "16162") {
              const [command = "", ...rest] = value.split(";");
              let payload: Record<string, unknown> = {};
              if (rest.length > 0) {
                try {
                  payload = JSON.parse(rest.join(";")) as Record<string, unknown>;
                } catch {}
              }
              if (command === "A") {
                shellStateRef.current = "ready";
                shellIntegrationRef.current = true;
                terminalApi.updateRuntimeInfo(terminalId, { shell_state: "ready", shell_integration: true }).catch(() => {});
                emitStateChange({ shellIntegration: true, shellState: "ready" });
              } else if (command === "C") {
                let lastCommand: string | undefined;
                if (typeof payload.cmd64 === "string") {
                  try {
                    lastCommand = decodeBase64Utf8(payload.cmd64);
                  } catch {}
                }
                lastCommandRef.current = lastCommand;
                shellStateRef.current = "running-command";
                shellIntegrationRef.current = true;
                terminalApi
                  .updateRuntimeInfo(terminalId, {
                    shell_state: "running-command",
                    shell_integration: true,
                    last_command: lastCommand,
                  })
                  .catch(() => {});
                emitStateChange({
                  lastCommand,
                  shellIntegration: true,
                  shellState: "running-command",
                });
              } else if (command === "M") {
                const shellType = typeof payload.shell === "string" ? payload.shell : undefined;
                const shellIntegration = typeof payload.integration === "boolean" ? payload.integration : true;
                shellTypeRef.current = shellType;
                shellIntegrationRef.current = shellIntegration;
                terminalApi
                  .updateRuntimeInfo(terminalId, {
                    shell_type: shellType,
                    shell_integration: shellIntegration,
                  })
                  .catch(() => {});
                emitStateChange({ shellIntegration, shellType });
              } else if (command === "D") {
                const lastCommandExitCode =
                  typeof payload.exitcode === "number" && Number.isFinite(payload.exitcode) ? payload.exitcode : null;
                shellStateRef.current = "ready";
                terminalApi
                  .updateRuntimeInfo(terminalId, {
                    shell_state: "ready",
                    last_command_exit_code: lastCommandExitCode,
                  })
                  .catch(() => {});
                emitStateChange({ lastCommandExitCode, shellState: "ready" });
              } else if (command === "R") {
                shellStateRef.current = "";
                shellIntegrationRef.current = false;
                terminalApi.updateRuntimeInfo(terminalId, { shell_state: "", shell_integration: false }).catch(() => {});
                emitStateChange({ shellIntegration: false, shellState: "" });
              }
            }
            i = endIndex + endLength;
            continue;
          }
          if (next === "[") {
            let j = i + 2;
            while (j < data.length && !/[A-Za-z]/.test(data[j])) {
              j += 1;
            }
            if (j >= data.length) {
              pendingEscapeRef.current = data.slice(i);
              break;
            }
            plain += data.slice(i, j + 1);
            i = j + 1;
            continue;
          }
          plain += data.slice(i, i + 2);
          i += 2;
        }
        if (plain) {
          writeToTerminal(plain);
        }
      },
      [emitStateChange, handleOscNotification, t, terminalId, terminalName, writeToTerminal]
    );

    const connectWebSocket = useCallback(() => {
      clearReconnectTimer();
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
      inputReadyRef.current = false;
      const ws = new WebSocket(terminalApi.wsUrl(terminalId));
      wsRef.current = ws;
      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        wasOpenRef.current = true;
        reconnectAttemptsRef.current = 0;
        inputReadyRef.current = !readonlyRef.current;
        ws.send(JSON.stringify({ type: "resize", cols: currentColsRef.current, rows: currentRowsRef.current }));
      };
      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "replay" || msg.type === "output") {
            if (msg.reset) {
              pendingEscapeRef.current = "";
              pendingWritesRef.current = [];
              terminalReadyRef.current = false;
              setTerminalRenderKey((key) => key + 1);
            }
            if (typeof msg.data === "string" && msg.data.length > 0) {
              const binaryString = atob(msg.data);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              flushAnsiState(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
            }
          } else if (msg.type === "state") {
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
              inputReadyRef.current = false;
            }
          } else if (msg.type === "pty_exited") {
            writeToTerminal(`\r\n[${t("terminal.processExited")}]\r\n`);
            readonlyRef.current = true;
            inputReadyRef.current = false;
            onExited?.();
          }
        } catch {}
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        inputReadyRef.current = false;
        if (destroyedRef.current || readonlyRef.current) {
          return;
        }
        if (wasOpenRef.current) {
          wasOpenRef.current = false;
          writeToTerminal(`\r\n[${t("terminal.connectionClosed")}]\r\n`);
        }
        const attempt = reconnectAttemptsRef.current;
        reconnectAttemptsRef.current = attempt + 1;
        const delay = Math.min(10_000, 400 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        reconnectTimerRef.current = setTimeout(() => {
          if (!destroyedRef.current && !readonlyRef.current) {
            connectWebSocket();
          }
        }, delay);
      };
      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        writeToTerminal(`\r\n[${t("terminal.connectionError")}]\r\n`);
        try {
          ws.close();
        } catch {}
      };
    }, [clearReconnectTimer, emitStateChange, flushAnsiState, onExited, t, terminalId, writeToTerminal]);

    const sendTerminalInput = useCallback(
      (data: string) => {
        if (readonlyRef.current || !inputReadyRef.current || wsRef.current?.readyState !== WebSocket.OPEN) {
          return;
        }
        clearSelection();
        wsRef.current.send(
          JSON.stringify({
            type: "input",
            data: encodeUtf8Base64(data),
          })
        );
      },
      [clearSelection]
    );

    useImperativeHandle(
      ref,
      () => ({
        sendInput: sendTerminalInput,
        getSelection: () => getSelectionText(),
        paste: (text: string) => sendTerminalInput(text),
        clearSelection,
        selectAll: () => {
          const wrapper = wrapperRef.current;
          if (!wrapper) return;
          const grid = wrapper.querySelector(".term-grid");
          if (!(grid instanceof Node)) return;
          const selection = window.getSelection();
          if (!selection) return;
          const range = document.createRange();
          range.selectNodeContents(grid);
          selection.removeAllRanges();
          selection.addRange(range);
          queueSelectionMenuUpdate();
        },
        focus: () => terminalRef.current?.focus(),
      }),
      [clearSelection, getSelectionText, queueSelectionMenuUpdate, sendTerminalInput]
    );

    useEffect(() => {
      readonlyRef.current = isExited;
      if (isExited) {
        inputReadyRef.current = false;
      }
    }, [isExited]);

    useEffect(() => {
      destroyedRef.current = false;
      return () => {
        destroyedRef.current = true;
        terminalReadyRef.current = false;
        pendingWritesRef.current = [];
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
      };
    }, [clearReconnectTimer]);

    useEffect(() => {
      if (terminalFrontend !== "wterm") {
        return;
      }
      connectWebSocket();
      return () => {
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
      };
    }, [clearReconnectTimer, connectWebSocket, terminalFrontend]);

    useEffect(() => {
      if (isActive && isFocused) {
        const timer = setTimeout(() => {
          terminalRef.current?.focus();
        }, 50);
        return () => clearTimeout(timer);
      }
    }, [isActive, isFocused]);

    useEffect(() => {
      const handleWindowKeyDown = (event: KeyboardEvent) => {
        const wrapper = wrapperRef.current;
        if (!wrapper) {
          return;
        }
        const activeElement = document.activeElement;
        if (!(activeElement instanceof Node) || !wrapper.contains(activeElement)) {
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
        if (event.type === "keydown" && shouldCopyTerminalSelection(event, getSelectionText().length > 0)) {
          const selection = getSelectionText();
          if (selection) {
            event.preventDefault();
            void navigator.clipboard.writeText(selection).catch(() => {});
            return;
          }
        }
        if (event.type === "keydown" && shouldPasteIntoTerminal(event)) {
          event.preventDefault();
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text) {
                sendTerminalInput(text);
              }
            })
            .catch(() => {});
          return;
        }
        const manualInput = event.type === "keydown" ? getTerminalShortcutInput(event) : null;
        if (manualInput) {
          event.preventDefault();
          sendTerminalInput(manualInput);
          return;
        }
        if (shouldPreventTerminalBrowserShortcut(event)) {
          event.preventDefault();
        }
      };
      window.addEventListener("keydown", handleWindowKeyDown, true);
      return () => window.removeEventListener("keydown", handleWindowKeyDown, true);
    }, [getSelectionText, sendTerminalInput]);

    useEffect(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const handleSelectionChange = () => queueSelectionMenuUpdate();
      document.addEventListener("selectionchange", handleSelectionChange);
      return () => document.removeEventListener("selectionchange", handleSelectionChange);
    }, [queueSelectionMenuUpdate]);

    const handleSelectionCopy = useCallback(() => {
      const text = getSelectionText();
      if (!text) {
        clearSelection();
        return;
      }
      void navigator.clipboard.writeText(text).then(() => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 1000);
      }).catch(() => {});
      clearSelection();
      terminalRef.current?.focus();
    }, [clearSelection, getSelectionText]);
    const [terminalRenderKey, setTerminalRenderKey] = useState(0);

    return (
      <div
        ref={wrapperRef}
        className="absolute inset-0"
        style={{
          display: isActive ? "block" : "none",
          backgroundColor: (getWtermThemeStyle(theme) as Record<string, string>)["--term-bg"] || undefined,
        }}
        onFocusCapture={() => setTerminalBrowserShortcutFocus(terminalId, true)}
        onBlurCapture={() => setTimeout(() => setTerminalBrowserShortcutFocus(terminalId, false), 0)}
        onPointerUpCapture={(e) => {
          selectionAnchorRef.current = { clientX: e.clientX, clientY: e.clientY };
          queueSelectionMenuUpdate();
        }}
      >
        <Terminal
          key={terminalRenderKey}
          ref={terminalRef}
          cols={currentColsRef.current}
          rows={currentRowsRef.current}
          autoResize={true}
          cursorBlink={true}
          theme={getWtermThemeClass(theme)}
          onData={(data) => sendTerminalInput(data)}
          onResize={(cols, rows) => {
            currentColsRef.current = cols;
            currentRowsRef.current = rows;
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          }}
          onReady={() => {
            terminalReadyRef.current = true;
            const queuedWrites = pendingWritesRef.current.splice(0);
            for (const chunk of queuedWrites) {
              terminalRef.current?.write(chunk);
            }
            terminalRef.current?.focus();
          }}
          className="absolute inset-0 !rounded-none !shadow-none [&_.term-grid]:min-h-full"
          style={getWtermThemeStyle(theme)}
        />
        {selectionMenu && (
          <TerminalSelectionMenu
            left={selectionMenu.left}
            top={selectionMenu.top}
            copyLabel={copySuccess ? t("common.copied") : t("common.copy")}
            searchLabel={t("common.search")}
            clearLabel={t("common.clear")}
            onCopy={handleSelectionCopy}
            onSearch={() => {}}
            onClear={clearSelection}
          />
        )}
        {!capabilitiesRef.current.snapshot && (
          <div className="absolute left-2 bottom-2 z-10 rounded bg-ide-panel/90 px-2 py-1 text-[10px] text-ide-mute shadow-sm backdrop-blur-sm">
            wterm
          </div>
        )}
      </div>
    );
  }
);

TerminalInstanceWTerm.displayName = "TerminalInstanceWTerm";

export default TerminalInstanceWTerm;
