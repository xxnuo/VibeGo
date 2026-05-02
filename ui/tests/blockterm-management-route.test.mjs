import assert from "node:assert/strict";
import test from "node:test";

import { planBlockTermManagementDispatch } from "../src/components/terminal/blockterm-management-dispatch.ts";
import { parseBlockTermManagementCommand } from "../src/components/terminal/blockterm-management.ts";

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
    sessions: [session("session-a", "dev"), session("session-b", "build")],
    sessionStatus: "ready",
    activeBlockId: null,
    selectedBlockId: "block-2",
    blocks: [block("block-1", 10), block("block-2", 20)],
    view: { sidebar: { open: false, width: "50%", blockId: null } },
    ...overrides,
  };
}

function route(input, state = snapshot()) {
  return planBlockTermManagementDispatch(parseBlockTermManagementCommand(input), state);
}

test("routes parsed kwargs into clear and sidebar actions", () => {
  assert.deepEqual(route("/clear archive=true"), {
    kind: "plan",
    commandName: "clear",
    actions: [{ kind: "archive-blocks", sessionId: "session-a", blockIds: ["block-1", "block-2"] }],
  });
  assert.deepEqual(route("[line=10 width=500px] /sidebar:add"), {
    kind: "plan",
    commandName: "sidebar:add",
    actions: [
      {
        kind: "update-view",
        sessionId: "session-a",
        patch: { sidebar: { open: true, blockId: "block-1", width: "500px" } },
      },
    ],
  });
});

test("routes parsed positional and renderer arguments into block actions", () => {
  const active = snapshot({
    activeBlockId: "block-1",
    selectedBlockId: "block-1",
    blocks: [block("block-1", 10, { status: "running" }), block("block-2", 20)],
  });
  assert.deepEqual(route("/signal 10 SIGTERM", active), {
    kind: "plan",
    commandName: "signal",
    actions: [{ kind: "signal", sessionId: "session-a", blockId: "block-1", signal: "TERM" }],
  });
  assert.deepEqual(route("/line:set 20 renderer=markdown"), {
    kind: "plan",
    commandName: "line:set",
    actions: [
      {
        kind: "switch-renderer",
        sessionId: "session-a",
        blockId: "block-2",
        renderer: "markdown",
      },
    ],
  });
});

test("routes screen, shell-state, and cross-workspace line commands with scope ids", () => {
  assert.deepEqual(route("/screen build"), {
    kind: "plan",
    commandName: "screen",
    actions: [
      {
        kind: "select-screen",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        targetSessionId: "session-b",
      },
    ],
  });
  assert.deepEqual(route("/screen:open name='scratch tab' activate=0"), {
    kind: "plan",
    commandName: "screen:open",
    actions: [
      {
        kind: "create-screen",
        sessionId: "session-a",
        workspaceSessionId: "workspace-a",
        groupId: "group-a",
        name: "scratch tab",
        activate: false,
      },
    ],
  });
  assert.equal(route("/reset:cwd").actions[0].kind, "reset-session-cwd");
  assert.deepEqual(route("/line:view workspace-b logs 42").actions, [
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
});

test("routes connect and does not plan actions for parser errors, unsupported commands, or shell input", () => {
  assert.deepEqual(route("/sidebar:open | cat"), {
    kind: "error",
    commandName: "sidebar:open",
    code: "parser-error",
    message: 'shell operator "|" is not supported in a management command',
  });
  assert.deepEqual(route("/connect user@example.com"), {
    kind: "plan",
    commandName: "connect",
    actions: [
      {
        kind: "set-connection",
        sessionId: "session-a",
        runtimeType: "ssh",
        sshProfileId: "user@example.com",
      },
    ],
  });
  assert.equal(route("/screen:archive").code, "unsupported");
  assert.equal(route("/screen:reset").code, "unsupported");
  assert.equal(route("/screen:webshare").code, "unsupported");
  assert.equal(route("/screen:termtheme").code, "unsupported");
  assert.deepEqual(route("echo /clear"), { kind: "not-applicable" });
});
