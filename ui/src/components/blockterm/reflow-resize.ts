import type { Terminal } from "@xterm/xterm";
import { captureReflowAnchor } from "./reflow-anchor";
import { readSavedCursor, restoreReflowCursor } from "./xterm-cursor";

export function resizeCommandOutput(terminal: Terminal, cols: number, rows: number) {
  const savedPoint = readSavedCursor(terminal);
  const active = savedPoint && captureReflowAnchor(terminal);
  const saved = savedPoint && captureReflowAnchor(terminal, savedPoint);
  const previous = terminal.options.reflowCursorLine;
  try {
    terminal.options.reflowCursorLine = !!active;
    terminal.resize(cols, rows);
    if (active) {
      const cursor = active.resolve();
      if (!cursor || !restoreReflowCursor(terminal, cursor)) throw new Error("终端重排后无法恢复光标位置");
      const savedCursor = saved?.resolve(true);
      if (savedCursor && !restoreReflowCursor(terminal, savedCursor, true))
        throw new Error("终端重排后无法恢复保存的光标位置");
    }
  } finally {
    terminal.options.reflowCursorLine = previous;
    active?.dispose();
    saved?.dispose();
  }
}
