import assert from "node:assert/strict";
import test from "node:test";

import { BlockTermOutputStore } from "../src/components/terminal/blockterm-output-store.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("deduplicates concurrent output loads", async () => {
  const store = new BlockTermOutputStore();
  const pending = deferred();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return pending.promise;
  };

  const first = store.load("block-1", loader);
  const second = store.load("block-1", loader);
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot("block-1").status, "loading");

  pending.resolve({ value: "loaded", cursor: 12 });
  assert.equal((await first).value, "loaded");
  assert.equal(store.getSnapshot("block-1").cursor, 12);
});

test("does not let an older load replace live output", async () => {
  const store = new BlockTermOutputStore();
  const pending = deferred();
  const loading = store.load("block-1", async () => pending.promise);

  store.appendLive("block-1", "live", 20);
  pending.resolve({ value: "stale", cursor: 10 });
  await loading;

  assert.deepEqual(store.getSnapshot("block-1"), {
    status: "ready",
    value: "live",
    cursor: 20,
    outputSize: 4,
    dirty: true,
    revision: 2,
    contentRevision: 1,
    error: null,
  });
});

test("ignores a load response after its block is deleted", async () => {
  const store = new BlockTermOutputStore();
  const pending = deferred();
  const loading = store.load("block-1", async () => pending.promise);
  let notifications = 0;
  store.subscribe("block-1", () => {
    notifications += 1;
  });

  store.delete("block-1");
  pending.resolve({ value: "late", cursor: 1 });
  await loading;

  assert.equal(store.has("block-1"), false);
  assert.equal(store.getSnapshot("block-1").status, "idle");
  assert.equal(notifications, 1);
});

test("evicts least-recent clean output while retaining pinned entries", () => {
  const store = new BlockTermOutputStore({ maxEntries: 2, maxBytes: 1024 });
  store.hydrate("block-a", "a", 1);
  store.hydrate("block-b", "b", 2);
  store.setPinned("block-a", "running", true);
  store.hydrate("block-c", "c", 3);

  assert.equal(store.has("block-a"), true);
  assert.equal(store.has("block-b"), false);
  assert.equal(store.has("block-c"), true);

  store.setPinned("block-a", "running", false);
  store.hydrate("block-d", "d", 4);
  assert.equal(store.has("block-a"), false);
  assert.equal(store.has("block-c"), true);
  assert.equal(store.has("block-d"), true);
});

test("retains empty output metadata after LRU eviction without issuing a load", async () => {
  const store = new BlockTermOutputStore({ maxEntries: 1 });
  store.prime("block-empty", 0, 7);
  store.hydrate("block-other", "loaded", 8);

  assert.equal(store.has("block-empty"), false);
  assert.equal(store.getSnapshot("block-empty").status, "ready");
  assert.equal(store.getSnapshot("block-empty").cursor, 7);

  let calls = 0;
  const snapshot = await store.load("block-empty", async () => {
    calls += 1;
    return { value: "unexpected", cursor: 9 };
  });
  assert.equal(calls, 0);
  assert.equal(snapshot.value, "");
  assert.equal(snapshot.outputSize, 0);
  assert.equal(store.has("block-empty"), true);
  assert.equal(store.has("block-other"), false);
});

test("retains non-empty output metadata after LRU eviction", async () => {
  const store = new BlockTermOutputStore({ maxEntries: 1 });
  store.prime("block-output", 128, 7);
  store.hydrate("block-other", "loaded", 8);

  assert.equal(store.has("block-output"), false);
  assert.equal(store.getSnapshot("block-output").status, "idle");
  assert.equal(store.getSnapshot("block-output").outputSize, 128);
  assert.equal(store.getSnapshot("block-output").cursor, 7);

  let calls = 0;
  const snapshot = await store.load("block-output", async () => {
    calls += 1;
    return { value: "loaded on demand", cursor: 9 };
  });
  assert.equal(calls, 1);
  assert.equal(snapshot.value, "loaded on demand");
});

test("retains dirty output until the matching content revision is persisted", () => {
  const store = new BlockTermOutputStore({ maxEntries: 1 });
  const first = store.appendLive("block-a", "one", 1);
  const second = store.appendLive("block-a", " two", 2);

  assert.equal(store.markPersisted("block-a", first.contentRevision), false);
  assert.equal(store.getSnapshot("block-a").dirty, true);
  assert.equal(store.markPersisted("block-a", second.contentRevision), true);
  assert.equal(store.getSnapshot("block-a").dirty, false);

  store.hydrate("block-b", "clean", 3);
  assert.equal(store.has("block-a"), false);
  assert.equal(store.has("block-b"), true);
});

test("ignores duplicate or stale live cursors", () => {
  const store = new BlockTermOutputStore();
  store.hydrate("block-1", "base", 10);
  const before = store.getSnapshot("block-1");

  assert.equal(store.appendLive("block-1", " stale", 9), before);
  assert.equal(store.appendLive("block-1", " duplicate", 10), before);
  assert.equal(store.appendLive("block-1", " next", 11).value, "base next");
});

