import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  BEL,
  BLOCKTERM_HANDSHAKE_BUFFER_MAX_BYTES,
  ESC,
  MARK_PREFIX,
  applyBlockTermCompletion,
  appendRecentCommand,
  concatBlockTermBytes,
  buildWrappedCommand,
  createBlockTermInputMessage,
  createBlockTermPendingChunkQueue,
  createBlockTermSignalMessage,
  decodeBase64Bytes,
  discardTerminalParserTail,
  drainBlockTermPendingChunkQueue,
  encodeUtf8Base64,
  escapeShellSingleQuoted,
  enqueueBlockTermMessageTask,
  enqueueBlockTermPendingChunk,
  extractSegmentsFromBuffer,
  extractSegmentsFromBytes,
  flushTerminalProjectionDecoder,
  generateBlockTermToken,
  guardLeadingBlockTermExec,
  hasBlockTermPendingStartFrame,
  getBlockMutationFocusTarget,
  getBlockTermLifecycleMetadata,
  getBlockTermEstimatedBlockHeight,
  getBlockTermPresentationHeight,
  getBlockNavigationTarget,
  getVisibleOrderedBlocks,
  missingReplayByteSuffix,
  moveBlockTermCompletionSelection,
  navigateBlockHistory,
  parseBlockTermNoteCommand,
  parseBlockTermCompletionContext,
  recentCommandHistory,
  resolveBlockTermCompletion,
  resolveBlockTermCompletionReconcile,
  resolveBlockTermConnectionContext,
  resolveBlockTermConnectionCwd,
  resolveBlockTermNextConnectionContext,
  resolveBlockTermFrameAcceptance,
  resolveBlockTermFrameDisposition,
  resolveBlockTermInterruptedStateBinding,
  resolveBlockTermInterruptedState,
  resolveBlockTermOutputOwner,
  resolveBlockTermStateBinding,
  resolveBlockTermStateBindings,
  isSameBlockTermConnectionIdentity,
  resolveBlockTermStartActivation,
  resolveBlockTermCorrelatedCompletions,
  resolveCreatedBlockSelection,
  resolveDraftAfterCommandPublish,
  resolveVisibleBlockSelection,
  serializeBlockTermShellState,
  setBlockTermPresentationHeight,
  shouldHandleBlockTermInputRejected,
  shouldInterruptBlockTermStateBinding,
  shouldRestoreBlockTermSignalFailure,
  shouldRecordBlockTermHistory,
  shouldRouteRejectedBlockTermFrame,
  shouldSeedBlockTermToken,
  shouldUseTerminalMode,
  takeTerminalParserTail,
} from "../src/components/terminal/blockterm-model.ts";

const BLOCK_TOKEN = "0123456789abcdef".repeat(4);
const OTHER_BLOCK_TOKEN = "fedcba9876543210".repeat(4);

