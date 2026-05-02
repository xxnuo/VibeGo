import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKTERM_SIDEBAR_DEFAULT_WIDTH,
  DEFAULT_BLOCKTERM_VIEW_STATE,
  isBlockTermSidebarOwner,
  isBlockTermViewScopeCurrent,
  legalizeBlockTermSidebarState,
  partitionBlockTermSidebarBlocks,
  parseBlockTermViewJSON,
  queueBlockTermViewLoadAfterWrites,
  queueBlockTermViewWriteAfterLoad,
  resolveBlockTermSidebarBody,
  resolveBlockTermSidebarWidth,
  resolveBlockTermViewWrite,
  sanitizeBlockTermViewState,
  serializeBlockTermViewState,
  setBlockTermNextConnectionState,
  setBlockTermSidebarState,
  shouldLegalizeBlockTermSidebarState,
} from "../src/components/terminal/blockterm-sidebar.ts";

test("waits for writes from the previous scope before reloading a reused terminal ID", async () => {
  let releaseWrite;
  const previousWrite = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let loadStarted = false;
  const queued = queueBlockTermViewLoadAfterWrites(previousWrite, async () => {
    loadStarted = true;
  });

  await Promise.resolve();
  assert.equal(loadStarted, false);
  releaseWrite();
  await queued;
  assert.equal(loadStarted, true);
});

test("drops a queued view load after its scope resets even when the terminal ID is reused", async () => {
  let releaseWrite;
  const previousWrite = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const requestScopeGeneration = 7;
  let currentScopeGeneration = requestScopeGeneration;
  let applied = false;
  const queued = queueBlockTermViewLoadAfterWrites(previousWrite, async () => {
    if (!isBlockTermViewScopeCurrent(requestScopeGeneration, currentScopeGeneration)) return;
    applied = true;
  });

  currentScopeGeneration += 1;
  releaseWrite();
  await queued;
  assert.equal(applied, false);
  assert.equal(isBlockTermViewScopeCurrent(currentScopeGeneration, currentScopeGeneration), true);
});

test("waits for the initial confirmed view before the first sidebar write", async () => {
  let releaseLoad;
  const confirmedLoad = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  let writeStarted = false;
  const queued = queueBlockTermViewWriteAfterLoad(Promise.resolve(), confirmedLoad, async () => {
    writeStarted = true;
  });

  await Promise.resolve();
  assert.equal(writeStarted, false);
  releaseLoad();
  await queued;
  assert.equal(writeStarted, true);
});

test("normalizes BlockTerm screen sidebar state", () => {
  assert.deepEqual(parseBlockTermViewJSON(), DEFAULT_BLOCKTERM_VIEW_STATE);
  assert.deepEqual(
    parseBlockTermViewJSON(
      JSON.stringify({ sidebar: { open: true, width: "500px", block_id: "block-1", ignored: true } })
    ),
    { sidebar: { open: true, width: "500px", blockId: "block-1" } }
  );
  assert.deepEqual(parseBlockTermViewJSON('{"sidebar":{"open":true,"width":"101%","block_id":""}}'), {
    sidebar: { open: true, width: "50%", blockId: null },
  });
  assert.deepEqual(parseBlockTermViewJSON("{bad"), DEFAULT_BLOCKTERM_VIEW_STATE);
  assert.equal(
    serializeBlockTermViewState({ sidebar: { open: true, width: "500px", blockId: "block-2" } }),
    '{"sidebar":{"open":true,"width":"500px","block_id":"block-2"}}'
  );
});

test("round-trips and updates the durable next connection without changing the sidebar", () => {
  const parsed = parseBlockTermViewJSON(
    JSON.stringify({
      sidebar: { open: true, width: "500px", block_id: "block-1" },
      next_connection: { runtime_type: "ssh", ssh_profile_id: " profile-a ", cwd: "/remote/a" },
    })
  );
  assert.deepEqual(parsed, {
    sidebar: { open: true, width: "500px", blockId: "block-1" },
    nextConnection: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/remote/a" },
  });
  assert.equal(
    serializeBlockTermViewState(parsed),
    '{"sidebar":{"open":true,"width":"500px","block_id":"block-1"},"next_connection":{"runtime_type":"ssh","ssh_profile_id":"profile-a","cwd":"/remote/a"}}'
  );
  assert.deepEqual(setBlockTermNextConnectionState(parsed, { runtimeType: "local", cwd: "/local" }), {
    sidebar: parsed.sidebar,
    nextConnection: { runtimeType: "local", cwd: "/local" },
  });
  assert.deepEqual(setBlockTermNextConnectionState(parsed, null), { sidebar: parsed.sidebar });
});

test("replaces the single sidebar owner and preserves close semantics", () => {
  const first = setBlockTermSidebarState(DEFAULT_BLOCKTERM_VIEW_STATE, {
    open: true,
    width: "500px",
    blockId: "block-1",
  });
  const replaced = setBlockTermSidebarState(first, { blockId: "block-2" });
  const closed = setBlockTermSidebarState(replaced, { open: false });

  assert.equal(isBlockTermSidebarOwner(first, "block-1"), true);
  assert.equal(isBlockTermSidebarOwner(replaced, "block-1"), false);
  assert.equal(isBlockTermSidebarOwner(replaced, "block-2"), true);
  assert.deepEqual(closed.sidebar, { open: false, width: "500px", blockId: "block-2" });
});

