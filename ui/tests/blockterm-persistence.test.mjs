import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitSessionCommandChain,
  confirmBlockTermDelete,
  compensateUnconfirmedBlockTermModelRun,
  drainBlockPersistence,
  enqueueBlockPersistence,
  enqueueSessionCommand,
  getBlockTermPersistenceDisposition,
  isBlockTermDeleteAlreadyAppliedError,
  isBlockTermTombstoneError,
  mergeFailedBlockPatch,
  persistThenSendCommand,
  retryBlockPersistence,
  trackConcurrentSessionCommand,
} from "../src/components/terminal/blockterm-persistence.ts";

test("defers new BlockTerm persistence while deletion is in flight", () => {
  assert.equal(getBlockTermPersistenceDisposition({ deleted: false, deleting: false }), "schedule");
  assert.equal(getBlockTermPersistenceDisposition({ deleted: false, deleting: true }), "defer");
  assert.equal(getBlockTermPersistenceDisposition({ deleted: true, deleting: false }), "discard");
  assert.equal(getBlockTermPersistenceDisposition({ deleted: true, deleting: true }), "discard");
});

test("commits a local block deletion only after durable removal succeeds", async () => {
  const order = [];
  let releaseRemove;
  const removeGate = new Promise((resolve) => {
    releaseRemove = resolve;
  });
  const deleting = confirmBlockTermDelete({
    prepare: async () => order.push("prepare"),
    remove: async () => {
      order.push("remove:start");
      await removeGate;
      order.push("remove:end");
    },
    commit: () => order.push("commit"),
  });

  await Promise.resolve();
  assert.deepEqual(order, ["prepare", "remove:start"]);
  releaseRemove();
  await deleting;
  assert.deepEqual(order, ["prepare", "remove:start", "remove:end", "commit"]);
});

test("keeps local block state when durable deletion fails", async () => {
  const failure = new Error("delete failed");
  let committed = false;
  await assert.rejects(
    confirmBlockTermDelete({
      prepare: async () => {},
      remove: async () => {
        throw failure;
      },
      commit: () => {
        committed = true;
      },
    }),
    failure
  );
  assert.equal(committed, false);
});

test("does not commit a local deletion after all queued DELETE retries fail", async () => {
  const chains = new Map();
  const failure = new Error("delete failed");
  let attempts = 0;
  let committed = false;

  await assert.rejects(
    confirmBlockTermDelete({
      prepare: async () => {},
      remove: () =>
        enqueueBlockPersistence(
          chains,
          "block-1",
          async () => {
            attempts += 1;
            throw failure;
          },
          { attempts: 4, wait: async () => {} }
        ),
      commit: () => {
        committed = true;
      },
    }),
    failure
  );

  assert.equal(attempts, 4);
  assert.equal(committed, false);
  await Promise.resolve();
  assert.equal(chains.size, 0);
});

test("treats a missing block as an already-applied durable deletion", async () => {
  const missing = { status: 404 };
  let committed = false;
  assert.equal(isBlockTermDeleteAlreadyAppliedError(missing), true);
  assert.equal(isBlockTermDeleteAlreadyAppliedError({ status: 500 }), false);
  await confirmBlockTermDelete({
    prepare: async () => {},
    remove: async () => {
      throw missing;
    },
    commit: () => {
      committed = true;
    },
  });
  assert.equal(committed, true);
});

test("continues durable deletion when model cancellation fails", async () => {
  const order = [];
  await confirmBlockTermDelete({
    prepare: async () => order.push("prepare"),
    cancel: async () => {
      order.push("cancel");
      throw new Error("already stopped");
    },
    remove: async () => order.push("remove"),
    commit: () => order.push("commit"),
  });
  assert.deepEqual(order, ["prepare", "cancel", "remove", "commit"]);
});

test("model creation retries in the block queue and preserves the server block", async () => {
  const chains = new Map();
  const delays = [];
  let attempts = 0;
  const completedBlock = { id: "model-block", status: "success", output: "saved answer" };

  const result = await enqueueBlockPersistence(
    chains,
    "model-block",
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("response lost");
      return completedBlock;
    },
    { attempts: 4, getDelayMs: (attempt) => attempt, wait: async (delay) => delays.push(delay) }
  );

  assert.equal(result, completedBlock);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1, 2]);
  await Promise.resolve();
  assert.equal(chains.size, 0);
});

