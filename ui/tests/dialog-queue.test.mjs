import assert from "node:assert/strict";
import test from "node:test";

import { DialogRequestQueue } from "../src/components/common/dialog-queue.ts";

let nextId = 1;

function request(type, patch = {}) {
  return {
    id: nextId++,
    type,
    title: patch.title || type,
    defaultValue: patch.defaultValue,
    signal: patch.signal,
    resolve: () => {},
    settled: false,
  };
}

test("activates dialogs in FIFO order without leaking a queued prompt default", async () => {
  const active = [];
  const queue = new DialogRequestQueue((current) => active.push(current));
  const confirm = request("confirm", { title: "confirm-a" });
  const prompt = request("prompt", { title: "prompt-b", defaultValue: "prompt-default" });

  const confirmResult = queue.enqueue(confirm, false, Boolean);
  const promptResult = queue.enqueue(prompt, null, (value) => value);
  assert.deepEqual(active.map((item) => item?.title), ["confirm-a"]);
  assert.equal(active[0]?.defaultValue, undefined);

  assert.equal(queue.finish(confirm, true), true);
  assert.deepEqual(active.map((item) => item?.title), ["confirm-a", "prompt-b"]);
  assert.equal(active[1]?.defaultValue, "prompt-default");
  assert.equal(await confirmResult, true);

  queue.finish(prompt, "edited-value");
  assert.equal(await promptResult, "edited-value");
  assert.equal(active.at(-1), null);
});

test("settles queued and active aborts with cancel values while advancing FIFO", async () => {
  const active = [];
  const queue = new DialogRequestQueue((current) => active.push(current));
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const first = request("confirm", { title: "first", signal: activeController.signal });
  const skipped = request("prompt", { title: "skipped", signal: queuedController.signal });
  const last = request("alert", { title: "last" });

  const firstResult = queue.enqueue(first, false, Boolean);
  const skippedResult = queue.enqueue(skipped, null, (value) => value);
  const lastResult = queue.enqueue(last, true, () => undefined);
  queuedController.abort();
  assert.equal(await skippedResult, null);
  assert.deepEqual(active.map((item) => item?.title), ["first"]);

  activeController.abort();
  assert.equal(await firstResult, false);
  assert.deepEqual(active.map((item) => item?.title), ["first", "last"]);
  queue.finish(last, true);
  await lastResult;
  assert.equal(active.at(-1), null);
});

test("dispose settles active and queued requests and old callbacks cannot advance twice", async () => {
  const active = [];
  const settled = [];
  const queue = new DialogRequestQueue((current) => active.push(current));
  const first = request("confirm", { title: "first" });
  const second = request("prompt", { title: "second" });
  const third = request("alert", { title: "third" });

  const firstResult = queue.enqueue(first, false, Boolean);
  const secondResult = queue.enqueue(second, null, (value) => value).then((value) => {
    settled.push("second");
    return value;
  });
  const thirdResult = queue.enqueue(third, true, () => undefined).then((value) => {
    settled.push("third");
    return value;
  });
  assert.equal(queue.finish(first, true), true);
  assert.equal(queue.finish(first, false), false);
  assert.deepEqual(active.map((item) => item?.title), ["first", "second"]);
  assert.equal(await firstResult, true);

  queue.dispose();
  assert.equal(await secondResult, null);
  await thirdResult;
  assert.deepEqual(settled, ["second", "third"]);
  assert.equal(active.at(-1), null);
  assert.equal(queue.finish(second, "late"), false);

  const afterDispose = request("confirm", { title: "after-dispose" });
  assert.equal(await queue.enqueue(afterDispose, false, Boolean), false);
  assert.deepEqual(active.map((item) => item?.title), ["first", "second", undefined]);
});
