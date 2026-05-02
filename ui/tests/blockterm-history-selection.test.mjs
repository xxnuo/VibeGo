import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("BlockTerm history selection is bounded and toggles loaded results", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { toggleBlockTermHistorySelection, toggleAllLoadedBlockTermHistory } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-history-selection.ts"
  );
  const entries = [{ id: "one" }, { id: "two" }, { id: "three" }];

  let result = toggleBlockTermHistorySelection(new Set(), "one", 2);
  assert.deepEqual([...result.selection], ["one"]);
  assert.equal(result.limitExceeded, false);

  result = toggleBlockTermHistorySelection(result.selection, "two", 2);
  result = toggleBlockTermHistorySelection(result.selection, "three", 2);
  assert.deepEqual([...result.selection], ["one", "two"]);
  assert.equal(result.limitExceeded, true);

  result = toggleBlockTermHistorySelection(result.selection, "one", 2);
  assert.deepEqual([...result.selection], ["two"]);
  assert.equal(result.limitExceeded, false);

  result = toggleAllLoadedBlockTermHistory(entries.slice(0, 2), new Set(), 2);
  assert.deepEqual([...result.selection], ["one", "two"]);
  result = toggleAllLoadedBlockTermHistory(entries.slice(0, 2), result.selection, 2);
  assert.deepEqual([...result.selection], []);

  result = toggleAllLoadedBlockTermHistory(entries, new Set(["one"]), 2);
  assert.deepEqual([...result.selection], ["one"]);
  assert.equal(result.limitExceeded, true);
});

test("BlockTerm history activation waits for the target inventory to hydrate", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const {
    canSettleBlockTermHistoryActivation,
    resolveBlockTermHistoryActivationState,
    shouldCancelBlockTermHistoryActivationForSession,
  } = await vite.ssrLoadModule("/src/components/terminal/blockterm-history-selection.ts");

  assert.equal(canSettleBlockTermHistoryActivation([], "block-1", false), false);
  assert.equal(canSettleBlockTermHistoryActivation([{ id: "block-1" }], "block-1", false), true);
  assert.equal(canSettleBlockTermHistoryActivation([], "block-1", true), true);
  assert.equal(
    resolveBlockTermHistoryActivationState([], "block-1", false, "terminal-1", "terminal-1", 4, 5),
    "discard"
  );
  assert.equal(
    resolveBlockTermHistoryActivationState([], "block-1", false, "terminal-1", "terminal-1", 5, 5),
    "wait"
  );
  assert.equal(
    resolveBlockTermHistoryActivationState(
      [{ id: "block-1" }],
      "block-1",
      false,
      "terminal-1",
      "terminal-2",
      5,
      5
    ),
    "wait"
  );
  assert.equal(
    resolveBlockTermHistoryActivationState(
      [{ id: "block-1" }],
      "block-1",
      false,
      "terminal-1",
      "terminal-1",
      5,
      5
    ),
    "settle"
  );
  assert.equal(
    resolveBlockTermHistoryActivationState([], "block-1", true, "terminal-1", "terminal-1", 5, 5),
    "settle"
  );
  assert.equal(shouldCancelBlockTermHistoryActivationForSession("terminal-1", "terminal-1", 5, 5), false);
  assert.equal(shouldCancelBlockTermHistoryActivationForSession("terminal-1", "terminal-2", 5, 5), true);
  assert.equal(shouldCancelBlockTermHistoryActivationForSession("terminal-1", "terminal-1", 4, 5), true);
});

