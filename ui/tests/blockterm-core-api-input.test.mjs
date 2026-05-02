import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('core text and binary input preserve encoding and forward cancellation',async t=>{
  const vite=await createServer({appType:'custom',server:{hmr:false,middlewareMode:true}});
  const originalFetch=globalThis.fetch;
  const originalStorage=globalThis.localStorage;
  t.after(async()=>{
    globalThis.fetch=originalFetch;
    globalThis.localStorage=originalStorage;
    await vite.close();
  });
  globalThis.localStorage={getItem:()=>null};
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify({ok:true}),{status:200});
  };
  const {coreApi,encode}=await vite.ssrLoadModule('/src/components/blockterm/api.ts');
  for(const value of ['', 'a'.repeat(8191)+'中文', 'x'.repeat(8192), '界'.repeat(100000), '\ud800tail']) {
    assert.equal(encode(value),Buffer.from(value,'utf8').toString('base64'));
  }
  const controller=new AbortController();
  const text='中文\0ÿ';
  const bytes=[0,127,128,255];
  await coreApi.input('session','owner',text,controller.signal);
  await coreApi.binary('session','owner',String.fromCharCode(...bytes),controller.signal);
  for(const call of calls) {
    assert.equal(call.url,'/api/blockterm/v2/sessions/session/input');
    assert.equal(call.options.signal,controller.signal);
    assert.equal(call.options.method,'POST');
    assert.equal(JSON.parse(call.options.body).owner,'owner');
  }
  assert.deepEqual(Buffer.from(JSON.parse(calls[0].options.body).data,'base64'),Buffer.from(text,'utf8'));
  assert.deepEqual([...Buffer.from(JSON.parse(calls[1].options.body).data,'base64')],bytes);
  for(const method of ['input','binary']) {
    const aborted=new AbortController();
    globalThis.fetch=async(_url,options)=>new Promise((resolve,reject)=>{
      options.signal.throwIfAborted();
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    });
    const pending=coreApi[method]('session','owner','x',aborted.signal);
    aborted.abort();
    await assert.rejects(pending,{name:'AbortError'});
  }
});
