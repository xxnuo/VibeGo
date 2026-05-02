import assert from "node:assert/strict";
import test from "node:test";

import {
  createBlockTermBookmarkDraft,
  getBlockTermBookmarkDisplayTitle,
  getBlockTermBookmarkSelectionAfterDelete,
  upsertBlockTermBookmark,
  validateBlockTermBookmarkDraft,
} from "../src/components/terminal/blockterm-bookmark.ts";

function bookmark(id, updatedAt, overrides = {}) {
  return {
    id,
    title: "",
    description: "",
    command: `echo ${id}`,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

test("creates bookmark drafts from blocks and existing bookmarks", () => {
  assert.deepEqual(createBlockTermBookmarkDraft(null, "printf 'hello'"), {
    title: "",
    description: "",
    command: "printf 'hello'",
  });
  assert.deepEqual(
    createBlockTermBookmarkDraft({ title: "Build", description: "Release build", command: "pnpm build" }),
    { title: "Build", description: "Release build", command: "pnpm build" }
  );
});

test("validates bookmark fields with the backend UTF-8 byte limits", () => {
  assert.equal(validateBlockTermBookmarkDraft({ title: "", description: "", command: "   " }), "commandRequired");
  assert.equal(
    validateBlockTermBookmarkDraft({ title: "你".repeat(86), description: "", command: "echo ok" }),
    "titleTooLong"
  );
  assert.equal(
    validateBlockTermBookmarkDraft({ title: "a".repeat(256), description: "", command: "echo ok" }),
    null
  );
  assert.equal(
    validateBlockTermBookmarkDraft({ title: "", description: "a".repeat(4097), command: "echo ok" }),
    "descriptionTooLong"
  );
  assert.equal(
    validateBlockTermBookmarkDraft({ title: "", description: "", command: "a".repeat(16 * 1024 + 1) }),
    "commandTooLong"
  );
});

test("uses an explicit title or the first non-empty command line in bookmark lists", () => {
  assert.equal(getBlockTermBookmarkDisplayTitle({ title: " Deploy ", command: "echo ignored" }), "Deploy");
  assert.equal(getBlockTermBookmarkDisplayTitle({ title: "", command: "\n  pnpm build\necho done" }), "pnpm build");
});

test("keeps bookmark mutations in updated order and selects a neighbor after deletion", () => {
  const initial = [bookmark("newest", 30), bookmark("middle", 20), bookmark("oldest", 10)];
  const updated = upsertBlockTermBookmark(initial, bookmark("oldest", 40, { title: "Updated" }));
  assert.deepEqual(
    updated.map((item) => item.id),
    ["oldest", "newest", "middle"]
  );
  assert.equal(getBlockTermBookmarkSelectionAfterDelete(initial, "middle"), "oldest");
  assert.equal(getBlockTermBookmarkSelectionAfterDelete(initial, "oldest"), "middle");
  assert.equal(getBlockTermBookmarkSelectionAfterDelete([bookmark("only", 1)], "only"), null);
});