test("model compensation deletes an unconfirmed run even when cancellation fails", async () => {
  const order = [];
  await compensateUnconfirmedBlockTermModelRun({
    cancel: async () => {
      order.push("cancel");
      throw new Error("already gone");
    },
    remove: async () => {
      order.push("remove");
    },
  });
  assert.deepEqual(order, ["cancel", "remove"]);
});

test("recognizes only the BlockTerm deleted-ID conflict", () => {
  assert.equal(isBlockTermTombstoneError({ status: 409, body: { error: "block has been deleted" } }), true);
  assert.equal(isBlockTermTombstoneError({ status: 409, message: "block has been deleted" }), true);
  assert.equal(isBlockTermTombstoneError({ status: 409, body: { error: "block id conflict" } }), false);
  assert.equal(isBlockTermTombstoneError({ status: 404, body: { error: "block has been deleted" } }), false);
  assert.equal(isBlockTermTombstoneError(new Error("block has been deleted")), false);
});

test("restores a failed patch without overwriting newer pending values", () => {
  assert.deepEqual(
    mergeFailedBlockPatch(
      { output: "old output", status: "running", pinned: true },
      { output: "new output", status: "success" }
    ),
    { output: "new output", status: "success", pinned: true }
  );
});

test("retries a failed BlockTerm persistence operation before resolving", async () => {
  let attempts = 0;
  const delays = [];

  const result = await retryBlockPersistence(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary failure");
      return "persisted";
    },
    {
      attempts: 4,
      getDelayMs: (failedAttempt) => failedAttempt * 10,
      wait: async (delayMs) => delays.push(delayMs),
    }
  );

  assert.equal(result, "persisted");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("stops retrying BlockTerm persistence after the configured attempt limit", async () => {
  const failure = new Error("permanent failure");
  let attempts = 0;

  await assert.rejects(
    retryBlockPersistence(
      async () => {
        attempts += 1;
        throw failure;
      },
      { attempts: 3, wait: async () => {} }
    ),
    failure
  );

  assert.equal(attempts, 3);
});

test("reports a failed drain instead of treating it as persisted", async () => {
  const failure = new Error("write failed");
  const pendingIds = new Set(["block-1"]);

  await assert.rejects(
    drainBlockPersistence(undefined, {
      collectIds: () => pendingIds,
      flush: async () => {
        throw failure;
      },
      getWriteChain: () => undefined,
      hasPending: () => true,
    }),
    failure
  );
  assert.deepEqual([...pendingIds], ["block-1"]);
});

test("drains a patch queued while an earlier write is in flight", async () => {
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const pendingIds = new Set(["block-1"]);
  const flushed = [];

  const draining = drainBlockPersistence(undefined, {
    collectIds: () => pendingIds,
    flush: async (blockId) => {
      pendingIds.delete(blockId);
      flushed.push(blockId);
      if (blockId === "block-1") await firstWrite;
    },
    getWriteChain: () => undefined,
    hasPending: () => pendingIds.size > 0,
  });

  await Promise.resolve();
  pendingIds.add("block-2");
  releaseFirstWrite();
  await draining;

  assert.deepEqual(flushed, ["block-1", "block-2"]);
});

test("does not drain writes outside an explicit scope", async () => {
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const pendingIds = new Set(["old-block"]);
  const flushed = [];

  const draining = drainBlockPersistence(["old-block"], {
    collectIds: () => pendingIds,
    flush: async (blockId) => {
      pendingIds.delete(blockId);
      flushed.push(blockId);
      if (blockId === "old-block") await firstWrite;
    },
    getWriteChain: () => undefined,
    hasPending: (targetIds) => [...pendingIds].some((id) => targetIds?.has(id) ?? true),
  });

  await Promise.resolve();
  pendingIds.add("new-block");
  releaseFirstWrite();
  await draining;

  assert.deepEqual(flushed, ["old-block"]);
  assert.deepEqual([...pendingIds], ["new-block"]);
});

test("re-drains when a targeted patch is queued during a write", async () => {
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const pendingIds = new Set(["block-1"]);
  const flushed = [];

  const draining = drainBlockPersistence(["block-1"], {
    collectIds: () => pendingIds,
    flush: async (blockId) => {
      pendingIds.delete(blockId);
      flushed.push(blockId);
      if (flushed.length === 1) await firstWrite;
    },
    getWriteChain: () => undefined,
    hasPending: (targetIds) => [...pendingIds].some((id) => targetIds?.has(id) ?? true),
  });

  await Promise.resolve();
  pendingIds.add("block-1");
  releaseFirstWrite();
  await draining;

  assert.deepEqual(flushed, ["block-1", "block-1"]);
});

test("serializes command creation within one terminal session", async () => {
  const chains = new Map();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueueSessionCommand(chains, "session-1", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
  });
  const second = enqueueSessionCommand(chains, "session-1", async () => {
    order.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  await Promise.resolve();
  assert.equal(chains.size, 0);
});

test("keeps session command queues independent and continues after a failure", async () => {
  const chains = new Map();
  const order = [];
  const failure = enqueueSessionCommand(chains, "session-1", async () => {
    order.push("failed");
    throw new Error("failed");
  });
  const recovery = enqueueSessionCommand(chains, "session-1", async () => {
    order.push("recovered");
  });
  const parallel = enqueueSessionCommand(chains, "session-2", async () => {
    order.push("parallel");
  });

  await assert.rejects(failure, /failed/);
  await Promise.all([recovery, parallel]);
  assert.ok(order.indexOf("recovered") > order.indexOf("failed"));
  assert.ok(order.includes("parallel"));
});

test("tracks concurrent commands in one session without serializing their start", async () => {
  const chains = new Map();
  const order = [];
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });

  const first = trackConcurrentSessionCommand(chains, "session-1", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
  });
  const second = trackConcurrentSessionCommand(chains, "session-1", async () => {
    order.push("second:start");
    await secondGate;
    order.push("second:end");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start", "second:start"]);
  const waiting = awaitSessionCommandChain(chains, "session-1").then(() => order.push("all:end"));
  releaseSecond();
  await second;
  assert.deepEqual(order, ["first:start", "second:start", "second:end"]);
  releaseFirst();
  await Promise.all([first, waiting]);
  assert.deepEqual(order, ["first:start", "second:start", "second:end", "first:end", "all:end"]);
  assert.equal(chains.size, 0);
});

test("waits for every queued runtime update before continuing", async () => {
  const chains = new Map();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  enqueueSessionCommand(chains, "session-1", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
  });

  const waiting = awaitSessionCommandChain(chains, "session-1").then(() => {
    order.push("completion");
  });
  await Promise.resolve();
  enqueueSessionCommand(chains, "session-1", async () => {
    order.push("second");
  });

  releaseFirst();
  await waiting;
  assert.deepEqual(order, ["first:start", "first:end", "second", "completion"]);
});

