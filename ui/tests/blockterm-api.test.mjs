import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("normalizes BlockTerm history pagination and keeps legacy responses finite", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  const responses = [
    {
      history: [
        {
          id: "history-51",
          terminal_id: "term/a",
          workspace_session_id: "workspace/1",
          group_id: "group/a",
          user_id: "user/1",
          runtime_type: "ssh",
          ssh_profile_id: "profile/1",
          line_num: 51,
          kind: "renderer",
          command: "echo next",
          text: "rendered text",
          cwd: "/tmp",
          status: "success",
          mode: "terminal",
          output_cursor: 123,
          cmd_pid: 321,
          remote_pid: 654,
          term_cols: 120,
          term_rows: 36,
          term_flex_rows: true,
          term_max_pty_size: 1_048_576,
          before_state_json: '{"cwd":"/before"}',
          after_state_json: '{"cwd":"/after"}',
          exit_code: 0,
          started_at: 9,
          finished_at: 11,
          renderer: "markdown",
          state_json: '{"prompt:source":"pty"}',
          presentation_json: '{"height":240}',
          created_at: 10,
          starred: true,
          snapshot_updated_at: 12,
          block_deleted_at: 13,
        },
      ],
      offset: 50,
      limit: 25,
      has_more: true,
      next_offset: 51,
    },
    {
      history: [{ id: "legacy-object", terminal_id: "term-1", command: "pwd" }],
    },
    [{ id: "legacy-array", terminal_id: "term-2", command: "ls" }],
  ];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const controller = new AbortController();
  const page = await blockTermApi.listHistory({
    terminalId: "term/a",
    workspaceSessionId: "workspace/1",
    groupId: "group/a",
    runtimeType: "ssh",
    starredOnly: true,
    query: "echo &",
    limit: 25,
    offset: 50,
    signal: controller.signal,
  });
  assert.equal(
    requests[0].url,
    "/api/blockterm/history?terminal_id=term%2Fa&workspace_session_id=workspace%2F1&group_id=group%2Fa&runtime_type=ssh&starred=1&q=echo+%26&limit=25&offset=50"
  );
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(page, {
    history: [
      {
        id: "history-51",
        terminalId: "term/a",
        workspaceSessionId: "workspace/1",
        groupId: "group/a",
        userId: "user/1",
        runtimeType: "ssh",
        sshProfileId: "profile/1",
        lineNum: 51,
        kind: "renderer",
        command: "echo next",
        text: "rendered text",
        cwd: "/tmp",
        status: "success",
        mode: "terminal",
        outputCursor: 123,
        cmdPid: 321,
        remotePid: 654,
        termCols: 120,
        termRows: 36,
        termFlexRows: true,
        termMaxPtySize: 1_048_576,
        beforeStateJson: '{"cwd":"/before"}',
        afterStateJson: '{"cwd":"/after"}',
        exitCode: 0,
        startedAt: 9_000,
        finishedAt: 11_000,
        renderer: "markdown",
        stateJson: '{"prompt:source":"pty"}',
        presentationJson: '{"height":240}',
        createdAt: 10_000,
        starred: true,
        snapshotUpdatedAt: 12_000,
        blockDeletedAt: 13_000,
      },
    ],
    offset: 50,
    limit: 25,
    hasMore: true,
    nextOffset: 51,
  });

  const legacyObject = await blockTermApi.listHistory({ limit: 1, offset: 7 });
  assert.equal(requests[1].url, "/api/blockterm/history?limit=1&offset=7");
  assert.equal(legacyObject.offset, 7);
  assert.equal(legacyObject.limit, 1);
  assert.equal(legacyObject.hasMore, false);
  assert.equal(legacyObject.nextOffset, 8);
  assert.equal(legacyObject.history[0].id, "legacy-object");

  const legacyArray = await blockTermApi.listHistory({ limit: 1 });
  assert.equal(requests[2].url, "/api/blockterm/history?limit=1");
  assert.equal(legacyArray.offset, 0);
  assert.equal(legacyArray.limit, 1);
  assert.equal(legacyArray.hasMore, false);
  assert.equal(legacyArray.nextOffset, 1);
  assert.equal(legacyArray.history[0].id, "legacy-array");
});

