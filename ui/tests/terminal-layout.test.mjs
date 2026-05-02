import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTerminalWorkspace, layoutTerminalIds, pruneTerminalLayout, balanceTerminalLayout, terminalLayoutRects, clampSplitRatio } from "../src/stores/terminal-layout.ts";

const leaf = id => ({ type: "terminal", terminalId: id });
const split = (a, b, direction = "horizontal", ratio = 0.5) => ({ type: "split", direction, ratio, first: a, second: b });
const state = (inventory, layout = split(leaf("root"), split(leaf("a"), leaf("b"), "vertical", .7))) => ({
  terminalsByGroup: { shell: inventory }, activeTerminalByGroup: { shell: "root" }, focusedIdByGroup: { shell: "a" },
  terminalLayouts: { root: layout }, listManagerOpenByGroup: { shell: false },
});
const inventory = () => [
  { id: "root", name: "Root", status: "running" },
  { id: "a", name: "A", parentId: "root", status: "running" },
  { id: "b", name: "B", parentId: "root", status: "running" },
];
const normalizeAgain = (next, id, status) => normalizeTerminalWorkspace({ ...next,
  terminalsByGroup: { shell: next.terminalsByGroup.shell.map(item => item.id === id ? { ...item, status } : item) },
});

test("every order of pane exits collapses the tree, promotes a survivor and finally opens the list", () => {
  for (const order of [["root", "a", "b"], ["a", "root", "b"], ["b", "a", "root"], ["root", "b", "a"], ["a", "b", "root"], ["b", "root", "a"]]) {
    let next = normalizeTerminalWorkspace(state(inventory()));
    for (const [index, id] of order.entries()) {
      next = normalizeAgain(next, id, "exited");
      const panes = next.terminalsByGroup.shell;
      assert.equal(panes.length, 2 - index);
      assert.ok(!panes.some(item => item.id === id));
      assert.deepEqual(normalizeTerminalWorkspace(next), next, "normalization is idempotent");
      if (panes.length) {
        const root = panes.find(item => !item.parentId);
        assert.ok(root);
        assert.equal(next.activeTerminalByGroup.shell, root.id);
        assert.deepEqual(new Set(layoutTerminalIds(next.terminalLayouts[root.id])), new Set(panes.map(item => item.id)));
        assert.ok(panes.some(item => item.id === next.focusedIdByGroup.shell));
      } else {
        assert.equal(next.activeTerminalByGroup.shell, null);
        assert.equal(next.focusedIdByGroup.shell, null);
        assert.equal(next.listManagerOpenByGroup.shell, true);
        assert.deepEqual(next.terminalLayouts, {});
      }
    }
  }
});

test("refresh reconstructs nested server ancestry after the root has exited and another split was created", () => {
  const rows = inventory();
  rows[0].status = "exited";
  rows.push({ id: "c", name: "C", parentId: "a", status: "running" });
  const next = normalizeTerminalWorkspace(state(rows));
  assert.equal(next.terminalsByGroup.shell.length, 3);
  assert.equal(next.terminalsByGroup.shell.filter(item => !item.parentId).length, 1);
  assert.deepEqual(next.terminalLayouts.a.first.first, leaf("a"));
  assert.ok(next.terminalsByGroup.shell.every(item => item.splitGroupId === "root"));
  const after = normalizeAgain(next, "a", "closed");
  assert.equal(after.activeTerminalByGroup.shell, "b");
  assert.deepEqual(layoutTerminalIds(after.terminalLayouts.b), ["b", "c"]);
});

test("independent exited tabs retain replay while exited split panes only remain in history", () => {
  const rows = inventory().map(item => ({ ...item, status: "exited" }));
  rows.push({ id: "standalone", name: "Standalone", status: "exited" });
  const next = normalizeTerminalWorkspace(state(rows));
  assert.deepEqual(next.terminalsByGroup.shell.map(item => item.id), ["standalone"]);
  assert.deepEqual(new Set(next.retiredTerminalIds), new Set(["root", "a", "b"]));
  assert.deepEqual(next.terminalLayouts.standalone, leaf("standalone"));
});

