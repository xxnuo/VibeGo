import { Keyboard as KeyboardIcon } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import type { KeyEvent } from "@/components/keyboard";
import { useTranslation } from "@/lib/i18n";
import { registerPage } from "@/pages/registry";
import type { PageViewProps } from "@/pages/types";
import { useAppStore } from "@/stores/app-store";
import { useKeyboardStore } from "@/stores/keyboard-store";

interface EventLogEntry {
  id: number;
  event: KeyEvent;
  formatted: string;
}

function formatEvent(e: KeyEvent): string {
  const mods: string[] = [];
  if (e.ctrl) mods.push("Ctrl");
  if (e.alt) mods.push("Alt");
  if (e.shift) mods.push("Shift");
  if (e.meta) mods.push("Meta");
  const modStr = mods.length > 0 ? mods.join("+") + "+" : "";
  if (e.type === "char") {
    const display = e.value === " " ? "Space" : e.value;
    return modStr + display;
  }
  return modStr + e.value;
}

const KeyboardTestView: React.FC<PageViewProps> = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const [text, setText] = useState<string>("");
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const nextId = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<string[]>([]);
  const [useNativeKb, setUseNativeKb] = useState(false);

  const scrollBottom = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.scrollTop = ref.current.scrollHeight;
      }
    });
  }, []);

  const handleKeyEvent = useCallback(
    (e: KeyEvent) => {
      const entry: EventLogEntry = {
        id: nextId.current++,
        event: e,
        formatted: formatEvent(e),
      };
      setEventLog((prev) => [...prev.slice(-199), entry]);
      scrollBottom(logRef);

      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const currentText = textarea.value;

      let nextText = currentText;
      let finalCursor = start;
      let handled = false;

      if (e.value !== "Keyboard") {
        setUseNativeKb(false);
        if (textarea.inputMode === "text") {
          textarea.dataset.ignoreBlur = "true";
          textarea.inputMode = "none";
          textarea.blur();
          textarea.dataset.ignoreBlur = "false";
        }
      }

      const handleArrow = (deltaFn: (pos: number) => number, isHorizontalLeft = false, isHorizontalRight = false) => {
        if (e.select || e.shift) {
          const dir = textarea.selectionDirection || "none";
          const activeCursor = dir === "backward" || start === end ? start : end;
          const newCursor = deltaFn(activeCursor);
          const fixedCursor = dir === "backward" || start === end ? end : start;
          const isNowBackward = newCursor < fixedCursor || (newCursor === fixedCursor && dir === "backward");
          const newStart = Math.min(newCursor, fixedCursor);
          const newEnd = Math.max(newCursor, fixedCursor);
          textarea.setSelectionRange(newStart, newEnd, isNowBackward ? "backward" : "forward");
        } else {
          if (start !== end && (isHorizontalLeft || isHorizontalRight)) {
            const collapseCursor = isHorizontalLeft ? start : end;
            textarea.setSelectionRange(collapseCursor, collapseCursor);
          } else {
            const dir = textarea.selectionDirection || "none";
            const activeCursor = dir === "backward" ? start : end;
            const newCursor = deltaFn(start !== end ? activeCursor : start);
            textarea.setSelectionRange(newCursor, newCursor);
          }
        }
        textarea.focus();
      };

      if (e.value === "SelectAll" || ((e.ctrl || e.meta) && e.value.toLowerCase() === "a")) {
        textarea.setSelectionRange(0, currentText.length);
        textarea.focus();
        return;
      }

      if (e.value === "Copy" || ((e.ctrl || e.meta) && e.value.toLowerCase() === "c")) {
        if (start !== end) navigator.clipboard.writeText(currentText.slice(start, end));
        textarea.focus();
        return;
      }

      if (e.value === "Cut" || ((e.ctrl || e.meta) && e.value.toLowerCase() === "x")) {
        if (start !== end) {
          navigator.clipboard.writeText(currentText.slice(start, end)).then(() => {
            historyRef.current.push(currentText);
            if (historyRef.current.length > 100) historyRef.current.shift();
            const next = currentText.slice(0, start) + currentText.slice(end);
            setText(next);
            setTimeout(() => {
              if (textareaRef.current) {
                textareaRef.current.setSelectionRange(start, start);
                textareaRef.current.focus();
              }
            }, 0);
          });
        } else {
          textarea.focus();
        }
        return;
      }

      if (e.value === "Paste" || ((e.ctrl || e.meta) && e.value.toLowerCase() === "v")) {
        navigator.clipboard
          .readText()
          .then((clip) => {
            historyRef.current.push(currentText);
            if (historyRef.current.length > 100) historyRef.current.shift();
            const next = currentText.slice(0, start) + clip + currentText.slice(end);
            setText(next);
            const cursor = start + clip.length;
            setTimeout(() => {
              if (textareaRef.current) {
                textareaRef.current.setSelectionRange(cursor, cursor);
                textareaRef.current.focus();
              }
            }, 0);
          })
          .catch(() => {
            textarea.focus();
          });
        return;
      }

      if (e.value === "Undo" || ((e.ctrl || e.meta) && e.value.toLowerCase() === "z")) {
        if (historyRef.current.length > 0) {
          const previous = historyRef.current.pop()!;
          setText(previous);
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
            }
          }, 0);
        } else {
          textarea.focus();
        }
        return;
      }

      if (e.value === "Keyboard") {
        setUseNativeKb(true);
        if (textareaRef.current) {
          textareaRef.current.dataset.ignoreBlur = "true";
          textareaRef.current.inputMode = "text";
          textareaRef.current.blur();
          textareaRef.current.dataset.ignoreBlur = "false";
          textareaRef.current.focus();
        }
        return;
      }

      if (e.value === "Backspace") {
        if (start !== end) {
          nextText = currentText.slice(0, start) + currentText.slice(end);
          finalCursor = start;
        } else if (start > 0) {
          nextText = currentText.slice(0, start - 1) + currentText.slice(end);
          finalCursor = start - 1;
        }
        handled = true;
      } else if (e.value === "Delete") {
        if (start !== end) {
          nextText = currentText.slice(0, start) + currentText.slice(end);
          finalCursor = start;
        } else if (start < currentText.length) {
          nextText = currentText.slice(0, start) + currentText.slice(start + 1);
          finalCursor = start;
        }
        handled = true;
      } else if (e.value === "ArrowLeft") {
        handleArrow((pos) => Math.max(0, pos - 1), true, false);
        return;
      } else if (e.value === "ArrowRight") {
        handleArrow((pos) => Math.min(currentText.length, pos + 1), false, true);
        return;
      } else if (e.value === "ArrowUp") {
        handleArrow((pos) => {
          const textBeforeBox = currentText.slice(0, pos);
          const lastNewLine = textBeforeBox.lastIndexOf("\n");
          if (lastNewLine === -1) return 0;
          const currentColumn = pos - lastNewLine - 1;
          const prevLineStart = currentText.lastIndexOf("\n", lastNewLine - 1);
          const prevLineLength = lastNewLine - (prevLineStart + 1);
          return prevLineStart + 1 + Math.min(currentColumn, Math.max(0, prevLineLength));
        });
        return;
      } else if (e.value === "ArrowDown") {
        handleArrow((pos) => {
          const textBeforeBox = currentText.slice(0, pos);
          const lastNewLine = textBeforeBox.lastIndexOf("\n");
          const currentColumn = pos - lastNewLine - 1;
          const nextNewLine = currentText.indexOf("\n", pos);
          if (nextNewLine === -1) return currentText.length;
          const nextNextNewLine = currentText.indexOf("\n", nextNewLine + 1);
          const nextLineEnd = nextNextNewLine === -1 ? currentText.length : nextNextNewLine;
          const nextLineLength = nextLineEnd - (nextNewLine + 1);
          return nextNewLine + 1 + Math.min(currentColumn, Math.max(0, nextLineLength));
        });
        return;
      } else if (e.value === "Home") {
        handleArrow((pos) => {
          const textBeforeBox = currentText.slice(0, pos);
          const lastNewLine = textBeforeBox.lastIndexOf("\n");
          return lastNewLine + 1;
        });
        return;
      } else if (e.value === "End") {
        handleArrow((pos) => {
          const nextNewLine = currentText.indexOf("\n", pos);
          return nextNewLine === -1 ? currentText.length : nextNewLine;
        });
        return;
      } else if (e.value === "PageUp") {
        handleArrow((pos) => Math.max(0, pos - 150));
        return;
      } else if (e.value === "PageDown") {
        handleArrow((pos) => Math.min(currentText.length, pos + 150));
        return;
      } else if (!(e.ctrl || e.meta || e.alt)) {
        let insertText = "";
        if (e.value === "Enter") insertText = "\n";
        else if (e.value === "Tab") insertText = "    ";
        else if (e.value === "Space") insertText = " ";
        else if (e.type === "char") insertText = e.value;

        if (insertText) {
          nextText = currentText.slice(0, start) + insertText + currentText.slice(end);
          finalCursor = start + insertText.length;
          handled = true;
        }
      }

      if (handled) {
        historyRef.current.push(currentText);
        if (historyRef.current.length > 100) historyRef.current.shift();
        setText(nextText);
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = finalCursor;
            textareaRef.current.selectionEnd = finalCursor;
            textareaRef.current.focus();
          }
        }, 0);
      } else {
        textarea.focus();
      }
    },
    [scrollBottom]
  );

  const registerHandler = useKeyboardStore((s) => s.registerHandler);

  React.useEffect(() => {
    return registerHandler((e) => {
      if (document.activeElement !== textareaRef.current) return false;
      handleKeyEvent(e);
      return true;
    });
  }, [registerHandler, handleKeyEvent]);

  const handleClear = useCallback(() => {
    setText("");
    setEventLog([]);
  }, []);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--ide-bg)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid var(--ide-border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <KeyboardIcon size={18} style={{ color: "var(--ide-accent)" }} />
          <span
            style={{
              fontWeight: 600,
              fontSize: "14px",
              color: "var(--ide-text)",
            }}
          >
            {t("plugin.keyboardTest.title")}
          </span>
        </div>
        <button
          type="button"
          onClick={handleClear}
          style={{
            padding: "4px 12px",
            borderRadius: "6px",
            border: "1px solid var(--ide-border)",
            background: "transparent",
            color: "var(--ide-text)",
            fontSize: "12px",
            cursor: "pointer",
          }}
        >
          {t("plugin.keyboardTest.clear")}
        </button>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            historyRef.current.push(text);
            if (historyRef.current.length > 100) historyRef.current.shift();
            setText(e.target.value);
          }}
          onBlur={(e) => {
            if (e.target.dataset.ignoreBlur === "true") return;
            setUseNativeKb(false);
          }}
          inputMode={useNativeKb ? "text" : "none"}
          placeholder={t("plugin.keyboardTest.placeholder")}
          style={{
            flex: 1,
            padding: "16px",
            paddingBottom: "260px", // space for floating keyboard
            fontFamily: "var(--font-mono)",
            fontSize: "14px",
            lineHeight: 1.6,
            color: "var(--ide-text)",
            background: "var(--ide-panel)",
            border: "none",
            resize: "none",
            outline: "none",
            boxShadow: "inset 0 0 10px rgba(0,0,0,0.05)",
          }}
        />

        <div
          ref={logRef}
          style={{
            width: "130px", // a bit more room for text
            flexShrink: 0,
            overflowY: "auto",
            padding: "12px 8px 260px", // bottom padding so list can scroll past keyboard
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            color: "var(--ide-mute)",
            background: "var(--ide-bg)",
            borderLeft: "1px solid var(--ide-border)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              marginBottom: "8px",
              color: "var(--ide-text)",
              opacity: 0.6,
            }}
          >
            {t("plugin.keyboardTest.eventLog")}
          </div>
          {eventLog.map((entry) => (
            <div
              key={entry.id}
              style={{
                padding: "4px 6px",
                borderRadius: "4px",
                marginBottom: "4px",
                display: "flex",
                justifyContent: "space-between",
                gap: "8px",
                background: "var(--ide-panel)",
              }}
            >
              <span
                style={{
                  color: "var(--ide-text)",
                  fontWeight: entry.event.type === "char" ? 400 : 600,
                  wordBreak: "break-all",
                  whiteSpace: "pre-wrap",
                  textAlign: "center",
                  width: "100%",
                }}
              >
                {entry.formatted}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

registerPage({
  id: "keyboard-test",
  name: "Keyboard Test",
  nameKey: "plugin.keyboardTest.name",
  descriptionKey: "plugin.keyboardTest.description",
  icon: KeyboardIcon,
  order: 20,
  category: "tool",
  singleton: true,
  newPageDefaultVisible: false,
  tags: [{ labelKey: "pageTag.test" }],
  View: KeyboardTestView,
});

export default KeyboardTestView;
