import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  server: { hmr: false, middlewareMode: true },
});

const terminalApiModule = await vite.ssrLoadModule("/src/api/terminal.ts");
const terminalStoreModule = await vite.ssrLoadModule("/src/stores/terminal-store.ts");
const sessionApiModule = await vite.ssrLoadModule("/src/api/session.ts");
const sessionStoreModule = await vite.ssrLoadModule("/src/stores/session-store.ts");
const frameStoreModule = await vite.ssrLoadModule("/src/stores/frame-store.ts");

const terminalApi = terminalApiModule.terminalApi;
const terminalStore = terminalStoreModule.useTerminalStore;
const sessionApi = sessionApiModule.sessionApi;
const sessionStore = sessionStoreModule.useSessionStore;
const frameStore = frameStoreModule.useFrameStore;
const normalizeSessionWorkspaceState = sessionStoreModule.normalizeSessionWorkspaceState;

test.after(async () => {
  await vite.close();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function terminal(id, extra = {}) {
  return { id, name: id, ...extra };
}

function seedTerminalStore(groups) {
  terminalStore.getState().reset();
  terminalStore.setState({
    terminalsByGroup: groups,
    activeIdByGroup: Object.fromEntries(
      Object.entries(groups).map(([groupId, terminals]) => [groupId, terminals[0]?.id || null])
    ),
    listManagerOpenByGroup: Object.fromEntries(Object.keys(groups).map((groupId) => [groupId, false])),
    terminalLayouts: {},
    focusedIdByGroup: Object.fromEntries(
      Object.entries(groups).map(([groupId, terminals]) => [groupId, terminals[0]?.id || null])
    ),
  });
}

function seedSessionStore(sessions, currentSessionId = null) {
  sessionStore.setState({
    currentSessionId,
    currentWorkspaceNameOverride: null,
    sessions,
    loading: false,
    sessionsLoading: false,
    sessionInitialized: true,
    workspaceRevision: 0,
    error: null,
  });
}

function seedBlockTermFrame(groupId) {
  frameStore.setState({
    groups: [
      {
        type: "tool",
        id: groupId,
        name: "BlockTerm",
        pageId: "blockterm",
        tabs: [],
        activeTabId: null,
      },
    ],
    activeGroupId: groupId,
    taskbarOrder: [groupId],
  });
}

function remoteTerminal(id, groupId, extra = {}) {
  return {
    id,
    name: id,
    group_id: groupId,
    parent_id: "",
    status: "running",
    ...extra,
  };
}

function session(id, position, name = id) {
  return {
    id,
    user_id: "user-1",
    name,
    position,
    created_at: position,
    updated_at: position,
  };
}

test("local terminal reorder is optimistic without creating durable mutation bookkeeping", async () => {
  seedTerminalStore({ group: [terminal("a"), terminal("b")] });
  const original = terminalApi.syncWorkspace;
  let calls = 0;
  terminalApi.syncWorkspace = async () => {
    calls += 1;
    return { ok: true };
  };
  try {
    assert.equal(await terminalStore.getState().reorderTerminalPages("group", "a", "b"), true);
    assert.deepEqual(
      terminalStore.getState().getTerminals("group").map((item) => item.id),
      ["b", "a"]
    );
    assert.equal(calls, 0);
  } finally {
    terminalApi.syncWorkspace = original;
  }
});

test("terminal reorder keeps the latest optimistic order while an earlier request fails", async () => {
  seedTerminalStore({ group: [terminal("a"), terminal("b"), terminal("c")] });
  const original = terminalApi.syncWorkspace;
  const first = deferred();
  const second = deferred();
  const calls = [];
  terminalApi.syncWorkspace = (...args) => {
    calls.push(args);
    return calls.length === 1 ? first.promise : second.promise;
  };
  try {
    const firstMutation = terminalStore.getState().reorderTerminalPages("group", "a", "c", {
      workspaceSessionId: "workspace-1",
    });
    const secondMutation = terminalStore.getState().reorderTerminalPages("group", "c", "b", {
      workspaceSessionId: "workspace-1",
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      terminalStore.getState().getTerminals("group").map((item) => item.id),
      ["c", "b", "a"]
    );

    first.reject(new Error("first failed"));
    assert.equal(await firstMutation, false);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 2);

    second.reject(new Error("second failed"));
    await assert.rejects(secondMutation, /second failed/);
    assert.deepEqual(
      terminalStore.getState().getTerminals("group").map((item) => item.id),
      ["a", "b", "c"]
    );
  } finally {
    terminalApi.syncWorkspace = original;
    terminalStore.getState().reset();
  }
});

test("terminal reorder rolls back to the first confirmed order when only the latest request fails", async () => {
  seedTerminalStore({ group: [terminal("a"), terminal("b"), terminal("c")] });
  const original = terminalApi.syncWorkspace;
  const first = deferred();
  const second = deferred();
  let calls = 0;
  terminalApi.syncWorkspace = () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };
  try {
    const firstMutation = terminalStore.getState().reorderTerminalPages("group", "a", "c", {
      workspaceSessionId: "workspace-2",
    });
    const secondMutation = terminalStore.getState().reorderTerminalPages("group", "c", "b", {
      workspaceSessionId: "workspace-2",
    });
    await Promise.resolve();
    await Promise.resolve();
    first.resolve({ ok: true });
    assert.equal(await firstMutation, true);
    await Promise.resolve();
    await Promise.resolve();
    second.reject(new Error("latest failed"));
    await assert.rejects(secondMutation, /latest failed/);
    assert.deepEqual(
      terminalStore.getState().getTerminals("group").map((item) => item.id),
      ["b", "c", "a"]
    );
  } finally {
    terminalApi.syncWorkspace = original;
    terminalStore.getState().reset();
  }
});

test("terminal reorder rollback preserves metadata updates made while the request is pending", async () => {
  seedTerminalStore({ group: [terminal("a", { tabColor: "red" }), terminal("b")] });
  const original = terminalApi.syncWorkspace;
  const request = deferred();
  terminalApi.syncWorkspace = () => request.promise;
  try {
    const mutation = terminalStore.getState().reorderTerminalPages("group", "a", "b", {
      workspaceSessionId: "workspace-3",
    });
    await Promise.resolve();
    terminalStore.getState().updateTerminal("group", "a", {
      name: "renamed",
      tabColor: "cyan",
      tabIcon: "sparkle",
      status: "exited",
    });
    request.reject(new Error("sync failed"));
    await assert.rejects(mutation, /sync failed/);
    const current = terminalStore.getState().getTerminals("group");
    assert.deepEqual(current.map((item) => item.id), ["a", "b"]);
    assert.deepEqual(current[0], {
      id: "a",
      name: "renamed",
      tabColor: "cyan",
      tabIcon: "sparkle",
      status: "exited",
    });
  } finally {
    terminalApi.syncWorkspace = original;
    terminalStore.getState().reset();
  }
});

test("terminal reorder sync includes every group and split child in the workspace inventory", async () => {
  seedTerminalStore({
    first: [terminal("a"), terminal("a-child", { parentId: "a" }), terminal("c")],
    second: [terminal("b")],
  });
  const original = terminalApi.syncWorkspace;
  let payload;
  terminalApi.syncWorkspace = async (...args) => {
    payload = args;
    return { ok: true };
  };
  try {
    await terminalStore.getState().reorderTerminalPages("first", "a", "c", {
      workspaceSessionId: "workspace-4",
    });
    assert.deepEqual(
      payload[1].map((item) => [item.id, item.group_id, item.parent_id || null]),
      [
        ["c", "first", null],
        ["a", "first", null],
        ["a-child", "first", "a"],
        ["b", "second", null],
      ]
    );
    assert.deepEqual(payload[2].terminalsByGroup.first.map((item) => item.id), ["c", "a", "a-child"]);
    assert.deepEqual(payload[2].terminalsByGroup.second.map((item) => item.id), ["b"]);
  } finally {
    terminalApi.syncWorkspace = original;
    terminalStore.getState().reset();
  }
});

test("terminal reorders serialize per workspace without committing another group's optimistic order", async () => {
  seedTerminalStore({
    first: [terminal("a"), terminal("b")],
    second: [terminal("x"), terminal("y")],
  });
  const original = terminalApi.syncWorkspace;
  const first = deferred();
  const second = deferred();
  const calls = [];
  terminalApi.syncWorkspace = (...args) => {
    calls.push(args);
    return calls.length === 1 ? first.promise : second.promise;
  };
  try {
    const firstMutation = terminalStore.getState().reorderTerminalPages("first", "a", "b", {
      workspaceSessionId: "workspace-shared",
    });
    const secondMutation = terminalStore.getState().reorderTerminalPages("second", "x", "y", {
      workspaceSessionId: "workspace-shared",
    });
    const secondRejection = assert.rejects(secondMutation, /second failed/);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][2].terminalsByGroup.first.map((item) => item.id), ["b", "a"]);
    assert.deepEqual(calls[0][2].terminalsByGroup.second.map((item) => item.id), ["x", "y"]);

    first.resolve({ ok: true });
    assert.equal(await firstMutation, true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1][2].terminalsByGroup.first.map((item) => item.id), ["b", "a"]);
    assert.deepEqual(calls[1][2].terminalsByGroup.second.map((item) => item.id), ["y", "x"]);

    second.reject(new Error("second failed"));
    await secondRejection;
    assert.deepEqual(terminalStore.getState().getTerminals("first").map((item) => item.id), ["b", "a"]);
    assert.deepEqual(terminalStore.getState().getTerminals("second").map((item) => item.id), ["x", "y"]);
  } finally {
    terminalApi.syncWorkspace = original;
    terminalStore.getState().reset();
  }
});

