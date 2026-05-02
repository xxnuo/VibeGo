import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getBlockTermHistoryTerminalHeight,
  getBlockTermHistoryXtermTheme,
  resolveBlockTermHistoryTerminalCols,
  resolveBlockTermHistoryTerminalRows,
} from "../src/components/terminal/blockterm-history-preview.ts";

test("bounds BlockTerm history terminal geometry to a stable preview", () => {
  assert.equal(resolveBlockTermHistoryTerminalCols(undefined), 80);
  assert.equal(resolveBlockTermHistoryTerminalCols(9), 80);
  assert.equal(resolveBlockTermHistoryTerminalCols(120), 120);
  assert.equal(resolveBlockTermHistoryTerminalCols(2_000), 1024);

  assert.equal(resolveBlockTermHistoryTerminalRows(undefined), 12);
  assert.equal(resolveBlockTermHistoryTerminalRows(3), 12);
  assert.equal(resolveBlockTermHistoryTerminalRows(10), 10);
  assert.equal(resolveBlockTermHistoryTerminalRows(100), 18);
  assert.equal(getBlockTermHistoryTerminalHeight(10), 188);
  assert.equal(getBlockTermHistoryTerminalHeight(100), 332);
});

test("uses the existing BlockTerm light and dark xterm palette", () => {
  assert.deepEqual(getBlockTermHistoryXtermTheme("light"), {
    background: "#ffffff",
    foreground: "#18181b",
    cursor: "#52525b",
    selectionBackground: "rgba(82,82,91,0.25)",
  });
  assert.deepEqual(getBlockTermHistoryXtermTheme("dark"), {
    background: "#18181b",
    foreground: "#d4d4d8",
    cursor: "#a1a1aa",
    selectionBackground: "rgba(161,161,170,0.3)",
  });
});

test("History Center reads immutable history output and disposes its read-only xterm", () => {
  const source = readFileSync(
    new URL("../src/components/terminal/blockterm-history-center.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /\.getHistoryOutput\(blockTermHistoryEntryToTarget\(entry\), controller\.signal\)/u);
  assert.doesNotMatch(source, /\.getOutput\(/u);
  assert.match(source, /disableStdin:\s*true/u);
  assert.match(source, /terminal\.dispose\(\)/u);
  assert.match(source, /<BlockTermRendererHost[\s\S]*?readOnly/u);
});
