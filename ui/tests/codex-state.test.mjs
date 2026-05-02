import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("completed turn summaries preserve streamed items and merge matching item fields", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { upsertCodexTurn } = await vite.ssrLoadModule("/src/components/codex/codex-state.ts");
  const turns = [
    {
      id: "turn-1",
      status: "inProgress",
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "keep me" }] },
        { id: "command-1", type: "commandExecution", aggregatedOutput: "streamed output" },
        { id: "agent-1", type: "agentMessage", text: "streamed answer" },
      ],
    },
  ];

  const merged = upsertCodexTurn(turns, {
    id: "turn-1",
    status: "completed",
    items: [
      { id: "agent-1", type: "agentMessage", phase: "final" },
      { id: "plan-1", type: "plan", text: "done" },
    ],
  });

  assert.equal(merged[0].status, "completed");
  assert.deepEqual(
    merged[0].items.map((item) => item.id),
    ["user-1", "command-1", "agent-1", "plan-1"]
  );
  assert.equal(merged[0].items[1].aggregatedOutput, "streamed output");
  assert.equal(merged[0].items[2].text, "streamed answer");
  assert.equal(merged[0].items[2].phase, "final");
});

test("paginated history keeps chronological order while live state wins", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { mergeCodexHistoryTurns } = await vite.ssrLoadModule("/src/components/codex/codex-state.ts");
  const history = [
    {
      id: "turn-1",
      status: "completed",
      items: [{ id: "agent-1", type: "agentMessage", text: "persisted" }],
    },
    {
      id: "turn-2",
      status: "inProgress",
      items: [{ id: "command-1", type: "commandExecution", aggregatedOutput: "old" }],
    },
  ];
  const current = [
    {
      id: "turn-2",
      status: "completed",
      items: [
        { id: "command-1", type: "commandExecution", aggregatedOutput: "live", exitCode: 0 },
        { id: "agent-2", type: "agentMessage", text: "new reply" },
      ],
    },
    {
      id: "turn-3",
      status: "inProgress",
      items: [{ id: "user-3", type: "userMessage", content: [{ type: "text", text: "new turn" }] }],
    },
  ];

  const merged = mergeCodexHistoryTurns(current, history);
  assert.deepEqual(
    merged.map((turn) => turn.id),
    ["turn-1", "turn-2", "turn-3"]
  );
  assert.equal(merged[1].status, "completed");
  assert.deepEqual(
    merged[1].items.map((item) => item.id),
    ["command-1", "agent-2"]
  );
  assert.equal(merged[1].items[0].aggregatedOutput, "live");
  assert.equal(merged[1].items[0].exitCode, 0);
});

test("history pagination consumes the resume page and keeps full turns chronological", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { paginateCodexThreadHistory } = await vite.ssrLoadModule("/src/components/codex/codex-state.ts");
  const requests = [];
  const pages = new Map([
    [
      "older-2",
      {
        data: [
          {
            id: "turn-2",
            status: "completed",
            itemsView: "full",
            items: [{ id: "agent-2", type: "agentMessage", text: "second" }],
          },
        ],
        nextCursor: "older-1",
        backwardsCursor: null,
      },
    ],
    [
      "older-1",
      {
        data: [
          {
            id: "turn-1",
            status: "completed",
            itemsView: "full",
            items: [{ id: "agent-1", type: "agentMessage", text: "first" }],
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      },
    ],
  ]);

  const turns = await paginateCodexThreadHistory(
    async (request) => {
      requests.push(request);
      return pages.get(request.cursor);
    },
    {
      pageSize: 1,
      initialCursor: "newest",
      initialPage: {
        data: [
          {
            id: "turn-3",
            status: "completed",
            itemsView: "full",
            items: [{ id: "agent-3", type: "agentMessage", text: "third" }],
          },
        ],
        nextCursor: "older-2",
        backwardsCursor: "newest",
      },
    }
  );

  assert.deepEqual(
    requests.map((request) => request.cursor),
    ["older-2", "older-1"]
  );
  assert.ok(requests.every((request) => request.limit === 1 && request.itemsView === "full"));
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["turn-1", "turn-2", "turn-3"]
  );
});

