import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";

test("terminal page collapses exited panes and keeps the survivor when revisiting", async t => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const vite = await createServer({
    configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [{
      name: "terminal-view-stub",
      load(id) {
        if (id.endsWith("/components/terminal/terminal-instance.tsx")) return `
          import React from 'react';
          export default React.forwardRef((props, ref) => React.createElement('div', { 'data-terminal-id': props.terminalId }, props.terminalName));
        `;
      },
    }],
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const client = new QueryClient();
  t.after(async () => {
    await act(() => root.unmount());
    client.clear();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const load = path => vite.ssrLoadModule(`/src/${path}`);
  const { default: TerminalPage } = await load("components/terminal/terminal-page.tsx");
  const { DialogProvider } = await load("components/common/dialog-provider.tsx");
  const { useTerminalStore: terminals } = await load("stores/terminal-store.ts");
  const { useFrameStore: frame } = await load("stores/frame-store.ts");
  frame.getState().addToolGroup("terminal", "Shell", "shell");
  const render = visible => act(() => root.render(
    React.createElement(QueryClientProvider, { client }, React.createElement(DialogProvider, null,
      visible ? React.createElement(TerminalPage, { groupId: "shell" }) : null))
  ));
  for (const exitedId of ["child", "root"]) {
    terminals.getState().reset();
    terminals.getState().addTerminal("shell", { id: "root", name: "Root" });
    terminals.getState().addTerminal("shell", { id: "child", name: "Child", parentId: "root" });
    terminals.getState().splitTerminal("root", "root", "child", "vertical");
    terminals.getState().setTerminalStatus("shell", exitedId, "exited");
    const survivor = exitedId === "root" ? "child" : "root";
    const layout = structuredClone(terminals.getState().terminalLayouts[survivor]);
    await render(true);
    assert.deepEqual(terminals.getState().terminalLayouts[survivor], layout);
    assert.equal(document.querySelectorAll("[data-terminal-id]").length, 1);
    await render(false);
    await render(true);
    assert.deepEqual(terminals.getState().getTerminals("shell").map(terminal => terminal.id), [exitedId === "root" ? "child" : "root"]);
    assert.deepEqual(terminals.getState().terminalLayouts[survivor], layout);
    assert.equal(document.querySelectorAll("[data-terminal-id]").length, 1);
    await render(false);
  }
});

test("rerendering an exited terminal lets its delayed history replay finish", async t => {
  const temp = await mkdtemp(path.join(tmpdir(), "vibego-exited-replay-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const server = await createServer({
    cacheDir: temp,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "exited-terminal-replay",
      resolveId(id) { if (id === "virtual:exited-replay" || id === "\0virtual:exited-replay") return "\0virtual:exited-replay"; },
      load(id) {
        if (id !== "\0virtual:exited-replay") return;
        return `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {Terminal} from '@xterm/xterm';
          import TerminalInstance from '/src/components/terminal/terminal-instance.tsx';
          const open=Terminal.prototype.open;
          Terminal.prototype.open=function(...args){window.terminal=this;return open.apply(this,args);};
          const root=createRoot(document.getElementById('root'));
          window.render=()=>root.render(React.createElement(TerminalInstance,{terminalId:'exited',terminalName:'Exited',isActive:true,isExited:true,onExited:()=>{}}));
          window.render();
        `;
      },
      configureServer(server) {
        server.middlewares.use("/exited-replay", async (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end(await server.transformIndexHtml("/exited-replay", '<style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/@id/__x00__virtual:exited-replay"></script>'));
        });
      },
    }],
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  let socket, closed = false;
  await page.routeWebSocket("**/api/terminal/ws/**", route => {
    socket = route;
    route.onClose(() => { closed = true; });
  });
  await page.goto(server.resolvedUrls.local[0] + "exited-replay");
  await page.waitForFunction(() => window.terminal && window.render);
  for (let i = 0; !socket && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(socket);
  await page.evaluate(async () => {
    window.render();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(closed, false, "a read-only view must retain its history connection across renders");
  socket.send(JSON.stringify({ type: "replay", data: Buffer.from("persisted split output\r\n").toString("base64"), cursor: 24 }));
  socket.send(JSON.stringify({ type: "replay_done" }));
  socket.send(JSON.stringify({ type: "state", status: "exited", readonly: true }));
  socket.send(JSON.stringify({ type: "pty_exited" }));
  await page.waitForFunction(() => Array.from({ length: window.terminal.buffer.active.length }, (_, i) => window.terminal.buffer.active.getLine(i)?.translateToString()).join("\n").includes("persisted split output"));
});
