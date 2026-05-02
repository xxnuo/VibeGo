import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildBlockTermManagementScreenSettingsPatch,
  isBlockTermManagementIndependentBlock,
  planBlockTermManagementDispatch,
  resolveBlockTermManagementScreenReorderAnchor,
} from "../src/components/terminal/blockterm-management-dispatch.ts";

function block(id, lineNum, overrides = {}) {
  return {
    id,
    lineNum,
    kind: "command",
    command: `echo ${id}`,
    status: "success",
    archived: false,
    pinned: false,
    starred: false,
    collapsed: false,
    renderer: "terminal",
    ...overrides,
  };
}

function session(id, name, overrides = {}) {
  return {
    id,
    name,
    tabColor: "",
    tabIcon: "",
    cwd: `/work/${id}`,
    runtimeType: "local",
    cols: 100,
    rows: 30,
    status: "ready",
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    sessionId: "session-a",
    workspaceSessionId: "workspace-a",
    groupId: "group-a",
    sessions: [
      session("session-a", "dev"),
      session("session-b", "build", { tabColor: "blue" }),
      session("session-c", "deploy", { runtimeType: "ssh" }),
    ],
    sessionStatus: "ready",
    activeBlockId: null,
    selectedBlockId: "block-2",
    blocks: [block("block-1", 10), block("block-2", 20)],
    view: { sidebar: { open: false, width: "50%", blockId: null } },
    ...overrides,
  };
}

function command(commandName, args = [], kwargs = {}) {
  const [name, subcommand] = commandName.split(":");
  return {
    kind: "management",
    raw: `/${commandName}`,
    name,
    commandName,
    ...(subcommand ? { subcommand } : {}),
    args,
    kwargs,
  };
}

test("plans future-block connection selection without mutating the parent screen", () => {
  const base = snapshot();
  assert.deepEqual(planBlockTermManagementDispatch(command("connect"), base).actions, [
    { kind: "open-connection-selector", sessionId: "session-a" },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("connect", ["local"]), base).actions, [
    { kind: "set-connection", sessionId: "session-a", runtimeType: "local" },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("connect", ["ssh", "profile-a"]), base).actions, [
    {
      kind: "set-connection",
      sessionId: "session-a",
      runtimeType: "ssh",
      sshProfileId: "profile-a",
    },
  ]);
  assert.deepEqual(
    planBlockTermManagementDispatch(command("connect", [], { profile: "profile-b" }), base).actions,
    [
      {
        kind: "set-connection",
        sessionId: "session-a",
        runtimeType: "ssh",
        sshProfileId: "profile-b",
      },
    ]
  );
  assert.deepEqual(
    planBlockTermManagementDispatch(command("connect", ["profile-c"], { runtime: "ssh" }), base).actions,
    [
      {
        kind: "set-connection",
        sessionId: "session-a",
        runtimeType: "ssh",
        sshProfileId: "profile-c",
      },
    ]
  );
  assert.equal(planBlockTermManagementDispatch(command("connect", ["ssh"]), base).code, "invalid-value");
  assert.equal(
    planBlockTermManagementDispatch(command("connect", ["local"], { profile: "profile-a" }), base).code,
    "invalid-value"
  );
  assert.equal(
    planBlockTermManagementDispatch(command("connect", ["local"], { runtime: "ssh" }), base).code,
    "invalid-arguments"
  );
});

test("plans clear as delete by default and archive only when archive is truthy", () => {
  const base = snapshot();
  assert.deepEqual(planBlockTermManagementDispatch(command("clear"), base), {
    kind: "plan",
    commandName: "clear",
    actions: [{ kind: "delete-blocks", sessionId: "session-a", blockIds: ["block-1", "block-2"] }],
  });
  assert.deepEqual(planBlockTermManagementDispatch(command("clear", [], { archive: "1" }), base), {
    kind: "plan",
    commandName: "clear",
    actions: [{ kind: "archive-blocks", sessionId: "session-a", blockIds: ["block-1", "block-2"] }],
  });
  assert.equal(planBlockTermManagementDispatch(command("clear", [], { archive: "later" }), base).code, "invalid-value");
  const protectedBlocks = snapshot({
    activeBlockId: "block-1",
    blocks: [block("block-1", 10, { status: "running" }), block("block-2", 20, { status: "streaming" }), block("block-3", 30)],
  });
  assert.deepEqual(planBlockTermManagementDispatch(command("clear"), protectedBlocks).actions, [
    { kind: "delete-blocks", sessionId: "session-a", blockIds: ["block-3"] },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("clear", [], { archive: "1" }), protectedBlocks).actions, [
    { kind: "archive-blocks", sessionId: "session-a", blockIds: ["block-3"] },
  ]);
});

