import assert from "node:assert/strict";
import test from "node:test";
import { resolveBlockTermFrameAcceptance } from "../src/components/terminal/blockterm-model.ts";
import {
  cancelBlockTermStopSequence,
  createBlockTermStopSequence,
  resolveBlockTermStopToken,
  resolveBlockTermStopSignals,
  startBlockTermStop,
} from "../src/components/terminal/blockterm-stop.ts";

const BLOCK_TOKEN = "0123456789abcdef".repeat(4);

test("chooses stop escalation from the target block runtime", () => {
  assert.deepEqual(resolveBlockTermStopSignals("local"), ["INT", "TERM", "KILL"]);
  assert.deepEqual(resolveBlockTermStopSignals("ssh"), ["INT"]);
  assert.deepEqual(resolveBlockTermStopSignals(undefined), ["INT", "TERM", "KILL"]);
});

test("requires a valid same-session token before starting a tagged stop", () => {
  assert.equal(resolveBlockTermStopToken("term-a", undefined), null);
  assert.equal(resolveBlockTermStopToken("term-a", { sessionId: "term-b", token: BLOCK_TOKEN }), null);
  assert.equal(resolveBlockTermStopToken("term-a", { sessionId: "term-a", token: "invalid" }), null);
  assert.equal(resolveBlockTermStopToken("term-a", { sessionId: "term-a", token: BLOCK_TOKEN }), BLOCK_TOKEN);
});

function createScheduler() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    schedule(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clear(id) {
      callbacks.delete(id);
    },
    runNext() {
      const entry = callbacks.entries().next().value;
      if (!entry) return false;
      callbacks.delete(entry[0]);
      entry[1]();
      return true;
    },
    size() {
      return callbacks.size;
    },
  };
}

test("escalates one bound block from INT to TERM to KILL", () => {
  const scheduler = createScheduler();
  const sent = [];
  const sequence = createBlockTermStopSequence({
    blockId: "block-a",
    isRunning: (blockId) => blockId === "block-a",
    send: (blockId, signal) => {
      sent.push([blockId, signal]);
      return true;
    },
    schedule: scheduler.schedule,
    clear: scheduler.clear,
  });

  assert.ok(sequence);
  assert.equal(typeof sequence.done?.then, "function");
  assert.deepEqual(sent, [["block-a", "INT"]]);
  assert.equal(scheduler.runNext(), true);
  assert.equal(scheduler.runNext(), true);
  assert.deepEqual(sent, [
    ["block-a", "INT"],
    ["block-a", "TERM"],
    ["block-a", "KILL"],
  ]);
  assert.equal(scheduler.size(), 0);
});

test("does not signal a newer active block from an older stop timer", () => {
  const scheduler = createScheduler();
  const sent = [];
  let activeBlockId = "block-a";
  createBlockTermStopSequence({
    blockId: "block-a",
    isRunning: (blockId) => activeBlockId === blockId,
    send: (blockId, signal) => {
      sent.push([blockId, signal]);
      return true;
    },
    schedule: scheduler.schedule,
    clear: scheduler.clear,
  });

  activeBlockId = "block-b";
  assert.equal(scheduler.runNext(), true);
  assert.deepEqual(sent, [["block-a", "INT"]]);
  assert.equal(scheduler.size(), 0);
});

test("a repeated stop advances immediately without duplicating the old timer", () => {
  const scheduler = createScheduler();
  const sent = [];
  const sequence = createBlockTermStopSequence({
    blockId: "block-a",
    isRunning: () => true,
    send: (_blockId, signal) => {
      sent.push(signal);
      return true;
    },
    schedule: scheduler.schedule,
    clear: scheduler.clear,
  });

  assert.ok(sequence);
  assert.equal(sequence.advance(), true);
  assert.deepEqual(sent, ["INT", "TERM"]);
  assert.equal(scheduler.size(), 1);
  assert.equal(scheduler.runNext(), true);
  assert.deepEqual(sent, ["INT", "TERM", "KILL"]);
});

test("completes an escalation sequence after the final signal", async () => {
  const scheduler = createScheduler();
  const sent = [];
  let completed = 0;
  const sequence = createBlockTermStopSequence({
    blockId: "block-a",
    isRunning: () => true,
    send: (_blockId, signal) => {
      sent.push(signal);
      return true;
    },
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    onComplete: () => {
      completed += 1;
    },
  });

  assert.ok(sequence);
  let released = false;
  void sequence.done.then(() => {
    released = true;
  });
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(scheduler.runNext(), true);
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(scheduler.runNext(), true);
  await sequence.done;
  assert.equal(released, true);
  assert.deepEqual(sent, ["INT", "TERM", "KILL"]);
  assert.equal(completed, 1);
  sequence.cancel();
  assert.equal(completed, 1);
});

