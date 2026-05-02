import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("history rewrites pass the parent of the oldest loaded commit", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { getLastRetainedCommitRef } = await vite.ssrLoadModule("/src/components/git/git-view.tsx");
  const commits = [
    { hash: "cccccccccccccccccccccccccccccccccccccccc" },
    { hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { hash: "dddddddddddddddddddddddddddddddddddddddd" },
  ];

  assert.equal(
    getLastRetainedCommitRef(commits, [commits[0].hash.slice(0, 7), commits[1].hash]),
    `${commits[1].hash}^`
  );
  assert.equal(getLastRetainedCommitRef(commits, [commits[3].hash]), undefined);
  assert.equal(getLastRetainedCommitRef(commits, ["not-loaded"]), undefined);
});
