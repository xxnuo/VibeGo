import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("split workspace with real PTYs: pane controls, resize, exits, reload, peers and retained history", { timeout: 180_000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), "vibego-split-"));
  const address = path.join(temp, "address");
  const backend = spawn("go", ["test", "./internal/handler", "-run", "^TestTerminalMemoryHarness$", "-timeout", "4m", "-v"], {
    cwd: path.resolve(".."), env: { ...process.env, VIBEGO_TERMINAL_HARNESS_FILE: address }, stdio: ["ignore", "pipe", "pipe"],
  });
  let backendLog = "";
  backend.stdout.on("data", data => { backendLog = (backendLog + data).slice(-20000); });
  backend.stderr.on("data", data => { backendLog = (backendLog + data).slice(-20000); });
  t.after(async () => {
    await writeFile(address + ".stop", "stop");
    for (let i = 0; i < 50 && backend.exitCode === null; i++) await sleep(100);
    if (backend.exitCode === null) backend.kill("SIGTERM");
    if (backend.exitCode) console.error(backendLog);
    await rm(temp, { recursive: true, force: true });
  });
  let target;
  for (let i = 0; i < 300; i++) {
    try { target = await readFile(address, "utf8"); break; } catch {}
    if (backend.exitCode !== null) throw new Error(backendLog);
    await sleep(100);
  }
  assert.ok(target, backendLog);
  const server = await createServer({
    cacheDir: path.join(temp, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target, ws: true }, "/harness": { target } } },
    plugins: [{ name: "terminal-split-browser",
      resolveId(id) { if (id === "virtual:split-test" || id === "\0virtual:split-test") return "\0virtual:split-test"; },
      load(id) {
        if (id !== "\0virtual:split-test") return;
        return `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {Terminal} from '@xterm/xterm';
          import '/src/index.css';
          import TerminalPage from '/src/components/terminal/terminal-page.tsx';
          import {DialogProvider} from '/src/components/common/dialog-provider.tsx';
          import {terminalApi} from '/src/api/terminal.ts';
          import {workspaceApi} from '/src/api/workspace-sync.ts';
          import {useTerminalStore as terminals} from '/src/stores/terminal-store.ts';
          import {useFrameStore as frame} from '/src/stores/frame-store.ts';
          import {useSessionStore as session} from '/src/stores/session-store.ts';
          import {useWorkspaceSyncStore as sync} from '/src/stores/workspace-sync-store.ts';
          import {workspaceSnapshotState} from '/src/stores/workspace-viewport.ts';
          import {sanitizeTerminalWorkspaceState} from '/src/stores/session-workspace-guard.ts';
          import {useAppStore} from '/src/stores/app-store.ts';
          localStorage.setItem('vibego_auth_key','test-key');
          useAppStore.setState({locale:'zh'});
          window.api=terminalApi;window.terminals=terminals;window.frame=frame;window.sync=sync;
          window.xterms={};window.opens={};
          const open=Terminal.prototype.open;
          Terminal.prototype.open=function(element,...args){const id=element.closest('[data-pane-id]')?.dataset.paneId;if(id){window.xterms[id]=this;window.opens[id]=(window.opens[id]||0)+1;}return open.call(this,element,...args);};
          window.output=id=>{const term=window.xterms[id];return term?Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()).join('\\n'):'';};
          window.send=(id,text)=>window.xterms[id].input(text,true);
          const snapshot=await workspaceApi.getSnapshot('ws');
          await sync.getState().connect('ws',snapshot);
          if(!snapshot.tools.some(tool=>tool.id==='shell')){frame.getState().addToolGroup('terminal','Shell','shell');await sync.getState().flush();}
          session.setState({currentSessionId:'ws',sessionInitialized:true,loading:false});
          const restored=workspaceSnapshotState(await workspaceApi.getSnapshot('ws'));
          const normalized=sanitizeTerminalWorkspaceState(restored);
          terminals.setState({...normalized,activeIdByGroup:normalized.activeTerminalByGroup});
          frame.setState({activeGroupId:'shell'});
          const client=new QueryClient();
          function Actions(){const menus=frame(s=>s.pageMenuItems);const top=frame(s=>s.topBarConfig);return React.createElement('div',{id:'actions',style:{display:'flex',gap:12,height:36,flexShrink:0}},
            ...(top.rightButtons||[]).map((item,i)=>React.createElement('button',{key:'top'+i,'data-action':'new',onClick:item.onClick},item.title)),
            ...menus.map(item=>React.createElement('button',{key:item.id,'data-action':item.id,onClick:item.onClick},item.label)));}
          function App(){return React.createElement(QueryClientProvider,{client},React.createElement(DialogProvider,null,
            React.createElement('div',{style:{height:'100%',display:'flex',flexDirection:'column'}},React.createElement(Actions),
              React.createElement('div',{style:{flex:1,minHeight:0}},React.createElement(TerminalPage,{groupId:'shell'})))));}
          createRoot(document.getElementById('root')).render(React.createElement(App));
          window.ready=true;
        `;
      },
      configureServer(server) {
        server.middlewares.use("/split-test", async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/split-test", '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;background:#18181b;color:#ddd}</style><div id="root"></div><script type="module" src="/@id/__x00__virtual:split-test"></script>'));
        });
      },
    }],
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  const url = server.resolvedUrls.local[0] + "split-test";
  const pane = id => page.locator(`[data-pane-id="${id}"]`);
  const ids = () => page.evaluate(() => window.terminals.getState().getTerminals("shell").map(item => item.id));
  const ready = id => page.waitForFunction(id => window.output(id).trim().length > 0, id);
  const split = async (id, direction) => {
    const before = await ids();
    if (before.length === 1) await page.locator(`[data-action="split-${direction === "vertical" ? "down" : "right"}"]`).click();
    else await pane(id).getByRole("button", { name: direction === "vertical" ? "向下分屏" : "向右分屏", exact: true }).click();
    await page.waitForFunction(count => window.terminals.getState().getTerminals("shell").length === count + 1, before.length);
    const added = (await ids()).find(id => !before.includes(id));
    await ready(added);
    return added;
  };
  await page.goto(url);
  await page.waitForFunction(() => window.ready);
  await page.locator('[data-action="new"]').click();
  await page.waitForFunction(() => window.terminals.getState().getTerminals("shell").length === 1);
  const rootId = (await ids())[0];
  await ready(rootId);
  const initialOpens = await page.evaluate(id => window.opens[id], rootId);
  await page.route("**/api/terminal", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.parent_id) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "split creation rejected" }) });
    } else await route.continue();
  });
  await page.locator('[data-action="split-right"]').click();
  await expect(page.getByRole("dialog")).toContainText("split creation rejected");
  await page.getByRole("dialog").getByRole("button").last().click();
  await page.unroute("**/api/terminal");
  assert.deepEqual(await ids(), [rootId], "failed split changed existing panes");
  let splitRequests = 0;
  await page.route("**/api/terminal", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.parent_id) splitRequests++;
    await route.continue();
  });
  await page.evaluate(() => {
    const action = window.frame.getState().pageMenuItems.find(item => item.id === "split-right");
    action.onClick(); action.onClick();
  });
  await page.waitForFunction(() => window.terminals.getState().getTerminals("shell").length === 2);
  const child = (await ids()).find(id => id !== rootId);
  await ready(child);
  await page.unroute("**/api/terminal");
  assert.equal(splitRequests, 1, "repeated split actions created duplicate PTYs");
  assert.equal(await page.evaluate(id => window.opens[id], rootId), initialOpens, "splitting remounted the existing xterm");
  await page.evaluate(id => window.send(id, "printf 'surviving-pane-marker\\n'\r"), rootId);
  await page.waitForFunction(id => window.output(id).includes("surviving-pane-marker"), rootId);
  await page.evaluate(id => window.send(id, "cd /tmp; printf '\\033]7;file://localhost/tmp\\007'\r"), child);
  await page.waitForFunction(id => window.api.list().then(result => result.terminals.find(item => item.id === id)?.current_cwd === "/tmp"), child);
  const nested = await split(child, "vertical");
  assert.equal((await page.evaluate(() => window.api.list())).terminals.find(item => item.id === nested).cwd, "/tmp");
  await expect(page.getByRole("separator")).toHaveCount(2);
  const rootSplitButton = pane(rootId).getByRole("button", { name: "向右分屏", exact: true });
  await rootSplitButton.focus();
  await page.waitForTimeout(80); // The terminal's delayed focus must not steal keyboard toolbar focus.
  await expect(rootSplitButton).toBeFocused();
  const firstSeparator = page.getByRole("separator").first();
  await firstSeparator.focus();
  await firstSeparator.press("ArrowRight");
  await expect(firstSeparator).toHaveAttribute("aria-valuenow", "52");
  const bounds = await firstSeparator.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 4);
  await page.mouse.down();
  await page.mouse.move(720, bounds.y + bounds.height / 4);
  await page.mouse.up();
  await expect(firstSeparator).toHaveAttribute("aria-valuenow", "60");
  await firstSeparator.dblclick();
  await expect(firstSeparator).toHaveAttribute("aria-valuenow", "50");
  await pane(child).getByRole("button", { name: "放大窗格", exact: true }).click();
  await expect(pane(rootId)).toBeHidden();
  await expect(pane(child)).toBeVisible();
  await pane(child).getByRole("button", { name: "恢复分屏", exact: true }).click();
  await expect(pane(rootId)).toBeVisible();
  await pane(rootId).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(pane(child)).toHaveAttribute("data-focused", "true");
  await page.locator('[data-action="balance-panes"]').click();
  await expect(firstSeparator).toHaveAttribute("aria-valuenow", "33");
  const savedLayout = await page.evaluate(() => structuredClone(window.terminals.getState().getActiveLayout("shell")));
  await page.waitForTimeout(400); // Allow the production viewport debounce to persist.
  await page.reload();
  await page.waitForFunction(() => window.ready && window.terminals.getState().getTerminals("shell").length === 3);
  assert.deepEqual(await page.evaluate(() => window.terminals.getState().getActiveLayout("shell")), savedLayout);
  await ready(rootId);
  await page.waitForFunction(id => window.output(id).includes("surviving-pane-marker"), rootId);
  const peer = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  peer.on("pageerror", error => errors.push(String(error)));
  await peer.goto(url);
  await peer.waitForFunction(() => window.ready && window.terminals.getState().getTerminals("shell").length === 3);
  await peer.evaluate(id => window.terminals.getState().setActiveId("shell", id), rootId);
  await expect(peer.locator("[data-pane-id]")).toHaveCount(3);
  for (const separator of await peer.getByRole("separator").all()) await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  const touchSeparator = peer.getByRole("separator").first();
  const touchBounds = await touchSeparator.boundingBox();
  const touchX = touchBounds.x + touchBounds.width / 4;
  const touchY = touchBounds.y + touchBounds.height / 2;
  const touchBefore = Number(await touchSeparator.getAttribute("aria-valuenow"));
  const cdp = await peer.context().newCDPSession(peer);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX, y: touchY + 45 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => Number(await touchSeparator.getAttribute("aria-valuenow"))).toBeGreaterThan(touchBefore);
  await touchSeparator.press("Enter");
  const screenshotDir = path.resolve("../temp/dev/split-redesign");
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, "desktop.png") });
  await peer.screenshot({ path: path.join(screenshotDir, "mobile.png") });
  await page.evaluate(id => window.send(id, "printf 'root-exit-tail\\n'; exit\r"), rootId);
  await expect(pane(rootId)).toHaveCount(0);
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(peer.locator(`[data-pane-id="${rootId}"]`)).toHaveCount(0);
  await expect(peer.locator("[data-pane-id]")).toHaveCount(2);
  const history = await page.evaluate(() => window.api.list({ status: "history" }));
  assert.ok(history.terminals.some(item => item.id === rootId));
  await page.waitForFunction(() => fetch('/harness/metrics').then(res => res.json()).then(metrics => metrics.active === 2));
  const retainedOutput = await page.evaluate(id => new Promise((resolve, reject) => {
    const ws = new WebSocket(window.api.wsUrl(id)); let text = "";
    const timer = setTimeout(() => { ws.close(); reject(new Error("history replay timed out")); }, 5000);
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === "replay" && typeof message.data === "string") text += atob(message.data);
      if (message.stream_id && typeof message.cursor === "number") ws.send(JSON.stringify({ type: "ack", stream_id: message.stream_id, cursor: message.cursor }));
      if (message.type === "pty_exited") ws.close();
    };
    ws.onclose = () => { clearTimeout(timer); resolve(text); }; ws.onerror = () => { clearTimeout(timer); reject(new Error("history socket failed")); };
  }), rootId);
  assert.ok(retainedOutput.includes("root-exit-tail"), "collapsing the root lost its final output");
  const deletion = await page.evaluate(id => window.api.deleteBatch([id]), rootId);
  assert.deepEqual(deletion.deleted_ids, [rootId]);
  assert.equal((await page.evaluate(() => window.api.list())).terminals.filter(item => item.status === "running").length, 2);
  await page.reload();
  await page.waitForFunction(() => window.ready && window.terminals.getState().getTerminals("shell").length === 2);
  await expect(page.getByRole("separator")).toHaveCount(1);
  await ready(child);
  const opensBeforeClose = await page.evaluate(id => window.opens[id], nested);
  await pane(child).getByRole("button", { name: "关闭分屏", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(pane(child)).toHaveCount(0);
  await expect(pane(nested)).toBeVisible();
  await expect(page.getByRole("separator")).toHaveCount(0);
  assert.equal(await page.evaluate(id => window.opens[id], nested), opensBeforeClose, "collapsing a split remounted the survivor");
  await ready(nested);
  let releaseCreate;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  let pendingChild;
  let completeCreate;
  const createCompleted = new Promise(resolve => { completeCreate = resolve; });
  await page.route("**/api/terminal", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.parent_id === nested) {
      const response = await route.fetch();
      pendingChild = (await response.json()).id;
      await createGate;
      await route.fulfill({ response });
      completeCreate();
    } else await route.continue();
  });
  await page.locator('[data-action="split-down"]').click();
  await expect.poll(() => pendingChild).toBeTruthy();
  await page.evaluate(id => window.send(id, "printf 'final-pane-exit\\n'; exit\r"), nested);
  await expect(pane(nested)).toHaveCount(0);
  releaseCreate();
  await createCompleted;
  await page.unroute("**/api/terminal");
  await expect(page.locator("[data-pane-id]")).toHaveCount(0);
  await page.waitForFunction(() => window.terminals.getState().isListManagerOpen("shell"));
  const finalHistory = await page.evaluate(() => window.api.list({ status: "history" }));
  assert.ok(finalHistory.terminals.some(item => item.id === nested));
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.deepEqual(await ids(), []);
  await page.waitForFunction(() => fetch('/harness/metrics').then(res => res.json()).then(metrics => metrics.active === 0));
  assert.equal((await page.evaluate(() => window.api.list())).terminals.some(item => item.id === pendingChild), false, "stale split result left an orphan PTY");
  await page.locator('[data-action="new"]').click();
  await page.waitForFunction(() => window.terminals.getState().getTerminals("shell").length === 1);
  const standalone = (await ids())[0];
  await ready(standalone);
  const standaloneOpens = await page.evaluate(id => window.opens[id], standalone);
  await page.evaluate(id => window.send(id, "printf 'standalone-exit-output\\n'; exit\r"), standalone);
  await page.waitForFunction(id => window.terminals.getState().getTerminals("shell").find(item => item.id === id)?.status === "exited", standalone);
  await page.waitForFunction(id => window.output(id).includes("standalone-exit-output"), standalone);
  assert.equal(await page.evaluate(id => window.opens[id], standalone), standaloneOpens, "exiting a standalone terminal remounted its read-only history view");
  await expect(pane(standalone)).toBeVisible();
  await page.evaluate(id => window.api.close(id), standalone);
  await expect(page.locator("[data-pane-id]")).toHaveCount(0);
  assert.deepEqual(errors, []);
});
