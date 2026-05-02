import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("check-suite reruns require a completed, recent, rerequestable suite", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { isCheckSuiteRerunnable } = await vite.ssrLoadModule("/src/components/git/github-panel.tsx");
  const now = Date.parse("2026-08-27T00:00:00.000Z");
  const base = {
    id: 1,
    status: "completed",
    created_at: "2026-08-01T00:00:00.000Z",
    rerequestable: true,
  };

  assert.equal(isCheckSuiteRerunnable(base, now), true);
  assert.equal(isCheckSuiteRerunnable({ ...base, rerequestable: false }, now), false);
  assert.equal(isCheckSuiteRerunnable({ ...base, status: "in_progress" }, now), false);
  assert.equal(
    isCheckSuiteRerunnable({ ...base, created_at: "2026-07-27T00:00:00.000Z" }, now),
    false
  );
  assert.equal(isCheckSuiteRerunnable({ ...base, created_at: "not-a-date" }, now), false);
  assert.equal(isCheckSuiteRerunnable({ ...base, created_at: "2026-08-28T00:00:00.000Z" }, now), false);
});

test("workflow run lookup uses the commit SHA instead of a possibly mismatched branch", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { workflowRunsQueryForCommit } = await vite.ssrLoadModule("/src/components/git/github-panel.tsx");
  assert.deepEqual(workflowRunsQueryForCommit("abc123"), {
    head_sha: "abc123",
    per_page: 30,
  });
  assert.equal("branch" in workflowRunsQueryForCommit("abc123"), false);
});