test("plans current and cross-workspace line views without treating line:show as navigation", () => {
  const base = snapshot();
  assert.deepEqual(planBlockTermManagementDispatch(command("line:view", ["10"]), base).actions, [
    { kind: "focus-block", sessionId: "session-a", blockId: "block-1" },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("line:view", ["workspace-b", "logs", "42"]), base).actions, [
    {
      kind: "view-line",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      workspaceRef: "workspace-b",
      screenRef: "logs",
      lineRef: "42",
    },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("line:view", ["404"]), base).code, "unknown-line");
  assert.equal(planBlockTermManagementDispatch(command("line:view"), base).code, "invalid-arguments");
  assert.equal(planBlockTermManagementDispatch(command("line:view", ["a", "b"]), base).code, "invalid-arguments");
  assert.equal(planBlockTermManagementDispatch(command("line:show", ["10"]), base).code, "unsupported");
});

test("requires signals to target the live current command block", () => {
  const active = snapshot({
    activeBlockId: "block-1",
    selectedBlockId: "block-1",
    blocks: [block("block-1", 10, { status: "running" }), block("block-2", 20)],
  });
  assert.deepEqual(planBlockTermManagementDispatch(command("signal", ["10", "TERM"]), active).actions, [
    { kind: "signal", sessionId: "session-a", blockId: "block-1", signal: "TERM" },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("signal", ["KILL"]), active).actions, [
    { kind: "signal", sessionId: "session-a", blockId: "block-1", signal: "KILL" },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("signal", ["block-2", "INT"]), active).code, "not-active-line");
  assert.equal(planBlockTermManagementDispatch(command("signal", ["HUP"]), active).code, "invalid-signal");
  assert.equal(
    planBlockTermManagementDispatch(command("signal", ["INT"]), { ...active, activeBlockId: "block-2" }).code,
    "not-active-line"
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("signal", ["10", "SIGTERM"]), active).actions, [
    { kind: "signal", sessionId: "session-a", blockId: "block-1", signal: "TERM" },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("signal", ["10", "9"]), active).actions, [
    { kind: "signal", sessionId: "session-a", blockId: "block-1", signal: "KILL" },
  ]);

  const activeSSH = snapshot({
    activeBlockId: "block-1",
    selectedBlockId: "block-1",
    blocks: [block("block-1", 10, { status: "running", runtimeType: "ssh" })],
  });
  assert.deepEqual(planBlockTermManagementDispatch(command("signal", ["INT"]), activeSSH).actions, [
    { kind: "signal", sessionId: "session-a", blockId: "block-1", signal: "INT" },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("signal", ["TERM"]), activeSSH).code, "invalid-signal");
  assert.equal(planBlockTermManagementDispatch(command("signal", ["KILL"]), activeSSH).code, "invalid-signal");
});

test("plans supported line mutations and documents the boolean star mapping", () => {
  const base = snapshot();
  assert.deepEqual(planBlockTermManagementDispatch(command("line:star", ["10", "0"]), base).actions, [
    { kind: "update-block", sessionId: "session-a", blockId: "block-1", patch: { starred: false } },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("line:pin", ["10"]), base).actions, [
    { kind: "update-block", sessionId: "session-a", blockId: "block-1", patch: { pinned: true } },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("line:archive", ["block-1", "false"]), base).actions, [
    { kind: "update-block", sessionId: "session-a", blockId: "block-1", patch: { archived: false } },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("line:minimize", ["off"]), base).actions, [
    { kind: "update-block", sessionId: "session-a", blockId: "block-2", patch: { collapsed: false } },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("line:star", ["10", "5"]), base).actions, [
    { kind: "update-block", sessionId: "session-a", blockId: "block-1", patch: { starred: true } },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("line:setheight", ["10", "320"]), base).actions, [
    {
      kind: "update-block",
      sessionId: "session-a",
      blockId: "block-1",
      patch: { presentationJson: '{"height":320}' },
    },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("line:pin"), base).code, "invalid-arguments");
  assert.equal(planBlockTermManagementDispatch(command("line:setheight", ["400"]), base).code, "invalid-arguments");
});

