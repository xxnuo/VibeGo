import type { Terminal } from "@xterm/xterm";
import type { ReflowCursor } from "./reflow-cursor";

// xterm's public cursor is read-only and CUP clears pending wrap. Keep the private
// compatibility boundary here, guarded and covered by real-parser continuation tests.
export function restoreReflowCursor(terminal: Terminal, cursor: ReflowCursor, saved = false): boolean {
  if (
    terminal.buffer.active.type !== "normal" ||
    !Number.isInteger(cursor.row) ||
    cursor.row < (saved ? -terminal.buffer.normal.baseY : 0) ||
    cursor.row >= terminal.rows ||
    !Number.isInteger(cursor.column) ||
    cursor.column < 0 ||
    cursor.column >= terminal.cols ||
    (cursor.pendingWrap && cursor.column !== terminal.cols - 1)
  )
    return false;
  const internal = terminal as unknown as {
    _core?: { _bufferService?: { buffer?: { x: number; y: number; savedX?: number; savedY?: number } } };
  };
  const buffer = internal._core?._bufferService?.buffer;
  if (!buffer || buffer.x !== terminal.buffer.active.cursorX || buffer.y !== terminal.buffer.active.cursorY)
    return false;
  if (saved) {
    if (!Number.isInteger(buffer.savedX) || !Number.isInteger(buffer.savedY)) return false;
    buffer.savedX = cursor.column + (cursor.pendingWrap ? 1 : 0);
    buffer.savedY = terminal.buffer.normal.baseY + cursor.row;
    return true;
  }
  buffer.x = cursor.column + (cursor.pendingWrap ? 1 : 0);
  buffer.y = cursor.row;
  terminal.refresh(0, terminal.rows - 1);
  return true;
}

export function readSavedCursor(terminal: Terminal) {
  if (terminal.buffer.active.type !== "normal") return null;
  const internal = terminal as unknown as {
    _core?: { _bufferService?: { buffer?: { savedX?: number; savedY?: number } } };
  };
  const buffer = internal._core?._bufferService?.buffer;
  if (!buffer || !Number.isInteger(buffer.savedX) || !Number.isInteger(buffer.savedY)) return null;
  return { column: buffer.savedX!, row: buffer.savedY! - terminal.buffer.normal.baseY };
}

// Installed only by the reflow integration: let xterm restore attributes and
// charset first, then retain its saved pending-wrap position instead of clamping it.
export function installSavedWrapRestore(terminal: Terminal) {
  const internal = terminal as unknown as {
    _core?: { _inputHandler?: { restoreCursor: () => boolean } };
  };
  const handler = internal._core?._inputHandler;
  if (typeof handler?.restoreCursor !== "function") return null;
  const restore = () => {
    const saved = readSavedCursor(terminal);
    if (!saved || saved.column !== terminal.cols || saved.row < 0 || saved.row >= terminal.rows) return false;
    handler.restoreCursor();
    restoreReflowCursor(terminal, { row: saved.row, column: terminal.cols - 1, pendingWrap: true });
    return true;
  };
  const esc = terminal.parser.registerEscHandler({ final: "8" }, restore);
  const csi = terminal.parser.registerCsiHandler({ final: "u" }, restore);
  return {
    dispose() {
      esc.dispose();
      csi.dispose();
    },
  };
}
