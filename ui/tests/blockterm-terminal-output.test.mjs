import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKTERM_TERMINAL_CONVERT_EOL,
  appendBlockTermTerminalBytes,
  getBlockTermTerminalCellHeight,
  getBlockTermTerminalHeight,
  getBlockTermTerminalHydrationValue,
  getBlockTermTerminalInitialUsedRows,
  getBlockTermTerminalRowsOption,
  getBlockTermTerminalUsedRows,
  hasAcknowledgedBlockTermRawTarget,
  hasReachedBlockTermRawTarget,
  mergeBlockTermRawTarget,
  resolveBlockTermTerminalMaxPtySize,
  resolveBlockTermTerminalRows,
  resolveBlockTermTerminalUsedRows,
  resolveBlockTermTerminalWrite,
  shouldUseBlockTermTerminalRenderer,
} from "../src/components/terminal/blockterm-terminal-output.ts";

function bytes(...values) {
  return Uint8Array.from(values);
}

test("restores normal newline display without changing retained raw bytes", () => {
  assert.equal(BLOCKTERM_TERMINAL_CONVERT_EOL, true);
  assert.deepEqual(getBlockTermTerminalHydrationValue(bytes(0x41, 0x0a, 0x42), "lossy"), bytes(0x41, 0x0a, 0x42));
});

test("prefers retained raw bytes when hydrating a remounted terminal", () => {
  const raw = bytes(0x1b, 0x5b, 0x32, 0x4a, 0x00, 0xff);
  assert.deepEqual(getBlockTermTerminalHydrationValue(raw, "lossy projection"), raw);
  assert.deepEqual(getBlockTermTerminalHydrationValue(raw, ""), raw);
  assert.equal(getBlockTermTerminalHydrationValue(new Uint8Array(), "text fallback"), "text fallback");
  assert.equal(getBlockTermTerminalHydrationValue(undefined, "text fallback"), "text fallback");
});

test("resets a fresh terminal with the complete raw snapshot", () => {
  const result = resolveBlockTermTerminalWrite(null, {
    data: bytes(0x1b, 0xff, 0x00),
    startCursor: 40,
    endCursor: 43,
  });

  assert.equal(result.reset, true);
  assert.equal(result.cursor, 43);
  assert.deepEqual(result.data, bytes(0x1b, 0xff, 0x00));
});

test("writes only the suffix that follows the current PTY cursor", () => {
  const result = resolveBlockTermTerminalWrite(42, {
    data: bytes(0x61, 0x62, 0x63, 0x64),
    startCursor: 40,
    endCursor: 44,
  });

  assert.equal(result.reset, false);
  assert.equal(result.cursor, 44);
  assert.deepEqual(result.data, bytes(0x63, 0x64));
});

test("ignores a stale raw snapshot", () => {
  const result = resolveBlockTermTerminalWrite(50, {
    data: bytes(0x61, 0x62),
    startCursor: 48,
    endCursor: 50,
  });

  assert.equal(result.reset, false);
  assert.equal(result.cursor, 50);
  assert.equal(result.data.length, 0);
});

test("resets when retained raw output starts after the current cursor", () => {
  const result = resolveBlockTermTerminalWrite(12, {
    data: bytes(0x61, 0x62, 0x63),
    startCursor: 20,
    endCursor: 23,
  });

  assert.equal(result.reset, true);
  assert.equal(result.cursor, 23);
  assert.deepEqual(result.data, bytes(0x61, 0x62, 0x63));
});

test("resets for missing or non-contiguous cursor ranges", () => {
  for (const chunk of [
    { data: bytes(0x61), startCursor: null, endCursor: 21 },
    { data: bytes(0x61), startCursor: 20, endCursor: null },
    { data: bytes(0x61, 0x62), startCursor: 20, endCursor: 24 },
  ]) {
    const result = resolveBlockTermTerminalWrite(20, chunk);
    assert.equal(result.reset, true);
    assert.deepEqual(result.data, chunk.data);
  }
});

test("uses terminal as the default renderer and keeps reserved renderer semantics", () => {
  assert.equal(shouldUseBlockTermTerminalRenderer(undefined), true);
  assert.equal(shouldUseBlockTermTerminalRenderer(""), true);
  assert.equal(shouldUseBlockTermTerminalRenderer("terminal"), true);
  assert.equal(shouldUseBlockTermTerminalRenderer("none"), false);
  assert.equal(shouldUseBlockTermTerminalRenderer("markdown"), false);
});