test("maps supported block actions and rejects unsupported lifecycle and renderer states", () => {
  const base = snapshot();
  assert.deepEqual(planBlockTermManagementDispatch(command("line:delete", ["10", "block-2"]), base).actions, [
    { kind: "delete-blocks", sessionId: "session-a", blockIds: ["block-1", "block-2"] },
  ]);
  assert.equal(
    planBlockTermManagementDispatch(
      command("line:delete", ["10"]),
      snapshot({ activeBlockId: "block-1", blocks: [block("block-1", 10, { status: "running" }), block("block-2", 20)] })
    ).code,
    "not-active-line"
  );
  assert.equal(
    planBlockTermManagementDispatch(
      command("line:delete", ["10"]),
      snapshot({ blocks: [block("block-1", 10, { status: "streaming" }), block("block-2", 20)] })
    ).code,
    "not-active-line"
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("line:bookmark", ["10"]), base).actions, [
    { kind: "open-bookmark", sessionId: "session-a", blockId: "block-1", command: "echo block-1" },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("line:bookmark"), base).code, "invalid-arguments");
  assert.equal(
    planBlockTermManagementDispatch(
      command("line:bookmark", ["10"]),
      snapshot({ blocks: [block("block-1", 10, { kind: "note" })] })
    ).code,
    "unsupported"
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("line:set", ["10"], { view: "markdown" }), base).actions, [
    { kind: "switch-renderer", sessionId: "session-a", blockId: "block-1", renderer: "markdown" },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("line:set", ["10"], { state: "{}" }), base).code, "unsupported");
  assert.deepEqual(
    planBlockTermManagementDispatch(
      command("line:set", ["10"], { renderer: "markdown", state: '{"prompt:source":"pty","wrap":true}' }),
      base
    ).actions,
    [
      { kind: "switch-renderer", sessionId: "session-a", blockId: "block-1", renderer: "markdown" },
      {
        kind: "update-block",
        sessionId: "session-a",
        blockId: "block-1",
        patch: { stateJson: '{"prompt:source":"pty","wrap":true}' },
      },
    ]
  );
  assert.equal(
    planBlockTermManagementDispatch(command("line:set", ["10"], { renderer: "markdown", state: "[]" }), base).code,
    "invalid-value"
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("line:restart"), base).actions, [
    { kind: "restart-block", sessionId: "session-a", blockId: "block-2" },
  ]);
  assert.equal(
    planBlockTermManagementDispatch(command("line:restart"), snapshot({ activeBlockId: "block-1" })).code,
    "unsupported"
  );
});