test("history pagination downgrades failed full pages only once", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { paginateCodexThreadHistory } = await vite.ssrLoadModule("/src/components/codex/codex-state.ts");
  const requests = [];
  const turns = await paginateCodexThreadHistory(
    async (request) => {
      requests.push(request);
      if (request.itemsView === "full") throw Object.assign(new Error("not supported"), { code: -32601 });
      if (request.cursor === "anchor") {
        return {
          data: [
            {
              id: "turn-2",
              status: "completed",
              itemsView: "summary",
              items: [{ id: "agent-2", type: "agentMessage", text: "second" }],
            },
          ],
          nextCursor: "older",
          backwardsCursor: null,
        };
      }
      return {
        data: [
          {
            id: "turn-1",
            status: "completed",
            itemsView: "summary",
            items: [{ id: "agent-1", type: "agentMessage", text: "first" }],
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      };
    },
    {
      initialCursor: "anchor",
      shouldDowngradeItemsView: (error) => error?.code === -32601,
    }
  );

  assert.deepEqual(
    requests.map((request) => [request.cursor, request.itemsView]),
    [
      ["anchor", "full"],
      ["anchor", "summary"],
      ["older", "summary"],
    ]
  );
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["turn-1", "turn-2"]
  );
});

test("history pagination preserves full pages before an oversized page downgrade", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { paginateCodexThreadHistory } = await vite.ssrLoadModule("/src/components/codex/codex-state.ts");
  const requests = [];
  const turns = await paginateCodexThreadHistory(
    async (request) => {
      requests.push(request);
      if (request.cursor === "oversized" && request.itemsView === "full") {
        throw Object.assign(new Error("response too large"), { code: -32001 });
      }
      return {
        data: [
          {
            id: "turn-1",
            status: "completed",
            itemsView: "summary",
            items: [{ id: "agent-1", type: "agentMessage", text: "summary" }],
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      };
    },
    {
      initialPage: {
        data: [
          {
            id: "turn-2",
            status: "completed",
            itemsView: "full",
            items: [{ id: "agent-2", type: "agentMessage", text: "full" }],
          },
        ],
        nextCursor: "oversized",
        backwardsCursor: null,
      },
      shouldDowngradeItemsView: (error) => error?.code === -32001,
    }
  );

  assert.deepEqual(
    requests.map((request) => [request.cursor, request.itemsView]),
    [
      ["oversized", "full"],
      ["oversized", "summary"],
    ]
  );
  assert.deepEqual(
    turns.map((turn) => [turn.id, turn.itemsView]),
    [
      ["turn-1", "summary"],
      ["turn-2", "full"],
    ]
  );
});

test("history pagination rejects repeated cursors", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { paginateCodexThreadHistory } = await vite.ssrLoadModule("/src/components/codex/codex-state.ts");
  await assert.rejects(
    paginateCodexThreadHistory(async () => ({ data: [], nextCursor: "same", backwardsCursor: null }), {
      initialCursor: "same",
    }),
    /cursor repeated/
  );
});

test("transcript signature detects plan updates without changing the step count", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { codexTranscriptSignature } = await vite.ssrLoadModule(
    "/src/components/codex/codex-state.ts"
  );
  const signature = ({ explanation = "prepare", step = "inspect", status = "pending" } = {}) =>
    codexTranscriptSignature([
      {
        id: "turn-plan",
        status: "inProgress",
        items: [
          {
            id: "plan-1",
            type: "plan",
            explanation,
            planSteps: [{ step, status }],
          },
        ],
      },
    ]);
  const initial = signature();

  assert.notEqual(initial, signature({ explanation: "execute" }));
  assert.notEqual(initial, signature({ step: "collect" }));
  assert.notEqual(initial, signature({ status: "running" }));
});

test("thread selection snapshots reject late responses after switching away and back", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { isCodexThreadSelectionCurrent } = await vite.ssrLoadModule(
    "/src/components/codex/codex-state.ts"
  );
  const snapshot = { threadId: "thread-a", epoch: 3 };

  assert.equal(isCodexThreadSelectionCurrent(snapshot, "thread-a", 3), true);
  assert.equal(isCodexThreadSelectionCurrent(snapshot, "thread-b", 4), false);
  assert.equal(isCodexThreadSelectionCurrent(snapshot, "thread-a", 5), false);
});

test("retry branch cleanup interrupts active work before deleting", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { cleanupCodexRetryBranch } = await vite.ssrLoadModule(
    "/src/components/codex/codex-state.ts"
  );
  const calls = [];
  await cleanupCodexRetryBranch(async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return {
        thread: {
          turns: [{ id: "turn-active", status: "inProgress", items: [] }],
        },
      };
    }
    return {};
  }, "thread-branch");

  assert.deepEqual(calls, [
    ["thread/read", { threadId: "thread-branch", includeTurns: true }],
    ["turn/interrupt", { threadId: "thread-branch", turnId: "turn-active" }],
    ["thread/delete", { threadId: "thread-branch" }],
  ]);
});

