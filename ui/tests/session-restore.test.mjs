import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("workspace startup restores shared history without overriding local navigation", async (t) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const globals = ["window", "document", "localStorage", "sessionStorage", "WebSocket"];
  const original = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Socket {
    static OPEN = 1;
    readyState = 0;
    close() { this.readyState = 3; }
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "WebSocket" ? Socket : dom.window[key] });
  }
  const vite = await createServer({
    appType: "custom", configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  const load = (path) => vite.ssrLoadModule(`/src/${path}`);
  const { useSessionStore: sessions } = await load("stores/session-store.ts");
  const { useWorkspaceSyncStore: sync } = await load("stores/workspace-sync-store.ts");
  const { useFrameStore: frame } = await load("stores/frame-store.ts");
  const { sessionApi } = await load("api/session.ts");
  const { settingsApi } = await load("api/settings.ts");
  const { workspaceApi } = await load("api/workspace-sync.ts");
  const { terminalApi } = await load("api/terminal.ts");
  const localKey = "workspaceCurrentSessionId", sharedKey = "workspaceLastActiveSessionId";
  const list = [
    { id: "first", name: "First", updated_at: 10 },
    { id: "newest", name: "Newest", updated_at: 30 },
    { id: "active", name: "Active", updated_at: 20 },
  ];
  let sharedId, reads, writes;
  settingsApi.get = async (key) => { assert.equal(key, sharedKey); reads++; return { key, value: sharedId }; };
  settingsApi.set = async (key, value) => { assert.equal(key, sharedKey); sharedId = value; writes.push(value); return { ok: true }; };
  sessionApi.list = async () => ({ sessions: list, page: 1, page_size: 50, total: list.length });
  terminalApi.list = async () => ({ terminals: [] });
  workspaceApi.getSnapshot = async (id) => ({
    workspace: { id, name: id, revision: 1, data: "{}" },
    folders: [{ workspace_id: id, id: `${id}-folder`, name: id, path: `/${id}`, position: 0, data: "{}" }],
    tools: [], tabs: [], terminals: [], storage: [],
  });
  sessions.setState({ initAutoSave: () => {} });
  const reset = (localId, remoteId) => {
    sync.getState().disconnect();
    sessionStorage.clear();
    if (localId) sessionStorage.setItem(localKey, localId);
    sharedId = remoteId; reads = 0; writes = [];
    sessions.setState({ currentSessionId: null, sessions: [], loading: false, sessionInitialized: false, workspaceRevision: sessions.getState().workspaceRevision + 1 });
    frame.getState().initDefaultGroups();
  };
  t.after(async () => {
    sync.getState().disconnect(); await vite.close(); dom.window.close();
    for (const [key, value] of original) {
      if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
    }
  });

  await t.test("a fresh device opens the last selected workspace, regardless of list order", async () => {
    reset(null, "active");
    assert.equal(await sessions.getState().initSession(), true);
    assert.equal(sessions.getState().currentSessionId, "active");
    assert.equal(frame.getState().activeGroupId, "active-folder");
    assert.equal(sessionStorage.getItem(localKey), "active");
    assert.deepEqual(writes, ["active"]);
  });
  await t.test("a valid local workspace takes priority over a peer's selection", async () => {
    reset("first", "active");
    assert.equal(await sessions.getState().initSession(), true);
    assert.equal(sessions.getState().currentSessionId, "first");
    assert.equal(reads, 0);
    sharedId = "active";
    await sessions.getState().loadSessions();
    assert.equal(sessions.getState().currentSessionId, "first");
  });
  await t.test("deleted local and shared selections fall back to the latest existing workspace", async () => {
    reset("deleted-local", "deleted-peer");
    assert.equal(await sessions.getState().initSession(), true);
    assert.equal(sessions.getState().currentSessionId, "newest");
  });
  await t.test("a delayed shared lookup cannot replace a newer local navigation", async () => {
    reset(null, "active");
    const get = settingsApi.get;
    let resolve, started;
    const reading = new Promise((done) => { started = done; });
    settingsApi.get = () => new Promise((done) => { resolve = done; started(); });
    try {
      const pending = sessions.getState().initSession();
      await reading;
      sessions.getState().setCurrentSessionId("first");
      resolve({ value: "active" });
      assert.equal(await pending, false);
      assert.equal(sessions.getState().currentSessionId, "first");
    } finally { settingsApi.get = get; }
  });
  await t.test("slow shared writes preserve ordering without blocking local switches", { timeout: 2000 }, async () => {
    reset(null, "active");
    const set = settingsApi.set;
    let resolve;
    settingsApi.set = async (key, value) => {
      writes.push(value);
      if (value === "active") await new Promise((done) => { resolve = done; });
      sharedId = value;
      return { ok: true };
    };
    try {
      assert.equal(await sessions.getState().initSession(), true);
      await sessions.getState().switchSession("first");
      assert.equal(sessions.getState().currentSessionId, "first");
      assert.equal(sessionStorage.getItem(localKey), "first");
      assert.deepEqual(writes, ["active"]);
      resolve();
      await new Promise((done) => setTimeout(done, 0));
      assert.deepEqual(writes, ["active", "first"]);
      assert.equal(sharedId, "first");
    } finally { resolve?.(); settingsApi.set = set; }
  });
  await t.test("missing shared history and failed writes still restore and remember locally", async () => {
    reset(null, null);
    const get = settingsApi.get, set = settingsApi.set;
    const error = t.mock.method(console, "error", () => {});
    settingsApi.get = async () => { throw new Error("missing"); };
    settingsApi.set = async () => { throw new Error("offline"); };
    try {
      assert.equal(await sessions.getState().initSession(), true);
      assert.equal(sessions.getState().currentSessionId, "newest");
      assert.equal(sessionStorage.getItem(localKey), "newest");
    } finally { settingsApi.get = get; settingsApi.set = set; error.mock.restore(); }
  });
  await t.test("an empty workspace catalog stays on the home page", async () => {
    reset("deleted", "active");
    const list = sessionApi.list;
    sessionApi.list = async () => ({ sessions: [], total: 0 });
    try {
      assert.equal(await sessions.getState().initSession(), false);
      assert.equal(sessions.getState().currentSessionId, null);
      assert.equal(sessionStorage.getItem(localKey), null);
      assert.equal(reads, 0);
      assert.deepEqual(writes, []);
    } finally { sessionApi.list = list; }
  });
  await t.test("switching workspaces restores every split pane with its layout and focus", async () => {
    reset(null, "active");
    const { useTerminalStore: terminals } = await load("stores/terminal-store.ts");
    const getSnapshot = workspaceApi.getSnapshot, terminalList = terminalApi.list;
    const remoteTerminals = [
      { id: "root", name: "Root", workspace_session_id: "active", group_id: "shell", status: "running" },
      { id: "child", name: "Child", workspace_session_id: "active", group_id: "shell", parent_id: "root", status: "running" },
    ];
    workspaceApi.getSnapshot = async id => {
      const snapshot = await getSnapshot(id);
      if (id === "active") {
        snapshot.tools.push({ id: "shell", page_id: "terminal", name: "Shell", data: "{}" });
        snapshot.terminals = remoteTerminals;
      }
      return snapshot;
    };
    terminalApi.list = async ({ workspace_session_id: id } = {}) => ({ terminals: id === "active" ? remoteTerminals : [] });
    const close = t.mock.method(terminalApi, "close", async () => { throw new Error("workspace switch must keep PTYs alive"); });
    try {
      assert.equal(await sessions.getState().initSession(), true);
      terminals.getState().setActiveId("shell", "root");
      terminals.getState().setTerminalLayout("root", {
        type: "split", direction: "vertical", ratio: 0.3,
        first: { type: "terminal", terminalId: "root" },
        second: { type: "terminal", terminalId: "child" },
      });
      terminals.getState().setFocusedId("shell", "child");
      frame.getState().setActiveGroup("shell");
      const layout = structuredClone(terminals.getState().getActiveLayout("shell"));
      await sessions.getState().switchSession("first");
      assert.equal(sessions.getState().currentSessionId, "first");
      assert.deepEqual(terminals.getState().getTerminals("shell"), []);
      await sessions.getState().switchSession("active");
      assert.equal(sessions.getState().currentSessionId, "active");
      assert.equal(frame.getState().activeGroupId, "shell");
      assert.deepEqual(terminals.getState().getTerminals("shell").map(terminal => terminal.id), ["root", "child"]);
      assert.deepEqual(terminals.getState().getActiveLayout("shell"), layout);
      assert.equal(terminals.getState().focusedIdByGroup.shell, "child");
      assert.equal(close.mock.callCount(), 0);
    } finally { workspaceApi.getSnapshot = getSnapshot; terminalApi.list = terminalList; close.mock.restore(); }
  });
});