test("preserves sidebar ownership and requires line= only when adding an owner", () => {
  const base = snapshot();
  assert.deepEqual(planBlockTermManagementDispatch(command("sidebar:open"), base).actions, [
    {
      kind: "update-view",
      sessionId: "session-a",
      patch: { sidebar: { open: true } },
    },
  ]);
  assert.deepEqual(
    planBlockTermManagementDispatch(command("sidebar:add", [], { line: "10", width: "500px" }), base).actions,
    [
      {
        kind: "update-view",
        sessionId: "session-a",
        patch: { sidebar: { open: true, blockId: "block-1", width: "500px" } },
      },
    ]
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("sidebar:close"), base).actions, [
    { kind: "update-view", sessionId: "session-a", patch: { sidebar: { open: false } } },
  ]);
  const persistedOwner = snapshot({
    selectedBlockId: null,
    view: { sidebar: { open: false, width: "50%", blockId: "block-1" } },
  });
  assert.deepEqual(planBlockTermManagementDispatch(command("sidebar:open"), persistedOwner).actions, [
    {
      kind: "update-view",
      sessionId: "session-a",
      patch: { sidebar: { open: true } },
    },
  ]);
  assert.deepEqual(
    planBlockTermManagementDispatch(
      command("sidebar:remove"),
      snapshot({ selectedBlockId: null, view: { sidebar: { open: true, width: "50%", blockId: "block-1" } } })
    ).actions,
    [{ kind: "update-view", sessionId: "session-a", patch: { sidebar: { open: false, blockId: null } } }]
  );
  assert.equal(planBlockTermManagementDispatch(command("sidebar:add", ["10"]), base).code, "invalid-arguments");
  assert.equal(planBlockTermManagementDispatch(command("sidebar:add"), base).code, "invalid-arguments");
  assert.equal(planBlockTermManagementDispatch(command("sidebar:remove", ["10"]), base).code, "invalid-arguments");
  assert.equal(
    planBlockTermManagementDispatch(
      command("sidebar:add", [], { line: "10" }),
      snapshot({
        activeBlockId: "block-1",
        blocks: [block("block-1", 10, { status: "running" }), block("block-2", 20)],
      })
    ).code,
    "unsupported"
  );

  const independent = snapshot({
    scopeGeneration: 7,
    activeBlockId: null,
    blocks: [block("block-1", 10, { terminalId: "session-a", status: "running" })],
    independentBindings: [
      { sessionId: "session-a", blockId: "block-1", blockToken: "token-1", scopeGeneration: 7 },
    ],
  });
  assert.deepEqual(planBlockTermManagementDispatch(command("sidebar:add", [], { line: "10" }), independent).actions, [
    {
      kind: "update-view",
      sessionId: "session-a",
      patch: { sidebar: { open: true, blockId: "block-1" } },
    },
  ]);
  assert.equal(isBlockTermManagementIndependentBlock(independent, independent.blocks[0]), true);
  assert.equal(
    planBlockTermManagementDispatch(
      command("sidebar:add", [], { line: "10" }),
      snapshot({
        scopeGeneration: 8,
        blocks: [block("block-1", 10, { terminalId: "session-a", status: "running" })],
        independentBindings: [
          { sessionId: "session-a", blockId: "block-1", blockToken: "token-1", scopeGeneration: 7 },
        ],
      })
    ).code,
    "unsupported"
  );
});

test("plans reset and bounded shell-state refresh actions only for idle scoped terminals", () => {
  const base = snapshot();
  assert.deepEqual(
    planBlockTermManagementDispatch(command("reset", [], { shell: "zsh", verbose: "1" }), base).actions,
    [
      {
        kind: "reset-session-runtime",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        targetSessionId: "session-a",
        shell: "zsh",
        verbose: true,
      },
    ]
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("sync"), base).actions, [
    {
      kind: "sync-session-state",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      targetSessionId: "session-a",
      command: ":",
    },
  ]);
  assert.deepEqual(planBlockTermManagementDispatch(command("reset:cwd"), base).actions, [
    {
      kind: "reset-session-cwd",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      targetSessionId: "session-a",
      command: "cd ~",
    },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("sync"), snapshot({ activeBlockId: "block-1" })).code, "session-busy");
  assert.equal(planBlockTermManagementDispatch(command("reset:cwd"), snapshot({ workspaceSessionId: null })).code, "missing-scope");
});

test("resolves screen names, indices, ids, creation, and true deletion into scoped tab actions", () => {
  const base = snapshot();
  assert.deepEqual(planBlockTermManagementDispatch(command("screen", ["2"]), base).actions, [
    {
      kind: "select-screen",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      targetSessionId: "session-b",
    },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("screen", ["dep"]), base).actions[0].targetSessionId, "session-c");
  assert.deepEqual(
    planBlockTermManagementDispatch(command("screen:open", [], { name: " dev shell ", activate: "false" }), base).actions,
    [
      {
        kind: "create-screen",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        name: "dev shell",
        activate: false,
      },
    ]
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("screen:new"), base).actions, [
    {
      kind: "create-screen",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      activate: true,
    },
  ]);
  assert.equal(
    planBlockTermManagementDispatch(command("screen:open", [], { name: "   " }), base).code,
    "invalid-value"
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("screen:delete", ["build"]), base).actions, [
    {
      kind: "delete-screen",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      targetSessionId: "session-b",
    },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("screen", ["missing"]), base).code, "unknown-screen");
});

