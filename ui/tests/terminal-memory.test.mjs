import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("bounded terminal views, cache, and real PTY lifecycle", {timeout: 900_000}, async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "vibego-terminal-memory-"));
  const address = path.join(temp, "address");
  const backend = spawn("go", ["test", "./internal/handler", "-run", "^TestTerminalMemoryHarness$", "-timeout", "16m", "-v"], {
    cwd: path.resolve(".."), env: {...process.env, VIBEGO_TERMINAL_HARNESS_FILE: address}, stdio: ["ignore", "pipe", "pipe"],
  });
  let backendLog = "";
  backend.stdout.on("data", (data) => { backendLog = (backendLog + data).slice(-20000); });
  backend.stderr.on("data", (data) => { backendLog = (backendLog + data).slice(-20000); });
  t.after(async () => {
    await writeFile(address + ".stop", "stop");
    for (let i=0;i<100 && backend.exitCode === null;i++) await sleep(100);
    if (backend.exitCode === null) backend.kill("SIGTERM");
    if (backend.exitCode) console.error(backendLog);
    await rm(temp,{recursive:true,force:true});
  });
  let target;
  for (let i=0;i<300;i++) {
    try { target = await readFile(address,"utf8"); break; } catch {}
    if (backend.exitCode !== null) throw new Error(backendLog);
    await sleep(100);
  }
  assert.ok(target, backendLog);
  const server = await createServer({
    cacheDir: path.join(temp,"vite-cache"),
    server: {host:"127.0.0.1",port:0,proxy:{"/api":{target,ws:true},"/harness":{target}}},
    plugins: [{name:"terminal-memory-harness",
 resolveId(id) { if (id === "virtual:terminal-memory.tsx" || id === "\0virtual:terminal-memory.tsx") return "\0virtual:terminal-memory.tsx"; },
 load(id) { if (id !== "\0virtual:terminal-memory.tsx") return; return `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import TerminalInstance from '/src/components/terminal/terminal-instance.tsx';
          import {Terminal} from '@xterm/xterm';
          window.debugTerminals=new Set();const open=Terminal.prototype.open;const dispose=Terminal.prototype.dispose;
          Terminal.prototype.open=function(...args){window.debugTerminals.add(this);return open.apply(this,args);};
          Terminal.prototype.dispose=function(...args){window.debugTerminals.delete(this);return dispose.apply(this,args);};
          import {terminalApi} from '/src/api/terminal.ts';
          import * as cache from '/src/services/terminal-session-cache.ts';
          import {useTerminalEventSupport,receiveTerminalEvent} from '/src/services/terminal-runtime-events.ts';
          localStorage.setItem('vibego_auth_key','test-key');
          window.api=terminalApi; window.cache=cache; window.events=[];
          const events=new WebSocket(location.origin.replace('http','ws')+'/api/workspace/events?workspace_id=ws&key=test-key');
          events.onmessage=(event)=>{const msg=JSON.parse(event.data);if(msg.type==='workspace:snapshot') {useTerminalEventSupport.setState({supported:msg.terminal_events});window.ready=true;} if(msg.terminal_event){window.events.push(msg.terminal_event);if(window.events.length>100)window.events.shift();receiveTerminalEvent(msg.terminal_event);}};
          const root=createRoot(document.getElementById('root'));
          window.views=[];window.active='';window.handles={};
          window.render=()=>root.render(React.createElement('div',{className:'view'},...window.views.map(id=>React.createElement(TerminalInstance,{key:id,terminalId:id,terminalName:id,isActive:window.splitIds?window.splitIds.includes(id):id===window.active,isFocused:id===window.active,ref:(ref)=>{if(ref)window.handles[id]=ref;else delete window.handles[id];}}))));
          window.switchTo=(id)=>{window.splitIds=null;window.active=id;window.render();};
          window.send=(id,text)=>window.handles[id].sendInput(text);
          window.render();
        `; },
 configureServer(server) {
      server.middlewares.use("/memory-test", async (_req,res) => {
        res.setHeader("Content-Type","text/html");
        res.end(await server.transformIndexHtml("/memory-test", `<!doctype html><style>html,body,#root{height:100%;margin:0} .view{height:100%;position:relative}</style><div id="root"></div><script type="module" src="/@id/__x00__virtual:terminal-memory.tsx"></script>`));
      });

    }}],
  });
  t.after(() => server.close());
  await server.listen();
  const browserServer=await chromium.launchServer({headless:true,args:["--js-flags=--expose-gc"]});
  console.log('BROWSER_ENDPOINT '+browserServer.wsEndpoint());
  const browser=await chromium.connect(browserServer.wsEndpoint());
  t.after(()=>browserServer.close());
  const page=await browser.newPage({viewport:{width:1000,height:650}});
  const cdp=await page.context().newCDPSession(page);
  const errors=[];page.on("pageerror",error=>errors.push(String(error)));
  const consoleCounts={};page.on('console',message=>{const key=message.text().slice(0,100);consoleCounts[key]=(consoleCounts[key]??0)+1;});
  await page.goto(server.resolvedUrls.local[0]+"memory-test");
  await page.waitForFunction(()=>window.ready,{timeout:30_000});
  const create=()=>page.evaluate(async()=>{const terminal=await window.api.create({name:'memory',cols:80,rows:24,workspace_session_id:'ws'});return terminal.id;});
  const show=async(id)=>{
    await page.evaluate(id=>{if(!window.views.includes(id))window.views.push(id);window.switchTo(id);},id);
    await page.waitForFunction(id=>Boolean(window.handles[id]),id);
    await page.waitForFunction(id=>document.querySelector(`[data-terminal-id="${id}"]`)?.dataset.lifecycle === "live",id);
  };
  const metrics=async()=>{
    const backend=await (await fetch(target+"/harness/metrics")).json();
    await cdp.send('HeapProfiler.collectGarbage');
    const heap=await cdp.send('Runtime.getHeapUsage');
    const browser={heap:heap.usedSize,views:await page.locator('.xterm').count()};
    const terminal=await page.evaluate(()=>[...window.debugTerminals].map(t=>({lines:t.buffer.active.length,pending:t._core._writeBuffer?._pendingData,writes:t._core._writeBuffer?._writeBuffer?.length,scrollback:t.options.scrollback})));
    return {...backend,browser,terminal,consoleCounts};
  };
  for(let i=0;i<30;i++){const id=await create();await show(id);}
  assert.ok(await page.locator('.xterm').count()<=3,"hidden xterm views exceeded budget");
  const ids=await page.evaluate(()=>[...window.views]);
  await show(ids[0]);
  await page.evaluate(ids=>{window.splitIds=ids.slice(0,2);window.render();},ids);
  await page.waitForFunction(ids=>ids.slice(0,2).every(id=>!!window.handles[id]),ids);
  assert.ok(await page.locator('.xterm').count()<=4,'split views plus hidden views exceeded budget');
  await page.evaluate(id=>window.send(id,"(sleep 1; printf '\\033]9;background-check\\007\\033]7;file:///tmp/background-check\\007') &\n"),ids[0]);
  await show(ids[10]);await show(ids[11]);await show(ids[12]);
  await page.waitForFunction(()=>window.events.some(event=>event.body==='background-check'));
  await page.waitForFunction(()=>window.events.some(event=>event.terminal?.current_cwd==='/tmp/background-check'));
  assert.equal(await page.evaluate(id=>Boolean(window.handles[id]),ids[0]),false,'background sender should be asleep');
  await page.evaluate(async()=>{window.views=[];window.render();});
  for(const id of ids) await page.evaluate(id=>window.api.close(id),id);
  await page.waitForFunction(()=>document.querySelectorAll('.xterm').length===0);
  const rounds=[];
  for(let round=0;round<3;round++){
    for(let i=0;i<(process.env.VIBEGO_TERMINAL_STRESS==='1'?34:4);i++){
      const id=await create();await show(id);
      await page.evaluate(id=>window.send(id,"printf 'final-tail\\n'; exit\n"),id);
      await page.waitForFunction(id=>window.api.list().then(({terminals})=>terminals.some(t=>t.id===id && t.status==='exited')),id);
      await page.evaluate(()=>{window.views=[];window.render();});
    }
    await sleep(200);rounds.push(await metrics());
    assert.equal(rounds.at(-1).active,0,"exited PTYs retained");
  }
  // Persist enough small entries to exercise count eviction and delete/write ordering.
  await page.evaluate(async()=>{
    for(let i=0;i<110;i++) await window.cache.writeTerminalSessionCache({terminalId:'cache-'+i,serialized:'hello',cursor:5,cols:80,rows:24,status:'exited',updatedAt:Date.now()});
  });
  assert.equal(await page.evaluate(()=>window.cache.readTerminalSessionCache('cache-0')),null);
  await page.evaluate(async()=>{
    const owner=window.cache.acquireTerminalCacheOwner('deleted');
    const item={terminalId:'deleted',serialized:'hello',cursor:5,cols:80,rows:24,status:'exited',updatedAt:Date.now()};
    const write=window.cache.writeTerminalSessionCache(item,owner.token);
    await window.cache.deleteTerminalSessionCache('deleted');await write;
    await window.cache.writeTerminalSessionCache(item,owner.token);owner.release();
  });
  assert.equal(await page.evaluate(()=>window.cache.readTerminalSessionCache('deleted')),null);
  await page.evaluate(async()=>{
    for(let i=0;i<18;i++) await window.cache.writeTerminalSessionCache({terminalId:'large-'+i,serialized:'x'.repeat(4*1024*1024),cursor:1,cols:80,rows:24,status:'exited',updatedAt:Date.now()});
    await window.cache.writeTerminalSessionCache({terminalId:'expired',serialized:'old',cursor:1,cols:80,rows:24,status:'exited',updatedAt:1});
  });
  assert.equal(await page.evaluate(()=>window.cache.readTerminalSessionCache('large-0')),null);
  assert.equal(await page.evaluate(()=>window.cache.readTerminalSessionCache('expired')),null);
  const samples=[];
  {
    const id=await create();await show(id);
    await page.evaluate(id=>window.send(id,"yes 'terminal-stress-0123456789'\n"),id);
    for(let i=0;i<100;i++) { if((await metrics()).historyBytes>=10*1024*1024) break; await sleep(100); }
    assert.ok((await metrics()).historyBytes>=10*1024*1024,"stress command must actually fill history");
    const start=Date.now();
    while(Date.now()-start<Number(process.env.VIBEGO_TERMINAL_DURATION_MS ?? (process.env.VIBEGO_TERMINAL_STRESS === "1" ? 600_000 : 10_000))){await sleep(10_000);const sample=await metrics();samples.push(sample);console.log(JSON.stringify({elapsed:Date.now()-start,...sample}));}
    await page.evaluate(id=>window.api.close(id),id);
    await page.evaluate(()=>{window.views=[];window.render();});
    assert.ok(samples.at(-1).browser.heap < samples[0].browser.heap + 32*1024*1024, 'retained browser heap grew with output');
    assert.ok(samples.every(sample => sample.terminal.every(term => term.lines <= 5024 && term.pending <= 512*1024)), 'terminal buffers exceeded their budget');
  }
  console.log(JSON.stringify({rounds,samples: samples.length,errors}));
  assert.deepEqual(errors,[]);
  assert.equal((await metrics()).active,0);
});