test("pruning a nested tree keeps its proportions and removes duplicate, stale and foreign leaves", () => {
  const tree = split(split(leaf("root"), leaf("a"), "vertical", .3), split(leaf("a"), leaf("foreign")));
  assert.deepEqual(pruneTerminalLayout(tree, new Set(["root", "a"])), split(leaf("root"), leaf("a"), "vertical", .3));
  assert.equal(pruneTerminalLayout(tree, new Set()), null);
  assert.equal(clampSplitRatio(NaN), .5);
  assert.equal(clampSplitRatio(-1), .1);
  assert.equal(clampSplitRatio(2), .9);
});

test("different tabs and groups never share leaves or focus", () => {
  const source = state(inventory());
  source.terminalsByGroup.shell.push({ id: "other", name: "Other", status: "running" });
  source.terminalsByGroup.second = [{ id: "remote", name: "Remote", status: "running" }];
  source.terminalLayouts.root = split(leaf("root"), split(leaf("remote"), split(leaf("a"), leaf("b"))));
  const next = normalizeTerminalWorkspace(source, new Set(["shell"]));
  assert.deepEqual(Object.keys(next.terminalsByGroup), ["shell"]);
  assert.deepEqual(new Set(layoutTerminalIds(next.terminalLayouts.root)), new Set(["root", "a", "b"]));
  assert.deepEqual(next.terminalLayouts.other, leaf("other"));
});

test("missing parents and legacy cycles yield one recoverable tab instead of infinite traversal", () => {
  for (const rows of [
    [{ id: "a", parentId: "missing" }, { id: "b", parentId: "missing" }],
    [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }],
  ]) {
    const next = normalizeTerminalWorkspace(state(rows, leaf("a")));
    assert.equal(next.terminalsByGroup.shell.filter(item => !item.parentId).length, 1);
    assert.equal(Object.keys(next.terminalLayouts).length, 1);
    assert.deepEqual(new Set(layoutTerminalIds(Object.values(next.terminalLayouts)[0])), new Set(["a", "b"]));
  }
});

test("balanced layouts allocate equal area and mobile stacking does not mutate the saved direction", () => {
  const tree = split(leaf("root"), split(leaf("a"), leaf("b"), "horizontal"));
  const balanced = balanceTerminalLayout(tree);
  assert.equal(balanced.ratio, 1 / 3);
  const desktop = terminalLayoutRects(balanced);
  for (const pane of desktop.panes) assert.ok(Math.abs(pane.width * pane.height - 1 / 3) < 1e-10);
  const mobile = terminalLayoutRects(balanced, true);
  for (const pane of mobile.panes) assert.equal(pane.width, 1);
  assert.equal(balanced.direction, "horizontal");
  assert.equal(mobile.dividers.length, 2);
  assert.deepEqual(mobile.dividers[1].path, [1]);
});

test("a saved active anchor remains on its split tab after history deletion and reload", () => {
  const rows = [
    { id: "a", name: "A", parentId: "deleted-root", splitGroupId: "deleted-root", status: "running" },
    { id: "b", name: "B", parentId: "a", splitGroupId: "deleted-root", status: "running" },
  ];
  const source = state(rows, split(leaf("a"), leaf("b"), "vertical", .65));
  source.activeTerminalByGroup.shell = "deleted-root";
  const next = normalizeTerminalWorkspace(source);
  assert.equal(next.activeTerminalByGroup.shell, "a");
  assert.equal(next.listManagerOpenByGroup.shell, false);
  assert.equal(next.terminalLayouts.a.ratio, .65);
});

test("exiting a focused nested pane focuses its adjacent sibling", () => {
  const next = normalizeTerminalWorkspace(state(inventory()));
  const after = normalizeAgain(next, "a", "exited");
  assert.equal(after.focusedIdByGroup.shell, "b");
  assert.equal(after.activeTerminalByGroup.shell, "root");
});

test("closing the last pane selects the next tab without stealing focus from other groups", () => {
  const source = state([
    { id: "root", name: "Root", splitGroupId: "root", status: "running" },
    { id: "next", name: "Next", status: "running" },
  ], leaf("root"));
  source.focusedIdByGroup.shell = "root";
  const after = normalizeAgain(normalizeTerminalWorkspace(source), "root", "exited");
  assert.equal(after.activeTerminalByGroup.shell, "next");
  assert.equal(after.focusedIdByGroup.shell, "next");
  assert.equal(after.listManagerOpenByGroup.shell, false);
});
