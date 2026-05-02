import assert from "node:assert/strict";
import test from "node:test";

import {
  getBlockTermRestoreScope,
  getBlockTermRestoreScopeKey,
  getLoadedBlockTermInventory,
  followSupersedingBlockTermInventoryLoad,
  isBlockTermConnectionContinuationCurrent,
  isBlockTermRootTerminalInRestoreScope,
  isBlockTermTerminalInRestoreScope,
  isBlockTermRestoreScopeCurrent,
  mergeBlockTermPersistedBlock,
  resolveBlockTermActiveSessionId,
  resolveBlockTermRestoredOwner,
  resolveBlockTermRestoredStatus,
  restoreBlockTermTerminalInventory,
} from "../src/components/terminal/blockterm-restore.ts";

test("advances BlockTerm replay only with a loaded block inventory", () => {
  const blocks = [{ id: "block-1" }];
  assert.equal(getLoadedBlockTermInventory({ kind: "failed", error: new Error("offline") }), null);
  assert.equal(getLoadedBlockTermInventory({ kind: "stale" }), null);
  assert.equal(getLoadedBlockTermInventory({ kind: "loaded", blocks }), blocks);
});

test("follows the latest BlockTerm inventory when an older request is superseded", async () => {
  let resolveLatest;
  const original = Promise.resolve({ kind: "stale" });
  const latest = new Promise((resolve) => {
    resolveLatest = resolve;
  });
  const following = followSupersedingBlockTermInventoryLoad(
    await original,
    { scopeGeneration: 1, requestId: 1, promise: original },
    () => ({ scopeGeneration: 1, requestId: 2, promise: latest })
  );

  resolveLatest({ kind: "loaded", blocks: [{ id: "block-1" }] });
  assert.deepEqual(await following, { kind: "loaded", blocks: [{ id: "block-1" }] });
});

test("follows a chain of superseding BlockTerm inventory requests", async () => {
  let latestRequest;
  let resolveSecond;
  let resolveThird;
  const first = Promise.resolve({ kind: "stale" });
  const second = new Promise((resolve) => {
    resolveSecond = resolve;
  });
  const third = new Promise((resolve) => {
    resolveThird = resolve;
  });
  latestRequest = second;
  const following = followSupersedingBlockTermInventoryLoad(
    await first,
    { scopeGeneration: 1, requestId: 1, promise: first },
    () => ({
      scopeGeneration: 1,
      requestId: latestRequest === second ? 2 : 3,
      promise: latestRequest,
    })
  );

  latestRequest = third;
  resolveSecond({ kind: "stale" });
  resolveThird({ kind: "failed", error: new Error("inventory unavailable") });
  const outcome = await following;
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.error.message, /inventory unavailable/);
});

test("keeps a stale BlockTerm inventory outcome when no newer request exists", async () => {
  const request = Promise.resolve({ kind: "stale" });
  const node = { scopeGeneration: 1, requestId: 1, promise: request };
  assert.deepEqual(await followSupersedingBlockTermInventoryLoad(await request, node, () => node), { kind: "stale" });
});

test("does not follow a superseding BlockTerm inventory request from another scope", async () => {
  const request = Promise.resolve({ kind: "stale" });
  const otherScope = Promise.resolve({ kind: "loaded", blocks: [{ id: "wrong-scope" }] });
  assert.deepEqual(
    await followSupersedingBlockTermInventoryLoad(
      await request,
      { scopeGeneration: 1, requestId: 1, promise: request },
      () => ({ scopeGeneration: 2, requestId: 2, promise: otherScope })
    ),
    { kind: "stale" }
  );
});

test("creates a BlockTerm terminal only after a successful empty inventory", async () => {
  const calls = [];
  assert.equal(
    await restoreBlockTermTerminalInventory({
      load: async () => [],
      restore: async () => calls.push("restore"),
      create: async () => calls.push("create"),
    }),
    "created"
  );
  assert.deepEqual(calls, ["create"]);
});

test("does not create a BlockTerm terminal when inventory restore fails", async () => {
  const failure = new Error("inventory unavailable");
  let created = false;
  await assert.rejects(
    restoreBlockTermTerminalInventory({
      load: async () => {
        throw failure;
      },
      restore: async () => {},
      create: async () => {
        created = true;
      },
    }),
    failure
  );
  assert.equal(created, false);
});

test("does not fall back to a new terminal when restoring existing inventory fails", async () => {
  const failure = new Error("restore failed");
  let created = false;
  await assert.rejects(
    restoreBlockTermTerminalInventory({
      load: async () => [{ id: "terminal-1" }],
      restore: async () => {
        throw failure;
      },
      create: async () => {
        created = true;
      },
    }),
    failure
  );
  assert.equal(created, false);
});

test("defers BlockTerm restore until workspace session initialization completes", () => {
  assert.equal(getBlockTermRestoreScope("tool-blockterm", null, false, false), null);
  assert.equal(getBlockTermRestoreScope("tool-blockterm", null, true, true), null);
  assert.deepEqual(getBlockTermRestoreScope("tool-blockterm", "session-1", true, false), {
    groupId: "tool-blockterm",
    workspaceSessionId: "session-1",
  });
});

