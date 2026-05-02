import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("uses durable BlockTerm identity for SSH renderer file requests", async (t) => {
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
    if (String(url).includes("view-url")) {
      return new Response(JSON.stringify({ url: "/view/1", expires_at: 123 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/info")) {
      return new Response(JSON.stringify({ path: "/tmp/a.txt", name: "a.txt", size: 1, isDir: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, exist: true, content: "x", path: "/tmp/a.txt", size: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { createRendererFileClient } = await vite.ssrLoadModule("/src/api/file.ts");
  const client = createRendererFileClient({
    runtimeType: "ssh",
    terminalId: "terminal/a",
    blockId: "block/1",
    createdAt: 1_700_000_000_123,
  });
  await client.info("docs/readme.md");
  await client.read("docs/readme.md");
  await client.check("docs/readme.md");
  await client.save("docs/readme.md", "updated");
  await client.viewUrl("docs/readme.md");

  assert.equal(requests.length, 5);
  assert.match(requests[0].url, /terminal_id=terminal%2Fa/u);
  assert.match(requests[0].url, /block_id=block%2F1/u);
  assert.match(requests[0].url, /block_created_at=1700000000/u);
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    terminal_id: "terminal/a",
    path: "docs/readme.md",
    block_id: "block/1",
    block_created_at: 1700000000,
  });
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    terminal_id: "terminal/a",
    path: "docs/readme.md",
    block_id: "block/1",
    block_created_at: 1700000000,
    content: "updated",
  });
});
