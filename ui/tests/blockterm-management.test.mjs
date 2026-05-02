import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BLOCKTERM_MANAGEMENT_INPUT_BYTES,
  MAX_BLOCKTERM_MANAGEMENT_KWARGS,
  MAX_BLOCKTERM_MANAGEMENT_TOKEN_BYTES,
  MAX_BLOCKTERM_MANAGEMENT_TOKENS,
  isBlockTermManagementResult,
  parseBlockTermManagementCommand,
  tokenizeBlockTermManagement,
} from "../src/components/terminal/blockterm-management.ts";

test("keeps the raw shell body for /run, including shell operators and assignments", () => {
  assert.deepEqual(parseBlockTermManagementCommand("/run printf '%s\\n' a | sed s/a/b/ > out.txt"), {
    kind: "management",
    raw: "/run printf '%s\\n' a | sed s/a/b/ > out.txt",
    name: "run",
    commandName: "run",
    args: ["printf '%s\\n' a | sed s/a/b/ > out.txt"],
    kwargs: {},
    command: "printf '%s\\n' a | sed s/a/b/ > out.txt",
  });
  assert.deepEqual(parseBlockTermManagementCommand("[rtnstate=1 view=markdown] /run FOO=bar echo \"$FOO\""), {
    kind: "management",
    raw: "[rtnstate=1 view=markdown] /run FOO=bar echo \"$FOO\"",
    name: "run",
    commandName: "run",
    args: ['FOO=bar echo "$FOO"'],
    kwargs: { rtnstate: "1", view: "markdown" },
    command: 'FOO=bar echo "$FOO"',
  });
});

test("leaves incomplete /run shell syntax untouched for the shell to diagnose", () => {
  for (const command of ['echo "unterminated', "printf '%s", "echo trailing\\", "echo $(unfinished", "echo `unfinished"]) {
    const raw = `/run ${command}`;
    assert.deepEqual(parseBlockTermManagementCommand(raw), {
      kind: "management",
      raw,
      name: "run",
      commandName: "run",
      args: [command],
      kwargs: {},
      command,
    });
  }
});

test("classifies root and namespaced management commands", () => {
  assert.deepEqual(parseBlockTermManagementCommand("/clear archive=true"), {
    kind: "management",
    raw: "/clear archive=true",
    name: "clear",
    commandName: "clear",
    args: [],
    kwargs: { archive: "true" },
  });
  assert.deepEqual(parseBlockTermManagementCommand("/signal 'line 1' SIGTERM"), {
    kind: "management",
    raw: "/signal 'line 1' SIGTERM",
    name: "signal",
    commandName: "signal",
    args: ["line 1", "SIGTERM"],
    kwargs: {},
  });
  assert.deepEqual(parseBlockTermManagementCommand("/line:star 2 1"), {
    kind: "management",
    raw: "/line:star 2 1",
    name: "line",
    commandName: "line:star",
    subcommand: "star",
    args: ["2", "1"],
    kwargs: {},
  });
  assert.deepEqual(parseBlockTermManagementCommand("/sidebar:add line=2 width='50%'"), {
    kind: "management",
    raw: "/sidebar:add line=2 width='50%'",
    name: "sidebar",
    commandName: "sidebar:add",
    subcommand: "add",
    args: [],
    kwargs: { line: "2", width: "50%" },
  });
  assert.deepEqual(parseBlockTermManagementCommand("/screen dev"), {
    kind: "management",
    raw: "/screen dev",
    name: "screen",
    commandName: "screen",
    args: ["dev"],
    kwargs: {},
  });
  assert.deepEqual(parseBlockTermManagementCommand("/screen:open name='dev shell' activate=false"), {
    kind: "management",
    raw: "/screen:open name='dev shell' activate=false",
    name: "screen",
    commandName: "screen:open",
    subcommand: "open",
    args: [],
    kwargs: { name: "dev shell", activate: "false" },
  });
  assert.deepEqual(parseBlockTermManagementCommand("/reset:cwd"), {
    kind: "management",
    raw: "/reset:cwd",
    name: "reset",
    commandName: "reset:cwd",
    subcommand: "cwd",
    args: [],
    kwargs: {},
  });
  assert.deepEqual(parseBlockTermManagementCommand("/sync"), {
    kind: "management",
    raw: "/sync",
    name: "sync",
    commandName: "sync",
    args: [],
    kwargs: {},
  });
});

test("supports WaveTerm-style bracket kwargs, bare kwargs, quoting, and override order", () => {
  assert.deepEqual(
    parseBlockTermManagementCommand(
      "[width='500 px' nohist] /sidebar:open width=50% 'literal=value' label=hello\\ world"
    ),
    {
      kind: "management",
      raw: "[width='500 px' nohist] /sidebar:open width=50% 'literal=value' label=hello\\ world",
      name: "sidebar",
      commandName: "sidebar:open",
      subcommand: "open",
      args: ["literal=value"],
      kwargs: { width: "50%", nohist: "1", label: "hello world" },
    }
  );
  assert.deepEqual(parseBlockTermManagementCommand("/line:set 7 renderer=markdown state=$'{\"x\":1}'"), {
    kind: "management",
    raw: "/line:set 7 renderer=markdown state=$'{\"x\":1}'",
    name: "line",
    commandName: "line:set",
    subcommand: "set",
    args: ["7"],
    kwargs: { renderer: "markdown", state: '{"x":1}' },
  });
});

