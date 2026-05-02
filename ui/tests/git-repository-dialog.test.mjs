import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("validates create and clone repository inputs", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { performGitRepositoryOperation, validateGitRepositoryInput } = await vite.ssrLoadModule(
    "/src/components/git/git-repository-dialog.tsx"
  );

  assert.equal(validateGitRepositoryInput("create", "", ""), "path");
  assert.equal(validateGitRepositoryInput("create", "", " /tmp/new-repository "), null);
  assert.equal(validateGitRepositoryInput("clone", "", "/tmp/new-repository"), "url");
  assert.equal(validateGitRepositoryInput("clone", " https://example.com/repo.git ", " /tmp/new-repository "), null);

  const calls = [];
  assert.equal(
    await performGitRepositoryOperation("create", "", " /tmp/create-repository ", {
      init: async (path) => calls.push(["init", path]),
      clone: async () => calls.push(["clone"]),
    }),
    "/tmp/create-repository"
  );
  assert.equal(
    await performGitRepositoryOperation("clone", " https://example.com/repo.git ", " /tmp/clone-repository ", {
      init: async () => calls.push(["init"]),
      clone: async (url, path) => calls.push(["clone", url, path]),
    }),
    "/tmp/clone-repository"
  );
  assert.deepEqual(calls, [
    ["init", "/tmp/create-repository"],
    ["clone", "https://example.com/repo.git", "/tmp/clone-repository"],
  ]);
});
