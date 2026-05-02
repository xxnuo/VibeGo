import assert from "node:assert/strict";
import test from "node:test";

import { cleanupSpeculativeTerminal } from "../src/services/speculative-terminal-cleanup.ts";

test("deletes a terminal created after its workspace scope became stale", async () => {
  const calls = [];

  await cleanupSpeculativeTerminal("terminal-1", {
    delete: async (terminalId) => calls.push(["delete", terminalId]),
    close: async (terminalId) => calls.push(["close", terminalId]),
  });

  assert.deepEqual(calls, [["delete", "terminal-1"]]);
});

test("falls back to closing a speculative terminal when deletion fails", async () => {
  const calls = [];

  await cleanupSpeculativeTerminal("terminal-1", {
    delete: async (terminalId) => {
      calls.push(["delete", terminalId]);
      throw new Error("delete failed");
    },
    close: async (terminalId) => calls.push(["close", terminalId]),
  });

  assert.deepEqual(calls, [
    ["delete", "terminal-1"],
    ["close", "terminal-1"],
  ]);
});
