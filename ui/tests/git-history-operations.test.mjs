import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("cherry-pick does not default to a commit from the current HEAD history", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { defaultGitOperationRef } = await vite.ssrLoadModule("/src/components/git/desktop-git-workspace.tsx");

  assert.equal(defaultGitOperationRef("cherry-pick", "ancestor", "main"), "");
  assert.equal(defaultGitOperationRef("revert", "ancestor", "main"), "ancestor");
  assert.equal(defaultGitOperationRef("merge", undefined, "main"), "main");
});

test("multi-commit history cherry-pick sends each hash exactly once", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { getHistoryCherryPickRequest } = await vite.ssrLoadModule("/src/components/git/git-view.tsx");
  const commits = [
    { hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  ];

  assert.deepEqual(getHistoryCherryPickRequest(commits), {
    commit: "",
    action: "start",
    options: { commits: commits.map((commit) => commit.hash) },
  });
  assert.deepEqual(getHistoryCherryPickRequest([commits[0]]), {
    commit: commits[0].hash,
    action: "start",
  });
});

test("history cherry-pick orders selected commits oldest-first", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { orderHistoryCommits, getHistoryCherryPickRequest } = await vite.ssrLoadModule(
    "/src/components/git/git-view.tsx"
  );
  const newest = { hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const middle = { hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  const oldest = { hash: "cccccccccccccccccccccccccccccccccccccccc" };
  const history = [newest, middle, oldest];

  const ordered = orderHistoryCommits(history, [newest, oldest, middle]);
  assert.deepEqual(
    ordered.map((commit) => commit.hash),
    [oldest.hash, middle.hash, newest.hash]
  );
  assert.deepEqual(getHistoryCherryPickRequest(ordered).options, {
    commits: [oldest.hash, middle.hash, newest.hash],
  });
});
