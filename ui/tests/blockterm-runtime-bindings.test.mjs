import assert from "node:assert/strict";
import test from "node:test";

import {
  forgetBlockTermRuntimeBinding,
  getBlockTermRuntimeBinding,
  loadBlockTermRuntimeBindings,
  pruneBlockTermRuntimeBindings,
  rememberBlockTermRuntimeBinding,
} from "../src/components/terminal/blockterm-runtime-bindings.ts";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);

test("remembers and restores an exact runtime binding", () => {
  const storage = createStorage();
  assert.equal(
    rememberBlockTermRuntimeBinding(
      { terminalId: "terminal-a", blockId: "block-a", blockToken: tokenA },
      storage
    ),
    true
  );
  assert.deepEqual(getBlockTermRuntimeBinding("terminal-a", "block-a", storage), {
    terminalId: "terminal-a",
    blockId: "block-a",
    blockToken: tokenA,
  });

  rememberBlockTermRuntimeBinding({ terminalId: "terminal-a", blockId: "block-a", blockToken: tokenB }, storage);
  assert.equal(loadBlockTermRuntimeBindings(storage).length, 1);
  assert.equal(getBlockTermRuntimeBinding("terminal-a", "block-a", storage)?.blockToken, tokenB);
});

test("drops malformed storage and invalid tokens", () => {
  const malformed = createStorage({ vibego_blockterm_runtime_bindings_v1: "{" });
  assert.deepEqual(loadBlockTermRuntimeBindings(malformed), []);

  const invalid = createStorage();
  assert.equal(
    rememberBlockTermRuntimeBinding(
      { terminalId: "terminal-a", blockId: "block-a", blockToken: "not-a-token" },
      invalid
    ),
    false
  );
  assert.deepEqual(loadBlockTermRuntimeBindings(invalid), []);
});

test("forgets only the exact stale token", () => {
  const storage = createStorage();
  rememberBlockTermRuntimeBinding({ terminalId: "terminal-a", blockId: "block-a", blockToken: tokenA }, storage);
  forgetBlockTermRuntimeBinding("terminal-a", "block-a", tokenB, storage);
  assert.equal(getBlockTermRuntimeBinding("terminal-a", "block-a", storage)?.blockToken, tokenA);
  forgetBlockTermRuntimeBinding("terminal-a", "block-a", tokenA, storage);
  assert.equal(getBlockTermRuntimeBinding("terminal-a", "block-a", storage), null);
});

test("prunes one terminal without touching another terminal", () => {
  const storage = createStorage();
  rememberBlockTermRuntimeBinding({ terminalId: "terminal-a", blockId: "keep", blockToken: tokenA }, storage);
  rememberBlockTermRuntimeBinding({ terminalId: "terminal-a", blockId: "stale", blockToken: tokenB }, storage);
  rememberBlockTermRuntimeBinding({ terminalId: "terminal-b", blockId: "stale", blockToken: tokenA }, storage);

  pruneBlockTermRuntimeBindings("terminal-a", new Set(["keep"]), storage);
  assert.deepEqual(loadBlockTermRuntimeBindings(storage), [
    { terminalId: "terminal-a", blockId: "keep", blockToken: tokenA },
    { terminalId: "terminal-b", blockId: "stale", blockToken: tokenA },
  ]);
});
