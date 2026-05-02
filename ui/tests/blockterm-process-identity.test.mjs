import assert from "node:assert/strict";
import test from "node:test";
import {
  decideBlockTermProcessIdentity,
  startBlockTermProcessIdentityTracker,
} from "../src/components/terminal/blockterm-process-identity.ts";

const RUNNING_GUARD = {
  tokenMatches: true,
  scopeMatches: true,
  sessionRunning: true,
  blockRunning: true,
};

function identity(shellPid, foregroundChildPid) {
  return {
    shell_pid: shellPid,
    shell_process_group_id: shellPid,
    foreground_process_group_id: foregroundChildPid,
    foreground_child_pid: foregroundChildPid,
  };
}

function createScheduler(startedAt = 0) {
  let now = startedAt;
  let nextId = 1;
  const timers = new Map();
  return {
    schedule(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    now() {
      return now;
    },
    advanceTo(value) {
      now = value;
    },
    runNext() {
      const entry = [...timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!entry) return false;
      timers.delete(entry[0]);
      now = Math.max(now, entry[1].dueAt);
      entry[1].callback();
      return true;
    },
    size() {
      return timers.size;
    },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

test("accepts only a positive foreground process-group leader distinct from the shell", () => {
  assert.equal(
    decideBlockTermProcessIdentity({ ...RUNNING_GUARD, identity: identity(101, 202) }),
    "accept"
  );
  for (const foregroundChildPid of [null, 0, -1, 1.5, 101]) {
    assert.equal(
      decideBlockTermProcessIdentity({ ...RUNNING_GUARD, identity: identity(101, foregroundChildPid) }),
      "continue"
    );
  }
});

test("stops when the token, scope, running status, or deadline is stale", () => {
  for (const patch of [
    { tokenMatches: false },
    { scopeMatches: false },
    { sessionRunning: false },
    { blockRunning: false },
    { timedOut: true },
  ]) {
    assert.equal(
      decideBlockTermProcessIdentity({ ...RUNNING_GUARD, identity: identity(101, 202), ...patch }),
      "stop"
    );
  }
});

test("polls until a foreground child can be accepted", async () => {
  const scheduler = createScheduler(100);
  const responses = [identity(101, null), identity(101, 202)];
  const accepted = [];
  const tracker = startBlockTermProcessIdentityTracker({
    load: async () => responses.shift(),
    guard: () => RUNNING_GUARD,
    onAccept: (pid, processIdentity) => accepted.push([pid, processIdentity]),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    now: scheduler.now,
    initialDelayMs: 10,
    pollIntervalMs: 25,
    timeoutMs: 500,
  });

  assert.equal(scheduler.runNext(), true);
  await flushAsync();
  assert.deepEqual(accepted, []);
  assert.equal(tracker.isActive(), true);
  assert.equal(scheduler.runNext(), true);
  await flushAsync();
  assert.deepEqual(accepted, [[202, identity(101, 202)]]);
  assert.equal(tracker.isActive(), false);
  assert.equal(scheduler.size(), 0);
});

test("a short command ending before the first poll cannot publish the shell pid", async () => {
  const scheduler = createScheduler();
  let guard = RUNNING_GUARD;
  let loads = 0;
  const accepted = [];
  const tracker = startBlockTermProcessIdentityTracker({
    load: async () => {
      loads += 1;
      return identity(101, 101);
    },
    guard: () => guard,
    onAccept: (pid) => accepted.push(pid),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    now: scheduler.now,
    initialDelayMs: 20,
    timeoutMs: 500,
  });

  guard = { ...RUNNING_GUARD, sessionRunning: false, blockRunning: false };
  assert.equal(scheduler.runNext(), true);
  await flushAsync();
  assert.equal(loads, 0);
  assert.deepEqual(accepted, []);
  assert.equal(tracker.isActive(), false);
  assert.equal(scheduler.size(), 0);
});

test("a token or scope change while loading discards the late identity", async () => {
  for (const staleGuard of [
    { ...RUNNING_GUARD, tokenMatches: false },
    { ...RUNNING_GUARD, scopeMatches: false },
  ]) {
    const scheduler = createScheduler();
    let guard = RUNNING_GUARD;
    let resolveLoad;
    const accepted = [];
    const tracker = startBlockTermProcessIdentityTracker({
      load: () => new Promise((resolve) => (resolveLoad = resolve)),
      guard: () => guard,
      onAccept: (pid) => accepted.push(pid),
      schedule: scheduler.schedule,
      clear: scheduler.clear,
      now: scheduler.now,
      timeoutMs: 500,
    });

    assert.equal(scheduler.runNext(), true);
    guard = staleGuard;
    resolveLoad(identity(101, 202));
    await flushAsync();
    assert.deepEqual(accepted, []);
    assert.equal(tracker.isActive(), false);
    assert.equal(scheduler.size(), 0);
  }
});

test("timeout aborts an in-flight request and ignores its later completion", async () => {
  const scheduler = createScheduler();
  let requestSignal;
  let resolveLoad;
  const accepted = [];
  const tracker = startBlockTermProcessIdentityTracker({
    load: (signal) => {
      requestSignal = signal;
      return new Promise((resolve) => (resolveLoad = resolve));
    },
    guard: () => RUNNING_GUARD,
    onAccept: (pid) => accepted.push(pid),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    now: scheduler.now,
    timeoutMs: 50,
  });

  assert.equal(scheduler.runNext(), true);
  assert.equal(requestSignal.aborted, false);
  assert.equal(scheduler.runNext(), true);
  assert.equal(requestSignal.aborted, true);
  assert.equal(tracker.isActive(), false);
  resolveLoad(identity(101, 202));
  await flushAsync();
  assert.deepEqual(accepted, []);
  assert.equal(scheduler.size(), 0);
});

test("cancelling aborts the request and blocks a loader that ignores abort", async () => {
  const scheduler = createScheduler();
  let requestSignal;
  let resolveLoad;
  const accepted = [];
  const tracker = startBlockTermProcessIdentityTracker({
    load: (signal) => {
      requestSignal = signal;
      return new Promise((resolve) => (resolveLoad = resolve));
    },
    guard: () => RUNNING_GUARD,
    onAccept: (pid) => accepted.push(pid),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    now: scheduler.now,
    timeoutMs: 500,
  });

  assert.equal(scheduler.runNext(), true);
  tracker.cancel();
  assert.equal(requestSignal.aborted, true);
  resolveLoad(identity(101, 202));
  await flushAsync();
  assert.deepEqual(accepted, []);
  assert.equal(tracker.isActive(), false);
  assert.equal(scheduler.size(), 0);
});

test("uses the injected clock to reject a response that crosses the deadline", async () => {
  const scheduler = createScheduler(1000);
  let resolveLoad;
  const accepted = [];
  const tracker = startBlockTermProcessIdentityTracker({
    load: () => new Promise((resolve) => (resolveLoad = resolve)),
    guard: () => RUNNING_GUARD,
    onAccept: (pid) => accepted.push(pid),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    now: scheduler.now,
    timeoutMs: 40,
  });

  assert.equal(scheduler.runNext(), true);
  scheduler.advanceTo(1040);
  resolveLoad(identity(101, 202));
  await flushAsync();
  assert.deepEqual(accepted, []);
  assert.equal(tracker.isActive(), false);
  assert.equal(scheduler.size(), 0);
});

test("an external abort stops before the first scheduled load", async () => {
  const scheduler = createScheduler();
  const controller = new AbortController();
  let loads = 0;
  const tracker = startBlockTermProcessIdentityTracker({
    load: async () => {
      loads += 1;
      return identity(101, 202);
    },
    guard: () => RUNNING_GUARD,
    onAccept: () => assert.fail("aborted tracking must not accept"),
    signal: controller.signal,
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    now: scheduler.now,
  });

  controller.abort();
  await flushAsync();
  assert.equal(loads, 0);
  assert.equal(tracker.isActive(), false);
  assert.equal(scheduler.size(), 0);
});
