import type { IBuffer } from "@xterm/xterm";
import { chunkCharacters, chunkMatches } from "./chunk-search.ts";

export function bufferTextChunks(buffer: IBuffer, end: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index <= end; index++) {
    const line = buffer.getLine(index);
    const next = index < end ? buffer.getLine(index + 1) : undefined;
    let endColumn = line?.length ?? 0;
    // A wide glyph moved to the next row can leave an empty padding cell.
    // Preserve actual spaces, including spaces at ordinary soft-wrap boundaries.
    if (next?.isWrapped && next.getCell(0)?.getWidth() === 2 && line?.getCell(endColumn - 1)?.getCode() === 0)
      endColumn--;
    const text = line?.translateToString(!next?.isWrapped, 0, endColumn) ?? "";
    lines.push(index > 0 && !line?.isWrapped ? `\n${text}` : text);
  }
  return lines;
}

export function bufferText(buffer: IBuffer, end: number): string {
  return bufferTextChunks(buffer, end).join("");
}

export function findTextRow(chunks: string[], query: string): number {
  if (!query) return -1;
  const first = chunkMatches(chunks, query).next();
  if (first.done) return -1;
  const [match] = first.value;
  let offset = 0;
  for (let row = 0; row < chunks.length; row++) {
    offset += chunks[row].toLowerCase().length;
    if (match < offset) return row;
  }
  return -1;
}

// Offsets are UTF-16 positions in the rendered row, not terminal cell columns.
export type TextMatchRange = { start: number; end: number; match: number };

export function buildTextSearch(chunks: string[], query: string): { rows: TextMatchRange[][]; matchRows: number[] } {
  const rows: TextMatchRange[][] = chunks.map(() => []);
  const matchRows: number[] = [];
  if (!query) return { rows, matchRows };
  const characters = chunkCharacters(chunks);
  // Match boundaries advance monotonically. Map only those boundaries instead
  // of allocating two numeric arrays for every UTF-16 unit of the output.
  let originalStart = 0;
  let originalEnd = 0;
  let normalizedEnd = 0;
  const advance = (position: number) => {
    while (position >= normalizedEnd) {
      const next = characters.next();
      if (next.done) break;
      originalStart = originalEnd;
      const character = next.value;
      originalEnd += character.length;
      normalizedEnd += character.toLowerCase().length;
    }
  };
  let matchRow = 0;
  let rowStart = 0;
  let rowEnd = chunks[0]?.length ?? 0;
  for (const [index, end] of chunkMatches(chunks, query)) {
    advance(index);
    const start = originalStart;
    advance(end - 1);
    while (matchRow + 1 < chunks.length && start >= rowEnd) {
      rowStart = rowEnd;
      rowEnd += chunks[++matchRow].length;
    }
    const match = matchRows.length;
    matchRows.push(matchRow);
    // Emit directly into the final row index rather than retaining a second
    // complete list of absolute match ranges for dense output.
    for (let row = matchRow, base = rowStart; row < chunks.length && base < originalEnd; row++) {
      const chunk = chunks[row];
      const visibleStart = base + (chunk.startsWith("\n") ? 1 : 0);
      const visibleEnd = base + chunk.length;
      const left = Math.max(visibleStart, start);
      const right = Math.min(visibleEnd, originalEnd);
      if (left < right) {
        rows[row].push({ start: left - visibleStart, end: right - visibleStart, match });
      }
      base = visibleEnd;
    }
  }
  return { rows, matchRows };
}

export function findTextRanges(chunks: string[], query: string, selected?: number): [number, number][][] {
  return buildTextSearch(chunks, query).rows.map((row) =>
    row.filter((range) => selected === undefined || range.match === selected).map((range) => [range.start, range.end])
  );
}

export function findTextMatchRows(chunks: string[], query: string): number[] {
  return buildTextSearch(chunks, query).matchRows;
}