test("retry branch cleanup uses a known active turn without reading first", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { cleanupCodexRetryBranch } = await vite.ssrLoadModule(
    "/src/components/codex/codex-state.ts"
  );
  const calls = [];
  await cleanupCodexRetryBranch(async (method, params) => {
    calls.push([method, params]);
    return {};
  }, "thread-branch", "turn-known");

  assert.deepEqual(calls, [
    ["turn/interrupt", { threadId: "thread-branch", turnId: "turn-known" }],
    ["thread/delete", { threadId: "thread-branch" }],
  ]);
});

test("retry branch cleanup deletes when no active turn remains", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { cleanupCodexRetryBranch } = await vite.ssrLoadModule(
    "/src/components/codex/codex-state.ts"
  );
  const calls = [];
  await cleanupCodexRetryBranch(async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return {
        thread: {
          turns: [{ id: "turn-complete", status: "completed", items: [] }],
        },
      };
    }
    return {};
  }, "thread-branch");

  assert.deepEqual(calls, [
    ["thread/read", { threadId: "thread-branch", includeTurns: true }],
    ["thread/delete", { threadId: "thread-branch" }],
  ]);
});

test("retry branch cleanup does not delete when active work cannot be interrupted", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { cleanupCodexRetryBranch } = await vite.ssrLoadModule(
    "/src/components/codex/codex-state.ts"
  );
  const calls = [];
  await assert.rejects(
    cleanupCodexRetryBranch(async (method, params) => {
      calls.push([method, params]);
      if (method === "turn/interrupt") throw new Error("connection closed");
      if (method === "thread/read") {
        return {
          thread: {
            turns: [{ id: "turn-active", status: "inProgress", items: [] }],
          },
        };
      }
      return {};
    }, "thread-branch", "turn-active"),
    /connection closed/
  );

  assert.deepEqual(calls.map(([method]) => method), ["turn/interrupt", "thread/read"]);
});

test("transcript bottom detection uses a small tolerance for mobile scrolling", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const {
    isCodexTranscriptNearBottom,
    codexTranscriptSignature,
    codexUserInputForRetry,
    codexRetryBranchPoint,
    isCodexBeforeTurnForkUnsupported,
  } = await vite.ssrLoadModule(
    "/src/components/codex/codex-state.ts"
  );
  assert.equal(isCodexTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 928, clientHeight: 0 }), true);
  assert.equal(isCodexTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 870, clientHeight: 50 }), false);
  assert.notEqual(
    codexTranscriptSignature([
      { id: "turn-1", status: "completed", items: [{ id: "item-1", type: "agentMessage", text: "a" }] },
    ]),
    codexTranscriptSignature([
      { id: "turn-1", status: "completed", items: [{ id: "item-1", type: "agentMessage", text: "ab" }] },
    ])
  );
  assert.notEqual(
    codexTranscriptSignature([
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "item-1", type: "agentMessage", text: "a" },
          { id: "item-2", type: "agentMessage", text: "tail" },
        ],
      },
    ]),
    codexTranscriptSignature([
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "item-1", type: "agentMessage", text: "ab" },
          { id: "item-2", type: "agentMessage", text: "tail" },
        ],
      },
    ])
  );
  const original = {
    id: "user-1",
    type: "userMessage",
    content: [
      { type: "text", text: "old", text_elements: [] },
      { type: "image", url: "data:image/png;base64,abc" },
    ],
  };
  assert.deepEqual(codexUserInputForRetry(original, "new"), [
    { type: "text", text: "new", text_elements: [] },
    { type: "image", url: "data:image/png;base64,abc" },
  ]);
  const turns = [
    { id: "turn-a", status: "completed", items: [] },
    { id: "turn-b", status: "completed", items: [] },
    { id: "turn-c", status: "completed", items: [] },
  ];
  assert.deepEqual(codexRetryBranchPoint(turns, "turn-b"), {
    previousTurnId: "turn-a",
    retainedTurns: [turns[0]],
  });
  assert.deepEqual(codexRetryBranchPoint(turns, "turn-a"), {
    previousTurnId: null,
    retainedTurns: [],
  });
  assert.equal(codexRetryBranchPoint(turns, "missing"), null);
  assert.equal(
    isCodexBeforeTurnForkUnsupported({
      code: -32602,
      message: "thread/fork.beforeTurnId requires experimentalApi capability",
    }),
    true
  );
  assert.equal(
    isCodexBeforeTurnForkUnsupported({ code: -32602, message: "invalid lastTurnId" }),
    false
  );
  assert.equal(
    isCodexBeforeTurnForkUnsupported({ code: -32602, message: "unknown field deferGoalContinuation" }),
    false
  );
  assert.equal(isCodexBeforeTurnForkUnsupported({ code: -32601, message: "method not found" }), false);
});
