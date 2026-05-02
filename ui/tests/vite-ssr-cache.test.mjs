import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("SSR test servers preserve an existing browser dependency cache", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "vibego-vite-cache-"));
  const cachedModule = path.join(cacheDir, "deps", "browser-module.js");
  let server;
  try {
    await mkdir(path.dirname(cachedModule));
    await writeFile(cachedModule, "export const cached = true;");
    server = await createServer({
      appType: "custom",
      cacheDir,
      server: { hmr: false, middlewareMode: true },
    });
    await server.ssrLoadModule("/src/api/file.ts");
    await server.close();
    server = undefined;
    assert.equal(await readFile(cachedModule, "utf8"), "export const cached = true;");
  } finally {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