test("resets cwd when a future block switches connection identity", () => {
  assert.deepEqual(
    resolveBlockTermConnectionContext({
      block: { runtimeType: "ssh", sshProfileId: "profile-block", cwd: "/remote/block" },
      next: { runtimeType: "ssh", sshProfileId: "profile-next", cwd: "/remote/next" },
      session: { runtimeType: "local", cwd: "/local/session" },
    }),
    { runtimeType: "ssh", sshProfileId: "profile-block", cwd: "/remote/block" }
  );
  assert.deepEqual(
    resolveBlockTermConnectionContext({
      next: { runtimeType: "ssh", sshProfileId: "profile-next", cwd: "/remote/next" },
      session: { runtimeType: "local", cwd: "/local/session" },
    }),
    { runtimeType: "ssh", sshProfileId: "profile-next", cwd: "/remote/next" }
  );
  assert.equal(
    resolveBlockTermConnectionCwd({
      connection: { runtimeType: "ssh", sshProfileId: "profile-b", cwd: "/remote/b" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/remote/a" },
    }),
    "/remote/b"
  );
  assert.equal(
    resolveBlockTermConnectionCwd({
      connection: { runtimeType: "ssh", sshProfileId: "profile-b" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/remote/a" },
    }),
    "."
  );
  assert.equal(
    resolveBlockTermConnectionCwd({
      connection: { runtimeType: "local" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/remote/a" },
    }),
    "."
  );
  assert.equal(
    resolveBlockTermConnectionCwd({
      connection: { runtimeType: "ssh", sshProfileId: "profile-a" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/remote/a" },
    }),
    "/remote/a"
  );
  assert.equal(isSameBlockTermConnectionIdentity({ runtimeType: "local" }, { runtimeType: "local" }), true);
});

test("persists a portable cwd when the next connection identity changes", () => {
  const session = { runtimeType: "local", cwd: "/work/local" };
  assert.deepEqual(
    resolveBlockTermNextConnectionContext({
      requested: { runtimeType: "ssh", sshProfileId: "profile-a" },
      current: session,
      session,
    }),
    { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "." }
  );
  assert.deepEqual(
    resolveBlockTermNextConnectionContext({
      requested: { runtimeType: "ssh", sshProfileId: "profile-b" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/a" },
      session: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/a" },
    }),
    { runtimeType: "ssh", sshProfileId: "profile-b", cwd: "." }
  );
  assert.deepEqual(
    resolveBlockTermNextConnectionContext({
      requested: { runtimeType: "ssh", sshProfileId: "profile-a" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/a" },
      session: { runtimeType: "local", cwd: "/work/local" },
    }),
    { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/a" }
  );
  assert.deepEqual(
    resolveBlockTermNextConnectionContext({
      requested: { runtimeType: "local" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/a" },
      session,
    }),
    { runtimeType: "local", cwd: "/work/local" }
  );
  assert.deepEqual(
    resolveBlockTermNextConnectionContext({
      requested: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/new" },
      current: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/a" },
      session,
    }),
    { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/srv/new" }
  );
});

function findTestZsh() {
  const candidates = [
    process.env.VIBEGO_TEST_ZSH,
    process.env.SHELL?.endsWith("/zsh") ? process.env.SHELL : undefined,
    "/bin/zsh",
    "/usr/bin/zsh",
    "zsh",
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", stdio: "ignore" });
    if (result.status === 0 && !result.error) return candidate;
  }
  return null;
}

const TEST_ZSH = process.platform === "linux" ? findTestZsh() : null;

test("round-trips persisted BlockTerm presentation heights", () => {
  assert.equal(getBlockTermPresentationHeight(undefined), null);
  assert.equal(getBlockTermPresentationHeight('{"height":-1}'), null);
  assert.equal(getBlockTermPresentationHeight('{"height":240,"sidebar":{"open":true}}'), 240);
  assert.equal(getBlockTermPresentationHeight('{"height":0}'), 0);
  assert.equal(getBlockTermPresentationHeight('{"height":2}'), 2);
  assert.equal(getBlockTermPresentationHeight('{"height":100000}'), 10000);
  assert.equal(
    setBlockTermPresentationHeight('{"sidebar":{"open":true}}', 318.4),
    '{"sidebar":{"open":true},"height":318}'
  );
  assert.equal(
    setBlockTermPresentationHeight('{"height":0,"sidebar":{"open":true},"unknown":true}', 2),
    '{"height":2,"sidebar":{"open":true}}'
  );
  assert.equal(setBlockTermPresentationHeight('{bad', 99), '{"height":99}');
  assert.equal(
    getBlockTermEstimatedBlockHeight({ collapsed: false, mode: "text", presentationJson: '{"height":420}' }),
    420
  );
  assert.equal(
    getBlockTermEstimatedBlockHeight({ collapsed: true, mode: "terminal", presentationJson: '{"height":420}' }),
    54
  );
  assert.equal(getBlockTermEstimatedBlockHeight({ collapsed: false, mode: "terminal" }), 480);
});

test("wraps multiline commands in one token-bearing physical shell line", () => {
  const command = "printf '%s\\n' 'hello;world'\nprintf 'line2\\n'";
  const wrapped = buildWrappedCommand(command, "block-1", BLOCK_TOKEN);
  const physicalLines = wrapped.trimEnd().split("\n");
  assert.equal(physicalLines.length, 2);
  assert.equal(physicalLines[0].includes(BLOCK_TOKEN), false);
  assert.equal(physicalLines[1].includes(BLOCK_TOKEN), true);
  assert.equal(wrapped.startsWith(" "), true);
  assert.match(wrapped, /builtin history -d "\$HISTCMD"/);
  assert.match(wrapped, /__vibego_blockterm_tty_state=\$\(command stty -g/);
  assert.match(wrapped, /stty -opost/);
  assert.match(wrapped, /stty "\$__vibego_blockterm_tty_state"/);
  assert.match(wrapped, /command printf '\\033\]633;/);

  const result = spawnSync("/bin/bash", ["--noprofile", "--norc"], {
    input: wrapped,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = extractSegmentsFromBuffer(result.stdout);
  assert.equal(parsed.rest, "");
  assert.equal(parsed.segments[0].type, "frame");
  assert.deepEqual(
    { ...parsed.segments[0].frame, shellPid: undefined },
    {
      kind: "start",
      id: "block-1",
      protocolVersion: "v3",
      blockToken: BLOCK_TOKEN,
      cwd: process.cwd(),
      command,
      shellPid: undefined,
    }
  );
  assert.equal(Number.isSafeInteger(parsed.segments[0].frame.shellPid), true);
  assert.equal(parsed.segments[0].frame.shellPid > 0, true);
  assert.equal(parsed.segments[1].type, "text");
  assert.equal(parsed.segments[1].value, "hello;world\nline2\n");
  assert.equal(parsed.segments[2].type, "frame");
  assert.equal(parsed.segments[2].frame.kind, "end");
  assert.equal(parsed.segments[2].frame.protocolVersion, "v3");
  assert.equal(parsed.segments[2].frame.blockToken, BLOCK_TOKEN);
  assert.equal(parsed.segments[2].frame.exitCode, 0);
});

test(
  "keeps the lifecycle token out of interactive Bash history",
  { skip: process.platform !== "linux" },
  () => {
    for (const historyControl of ["", "ignorespace"]) {
      const historyDir = mkdtempSync(join(process.cwd(), ".blockterm-history-"));
      const historyFile = join(historyDir, "history");
      try {
        const command = `command printf '\\036VIBEGO_HISTORY_DURING:%s\\037' "$(builtin history 20)"`;
        const wrapped = buildWrappedCommand(command, `history-${historyControl || "unset"}`, BLOCK_TOKEN);
        const result = spawnSync("script", ["-qefc", "/bin/bash --noprofile --norc", "/dev/null"], {
          input: [
            "stty -echo",
            `HISTFILE=${JSON.stringify(historyFile)}`,
            "HISTSIZE=100",
            "HISTFILESIZE=100",
            `HISTCONTROL=${historyControl}`,
            "export HISTFILE HISTSIZE HISTFILESIZE HISTCONTROL",
            "builtin history -c",
            "echo VIBEGO_HISTORY_KEEP",
            wrapped.trimEnd(),
            `command printf '\\036VIBEGO_HISTORY_AFTER:%s\\037' "$(builtin history 20)"`,
            "builtin history -w",
            "exit",
            "",
          ].join("\n"),
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, result.stderr);

        const readMarkedHistory = (label) => {
          const start = result.stdout.indexOf(`\x1e${label}:`);
          assert.notEqual(start, -1, `${label} marker missing with HISTCONTROL=${historyControl}`);
          const valueStart = start + label.length + 2;
          const end = result.stdout.indexOf("\x1f", valueStart);
          assert.notEqual(end, -1, `${label} terminator missing with HISTCONTROL=${historyControl}`);
          return result.stdout.slice(valueStart, end);
        };

        const during = readMarkedHistory("VIBEGO_HISTORY_DURING");
        const after = readMarkedHistory("VIBEGO_HISTORY_AFTER");
        assert.match(during, /VIBEGO_HISTORY_KEEP/);
        assert.match(after, /VIBEGO_HISTORY_KEEP/);
        assert.equal(during.includes(BLOCK_TOKEN), false, `token exposed during command with ${historyControl}`);
        assert.equal(after.includes(BLOCK_TOKEN), false, `token retained after command with ${historyControl}`);

        const persisted = readFileSync(historyFile, "utf8");
        assert.match(persisted, /VIBEGO_HISTORY_KEEP/);
        assert.equal(persisted.includes(BLOCK_TOKEN), false, `token persisted with HISTCONTROL=${historyControl}`);
      } finally {
        rmSync(historyDir, { recursive: true, force: true });
      }
    }
  }
);

test(
  "keeps the lifecycle token out of interactive zsh history",
  { skip: TEST_ZSH === null },
  () => {
    const historyDir = mkdtempSync(join(process.cwd(), ".blockterm-zsh-history-"));
    const historyFile = join(historyDir, "history");
    try {
      writeFileSync(
        join(historyDir, ".zshrc"),
        "unsetopt HIST_IGNORE_SPACE\ncommand printf '\\036VIBEGO_ZSH_RC_UNSET\\037'\n",
        "utf8"
      );
      const command = `command printf '\\036VIBEGO_ZSH_EXECUTED\\037'; command printf '\\036VIBEGO_ZSH_HISTORY_DURING:%s\\037' "$(builtin fc -l -20 2>/dev/null)"`;
      const wrapped = buildWrappedCommand(command, "zsh-history", BLOCK_TOKEN);
      const shellCommand = `${escapeShellSingleQuoted(TEST_ZSH)} -d -o HIST_IGNORE_SPACE`;
      const result = spawnSync("script", ["-qefc", shellCommand, "/dev/null"], {
        input: [
          "stty -echo",
          `HISTFILE=${JSON.stringify(historyFile)}`,
          "HISTSIZE=100",
          "SAVEHIST=100",
          "setopt APPEND_HISTORY",
          "builtin fc -p \"$HISTFILE\"",
          "command printf VIBEGO_ZSH_HISTORY_KEEP",
          wrapped.trimEnd(),
          `command printf '\\036VIBEGO_ZSH_HISTORY_AFTER:%s\\037' "$(builtin fc -l -20 2>/dev/null)"`,
          "builtin fc -W \"$HISTFILE\"",
          "exit",
          "",
        ].join("\n"),
        encoding: "utf8",
        env: { ...process.env, ZDOTDIR: historyDir },
        maxBuffer: 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes("\x1eVIBEGO_ZSH_RC_UNSET\x1f"), true, ".zshrc override did not run");
      assert.equal(result.stdout.includes("\x1eVIBEGO_ZSH_EXECUTED\x1f"), true, "wrapped zsh command did not execute");
      const parsed = extractSegmentsFromBuffer(result.stdout);
      const frames = parsed.segments.filter((segment) => segment.type === "frame").map((segment) => segment.frame);
      assert.equal(
        frames.some((frame) => frame.kind === "start" && frame.id === "zsh-history" && frame.blockToken === BLOCK_TOKEN),
        true,
        "zsh start frame missing"
      );
      assert.equal(
        frames.some(
          (frame) =>
            frame.kind === "end" && frame.id === "zsh-history" && frame.blockToken === BLOCK_TOKEN && frame.exitCode === 0
        ),
        true,
        "zsh end frame missing"
      );

      const readMarkedHistory = (label) => {
        const start = result.stdout.indexOf(`\x1e${label}:`);
        assert.notEqual(start, -1, `${label} marker missing`);
        const valueStart = start + label.length + 2;
        const end = result.stdout.indexOf("\x1f", valueStart);
        assert.notEqual(end, -1, `${label} terminator missing`);
        return result.stdout.slice(valueStart, end);
      };
      const during = readMarkedHistory("VIBEGO_ZSH_HISTORY_DURING");
      const after = readMarkedHistory("VIBEGO_ZSH_HISTORY_AFTER");
      assert.match(during, /VIBEGO_ZSH_HISTORY_KEEP/);
      assert.match(after, /VIBEGO_ZSH_HISTORY_KEEP/);
      assert.equal(during.includes(BLOCK_TOKEN), false, "zsh token exposed during command");
      assert.equal(after.includes(BLOCK_TOKEN), false, "zsh token retained after command");
      assert.equal(after.includes("__vibego_blockterm_exit"), false, "zsh wrapper remained in interactive history");

      const persisted = readFileSync(historyFile, "utf8");
      assert.match(persisted, /VIBEGO_ZSH_HISTORY_KEEP/);
      assert.equal(persisted.includes(BLOCK_TOKEN), false, "zsh token persisted to history");
      assert.equal(persisted.includes("__vibego_blockterm_exit"), false, "zsh wrapper persisted to history");
    } finally {
      rmSync(historyDir, { recursive: true, force: true });
    }
  }
);

test("runs a leading exec command without replacing the persistent shell", () => {
  assert.equal(guardLeadingBlockTermExec("exec bash --noprofile --norc"), "command bash --noprofile --norc");
  assert.equal(guardLeadingBlockTermExec("  exec env FOO=bar sh"), "  command env FOO=bar sh");
  assert.equal(guardLeadingBlockTermExec("echo exec bash"), "echo exec bash");
  assert.equal(guardLeadingBlockTermExec("exec -a child bash"), "exec -a child bash");
  assert.equal(guardLeadingBlockTermExec("exec >output.log"), "exec >output.log");
});

test("adds a correlated block id and token only to managed command input messages", () => {
  assert.deepEqual(createBlockTermInputMessage("printf '你好\\n'", "block-real", BLOCK_TOKEN), {
    type: "input",
    data: encodeUtf8Base64("printf '你好\\n'"),
    block_id: "block-real",
    block_token: BLOCK_TOKEN,
  });
  const interactive = createBlockTermInputMessage("x");
  assert.deepEqual(interactive, { type: "input", data: encodeUtf8Base64("x") });
  assert.equal(Object.hasOwn(interactive, "block_id"), false);
  assert.equal(Object.hasOwn(interactive, "block_token"), false);
  assert.deepEqual(createBlockTermInputMessage("x", "block-without-token"), interactive);
});

test("creates cryptographic BlockTerm tokens and bound signal messages", () => {
  const first = generateBlockTermToken();
  const second = generateBlockTermToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.deepEqual(createBlockTermSignalMessage("INT", "block-real", BLOCK_TOKEN), {
    type: "signal",
    signal: "INT",
    block_id: "block-real",
    block_token: BLOCK_TOKEN,
  });
  assert.deepEqual(createBlockTermSignalMessage("TERM", "block-old"), {
    type: "signal",
    signal: "TERM",
    block_id: "block-old",
  });
});

test("accepts private OSC frames only for the matching owner phase and token", () => {
  const blocks = [{ id: "block-real", terminalId: "term-a", status: "running" }];
  const start = {
    kind: "start",
    id: "block-real",
    protocolVersion: "v3",
    blockToken: BLOCK_TOKEN,
  };
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: start,
      replay: false,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      blocks,
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: true }
  );
  assert.deepEqual(
    resolveBlockTermStartActivation({ accepted: true, frame: start, sessionId: "term-a" }),
    { sessionId: "term-a", phase: "active" }
  );
  assert.equal(
    resolveBlockTermStartActivation({ accepted: false, frame: start, sessionId: "term-a" }),
    null
  );
  assert.equal(
    resolveBlockTermStartActivation({
      accepted: true,
      frame: { ...start, kind: "end" },
      sessionId: "term-a",
    }),
    null
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: start,
      replay: false,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      blocks,
      blockToken: OTHER_BLOCK_TOKEN,
    }),
    { accepted: false }
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: start,
      replay: true,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      blocks,
    }),
    { accepted: false }
  );
  const replayStartAcceptance = resolveBlockTermFrameAcceptance({
    frame: start,
    replay: true,
    sessionId: "term-a",
    activeBlockId: "block-real",
    activeBlockPhase: { sessionId: "term-a", phase: "expected" },
    blocks,
    blockToken: BLOCK_TOKEN,
  });
  assert.deepEqual(replayStartAcceptance, { accepted: true });
  assert.deepEqual(
    resolveBlockTermStartActivation({ ...replayStartAcceptance, frame: start, sessionId: "term-a" }),
    { sessionId: "term-a", phase: "active" }
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: { ...start, kind: "end" },
      replay: true,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      blocks,
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: false }
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: { kind: "start", id: "block-real", protocolVersion: "v2" },
      replay: true,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      blocks,
    }),
    { accepted: false }
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: start,
      replay: false,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "active" },
      blocks,
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: false }
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: { ...start, kind: "end", exitCode: 0 },
      replay: false,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "active" },
      blocks,
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: true }
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: start,
      replay: true,
      sessionId: "term-b",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-b", phase: "expected" },
      blocks,
    }),
    { accepted: false }
  );
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: start,
      replay: true,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      blocks: [{ ...blocks[0], status: "success" }],
    }),
    { accepted: false }
  );
});

