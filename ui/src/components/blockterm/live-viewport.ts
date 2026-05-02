import type { Terminal } from "@xterm/xterm";

// Crop unused normal-screen rows without resizing the PTY or the terminal grid.
export function compactLiveViewport(terminal: Terminal, host: HTMLElement) {
  let frame = 0;
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const update = () => {
    frame = 0;
    if (!screen) return;
    const buffer = terminal.buffer.active;
    let rows = terminal.rows;
    if (buffer.type === "normal" && buffer.baseY === 0 && terminal.modes.mouseTrackingMode === "none") {
      rows = Math.min(terminal.rows, buffer.cursorY + 1);
      for (let y = terminal.rows - 1; y >= rows; y--) {
        const line = buffer.getLine(y);
        if (!line) continue;
        let painted = line.translateToString(true).length > 0;
        for (let x = 0; !painted && x < line.length; x++) {
          const cell = line.getCell(x);
          painted =
            !!cell &&
            (!cell.isBgDefault() ||
              !!cell.isInverse() ||
              !!cell.isUnderline() ||
              !!cell.isStrikethrough() ||
              !!cell.isOverline());
        }
        if (painted) {
          rows = y + 1;
          break;
        }
      }
    }
    const height = screen.getBoundingClientRect().height;
    host.style.maxHeight = height > 0 ? `${Math.ceil((height * rows) / terminal.rows)}px` : "";
    host.dataset.liveRows = String(rows);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const subscriptions = [
    terminal.onRender(schedule),
    terminal.onWriteParsed(schedule),
    terminal.onResize(schedule),
    terminal.onScroll(schedule),
    terminal.buffer.onBufferChange(schedule),
  ];
  const observer = new ResizeObserver(schedule);
  if (screen) observer.observe(screen);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    for (const subscription of subscriptions) subscription.dispose();
    host.style.maxHeight = "";
    delete host.dataset.liveRows;
  };
}
