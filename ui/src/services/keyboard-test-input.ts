import type React from "react";
import type { KeyEvent } from "@/components/keyboard";
export function applyKeyboardTestInput(
  e: KeyEvent,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  historyRef: React.RefObject<string[]>,
  setText: (text: string) => void,
  setUseNativeKb: (value: boolean) => void,
  clipboard: { readText: () => Promise<string>; writeText: (text: string) => Promise<void> }
) {
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
    if (start !== end) clipboard.writeText(currentText.slice(start, end));
    textarea.focus();
    return;
  }

  if (e.value === "Cut" || ((e.ctrl || e.meta) && e.value.toLowerCase() === "x")) {
    if (start !== end) {
      clipboard.writeText(currentText.slice(start, end)).then(() => {
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
    clipboard
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
}
