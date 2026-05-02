import type { Terminal } from "@xterm/xterm";
import type { TerminalCheckpoint } from "./checkpoint-protocol";
import { createCheckpointCell, createCheckpointRow, type XtermCheckpointCell } from "./xterm-checkpoint-cell";

type Link = TerminalCheckpoint["Screens"][number]["Cursor"]["Link"];
const maxPreparedCells = 1 << 16;
interface PreparedLine {
  readonly _data: Uint32Array;
  length: number;
  isWrapped: boolean;
  clone(): PreparedLine;
  fill(cell: XtermCheckpointCell): void;
  setCell(column: number, cell: XtermCheckpointCell): void;
}

export function checkpointLinkKey(link: Link): string {
  return JSON.stringify([link.URL, link.Params]);
}

// This is a buffers-only preparation stage, not an importer. The wire format
// carries soft-wrap flags in v3. Older snapshots require a verified external
// layout, never inferred from spaces. No live line, cursor, mode or link changes.
export function prepareCheckpointBuffers(
  terminal: Terminal,
  checkpoint: TerminalCheckpoint,
  wraps: readonly [readonly boolean[], readonly boolean[]] | undefined = undefined,
  linkIds: ReadonlyMap<string, number> = new Map()
) {
  if (checkpoint.Version < 2 || checkpoint.SavedCharsets?.some((state) => state === null) || !checkpoint.SavedCharsets)
    throw new Error("旧检查点缺少完整保存状态，需要事件回放");
  if (terminal.cols !== checkpoint.Cols || terminal.rows !== checkpoint.Rows)
    throw new Error("检查点准备需要相同终端尺寸");
  if (checkpoint.Version === 3) {
    if (!checkpoint.Wraps || checkpoint.Wraps.some((layout) => layout === null))
      throw new Error("检查点换行布局未知，需要事件回放");
    // The decoded source is authoritative; external flags cannot override it.
    wraps = checkpoint.Wraps as [boolean[], boolean[]];
  }
  if (!Array.isArray(wraps) || wraps.length !== 2) throw new Error("检查点缺少换行布局");
  // Empty/trimmed history rows cost few wire cells but become full-width xterm
  // lines. Bound expanded storage before cloning, not just encoded cell count.
  const expandedCells = checkpoint.Screens.reduce(
    (total, screen) => total + (screen.History.length + checkpoint.Rows) * checkpoint.Cols,
    0
  );
  if (expandedCells > maxPreparedCells) throw new Error("检查点展开后超过缓冲区格子预算");
  const template = (
    terminal as unknown as {
      _core?: {
        _bufferService?: { buffers?: { normal?: { lines?: { get(index: number): PreparedLine | undefined } } } };
      };
    }
  )._core?._bufferService?.buffers?.normal?.lines?.get(0);
  if (
    typeof template?.clone !== "function" ||
    typeof template.fill !== "function" ||
    typeof template.setCell !== "function" ||
    template.length !== checkpoint.Cols ||
    !(template._data instanceof Uint32Array)
  )
    throw new Error("xterm 检查点缓冲区接口不兼容");
  const empty = createCheckpointCell(terminal, {
    Content: "",
    Width: 1,
    Style: { Fg: null, Bg: null, UnderlineColor: null, Underline: 0, Attrs: 0 },
    Link: { URL: "", Params: "" },
  });
  const idFor = (link: Link) => (link.URL ? (linkIds.get(checkpointLinkKey(link)) ?? 0) : 0);
  const screens = checkpoint.Screens.map((screen, index) => {
    const history = screen.History.length;
    if ((index === 1 && history !== 0) || history > (terminal.options.scrollback ?? 0))
      throw new Error("检查点历史超出目标缓冲区能力");
    if (screen.Scroll.Min.X !== 0 || screen.Scroll.Max.X !== checkpoint.Cols)
      throw new Error("检查点横向滚动区尚不受支持");
    const layout = wraps[index];
    if (
      !Array.isArray(layout) ||
      layout.length !== history + checkpoint.Rows ||
      Array.from(layout).some((value) => typeof value !== "boolean")
    )
      throw new Error("检查点换行布局与行数不匹配");
    const lines = [...screen.History, ...screen.Rows].map((row, y) => {
      const cells = createCheckpointRow(
        terminal,
        row,
        row.map((cell) => idFor(cell.Link))
      );
      if (cells.length > checkpoint.Cols) throw new Error("检查点历史宽度需要重排，不能直接截断");
      const line = template.clone();
      if (
        line === template ||
        !(line?._data instanceof Uint32Array) ||
        line._data.buffer === template._data.buffer ||
        line.length !== checkpoint.Cols ||
        typeof line.fill !== "function" ||
        typeof line.setCell !== "function"
      )
        throw new Error("xterm 检查点行复制不独立");
      line.fill(empty);
      line.isWrapped = layout[y];
      cells.forEach((cell, x) => line.setCell(x, cell));
      return line;
    });
    const pen = (cursor: typeof screen.Cursor) =>
      createCheckpointCell(
        terminal,
        {
          Content: "",
          Width: 1,
          Style: cursor.Pen,
          Link: cursor.Link,
        },
        idFor(cursor.Link)
      );
    const phantom = index === checkpoint.Active && checkpoint.Phantom;
    if (
      (phantom && screen.Cursor.X !== checkpoint.Cols - 1) ||
      (screen.SavedPhantom && screen.Saved.X !== checkpoint.Cols - 1)
    )
      throw new Error("检查点待换行位置无效");
    return {
      lines,
      ybase: history,
      ydisp: history,
      x: screen.Cursor.X + (phantom ? 1 : 0),
      y: screen.Cursor.Y,
      savedX: screen.Saved.X + (screen.SavedPhantom ? 1 : 0),
      savedY: history + screen.Saved.Y,
      scrollTop: screen.Scroll.Min.Y,
      scrollBottom: screen.Scroll.Max.Y - 1,
      tabs: Object.fromEntries(checkpoint.Tabs.map((column) => [column, true])),
      pen: pen(screen.Cursor),
      savedPen: pen(screen.Saved),
    };
  });
  return { stage: "buffers-only" as const, active: checkpoint.Active, screens };
}
