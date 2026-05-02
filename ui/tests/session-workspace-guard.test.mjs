import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspaceSaveLatch,
  getTerminalWorkspaceGroupIds,
  sanitizeTerminalWorkspaceState,
  saveLatestWorkspaceSnapshot,
} from "../src/stores/session-workspace-guard.ts";

test("keeps only frame groups that can own terminal workspace state", () => {
  assert.deepEqual(
    [...getTerminalWorkspaceGroupIds([
      { id: "home", type: "home" },
      { id: "files-only", type: "group", pages: [{ type: "files" }] },
      { id: "folder", type: "group", pages: [{ type: "files" }, { type: "terminal" }] },
      { id: "blockterm", type: "tool", pageId: "blockterm" },
      { id: "other-tool", type: "tool", pageId: "other" },
    ])],
    ["folder", "blockterm"]
  );
});

test("removes terminal state owned by an invalid local frame group", () => {
  const sanitized = sanitizeTerminalWorkspaceState(
    {
      terminalsByGroup: {
        valid: [{ id: "terminal-1", name: "Terminal 1" }],
        stale: [{ id: "terminal-stale", name: "Stale terminal" }],
      },
      activeTerminalByGroup: { valid: "terminal-1", stale: "terminal-stale" },
      listManagerOpenByGroup: { valid: false, stale: true },
      terminalLayouts: {
        "terminal-1": { type: "terminal", terminalId: "terminal-1" },
        "terminal-stale": { type: "terminal", terminalId: "terminal-stale" },
      },
      focusedIdByGroup: { valid: "terminal-1", stale: "terminal-stale" },
    },
    new Set(["valid"])
  );

  assert.deepEqual(Object.keys(sanitized.terminalsByGroup), ["valid"]);
  assert.deepEqual(sanitized.activeTerminalByGroup, { valid: "terminal-1" });
  assert.deepEqual(sanitized.focusedIdByGroup, { valid: "terminal-1" });
  assert.deepEqual(sanitized.listManagerOpenByGroup, { valid: false });
  assert.deepEqual(Object.keys(sanitized.terminalLayouts), ["terminal-1"]);
});

test("resaves when workspace state changes while the first save is in flight", async () => {
  let revision = 0;
  let value = "initial";
  const saved = [];

  await saveLatestWorkspaceSnapshot(
    () => revision,
    () => value,
    async (snapshot) => {
      saved.push(snapshot);
      if (saved.length === 1) {
        value = "latest";
        revision += 1;
      }
    }
  );

  assert.deepEqual(saved, ["initial", "latest"]);
});

test("workspace save latch forwards a save failure to superseding transitions", async () => {
  const latch = createWorkspaceSaveLatch("session-1");
  const failure = new Error("save failed");
  latch.reject(failure);
  await assert.rejects(latch.promise, failure);
});
