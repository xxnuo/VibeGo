import assert from 'node:assert/strict';
import test from 'node:test';
import { collectOutput } from '../src/components/blockterm/output-download.ts';

const event=(seq,data)=>({session_id:'s',block_id:'b',type:'output',seq,data:Buffer.from(data).toString('base64')});
test('oversized base64 is rejected before allocating decoded copies',async()=>{
  const original=globalThis.atob;
  let decoded=0;
  globalThis.atob=value=>{decoded++;return original(value);};
  try {
    await assert.rejects(collectOutput('s','b',async()=>({events:[event(1,[1,2,3,4])],has_more:false}),1),/上限/);
    assert.equal(decoded,0);
    await assert.rejects(collectOutput('s','b',async cursor=>cursor===0
      ? {events:[event(1,[1,2,3])],has_more:true}
      : {events:[event(2,[4,5,6,7])],has_more:false},4),/上限/);
    assert.equal(decoded,1,'Remaining budget must be checked before decoding the next page');
    for(const bytes of [[1],[1,2],[1,2,3]]) {
      const parts=await collectOutput('s','b',async()=>({events:[event(1,bytes)],has_more:false}),bytes.length);
      assert.deepEqual([...new Uint8Array(await new Blob(parts).arrayBuffer())],bytes);
    }
  } finally {globalThis.atob=original;}
});
test('download preserves binary bytes across sparse event cursors',async()=>{
  const cursors=[];
  const progress=[];
  const parts=await collectOutput('s','b',async cursor=>{
    cursors.push(cursor);
    return cursor===0?{events:[event(2,[0,255,27])],has_more:true}:{events:[event(9,[128,10])],has_more:false};
  },undefined,undefined,bytes=>progress.push(bytes));
  assert.deepEqual(cursors,[0,2]);
  assert.deepEqual(progress,[3,5]);
  assert.deepEqual([...new Uint8Array(await new Blob(parts).arrayBuffer())],[0,255,27,128,10]);
});

test('cancelling from progress prevents a completed artifact',async()=>{
  const controller=new AbortController();
  await assert.rejects(collectOutput('s','b',async()=>({events:[event(1,[1])],has_more:false}),undefined,controller.signal,()=>controller.abort()),{name:'AbortError'});
});
test('download rejects stalled, duplicate, foreign and oversized results',async()=>{
  await assert.rejects(collectOutput('s','b',async()=>({events:[],has_more:true})),/游标/);
  await assert.rejects(collectOutput('s','b',async()=>({events:[event(1,[1]),event(1,[2])],has_more:false})),/无效/);
  await assert.rejects(collectOutput('s','b',async()=>({events:[event(9,[1]),event(2,[2])],has_more:false})),/无效/);
  await assert.rejects(collectOutput('s','b',async()=>({events:[{...event(1,[1]),block_id:'other'}],has_more:false})),/无效/);
  await assert.rejects(collectOutput('s','b',async()=>({events:[event(1,[1,2,3])],has_more:false}),2),/上限/);
});

test('download failures do not return a partial successful artifact',async()=>{
  await assert.rejects(collectOutput('s','b',async cursor=>{
    if(cursor) throw Error('connection lost');
    return {events:[event(1,[1,2])],has_more:true};
  }),/connection lost/);
});

test('cancelled downloads neither request another page nor return partial data',async()=>{
  const controller=new AbortController();
  let calls=0;
  await assert.rejects(collectOutput('s','b',async()=>{
    calls++;controller.abort();
    return {events:[event(1,[1])],has_more:true};
  },undefined,controller.signal),{name:'AbortError'});
  assert.equal(calls,1);
  await assert.rejects(collectOutput('s','b',async()=>{calls++;return {events:[],has_more:false};},undefined,controller.signal),{name:'AbortError'});
  assert.equal(calls,1);
});

test('download rejects malformed pagination and payload types instead of completing early',async()=>{
  for(const page of [null,{},[],{events:[]},{events:null,has_more:false},{events:[],has_more:0},{events:[],has_more:'false'}]) {
    await assert.rejects(collectOutput('s','b',async cursor=>cursor===0
      ? {events:[event(1,[1])],has_more:true}
      : page),/无效分页/);
  }
  for(const record of [null,0,false,{...event(1,[]),data:null},{...event(1,[]),data:0},{...event(1,[]),data:false},{...event(1,[]),data:[]}]) {
    await assert.rejects(collectOutput('s','b',async()=>({events:[record],has_more:false})),/无效记录/);
  }
  const empty={...event(1,[])};delete empty.data;
  assert.deepEqual(await collectOutput('s','b',async()=>({events:[empty],has_more:false})),[]);
});

test('download follows byte-limited short pages through the final payload',async()=>{
  const payloads=Array.from({length:6},(_,index)=>Buffer.alloc(400000,index));
  const cursors=[];
  const parts=await collectOutput('s','b',async cursor=>{
    cursors.push(cursor);
    return {events:payloads.slice(cursor,cursor+2).map((data,index)=>event(cursor+index+1,data)),has_more:cursor+2<6};
  });
  assert.deepEqual(cursors,[0,2,4]);
  assert.deepEqual(Buffer.from(await new Blob(parts).arrayBuffer()),Buffer.concat(payloads));
});

test('download pins the first snapshot boundary and rejects changes or records beyond it',async()=>{
  const requests=[];
  const parts=await collectOutput('s','b',async(after,through)=>{
    requests.push([after,through]);
    return {events:[event(after?3:1,[after?2:1])],has_more:after===0,through:3};
  });
  assert.deepEqual(requests,[[0,undefined],[1,3]]);
  assert.deepEqual(Buffer.from(await new Blob(parts).arrayBuffer()),Buffer.from([1,2]));
  for(const through of [undefined,2,4,-1,1.5,'3']) {
    await assert.rejects(collectOutput('s','b',async after=>after===0
      ? {events:[event(1,[1])],has_more:true,through:3}
      : {events:[],has_more:false,through}),/快照/);
  }
  await assert.rejects(collectOutput('s','b',async()=>({events:[event(4,[1])],has_more:false,through:3})),/无效记录/);
});