test("keeps the stopped owner bound so a late correlated end can finish after escalation", async () => {
  const scheduler = createScheduler();
  let stopSequenceRegistered = true;
  const binding = {
    activeBlockId: "block-a",
    blockToken: BLOCK_TOKEN,
    outputPhase: "active",
    interruptedOutputBlockId: "block-a",
  };
  const sequence = createBlockTermStopSequence({
    blockId: "block-a",
    isRunning: (blockId) => binding.activeBlockId === blockId && binding.interruptedOutputBlockId === blockId,
    send: () => true,
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    onComplete: () => {
      stopSequenceRegistered = false;
    },
  });

  assert.ok(sequence);
  assert.equal(scheduler.runNext(), true);
  assert.equal(scheduler.runNext(), true);
  assert.equal(stopSequenceRegistered, false);
  await sequence.done;
  assert.deepEqual(binding, {
    activeBlockId: "block-a",
    blockToken: BLOCK_TOKEN,
    outputPhase: "active",
    interruptedOutputBlockId: "block-a",
  });

  const end = {
    kind: "end",
    id: "block-a",
    protocolVersion: "v3",
    blockToken: BLOCK_TOKEN,
    exitCode: 130,
  };
  const acceptance = {
    frame: end,
    replay: false,
    sessionId: "term-a",
    activeBlockId: binding.activeBlockId,
    interruptedBlockId: binding.interruptedOutputBlockId,
    activeBlockPhase: { sessionId: "term-a", phase: binding.outputPhase },
    blocks: [{ id: "block-a", terminalId: "term-a", status: "interrupted" }],
    blockToken: binding.blockToken,
  };
  assert.deepEqual(resolveBlockTermFrameAcceptance(acceptance), { accepted: true });
  assert.deepEqual(resolveBlockTermFrameAcceptance({ ...acceptance, replay: true }), { accepted: false });
});

test("cancelling an escalation does not run its completion callback", async () => {
  const scheduler = createScheduler();
  let completed = 0;
  const sequence = createBlockTermStopSequence({
    blockId: "block-a",
    isRunning: () => true,
    send: () => true,
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    onComplete: () => {
      completed += 1;
    },
  });

  assert.ok(sequence);
  sequence.cancel();
  await sequence.done;
  assert.equal(completed, 0);
  assert.equal(scheduler.size(), 0);
});

test("cancels a replaced block escalation without changing its tail ownership", async () => {
  const scheduler = createScheduler();
  const sequences = new Map();
  const sent = [];
  const sequence = createBlockTermStopSequence({
    blockId: "block-old",
    isRunning: () => true,
    send: (_blockId, signal) => {
      sent.push(signal);
      return true;
    },
    schedule: scheduler.schedule,
    clear: scheduler.clear,
  });
  assert.ok(sequence);
  sequences.set("block-old", sequence);

  assert.equal(cancelBlockTermStopSequence(sequences, "block-old"), true);
  assert.equal(sequences.has("block-old"), false);
  assert.equal(scheduler.size(), 0);
  await sequence.done;
  assert.deepEqual(sent, ["INT"]);
  assert.equal(cancelBlockTermStopSequence(sequences, "block-old"), false);
});

test("sends INT again for repeated SSH stops without retaining a sequence", () => {
  const scheduler = createScheduler();
  const sent = [];
  let completed = 0;
  const stop = () =>
    startBlockTermStop({
      blockId: "block-ssh",
      signals: ["INT"],
      isRunning: () => true,
      send: (_blockId, signal) => {
        sent.push(signal);
        return true;
      },
      schedule: scheduler.schedule,
      clear: scheduler.clear,
      onComplete: () => {
        completed += 1;
      },
    });

  const first = stop();

  assert.equal(first.sent, true);
  assert.equal(first.sequence, null);
  assert.equal(completed, 0);
  assert.deepEqual(sent, ["INT"]);
  assert.equal(scheduler.size(), 0);
  const second = stop();
  assert.equal(second.sent, true);
  assert.equal(second.sequence, null);
  assert.equal(completed, 0);
  assert.deepEqual(sent, ["INT", "INT"]);
  assert.equal(scheduler.size(), 0);
});