test("terminal reset keeps a new same-workspace sync behind an already-issued stale request", async () => {
  seedTerminalStore({ group: [terminal("old-a"), terminal("old-b")] });
  const original = terminalApi.syncWorkspace;
  const stale = deferred();
  const current = deferred();
  const calls = [];
  terminalApi.syncWorkspace = (...args) => {
    calls.push(args);
    return calls.length === 1 ? stale.promise : current.promise;
  };
  try {
    const staleMutation = terminalStore.getState().reorderTerminalPages("group", "old-a", "old-b", {
      workspaceSessionId: "workspace-reset",
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 1);

    seedTerminalStore({ group: [terminal("new-a"), terminal("new-b")] });
    const currentMutation = terminalStore.getState().reorderTerminalPages("group", "new-a", "new-b", {
      workspaceSessionId: "workspace-reset",
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 1);

    stale.resolve({ ok: true });
    assert.equal(await staleMutation, false);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1][1].map((item) => item.id), ["new-b", "new-a"]);

    current.resolve({ ok: true });
    assert.equal(await currentMutation, true);
    assert.deepEqual(terminalStore.getState().getTerminals("group").map((item) => item.id), ["new-b", "new-a"]);
  } finally {
    terminalApi.syncWorkspace = original;
    terminalStore.getState().reset();
  }
});