test("restores persisted terminal rows for fixed and flex renderers", () => {
  assert.equal(resolveBlockTermTerminalRows(41, 24), 41);
  assert.equal(resolveBlockTermTerminalRows(0, 24), 24);
  assert.equal(resolveBlockTermTerminalRows(2048, 24), 1024);
  assert.deepEqual(getBlockTermTerminalRowsOption(41, 24), { rows: 41 });
  assert.equal(getBlockTermTerminalInitialUsedRows(false, false, 41), 41);
  assert.equal(getBlockTermTerminalInitialUsedRows(true, true, 41), 1);
  assert.equal(getBlockTermTerminalInitialUsedRows(true, false, 41), 0);
});

test("measures WaveTerm-compatible flex rows from cursor and physical content", () => {
  const measure = ({ lines = [], bufferLength = 8, cursorY = 0, isRunning = false, maxRows = 8 } = {}) =>
    getBlockTermTerminalUsedRows({
      bufferLength,
      cursorY,
      isRunning,
      maxRows,
      getLineText: (index) => lines[index] || "",
    });

  assert.equal(measure(), 0, "a completed empty terminal has zero visible rows");
  assert.equal(measure({ isRunning: true }), 1, "a running empty terminal keeps an input row");
  assert.equal(measure({ isRunning: true, cursorY: 3 }), 4, "the running cursor extends visible rows");
  assert.equal(measure({ lines: ["", "output", "", "tail"] }), 4, "the last non-blank physical row wins");
  assert.equal(measure({ lines: ["", "  ", "\t"] }), 0, "whitespace-only rows do not add height");
  assert.equal(measure({ bufferLength: 9 }), 8, "scrollback fills the configured terminal row limit");
});

test("allows flex rows to shrink only on forced recalculation", () => {
  assert.equal(resolveBlockTermTerminalUsedRows(true, 6, 3, 12, false), 6);
  assert.equal(resolveBlockTermTerminalUsedRows(true, 6, 8, 12, false), 8);
  assert.equal(resolveBlockTermTerminalUsedRows(true, 6, 3, 12, true), 3);
  assert.equal(resolveBlockTermTerminalUsedRows(false, 3, 1, 12, false), 12);
});

test("matches xterm DPR row rounding when calculating terminal height", () => {
  const cellHeight = getBlockTermTerminalCellHeight({
    cssCellHeight: 99,
    deviceCellHeight: 31,
    devicePixelRatio: 2,
    totalRows: 41,
  });
  assert.equal(cellHeight, 636 / 41);
  assert.equal(getBlockTermTerminalHeight(7, 41, cellHeight), 109);
  assert.equal(
    getBlockTermTerminalCellHeight({ cssCellHeight: 15.5, devicePixelRatio: 2, totalRows: 41 }),
    15.5
  );
  assert.equal(getBlockTermTerminalHeight(0, 41, cellHeight), 0);
});

test("uses persisted max PTY size for the retained raw tail", () => {
  assert.equal(resolveBlockTermTerminalMaxPtySize(4, 16), 4);
  assert.equal(resolveBlockTermTerminalMaxPtySize(0, 16), 16);
  assert.equal(resolveBlockTermTerminalMaxPtySize(32, 16), 16);
  assert.deepEqual(appendBlockTermTerminalBytes(bytes(1, 2, 3), bytes(4, 5), 4), bytes(2, 3, 4, 5));
  assert.deepEqual(appendBlockTermTerminalBytes(bytes(1, 2), bytes(3, 4, 5, 6, 7), 4), bytes(4, 5, 6, 7));
});

test("keeps the furthest raw completion watermark and checks it monotonically", () => {
  assert.equal(mergeBlockTermRawTarget(null, 80), 80);
  assert.equal(mergeBlockTermRawTarget(80, 70), 80);
  assert.equal(mergeBlockTermRawTarget(80, 90), 90);
  assert.equal(mergeBlockTermRawTarget(80, null), 80);
  assert.equal(hasReachedBlockTermRawTarget(null, null), true);
  assert.equal(hasReachedBlockTermRawTarget(79, 80), false);
  assert.equal(hasReachedBlockTermRawTarget(80, 80), true);
  assert.equal(hasReachedBlockTermRawTarget(81, 80), true);
});

test("acknowledges completion targets only after the matching recorder-barrier request", () => {
  assert.equal(hasAcknowledgedBlockTermRawTarget(null, null), true);
  assert.equal(hasAcknowledgedBlockTermRawTarget(null, 80), false, "legacy fallback must not acknowledge raw data");
  assert.equal(hasAcknowledgedBlockTermRawTarget(80, 80), true, "an empty successful raw response still crosses the barrier");
  assert.equal(hasAcknowledgedBlockTermRawTarget(80, 90), false, "a target that advances during the request needs another GET");
  assert.equal(hasAcknowledgedBlockTermRawTarget(90, 90), true);
});
