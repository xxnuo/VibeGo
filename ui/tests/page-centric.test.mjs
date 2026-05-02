import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("page tasks preserve independent lifetimes, context and legacy sessions", async (t) => {
  const dom = new JSDOM("<div></div>", { url: "http://localhost" });
  const keys = ["window", "document", "localStorage", "sessionStorage"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true },
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, ws: false } });
  t.after(async () => {
    await vite.close(); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const load = (path) => vite.ssrLoadModule(`/src/${path}`);
  const { useFrameStore: frame } = await load("stores/frame-store.ts");
  const { inventoryFromFrame, frameFromInventory } = await load("stores/workspace-inventory.ts");
  const { normalizeSessionWorkspaceState } = await load("stores/session-store.ts");
  const { workspaceSnapshotState } = await load("stores/workspace-viewport.ts");
  const { getTerminalWorkspaceGroupIds } = await load("stores/session-workspace-guard.ts");
  const { registerPage, pageRegistry } = await load("pages/registry.ts");

  await t.test("a Git page without a repository shows onboarding instead of loading forever", async () => {
    const {getOrCreateGitStore} = await load("stores/git-store.ts");
    const store = getOrCreateGitStore("blank-git");
    assert.equal(store.getState().isRepo,null);
    store.getState().setCurrentPath("");
    assert.equal(await store.getState().checkRepo(),false);
    assert.equal(store.getState().isRepo,false);
  });
  await t.test("page context uses the path belonging to its own page type", async () => {
    const {getWorkspacePath} = await load("components/frame/workspace-hint-bubble.tsx");
    const task = {type:"tool", id:"context", name:"Context", pageId:"git", data:{cwd:"/shell",repoPath:"/repo",path:"/fallback"}};
    assert.equal(getWorkspacePath(task),"/repo");
    assert.equal(getWorkspacePath({...task,pageId:"terminal"}),"/shell");
    assert.equal(getWorkspacePath({...task,pageId:"extra"}),"/fallback");
  });
  await t.test("folder creation and late plugin registration never instantiate other pages", () => {
    frame.getState().initDefaultGroups(); frame.getState().addFolderGroup("/repo", "Repo", "files");
    registerPage({ id: "extra", name: "Extra", category: "workspace", View: () => null });
    assert.deepEqual(frame.getState().groups[0].pages.map((page) => page.type), ["files"]);
    assert.ok(pageRegistry.getMenus("new-page").some((item) => item.command === "page:extra"));
  });
  await t.test("independent instances retain paths and tabs after restore and closing their source", () => {
    const a = frame.getState().addTerminalGroup("/repo/subdir", "Shell", "files");
    const b = frame.getState().addTerminalGroup();
    const git = frame.getState().addGitGroup("/repo", "Repo Git", "files");
    frame.getState().addTab(git, { id: "diff", title: "Diff", data: { type: "diff", original: "a", modified: "b" } });
    const snapshot = { workspace: { id: "ws", name: "Workspace", revision: 1, data: "{}" },
      ...inventoryFromFrame(frame.getState().groups, "ws"), terminals: [], storage: [] };
    assert.equal(snapshot.folders.length, 1); assert.equal(snapshot.tools.length, 3);
    const restored = frameFromInventory(snapshot, []);
    assert.deepEqual([...getTerminalWorkspaceGroupIds(restored)], [a, b]);
    assert.equal(restored.find((group) => group.id === a).data.cwd, "/repo/subdir");
    assert.equal(restored.find((group) => group.id === b).data.cwd, undefined);
    assert.equal(restored.find((group) => group.id === git).tabs[0].data.modified, "b");
    frame.getState().removeGroup("files"); frame.getState().removeGroup(git);
    assert.ok(frame.getState().groups.some((group) => group.id === a));
    assert.ok(frame.getState().groups.some((group) => group.id === b));
  });
  await t.test("peer projections and refresh preserve an explicitly selected list view", () => {
    const id = frame.getState().addGitGroup("/repo");
    frame.getState().addTab(id, { id: "diff", title: "Diff" });
    frame.getState().setActiveTab(id, null);
    const snapshot = { workspace: { id: "focus", name: "Focus", revision: 1, data: "{}" }, ...inventoryFromFrame(frame.getState().groups,"focus"), terminals: [], storage: [] };
    const projected = frameFromInventory(snapshot, frame.getState().groups);
    assert.equal(projected.find(group => group.id === id).activeTabId, null);
    sessionStorage.setItem("vibego:viewport:focus", JSON.stringify({activeToolTabs:{[id]:null}}));
    assert.equal(workspaceSnapshotState(snapshot).openTools.find(group => group.id === id).activeTabId,null);
  });
  await t.test("legacy bundles retain tabs, terminal trees, selection and order", () => {
    const pages = ["files", "git", "terminal"].map((type) => ({ id: `old-${type}`, type, label: type, path: "/old",
      tabs: type === "git" ? [{ id: "diff", title: "Diff", data: { modified: "saved" } }] : [], activeTabId: type === "git" ? "diff" : null }));
    const state = normalizeSessionWorkspaceState({ openGroups: [{ id: "old", name: "Old", pages, activePageId: "old-git" }],
      taskbarOrder: ["group:old"], activeGroupId: "old", terminalsByGroup: { old: [{ id: "root", name: "Root" }, { id: "child", name: "Child", parentId: "root" }] },
      activeTerminalByGroup: { old: "root" }, focusedIdByGroup: { old: "child" }, terminalLayouts: { root: { type: "terminal", terminalId: "root" } } });
    assert.equal(state.openGroups.length, 1); assert.deepEqual(state.openGroups[0].pages.map((page) => page.type), ["files"]);
    assert.equal(state.openTools.length, 2); assert.equal(state.activeGroupId, "page:old:old-git");
    assert.equal(state.openTools[0].tabs[0].data.modified, "saved");
    assert.equal(state.terminalsByGroup["page:old:old-terminal"][1].parentId, "root");
    assert.equal(state.focusedIdByGroup["page:old:old-terminal"], "child");
    assert.deepEqual(state.taskbarOrder, ["group:old", "group:page:old:old-git", "group:page:old:old-terminal"]);
    assert.deepEqual(normalizeSessionWorkspaceState(state), state);
  });
  await t.test("migrated snapshots restore this device's legacy Git tab and terminal focus", () => {
    sessionStorage.setItem("vibego:viewport:ws", JSON.stringify({ activeGroupId: "old", activePages: { old: "g" }, activeTabs: { g: "diff" }, activeTerminalByGroup: { old: "pty" }, taskbarOrder: ["group:old"] }));
    const snapshot = { workspace: { id: "ws", name: "Workspace", revision: 2, data: "{}" }, folders: [], storage: [],
      tools: [
        { id: "git", page_id: "git", name: "Git", data: JSON.stringify({ repoPath: "/repo", sourceGroupId: "old", sourcePageId: "g" }) },
        { id: "term", page_id: "terminal", name: "Terminal", data: JSON.stringify({ cwd: "/repo", sourceGroupId: "old", sourcePageId: "t" }) }],
      tabs: [{ id: "diff", folder_id: "git", page_id: "", title: "Diff", data: "{}" }], terminals: [{ id: "pty", name: "Shell", group_id: "term", status: "running" }] };
    const state = workspaceSnapshotState(snapshot);
    assert.equal(state.activeGroupId, "git"); assert.equal(state.openTools[0].activeTabId, "diff");
    assert.equal(state.activeTerminalByGroup.term, "pty");
  });
});
