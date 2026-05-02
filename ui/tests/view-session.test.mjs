import assert from "node:assert/strict";
import test from "node:test";

import {
  clampMediaRestoreTime,
  createSerialExecutor,
  mergeViewSession,
  shouldRenewViewSession,
  VIEW_SESSION_MAX_ERROR_RETRIES,
  viewResourceKey,
  viewSessionRenewDelay,
  viewSessionRetryDelay,
} from "../src/lib/view-session.ts";

test("serializes signed view-session bootstrap requests", async () => {
  const runSerial = createSerialExecutor();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = runSerial(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = runSerial(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("schedules signed view-session renewal before expiry", () => {
  const session = { url: "/signed", expiresAt: 1_000 };
  assert.equal(viewSessionRenewDelay(session, 900_000), 40_000);
  assert.equal(shouldRenewViewSession(session, 939_999), false);
  assert.equal(shouldRenewViewSession(session, 940_000), true);
  assert.equal(viewSessionRenewDelay({ url: "/plain", expiresAt: null }, 900_000), null);
});

test("distinguishes expiry-only renewal from a resource URL change", () => {
  const current = { url: "/signed?sig=stable", expiresAt: 1_000 };
  const expiryOnly = mergeViewSession(current, { url: current.url, expiresAt: 1_500 });
  assert.equal(expiryOnly.urlChanged, false);
  assert.deepEqual(expiryOnly.session, { url: current.url, expiresAt: 1_500 });
  assert.equal(viewResourceKey(current, 0), viewResourceKey(expiryOnly.session, 0));
  assert.notEqual(viewResourceKey(current, 0), viewResourceKey(expiryOnly.session, 1));

  const replacement = mergeViewSession(current, { url: "/signed?sig=next", expiresAt: 1_500 });
  assert.equal(replacement.urlChanged, true);
  assert.equal(replacement.session.url, "/signed?sig=next");
});

test("caps automatic view-session retries with exponential delays", () => {
  assert.equal(viewSessionRetryDelay(1), 1_000);
  assert.equal(viewSessionRetryDelay(2), 2_000);
  assert.equal(viewSessionRetryDelay(VIEW_SESSION_MAX_ERROR_RETRIES + 1), null);
});

test("clamps restored media time to a seekable duration", () => {
  assert.equal(clampMediaRestoreTime(Number.NaN, 10), 0);
  assert.equal(clampMediaRestoreTime(-1, 10), 0);
  assert.equal(clampMediaRestoreTime(4.5, 10), 4.5);
  assert.equal(clampMediaRestoreTime(15, 10), 9.95);
  assert.equal(clampMediaRestoreTime(15, Number.POSITIVE_INFINITY), 15);
});
