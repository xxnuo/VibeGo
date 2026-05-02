import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser=await chromium.launch();
try {
  const page=await browser.newPage({ignoreHTTPSErrors:true});
  await page.route('**/blockterm-control-limit',route=>route.fulfill({contentType:'text/html',body:`
    <html><body><script type="module">
    window.BlockEngine=(await import('/src/components/blockterm/engine.ts')).BlockEngine;
    </script></body></html>`}));
  await page.goto(`${process.env.BLOCKTERM_URL||'https://127.0.0.1:11984'}/blockterm-control-limit`);
  await page.waitForFunction(()=>window.BlockEngine);
  const results=await page.evaluate(async()=>{
    const encoder=new TextEncoder(),limit=4<<20,results=[];
    const run=async(kind,delta,wide,enabled=true)=>{
      const host=document.createElement('div');document.body.append(host);
      const engine=new window.BlockEngine(host,{id:'limits',cols:20,rows:3});
      if(!enabled)engine.controlStringLimit.dispose();
      const calls=[];
      const callback=data=>{calls.push(encoder.encode(data).length);return Promise.resolve(true);};
      const handler=kind==='osc'?engine.terminal.parser.registerOscHandler(99,callback):engine.terminal.parser.registerDcsHandler({final:'q'},callback);
      const prefix=kind==='osc'?'\x1b]99;':'\x1bPq';
      const bytes=limit+delta-(kind==='osc'?3:0);
      const body=wide?'界'.repeat(Math.floor(bytes/3))+'x'.repeat(bytes%3):'x'.repeat(bytes);
      try {
        const write=async text=>{
          const data=encoder.encode(text);
          for(let start=0;start<data.length;start+=65536)await engine.write(data.subarray(start,start+65536));
        };
        await write(prefix+body);
        const unfinished=calls.length;
        await write((kind==='osc'?'\x07':'\x1b\\')+'X');
        const after=calls.slice();
        await write(prefix+'ok\x1b\\Y');
        return {kind,delta,wide,bytes,unfinished,after,calls,text:engine.snapshot().text,limited:engine.projectionLimited};
      } finally {handler.dispose();engine.dispose();host.remove();}
    };
    for(const kind of ['osc','dcs'])for(const wide of [false,true])for(const delta of [-1,0,1])results.push(await run(kind,delta,wide));
    return {results,unguarded:await run('osc',1,false,false)};
  });
  assert.equal(results.unguarded.after.length,1,'unguarded xterm must reproduce the backend limit mismatch');
  for(const result of results.results) {
    assert.equal(result.unfinished,0);
    assert.equal(result.limited,result.delta>0);
    assert.deepEqual(result.after,result.delta>0?[]:[result.bytes],JSON.stringify({kind:result.kind,delta:result.delta,wide:result.wide}));
    assert.deepEqual(result.calls,[...result.after,2]);
    assert.equal(result.text,'XY');
  }
  console.log('OSC/DCS: 12 UTF-8 byte-boundary cases reject overflow, preserve async completion and resume parsing');
} finally {await browser.close();}