test("restores only the exact interrupted owner reported by running terminal state", () => {
  const blocks = [{ id: "block-real", terminalId: "term-a", status: "interrupted" }];
  const valid = {
    sessionId: "term-a",
    terminalStatus: "running",
    serverBlockId: "block-real",
    serverBlockToken: BLOCK_TOKEN,
    serverBlockPhase: "active",
    blocks,
  };
  assert.deepEqual(resolveBlockTermInterruptedStateBinding(valid), {
    blockId: "block-real",
    blockToken: BLOCK_TOKEN,
    blockPhase: "active",
  });
  assert.deepEqual(resolveBlockTermInterruptedStateBinding({ ...valid, serverBlockPhase: "expected" }), {
    blockId: "block-real",
    blockToken: BLOCK_TOKEN,
    blockPhase: "expected",
  });
  assert.deepEqual(resolveBlockTermInterruptedStateBinding({ ...valid, serverBlockPhase: "prepared" }), {
    blockId: "block-real",
    blockToken: BLOCK_TOKEN,
    blockPhase: "expected",
  });
  assert.equal(resolveBlockTermInterruptedStateBinding({ ...valid, terminalStatus: "exited" }), null);
  assert.equal(resolveBlockTermInterruptedStateBinding({ ...valid, serverBlockId: "block-other" }), null);
  assert.equal(resolveBlockTermInterruptedStateBinding({ ...valid, serverBlockToken: "invalid" }), null);
  assert.equal(resolveBlockTermInterruptedStateBinding({ ...valid, serverBlockPhase: "other" }), null);
  assert.equal(resolveBlockTermInterruptedStateBinding({ ...valid, currentActiveBlockId: "block-other" }), null);
  assert.equal(resolveBlockTermInterruptedStateBinding({ ...valid, localBlockToken: OTHER_BLOCK_TOKEN }), null);
  assert.equal(
    resolveBlockTermInterruptedStateBinding({
      ...valid,
      blocks: [{ ...blocks[0], terminalId: "term-b" }],
    }),
    null
  );
  assert.equal(
    resolveBlockTermInterruptedStateBinding({
      ...valid,
      blocks: [{ ...blocks[0], status: "running" }],
    }),
    null
  );
});

test("resolves a running primary and interrupted tail as independent state bindings", () => {
  const blocks = [
    { id: "block-new", terminalId: "term-a", status: "running" },
    { id: "block-old", terminalId: "term-a", status: "interrupted" },
    { id: "block-foreign", terminalId: "term-b", status: "interrupted" },
  ];
  const dual = {
    sessionId: "term-a",
    terminalStatus: "running",
    serverBlockId: "block-new",
    serverBlockToken: BLOCK_TOKEN,
    serverBlockPhase: "expected",
    serverTailBlockId: "block-old",
    serverTailBlockToken: OTHER_BLOCK_TOKEN,
    serverTailBlockPhase: "active",
    blocks,
  };

  assert.deepEqual(resolveBlockTermStateBindings(dual), {
    primary: { blockId: "block-new", blockToken: BLOCK_TOKEN, blockPhase: "expected" },
    tail: { blockId: "block-old", blockToken: OTHER_BLOCK_TOKEN, blockPhase: "active" },
  });
  assert.deepEqual(resolveBlockTermStateBindings({ ...dual, serverBlockPhase: "prepared" }), {
    primary: { blockId: "block-new", blockToken: BLOCK_TOKEN, blockPhase: "expected" },
    tail: { blockId: "block-old", blockToken: OTHER_BLOCK_TOKEN, blockPhase: "active" },
  });
  assert.deepEqual(
    resolveBlockTermStateBindings({
      ...dual,
      serverBlockId: "block-old",
      serverBlockToken: OTHER_BLOCK_TOKEN,
      serverBlockPhase: "active",
      serverTailBlockId: undefined,
      serverTailBlockToken: undefined,
      serverTailBlockPhase: undefined,
    }),
    {
      primary: null,
      tail: { blockId: "block-old", blockToken: OTHER_BLOCK_TOKEN, blockPhase: "active" },
    }
  );
  assert.deepEqual(resolveBlockTermStateBindings({ ...dual, terminalStatus: "exited" }), {
    primary: null,
    tail: null,
  });
  assert.deepEqual(
    resolveBlockTermStateBindings({
      ...dual,
      serverTailBlockId: "block-foreign",
    }),
    {
      primary: { blockId: "block-new", blockToken: BLOCK_TOKEN, blockPhase: "expected" },
      tail: null,
    }
  );
  assert.deepEqual(
    resolveBlockTermStateBindings({
      ...dual,
      localPrimaryBinding: { blockId: "block-new", blockToken: OTHER_BLOCK_TOKEN },
      localTailBinding: { blockId: "block-old", blockToken: OTHER_BLOCK_TOKEN },
    }),
    {
      primary: null,
      tail: { blockId: "block-old", blockToken: OTHER_BLOCK_TOKEN, blockPhase: "active" },
    }
  );
  assert.deepEqual(
    resolveBlockTermStateBindings({
      ...dual,
      localPrimaryBinding: { blockId: "block-new", blockToken: BLOCK_TOKEN },
      localTailBinding: { blockId: "block-old", blockToken: BLOCK_TOKEN },
    }),
    {
      primary: { blockId: "block-new", blockToken: BLOCK_TOKEN, blockPhase: "expected" },
      tail: null,
    }
  );
  assert.deepEqual(
    resolveBlockTermStateBindings({
      ...dual,
      serverTailBlockPhase: "prepared",
    }),
    {
      primary: { blockId: "block-new", blockToken: BLOCK_TOKEN, blockPhase: "expected" },
      tail: null,
    }
  );
  assert.deepEqual(
    resolveBlockTermStateBindings({
      ...dual,
      serverBlockId: "block-old",
      serverBlockToken: OTHER_BLOCK_TOKEN,
      serverBlockPhase: "expected",
      serverTailBlockId: undefined,
      serverTailBlockToken: undefined,
      serverTailBlockPhase: undefined,
    }),
    { primary: null, tail: null }
  );
});

test("does not interrupt a state binding after completion already released it", () => {
  assert.equal(
    shouldInterruptBlockTermStateBinding({
      blockId: "block-real",
      blockStatus: "running",
      activeBlockId: "block-real",
    }),
    true
  );
  assert.equal(
    shouldInterruptBlockTermStateBinding({
      blockId: "block-real",
      blockStatus: "success",
      activeBlockId: null,
    }),
    false
  );
  assert.equal(
    shouldInterruptBlockTermStateBinding({
      blockId: "block-real",
      blockStatus: "running",
      activeBlockId: "block-new",
    }),
    false
  );
});

test("accepts only a matching live v3 end after the current block is interrupted", () => {
  const blocks = [{ id: "block-real", terminalId: "term-a", status: "interrupted" }];
  const end = {
    kind: "end",
    id: "block-real",
    protocolVersion: "v3",
    blockToken: BLOCK_TOKEN,
    exitCode: 130,
  };
  const input = {
    frame: end,
    replay: false,
    sessionId: "term-a",
    activeBlockId: "block-real",
    interruptedBlockId: "block-real",
    activeBlockPhase: { sessionId: "term-a", phase: "active" },
    blocks,
    blockToken: BLOCK_TOKEN,
  };
  assert.deepEqual(resolveBlockTermFrameAcceptance(input), { accepted: true });
  assert.deepEqual(resolveBlockTermFrameAcceptance({ ...input, frame: { ...end, kind: "start" } }), {
    accepted: false,
  });
  assert.deepEqual(resolveBlockTermFrameAcceptance({ ...input, replay: true }), { accepted: false });
  assert.deepEqual(resolveBlockTermFrameAcceptance({ ...input, blockToken: OTHER_BLOCK_TOKEN }), {
    accepted: false,
  });
  assert.deepEqual(resolveBlockTermFrameAcceptance({ ...input, activeBlockId: "block-new" }), {
    accepted: true,
  });
  assert.deepEqual(resolveBlockTermFrameAcceptance({ ...input, interruptedBlockId: "block-new" }), {
    accepted: false,
  });
});