test("plans screen settings, selection, anchor, focus, and durable reorder targets", () => {
  const base = snapshot();
  assert.deepEqual(
    planBlockTermManagementDispatch(
      command("screen:set", [], {
        name: " Work ",
        tabcolor: "red",
        tabicon: "fire",
        pos: "3",
        line: "10",
        anchor: "20:-4",
        focus: "cmd",
      }),
      base
    ).actions,
    [
      {
        kind: "update-screen-settings",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        targetSessionId: "session-a",
        settings: { name: "Work", tabColor: "red", tabIcon: "fire" },
      },
      {
        kind: "reorder-screen",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        targetSessionId: "session-a",
        targetIndex: 3,
        anchorSessionId: "session-c",
      },
      {
        kind: "set-screen-view",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        targetSessionId: "session-a",
        selectedBlockId: "block-1",
        anchorBlockId: "block-2",
        anchorOffset: -4,
        focus: "command",
      },
    ]
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("screen:reorder", [], { index: "2" }), base).actions, [
    {
      kind: "reorder-screen",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      targetSessionId: "session-a",
      targetIndex: 2,
      anchorSessionId: "session-b",
    },
  ]);
  assert.equal(planBlockTermManagementDispatch(command("screen:set", [], { sharename: "public" }), base).code, "unsupported");
  assert.equal(planBlockTermManagementDispatch(command("screen:set", [], { tabcolor: "purple" }), base).code, "invalid-value");
  assert.equal(planBlockTermManagementDispatch(command("screen:reorder", [], { index: "9" }), base).code, "invalid-value");
});

test("keeps screen settings patches field-scoped and resolves reorder positions from the current inventory", () => {
  const patch = buildBlockTermManagementScreenSettingsPatch({ tabColor: "red", tabIcon: "default" });
  assert.deepEqual(patch, { tabColor: "red", tabIcon: "" });
  assert.deepEqual({ name: "renamed", tabColor: "blue", ...patch }, {
    name: "renamed",
    tabColor: "red",
    tabIcon: "",
  });

  assert.equal(
    resolveBlockTermManagementScreenReorderAnchor(
      [{ id: "session-c" }, { id: "session-a" }, { id: "session-b" }],
      3
    ),
    "session-b"
  );
  assert.equal(resolveBlockTermManagementScreenReorderAnchor([{ id: "session-a" }], 2), null);
});

test("plans structured screen inspection and preserves legacy parent-only resize actions", () => {
  const base = snapshot();
  const show = planBlockTermManagementDispatch(command("screen:show"), base);
  assert.equal(show.actions[0].kind, "show-screen-info");
  assert.deepEqual(show.actions[0].screen, { ...base.sessions[0], index: 1 });
  const showAll = planBlockTermManagementDispatch(command("screen:showall"), base);
  assert.equal(showAll.actions[0].kind, "show-screen-list");
  assert.deepEqual(
    showAll.actions[0].screens.map(({ id, index }) => ({ id, index })),
    [
      { id: "session-a", index: 1 },
      { id: "session-b", index: 2 },
      { id: "session-c", index: 3 },
    ]
  );
  assert.deepEqual(planBlockTermManagementDispatch(command("screen:resize", [], { cols: "132" }), base).actions, [
    {
      kind: "resize-screen",
      sessionId: "session-a",
      workspaceSessionId: "workspace-a",
      groupId: "group-a",
      targetSessionId: "session-a",
      cols: 132,
      rows: 30,
    },
  ]);
  assert.deepEqual(
    planBlockTermManagementDispatch(command("screen:resize", [], { cols: "132", include: "10" }), base).actions,
    [
      {
        kind: "resize-screen",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        targetSessionId: "session-a",
        cols: 132,
        rows: 30,
      },
    ]
  );
});