test("sends scoped BlockTerm history favorite and purge mutations", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (options.method === "PATCH") {
      return new Response(
        JSON.stringify({
          history: {
            id: "history/1",
            terminal_id: "term/1",
            workspace_session_id: "workspace/1",
            group_id: "group/1",
            user_id: "user/1",
            command: "echo hi",
            starred: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ purged_ids: ["history/1"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const target = {
    id: "history/1",
    terminalId: "term/1",
    workspaceSessionId: "workspace/1",
    groupId: "group/1",
    userId: "user/1",
  };
  const updated = await blockTermApi.updateHistoryStarred(target, true);
  assert.equal(updated.history.starred, true);
  const purged = await blockTermApi.purgeHistory([target]);
  assert.deepEqual(purged.purgedIds, ["history/1"]);

  assert.equal(requests[0].url, "/api/blockterm/history/history%2F1");
  assert.equal(requests[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    id: "history/1",
    terminal_id: "term/1",
    workspace_session_id: "workspace/1",
    group_id: "group/1",
    user_id: "user/1",
    starred: true,
  });
  assert.equal(requests[1].url, "/api/blockterm/history");
  assert.equal(requests[1].options.method, "DELETE");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    targets: [
      {
        id: "history/1",
        terminal_id: "term/1",
        workspace_session_id: "workspace/1",
        group_id: "group/1",
        user_id: "user/1",
      },
    ],
  });
});

test("preserves empty BlockTerm history owner fields for scoped mutations", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (options.method === "PATCH") {
      return new Response(
        JSON.stringify({
          history: {
            id: "history-empty-owner",
            terminal_id: "term-empty-owner",
            workspace_session_id: "",
            group_id: "",
            user_id: "",
            command: "pwd",
            starred: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ purged_ids: ["history-empty-owner"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const listed = await blockTermApi.listHistory();
  assert.equal(listed.history.length, 0);
  const target = {
    id: "history-empty-owner",
    terminalId: "term-empty-owner",
    workspaceSessionId: "",
    groupId: "",
    userId: "",
  };
  const updated = await blockTermApi.updateHistoryStarred(target, true);
  assert.equal(updated.history.workspaceSessionId, "");
  assert.equal(updated.history.groupId, "");
  assert.equal(updated.history.userId, "");
  await blockTermApi.purgeHistory([target]);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    id: "history-empty-owner",
    terminal_id: "term-empty-owner",
    workspace_session_id: "",
    group_id: "",
    user_id: "",
    starred: true,
  });
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    targets: [
      {
        id: "history-empty-owner",
        terminal_id: "term-empty-owner",
        workspace_session_id: "",
        group_id: "",
        user_id: "",
      },
    ],
  });
});

test("loads scoped BlockTerm history output as byte-exact snapshot data", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(Uint8Array.from([0x1b, 0xff, 0x00, 0x41]), {
      status: 200,
      headers: { "X-BlockTerm-Output-Cursor": "456" },
    });
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const controller = new AbortController();
  const result = await blockTermApi.getHistoryOutput(
    {
      id: "history/1 ?",
      terminalId: "term/a ?",
      workspaceSessionId: "",
      groupId: "group/&",
      userId: "",
    },
    controller.signal
  );

  assert.equal(
    requests[0].url,
    "/api/blockterm/history/history%2F1%20%3F/output?terminal_id=term%2Fa+%3F&workspace_session_id=&group_id=group%2F%26&user_id="
  );
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(result.data, Uint8Array.from([0x1b, 0xff, 0x00, 0x41]));
  assert.equal(result.cursor, 456);
});

test("sends explicit BlockTerm list output modes", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return new Response(JSON.stringify({ blocks: [], deleted_block_ids: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  await blockTermApi.list("term/a");
  await blockTermApi.list("term/a", { includeOutput: false });
  await blockTermApi.list("term/a", { includeOutput: true });

  assert.deepEqual(requests, [
    "/api/blockterm/blocks?terminal_id=term%2Fa",
    "/api/blockterm/blocks?terminal_id=term%2Fa&include_output=0",
    "/api/blockterm/blocks?terminal_id=term%2Fa&include_output=1",
  ]);
});

test("sends the cursor-aware completion protocol and normalizes candidates", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        kind: "file",
        prefix: "fo",
        common_prefix: "foo",
        has_more: true,
        candidates: [
          { value: "foo.txt", display: "foo.txt", is_directory: false },
          { value: "foo-dir/", display: "foo-dir/", is_directory: true },
          { display: "ignored-without-value" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const controller = new AbortController();
  const result = await blockTermApi.complete({
    terminalId: "term/1",
    draft: "cat fo",
    cursor: 6,
    prefix: "fo",
    // The active terminal supplies cwd for the new protocol. This value must
    // not be sent as an override.
    cwd: "/client/override",
    kind: "file",
    executableOnly: true,
    cwd: ".",
    runtimeType: "ssh",
    sshProfileId: "profile-remote",
    signal: controller.signal,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/blockterm/completion");
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    terminal_id: "term/1",
    draft: "cat fo",
    cursor: 6,
    prefix: "fo",
    kind: "file",
    executable_only: true,
    cwd: ".",
    runtime_type: "ssh",
    ssh_profile_id: "profile-remote",
  });
  assert.deepEqual(result, {
    kind: "file",
    prefix: "fo",
    commonPrefix: "foo",
    hasMore: true,
    candidates: [
      { value: "foo.txt", display: "foo.txt", isDirectory: false },
      { value: "foo-dir/", display: "foo-dir/", isDirectory: true },
    ],
  });
});

test("falls back to the legacy completion request and suggestions response", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        kind: "command",
        common_prefix: "git-",
        suggestions: [
          { label: "git-log", kind: "command" },
          { label: "git-dir/", kind: "directory" },
          { kind: "command" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const result = await blockTermApi.complete({
    terminalId: "term-legacy",
    prefix: "git lo",
    wordPrefix: "lo",
    cwd: "/legacy-cwd",
    kind: "command",
  });

  assert.equal(requests[0].url, "/api/blockterm/completions");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    terminal_id: "term-legacy",
    cwd: "/legacy-cwd",
    prefix: "git lo",
  });
  assert.deepEqual(result, {
    kind: "command",
    prefix: "lo",
    commonPrefix: "git-",
    hasMore: false,
    candidates: [
      { value: "git-log", display: "git-log", isDirectory: false },
      { value: "git-dir/", display: "git-dir/", isDirectory: true },
    ],
  });
});

test("round-trips command lifecycle metadata through the API adapter", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        block: {
          id: "block-1",
          terminal_id: "term-1",
          command: "cd /tmp",
          runtime_type: "ssh",
          ssh_profile_id: "profile-1",
          cmd_pid: 42,
          remote_pid: null,
          term_cols: 120,
          term_rows: 40,
          term_flex_rows: true,
          term_max_pty_size: 16777216,
          before_state_json: '{"cwd":"/"}',
          after_state_json: '{"cwd":"/tmp"}',
          status: "success",
          mode: "text",
          output: "",
          exit_code: 0,
          started_at: 10,
          finished_at: 11,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const result = await blockTermApi.create({
    id: "block-1",
    terminalId: "term-1",
    command: "cd /tmp",
    runtimeType: "ssh",
    sshProfileId: "profile-1",
    cmdPid: 42,
    remotePid: null,
    termCols: 120,
    termRows: 40,
    termFlexRows: true,
    termMaxPtySize: 16777216,
    beforeStateJson: '{"cwd":"/"}',
    afterStateJson: '{"cwd":"/tmp"}',
  });
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.cmd_pid, 42);
  assert.equal(payload.runtime_type, "ssh");
  assert.equal(payload.ssh_profile_id, "profile-1");
  assert.equal(payload.remote_pid, null);
  assert.equal(payload.term_cols, 120);
  assert.equal(payload.term_rows, 40);
  assert.equal(payload.term_flex_rows, true);
  assert.equal(payload.term_max_pty_size, 16777216);
  assert.equal(result.block.cmdPid, 42);
  assert.equal(result.block.runtimeType, "ssh");
  assert.equal(result.block.sshProfileId, "profile-1");
  assert.equal(result.block.termRows, 40);
  assert.equal(result.block.beforeStateJson, '{"cwd":"/"}');
  assert.equal(result.block.afterStateJson, '{"cwd":"/tmp"}');
});

test("restarts a BlockTerm command in place with a fresh lifecycle token", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        block: {
          id: "block/a ?",
          terminal_id: "term-1",
          line_num: 7,
          kind: "command",
          command: "printf restart",
          cwd: "/tmp",
          status: "running",
          mode: "text",
          output_size: 0,
          output_cursor: null,
          term_cols: 120,
          term_rows: 40,
          term_flex_rows: true,
          term_max_pty_size: 16777216,
          before_state_json: '{"cwd":"/tmp"}',
          exit_code: null,
          started_at: 25,
          finished_at: null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const token = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const result = await blockTermApi.restart("block/a ?", {
    token,
    mode: "text",
    termCols: 120,
    termRows: 40,
    termFlexRows: true,
    termMaxPtySize: 16777216,
    beforeStateJson: '{"cwd":"/tmp"}',
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/blockterm/blocks/block%2Fa%20%3F/restart");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    token,
    mode: "text",
    term_cols: 120,
    term_rows: 40,
    term_flex_rows: true,
    term_max_pty_size: 16777216,
    before_state_json: '{"cwd":"/tmp"}',
  });
  assert.equal(result.block.id, "block/a ?");
  assert.equal(result.block.status, "running");
  assert.equal(result.block.startedAt, 25_000);
  assert.equal(result.block.outputSize, 0);
  assert.equal(result.block.outputCursor, null);
});

test("cancels an unsent BlockTerm restart with its exact lifecycle token", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        block: {
          id: "block/a ?",
          terminal_id: "term-1",
          kind: "command",
          command: "printf restart",
          cwd: "/tmp",
          status: "interrupted",
          mode: "text",
          output_size: 0,
          output_cursor: null,
          before_state_json: '{"cwd":"/tmp"}',
          after_state_json: '{"cwd":"/tmp"}',
          exit_code: null,
          started_at: 25,
          finished_at: 26,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const token = "fedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcba";
  const result = await blockTermApi.cancelRestart("block/a ?", token);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/blockterm/blocks/block%2Fa%20%3F/restart/cancel");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), { token });
  assert.equal(result.block.status, "interrupted");
  assert.equal(result.block.finishedAt, 26_000);
});

test("loads raw BlockTerm output as bytes with its retained PTY cursor range", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response(Uint8Array.from([0x1b, 0xff, 0x00]), {
        status: 200,
        headers: {
          "X-BlockTerm-Output-Start-Cursor": "120",
          "X-BlockTerm-Output-End-Cursor": "123",
          "X-BlockTerm-Output-Cursor": "122",
        },
      });
    }
    if (requests.length === 2) {
      return new Response(Uint8Array.from([0x61]), {
        status: 200,
        headers: {
          "X-BlockTerm-Output-Start-Cursor": "+123",
          "X-BlockTerm-Output-Cursor": "124.0",
        },
      });
    }
    if (requests.length === 3) {
      return new Response(Uint8Array.from([0x62]), {
        status: 200,
        headers: {
          "X-BlockTerm-Output-Start-Cursor": "123",
          "X-BlockTerm-Output-End-Cursor": "124",
        },
      });
    }
    return new Response(JSON.stringify({ error: "raw output unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { BlockTermApiError, blockTermApi } = await vite.ssrLoadModule("/src/api/blockterm.ts");
  const controller = new AbortController();
  const result = await blockTermApi.getRawOutput("block/a ?", controller.signal);

  assert.equal(requests[0].url, "/api/blockterm/blocks/block%2Fa%20%3F/raw-output");
  assert.equal(requests[0].options.signal, controller.signal);
  assert.equal(result.startCursor, 120);
  assert.equal(result.endCursor, 123);
  assert.deepEqual(result.data, Uint8Array.from([0x1b, 0xff, 0x00]));

  const invalidRange = await blockTermApi.getRawOutput("invalid-range");
  assert.equal(invalidRange.startCursor, null);
  assert.equal(invalidRange.endCursor, null);

  const incremental = await blockTermApi.getRawOutput("block/a ?", undefined, 123);
  assert.equal(requests[2].url, "/api/blockterm/blocks/block%2Fa%20%3F/raw-output?cursor=123");
  assert.equal(incremental.startCursor, 123);
  assert.equal(incremental.endCursor, 124);
  assert.deepEqual(incremental.data, Uint8Array.from([0x62]));

  await assert.rejects(blockTermApi.getRawOutput("missing"), (error) => {
    assert.equal(error instanceof BlockTermApiError, true);
    assert.equal(error.status, 503);
    assert.equal(error.message, "raw output unavailable");
    assert.deepEqual(error.body, { error: "raw output unavailable" });
    return true;
  });
});

test("preserves the tombstone response body on stable-ID create conflicts", async (t) => {
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "block has been deleted" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });

  const [{ BlockTermApiError, blockTermApi }, { isBlockTermTombstoneError }] = await Promise.all([
    vite.ssrLoadModule("/src/api/blockterm.ts"),
    vite.ssrLoadModule("/src/components/terminal/blockterm-persistence.ts"),
  ]);

  await assert.rejects(
    blockTermApi.create({ id: "deleted-id", terminalId: "term-1", lineNum: 0, command: "echo replay" }),
    (error) => {
      assert.equal(error instanceof BlockTermApiError, false);
      assert.equal(error.status, 409);
      assert.deepEqual(error.body, { error: "block has been deleted" });
      assert.equal(isBlockTermTombstoneError(error), true);
      return true;
    }
  );
});
