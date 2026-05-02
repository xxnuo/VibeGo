import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

import {
  BLOCKTERM_LINE_AI_DEFAULT_HISTORY_BYTES,
  BLOCKTERM_LINE_AI_TRUNCATION_MARKER,
  buildBlockTermLineAIPrompt,
  buildBlockTermLineAIRefillEdit,
  buildBlockTermLineAIRetryInput,
  buildBlockTermLineAIRunInput,
  extractBlockTermLineAICodeBlocks,
  getBlockTermLineAICodeForRefill,
  getBlockTermLineAIDefaultPrompt,
  limitBlockTermLineAIHistory,
  truncateBlockTermLineAIText,
} from "../src/components/terminal/blockterm-line-ai.ts";

function block(patch = {}) {
  return {
    id: "block-source",
    terminalId: "terminal-1",
    lineNum: 7,
    kind: "command",
    command: "pnpm test",
    text: "",
    runtimeType: "local",
    output: "display-only output",
    outputSize: 19,
    outputCursor: 2,
    cmdPid: null,
    remotePid: null,
    termCols: 120,
    termRows: 30,
    termFlexRows: true,
    termMaxPtySize: 16 * 1024 * 1024,
    status: "success",
    mode: "text",
    cwd: "/work",
    exitCode: 0,
    startedAt: 1,
    finishedAt: 2,
    collapsed: false,
    pinned: false,
    archived: false,
    starred: false,
    ...patch,
  };
}

test("uses block outcome for the default Line AI question", () => {
  assert.equal(getBlockTermLineAIDefaultPrompt(block()), "What should I do next?");
  assert.equal(getBlockTermLineAIDefaultPrompt(block({ status: "error", exitCode: null })), "How should I fix this?");
  assert.equal(getBlockTermLineAIDefaultPrompt(block({ status: "interrupted" })), "How should I fix this?");
  assert.equal(getBlockTermLineAIDefaultPrompt(block({ status: "success", exitCode: 127 })), "How should I fix this?");
});

test("builds sourceBlockId-only run input without leaking selected output or command context", () => {
  const source = block({ command: "secret-command --token hidden", output: "secret output" });
  const result = buildBlockTermLineAIRunInput({
    id: "model-1",
    terminalId: "terminal-1",
    lineNum: 8,
    selectedBlock: source,
    userQuery: "Explain the failure",
    history: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ],
    model: "test-model",
  });

  assert.deepEqual(result, {
    id: "model-1",
    terminalId: "terminal-1",
    lineNum: 8,
    command: "/chat Explain the failure",
    currentCommand: "",
    prompt: "Explain the failure",
    cwd: "/work",
    runtimeType: "local",
    model: "test-model",
    sourceBlockId: "block-source",
    messages: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Explain the failure" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result.messages), /secret-command|secret output/u);
  assert.doesNotMatch(result.prompt, /secret-command|secret output/u);
});

test("uses the source block connection for Line AI model runs", () => {
  const result = buildBlockTermLineAIRunInput({
    id: "model-remote",
    terminalId: "terminal-1",
    selectedBlock: block({ runtimeType: "ssh", sshProfileId: "profile-remote" }),
    userQuery: "Explain",
  });
  assert.equal(result.runtimeType, "ssh");
  assert.equal(result.sshProfileId, "profile-remote");
});

test("uses a bounded default prompt and never serializes block output into messages", () => {
  const source = block({ status: "error", exitCode: 2, output: "do not send this output" });
  const result = buildBlockTermLineAIRunInput({
    id: "model-2",
    terminalId: "terminal-1",
    selectedBlock: source,
  });

  assert.equal(result.prompt, "How should I fix this?");
  assert.equal(result.command, "/chat How should I fix this?");
  assert.deepEqual(result.messages, [{ role: "user", content: "How should I fix this?" }]);
  assert.equal(result.sourceBlockId, source.id);
  assert.equal(result.currentCommand, "");
  assert.doesNotMatch(JSON.stringify(result), /do not send this output/u);
});

test("keeps recent turns within byte and count limits without mutating history", () => {
  const history = [
    { role: "user", content: "old-" + "x".repeat(100) },
    { role: "assistant", content: "middle" },
    { role: "user", content: "最新问题".repeat(20) },
  ];
  const before = structuredClone(history);
  const result = limitBlockTermLineAIHistory(history, { maxHistoryBytes: 90, maxHistoryMessages: 2 });

  assert.deepEqual(history, before);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  assert.match(result.messages[0].content, /truncated/u);
  assert.ok(Buffer.byteLength(JSON.stringify(result.messages), "utf8") <= 90);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.messages[0].content, /\ufffd/u);
});

