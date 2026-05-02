import type { IBuffer } from "@xterm/xterm";

export function captureLogicalCursor(buffer: IBuffer, point = { row: buffer.cursorY, column: buffer.cursorX }) {
  if (buffer.type !== "normal") return null;
  const cursorRow = buffer.baseY + point.row;
  if (
    !Number.isInteger(cursorRow) ||
    cursorRow < 0 ||
    cursorRow >= buffer.length ||
    !Number.isInteger(point.column) ||
    point.column < 0
  )
    return null;
  let startRow = cursorRow;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) startRow--;
  let endRow = cursorRow;
  while (endRow + 1 < buffer.length && buffer.getLine(endRow + 1)?.isWrapped) endRow++;
  const widths: number[] = [];
  let offset = 0;
  for (let row = startRow; row <= endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) return null;
    const next = row + 1 < buffer.length ? buffer.getLine(row + 1) : undefined;
    let end = line.length;
    if (next?.isWrapped && next.getCell(0)?.getWidth() === 2 && line.getCell(end - 1)?.getCode() === 0) end--;
    if (row === endRow) {
      while (end > 0) {
        const cell = line.getCell(end - 1);
        if (cell?.getCode() || cell?.getWidth() === 0) break;
        end--;
      }
    }
    for (let column = 0; column < end; ) {
      const width = line.getCell(column)?.getWidth();
      if (width !== 1 && width !== 2) return null;
      if (row === cursorRow && column < point.column && column + width > point.column) return null;
      widths.push(width);
      if (row < cursorRow || (row === cursorRow && column < point.column)) offset += width;
      column += width;
    }
    if (row === cursorRow && point.column > end) offset += point.column - end;
  }
  return { startRow, widths, offset };
}

export interface ReflowCursor {
  row: number;
  column: number;
  pendingWrap: boolean;
}

// Widths describe logical content cells, excluding wide-glyph padding at row ends.
// Combining marks belong to their base cell and do not add another width entry.
export function mapReflowCursor(widths: readonly number[], offset: number, columns: number): ReflowCursor {
  if (!Number.isSafeInteger(columns) || columns < 2 || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid reflow cursor geometry");
  if (widths.some((width) => width !== 1 && width !== 2)) throw new Error("Invalid logical cell width");
  let row = 0;
  let column = 0;
  let consumed = 0;
  for (const width of widths) {
    // A wide glyph moves as a unit, leaving non-content padding behind.
    if (column + width > columns) {
      row++;
      column = 0;
    }
    if (consumed === offset) return { row, column, pendingWrap: false };
    if (consumed + width > offset) throw new Error("Cursor offset is inside a wide cell");
    consumed += width;
    column += width;
  }
  // A cursor can lie in blank cells beyond the last rendered character.
  if (consumed < offset) {
    const position = column + offset - consumed;
    row += Math.floor((position - 1) / columns);
    column = ((position - 1) % columns) + 1;
  }
  return column === columns ? { row, column: columns - 1, pendingWrap: true } : { row, column, pendingWrap: false };
}