test("primes metadata without loading output and auto-increments snapshot cursors", () => {
  const store = new BlockTermOutputStore();
  const primed = store.prime("block-1", 128, 7);
  assert.equal(primed.status, "idle");
  assert.equal(primed.outputSize, 128);
  assert.equal(primed.cursor, 7);

  const appended = store.appendLive("block-1", "next");
  assert.equal(appended.value, "next");
  assert.equal(appended.cursor, 8);
  assert.equal(appended.dirty, true);
});

test("rebases dirty output beyond a newer persisted cursor", () => {
  const store = new BlockTermOutputStore();
  store.appendLive("block-1", "local", 2);
  const rebased = store.prime("block-1", 5, 10);
  assert.equal(rebased.value, "local");
  assert.equal(rebased.cursor, 11);
  assert.equal(rebased.dirty, true);
});

test("reconciles output conflicts without losing newer local content", () => {
  const store = new BlockTermOutputStore();
  const local = store.appendLive("block-1", "local", 3);

  const rebased = store.reconcileConflict("block-1", local.contentRevision, {
    value: "server",
    cursor: 8,
  });
  assert.equal(rebased.value, "local");
  assert.equal(rebased.cursor, 9);
  assert.equal(rebased.dirty, true);

  const matched = store.reconcileConflict("block-1", local.contentRevision, {
    value: "local",
    cursor: 10,
  });
  assert.equal(matched.cursor, 10);
  assert.equal(matched.dirty, false);
});

test("bounds individual values and the total byte cache", () => {
  const store = new BlockTermOutputStore({ maxEntries: 4, maxBytes: 6, maxValueChars: 4 });
  store.hydrate("block-a", "123456", 1);
  assert.equal(store.getSnapshot("block-a").value, "3456");

  store.hydrate("block-b", "abcd", 2);
  assert.equal(store.has("block-a"), false);
  assert.equal(store.has("block-b"), true);
});

test("retains full output behind the smaller display tail", () => {
  const store = new BlockTermOutputStore({ maxValueChars: 4 });
  store.hydrate("block-1", "123456", 1);
  assert.equal(store.getSnapshot("block-1").value, "3456");
  assert.equal(store.getSnapshot("block-1").outputSize, 6);
  assert.equal(store.getFullValue("block-1"), "123456");

  const appended = store.appendLive("block-1", "789", 2);
  assert.equal(appended.value, "6789");
  assert.equal(appended.outputSize, 9);
  assert.equal(store.getFullValue("block-1"), "123456789");
});

test("drops clean full output on LRU eviction and reloads it on demand", async () => {
  const store = new BlockTermOutputStore({ maxEntries: 1, maxValueChars: 4 });
  store.hydrate("block-1", "prefix-output", 1);
  store.hydrate("block-2", "other", 2);

  assert.equal(store.has("block-1"), false);
  assert.equal(store.getSnapshot("block-1").status, "idle");
  assert.equal(store.getSnapshot("block-1").outputSize, 13);
  assert.equal(store.getFullValue("block-1"), "");

  const loaded = await store.load("block-1", async () => ({ value: "prefix-output", cursor: 1 }));
  assert.equal(loaded.value, "tput");
  assert.equal(store.getFullValue("block-1"), "prefix-output");
});

test("preserves full UTF-8 output while bounding the display tail", () => {
  const store = new BlockTermOutputStore({ maxValueChars: 2 });
  const snapshot = store.hydrate("block-1", "A你好B", 1);
  assert.equal(snapshot.value, "好B");
  assert.equal(snapshot.outputSize, 8);
  assert.equal(store.getFullValue("block-1"), "A你好B");
});

test("accepts the exact output byte limit and truncates later live output", () => {
  const store = new BlockTermOutputStore({ maxOutputBytes: 5, maxValueChars: 4 });
  const exact = store.hydrate("block-1", "12345", 1);

  assert.equal(exact.outputSize, 5);
  assert.equal(exact.error, null);
  assert.equal(store.getFullValue("block-1"), "12345");

  const truncated = store.appendLive("block-1", "6", 2);
  assert.equal(truncated.value, "3456");
  assert.equal(truncated.outputSize, 5);
  assert.equal(truncated.dirty, false);
  assert.match(truncated.error, /too large/);
  assert.equal(store.getFullValue("block-1"), "12345");
});

test("truncates the durable prefix at a UTF-8 boundary", () => {
  const store = new BlockTermOutputStore({ maxOutputBytes: 5, maxValueChars: 10 });
  const snapshot = store.hydrate("block-1", "A你好B", 1);

  assert.equal(snapshot.value, "A你好B");
  assert.equal(snapshot.outputSize, 4);
  assert.match(snapshot.error, /too large/);
  assert.equal(store.getFullValue("block-1"), "A你");
  assert.equal(new TextEncoder().encode(store.getFullValue("block-1")).byteLength <= 5, true);
});