test("terminal refresh preserves a pending optimistic reorder", async () => {
  seedBlockTermFrame("group");
  seedTerminalStore({ group: [terminal("a"), terminal("b"), terminal("c")] });
  seedSessionStore([session("workspace-refresh", 1)], "workspace-refresh");
  const originalList = terminalApi.list;
  const originalSync = terminalApi.syncWorkspace;
  const list = deferred();
  const sync = deferred();
  terminalApi.list = () => list.promise;
  terminalApi.syncWorkspace = () => sync.promise;
  try {
    const refresh = sessionStore.getState().refreshCurrentSession();
    const reorder = terminalStore.getState().reorderTerminalPages("group", "a", "c", {
      workspaceSessionId: "workspace-refresh",
    });
    list.resolve({
      terminals: [remoteTerminal("a", "group"), remoteTerminal("b", "group"), remoteTerminal("c", "group")],
    });
    await refresh;
    assert.deepEqual(terminalStore.getState().getTerminals("group").map((item) => item.id), ["b", "c", "a"]);

    sync.resolve({ ok: true });
    assert.equal(await reorder, true);
  } finally {
    terminalApi.list = originalList;
    terminalApi.syncWorkspace = originalSync;
    terminalStore.getState().reset();
  }
});

test("terminal refresh clears a stale local parent when the API returns an empty parent_id", async () => {
  seedBlockTermFrame("group");
  seedTerminalStore({ group: [terminal("root"), terminal("child", { parentId: "root" })] });
  seedSessionStore([session("workspace-parent", 1)], "workspace-parent");
  const original = terminalApi.list;
  terminalApi.list = async () => ({
    terminals: [remoteTerminal("root", "group"), remoteTerminal("child", "group")],
  });
  try {
    await sessionStore.getState().refreshCurrentSession();
    assert.equal(
      terminalStore.getState().getTerminals("group").find((item) => item.id === "child")?.parentId,
      undefined
    );
  } finally {
    terminalApi.list = original;
    terminalStore.getState().reset();
  }
});

