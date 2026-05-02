import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("commit APIs send commit options and preserve scoped draft payloads", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const requests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, hash: "abc123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { gitApi } = await vite.ssrLoadModule("/src/api/git.ts");
  await gitApi.commitSelected(
    "/repo",
    [],
    [],
    "empty commit",
    "details",
    { workspace_session_id: "session-a", group_id: "group-a" },
    { noVerify: true, signOff: true, allowEmpty: true }
  );
  await gitApi.amend(
    "/repo",
    [],
    [],
    "amend",
    undefined,
    { noVerify: false, signOff: true, allowEmpty: false },
    { workspace_session_id: "session-b", group_id: "group-b" }
  );
  await gitApi.commit("/repo", "ordinary", undefined, undefined, {
    noVerify: true,
    signOff: false,
    allowEmpty: false,
  });

  assert.deepEqual(requests, [
    {
      path: "/repo",
      files: [],
      patches: [],
      summary: "empty commit",
      description: "details",
      workspace_session_id: "session-a",
      group_id: "group-a",
      noVerify: true,
      signOff: true,
      allowEmpty: true,
    },
    {
      path: "/repo",
      files: [],
      patches: [],
      summary: "amend",
      workspace_session_id: "session-b",
      group_id: "group-b",
      noVerify: false,
      signOff: true,
      allowEmpty: false,
    },
    {
      path: "/repo",
      message: "ordinary",
      noVerify: true,
      signOff: false,
      allowEmpty: false,
    },
  ]);
});