test("keeps the latest display tail after the durable prefix is full", () => {
  const store = new BlockTermOutputStore({ maxOutputBytes: 5, maxValueChars: 4 });
  store.hydrate("block-1", "1234", 1);

  const capped = store.appendLive("block-1", "5ab", 2);
  assert.equal(capped.value, "45ab");
  assert.equal(capped.dirty, true);
  assert.equal(store.getFullValue("block-1"), "12345");

  const liveTail = store.appendLive("block-1", "cd", 3);
  assert.equal(liveTail.value, "abcd");
  assert.equal(liveTail.dirty, true);
  assert.equal(store.getFullValue("block-1"), "12345");

  assert.equal(store.markPersisted("block-1", capped.contentRevision), true);
  assert.equal(store.getSnapshot("block-1").dirty, false);

  const afterPersist = store.appendLive("block-1", "ef", 4);
  assert.equal(afterPersist.value, "cdef");
  assert.equal(afterPersist.dirty, false);
  assert.match(afterPersist.error, /too large/);
  assert.equal(store.getFullValue("block-1"), "12345");
});

test("clamps oversized output metadata to the durable limit", () => {
  const store = new BlockTermOutputStore({ maxOutputBytes: 5 });
  const snapshot = store.prime("block-1", 6, 1);

  assert.equal(snapshot.outputSize, 5);
  assert.match(snapshot.error, /too large/);
});

test("retains output larger than one MiB without truncating the full value", () => {
  const store = new BlockTermOutputStore({ maxValueChars: 200_000 });
  const output = `${"x".repeat(1024 * 1024 + 17)}终点`;
  const snapshot = store.hydrate("block-large", output, 1);

  assert.equal(snapshot.outputSize, new TextEncoder().encode(output).byteLength);
  assert.equal(snapshot.value, output.slice(-200_000));
  assert.equal(store.getFullValue("block-large"), output);

  const appended = store.appendLive("block-large", "\nnext", 2);
  assert.equal(appended.value, `${output}\nnext`.slice(-200_000));
  assert.equal(appended.outputSize, new TextEncoder().encode(`${output}\nnext`).byteLength);
  assert.equal(store.getFullValue("block-large"), `${output}\nnext`);
});

test("reconciles conflicts using full output instead of an identical display tail", () => {
  const store = new BlockTermOutputStore({ maxValueChars: 4 });
  const local = store.appendLive("block-1", "prefix-local", 3);
  assert.equal(local.value, "ocal");

  const rebased = store.reconcileConflict("block-1", local.contentRevision, {
    value: "other-local",
    cursor: 8,
  });
  assert.equal(rebased.value, "ocal");
  assert.equal(rebased.cursor, 9);
  assert.equal(rebased.dirty, true);
  assert.equal(store.getFullValue("block-1"), "prefix-local");
});

test("publishes load failures and allows a later retry", async () => {
  const store = new BlockTermOutputStore();
  await assert.rejects(store.load("block-1", async () => Promise.reject(new Error("offline"))), /offline/);
  assert.equal(store.getSnapshot("block-1").status, "error");
  assert.equal(store.getSnapshot("block-1").error, "offline");

  const recovered = await store.load("block-1", async () => ({ value: "recovered", cursor: null }));
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.value, "recovered");
});

test("normalizes synchronous loader failures and allows a later retry", async () => {
  const store = new BlockTermOutputStore();
  await assert.rejects(
    store.load("block-1", () => {
      throw new Error("invalid loader");
    }),
    /invalid loader/
  );
  assert.equal(store.getSnapshot("block-1").status, "error");

  const recovered = await store.load("block-1", async () => ({ value: "recovered", cursor: 2 }));
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.cursor, 2);
});

test("cancels scoped loads without deleting output metadata", async () => {
  const store = new BlockTermOutputStore();
  const pending = deferred();
  let signal;
  const loading = store.load("block-1", async (_blockId, loadSignal) => {
    signal = loadSignal;
    return pending.promise;
  });

  store.cancelLoads(["block-1"]);
  assert.equal(signal.aborted, true);
  assert.equal(store.getSnapshot("block-1").status, "ready");
  pending.resolve({ value: "late", cursor: 2 });
  await loading;
  assert.equal(store.getSnapshot("block-1").value, "");
});

test("cancels every pending load when a workspace scope is reset", async () => {
  const store = new BlockTermOutputStore();
  const first = deferred();
  const second = deferred();
  const signals = [];
  const loads = [
    store.load("block-1", async (_blockId, signal) => {
      signals.push(signal);
      return first.promise;
    }),
    store.load("block-2", async (_blockId, signal) => {
      signals.push(signal);
      return second.promise;
    }),
  ];

  store.cancelLoads();
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, true]
  );
  first.resolve({ value: "late-1", cursor: 1 });
  second.resolve({ value: "late-2", cursor: 2 });
  await Promise.all(loads);
  assert.equal(store.getSnapshot("block-1").value, "");
  assert.equal(store.getSnapshot("block-2").value, "");
});
