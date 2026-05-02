import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("conflict parser preserves plain context and trailing newlines", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { buildConflictDocuments } = await vite.ssrLoadModule("/src/components/git/conflict-utils.ts");
  const documents = buildConflictDocuments([
    { type: "plain", text: "header" },
    { type: "conflict", ours: ["ours one"], base: ["base one"], theirs: ["theirs one"] },
    { type: "plain", text: "between" },
    { type: "conflict", ours: ["ours two"], theirs: ["theirs two"] },
    { type: "plain", text: "footer\n" },
  ]);

  assert.equal(documents.ours, "header\nours one\nbetween\nours two\nfooter\n");
  assert.equal(documents.theirs, "header\ntheirs one\nbetween\ntheirs two\nfooter\n");
  assert.equal(documents.base, "header\nbase one\nbetween\n\nfooter\n");
});

test("conflict parser keeps a modify/delete side empty", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { buildConflictDocuments } = await vite.ssrLoadModule("/src/components/git/conflict-utils.ts");
  const documents = buildConflictDocuments([
    { type: "conflict", ours: ["kept", ""], base: ["base", ""], theirs: [] },
  ]);

  assert.equal(documents.ours, "kept\n");
  assert.equal(documents.theirs, "");
  assert.notEqual(documents.ours, documents.theirs);
  assert.doesNotMatch(documents.theirs, /kept/);
});
