import assert from "node:assert/strict";
import test from "node:test";

import {
  clearBlockTermStreamCursor,
  createBlockTermRoutedInputMessage,
  createBlockTermRoutedSignalMessage,
  createBlockTermTerminalRoute,
  getBlockTermStreamCursor,
  getBlockTermTerminalStreamKey,
  parseBlockTermTerminalMessage,
  parseBlockTermTerminalRoute,
  reduceBlockTermStreamCursor,
} from "../src/components/terminal/blockterm-terminal-protocol.ts";

const tokenA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const tokenB = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function blockRoute(terminalId = "terminal-a", blockId = "block-a", blockToken = tokenA) {
  return createBlockTermTerminalRoute(terminalId, "block", blockId, blockToken);
}

test("keeps legacy messages on one implicit session stream", () => {
  const result = parseBlockTermTerminalRoute("terminal-a", { type: "output" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.route, {
    terminalId: "terminal-a",
    mode: "legacy",
    blockId: null,
    blockToken: null,
    streamKey: "session:terminal-a",
  });
  assert.equal(getBlockTermTerminalStreamKey(result.route), "session:terminal-a");
});

test("parses explicit block routes and accepts the transitional omitted mode", () => {
  for (const message of [
    { type: "output", route_mode: "block", block_id: "block-a", block_token: tokenA },
    { type: "output", block_id: "block-a", block_token: tokenA },
  ]) {
    const result = parseBlockTermTerminalRoute("terminal-a", message);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.route.mode, "block");
    assert.equal(result.route.blockId, "block-a");
    assert.equal(result.route.blockToken, tokenA);
    assert.equal(result.route.streamKey, `block:terminal-a:block-a:${tokenA}`);
  }
});

test("does not downgrade partial or explicitly legacy block tags", () => {
  const cases = [
    [{ type: "output", route_mode: "block", block_token: tokenA }, "block_id_required"],
    [{ type: "output", route_mode: "block", block_id: "block-a" }, "block_token_required"],
    [{ type: "output", block_id: "block-a" }, "block_token_required"],
    [{ type: "output", route_mode: "legacy", block_id: "block-a", block_token: tokenA }, "legacy_route_has_block_fields"],
    [{ type: "output", route_mode: "other" }, "invalid_route_mode"],
  ];
  for (const [message, error] of cases) {
    const result = parseBlockTermTerminalRoute("terminal-a", message);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error, error);
  }
});

test("isolates cursors by canonical stream key", () => {
  const legacy = createBlockTermTerminalRoute("terminal-a");
  const first = blockRoute();
  const second = blockRoute("terminal-a", "block-b", tokenB);
  let state = {};

  let update = reduceBlockTermStreamCursor(state, first, 10);
  assert.equal(update.accepted, true);
  assert.equal(update.decision, "accepted");
  state = update.state;

  update = reduceBlockTermStreamCursor(state, second, 3);
  assert.equal(update.accepted, true);
  assert.equal(update.decision, "accepted");
  state = update.state;
  assert.equal(getBlockTermStreamCursor(state, first), 10);
  assert.equal(getBlockTermStreamCursor(state, second), 3);
  assert.equal(getBlockTermStreamCursor(state, legacy), null);

  update = reduceBlockTermStreamCursor(state, first, 10);
  assert.equal(update.accepted, false);
  assert.equal(update.decision, "duplicate");
  update = reduceBlockTermStreamCursor(state, first, 9);
  assert.equal(update.accepted, false);
  assert.equal(update.decision, "stale");

  update = reduceBlockTermStreamCursor(state, first, 4, true);
  assert.equal(update.accepted, true);
  assert.equal(update.decision, "reset");
  state = update.state;
  assert.equal(getBlockTermStreamCursor(state, first), 4);
  assert.equal(getBlockTermStreamCursor(state, second), 3);

  const cleared = clearBlockTermStreamCursor(state, first);
  assert.equal(getBlockTermStreamCursor(cleared, first), null);
  assert.equal(getBlockTermStreamCursor(cleared, second), 3);
});

test("keeps missing cursors compatible with legacy output", () => {
  const route = createBlockTermTerminalRoute("terminal-a");
  const state = { [route.streamKey]: 12 };
  const update = reduceBlockTermStreamCursor(state, route, undefined);
  assert.equal(update.accepted, true);
  assert.equal(update.decision, "untracked");
  assert.equal(update.state, state);
  assert.equal(update.previousCursor, 12);

  const reset = reduceBlockTermStreamCursor(state, route, undefined, true);
  assert.equal(reset.accepted, true);
  assert.equal(reset.decision, "reset");
  assert.equal(getBlockTermStreamCursor(reset.state, route), null);
});

test("normalizes routed output messages without sharing cursor state", () => {
  const parsed = parseBlockTermTerminalMessage("terminal-a", {
    type: "output",
    route_mode: "block",
    block_id: "block-a",
    block_token: tokenA,
    data: "AQI=",
    cursor: 42,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.message.route.streamKey, `block:terminal-a:block-a:${tokenA}`);
  assert.equal(parsed.message.cursor, 42);
  assert.equal(parsed.message.reset, false);
  assert.equal(parsed.message.data, "AQI=");
  assert.deepEqual(parsed.message.block_id, "block-a");
  assert.deepEqual(parsed.message.block_token, tokenA);

  const invalidCursor = parseBlockTermTerminalMessage("terminal-a", {
    type: "output",
    cursor: -1,
  });
  assert.deepEqual(invalidCursor, { ok: false, error: "invalid_cursor" });
});

test("builders preserve the old wire shape and opt in block routing explicitly", () => {
  const legacy = createBlockTermTerminalRoute("terminal-a");
  assert.deepEqual(createBlockTermRoutedInputMessage("hello", legacy), {
    type: "input",
    data: "aGVsbG8=",
  });
  assert.deepEqual(createBlockTermRoutedSignalMessage("INT", legacy), {
    type: "signal",
    signal: "INT",
  });

  const block = blockRoute();
  assert.deepEqual(createBlockTermRoutedInputMessage("你好", block), {
    type: "input",
    data: "5L2g5aW9",
    route_mode: "block",
    block_id: "block-a",
    block_token: tokenA,
  });
  assert.deepEqual(createBlockTermRoutedSignalMessage("TERM", block), {
    type: "signal",
    signal: "TERM",
    route_mode: "block",
    block_id: "block-a",
    block_token: tokenA,
  });
});

test("rejects invalid route construction rather than producing a fallback key", () => {
  assert.throws(() => createBlockTermTerminalRoute("terminal-a", "block", "block-a"), /block token/u);
  assert.throws(() => createBlockTermTerminalRoute("terminal-a", "legacy", "block-a", tokenA), /legacy route/u);
  assert.throws(() => createBlockTermTerminalRoute("terminal-a", "block", " block-a ", tokenA), /block id/u);
  assert.throws(
    () =>
      createBlockTermRoutedInputMessage("x", {
        terminalId: "terminal-a",
        mode: "block",
        blockId: "block-a",
        blockToken: tokenA,
        streamKey: "session:terminal-a",
      }),
    /stream key/u
  );
});