test("does not send a command until durable creation resolves", async () => {
  let resolveCreate;
  const create = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  let sent = false;
  const dispatch = persistThenSendCommand({
    persist: () => create,
    prepareSend: () => true,
    send: () => {
      sent = true;
      return true;
    },
    interrupt: () => assert.fail("successful send must not be interrupted"),
  });

  await Promise.resolve();
  assert.equal(sent, false);
  resolveCreate();
  assert.equal(await dispatch, "sent");
  assert.equal(sent, true);
});

test("does not send or interrupt when durable creation rejects", async () => {
  const failure = new Error("create failed");
  let sent = false;
  let interrupted = false;
  await assert.rejects(
    persistThenSendCommand({
      persist: async () => {
        throw failure;
      },
      prepareSend: () => true,
      send: () => {
        sent = true;
        return true;
      },
      interrupt: () => {
        interrupted = true;
      },
    }),
    failure
  );
  assert.equal(sent, false);
  assert.equal(interrupted, false);
});

test("interrupts a created command when it can no longer be sent", async () => {
  let sent = false;
  let interrupted = false;
  const result = await persistThenSendCommand({
    persist: async () => {},
    prepareSend: () => false,
    send: () => {
      sent = true;
      return true;
    },
    interrupt: () => {
      interrupted = true;
    },
  });
  assert.equal(result, "interrupted");
  assert.equal(sent, false);
  assert.equal(interrupted, true);
});