test("recognizes connect commands and keeps architecture-incompatible screen commands unsupported", () => {
  const result = parseBlockTermManagementCommand("/connect user@example.com shell=bash");
  assert.deepEqual(result, {
    kind: "management",
    raw: "/connect user@example.com shell=bash",
    name: "connect",
    commandName: "connect",
    args: ["user@example.com"],
    kwargs: { shell: "bash" },
  });
  assert.equal(isBlockTermManagementResult(result), true);
  assert.equal(isBlockTermManagementResult(parseBlockTermManagementCommand("echo ok")), false);
  for (const command of ["screen:archive", "screen:reset", "screen:webshare", "screen:termtheme"]) {
    const unsupported = parseBlockTermManagementCommand(`/${command}`);
    assert.equal(unsupported.kind, "unsupported");
    assert.equal(unsupported.commandName, command);
    assert.equal(unsupported.code, "unsupported");
    assert.equal(isBlockTermManagementResult(unsupported), true);
  }
});

test("recognizes every supported screen route instead of passing it to the shell", () => {
  for (const command of [
    "/screen target",
    "/screen:open",
    "/screen:new",
    "/screen:delete",
    "/screen:set name=dev",
    "/screen:reorder index=1",
    "/screen:show",
    "/screen:showall",
    "/screen:resize cols=120",
    "/reset",
    "/reset:cwd",
    "/sync",
  ]) {
    assert.equal(parseBlockTermManagementCommand(command).kind, "management", command);
  }
});

test("passes unknown, quoted, escaped, and embedded slash commands to the shell unchanged", () => {
  for (const source of [
    "/unknown one two",
    '"/run" echo hi',
    "'/clear'",
    "\\/signal 1 INT",
    "echo /line:delete 1",
    "[ -f file ] && echo ok",
    "   /future:command key=value",
  ]) {
    assert.deepEqual(parseBlockTermManagementCommand(source), { kind: "shell", raw: source, command: source });
  }
});

test("reports malformed known commands and namespace errors", () => {
  assert.deepEqual(
    {
      code: parseBlockTermManagementCommand("/line").code,
      message: parseBlockTermManagementCommand("/line").message,
    },
    { code: "missing-subcommand", message: "/line requires a subcommand" }
  );
  assert.equal(parseBlockTermManagementCommand("/line:explode 1").code, "unknown-subcommand");
  assert.equal(parseBlockTermManagementCommand("/screen:explode 1").code, "unknown-subcommand");
  assert.equal(parseBlockTermManagementCommand("/reset:all").code, "unknown-subcommand");
  assert.equal(parseBlockTermManagementCommand("/clear:all").code, "unknown-subcommand");
  assert.equal(parseBlockTermManagementCommand("/line:").code, "invalid-command");
  assert.equal(parseBlockTermManagementCommand("/sidebar:open | cat").code, "unsupported-operator");
  assert.equal(parseBlockTermManagementCommand("/signal 'unterminated").code, "unterminated-quote");
  assert.equal(parseBlockTermManagementCommand("/signal line\\").code, "trailing-escape");
  assert.equal(parseBlockTermManagementCommand("/run").code, "missing-command");
});

test("rejects malformed management bracket args without claiming ordinary shell brackets", () => {
  assert.equal(parseBlockTermManagementCommand("[bad-name=1] /clear").code, "invalid-kwarg");
  assert.equal(parseBlockTermManagementCommand("[width='unterminated] /sidebar:open").code, "invalid-bracket-args");
  assert.deepEqual(parseBlockTermManagementCommand("[unterminated"), {
    kind: "shell",
    raw: "[unterminated",
    command: "[unterminated",
  });
});

test("enforces input, token, token-count, and kwarg-count bounds", () => {
  assert.equal(
    parseBlockTermManagementCommand(`/clear ${"x".repeat(MAX_BLOCKTERM_MANAGEMENT_TOKEN_BYTES + 1)}`).code,
    "token-too-large"
  );
  assert.equal(
    parseBlockTermManagementCommand(`/signal ${Array(MAX_BLOCKTERM_MANAGEMENT_TOKENS + 1).fill("x").join(" ")}`).code,
    "too-many-tokens"
  );
  assert.equal(
    parseBlockTermManagementCommand(
      `/clear ${Array.from({ length: MAX_BLOCKTERM_MANAGEMENT_KWARGS + 1 }, (_, index) => `k${index}=1`).join(" ")}`
    ).code,
    "too-many-kwargs"
  );
  assert.equal(
    parseBlockTermManagementCommand(`/${"x".repeat(MAX_BLOCKTERM_MANAGEMENT_INPUT_BYTES)}`).code,
    "input-too-large"
  );
});

test("rejects prototype keys and does not mutate object prototypes", () => {
  const before = {}.polluted;
  for (const source of [
    "[__proto__=polluted] /clear",
    "[constructor=polluted] /clear",
    "/clear __proto__=polluted",
    "/clear prototype=polluted",
  ]) {
    const result = parseBlockTermManagementCommand(source);
    assert.equal(result.kind, "error");
    assert.equal(result.code, "invalid-kwarg");
  }
  assert.equal({}.polluted, before);
});

test("exports the bounded shell-word tokenizer for focused integration tests", () => {
  assert.deepEqual(tokenizeBlockTermManagement("one 'two three' four\\ five"), {
    ok: true,
    tokens: [
      { value: "one", startsQuoted: false, start: 0, end: 3 },
      { value: "two three", startsQuoted: true, start: 4, end: 15 },
      { value: "four five", startsQuoted: false, start: 16, end: 26 },
    ],
  });
  assert.equal(tokenizeBlockTermManagement("one | two").code, "unsupported-operator");
});