test("selects current independent child PTYs for screen resize", () => {
  const base = snapshot({
    scopeGeneration: 7,
    blocks: [
      block("legacy", 10, { terminalId: "session-a", status: "running" }),
      block("child-a", 20, { terminalId: "session-a", status: "running" }),
      block("child-b", 30, { terminalId: "session-a", status: "streaming" }),
      block("finished", 40, { terminalId: "session-a" }),
    ],
    independentBindings: [
      { sessionId: "session-a", blockId: "child-a", blockToken: "token-a", scopeGeneration: 7 },
      { sessionId: "session-a", blockId: "child-b", blockToken: "token-b", scopeGeneration: 7 },
      { sessionId: "session-a", blockId: "finished", blockToken: "token-finished", scopeGeneration: 7 },
    ],
  });

  assert.deepEqual(
    planBlockTermManagementDispatch(command("screen:resize", [], { cols: "144" }), base).actions[0].childTargets,
    [
      { blockId: "child-a", blockToken: "token-a", scopeGeneration: 7 },
      { blockId: "child-b", blockToken: "token-b", scopeGeneration: 7 },
    ]
  );
  assert.deepEqual(
    planBlockTermManagementDispatch(
      command("screen:resize", [], { cols: "144", include: "20,child-b", exclude: "20" }),
      base
    ).actions[0].childTargets,
    [{ blockId: "child-b", blockToken: "token-b", scopeGeneration: 7 }]
  );
  assert.equal(
    planBlockTermManagementDispatch(command("screen:resize", [], { cols: "144", include: "404" }), base).code,
    "unknown-line"
  );
  assert.equal(
    planBlockTermManagementDispatch(command("screen:resize", [], { cols: "144", include: "20," }), base).code,
    "invalid-value"
  );
  assert.equal(
    planBlockTermManagementDispatch(command("screen:resize", [], { cols: "144", exclude: "20,30" }), base)
      .actions[0].childTargets,
    undefined
  );
});

test("rejects stale independent resize ownership proofs", () => {
  const staleScope = snapshot({
    scopeGeneration: 8,
    blocks: [block("child", 10, { terminalId: "session-a", status: "running" })],
    independentBindings: [
      { sessionId: "session-a", blockId: "child", blockToken: "token-a", scopeGeneration: 7 },
    ],
  });
  const emptyToken = snapshot({
    scopeGeneration: 7,
    blocks: [block("child", 10, { terminalId: "session-a", status: "running" })],
    independentBindings: [
      { sessionId: "session-a", blockId: "child", blockToken: "", scopeGeneration: 7 },
    ],
  });
  for (const candidate of [staleScope, emptyToken]) {
    assert.equal(isBlockTermManagementIndependentBlock(candidate, candidate.blocks[0]), false);
    assert.equal(
      planBlockTermManagementDispatch(command("screen:resize", [], { cols: "120" }), candidate).actions[0]
        .childTargets,
      undefined
    );
  }
});

