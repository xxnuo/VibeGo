import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("builds image data URLs only for bounded raster payloads", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { buildGitImageSource, isSafeImageContent, isSafeImageMimeType } = await vite.ssrLoadModule(
    "/src/components/git/git-image-diff.tsx"
  );

  assert.equal(isSafeImageMimeType("image/png"), true);
  assert.equal(isSafeImageMimeType("image/svg+xml"), false);
  assert.equal(isSafeImageMimeType("text/html"), false);
  assert.equal(isSafeImageContent("iVBORw=="), true);
  assert.equal(isSafeImageContent("not base64!"), false);
  assert.equal(buildGitImageSource("image/png", "iVBORw=="), "data:image/png;base64,iVBORw==");
  assert.equal(buildGitImageSource("image/svg+xml", "PHN2Zz4="), null);
  assert.equal(buildGitImageSource("image/png", "<script>"), null);
});