test("distinguishes replay cleanup ends from running lifecycle completion", () => {
  const blocks = [
    { id: "block-tail", terminalId: "term-a", status: "interrupted" },
    { id: "block-running", terminalId: "term-a", status: "running" },
  ];
  const tailEnd = {
    kind: "end",
    id: "block-tail",
    protocolVersion: "v3",
    blockToken: OTHER_BLOCK_TOKEN,
    exitCode: 130,
  };
  const tailInput = {
    frame: tailEnd,
    replay: true,
    sessionId: "term-a",
    activeBlockId: "block-running",
    interruptedBlockId: "block-tail",
    activeBlockPhase: { sessionId: "term-a", phase: "active" },
    interruptedBlockPhase: { sessionId: "term-a", phase: "active" },
    blocks,
    blockToken: OTHER_BLOCK_TOKEN,
  };
  assert.deepEqual(resolveBlockTermFrameDisposition(tailInput), {
    accepted: true,
    action: "reconcile-interrupted",
  });
  // The compatibility API intentionally does not expose cleanup-only replay
  // ends as ordinary accepted completions.
  assert.deepEqual(resolveBlockTermFrameAcceptance(tailInput), { accepted: false });

  const runningEnd = {
    ...tailEnd,
    id: "block-running",
    blockToken: BLOCK_TOKEN,
  };
  assert.deepEqual(
    resolveBlockTermFrameDisposition({
      ...tailInput,
      frame: runningEnd,
      replay: false,
      interruptedBlockId: "block-tail",
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: true, action: "complete-running" }
  );
  assert.deepEqual(
    resolveBlockTermFrameDisposition({
      ...tailInput,
      frame: { ...runningEnd, kind: "start" },
      replay: true,
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      activeBlockId: "block-running",
      interruptedBlockId: "block-tail",
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: true, action: "activate-running" }
  );
  assert.deepEqual(
    resolveBlockTermFrameDisposition({
      ...tailInput,
      frame: tailEnd,
      interruptedBlockPhase: { sessionId: "term-b", phase: "active" },
    }),
    { accepted: false }
  );

  const tailStart = { ...tailEnd, kind: "start" };
  assert.deepEqual(
    resolveBlockTermFrameDisposition({
      ...tailInput,
      frame: tailStart,
      replay: true,
      activeBlockPhase: { sessionId: "term-a", phase: "active" },
      interruptedBlockPhase: { sessionId: "term-a", phase: "expected" },
    }),
    { accepted: false }
  );
  assert.deepEqual(
    resolveBlockTermFrameDisposition({
      ...tailInput,
      frame: tailStart,
      replay: true,
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      interruptedBlockPhase: { sessionId: "term-a", phase: "expected" },
    }),
    { accepted: true, action: "activate-interrupted" }
  );
});

test("keeps a handshake transition owner valid across either FIFO frame order", () => {
  const blocks = [
    { id: "block-old", terminalId: "term-a", status: "running" },
    { id: "block-new", terminalId: "term-a", status: "running" },
  ];
  const oldEnd = {
    kind: "end",
    id: "block-old",
    protocolVersion: "v3",
    blockToken: OTHER_BLOCK_TOKEN,
    exitCode: 0,
  };
  const newStart = {
    kind: "start",
    id: "block-new",
    protocolVersion: "v3",
    blockToken: BLOCK_TOKEN,
  };
  const transition = {
    sessionId: "term-a",
    activeBlockId: "block-old",
    activeBlockPhase: { sessionId: "term-a", phase: "active" },
    pendingBlockId: "block-new",
    pendingBlockToken: BLOCK_TOKEN,
    pendingBlockPhase: { sessionId: "term-a", phase: "expected" },
    transitionBlockId: "block-old",
    transitionBlockToken: OTHER_BLOCK_TOKEN,
    transitionBlockPhase: { sessionId: "term-a", phase: "active" },
    blocks,
  };

  assert.deepEqual(
    resolveBlockTermFrameDisposition({ ...transition, frame: oldEnd, replay: true, blockToken: OTHER_BLOCK_TOKEN }),
    { accepted: true, action: "complete-transition-running" }
  );
  assert.deepEqual(
    resolveBlockTermFrameDisposition({ ...transition, frame: newStart, replay: true, blockToken: BLOCK_TOKEN }),
    { accepted: true, action: "activate-pending-running" }
  );

  // Once the new start has switched the active ref, the old end remains valid
  // only through the detached transition binding.
  assert.deepEqual(
    resolveBlockTermFrameDisposition({
      ...transition,
      frame: oldEnd,
      replay: true,
      activeBlockId: "block-new",
      activeBlockPhase: { sessionId: "term-a", phase: "active" },
      pendingBlockId: null,
      pendingBlockToken: undefined,
      pendingBlockPhase: undefined,
      blockToken: OTHER_BLOCK_TOKEN,
    }),
    { accepted: true, action: "complete-transition-running" }
  );
  assert.deepEqual(
    resolveBlockTermFrameDisposition({
      ...transition,
      frame: { ...oldEnd, blockToken: BLOCK_TOKEN },
      replay: true,
      activeBlockId: "block-new",
      pendingBlockId: null,
      pendingBlockToken: undefined,
      pendingBlockPhase: undefined,
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: false }
  );
});

test("does not route fake-before-real frames or text while a block is only expected", () => {
  const blocks = [{ id: "block-real", terminalId: "term-a", status: "running" }];
  const fakeStart = {
    kind: "start",
    id: "block-real",
    protocolVersion: "v3",
    blockToken: OTHER_BLOCK_TOKEN,
  };
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: fakeStart,
      replay: false,
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      blocks,
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: false }
  );
  assert.equal(shouldRouteRejectedBlockTermFrame(false), true);
  assert.equal(shouldRouteRejectedBlockTermFrame(true), false);
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
    }),
    null
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "active" },
    }),
    "block-real"
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-b", phase: "active" },
    }),
    null
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-new",
      interruptedBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
    }),
    "block-real"
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-new",
      interruptedBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-a", phase: "active" },
      interruptedBlockPhase: { sessionId: "term-a", phase: "active" },
    }),
    "block-new"
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-new",
      interruptedBlockId: "block-real",
      activeBlockPhase: { sessionId: "term-b", phase: "active" },
      interruptedBlockPhase: { sessionId: "term-a", phase: "active" },
    }),
    "block-real"
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-new",
      transitionBlockId: "block-old",
      activeBlockPhase: { sessionId: "term-a", phase: "expected" },
      transitionBlockPhase: { sessionId: "term-a", phase: "active" },
    }),
    "block-old"
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      transitionBlockId: "block-old",
      transitionBlockPhase: { sessionId: "term-a", phase: "active" },
    }),
    "block-old"
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      activeBlockId: "block-new",
      transitionBlockId: "block-old",
      activeBlockPhase: { sessionId: "term-a", phase: "active" },
      transitionBlockPhase: { sessionId: "term-a", phase: "active" },
    }),
    "block-new"
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      transitionBlockId: "block-old",
      transitionBlockPhase: { sessionId: "term-b", phase: "active" },
    }),
    null
  );
  assert.equal(
    resolveBlockTermOutputOwner({
      sessionId: "term-a",
      transitionBlockId: "block-old",
      transitionBlockPhase: { sessionId: "term-a", phase: "expected" },
    }),
    null
  );
});

test("handles input rejection only for the active running block in the same terminal", () => {
  const blocks = [{ id: "block-real", terminalId: "term-a", status: "running" }];
  const valid = {
    sessionId: "term-a",
    blockId: "block-real",
    activeBlockId: "block-real",
    activeBlockStatus: "running",
    blocks,
  };
  assert.equal(shouldHandleBlockTermInputRejected(valid), false);
  assert.equal(
    shouldHandleBlockTermInputRejected({
      ...valid,
      blockToken: BLOCK_TOKEN,
      activeBlockToken: BLOCK_TOKEN,
    }),
    true
  );
  assert.equal(
    shouldHandleBlockTermInputRejected({
      ...valid,
      blockToken: undefined,
      activeBlockToken: BLOCK_TOKEN,
    }),
    false
  );
  assert.equal(
    shouldHandleBlockTermInputRejected({
      ...valid,
      blockToken: OTHER_BLOCK_TOKEN,
      activeBlockToken: BLOCK_TOKEN,
    }),
    false
  );
  assert.equal(
    shouldHandleBlockTermInputRejected({
      ...valid,
      blockToken: BLOCK_TOKEN,
      activeBlockToken: BLOCK_TOKEN,
      reason: "runtime_signal_failed",
    }),
    false
  );
  assert.equal(
    shouldHandleBlockTermInputRejected({
      ...valid,
      blockToken: BLOCK_TOKEN,
      activeBlockToken: BLOCK_TOKEN,
      reason: "runtime_write_failed",
    }),
    true
  );
  assert.equal(
    shouldRestoreBlockTermSignalFailure({
      ...valid,
      blockToken: BLOCK_TOKEN,
      activeBlockToken: BLOCK_TOKEN,
      activeBlockStatus: "interrupted",
      interruptedOutputBlockId: "block-real",
      stopPending: true,
      reason: "runtime_signal_failed",
    }),
    true
  );
  assert.equal(
    shouldRestoreBlockTermSignalFailure({
      ...valid,
      blockToken: BLOCK_TOKEN,
      activeBlockToken: BLOCK_TOKEN,
      activeBlockStatus: "interrupted",
      interruptedOutputBlockId: "block-real",
      stopPending: true,
      reason: "runtime_write_failed",
    }),
    false
  );
  assert.equal(
    shouldRestoreBlockTermSignalFailure({
      ...valid,
      blockToken: BLOCK_TOKEN,
      activeBlockToken: BLOCK_TOKEN,
      activeBlockStatus: "interrupted",
      interruptedOutputBlockId: "block-real",
      stopPending: false,
      reason: "runtime_signal_failed",
    }),
    false
  );
  assert.equal(shouldSeedBlockTermToken({ ...valid, blockToken: BLOCK_TOKEN }), true);
  assert.equal(shouldSeedBlockTermToken({ ...valid, blockToken: "not-hex" }), false);
  assert.equal(shouldHandleBlockTermInputRejected({ ...valid, activeBlockId: "block-new" }), false);
  assert.equal(shouldHandleBlockTermInputRejected({ ...valid, activeBlockStatus: "interrupted" }), false);
  assert.equal(
    shouldHandleBlockTermInputRejected({
      ...valid,
      sessionId: "term-b",
    }),
    false
  );
  assert.deepEqual(
    resolveBlockTermStateBinding({
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockStatus: "running",
      blocks,
      serverBlockId: "block-real",
      serverBlockToken: BLOCK_TOKEN,
    }),
    { action: "bind", blockToken: BLOCK_TOKEN }
  );
  assert.deepEqual(
    resolveBlockTermStateBinding({
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockStatus: "running",
      blocks,
      localBlockToken: BLOCK_TOKEN,
      serverBlockId: "block-old",
      serverBlockToken: OTHER_BLOCK_TOKEN,
    }),
    { action: "interrupt" }
  );
  assert.deepEqual(
    resolveBlockTermStateBinding({
      sessionId: "term-a",
      activeBlockId: "block-real",
      activeBlockStatus: "running",
      blocks,
      serverBlockId: undefined,
      serverBlockToken: undefined,
    }),
    { action: "interrupt" }
  );
});

