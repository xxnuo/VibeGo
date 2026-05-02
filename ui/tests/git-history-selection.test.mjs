import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("history selection continuity handles newest-first ordering and incomplete selections", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { areHistoryCommitsContiguous, getHistoryCommitSelectionIndexes } = await vite.ssrLoadModule(
    "/src/components/git/git-history-selection.ts"
  );
  const commits = [
    { hash: "newest" },
    { hash: "middle" },
    { hash: "older" },
    { hash: "oldest" },
  ];

  const select = (...hashes) => hashes.map((hash) => ({ hash }));
  assert.equal(areHistoryCommitsContiguous(commits, select()), true);
  assert.equal(areHistoryCommitsContiguous(commits, select("middle")), true);
  assert.equal(areHistoryCommitsContiguous(commits, select("older", "middle")), true);
  assert.equal(areHistoryCommitsContiguous(commits, select("oldest", "middle", "older")), true);
  assert.equal(areHistoryCommitsContiguous(commits, select("newest", "older")), false);
  assert.equal(areHistoryCommitsContiguous(commits, select("middle", "middle", "older")), true);
  assert.equal(areHistoryCommitsContiguous(commits, select("middle", "missing", "older")), false);
  assert.deepEqual(getHistoryCommitSelectionIndexes(commits, select("older", "middle")), [2, 1]);
  assert.equal(getHistoryCommitSelectionIndexes(commits, select("missing")), null);
});

test("history selection continuity treats duplicate loaded hashes deterministically", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { areHistoryCommitsContiguous } = await vite.ssrLoadModule("/src/components/git/git-history-selection.ts");
  const commits = [{ hash: "newest" }, { hash: "middle" }, { hash: "middle" }, { hash: "oldest" }];

  const select = (...hashes) => hashes.map((hash) => ({ hash }));
  assert.equal(areHistoryCommitsContiguous(commits, select("newest", "middle")), true);
  assert.equal(areHistoryCommitsContiguous(commits, select("middle", "oldest")), false);
});
