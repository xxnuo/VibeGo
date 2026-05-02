import assert from "node:assert/strict";
import test from "node:test";

import {
  BlockTermSessionCloseCoordinator,
  commitBlockTermSessionClose,
} from "../src/components/terminal/blockterm-session-close.ts";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("serializes close work within one scope", async () => {
  const coordinator = new BlockTermSessionCloseCoordinator();
  const first = coordinator.begin("session-a");
  const second = coordinator.begin("session-b");
  assert.ok(first);
  assert.ok(second);

  const gate = deferred();
  const order = [];
  const firstRun = coordinator.run(first, async () => {
    order.push("first:start");
    await gate.promise;
    order.push("first:end");
  });
  const secondRun = coordinator.run(second, async () => {
    order.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  gate.resolve();
  await Promise.all([firstRun, secondRun]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("reset aborts old requests and gives a reused session ID an independent queue", async () => {
  const coordinator = new BlockTermSessionCloseCoordinator();
  const oldRequest = coordinator.begin("shared-session");
  assert.ok(oldRequest);

  const oldGate = deferred();
  const order = [];
  const oldRun = coordinator.run(oldRequest, async () => {
    order.push("old:start");
    await oldGate.promise;
    order.push("old:end");
  });
  await Promise.resolve();

  coordinator.reset();
  assert.equal(oldRequest.controller.signal.aborted, true);
  assert.equal(coordinator.isCurrent(oldRequest), false);

  const newRequest = coordinator.begin("shared-session");
  assert.ok(newRequest);
  assert.equal(coordinator.isCurrent(newRequest), true);
  const newRun = coordinator.run(newRequest, async () => {
    order.push("new");
  });
  await newRun;
  assert.deepEqual(order, ["old:start", "new"]);

  oldGate.resolve();
  await oldRun;
  assert.deepEqual(order, ["old:start", "new", "old:end"]);
});

test("an old completion cannot clear a newer same-ID latch", async () => {
  const coordinator = new BlockTermSessionCloseCoordinator();
  const oldRequest = coordinator.begin("shared-session");
  assert.ok(oldRequest);
  const oldGate = deferred();
  const oldRun = coordinator.run(oldRequest, () => oldGate.promise);
  await Promise.resolve();

  coordinator.reset();
  const newRequest = coordinator.begin("shared-session");
  assert.ok(newRequest);
  assert.equal(coordinator.begin("shared-session"), null);

  oldGate.resolve();
  await oldRun;
  assert.equal(coordinator.isCurrent(newRequest), true);
  assert.equal(coordinator.begin("shared-session"), null);
});

test("reset skips old queued work while allowing the running close to finish", async () => {
  const coordinator = new BlockTermSessionCloseCoordinator();
  const runningRequest = coordinator.begin("running-session");
  const queuedRequest = coordinator.begin("queued-session");
  assert.ok(runningRequest);
  assert.ok(queuedRequest);

  const gate = deferred();
  let queuedRan = false;
  const running = coordinator.run(runningRequest, () => gate.promise);
  const queued = coordinator.run(queuedRequest, async () => {
    queuedRan = true;
  });
  await Promise.resolve();

  coordinator.reset();
  const currentRequest = coordinator.begin("queued-session");
  assert.ok(currentRequest);
  let currentRan = false;
  const current = coordinator.run(currentRequest, async () => {
    currentRan = true;
  });
  await current;
  assert.equal(currentRan, true);

  gate.resolve();
  await Promise.all([running, queued]);
  assert.equal(queuedRan, false);
});

test("a rejected close releases its latch and does not block the next request", async () => {
  const coordinator = new BlockTermSessionCloseCoordinator();
  const failedRequest = coordinator.begin("failed-session");
  const nextRequest = coordinator.begin("next-session");
  assert.ok(failedRequest);
  assert.ok(nextRequest);
  let nextRan = false;

  const failedRun = coordinator.run(failedRequest, async () => {
    throw new Error("close failed");
  });
  const nextRun = coordinator.run(nextRequest, async () => {
    nextRan = true;
  });

  await assert.rejects(failedRun, /close failed/);
  await nextRun;

  assert.equal(nextRan, true);
  assert.ok(coordinator.begin("failed-session"));
  assert.ok(coordinator.begin("next-session"));
});

test("an aborted request rejected before queueing releases its same-session latch", async () => {
  const coordinator = new BlockTermSessionCloseCoordinator();
  const request = coordinator.begin("aborted-session");
  assert.ok(request);
  request.controller.abort();

  let ran = false;
  await coordinator.run(request, async () => {
    ran = true;
  });

  assert.equal(ran, false);
  assert.ok(coordinator.begin("aborted-session"));
});

test("persistence failure still closes the backend while keeping cleanup behind the commit gate", async () => {
  const order = [];

  await assert.rejects(
    commitBlockTermSessionClose({
      persist: async () => {
        order.push("persist");
        throw new Error("persist failed");
      },
      closeTerminal: async () => {
        order.push("close");
      },
      cleanup: () => {
        order.push("cleanup");
      },
    }),
    /persist failed/
  );

  assert.deepEqual(order, ["persist", "close"]);
});

test("terminal close failure keeps cleanup behind the commit gate", async () => {
  const order = [];

  await assert.rejects(
    commitBlockTermSessionClose({
      persist: async () => {
        order.push("persist");
      },
      closeTerminal: async () => {
        order.push("close");
        throw new Error("close failed");
      },
      cleanup: () => {
        order.push("cleanup");
      },
    }),
    /close failed/
  );

  assert.deepEqual(order, ["persist", "close"]);
});

test("successful close commit cleans up after persistence and terminal close", async () => {
  const order = [];

  await commitBlockTermSessionClose({
    persist: async () => {
      order.push("persist");
    },
    closeTerminal: async () => {
      order.push("close");
    },
    cleanup: () => {
      order.push("cleanup");
    },
  });

  assert.deepEqual(order, ["persist", "close", "cleanup"]);
});
