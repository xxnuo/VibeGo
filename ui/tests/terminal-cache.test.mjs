import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

test("upgrades legacy terminal snapshots and recovers from quota exhaustion", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "vibego-terminal-cache-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const server = await createServer({
    configFile: false, cacheDir: temp, appType: "custom", optimizeDeps: {noDiscovery:true},
    server: {host:"127.0.0.1",port:0},
    plugins:[{name:"cache-test",configureServer(server) {
      server.middlewares.use("/cache-test",(_request,response)=>{
        response.setHeader("Content-Type","text/html");
        response.end(`<script type="module">import * as cache from '/src/services/terminal-session-cache.ts';window.cache=cache;window.ready=true;</script>`);
      });
    }}],
  });
  t.after(()=>server.close());await server.listen();
  const browser=await chromium.launch();t.after(()=>browser.close());
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto(server.resolvedUrls.local[0]+"cache-test");
  await page.waitForFunction(()=>window.ready);
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('VibeGoTerminalCache',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('terminal_sessions',{keyPath:'terminalId'});
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result;const tx=db.transaction('terminal_sessions','readwrite');
      for(let i=0;i<105;i++)tx.objectStore('terminal_sessions').put({terminalId:'legacy-'+String(i).padStart(3,'0'),serialized:'中文',cursor:6,cols:80,rows:24,status:'exited',updatedAt:Date.now()+i});
      tx.objectStore('terminal_sessions').put({terminalId:'expired',serialized:'old',cursor:3,cols:80,rows:24,status:'exited',updatedAt:1});
      tx.oncomplete=()=>{window.legacyDB=db;resolve();};tx.onerror=()=>reject(tx.error);
    };
  }));
  assert.equal(await page.evaluate(()=>Promise.race([window.cache.readTerminalSessionCache('legacy-104'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('blocked cache prevented terminal startup')),2500))])),null);
  await page.evaluate(()=>window.legacyDB.close());
  assert.equal((await page.evaluate(()=>window.cache.readTerminalSessionCache('legacy-104'))).serialized,'中文');
  assert.equal(await page.evaluate(()=>window.cache.readTerminalSessionCache('legacy-000')),null);
  const stats=await page.evaluate(()=>new Promise((resolve)=>{
    const request=indexedDB.open('VibeGoTerminalCache');request.onsuccess=()=>{
      const db=request.result;const tx=db.transaction(['terminal_sessions','terminal_metadata'],'readonly');
      const count=tx.objectStore('terminal_sessions').count();const meta=tx.objectStore('terminal_metadata').get('legacy-104');
      tx.oncomplete=()=>{db.close();resolve({count:count.result,size:meta.result.size});};
    };
  }));
  assert.deepEqual(stats,{count:100,size:6});
  const attempts=await page.evaluate(async()=>{
    const original=IDBObjectStore.prototype.put;let attempts=0;
    IDBObjectStore.prototype.put=function(value,...args){
      if(this.name==='terminal_sessions'&&value.terminalId==='quota'&&++attempts===1)throw new DOMException('test quota','QuotaExceededError');
      return original.call(this,value,...args);
    };
    try {await window.cache.writeTerminalSessionCache({terminalId:'quota',serialized:'recovered',cursor:9,cols:80,rows:24,status:'exited',updatedAt:Date.now()});}
    finally {IDBObjectStore.prototype.put=original;}
    return attempts;
  });
  assert.equal(attempts,2);
  assert.equal((await page.evaluate(()=>window.cache.readTerminalSessionCache('quota'))).serialized,'recovered');
  const other=await context.newPage();
  await other.goto(server.resolvedUrls.local[0]+"cache-test");
  await other.waitForFunction(()=>window.ready);
  await other.evaluate(()=>{window.owner=window.cache.acquireTerminalCacheOwner('quota');});
  await page.evaluate(()=>window.cache.deleteTerminalSessionCache('quota'));
  await other.waitForFunction(()=>!window.owner.token.valid);
  await other.evaluate(async()=>{
    await window.cache.writeTerminalSessionCache({terminalId:'quota',serialized:'stale',cursor:5,cols:80,rows:24,status:'exited',updatedAt:Date.now()},window.owner.token);
    window.owner.release();
  });
  assert.equal(await page.evaluate(()=>window.cache.readTerminalSessionCache('quota')),null);
  await other.close();
  // A completed transaction must release its database connection.
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.deleteDatabase('VibeGoTerminalCache');
    request.onblocked=()=>reject(new Error('database connection leaked'));
    request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve();
  }));
});