test("rolls consecutive failed sidebar writes back to the last confirmed view", () => {
  const confirmed = setBlockTermSidebarState(DEFAULT_BLOCKTERM_VIEW_STATE, { width: "500px" });
  const firstOptimistic = setBlockTermSidebarState(confirmed, { open: true, blockId: "block-1" });
  const secondOptimistic = setBlockTermSidebarState(firstOptimistic, { width: "640px" });

  const staleFailure = resolveBlockTermViewWrite(secondOptimistic, confirmed, { ok: false }, false);
  assert.equal(staleFailure.visible, secondOptimistic);
  assert.deepEqual(staleFailure.confirmed, confirmed);

  const latestFailure = resolveBlockTermViewWrite(
    staleFailure.visible,
    staleFailure.confirmed,
    { ok: false },
    true
  );
  assert.deepEqual(latestFailure.visible, confirmed);

  const staleSuccess = resolveBlockTermViewWrite(secondOptimistic, confirmed, { ok: true, view: firstOptimistic }, false);
  assert.equal(staleSuccess.visible, secondOptimistic);
  assert.deepEqual(staleSuccess.confirmed, firstOptimistic);
  const failureAfterConfirmedWrite = resolveBlockTermViewWrite(
    staleSuccess.visible,
    staleSuccess.confirmed,
    { ok: false },
    true
  );
  assert.deepEqual(failureAfterConfirmedWrite.visible, firstOptimistic);
});

test("renders note and comment-alias blocks as sidebar text instead of terminal output", () => {
  assert.deepEqual(resolveBlockTermSidebarBody({ kind: "note", text: "first line\nsecond line" }), {
    kind: "note",
    text: "first line\nsecond line",
  });
  assert.deepEqual(resolveBlockTermSidebarBody({ kind: "command", text: "ignored" }), { kind: "output" });
});

test("legalizes deleted and archived sidebar owners", () => {
  const open = setBlockTermSidebarState(DEFAULT_BLOCKTERM_VIEW_STATE, { open: true, blockId: "block-1" });
  assert.equal(legalizeBlockTermSidebarState(open, [{ id: "block-1" }]), open);
  assert.deepEqual(legalizeBlockTermSidebarState(open, []), {
    sidebar: { open: false, width: "50%", blockId: null },
  });
  assert.deepEqual(legalizeBlockTermSidebarState(open, [{ id: "block-1", archived: true }]), {
    sidebar: { open: false, width: "50%", blockId: null },
  });
});

test("waits for the persisted block inventory before clearing a sidebar owner", () => {
  const open = setBlockTermSidebarState(DEFAULT_BLOCKTERM_VIEW_STATE, { open: true, blockId: "block-1" });
  assert.equal(shouldLegalizeBlockTermSidebarState(open, [], false), false);
  assert.equal(shouldLegalizeBlockTermSidebarState(open, [], true), true);
  assert.equal(shouldLegalizeBlockTermSidebarState(open, [{ id: "block-1" }], true), false);
  assert.equal(shouldLegalizeBlockTermSidebarState(open, [{ id: "block-1", archived: true }], true), true);
});

test("partitions the owner out of the virtualized main block source", () => {
  const blocks = [{ id: "block-a" }, { id: "block-b" }, { id: "block-c" }];
  const closed = setBlockTermSidebarState(DEFAULT_BLOCKTERM_VIEW_STATE, { blockId: "block-b" });
  assert.deepEqual(partitionBlockTermSidebarBlocks(blocks, closed, true), {
    mainBlocks: blocks,
    sidebarBlock: null,
  });

  const open = setBlockTermSidebarState(closed, { open: true });
  assert.deepEqual(partitionBlockTermSidebarBlocks(blocks, open, true), {
    mainBlocks: [blocks[0], blocks[2]],
    sidebarBlock: blocks[1],
  });
  assert.deepEqual(partitionBlockTermSidebarBlocks(blocks, open, false), {
    mainBlocks: blocks,
    sidebarBlock: null,
  });

  const replaced = setBlockTermSidebarState(open, { blockId: "block-c" });
  const result = partitionBlockTermSidebarBlocks(blocks, replaced, true);
  assert.deepEqual(result.mainBlocks, [blocks[0], blocks[1]]);
  assert.equal(result.sidebarBlock, blocks[2]);
  assert.equal(new Set([...result.mainBlocks, result.sidebarBlock].map((block) => block.id)).size, blocks.length);
});

test("bounds WaveTerm-style sidebar width while keeping both panes usable", () => {
  assert.equal(resolveBlockTermSidebarWidth(1200, "50%"), 600);
  assert.equal(resolveBlockTermSidebarWidth(1200, "500px"), 500);
  assert.equal(resolveBlockTermSidebarWidth(600, "90%"), 400);
  assert.equal(resolveBlockTermSidebarWidth(600, "200px"), 200);
  assert.equal(resolveBlockTermSidebarWidth(360, "500px"), 180);
  assert.equal(resolveBlockTermSidebarWidth(1200, "bad"), 600);
});

test("sanitizes percent widths to the backend 10-90 contract", () => {
  assert.equal(
    sanitizeBlockTermViewState({ sidebar: { open: true, width: "10%", block_id: null } }).sidebar.width,
    "10%"
  );
  assert.equal(
    sanitizeBlockTermViewState({ sidebar: { open: true, width: "90%", block_id: null } }).sidebar.width,
    "90%"
  );
  assert.equal(
    sanitizeBlockTermViewState({ sidebar: { open: true, width: "9%", block_id: null } }).sidebar.width,
    BLOCKTERM_SIDEBAR_DEFAULT_WIDTH
  );
  assert.equal(
    sanitizeBlockTermViewState({ sidebar: { open: true, width: "91%", block_id: null } }).sidebar.width,
    BLOCKTERM_SIDEBAR_DEFAULT_WIDTH
  );
});