test("restores an unscoped BlockTerm workspace when no saved session exists", () => {
  assert.deepEqual(getBlockTermRestoreScope("tool-blockterm", null, true, false), {
    groupId: "tool-blockterm",
    workspaceSessionId: undefined,
  });
});

test("changes the restore scope key only when the group or workspace session changes", () => {
  const initial = getBlockTermRestoreScopeKey("tool-blockterm", null);
  assert.equal(getBlockTermRestoreScopeKey("tool-blockterm", null), initial);
  assert.notEqual(getBlockTermRestoreScopeKey("tool-blockterm", "session-1"), initial);
  assert.notEqual(getBlockTermRestoreScopeKey("tool-other", null), initial);
});

test("rejects a restore continuation after the workspace session changes", () => {
  const scoped = getBlockTermRestoreScope("tool-blockterm", "session-1", true, false);
  const unscoped = getBlockTermRestoreScope("tool-blockterm", null, true, false);
  assert.ok(scoped);
  assert.ok(unscoped);
  assert.equal(isBlockTermRestoreScopeCurrent(scoped, "session-1"), true);
  assert.equal(isBlockTermRestoreScopeCurrent(scoped, "session-2"), false);
  assert.equal(isBlockTermRestoreScopeCurrent(unscoped, null), true);
  assert.equal(isBlockTermRestoreScopeCurrent(unscoped, "session-1"), false);
});

test("keeps unscoped restore from adopting workspace-owned terminals", () => {
  assert.equal(isBlockTermTerminalInRestoreScope("", undefined), true);
  assert.equal(isBlockTermTerminalInRestoreScope(undefined, null), true);
  assert.equal(isBlockTermTerminalInRestoreScope("session-1", undefined), false);
  assert.equal(isBlockTermTerminalInRestoreScope("session-1", "session-1"), true);
  assert.equal(isBlockTermTerminalInRestoreScope("session-2", "session-1"), false);
});

test("restores renamed BlockTerm roots by ownership and excludes split children", () => {
  assert.equal(isBlockTermRootTerminalInRestoreScope("session-1", "session-1", ""), true);
  assert.equal(isBlockTermRootTerminalInRestoreScope("session-1", "session-1", undefined), true);
  assert.equal(isBlockTermRootTerminalInRestoreScope("session-1", "session-1", "root-terminal"), false);
  assert.equal(isBlockTermRootTerminalInRestoreScope("session-2", "session-1", ""), false);
});

test("preserves a persisted active BlockTerm terminal when it is still present", () => {
  assert.equal(resolveBlockTermActiveSessionId(["terminal-1", "terminal-2"], "terminal-2"), "terminal-2");
  assert.equal(resolveBlockTermActiveSessionId(["terminal-1", "terminal-2"], "other"), "terminal-1");
  assert.equal(resolveBlockTermActiveSessionId([], "terminal-1"), null);
});

test("lets durable terminal states replace stale running restore state", () => {
  assert.equal(resolveBlockTermRestoredStatus({ persistedStatus: "success", localStatus: "running" }), "success");
  assert.equal(resolveBlockTermRestoredStatus({ persistedStatus: "error", localStatus: "running" }), "error");
  assert.equal(resolveBlockTermRestoredStatus({ persistedStatus: "running", localStatus: "running" }), "running");
  assert.equal(
    resolveBlockTermRestoredStatus({ persistedStatus: "running", localStatus: "interrupted" }),
    "interrupted"
  );
  assert.equal(
    resolveBlockTermRestoredStatus({
      persistedStatus: "success",
      localStatus: "running",
      pendingStatus: "interrupted",
    }),
    "interrupted"
  );
});

test("releases a stale active owner when durable restore is terminal", () => {
  assert.deepEqual(
    resolveBlockTermRestoredOwner({
      sessionId: "terminal-1",
      currentActiveBlockId: "block-old",
      ended: false,
      blocks: [
        {
          id: "block-old",
          terminalId: "terminal-1",
          status: "success",
          lineNum: 1,
          startedAt: 100,
        },
      ],
    }),
    { activeBlockId: null, releasedBlockId: "block-old" }
  );
  assert.deepEqual(
    resolveBlockTermRestoredOwner({
      sessionId: "terminal-1",
      currentActiveBlockId: "block-old",
      ended: false,
      blocks: [
        {
          id: "block-old",
          terminalId: "terminal-1",
          status: "success",
          lineNum: 1,
          startedAt: 100,
        },
        {
          id: "block-new",
          terminalId: "terminal-1",
          status: "running",
          lineNum: 2,
          startedAt: 200,
        },
      ],
    }),
    { activeBlockId: "block-new", releasedBlockId: "block-old" }
  );
});

