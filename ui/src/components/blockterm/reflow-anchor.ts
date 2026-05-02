import type { Terminal } from "@xterm/xterm";
import { captureLogicalCursor, mapReflowCursor } from "./reflow-cursor";

// Own the marker until resize has completed; its line follows insertions and trims.
export function captureReflowAnchor(terminal: Terminal, point?: { row: number; column: number }) {
  const buffer = terminal.buffer.active;
  const captured = captureLogicalCursor(buffer, point);
  if (!captured) return null;
  const marker = terminal.registerMarker(captured.startRow - buffer.baseY - buffer.cursorY);
  if (!marker) return null;
  let disposed = false;
  return {
    resolve(allowScrollback = false) {
      if (
        disposed ||
        marker.isDisposed ||
        terminal.buffer.active.type !== "normal" ||
        !terminal.markers.includes(marker)
      )
        return null;
      const cursor = mapReflowCursor(captured.widths, captured.offset, terminal.cols);
      const row = marker.line + cursor.row - terminal.buffer.normal.baseY;
      if ((!allowScrollback && row < 0) || row < -terminal.buffer.normal.baseY || row >= terminal.rows) return null;
      return { ...cursor, row };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      marker.dispose();
    },
  };
}