test("session reorder rolls back both failed optimistic mutations to the confirmed order", async () => {
  seedSessionStore([session("a", 1), session("b", 2), session("c", 3)]);
  const original = sessionApi.reorder;
  const first = deferred();
  const second = deferred();
  let calls = 0;
  sessionApi.reorder = () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };
  try {
    const firstMutation = sessionStore.getState().reorderSessions(["b", "c", "a"]);
    const secondMutation = sessionStore.getState().reorderSessions(["c", "b", "a"]);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(sessionStore.getState().sessions.map((item) => item.id), ["c", "b", "a"]);

    first.reject(new Error("first session failure"));
    assert.equal(await firstMutation, false);
    await Promise.resolve();
    await Promise.resolve();
    second.reject(new Error("second session failure"));
    await assert.rejects(secondMutation, /second session failure/);
    assert.deepEqual(sessionStore.getState().sessions.map((item) => item.id), ["a", "b", "c"]);
  } finally {
    sessionApi.reorder = original;
  }
});

test("session list refresh does not replace a pending optimistic reorder", async () => {
  seedSessionStore([session("a", 1), session("b", 2), session("c", 3)]);
  const originalReorder = sessionApi.reorder;
  const originalList = sessionApi.list;
  const request = deferred();
  sessionApi.reorder = () => request.promise;
  sessionApi.list = async () => ({
    sessions: [session("a", 1), session("b", 2), session("c", 3)],
    page: 1,
    page_size: 50,
    total: 3,
  });
  try {
    const mutation = sessionStore.getState().reorderSessions(["c", "a", "b"]);
    await sessionStore.getState().loadSessions();
    assert.deepEqual(sessionStore.getState().sessions.map((item) => item.id), ["c", "a", "b"]);
    request.resolve({ ok: true });
    assert.equal(await mutation, true);
  } finally {
    sessionApi.reorder = originalReorder;
    sessionApi.list = originalList;
  }
});

test("two failed session renames roll back to the last confirmed name and both reject", async () => {
  seedSessionStore([session("workspace-rename", 1, "Original")], "workspace-rename");
  const original = sessionApi.update;
  const first = deferred();
  const second = deferred();
  let calls = 0;
  sessionApi.update = () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };
  try {
    const firstMutation = sessionStore.getState().renameSession("workspace-rename", "First");
    const secondMutation = sessionStore.getState().renameSession("workspace-rename", "Second");
    const firstRejection = assert.rejects(firstMutation, /first failed/);
    const secondRejection = assert.rejects(secondMutation, /second failed/);
    first.reject(new Error("first failed"));
    await firstRejection;
    second.reject(new Error("second failed"));
    await secondRejection;
    assert.equal(sessionStore.getState().sessions[0].name, "Original");
    assert.equal(sessionStore.getState().currentWorkspaceNameOverride, null);
  } finally {
    sessionApi.update = original;
  }
});