test("keeps a closed socket continuation current until a new connection token replaces it", () => {
  const runtime = { scopeGeneration: 7, connectionToken: 3, ws: null };
  assert.equal(isBlockTermConnectionContinuationCurrent(runtime, 7, 3), true);
  assert.equal(isBlockTermConnectionContinuationCurrent(runtime, 7, 4), false);
  assert.equal(isBlockTermConnectionContinuationCurrent(runtime, 8, 3), false);
});

test("merges persisted block metadata with local and pending note fields", () => {
  const persisted = {
    id: "block-1",
    terminalId: "terminal-1",
    lineNum: 1,
    kind: "command",
    command: "echo persisted",
    text: "persisted text",
    output: "persisted output",
    outputSize: 20,
    outputCursor: 3,
    cmdPid: 101,
    remotePid: 202,
    termCols: 80,
    termRows: 24,
    termFlexRows: false,
    termMaxPtySize: 1024,
    beforeStateJson: '{"cwd":"/persisted"}',
    afterStateJson: '{"cwd":"/persisted-after"}',
    status: "success",
    mode: "text",
    cwd: "/persisted",
    exitCode: 0,
    startedAt: 100,
    finishedAt: 120,
    collapsed: false,
    pinned: false,
    archived: false,
    starred: false,
    renderer: "markdown",
    stateJson: "persisted-state",
    presentationJson: "persisted-presentation",
  };
  const existing = {
    ...persisted,
    kind: "note",
    command: "",
    text: "local text",
    output: "local output",
    outputSize: 12,
    outputCursor: 2,
    cmdPid: 303,
    remotePid: 404,
    termCols: 100,
    termRows: 30,
    termFlexRows: true,
    termMaxPtySize: 2048,
    beforeStateJson: '{"cwd":"/local"}',
    afterStateJson: '{"cwd":"/local-after"}',
    status: "running",
    mode: "terminal",
    cwd: "/local",
    exitCode: null,
    startedAt: 110,
    finishedAt: 220,
    collapsed: true,
    pinned: true,
    archived: true,
    starred: true,
    renderer: "local-renderer",
    stateJson: "local-state",
    presentationJson: "local-presentation",
  };
  const merge = (overrides = {}) =>
    mergeBlockTermPersistedBlock({
      persisted,
      outputSize: 99,
      outputCursor: 7,
      ...overrides,
    });

  const pending = merge({
    existing,
    pendingPatch: {
      kind: "renderer",
      text: "pending text",
      presentationJson: "pending-presentation",
      cmdPid: null,
      remotePid: 505,
      termCols: 120,
      termRows: 40,
      termFlexRows: false,
      termMaxPtySize: 4096,
      beforeStateJson: '{"cwd":"/pending"}',
      afterStateJson: '{"cwd":"/pending-after"}',
      finishedAt: null,
    },
    localStatus: "error",
    localMode: "text",
  });

  assert.equal(pending.kind, "renderer");
  assert.equal(pending.text, "pending text");
  assert.equal(pending.presentationJson, "pending-presentation");
  assert.equal(pending.finishedAt, undefined);
  assert.equal(pending.status, "error");
  assert.equal(pending.mode, "text");
  assert.equal(pending.output, "");
  assert.equal(pending.outputSize, 99);
  assert.equal(pending.outputCursor, 7);
  assert.equal(pending.cmdPid, null);
  assert.equal(pending.remotePid, 505);
  assert.equal(pending.termCols, 120);
  assert.equal(pending.termRows, 40);
  assert.equal(pending.termFlexRows, false);
  assert.equal(pending.termMaxPtySize, 4096);
  assert.equal(pending.beforeStateJson, '{"cwd":"/pending"}');
  assert.equal(pending.afterStateJson, '{"cwd":"/pending-after"}');

  const local = merge({ existing });
  assert.equal(local.kind, "note");
  assert.equal(local.text, "local text");
  assert.equal(local.presentationJson, "local-presentation");
  assert.equal(local.status, "success");
  assert.equal(local.cwd, "/persisted");
  assert.equal(local.exitCode, 0);
  assert.equal(local.finishedAt, 120);
  assert.equal(local.afterStateJson, '{"cwd":"/persisted-after"}');
  assert.equal(local.cmdPid, 303);
  assert.equal(local.remotePid, 404);
  assert.equal(local.termCols, 100);
  assert.equal(local.termRows, 30);
  assert.equal(local.termFlexRows, true);
  assert.equal(local.termMaxPtySize, 2048);
  assert.equal(local.beforeStateJson, '{"cwd":"/local"}');

  const remote = merge();
  assert.equal(remote.kind, "command");
  assert.equal(remote.text, "persisted text");
  assert.equal(remote.presentationJson, "persisted-presentation");
  assert.equal(remote.finishedAt, 120);
  assert.equal(remote.cmdPid, 101);
  assert.equal(remote.remotePid, 202);
  assert.equal(remote.termCols, 80);
  assert.equal(remote.termRows, 24);
  assert.equal(remote.termFlexRows, false);
  assert.equal(remote.termMaxPtySize, 1024);
  assert.equal(remote.beforeStateJson, '{"cwd":"/persisted"}');
  assert.equal(remote.afterStateJson, '{"cwd":"/persisted-after"}');
});
