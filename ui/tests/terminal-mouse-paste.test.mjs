import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

// Native Chrome/X11: VIBEGO_TEST_X11=1 xvfb-run -a pnpm exec node --test tests/terminal-mouse-paste.test.mjs
test("browser paste bypasses TUI mouse reporting without duplicates", async (t) => {
  const nativeX11 = process.env.VIBEGO_TEST_X11 === "1";
  const cacheDir = await mkdtemp(path.join(tmpdir(), "vibego-mouse-paste-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const server = await createServer({
    configFile: false,
    cacheDir,
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "mouse-paste-test",
      configureServer(server) {
        server.middlewares.use("/mouse-paste-test", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end(`<!doctype html><link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css">
            <body oncontextmenu="return false"><div id="terminal"></div><script type="module">
            import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
            import { bindTerminalMousePaste } from '/src/services/terminal-mouse-paste.ts';
            const terminal = new Terminal({ cols: 60, rows: 12 });
            terminal.open(document.getElementById('terminal'));
            window.data = [];
            window.pasteCount = 0;
            window.terminal = terminal;
            terminal.onData(data => window.data.push(data));
            window.unbind = bindTerminalMousePaste(document.getElementById('terminal'), terminal, () => {
              window.pasteCount++;
              navigator.clipboard.readText().then(text => terminal.paste(text));
            });
            terminal.write('\\x1b[?1003h\\x1b[?1006h\\x1b[?2004h', () => window.ready = true);
            </script>`);
        });
      },
    }],
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({
    channel: nativeX11 ? "chrome" : undefined,
    headless: !nativeX11,
    args: nativeX11 ? ["--ozone-platform=x11"] : [],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}mouse-paste-test`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => navigator.clipboard.writeText("copied-text\n中文"));
  const screen = await page.locator(".xterm-screen").boundingBox();
  const point = { x: screen.x + 30, y: screen.y + 30 };
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => { window.data = []; });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.waitForFunction(() => window.data.length > 0);
  assert.deepEqual(await page.evaluate(() => window.data), ["\x1b[200~copied-text\r中文\x1b[201~"]);
  assert.equal(await page.evaluate(() => window.pasteCount), 1);

  await page.evaluate(() => { window.data = []; });
  if (nativeX11) {
    execFileSync("xclip", ["-selection", "primary"], { input: "selected-primary", stdio: ["pipe", "ignore", "ignore"] });
    await page.mouse.click(point.x, point.y, { button: "middle" });
    await page.waitForFunction(() => window.data.length > 0);
  } else {
    await page.evaluate(({ x, y }) => {
      const textarea = window.terminal.textarea;
      const down = new MouseEvent("mousedown", { button: 1, buttons: 4, clientX: x, clientY: y, bubbles: true, cancelable: true });
      document.querySelector(".xterm-screen").dispatchEvent(down);
      if (down.defaultPrevented) throw new Error("Native PRIMARY paste was cancelled");
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "selected-primary");
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
    }, point);
  }
  assert.deepEqual(await page.evaluate(() => window.data), ["\x1b[200~selected-primary\x1b[201~"]);
  assert.equal(await page.evaluate(() => window.pasteCount), 1);

  await page.evaluate(() => { window.data = []; });
  await page.mouse.click(point.x + 50, point.y, { button: "left" });
  assert.ok((await page.evaluate(() => window.data)).some(data => /^\x1b\[<0;/.test(data)));
  await page.evaluate(() => { window.data = []; });
  await page.keyboard.down("Alt");
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.keyboard.up("Alt");
  assert.ok((await page.evaluate(() => window.data)).some(data => /^\x1b\[<10;/.test(data)));
  assert.equal(await page.evaluate(() => window.pasteCount), 1);

  await page.evaluate(() => { window.unbind(); window.data = []; });
  await page.mouse.click(point.x, point.y, { button: "right" });
  assert.ok((await page.evaluate(() => window.data)).some(data => /^\x1b\[<2;/.test(data)));
  assert.equal(await page.evaluate(() => window.pasteCount), 1);
});