test("a failed rename followed by a successful rename keeps the successful value", async () => {
  seedSessionStore([session("workspace-rename", 1, "Original")], "workspace-rename");
  const original = sessionApi.update;
  const first = deferred();
  const second = deferred();
  let calls = 0;
  sessionApi.update = () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };
  try {
    const firstMutation = sessionStore.getState().renameSession("workspace-rename", "First");
    const secondMutation = sessionStore.getState().renameSession("workspace-rename", "Second");
    const firstRejection = assert.rejects(firstMutation, /first failed/);
    first.reject(new Error("first failed"));
    await firstRejection;
    second.resolve({ ok: true });
    await secondMutation;
    assert.equal(sessionStore.getState().sessions[0].name, "Second");
    assert.equal(sessionStore.getState().currentWorkspaceNameOverride, "Second");
  } finally {
    sessionApi.update = original;
  }
});

test("a failed latest rename rolls back to the preceding successful rename", async () => {
  seedSessionStore([session("workspace-rename", 1, "Original")], "workspace-rename");
  const original = sessionApi.update;
  const first = deferred();
  const second = deferred();
  let calls = 0;
  sessionApi.update = () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };
  try {
    const firstMutation = sessionStore.getState().renameSession("workspace-rename", "First");
    const secondMutation = sessionStore.getState().renameSession("workspace-rename", "Second");
    const secondRejection = assert.rejects(secondMutation, /second failed/);
    first.resolve({ ok: true });
    await firstMutation;
    second.reject(new Error("second failed"));
    await secondRejection;
    assert.equal(sessionStore.getState().sessions[0].name, "First");
    assert.equal(sessionStore.getState().currentWorkspaceNameOverride, "First");
  } finally {
    sessionApi.update = original;
  }
});

test("session list refresh preserves a pending optimistic rename", async () => {
  seedSessionStore([session("workspace-rename", 1, "Original")], "workspace-rename");
  const originalUpdate = sessionApi.update;
  const originalList = sessionApi.list;
  const request = deferred();
  sessionApi.update = () => request.promise;
  sessionApi.list = async () => ({
    sessions: [session("workspace-rename", 1, "Original")],
    page: 1,
    page_size: 50,
    total: 1,
  });
  try {
    const mutation = sessionStore.getState().renameSession("workspace-rename", "Optimistic");
    await sessionStore.getState().loadSessions();
    assert.equal(sessionStore.getState().sessions[0].name, "Optimistic");
    request.resolve({ ok: true });
    await mutation;
  } finally {
    sessionApi.update = originalUpdate;
    sessionApi.list = originalList;
  }
});

test("legacy workspace state without newly added fields is normalized before restore", () => {
  const normalized = normalizeSessionWorkspaceState({});
  assert.equal(normalized.workspaceNameOverride, null);
  assert.deepEqual(normalized.openGroups, []);
  assert.deepEqual(normalized.openTools, []);
  assert.deepEqual(normalized.terminalsByGroup, {});
  assert.deepEqual(normalized.fileManagerByGroup, {});
});

test("session save patch carries a manual workspace name override", async () => {
  seedSessionStore([session("workspace-1", 1, "Manual")], "workspace-1");
  sessionStore.setState({ currentWorkspaceNameOverride: "Manual" });
  const originalPatch = sessionApi.patchWorkspace;
  const originalSync = terminalApi.syncWorkspace;
  let patch;
  sessionApi.patchWorkspace = async (_id, body) => {
    patch = body;
    return { ok: true };
  };
  terminalApi.syncWorkspace = async () => ({ ok: true });
  try {
    await sessionStore.getState().saveCurrentSession();
    assert.equal(patch.workspaceNameOverride, "Manual");
  } finally {
    sessionApi.patchWorkspace = originalPatch;
    terminalApi.syncWorkspace = originalSync;
  }
});
