import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function loadBlockTermViewApi(t) {
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

  return vite.ssrLoadModule("/src/api/blockterm-view.ts");
}

test("gets and sanitizes the canonical BlockTerm session view", async (t) => {
  const { blockTermViewApi } = await loadBlockTermViewApi(t);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        view: {
          sidebar: {
            open: true,
            width: "500px",
            block_id: "block-1",
            blockId: "legacy-must-not-win",
            ignored: true,
          },
          ignored: true,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const controller = new AbortController();
  const response = await blockTermViewApi.getView("term/a ?", { signal: controller.signal });

  assert.equal(requests[0].url, "/api/blockterm/sessions/term%2Fa%20%3F/view");
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(response, {
    view: { sidebar: { open: true, width: "500px", blockId: "block-1" } },
  });
});

test("patches only provided nested fields and preserves a null sidebar block", async (t) => {
  const { blockTermViewApi } = await loadBlockTermViewApi(t);
  const requests = [];
  const responses = [
    { view: { sidebar: { open: true, width: "320px", block_id: "block-1" } } },
    { view: { sidebar: { open: false, width: "320px", block_id: null } } },
  ];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await blockTermViewApi.patchView("term/1", { sidebar: { width: "320px" } });
  const controller = new AbortController();
  const cleared = await blockTermViewApi.patchView(
    "term/1",
    { sidebar: { open: false, blockId: null } },
    { signal: controller.signal }
  );

  assert.deepEqual(
    requests.map(({ url, options }) => ({
      url,
      method: options.method,
      body: JSON.parse(options.body),
      signal: options.signal,
    })),
    [
      {
        url: "/api/blockterm/sessions/term%2F1/view",
        method: "PATCH",
        body: { sidebar: { width: "320px" } },
        signal: undefined,
      },
      {
        url: "/api/blockterm/sessions/term%2F1/view",
        method: "PATCH",
        body: { sidebar: { open: false, block_id: null } },
        signal: controller.signal,
      },
    ]
  );
  assert.deepEqual(cleared, {
    view: { sidebar: { open: false, width: "320px", blockId: null } },
  });
});

test("patches the strict next_connection wire contract", async (t) => {
  const { blockTermViewApi } = await loadBlockTermViewApi(t);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        view: {
          sidebar: { open: false, width: "50%", block_id: null },
          next_connection: { runtime_type: "ssh", ssh_profile_id: "profile-a", cwd: "/remote/a" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const response = await blockTermViewApi.patchView("term-1", {
    nextConnection: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "/remote/a" },
  });

  assert.deepEqual(JSON.parse(requests[0].options.body), {
    next_connection: { runtime_type: "ssh", ssh_profile_id: "profile-a", cwd: "/remote/a" },
  });
  assert.deepEqual(response.view.nextConnection, {
    runtimeType: "ssh",
    sshProfileId: "profile-a",
    cwd: "/remote/a",
  });
});

test("keeps the portable cwd sentinel in an identity-switch patch", async (t) => {
  const { blockTermViewApi } = await loadBlockTermViewApi(t);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        view: {
          sidebar: { open: false, width: "50%", block_id: null },
          next_connection: { runtime_type: "ssh", ssh_profile_id: "profile-a", cwd: "." },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  await blockTermViewApi.patchView("term-1", {
    nextConnection: { runtimeType: "ssh", sshProfileId: "profile-a", cwd: "." },
  });

  assert.deepEqual(JSON.parse(requests[0].options.body), {
    next_connection: { runtime_type: "ssh", ssh_profile_id: "profile-a", cwd: "." },
  });
});

test("rejects non-canonical BlockTerm view responses", async (t) => {
  const { blockTermViewApi } = await loadBlockTermViewApi(t);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sidebar: { open: false, width: "50%", block_id: null } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  await assert.rejects(blockTermViewApi.getView("term-1"), {
    name: "TypeError",
    message: "Invalid BlockTerm view response",
  });
});

test("preserves the shared API error contract", async (t) => {
  const { blockTermViewApi } = await loadBlockTermViewApi(t);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "view denied", code: "view_denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

  await assert.rejects(blockTermViewApi.patchView("term-1", { sidebar: { open: true } }), (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.message, "view denied");
    assert.equal(error.status, 403);
    assert.deepEqual(error.body, { error: "view denied", code: "view_denied" });
    return true;
  });
});
