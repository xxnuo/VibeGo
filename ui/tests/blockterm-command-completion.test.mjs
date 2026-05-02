import assert from "node:assert/strict";
import test from "node:test";

import { applyBlockTermCompletion } from "../src/components/terminal/blockterm-model.ts";
import { resolveBlockTermCommandCompletion } from "../src/components/terminal/blockterm-command-completion.ts";

test("suggests WaveTerm-style subcommands and a primary ghost suffix", () => {
  const result = resolveBlockTermCommandCompletion("git st", 6);
  assert.ok(result);
  assert.deepEqual(
    result.candidates.slice(0, 2).map(({ value, kind }) => ({ value, kind })),
    [
      { value: "status", kind: "subcommand" },
      { value: "stash", kind: "subcommand" },
    ]
  );
  assert.equal(result.commonPrefix, "sta");
  assert.equal(result.ghostText, "atus");
  assert.deepEqual(applyBlockTermCompletion(result.context, result.candidates[0].value, true), {
    draft: "git status ",
    cursor: 11,
  });
});

test("uses subcommand-specific options and their descriptions", () => {
  const result = resolveBlockTermCommandCompletion("git commit --am", 15);
  assert.ok(result);
  assert.deepEqual(result.candidates, [
    {
      value: "--amend",
      display: "--amend",
      isDirectory: false,
      kind: "option",
      description: "Replace the previous commit",
    },
  ]);
  assert.equal(result.ghostText, "end");
});

test("does not leak options across unrelated subcommands", () => {
  assert.equal(resolveBlockTermCommandCompletion("git status --am", 15), null);
  assert.equal(resolveBlockTermCommandCompletion("git status --no", 15), null);
  assert.equal(resolveBlockTermCommandCompletion("git commit --ver", 16), null);
  assert.equal(resolveBlockTermCommandCompletion("go test -C", 10), null);
  assert.equal(resolveBlockTermCommandCompletion("docker compose --context", 24), null);
  const result = resolveBlockTermCommandCompletion("git status --por", 16);
  assert.equal(result?.candidates[0].value, "--porcelain");
  assert.equal(resolveBlockTermCommandCompletion("git --no", 8)?.candidates[0].value, "--no-pager");
});

test("consumes option arguments before matching a subcommand", () => {
  const result = resolveBlockTermCommandCompletion("git -C /tmp st", 14);
  assert.equal(result?.candidates[0].value, "status");
  assert.equal(result?.ghostText, "atus");
});

test("does not suggest a non-repeatable option after it was used", () => {
  const result = resolveBlockTermCommandCompletion("git commit --amend --", 21);
  assert.ok(result);
  assert.equal(result.candidates.some((candidate) => candidate.value === "--amend"), false);
  assert.equal(result.candidates.some((candidate) => candidate.value === "--allow-empty"), true);

  const aliasResult = resolveBlockTermCommandCompletion("git switch -c topic --", 22);
  assert.ok(aliasResult);
  assert.equal(aliasResult.candidates.some((candidate) => candidate.value === "--create"), false);
  assert.equal(aliasResult.candidates.some((candidate) => candidate.value === "--force-create"), true);
});

test("stops structured completion after the explicit double dash", () => {
  assert.equal(resolveBlockTermCommandCompletion("git checkout -- --f", 19), null);
});

test("traverses nested subcommands", () => {
  const result = resolveBlockTermCommandCompletion("docker compose bu", 17);
  assert.deepEqual(
    result?.candidates.map(({ value, kind }) => ({ value, kind })),
    [{ value: "build", kind: "subcommand" }]
  );
  assert.equal(result?.ghostText, "ild");
});

test("resets parsing at shell command separators", () => {
  const result = resolveBlockTermCommandCompletion("printf ok && go mo", 18);
  assert.equal(result?.candidates[0].value, "mod");
  assert.equal(result?.ghostText, "d");
});

test("supports command wrappers and environment assignments", () => {
  assert.equal(resolveBlockTermCommandCompletion("FOO=1 command git sw", 20)?.candidates[0].value, "switch");
  assert.equal(resolveBlockTermCommandCompletion("sudo git com", 12)?.candidates[0].value, "commit");
  assert.equal(resolveBlockTermCommandCompletion("sudo -u root git st", 19)?.candidates[0].value, "status");
  assert.equal(resolveBlockTermCommandCompletion("env -u FOO git st", 17)?.candidates[0].value, "status");
  assert.equal(resolveBlockTermCommandCompletion("command -p git st", 17)?.candidates[0].value, "status");
  assert.equal(
    resolveBlockTermCommandCompletion("env -u FOO sudo --user=root command -p git st", 45)?.candidates[0].value,
    "status"
  );
});

test("suppresses unsafe shell and option-value contexts", () => {
  assert.equal(resolveBlockTermCommandCompletion("git $SUB", 8), null);
  assert.equal(resolveBlockTermCommandCompletion("git -C /tm", 10), null);
  assert.equal(resolveBlockTermCommandCompletion("git status > out --", 18), null);
});

test("does not show a ghost when the cursor is in the middle of a token", () => {
  const result = resolveBlockTermCommandCompletion("git status", 6);
  assert.ok(result);
  assert.equal(result.ghostText, "");
});