test("accepts only correlated state completions for owned completable blocks", () => {
  const blocks = [
    { id: "block-running", terminalId: "term-a", status: "running" },
    { id: "block-interrupted", terminalId: "term-a", status: "interrupted" },
    { id: "block-finished", terminalId: "term-a", status: "success" },
    { id: "block-other", terminalId: "term-b", status: "running" },
  ];
  assert.deepEqual(
    resolveBlockTermCorrelatedCompletions({
      sessionId: "term-a",
      blocks,
      completions: [
        { block_id: "block-running", block_token: BLOCK_TOKEN, exit_code: 1, cwd: "/old", end_cursor: 50 },
        { block_id: "block-running", block_token: OTHER_BLOCK_TOKEN, exit_code: 0, cwd: "/new", end_cursor: 80 },
        { block_id: "block-interrupted", block_token: BLOCK_TOKEN, exit_code: 130, cwd: "/interrupted", end_cursor: 85 },
        { block_id: "block-finished", exit_code: 0, cwd: "/finished", end_cursor: 90 },
        { block_id: "block-other", exit_code: 0, cwd: "/other", end_cursor: 100 },
        { block_id: "block-running", block_token: "invalid", exit_code: 0, cwd: "/invalid-token", end_cursor: 105 },
        { block_id: "block-running", exit_code: 999, cwd: "/bad", end_cursor: 110 },
        { block_id: "block-running", exit_code: 0, cwd: "/bad", end_cursor: 0 },
      ],
    }),
    [
      { blockId: "block-running", blockToken: OTHER_BLOCK_TOKEN, exitCode: 0, cwd: "/new", endCursor: 80 },
      { blockId: "block-interrupted", blockToken: BLOCK_TOKEN, exitCode: 130, cwd: "/interrupted", endCursor: 85 },
    ]
  );
  assert.deepEqual(
    resolveBlockTermCorrelatedCompletions({ sessionId: "term-a", blocks, completions: { block_id: "block-running" } }),
    []
  );
});

test("builds a status-preserving reconcile plan only for an owned interrupted completion", () => {
  const completion = { blockId: "block-interrupted", exitCode: 130, cwd: "/after", endCursor: 85 };
  const blocks = [
    { id: "block-interrupted", terminalId: "term-a", status: "interrupted" },
    { id: "block-running", terminalId: "term-a", status: "running" },
    { id: "block-success", terminalId: "term-a", status: "success" },
    { id: "block-other", terminalId: "term-b", status: "interrupted" },
  ];

  assert.deepEqual(resolveBlockTermCompletionReconcile({ sessionId: "term-a", completion, blocks }), {
    blockId: "block-interrupted",
    cwd: "/after",
    outputEndCursor: 85,
    preserveInterrupted: true,
  });
  assert.equal(
    resolveBlockTermCompletionReconcile({
      sessionId: "term-a",
      completion: { ...completion, blockId: "block-running" },
      blocks,
    }),
    null
  );
  assert.equal(
    resolveBlockTermCompletionReconcile({
      sessionId: "term-a",
      completion: { ...completion, blockId: "block-success" },
      blocks,
    }),
    null
  );
  assert.equal(
    resolveBlockTermCompletionReconcile({
      sessionId: "term-a",
      completion: { ...completion, blockId: "block-other" },
      blocks,
    }),
    null
  );
  assert.equal(
    resolveBlockTermCompletionReconcile({
      sessionId: "term-a",
      completion: { ...completion, blockId: "block-missing" },
      blocks,
    }),
    null
  );
  assert.equal(
    resolveBlockTermCompletionReconcile({
      sessionId: "term-a",
      completion: { ...completion, endCursor: 0 },
      blocks,
    }),
    null
  );
});

