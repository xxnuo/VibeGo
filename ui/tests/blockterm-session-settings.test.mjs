import assert from "node:assert/strict";
import test from "node:test";

import {
  createBlockTermSettingsDialogSubmissionGuard,
  normalizeBlockTermTabColor,
  normalizeBlockTermTabIcon,
  orderBlockTermTerminalsByWorkspace,
  reorderBlockTermItems,
  reorderBlockTermTerminalTree,
  sameBlockTermOrder,
  sameBlockTermSessionSettings,
  shouldRollbackBlockTermMutation,
} from "../src/components/terminal/blockterm-session-settings.ts";

test("invalidates an old settings submission across controlled close and reopen transitions", () => {
  const guard = createBlockTermSettingsDialogSubmissionGuard(true);
  const oldSubmission = guard.begin();

  guard.syncOpen(false);
  assert.equal(guard.isCurrent(oldSubmission), false);

  guard.syncOpen(true);
  assert.equal(guard.isCurrent(oldSubmission), false);

  const newSubmission = guard.begin();
  assert.equal(guard.isCurrent(oldSubmission), false);
  assert.equal(guard.isCurrent(newSubmission), true);
});

test("normalizes unsupported tab appearance to the default", () => {
  assert.equal(normalizeBlockTermTabColor("cyan"), "cyan");
  assert.equal(normalizeBlockTermTabColor("chartreuse"), "default");
  assert.equal(normalizeBlockTermTabIcon("graduation-cap"), "graduation-cap");
  assert.equal(normalizeBlockTermTabIcon("rocket"), "default");
});

test("reorders workspace entries at the target position", () => {
  assert.deepEqual(
    reorderBlockTermItems([{ id: "a" }, { id: "b" }, { id: "c" }], "a", "c").map((item) => item.id),
    ["b", "c", "a"]
  );
  assert.deepEqual(
    reorderBlockTermItems([{ id: "a" }, { id: "b" }, { id: "c" }], "c", "a").map((item) => item.id),
    ["c", "a", "b"]
  );
});

test("moves a root terminal together with all split children", () => {
  const terminals = [
    { id: "root-a" },
    { id: "child-a1", parentId: "root-a" },
    { id: "root-b" },
    { id: "child-b1", parentId: "root-b" },
    { id: "child-a2", parentId: "root-a" },
    { id: "root-c" },
  ];
  assert.deepEqual(
    reorderBlockTermTerminalTree(terminals, "root-a", "root-c").map((terminal) => terminal.id),
    ["root-b", "child-b1", "root-c", "root-a", "child-a1", "child-a2"]
  );
  assert.deepEqual(
    reorderBlockTermTerminalTree(terminals, "child-b1", "root-a").map((terminal) => terminal.id),
    ["root-b", "child-b1", "root-a", "child-a1", "child-a2", "root-c"]
  );
});

test("restores API terminals in durable workspace order and appends unknown rows", () => {
  const apiOrder = [{ id: "new" }, { id: "root-c" }, { id: "root-a" }, { id: "root-b" }];
  const workspaceOrder = [
    { id: "root-b" },
    { id: "child-b", parentId: "root-b" },
    { id: "root-a" },
    { id: "root-c" },
  ];
  assert.deepEqual(
    orderBlockTermTerminalsByWorkspace(apiOrder, workspaceOrder).map((terminal) => terminal.id),
    ["root-b", "root-a", "root-c", "new"]
  );
});

test("rolls back only the latest mutation while its optimistic value is still current", () => {
  const optimistic = [{ id: "b" }, { id: "a" }];
  assert.equal(
    shouldRollbackBlockTermMutation({
      mutationVersion: 2,
      latestVersion: 2,
      currentValue: optimistic,
      optimisticValue: optimistic,
      equals: sameBlockTermOrder,
    }),
    true
  );
  assert.equal(
    shouldRollbackBlockTermMutation({
      mutationVersion: 1,
      latestVersion: 2,
      currentValue: optimistic,
      optimisticValue: optimistic,
      equals: sameBlockTermOrder,
    }),
    false
  );
  assert.equal(
    shouldRollbackBlockTermMutation({
      mutationVersion: 2,
      latestVersion: 2,
      currentValue: [{ id: "a" }, { id: "b" }],
      optimisticValue: optimistic,
      equals: sameBlockTermOrder,
    }),
    false
  );
});

test("compares normalized tab appearance before a conditional rollback", () => {
  assert.equal(
    sameBlockTermSessionSettings(
      { name: "Shell", tabColor: "", tabIcon: undefined },
      { name: "Shell", tabColor: "default", tabIcon: "default" }
    ),
    true
  );
  assert.equal(
    sameBlockTermSessionSettings(
      { name: "Shell", tabColor: "blue", tabIcon: "fire" },
      { name: "Shell", tabColor: "blue", tabIcon: "cloud" }
    ),
    false
  );
});
