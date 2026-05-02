import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function loadTerminalApi(t) {
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
  return vite.ssrLoadModule("/src/api/terminal.ts");
}

test("gets process identity with an encoded terminal id and abort signal", async (t) => {
  const { terminalApi } = await loadTerminalApi(t);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        shell_pid: 101,
        shell_process_group_id: 101,
        foreground_process_group_id: null,
        foreground_child_pid: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const controller = new AbortController();
  const identity = await terminalApi.getProcessIdentity("term/a ?", { signal: controller.signal });
  assert.equal(requests[0].url, "/api/terminal/term%2Fa%20%3F/process-identity");
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(identity, {
    shell_pid: 101,
    shell_process_group_id: 101,
    foreground_process_group_id: null,
    foreground_child_pid: null,
  });
});

test("preserves shared ApiError statuses for missing and unsupported runtimes", async (t) => {
  const { terminalApi } = await loadTerminalApi(t);
  const responses = [
    { status: 404, body: { error: "terminal not found" } },
    { status: 501, body: { error: "terminal runtime does not expose process identity" } },
  ];
  globalThis.fetch = async () => {
    const response = responses.shift();
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  for (const expected of [404, 501]) {
    await assert.rejects(terminalApi.getProcessIdentity("term-1"), (error) => {
      assert.equal(error.name, "ApiError");
      assert.equal(error.status, expected);
      return true;
    });
  }
});
