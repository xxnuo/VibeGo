import type { ITheme } from "@xterm/xterm";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 12;
const MIN_COLS = 10;
const MAX_COLS = 1024;
const MIN_ROWS = 4;
const MAX_ROWS = 18;
const CELL_HEIGHT = 18;
const TERMINAL_PADDING = 8;

export function resolveBlockTermHistoryTerminalCols(termCols: number | undefined): number {
  if (!Number.isSafeInteger(termCols) || (termCols ?? 0) < MIN_COLS) return DEFAULT_COLS;
  return Math.min(MAX_COLS, termCols as number);
}

export function resolveBlockTermHistoryTerminalRows(termRows: number | undefined): number {
  if (!Number.isSafeInteger(termRows) || (termRows ?? 0) < MIN_ROWS) return DEFAULT_ROWS;
  return Math.min(MAX_ROWS, termRows as number);
}

export function getBlockTermHistoryTerminalHeight(rows: number): number {
  const normalizedRows = resolveBlockTermHistoryTerminalRows(rows);
  return normalizedRows * CELL_HEIGHT + TERMINAL_PADDING;
}

export function getBlockTermHistoryXtermTheme(theme: string): ITheme {
  const isDark = theme !== "light";
  return {
    background: isDark ? "#18181b" : "#ffffff",
    foreground: isDark ? "#d4d4d8" : "#18181b",
    cursor: isDark ? "#a1a1aa" : "#52525b",
    selectionBackground: isDark ? "rgba(161,161,170,0.3)" : "rgba(82,82,91,0.25)",
  };
}
