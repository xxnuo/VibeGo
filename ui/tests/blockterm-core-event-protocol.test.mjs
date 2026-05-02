import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTerminalEvent, validateBlockPayload, validateSessionPayload, validateResizePayload } from '../src/components/blockterm/event-protocol.ts';

test('session exit codes preserve unknown legacy results and reject invalid process outcomes',()=>{
  const event={session_id:'s'};
  assert.doesNotThrow(()=>validateSessionPayload({id:'s',phase:'exited'},event));
  assert.doesNotThrow(()=>validateSessionPayload({id:'s',phase:'exited',exit_signal:'killed'},event));
  for(const patch of [{exit_signal:''},{exit_signal:9},{exit_signal:'killed',exit_code:0},{phase:'running',exit_signal:'killed'}])
    assert.throws(()=>validateSessionPayload({id:'s',phase:'exited',...patch},event));
  for(const exit_code of [0,23,255,0xffffffff])
    assert.doesNotThrow(()=>validateSessionPayload({id:'s',phase:'exited',exit_code},event));
  for(const exit_code of [null,'0',false,{},[],NaN,Infinity,-1,1.5,0x100000000])
    assert.throws(()=>validateSessionPayload({id:'s',phase:'exited',exit_code},event),/退出码无效/);
  for(const phase of ['initializing','ready','running','submitted','editing','compatible'])
    assert.throws(()=>validateSessionPayload({id:'s',phase,exit_code:0},event),/退出码无效/);
});

test('validates payload identity, lifecycle and geometry before model mutation',()=>{
  const event={session_id:'s',block_id:'b'};
  assert.doesNotThrow(()=>validateBlockPayload({id:'b',session_id:'s',status:'done',exit_code:0},event));
  assert.doesNotThrow(()=>validateSessionPayload({id:'s',phase:'ready',cols:500,rows:300},event));
  for(const value of [null,[],{id:'other',status:'done'},{id:'b',session_id:'other',status:'done'},{id:'b',status:'future'},{id:'b',status:'done',command:42},{id:'b',status:'done',exit_code:'0'}])
    assert.throws(()=>validateBlockPayload(value,event));
  for(const value of [null,[],{id:'other',phase:'ready'},{id:'s',phase:'future'},{id:'s',phase:'ready',cwd:42}])
    assert.throws(()=>validateSessionPayload(value,event));
  for(const value of [null,[],{}, {cols:0,rows:24},{cols:80.5,rows:24},{cols:'80',rows:24},{cols:501,rows:24},{cols:80,rows:301}])
    assert.throws(()=>validateResizePayload(value));
});

test('accepts current event envelopes and out-of-band legacy faults',()=>{
  for(const type of ['hello','block','output','terminal','state','resize','gap'])
    assert.doesNotThrow(()=>validateTerminalEvent({type,session_id:'s',seq:type==='hello'?0:1,block_id:'b',data:''},'s'));
  assert.doesNotThrow(()=>validateTerminalEvent({type:'fault'},'s'));
});

test('rejects unknown, cross-session, imprecise and incomplete envelopes',()=>{
  const valid={type:'output',session_id:'s',seq:1,block_id:'b',data:'YWJj'};
  for(const patch of [
    {type:'future-checkpoint'}, {session_id:'other'}, {seq:0}, {seq:-1}, {seq:1.5},
    {seq:Number.MAX_SAFE_INTEGER+1}, {seq:NaN}, {seq:'1'}, {data:undefined}, {data:123},
    {block_id:''}, {block_id:undefined},
  ]) assert.throws(()=>validateTerminalEvent({...valid,...patch},'s'));
  for(const value of [null,undefined,[],42,'event',{type:'fault',data:42}])
    assert.throws(()=>validateTerminalEvent(value,'s'));
});
