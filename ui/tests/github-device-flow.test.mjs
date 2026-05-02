import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("device polling treats only GitHub authorization_pending 202 responses as pending", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
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

  const { githubApi } = await vite.ssrLoadModule("/src/api/github.ts");
  let response = {
    status: 202,
    body: {
      success: false,
      code: "github_authorization_pending",
      error: "waiting",
      status: 202,
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(await githubApi.devicePoll("device-code"), null);

  response = { status: 200, body: { success: true, data: { login: "vibego" } } };
  assert.deepEqual(await githubApi.devicePoll("device-code"), { login: "vibego" });

  response = {
    status: 202,
    body: { success: false, code: "github_slow_down", error: "slow down", status: 202 },
  };
  assert.equal(await githubApi.devicePoll("device-code"), null);

  response = {
    status: 202,
    body: { success: false, code: "github_device_expired", error: "expired", status: 202 },
  };
  await assert.rejects(githubApi.devicePoll("device-code"), /expired/);
});