test("serializes asynchronous BlockTerm websocket message tasks", async () => {
  const order = [];
  let releaseRefresh;
  const refresh = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let chain = Promise.resolve();
  chain = enqueueBlockTermMessageTask(chain, async () => {
    order.push("state:start");
    await refresh;
    order.push("state:end");
  });
  chain = enqueueBlockTermMessageTask(chain, () => {
    order.push("output");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["state:start"]);
  releaseRefresh();
  await chain;
  assert.deepEqual(order, ["state:start", "state:end", "output"]);

  chain = enqueueBlockTermMessageTask(chain, () => {
    throw new Error("malformed message");
  });
  chain = enqueueBlockTermMessageTask(chain, () => {
    order.push("after-error");
  });
  await chain;
  assert.equal(order.at(-1), "after-error");
});

test("buffers pre-handshake terminal chunks as copied FIFO transport bytes", () => {
  const queue = createBlockTermPendingChunkQueue();
  const replay = Uint8Array.from([1, 2, 3]);
  assert.equal(enqueueBlockTermPendingChunk(queue, { data: replay, replay: true, reset: true }), true);
  assert.equal(
    enqueueBlockTermPendingChunk(queue, { data: Uint8Array.from([4, 5]), replay: false, reset: false }),
    true
  );
  replay[0] = 9;

  const drained = drainBlockTermPendingChunkQueue(queue);
  assert.equal(drained.overflowed, false);
  assert.deepEqual(drained.chunks, [
    { data: Uint8Array.from([1, 2, 3]), replay: true, reset: true },
    { data: Uint8Array.from([4, 5]), replay: false, reset: false },
  ]);
  assert.deepEqual(queue, { chunks: [], bytes: 0, overflowed: false });

  queue.bytes = BLOCKTERM_HANDSHAKE_BUFFER_MAX_BYTES;
  assert.equal(
    enqueueBlockTermPendingChunk(queue, { data: Uint8Array.of(6), replay: false, reset: false }),
    false
  );
  assert.equal(queue.overflowed, true);
  assert.equal(drainBlockTermPendingChunkQueue(queue).overflowed, true);
  assert.deepEqual(queue, { chunks: [], bytes: 0, overflowed: false });
});

test("finds the correlated current start boundary across buffered chunks", () => {
  const start = new TextEncoder().encode(
    `${ESC}]633;${MARK_PREFIX};start;block-real;v3;${BLOCK_TOKEN};123;/tmp;${encodeUtf8Base64("echo current")}${BEL}`
  );
  const split = Math.floor(start.length / 2);
  const chunks = [
    { data: new TextEncoder().encode("old prompt\nold output\n"), replay: true, reset: true },
    { data: start.slice(0, split), replay: true, reset: false },
    { data: concatBlockTermBytes(start.slice(split), new TextEncoder().encode("current output\n")), replay: false, reset: false },
  ];
  assert.equal(hasBlockTermPendingStartFrame({ chunks, blockId: "block-real", blockToken: BLOCK_TOKEN }), true);
  assert.equal(hasBlockTermPendingStartFrame({ chunks, blockId: "block-real", blockToken: OTHER_BLOCK_TOKEN }), false);

  let phase = hasBlockTermPendingStartFrame({ chunks, blockId: "block-real", blockToken: BLOCK_TOKEN })
    ? "expected"
    : "active";
  let parserBuffer = new Uint8Array();
  let routed = "";
  for (const chunk of chunks) {
    if (chunk.reset) parserBuffer = new Uint8Array();
    const parsed = extractSegmentsFromBytes(concatBlockTermBytes(parserBuffer, chunk.data));
    parserBuffer = parsed.rest;
    for (const segment of parsed.segments) {
      if (segment.type === "text") {
        if (
          resolveBlockTermOutputOwner({
            sessionId: "term-a",
            activeBlockId: "block-real",
            activeBlockPhase: { sessionId: "term-a", phase },
          })
        ) {
          routed += new TextDecoder().decode(segment.value);
        }
        continue;
      }
      const acceptance = resolveBlockTermFrameAcceptance({
        frame: segment.frame,
        replay: chunk.replay,
        sessionId: "term-a",
        activeBlockId: "block-real",
        activeBlockPhase: { sessionId: "term-a", phase },
        blocks: [{ id: "block-real", terminalId: "term-a", status: "running" }],
        blockToken: BLOCK_TOKEN,
      });
      const activation = resolveBlockTermStartActivation({
        ...acceptance,
        frame: segment.frame,
        sessionId: "term-a",
      });
      if (activation) phase = activation.phase;
    }
  }
  assert.equal(routed, "current output\n");

  assert.equal(
    hasBlockTermPendingStartFrame({
      chunks: [
        { data: start.slice(0, split), replay: true, reset: false },
        { data: start.slice(split), replay: true, reset: true },
      ],
      blockId: "block-real",
      blockToken: BLOCK_TOKEN,
    }),
    false
  );
});

test(
  "finishes a leading exec shell through a real PTY and restores terminal output processing",
  { skip: process.platform !== "linux" },
  () => {
    const wrapped = buildWrappedCommand("exec bash --noprofile --norc", "exec-block", BLOCK_TOKEN);
    const result = spawnSync("script", ["-qefc", "/bin/bash --noprofile --norc", "/dev/null"], {
      input: [
        "stty -echo",
        `printf '\\036VIBEGO_EXEC_STATE_BEFORE:%s\\037' "$(stty -g)"`,
        wrapped.trimEnd(),
        `printf '\\036VIBEGO_EXEC_CHILD\\037'`,
        "exit",
        `printf '\\036VIBEGO_EXEC_STATE_AFTER:%s\\037' "$(stty -g)"`,
        "exit",
        "",
      ].join("\n"),
      encoding: null,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr?.toString());
    const parsed = extractSegmentsFromBytes(new Uint8Array(result.stdout));
    assert.ok(
      parsed.segments.some(
        (segment) => segment.type === "frame" && segment.frame.kind === "start" && segment.frame.id === "exec-block"
      )
    );
    assert.ok(
      parsed.segments.some(
        (segment) => segment.type === "frame" && segment.frame.kind === "end" && segment.frame.id === "exec-block"
      )
    );
    const transcript = result.stdout.toString("latin1");
    assert.match(transcript, /\x1eVIBEGO_EXEC_CHILD\x1f/);
    const beforeState = transcript.match(/\x1eVIBEGO_EXEC_STATE_BEFORE:([^\x1f]+)\x1f/)?.[1];
    const afterState = transcript.match(/\x1eVIBEGO_EXEC_STATE_AFTER:([^\x1f]+)\x1f/)?.[1];
    assert.ok(beforeState);
    assert.equal(afterState, beforeState);
  }
);

test(
  "keeps LF bytes unchanged through a real PTY while restoring terminal output processing",
  { skip: process.platform !== "linux" },
  () => {
    const command = "printf '\\001\\012\\002'";
    const wrapped = buildWrappedCommand(command, "binary-block", BLOCK_TOKEN);
    const result = spawnSync("script", ["-qefc", "/bin/bash --noprofile --norc", "/dev/null"], {
      input: [
        "stty -echo",
        `printf '\\036VIBEGO_STATE_BEFORE:%s\\037' "$(stty -g)"`,
        wrapped.trimEnd(),
        `printf '\\036VIBEGO_STATE_AFTER:%s\\037' "$(stty -g)"`,
        "exit",
        "",
      ].join("\n"),
      encoding: null,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr?.toString());
    const parsed = extractSegmentsFromBytes(new Uint8Array(result.stdout));
    const startIndex = parsed.segments.findIndex(
      (segment) => segment.type === "frame" && segment.frame.kind === "start" && segment.frame.id === "binary-block"
    );
    assert.notEqual(startIndex, -1);
    assert.equal(parsed.segments[startIndex + 1].type, "text");
    assert.deepEqual([...parsed.segments[startIndex + 1].value], [0x01, 0x0a, 0x02]);
    assert.equal(parsed.segments[startIndex + 2].type, "frame");
    assert.equal(parsed.segments[startIndex + 2].frame.kind, "end");
    const transcript = result.stdout.toString("latin1");
    const beforeState = transcript.match(/\x1eVIBEGO_STATE_BEFORE:([^\x1f]+)\x1f/)?.[1];
    const afterState = transcript.match(/\x1eVIBEGO_STATE_AFTER:([^\x1f]+)\x1f/)?.[1];
    assert.ok(beforeState);
    assert.equal(afterState, beforeState);
  }
);

test("formats compact command lifecycle metadata without implying a child pid", () => {
  assert.deepEqual(
    getBlockTermLifecycleMetadata({
      cmdPid: 1234,
      remotePid: null,
      termCols: 132,
      termRows: 41,
      termFlexRows: true,
      termMaxPtySize: 16 * 1024 * 1024,
    }),
    ["process pid 1234", "132x41", "flex rows", "pty 16 MiB"]
  );
  assert.deepEqual(
    getBlockTermLifecycleMetadata({
      cmdPid: null,
      remotePid: 5678,
      termCols: 0,
      termRows: 24,
      termFlexRows: false,
      termMaxPtySize: 0,
    }),
    ["remote shell pid 5678", "24 rows"]
  );
});

test("keeps BlockTerm shell metadata consistent across interruption outcomes", () => {
  const session = {
    cwd: "/workspace",
    shellType: "bash",
    shellState: "running-command",
    shellIntegration: true,
    lastCommand: "sleep 10",
    lastCommandExitCode: null,
  };

  assert.deepEqual(JSON.parse(serializeBlockTermShellState(session)), session);

  const stopped = resolveBlockTermInterruptedState({
    session,
    blockId: "block-stop",
    activeBlockId: "block-stop",
    command: "sleep 10",
    phase: "stop",
  });
  assert.deepEqual(stopped.sessionPatch, {
    status: "ready",
    activeBlockId: null,
    shellState: "ready",
    lastCommand: "sleep 10",
    lastCommandExitCode: null,
  });
  assert.deepEqual(stopped.runtimePatch, {
    current_cwd: "/workspace",
    shell_state: "ready",
    shell_integration: true,
    last_command: "sleep 10",
    last_command_exit_code: null,
  });
  assert.equal(JSON.parse(stopped.afterStateJson).shellState, "ready");

  const supersededStop = resolveBlockTermInterruptedState({
    session,
    blockId: "block-stop",
    activeBlockId: "block-new",
    command: "sleep 10",
    phase: "stop",
  });
  assert.deepEqual(supersededStop.sessionPatch, {});
  assert.equal(supersededStop.runtimePatch, null);
  assert.equal(JSON.parse(supersededStop.afterStateJson).shellState, "running-command");

  const unsent = resolveBlockTermInterruptedState({
    session,
    blockId: "block-unsent",
    activeBlockId: "block-other",
    phase: "not-sent",
  });
  assert.deepEqual(unsent.sessionPatch, {});
  assert.equal(unsent.runtimePatch, null);
  assert.equal(JSON.parse(unsent.afterStateJson).shellState, "running-command");

  const unsentAfterPrepare = resolveBlockTermInterruptedState({
    session,
    blockId: "block-unsent",
    activeBlockId: "block-unsent",
    phase: "not-sent",
  });
  assert.deepEqual(unsentAfterPrepare.sessionPatch, {
    status: "ready",
    activeBlockId: null,
    shellState: "ready",
  });
  assert.deepEqual(unsentAfterPrepare.runtimePatch, {
    current_cwd: "/workspace",
    shell_state: "ready",
    shell_integration: true,
    last_command: "sleep 10",
    last_command_exit_code: null,
  });
  assert.equal(JSON.parse(unsentAfterPrepare.afterStateJson).shellState, "ready");

  const exited = resolveBlockTermInterruptedState({
    session,
    blockId: "block-exit",
    activeBlockId: "block-exit",
    command: "sleep 10",
    phase: "runtime-exit",
  });
  assert.deepEqual(exited.sessionPatch, {
    activeBlockId: null,
    shellState: "interrupted",
    shellIntegration: false,
    lastCommand: "sleep 10",
    lastCommandExitCode: null,
  });
  assert.deepEqual(exited.runtimePatch, {
    current_cwd: "/workspace",
    shell_state: "interrupted",
    shell_integration: false,
    last_command: "sleep 10",
    last_command_exit_code: null,
  });
  assert.equal(JSON.parse(exited.afterStateJson).shellIntegration, false);
});

test("emits ANSI and alternate-screen output without waiting for an OSC frame", () => {
  const ansi = extractSegmentsFromBuffer(`${ESC}[31mred`);
  assert.equal(ansi.rest, "");
  assert.deepEqual(ansi.segments, [{ type: "text", value: `${ESC}[31mred`, hasTuiSequence: false }]);

  const tui = extractSegmentsFromBuffer(`${ESC}[?1049hTUI`);
  assert.equal(tui.rest, "");
  assert.deepEqual(tui.segments, [{ type: "text", value: `${ESC}[?1049hTUI`, hasTuiSequence: true }]);
});

test("decodes Base64 transport without replacing invalid UTF-8 bytes", () => {
  const encoded = btoa(String.fromCharCode(0xff, 0x00, 0x1b, 0x5b, 0x31, 0x6d));
  assert.deepEqual(decodeBase64Bytes(encoded), Uint8Array.from([0xff, 0x00, 0x1b, 0x5b, 0x31, 0x6d]));
});

test("parses BlockTerm OSC frames while retaining invalid UTF-8 and NUL bytes", () => {
  const start = new TextEncoder().encode(
    `${ESC}]633;${MARK_PREFIX};start;block-bytes;v3;${BLOCK_TOKEN};123;/tmp;${encodeUtf8Base64("printf bytes")}${BEL}`
  );
  const payload = Uint8Array.from([0xff, 0x00, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x58]);
  const end = new TextEncoder().encode(
    `${ESC}]633;${MARK_PREFIX};end;block-bytes;v3;${BLOCK_TOKEN};0;/tmp${BEL}`
  );
  const parsed = extractSegmentsFromBytes(concatBlockTermBytes(start, payload, end));
  assert.equal(parsed.rest.length, 0);
  assert.deepEqual(parsed.segments, [
    {
      type: "frame",
      raw: start,
      frame: {
        kind: "start",
        id: "block-bytes",
        protocolVersion: "v3",
        blockToken: BLOCK_TOKEN,
        cwd: "/tmp",
        command: "printf bytes",
        shellPid: 123,
      },
    },
    { type: "text", value: payload, hasTuiSequence: false },
    {
      type: "frame",
      raw: end,
      frame: {
        kind: "end",
        id: "block-bytes",
        protocolVersion: "v3",
        blockToken: BLOCK_TOKEN,
        exitCode: 0,
        cwd: "/tmp",
      },
    },
  ]);
});

test("rejects v3 end frames with non-canonical or out-of-range exit codes", () => {
  for (const exitCode of ["", "-1", "+1", "0junk", "256", "9999"]) {
    const value = new TextEncoder().encode(
      `${ESC}]633;${MARK_PREFIX};end;block-exit;v3;${BLOCK_TOKEN};${exitCode};/tmp${BEL}`
    );
    const parsed = extractSegmentsFromBytes(value);
    assert.equal(
      parsed.segments.some((segment) => segment.type === "frame"),
      false,
      `unexpected frame for exit code ${JSON.stringify(exitCode)}`
    );
    assert.deepEqual(parsed.rest, new Uint8Array());
  }

  const valid = new TextEncoder().encode(
    `${ESC}]633;${MARK_PREFIX};end;block-exit;v3;${BLOCK_TOKEN};255;/tmp${BEL}`
  );
  const parsed = extractSegmentsFromBytes(valid);
  assert.equal(parsed.segments[0].type, "frame");
  assert.equal(parsed.segments[0].frame.exitCode, 255);
});

test("keeps byte OSC state across chunks and preserves split UTF-8 payloads", () => {
  const prefix = new TextEncoder().encode(`${ESC}]633;${MARK_PREFIX};start;block-split;v2;9;/tmp;${encodeUtf8Base64("echo hi")}${BEL}`);
  const first = concatBlockTermBytes(prefix, Uint8Array.from([0xe4]));
  const parsedFirst = extractSegmentsFromBytes(first);
  assert.equal(parsedFirst.rest.length, 0);
  assert.equal(parsedFirst.segments[0].type, "frame");
  assert.deepEqual(parsedFirst.segments[0].raw, prefix);
  assert.equal(parsedFirst.segments[0].frame.protocolVersion, "v2");
  assert.deepEqual(parsedFirst.segments[1].value, Uint8Array.from([0xe4]));
  const parsedSecond = extractSegmentsFromBytes(Uint8Array.from([0xb8, 0xad, 0x00]));
  assert.deepEqual(parsedSecond.segments, [{ type: "text", value: Uint8Array.from([0xb8, 0xad, 0x00]), hasTuiSequence: false }]);
});

test("retains the exact private OSC bytes when lifecycle correlation rejects them", () => {
  const forged = new TextEncoder().encode(
    `${ESC}]633;${MARK_PREFIX};start;block-real;v3;${OTHER_BLOCK_TOKEN};123;/tmp;${encodeUtf8Base64("fake")}${BEL}`
  );
  const parsed = extractSegmentsFromBytes(forged);
  assert.equal(parsed.segments[0].type, "frame");
  assert.deepEqual(parsed.segments[0].raw, forged);
  assert.deepEqual(
    resolveBlockTermFrameAcceptance({
      frame: parsed.segments[0].frame,
      replay: false,
      sessionId: "term-a",
      activeBlockId: "block-real",
      blocks: [{ id: "block-real", terminalId: "term-a", status: "running" }],
      blockToken: BLOCK_TOKEN,
    }),
    { accepted: false }
  );
});

test("keeps ambiguous replay byte overlaps instead of dropping real output", () => {
  assert.deepEqual(
    missingReplayByteSuffix(Uint8Array.from([1, 2, 3]), Uint8Array.from([2, 3, 4])),
    Uint8Array.from([2, 3, 4])
  );
  assert.deepEqual(missingReplayByteSuffix(Uint8Array.from([1, 2, 3]), Uint8Array.from([2, 3])), new Uint8Array());
  assert.deepEqual(
    missingReplayByteSuffix(Uint8Array.from([1, 2, 1, 2]), Uint8Array.from([1, 2, 1])),
    Uint8Array.from([1, 2, 1])
  );
  assert.deepEqual(
    missingReplayByteSuffix(Uint8Array.from([0xff, 0x00]), Uint8Array.from([0xff, 0x00, 0xff])),
    Uint8Array.from([0xff, 0x00, 0xff])
  );
});

test("keeps only a partial BlockTerm OSC marker between chunks", () => {
  const first = extractSegmentsFromBuffer(`before${ESC}]63`);
  assert.deepEqual(first.segments, [{ type: "text", value: "before", hasTuiSequence: false }]);
  assert.equal(first.rest, `${ESC}]63`);

  const command = "printf hello";
  const second = extractSegmentsFromBuffer(
    `${first.rest}3;${MARK_PREFIX};start;block-1;/tmp/a;b;${encodeUtf8Base64(command)}${BEL}after`
  );
  assert.equal(second.rest, "");
  assert.deepEqual(second.segments, [
    {
      type: "frame",
      frame: { kind: "start", id: "block-1", cwd: "/tmp/a;b", command },
    },
    { type: "text", value: "after", hasTuiSequence: false },
  ]);
});

test("discards incomplete parser state when the PTY ends", () => {
  const state = {
    decoder: new TextDecoder("utf-8", { fatal: false }),
    parseBuffer: `${ESC}]63`,
  };
  state.decoder.decode(Uint8Array.of(0xe4), { stream: true });

  discardTerminalParserTail(state);

  assert.equal(state.parseBuffer, "");
  assert.equal(state.decoder.decode(new TextEncoder().encode("next")), "next");
});

test("takes parser bytes and flushes pending UTF-8 projection on teardown", () => {
  const state = {
    decoder: new TextDecoder("utf-8", { fatal: false }),
    parseBuffer: Uint8Array.from([0x1b, 0x5d, 0x36, 0x33]),
  };
  state.decoder.decode(Uint8Array.of(0xe4), { stream: true });

  const tail = takeTerminalParserTail(state);

  assert.deepEqual(tail.raw, Uint8Array.from([0x1b, 0x5d, 0x36, 0x33]));
  assert.equal(tail.projection, "\ufffd");
  assert.equal(state.parseBuffer.length, 0);
  assert.equal(flushTerminalProjectionDecoder(state), "");
  assert.equal(state.decoder.decode(Uint8Array.from([0xe4, 0xb8, 0xad])), "中");
});

test("parses end frames whose cwd contains semicolons", () => {
  const parsed = extractSegmentsFromBuffer(`${ESC}]633;${MARK_PREFIX};end;block-1;7;/tmp/a;b${BEL}`);
  assert.deepEqual(parsed, {
    segments: [
      {
        type: "frame",
        frame: { kind: "end", id: "block-1", exitCode: 7, cwd: "/tmp/a;b" },
      },
    ],
    rest: "",
  });
});

test("detects TUI commands behind common sudo and env wrappers", () => {
  assert.equal(shouldUseTerminalMode("sudo -u root vim /tmp/file"), true);
  assert.equal(shouldUseTerminalMode("env TERM=xterm-256color nvim /tmp/file"), true);
  assert.equal(shouldUseTerminalMode("FOO=bar sudo --user root /usr/bin/htop"), true);
  assert.equal(shouldUseTerminalMode("printf hello"), false);
});

test("uses one archived and pinned block order for rendering and navigation", () => {
  const blocks = [
    { id: "one", archived: false, pinned: false },
    { id: "two", archived: true, pinned: true },
    { id: "three", archived: false, pinned: true },
    { id: "four", archived: false, pinned: false },
  ];
  const visible = getVisibleOrderedBlocks(blocks, false);
  assert.deepEqual(
    visible.map((block) => block.id),
    ["three", "one", "four"]
  );
  assert.equal(getBlockNavigationTarget(visible, "three", "ArrowDown"), "one");
  assert.equal(getBlockNavigationTarget(visible, "one", "PageDown", 2), "four");
  assert.equal(getBlockNavigationTarget(visible, "four", "Home"), "three");
  assert.equal(getBlockNavigationTarget(visible, "three", "End"), "four");
});

test("restores the nearest visible selection when a block disappears", () => {
  const previous = [{ id: "one" }, { id: "two" }, { id: "three" }];
  assert.equal(resolveVisibleBlockSelection(previous, [{ id: "one" }, { id: "three" }], "two"), "three");
  assert.equal(resolveVisibleBlockSelection(previous, [{ id: "one" }, { id: "two" }], "three"), "two");
  assert.equal(resolveVisibleBlockSelection(previous, [], "two"), null);
  assert.equal(resolveVisibleBlockSelection(previous, previous, null), null);
});

test("selects a created block only when it passes the active filters", () => {
  const previous = [{ id: "one" }, { id: "two" }];
  assert.equal(resolveCreatedBlockSelection(previous, [...previous, { id: "three" }], "two", "three"), "three");
  assert.equal(resolveCreatedBlockSelection(previous, previous, "two", "hidden"), "two");
  assert.equal(resolveCreatedBlockSelection([], [], null, "hidden"), null);
});

test("keeps focus on a block when pinning reorders the virtual list", () => {
  const blocks = [
    { id: "one", archived: false, pinned: false },
    { id: "two", archived: false, pinned: false },
    { id: "three", archived: false, pinned: false },
  ];
  assert.equal(getBlockMutationFocusTarget(blocks, false, "two", { pinned: true }), "two");
});

test("moves focus to a neighboring row when archiving a focused unselected block", () => {
  const blocks = [
    { id: "one", archived: false, pinned: false },
    { id: "two", archived: false, pinned: false },
    { id: "three", archived: false, pinned: false },
  ];
  assert.equal(getBlockMutationFocusTarget(blocks, false, "two", { archived: true }), "three");
  assert.equal(getBlockMutationFocusTarget(blocks, false, "three", { archived: true }), "two");
});

test("uses active filters when resolving focus after a block mutation", () => {
  const blocks = [
    { id: "one", archived: false, pinned: false, status: "success", starred: false },
    { id: "two", archived: false, pinned: false, status: "success", starred: true },
    { id: "three", archived: false, pinned: false, status: "success", starred: false },
    { id: "four", archived: false, pinned: false, status: "success", starred: true },
  ];
  assert.equal(
    getBlockMutationFocusTarget(blocks, false, "two", { archived: true }, { starredOnly: true }),
    "four"
  );
});

test("restores an empty command draft after walking history", () => {
  const first = navigateBlockHistory(
    { draft: "", history: ["first", "second"], historyIndex: -1, historyDraft: null },
    "ArrowUp"
  );
  assert.deepEqual(first, { draft: "second", historyIndex: 1, historyDraft: "" });
  const second = navigateBlockHistory({ ...first, history: ["first", "second"] }, "ArrowUp");
  assert.deepEqual(second, { draft: "first", historyIndex: 0, historyDraft: "" });
  const third = navigateBlockHistory({ ...second, history: ["first", "second"] }, "ArrowDown");
  assert.deepEqual(third, { draft: "second", historyIndex: 1, historyDraft: "" });
  const restored = navigateBlockHistory({ ...third, history: ["first", "second"] }, "ArrowDown");
  assert.deepEqual(restored, { draft: "", historyIndex: -1, historyDraft: null });
});

test("captures a non-empty history draft only on the first ArrowUp", () => {
  const first = navigateBlockHistory(
    { draft: "unfinished", history: ["first", "second"], historyIndex: -1, historyDraft: null },
    "ArrowUp"
  );
  const second = navigateBlockHistory({ ...first, history: ["first", "second"] }, "ArrowUp");
  const restored = navigateBlockHistory({ ...second, history: ["first", "second"] }, "ArrowDown");
  const final = navigateBlockHistory({ ...restored, history: ["first", "second"] }, "ArrowDown");
  assert.equal(second.historyDraft, "unfinished");
  assert.deepEqual(final, { draft: "unfinished", historyIndex: -1, historyDraft: null });
});

test("builds arrow-key history from the most recent durable occurrence", () => {
  const history = recentCommandHistory([
    { command: "second" },
    { command: "first" },
    { command: "second" },
    { command: "" },
    { command: "old" },
  ]);
  assert.deepEqual(history, ["old", "first", "second"]);
  assert.deepEqual(recentCommandHistory([{ command: "one" }], 0), []);
});

test("moves a newly persisted command to the newest history position", () => {
  assert.deepEqual(appendRecentCommand(["one", "two", "three"], "two"), ["one", "three", "two"]);
  assert.deepEqual(appendRecentCommand(["one", "two"], "three", 2), ["two", "three"]);
  assert.deepEqual(appendRecentCommand(["one"], "   "), ["one"]);
});

test("parses note aliases without treating notes as command history", () => {
  assert.deepEqual(parseBlockTermNoteCommand("/note remember this"), { text: "remember this" });
  assert.deepEqual(parseBlockTermNoteCommand("/COMMENT\n  multiline\nnote  "), { text: "multiline\nnote" });
  assert.deepEqual(parseBlockTermNoteCommand("/note"), { text: "" });
  assert.equal(parseBlockTermNoteCommand("echo /note"), null);
  assert.equal(shouldRecordBlockTermHistory("note"), false);
  assert.equal(shouldRecordBlockTermHistory("command"), true);
  assert.equal(shouldRecordBlockTermHistory("renderer"), true);
});

test("clears only the draft that produced a persisted command", () => {
  assert.deepEqual(
    resolveDraftAfterCommandPublish({ draft: "echo one", historyIndex: 2, historyDraft: "work" }, "echo one"),
    { draft: "", historyIndex: -1, historyDraft: null }
  );
  const edited = { draft: "echo two", historyIndex: -1, historyDraft: null };
  assert.deepEqual(resolveDraftAfterCommandPublish(edited, "echo one"), edited);
});

test("consumes a /run draft while preserving its shell body for history", () => {
  const draft = "/run printf '%s\\n' hello";
  const body = "printf '%s\\n' hello";
  assert.deepEqual(
    resolveDraftAfterCommandPublish({ draft, historyIndex: -1, historyDraft: null }, draft),
    { draft: "", historyIndex: -1, historyDraft: null }
  );
  assert.deepEqual(appendRecentCommand([], body), [body]);
});

test("classifies command, path command, argument, redirect, and new statement completion", () => {
  const command = parseBlockTermCompletionContext("ec", 2);
  assert.deepEqual(
    { kind: command.kind, prefix: command.prefix, executableOnly: command.executableOnly },
    { kind: "command", prefix: "ec", executableOnly: false }
  );
  const pathCommand = parseBlockTermCompletionContext("./scr", 5);
  assert.deepEqual(
    { kind: pathCommand.kind, prefix: pathCommand.prefix, executableOnly: pathCommand.executableOnly },
    { kind: "file", prefix: "./scr", executableOnly: true }
  );
  assert.equal(parseBlockTermCompletionContext("echo fi", 7).kind, "file");
  assert.equal(parseBlockTermCompletionContext("echo value; gi", 14).kind, "command");
  assert.equal(parseBlockTermCompletionContext("echo > ou", 9).kind, "file");
  assert.equal(parseBlockTermCompletionContext("FOO=bar ec", 10).kind, "command");
  assert.equal(parseBlockTermCompletionContext("2>log ec", 8).kind, "command");
});

test("rejects expansion, glob, comment, and grouping contexts", () => {
  assert.equal(parseBlockTermCompletionContext("echo $HO", 8), null);
  assert.equal(parseBlockTermCompletionContext("echo *.ts", 9), null);
  assert.equal(parseBlockTermCompletionContext("echo $(touch marker)", 12), null);
  assert.equal(parseBlockTermCompletionContext("echo `touch fi", 14), null);
  assert.equal(parseBlockTermCompletionContext("(echo fi", 8), null);
  assert.equal(parseBlockTermCompletionContext("echo !12", 8), null);
  assert.equal(parseBlockTermCompletionContext("echo ok # fi", 12), null);
});

test("quotes unique completions for unquoted, single-quoted, and double-quoted words", () => {
  const unquoted = parseBlockTermCompletionContext("cat fo", 6);
  assert.deepEqual(applyBlockTermCompletion(unquoted, "foo bar", true), {
    draft: "cat foo\\ bar ",
    cursor: 13,
  });

  const single = parseBlockTermCompletionContext("cat 'fo", 7);
  assert.deepEqual(applyBlockTermCompletion(single, "foo bar", true), {
    draft: "cat 'foo bar' ",
    cursor: 14,
  });

  const double = parseBlockTermCompletionContext('cat "cash', 9);
  assert.deepEqual(applyBlockTermCompletion(double, "cash$box", true), {
    draft: 'cat "cash\\$box" ',
    cursor: 16,
  });
});

test("preserves escaped prefixes, directories, closing quotes, and word suffixes", () => {
  const escaped = parseBlockTermCompletionContext("cat foo\\ b", 10);
  assert.equal(escaped.prefix, "foo b");
  assert.equal(applyBlockTermCompletion(escaped, "foo bar", true).draft, "cat foo\\ bar ");

  const directory = parseBlockTermCompletionContext('cd "My', 6);
  assert.deepEqual(applyBlockTermCompletion(directory, "My Folder/", true, true), {
    draft: 'cd "My Folder/',
    cursor: 14,
  });

  const closingQuote = parseBlockTermCompletionContext('cat "fo"', 7);
  assert.deepEqual(applyBlockTermCompletion(closingQuote, "foo bar", true), {
    draft: 'cat "foo bar" ',
    cursor: 14,
  });

  const middle = parseBlockTermCompletionContext("cat fZZ", 5);
  assert.deepEqual(applyBlockTermCompletion(middle, "foo bar", true), {
    draft: "cat foo\\ barZZ",
    cursor: 12,
  });
});

test("uses JavaScript UTF-16 cursor positions without splitting Unicode characters", () => {
  const unicode = parseBlockTermCompletionContext("cat 你x", 5);
  assert.deepEqual(applyBlockTermCompletion(unicode, "你好", true), {
    draft: "cat 你好x",
    cursor: 6,
  });
  assert.equal(parseBlockTermCompletionContext("cat 😀", 5), null);
  assert.equal(parseBlockTermCompletionContext("cat 😀", 6).prefix, "😀");
});

test("auto-applies unique candidates and extends a common prefix before showing a menu", () => {
  const uniqueContext = parseBlockTermCompletionContext("cat pick-a", 10);
  assert.deepEqual(
    resolveBlockTermCompletion(
      uniqueContext,
      [{ value: "pick-alpha.txt", display: "pick-alpha.txt", isDirectory: false }],
      "pick-alpha.txt"
    ),
    { edit: { draft: "cat pick-alpha.txt ", cursor: 19 }, showCandidates: false }
  );

  const context = parseBlockTermCompletionContext("cat curr", 8);
  const candidates = [
    { value: "current file", display: "current file", isDirectory: false },
    { value: "current-dir/", display: "current-dir/", isDirectory: true },
  ];
  assert.deepEqual(resolveBlockTermCompletion(context, candidates, "current"), {
    edit: { draft: "cat current", cursor: 11 },
    showCandidates: false,
  });
  const extended = parseBlockTermCompletionContext("cat current", 11);
  assert.deepEqual(resolveBlockTermCompletion(extended, candidates, "current"), {
    edit: null,
    showCandidates: true,
  });
});

test("clamps completion keyboard selection", () => {
  assert.equal(moveBlockTermCompletionSelection(0, 3, "previous"), 0);
  assert.equal(moveBlockTermCompletionSelection(0, 3, "next"), 1);
  assert.equal(moveBlockTermCompletionSelection(2, 3, "next"), 2);
  assert.equal(moveBlockTermCompletionSelection(4, 0, "next"), 0);
});