test("BlockTerm history navigation survives the source view unmount and settles in the target workspace", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { activateBlockTermHistoryTarget } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-history-navigation.ts"
  );
  const {
    clearBlockTermHistoryActivation,
    getBlockTermHistoryActivationRequest,
    resolveBlockTermHistoryActivationState,
    subscribeBlockTermHistoryActivation,
  } = await vite.ssrLoadModule("/src/components/terminal/blockterm-history-selection.ts");
  const { BlockTermWorkspaceNavigationCoordinator } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-workspace-navigation.ts"
  );
  t.after(() => clearBlockTermHistoryActivation());

  const entry = {
    id: "block-b",
    terminalId: "terminal-b",
    workspaceSessionId: "workspace-b",
    groupId: "group-b",
    runtimeType: "local",
    command: "echo target",
    cwd: "/work",
    createdAt: 1,
    starred: false,
  };
  const target = {
    id: "target-b",
    workspaceId: "workspace-b",
    workspaceName: "Workspace B",
    workspaceOrder: 1,
    groupId: "group-b",
    groupOrder: 0,
    tabId: "terminal-b",
    tabName: "Terminal B",
    tabOrder: 0,
  };
  const sessionState = {
    currentSessionId: "workspace-a",
    loading: false,
    sessionInitialized: true,
  };
  const frameState = {
    groups: [{ type: "tool", id: "group-b", name: "BlockTerm", pageId: "blockterm", tabs: [], activeTabId: null }],
    activeGroupId: null,
  };
  const terminalState = {
    terminalsByGroup: { "group-b": [{ id: "terminal-b", name: "Terminal B" }] },
    activeIdByGroup: { "group-b": null },
  };
  let sourceMounted = true;
  const unsubscribe = subscribeBlockTermHistoryActivation(() => {});
  const dependencies = {
    switchSession: async (workspaceId) => {
      sourceMounted = false;
      unsubscribe();
      sessionState.currentSessionId = workspaceId;
      sessionState.loading = false;
      sessionState.sessionInitialized = true;
    },
    getSessionState: () => sessionState,
    getFrameState: () => frameState,
    getTerminalState: () => terminalState,
    setActiveTerminal: (groupId, terminalId) => {
      terminalState.activeIdByGroup[groupId] = terminalId;
    },
    setActiveGroup: (groupId) => {
      frameState.activeGroupId = groupId;
    },
  };

  const result = await activateBlockTermHistoryTarget(
    entry,
    target,
    new BlockTermWorkspaceNavigationCoordinator(),
    dependencies
  );
  assert.equal(sourceMounted, false);
  assert.equal(result.status, "activated");
  assert.equal(sessionState.currentSessionId, "workspace-b");
  assert.equal(frameState.activeGroupId, "group-b");
  assert.equal(terminalState.activeIdByGroup["group-b"], "terminal-b");
  const activationRequest = getBlockTermHistoryActivationRequest();
  assert.equal(activationRequest?.entry.id, "block-b");
  assert.equal(activationRequest?.workspaceSessionId, "workspace-b");
  assert.equal(
    resolveBlockTermHistoryActivationState(
      [{ id: "block-b" }],
      "block-b",
      true,
      "terminal-b",
      terminalState.activeIdByGroup["group-b"],
      2,
      2
    ),
    "settle"
  );
  clearBlockTermHistoryActivation(activationRequest.requestId);
  assert.equal(getBlockTermHistoryActivationRequest(), null);
});

test("BlockTerm history navigation clears activation when the target disappears", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { activateBlockTermHistoryTarget } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-history-navigation.ts"
  );
  const { clearBlockTermHistoryActivation, getBlockTermHistoryActivationRequest } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-history-selection.ts"
  );
  const { BlockTermWorkspaceNavigationCoordinator } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-workspace-navigation.ts"
  );
  t.after(() => clearBlockTermHistoryActivation());

  const sessionState = { currentSessionId: "workspace-a", loading: false, sessionInitialized: true };
  const result = await activateBlockTermHistoryTarget(
    {
      id: "missing-block",
      terminalId: "missing-terminal",
      workspaceSessionId: "workspace-b",
      runtimeType: "local",
      command: "echo missing",
      cwd: "/work",
      createdAt: 1,
      starred: false,
    },
    {
      id: "missing-target",
      workspaceId: "workspace-b",
      workspaceName: "Workspace B",
      workspaceOrder: 1,
      groupId: "group-b",
      groupOrder: 0,
      tabId: "missing-terminal",
      tabName: "Missing",
      tabOrder: 0,
    },
    new BlockTermWorkspaceNavigationCoordinator(),
    {
      switchSession: async (workspaceId) => {
        sessionState.currentSessionId = workspaceId;
      },
      getSessionState: () => sessionState,
      getFrameState: () => ({
        groups: [{ type: "tool", id: "group-b", name: "BlockTerm", pageId: "blockterm", tabs: [], activeTabId: null }],
        activeGroupId: null,
      }),
      getTerminalState: () => ({ terminalsByGroup: { "group-b": [] }, activeIdByGroup: { "group-b": null } }),
      setActiveTerminal: () => {},
      setActiveGroup: () => {},
    }
  );
  assert.equal(result.status, "unavailable");
  assert.equal(sessionState.currentSessionId, "workspace-a");
  assert.equal(getBlockTermHistoryActivationRequest(), null);
});

test("BlockTerm history filter options include durable scopes and preserve the active value", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { collectBlockTermHistoryFilterOptions } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-history-selection.ts"
  );
  assert.deepEqual(
    collectBlockTermHistoryFilterOptions(
      ["workspace-live", " workspace-deleted ", ""],
      ["workspace-live", undefined, null],
      ["workspace-selected"]
    ),
    ["workspace-live", "workspace-deleted", "workspace-selected"]
  );
});

test("BlockTerm history purge targets retain per-entry ownership scope", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { buildBlockTermHistoryPurgeTargets } = await vite.ssrLoadModule(
    "/src/components/terminal/blockterm-history-selection.ts"
  );
  const entries = [
    {
      id: "history-1",
      terminalId: "terminal-1",
      workspaceSessionId: "workspace-1",
      groupId: "group-1",
      userId: "user-1",
    },
    { id: "history-2", terminalId: "terminal-2" },
  ];

  assert.deepEqual(buildBlockTermHistoryPurgeTargets(entries, new Set(["history-2", "history-1"])), [
    {
      id: "history-1",
      terminalId: "terminal-1",
      workspaceSessionId: "workspace-1",
      groupId: "group-1",
      userId: "user-1",
    },
    {
      id: "history-2",
      terminalId: "terminal-2",
      workspaceSessionId: undefined,
      groupId: undefined,
      userId: undefined,
    },
  ]);
});