test("accounts for JSON escaping while fitting the latest history turn", () => {
  const content = String.raw`quote-"-slash-\\-` + "界".repeat(40);
  const result = limitBlockTermLineAIHistory([{ role: "user", content }], {
    maxHistoryBytes: 72,
    maxHistoryMessages: 1,
  });
  assert.equal(result.messages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result.messages), "utf8") <= 72);
  assert.match(result.messages[0].content, /truncated/u);
  assert.doesNotMatch(result.messages[0].content, /\ufffd/u);
});

test("keeps only complete prior turns before the latest user message", () => {
  const history = [];
  for (let index = 0; index < 20; index += 1) {
    history.push({ role: "user", content: `question-${index}` });
    history.push({ role: "assistant", content: `answer-${index}` });
  }
  history.push({ role: "user", content: "latest-question" });

  const result = limitBlockTermLineAIHistory(history);
  assert.equal(result.messages.length, 39);
  assert.equal(result.messages[0].role, "user");
  assert.deepEqual(result.messages.at(-1), { role: "user", content: "latest-question" });
  for (let index = 0; index < result.messages.length - 1; index += 2) {
    assert.equal(result.messages[index].role, "user");
    assert.equal(result.messages[index + 1].role, "assistant");
  }
});

test("never emits empty content at the default history byte boundary", () => {
  const result = limitBlockTermLineAIHistory([
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "y".repeat(BLOCKTERM_LINE_AI_DEFAULT_HISTORY_BYTES) },
  ]);

  assert.ok(result.messages.length > 0);
  assert.equal(result.messages[0].role, "user");
  assert.ok(result.messages.every((message) => message.content.length > 0));
  assert.ok(
    Buffer.byteLength(JSON.stringify(result.messages), "utf8") <= BLOCKTERM_LINE_AI_DEFAULT_HISTORY_BYTES
  );
});

test("retains ordering of the most recent complete multi-turn history", () => {
  const messages = [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
  ];
  const result = limitBlockTermLineAIHistory(messages, { maxHistoryBytes: 1024, maxHistoryMessages: 3 });
  assert.deepEqual(result.messages, messages.slice(-2));
  assert.equal(result.truncated, true);
});

test("bounds the compatibility prompt and matching latest user message by UTF-8 bytes", () => {
  const latest = "界".repeat(100);
  const result = buildBlockTermLineAIPrompt(
    "block-1",
    [
      { role: "assistant", content: "previous" },
      { role: "user", content: latest },
    ],
    { maxBytes: 50, maxHistoryBytes: 1024 }
  );

  assert.equal(result.sourceBlockId, "block-1");
  assert.ok(Buffer.byteLength(result.prompt, "utf8") <= 50);
  assert.equal(result.prompt, result.messages.at(-1).content);
  assert.match(result.prompt, /truncated/u);
  assert.doesNotMatch(result.prompt, /\ufffd/u);
  assert.equal(result.truncated, true);
});

test("truncates arbitrary UTF-8 text with stable head and tail", () => {
  const result = truncateBlockTermLineAIText(`head-${"界".repeat(30)}-tail`, 48);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.value, "utf8") <= 48);
  assert.match(result.value, new RegExp(BLOCKTERM_LINE_AI_TRUNCATION_MARKER.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(result.value, /\ufffd/u);
});

test("extracts stable fenced code blocks and ignores inline code", () => {
  const markdown = [
    "Use `echo inline` only as prose.",
    "```bash",
    "printf 'one'",
    "```",
    "~~~",
    "pnpm test",
    "~~~",
    "````typescript title=sample",
    "const fence = ```;",
    "````",
  ].join("\n");
  assert.deepEqual(extractBlockTermLineAICodeBlocks(markdown), [
    { index: 0, language: "bash", content: "printf 'one'\n", fence: "backtick" },
    { index: 1, language: "", content: "pnpm test\n", fence: "tilde" },
    { index: 2, language: "typescript", content: "const fence = ```;\n", fence: "backtick" },
  ]);
});

test("ignores unclosed fences and does not treat later nested-looking text as a second block", () => {
  assert.deepEqual(extractBlockTermLineAICodeBlocks("before\n```sh\necho broken"), []);
  assert.deepEqual(extractBlockTermLineAICodeBlocks("`inline` and more"), []);
});