test("wires independent resize revalidation and sidebar eligibility in the page", () => {
  const source = readFileSync(new URL("../src/components/terminal/blockterm-page.tsx", import.meta.url), "utf8");
  assert.match(source, /const isCurrentIndependentBlockOwner = useCallback/u);
  assert.match(
    source,
    /const isSidebarEligibleBlock = useCallback\([\s\S]*?!isActiveBlockStatus\(status\) \|\| isCurrentIndependentBlockOwner/u
  );
  assert.match(source, /independentBindings\.push\([\s\S]*?scopeGeneration: requestScopeGeneration/u);
  assert.match(source, /for \(const childTarget of action\.childTargets \|\| \[\]\)/u);
  assert.match(source, /binding\.token !== childTarget\.blockToken/u);
  assert.match(source, /runtime\.scopeGeneration !== requestScopeGeneration/u);
  assert.match(
    source,
    /const resizeBlockRuntime = useCallback\([\s\S]*?!isCurrentIndependentBlockOwner\(sessionId, blockId\)[\s\S]*?createBlockTermRoutedResizeMessage\(cols, rows, runtime\.route\)[\s\S]*?updateSessionBlock\(sessionId, blockId, \{ termCols: cols, termRows: rows \}\)/u
  );
  assert.match(source, /const observer = new ResizeObserver\([\s\S]*?onResize\(blockId\)/u);
  assert.match(
    source,
    /if \(!current\.allowReconnect \|\| \(blockStatusRef\.current\[blockId\] \?\? currentBlock\?\.status\) !== "running"\)[\s\S]{0,500}?reconcileBlockRuntimeRef\.current\(sessionId, blockId, blockToken, scopeGeneration\)/u
  );
  assert.doesNotMatch(
    source,
    /resizeBlockRuntime\(target\.id, childTarget\.blockId, action\.cols, action\.rows\)[\s\S]{0,300}?updateBlockState\(/u
  );
  assert.match(source, /disabled=\{!isSidebarEligibleBlock\(activeSession\.id, block\) \|\| isDeleting\}/u);
});

test("preserves parser and unsupported results as non-executable errors", () => {
  const base = snapshot();
  assert.equal(
    planBlockTermManagementDispatch({ kind: "error", raw: "/clear", code: "invalid-command", message: "bad" }, base).code,
    "parser-error"
  );
  assert.equal(
    planBlockTermManagementDispatch(
      {
        kind: "unsupported",
        raw: "/screen:archive",
        name: "screen",
        commandName: "screen:archive",
        subcommand: "archive",
        args: [],
        kwargs: {},
        code: "unsupported",
        supported: false,
        message: "unsupported",
      },
      base
    ).code,
    "unsupported"
  );
  assert.deepEqual(planBlockTermManagementDispatch({ kind: "shell", raw: "echo hi", command: "echo hi" }, base), {
    kind: "not-applicable",
  });
});

test("wires connection actions, block runtime context, restart ownership, and history refill in the page", () => {
  const source = readFileSync(new URL("../src/components/terminal/blockterm-page.tsx", import.meta.url), "utf8");
  assert.match(source, /case "set-connection":[\s\S]*?setNextConnectionContext\(sessionId/u);
  assert.match(source, /case "set-connection":[\s\S]*?sshApi\.listProfiles\(\)[\s\S]*?resolveBlockTermSSHProfileReference/u);
  assert.match(source, /const completedAt = durableBlock\.finishedAt[\s\S]*?isSameBlockTermConnectionIdentity/u);
  assert.match(source, /case "open-connection-selector":[\s\S]*?setSSHSelectionSessionId\(sessionId\)/u);
  assert.match(
    source,
    /sshSelectionScopeRef\.current[\s\S]*?scopeGenerationRef\.current !== target\.scopeGeneration[\s\S]*?isCurrentWorkspaceTransition/u
  );
  assert.match(source, /const connection = resolveSessionConnectionContext\(session\)/u);
  assert.match(source, /runtimeType: connection\.runtimeType,[\s\S]*?sshProfileId: connection\.sshProfileId/u);
  assert.match(
    source,
    /const createdRuntime = await blockTermApi\.createRuntime\([\s\S]*?await blockTermApi\.getRuntime\(sessionId, blockId, blockToken\)[\s\S]*?connectBlockRuntimeRef\.current\(sessionId, blockId, blockToken, expectedScopeGeneration\)/u
  );
  assert.match(
    source,
    /const connection = resolveBlockTermConnectionContext\(\{\s*block: candidate\.block,\s*session: candidate\.session/u
  );
  assert.match(source, /runtimeType=\{block\.runtimeType\}/u);
  assert.match(source, /runtimeType=\{sidebarBlock\.runtimeType\}/u);
  assert.match(source, /const useHistoryCommand = useCallback\([\s\S]*?setHistoryCenterOpen\(false\)/u);
  assert.match(source, /onUseCommand=\{useHistoryCommand\}/u);

  const dialogSource = readFileSync(
    new URL("../src/components/terminal/ssh-connection-dialog.tsx", import.meta.url),
    "utf8"
  );
  assert.match(dialogSource, /if \(selectionOnly\) \{\s*await sshApi\.connect\(attempt\.profile\.id, attempt\.auth\)/u);
  assert.match(dialogSource, /await onSelectProfile\?\.\(attempt\.profile\)/u);
});
