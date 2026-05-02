import assert from "node:assert/strict";
import test from "node:test";

import { resolveBlockTermAppShortcut } from "../src/components/terminal/blockterm-app-keybindings.ts";
import { parseBlockTermKeymapConfig } from "../src/components/terminal/blockterm-keymap.ts";
import { loadBlockTermWorkspaceSearchTargets } from "../src/components/terminal/blockterm-workspace-loader.ts";
import { BlockTermWorkspaceNavigationCoordinator } from "../src/components/terminal/blockterm-workspace-navigation.ts";
import {
  buildBlockTermWorkspaceSearchTargets,
  createLocalBlockTermWorkspaceInventory,
  createRemoteBlockTermWorkspaceInventory,
  filterBlockTermWorkspaceSearchTargets,
  resolveBlockTermWorkspaceNavigationTarget,
  resolveRequestedBlockTermSessionId,
} from "../src/components/terminal/blockterm-workspace-search.ts";

const keyboardEvent = (key, patch = {}) => ({
  key,
  code: undefined,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

const inventory = (workspaceId, workspaceOrder, tabs) => ({
  workspaceId,
  workspaceName: workspaceId,
  workspaceOrder,
  groups: [{ groupId: `group-${workspaceId}`, groupOrder: 0, tabs }],
});

test("resolves portable app shortcuts for search and numbered workspaces", () => {
  const keymap = parseBlockTermKeymapConfig(null).keymap;
  assert.deepEqual(resolveBlockTermAppShortcut(keyboardEvent("p", { altKey: true }), keymap), {
    type: "open-tab-search",
  });
  assert.equal(resolveBlockTermAppShortcut(keyboardEvent("p", { metaKey: true }), keymap), null);
  assert.deepEqual(resolveBlockTermAppShortcut(keyboardEvent("p", { metaKey: true }), keymap, { macPlatform: true }), {
    type: "open-tab-search",
  });
  assert.equal(resolveBlockTermAppShortcut(keyboardEvent("p", { altKey: true }), keymap, { macPlatform: true }), null);
  assert.deepEqual(resolveBlockTermAppShortcut(keyboardEvent("3", { altKey: true, ctrlKey: true }), keymap), {
    type: "select-workspace",
    index: 2,
  });
  assert.equal(resolveBlockTermAppShortcut(keyboardEvent("3", { metaKey: true }), keymap), null);
  assert.equal(resolveBlockTermAppShortcut(keyboardEvent("p", { metaKey: true, shiftKey: true }), keymap), null);
});

test("keeps current workspace tabs first and preserves stable workspace and tab order", () => {
  const targets = buildBlockTermWorkspaceSearchTargets(
    [
      inventory("workspace-a", 0, [
        { tabId: "a-1", tabName: "A1", tabOrder: 0 },
        { tabId: "a-2", tabName: "A2", tabOrder: 1 },
      ]),
      inventory("workspace-b", 1, [
        { tabId: "b-1", tabName: "B1", tabOrder: 0 },
        { tabId: "b-2", tabName: "B2", tabOrder: 1 },
      ]),
    ],
    "workspace-b"
  );
  assert.deepEqual(
    targets.map((target) => target.tabId),
    ["b-1", "b-2", "a-1", "a-2"]
  );
});

test("filters by workspace or tab and supports first-slash field filtering", () => {
  const targets = buildBlockTermWorkspaceSearchTargets(
    [
      {
        workspaceId: "alpha",
        workspaceName: "Alpha Project",
        workspaceOrder: 0,
        groups: [
          {
            groupId: "blockterm-alpha",
            groupOrder: 0,
            tabs: [
              { tabId: "logs", tabName: "Server Logs", tabOrder: 0 },
              { tabId: "deploy", tabName: "Deploy/Prod", tabOrder: 1 },
            ],
          },
        ],
      },
      inventory("beta", 1, [{ tabId: "shell", tabName: "Alpha Shell", tabOrder: 0 }]),
    ],
    null
  );
  assert.deepEqual(
    filterBlockTermWorkspaceSearchTargets(targets, "alpha").map((target) => target.tabId),
    ["logs", "deploy", "shell"]
  );
  assert.deepEqual(
    filterBlockTermWorkspaceSearchTargets(targets, "alpha / logs").map((target) => target.tabId),
    ["logs"]
  );
  assert.deepEqual(
    filterBlockTermWorkspaceSearchTargets(targets, "alpha/deploy/prod").map((target) => target.tabId),
    ["deploy"]
  );
  assert.deepEqual(filterBlockTermWorkspaceSearchTargets(targets, "missing"), []);
});

test("caps displayed matches after filtering without hiding later exact matches", () => {
  const tabs = Array.from({ length: 120 }, (_, index) => ({
    tabId: `tab-${index}`,
    tabName: `Tab ${index}`,
    tabOrder: index,
  }));
  const targets = buildBlockTermWorkspaceSearchTargets([inventory("workspace", 0, tabs)], null);
  assert.equal(targets.length, 120);
  assert.equal(filterBlockTermWorkspaceSearchTargets(targets, "").length, 100);
  assert.deepEqual(
    filterBlockTermWorkspaceSearchTargets(targets, "Tab 119").map((target) => target.tabId),
    ["tab-119"]
  );
});

test("uses authoritative BlockTerm ownership, live rename, root filtering, and persisted tab order", () => {
  const session = { id: "workspace-1", name: "Workspace 1" };
  const state = {
    openTools: [
      { id: "other-tool", pageId: "codex", name: "Codex" },
      { id: "blockterm-tool", pageId: "blockterm", name: "BlockTerm" },
    ],
    terminalsByGroup: {
      "blockterm-tool": [
        { id: "root-1", name: "Old name" },
        { id: "root-2", name: "Second" },
        { id: "child", name: "Child", parentId: "root-1" },
      ],
    },
  };
  const live = [
    {
      id: "root-2",
      name: "Renamed second",
      group_id: "blockterm-tool",
      parent_id: "",
      status: "running",
      created_at: 20,
    },
    {
      id: "root-1",
      name: "Renamed first",
      group_id: "blockterm-tool",
      parent_id: "",
      status: "exited",
      created_at: 10,
    },
    {
      id: "child",
      name: "Child",
      group_id: "blockterm-tool",
      parent_id: "root-1",
      status: "running",
      created_at: 30,
    },
  ];
  const result = createRemoteBlockTermWorkspaceInventory(session, 0, state, live);
  assert.deepEqual(
    result.groups.flatMap((group) => group.tabs.map((tab) => [tab.tabId, tab.tabName])),
    [
      ["root-1", "Renamed first"],
      ["root-2", "Renamed second"],
    ]
  );
});

test("builds current targets only from BlockTerm tool groups", () => {
  const result = createLocalBlockTermWorkspaceInventory(
    { id: "workspace-1", name: "Workspace 1" },
    0,
    [
      { type: "home", id: "home", name: "Home" },
      { type: "tool", id: "codex", name: "Codex", pageId: "codex", tabs: [], activeTabId: null },
      { type: "tool", id: "blockterm", name: "BlockTerm", pageId: "blockterm", tabs: [], activeTabId: null },
    ],
    {
      codex: [{ id: "other", name: "Other" }],
      blockterm: [{ id: "target", name: "Target" }],
    }
  );
  assert.deepEqual(result.groups.map((group) => group.groupId), ["blockterm"]);
  assert.deepEqual(result.groups[0].tabs.map((tab) => tab.tabId), ["target"]);
});

test("resolves only live root terminals inside BlockTerm groups", () => {
  const groups = [
    { type: "tool", id: "old-group", name: "BlockTerm", pageId: "blockterm", tabs: [], activeTabId: null },
    { type: "tool", id: "new-group", name: "BlockTerm", pageId: "blockterm", tabs: [], activeTabId: null },
  ];
  assert.equal(
    resolveBlockTermWorkspaceNavigationTarget(
      groups,
      { "new-group": [{ id: "terminal-1", name: "Renamed" }] },
      { groupId: "old-group", tabId: "terminal-1" }
    ),
    null
  );
  assert.deepEqual(
    resolveBlockTermWorkspaceNavigationTarget(
      [groups[1]],
      { "new-group": [{ id: "terminal-1", name: "Renamed" }] },
      { groupId: "old-group", tabId: "terminal-1" }
    ),
    { groupId: "new-group", terminalId: "terminal-1" }
  );
  assert.equal(
    resolveBlockTermWorkspaceNavigationTarget(
      groups,
      { "old-group": [{ id: "child", name: "Child", parentId: "root" }] },
      { groupId: "old-group", tabId: "child" }
    ),
    null
  );
});

test("consumes an external active session request only after the session exists", () => {
  assert.equal(resolveRequestedBlockTermSessionId("terminal-2", "terminal-1", ["terminal-1"]), null);
  assert.equal(
    resolveRequestedBlockTermSessionId("terminal-2", "terminal-1", ["terminal-1", "terminal-2"]),
    "terminal-2"
  );
  assert.equal(resolveRequestedBlockTermSessionId("terminal-1", "terminal-1", ["terminal-1"]), null);
});

const sessionInfo = (id, name = id) => ({
  id,
  user_id: "",
  name,
  created_at: 0,
  updated_at: 0,
});

const workspaceState = (workspaceId, terminalName = null) => {
  const groupId = `group-${workspaceId}`;
  return {
    openGroups: [],
    openTools: terminalName ? [{ id: groupId, pageId: "blockterm", name: "BlockTerm" }] : [],
    taskbarOrder: [],
    terminalsByGroup: terminalName ? { [groupId]: [{ id: `terminal-${workspaceId}`, name: terminalName }] } : {},
    activeTerminalByGroup: {},
    listManagerOpenByGroup: {},
    terminalLayouts: {},
    focusedIdByGroup: {},
    settingsOpen: false,
    activeGroupId: null,
    fileManagerByGroup: {},
  };
};

const sessionDetail = (session, state) => ({
  ...session,
  state: "{}",
  workspace_state: state,
});

const liveTerminal = (workspaceId, name) => ({
  id: `terminal-${workspaceId}`,
  name,
  group_id: `group-${workspaceId}`,
  parent_id: "",
  status: "exited",
  created_at: 1,
});

test("loads every workspace page and keeps server order when detail responses finish out of order", async () => {
  const sessions = [
    sessionInfo("current", "Current"),
    sessionInfo("empty", "Empty"),
    sessionInfo("slow", "Slow"),
    sessionInfo("fast", "Fast"),
  ];
  const pageCalls = [];
  const detailResolvers = new Map();
  const controller = new AbortController();
  const loadPromise = loadBlockTermWorkspaceSearchTargets(
    {
      currentWorkspaceId: "current",
      currentInventory: inventory("current", 0, [{ tabId: "current-tab", tabName: "Current tab", tabOrder: 0 }]),
      pageSize: 2,
      concurrency: 2,
    },
    controller.signal,
    {
      listSessions: async (page, pageSize) => {
        pageCalls.push(page);
        return {
          sessions: sessions.slice((page - 1) * pageSize, page * pageSize),
          page,
          page_size: pageSize,
          total: sessions.length,
        };
      },
      getSession: (id) =>
        new Promise((resolve) => {
          detailResolvers.set(id, () =>
            resolve(
              sessionDetail(
                sessions.find((session) => session.id === id),
                workspaceState(id, id === "empty" ? null : `${id} saved`)
              )
            )
          );
        }),
      listTerminals: async (workspaceId) => ({ terminals: [liveTerminal(workspaceId, `${workspaceId} live`)] }),
    }
  );

  while (!detailResolvers.has("empty")) await new Promise((resolve) => setImmediate(resolve));
  detailResolvers.get("empty")();
  while (!detailResolvers.has("slow")) await new Promise((resolve) => setImmediate(resolve));
  while (!detailResolvers.has("fast")) await new Promise((resolve) => setImmediate(resolve));
  detailResolvers.get("fast")();
  detailResolvers.get("slow")();

  const result = await loadPromise;
  assert.deepEqual(pageCalls, [1, 2]);
  assert.deepEqual(
    result.targets.map((target) => target.workspaceId),
    ["current", "slow", "fast"]
  );
  assert.deepEqual(
    result.targets.map((target) => target.tabName),
    ["Current tab", "slow live", "fast live"]
  );
});

test("refreshes a local fallback workspace name from paginated session metadata", async () => {
  const current = sessionInfo("current", "Real workspace name");
  const result = await loadBlockTermWorkspaceSearchTargets(
    {
      currentWorkspaceId: current.id,
      currentInventory: {
        ...inventory(current.id, 0, [{ tabId: "terminal", tabName: "Shell", tabOrder: 0 }]),
        workspaceName: "Workspace",
      },
      pageSize: 1,
    },
    new AbortController().signal,
    {
      listSessions: async () => ({ sessions: [current], page: 1, page_size: 1, total: 1 }),
      getSession: async () => {
        throw new Error("current inventory should not be reloaded");
      },
      listTerminals: async () => ({ terminals: [] }),
    }
  );
  assert.equal(result.targets[0].workspaceName, "Real workspace name");
});

test("keeps saved terminals on terminal refresh failure and counts degraded workspaces", async () => {
  const sessions = [sessionInfo("missing"), sessionInfo("stale"), sessionInfo("healthy")];
  const result = await loadBlockTermWorkspaceSearchTargets(
    { currentWorkspaceId: null, pageSize: 3 },
    new AbortController().signal,
    {
      listSessions: async () => ({ sessions, page: 1, page_size: 3, total: 3 }),
      getSession: async (id) => {
        if (id === "missing") throw new Error("detail failed");
        return sessionDetail(
          sessions.find((session) => session.id === id),
          workspaceState(id, `${id} saved`)
        );
      },
      listTerminals: async (id) => {
        if (id === "stale") throw new Error("terminal refresh failed");
        return { terminals: [liveTerminal(id, `${id} live`)] };
      },
    }
  );
  assert.equal(result.failedWorkspaceCount, 2);
  assert.deepEqual(
    result.targets.map((target) => [target.workspaceId, target.tabName]),
    [
      ["stale", "stale saved"],
      ["healthy", "healthy live"],
    ]
  );
});

test("aborts paginated inventory loading without requesting later pages", async () => {
  const controller = new AbortController();
  const pageCalls = [];
  await assert.rejects(
    loadBlockTermWorkspaceSearchTargets(
      { currentWorkspaceId: null, pageSize: 1, concurrency: 1 },
      controller.signal,
      {
        listSessions: async (page) => {
          pageCalls.push(page);
          return { sessions: [sessionInfo(`workspace-${page}`)], page, page_size: 1, total: 2 };
        },
        getSession: async () => {
          controller.abort();
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
        listTerminals: async () => ({ terminals: [] }),
      }
    ),
    (error) => error?.name === "AbortError"
  );
  assert.deepEqual(pageCalls, [1]);
});

test("keeps pagination moving when a response repeats an earlier page number", async () => {
  const pageCalls = [];
  const result = await loadBlockTermWorkspaceSearchTargets(
    { currentWorkspaceId: null, pageSize: 1, concurrency: 1 },
    new AbortController().signal,
    {
      listSessions: async (page, pageSize) => {
        pageCalls.push(page);
        const session = sessionInfo(`workspace-${page}`);
        return {
          sessions: [session],
          page: 1,
          page_size: pageSize,
          total: 2,
        };
      },
      getSession: async (id) => sessionDetail(sessionInfo(id), workspaceState(id, `terminal ${id}`)),
      listTerminals: async (id) => ({ terminals: [liveTerminal(id, `terminal ${id}`)] }),
    }
  );
  assert.deepEqual(pageCalls, [1, 2]);
  assert.deepEqual(result.targets.map((target) => target.workspaceId), ["workspace-1", "workspace-2"]);
});

const navigationTarget = (workspaceId) => ({
  id: workspaceId,
  workspaceId,
  workspaceName: workspaceId,
  workspaceOrder: 0,
  groupId: `group-${workspaceId}`,
  groupOrder: 0,
  tabId: `terminal-${workspaceId}`,
  tabName: workspaceId,
  tabOrder: 0,
});

function createNavigationHarness() {
  let sessionState = { currentSessionId: "workspace-a", loading: false, sessionInitialized: true };
  let frameState = {
    groups: [
      {
        type: "tool",
        id: "group-workspace-a",
        name: "BlockTerm",
        pageId: "blockterm",
        tabs: [],
        activeTabId: null,
      },
    ],
    activeGroupId: "group-workspace-a",
  };
  let terminalState = {
    terminalsByGroup: {
      "group-workspace-a": [{ id: "terminal-workspace-a", name: "A" }],
    },
    activeIdByGroup: { "group-workspace-a": "terminal-workspace-a" },
  };
  const switches = [];
  const activations = [];
  const pending = new Map();
  const installWorkspace = (workspaceId) => {
    const groupId = `group-${workspaceId}`;
    const terminalId = `terminal-${workspaceId}`;
    sessionState = { currentSessionId: workspaceId, loading: false, sessionInitialized: true };
    frameState = {
      groups: [{ type: "tool", id: groupId, name: "BlockTerm", pageId: "blockterm", tabs: [], activeTabId: null }],
      activeGroupId: groupId,
    };
    terminalState = {
      terminalsByGroup: { [groupId]: [{ id: terminalId, name: workspaceId }] },
      activeIdByGroup: { [groupId]: null },
    };
  };
  const dependencies = {
    switchSession: (workspaceId) => {
      switches.push(workspaceId);
      sessionState = { ...sessionState, loading: true, sessionInitialized: false };
      return new Promise((resolve) => pending.set(workspaceId, resolve));
    },
    getSessionState: () => sessionState,
    getFrameState: () => frameState,
    getTerminalState: () => terminalState,
    setActiveTerminal: (groupId, terminalId) => {
      activations.push([groupId, terminalId]);
      terminalState = {
        ...terminalState,
        activeIdByGroup: { ...terminalState.activeIdByGroup, [groupId]: terminalId },
      };
    },
    setActiveGroup: (groupId) => {
      frameState = { ...frameState, activeGroupId: groupId };
    },
  };
  return {
    dependencies,
    switches,
    activations,
    setSessionState: (next) => {
      sessionState = next;
    },
    resolveSwitch: (workspaceId, { install = true } = {}) => {
      if (install) installWorkspace(workspaceId);
      pending.get(workspaceId)();
      pending.delete(workspaceId);
    },
  };
}

test("lets the latest A to B to C target navigation win", async () => {
  const coordinator = new BlockTermWorkspaceNavigationCoordinator();
  const harness = createNavigationHarness();
  const toB = coordinator.activateTarget(navigationTarget("workspace-b"), harness.dependencies);
  const toC = coordinator.activateTarget(navigationTarget("workspace-c"), harness.dependencies);

  harness.resolveSwitch("workspace-c");
  const cResult = await toC;
  harness.resolveSwitch("workspace-b", { install: false });
  const bResult = await toB;

  assert.equal(cResult.status, "activated");
  assert.equal(bResult.status, "superseded");
  assert.deepEqual(harness.activations, [["group-workspace-c", "terminal-workspace-c"]]);
});

test("activates a current-workspace target through the shared stores", async () => {
  const coordinator = new BlockTermWorkspaceNavigationCoordinator();
  const harness = createNavigationHarness();

  const result = await coordinator.activateTarget(navigationTarget("workspace-a"), harness.dependencies);

  assert.equal(result.status, "activated");
  assert.deepEqual(harness.switches, []);
  assert.deepEqual(harness.activations, [["group-workspace-a", "terminal-workspace-a"]]);
});

test("supersedes an in-flight switch even when the requested workspace id still matches", async () => {
  const coordinator = new BlockTermWorkspaceNavigationCoordinator();
  const harness = createNavigationHarness();
  harness.setSessionState({ currentSessionId: "workspace-a", loading: true, sessionInitialized: false });

  const activation = coordinator.activateTarget(navigationTarget("workspace-a"), harness.dependencies);
  assert.deepEqual(harness.switches, ["workspace-a"]);
  harness.resolveSwitch("workspace-a");
  assert.equal((await activation).status, "activated");
});

test("invalidates a pending target without applying its terminal selection", async () => {
  const coordinator = new BlockTermWorkspaceNavigationCoordinator();
  const harness = createNavigationHarness();
  const activation = coordinator.activateTarget(navigationTarget("workspace-b"), harness.dependencies);
  coordinator.invalidate();
  harness.resolveSwitch("workspace-b");
  assert.equal((await activation).status, "superseded");
  assert.deepEqual(harness.activations, []);
});

test("rejects a target removed during workspace switching", async () => {
  const coordinator = new BlockTermWorkspaceNavigationCoordinator();
  const harness = createNavigationHarness();
  const activation = coordinator.activateTarget(navigationTarget("workspace-b"), harness.dependencies);
  harness.resolveSwitch("workspace-b");
  harness.dependencies.getTerminalState().terminalsByGroup["group-workspace-b"] = [];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.switches, ["workspace-b", "workspace-a"]);
  harness.resolveSwitch("workspace-a");
  assert.equal((await activation).status, "unavailable");
  assert.deepEqual(harness.activations, []);
});