test("builds a refill edit with cursor at the end and strips one renderer newline", () => {
  const markdown = "```sh\necho first\necho second\n\n```";
  const edit = buildBlockTermLineAIRefillEdit(markdown, 0);
  assert.deepEqual(edit, { draft: "echo first\necho second\n", cursor: 23 });
  assert.equal(getBlockTermLineAICodeForRefill(markdown, 0), edit.draft);
  assert.equal(buildBlockTermLineAIRefillEdit(markdown, 1), null);
  assert.equal(buildBlockTermLineAIRefillEdit(markdown, -1), null);
});

test("preserves explicit display command while leaving source command server-authoritative", () => {
  const result = buildBlockTermLineAIRunInput({
    id: "model-3",
    terminalId: "terminal-1",
    command: "/chat model=small custom display",
    selectedBlock: block({ command: "source command" }),
    userQuery: "custom display",
  });
  assert.equal(result.command, "/chat model=small custom display");
  assert.equal(result.currentCommand, "");
  assert.equal(result.sourceBlockId, "block-source");
});

test("distinguishes stable-ID resume from a fresh retry after a confirmed run failure", () => {
  const request = buildBlockTermLineAIRunInput({
    id: "model-original",
    terminalId: "terminal-1",
    lineNum: 9,
    selectedBlock: block(),
    userQuery: "Explain",
  });
  assert.equal(buildBlockTermLineAIRetryInput(request, false, "model-unused"), request);
  assert.deepEqual(buildBlockTermLineAIRetryInput(request, true, "model-retry", 12), {
    ...request,
    id: "model-retry",
    lineNum: 12,
  });
  assert.equal(request.id, "model-original");
  assert.equal(request.lineNum, 9);
});

test("preserves nonblank user prompt whitespace in prompt and the final user turn", () => {
  const result = buildBlockTermLineAIRunInput({
    id: "model-4",
    terminalId: "terminal-1",
    selectedBlock: block(),
    userQuery: "  compare these options  ",
  });
  assert.equal(result.prompt, "  compare these options  ");
  assert.equal(result.messages.at(-1).content, result.prompt);
});

test("retries an ambiguously created Line AI run with a fresh ID after confirmed cancellation", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const globalNames = [
    "window",
    "document",
    "navigator",
    "localStorage",
    "HTMLElement",
    "Node",
    "Event",
    "MouseEvent",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previousGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globalNames.slice(0, -1)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "localStorage" ? dom.window.localStorage : dom.window[name],
      writable: true,
    });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "/api/blockterm/model/runs") {
      const createRequests = requests.filter((request) => request.url === url);
      if (createRequests.length === 1) throw new TypeError("Create response lost");
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          block: {
            id: body.id,
            terminal_id: body.terminal_id,
            line_num: body.line_num,
            kind: "renderer",
            command: body.command,
            text: body.prompt,
            cwd: "/work",
            status: "success",
            mode: "text",
            output: "",
            exit_code: 0,
            archived: true,
            renderer: "openai",
            started_at: 1,
            finished_at: 2,
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }
    if (/^\/api\/blockterm\/model\/runs\/[^/]+\/cancel$/u.test(url)) {
      return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  const rootElement = document.getElementById("root");
  const root = createRoot(rootElement);
  let nextLineNum = 8;
  try {
    const { default: BlockTermLineAIPanel } = await vite.ssrLoadModule(
      "/src/components/terminal/blockterm-line-ai-panel.tsx"
    );
    await act(async () => {
      root.render(
        React.createElement(BlockTermLineAIPanel, {
          active: true,
          terminalId: "terminal-1",
          sourceBlock: block(),
          onClose: () => {},
          onRefill: () => {},
          allocateLineNum: () => nextLineNum++,
        })
      );
    });

    const sendButton = document.querySelector("[data-blockterm-line-ai-send]");
    assert.ok(sendButton);
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let attempt = 0; attempt < 100 && requests.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/api/blockterm/model/runs");
    const firstRunBody = JSON.parse(requests[0].init.body);
    const runId = firstRunBody.id;
    assert.equal(firstRunBody.runtime_type, "local");
    assert.equal(firstRunBody.ssh_profile_id, undefined);
    assert.equal(requests[1].url, `/api/blockterm/model/runs/${encodeURIComponent(runId)}/cancel`);
    assert.match(document.body.textContent, /Create response lost/u);

    const retryButton = document.querySelector("[data-blockterm-line-ai-retry]");
    assert.ok(retryButton);
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let attempt = 0; attempt < 100 && requests.length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, "/api/blockterm/model/runs");
    const retryBody = JSON.parse(requests[2].init.body);
    assert.notEqual(retryBody.id, runId);
    assert.equal(retryBody.line_num, 9);
  } finally {
    await act(async () => root.unmount());
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
