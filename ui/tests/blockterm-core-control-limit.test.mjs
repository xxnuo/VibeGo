import assert from 'node:assert/strict';
import test from 'node:test';
import { installControlStringLimit } from '../src/components/blockterm/xterm-control-limit.ts';

function fixture() {
  const make=()=>({received:0,finishes:[],put(_data,start,end){this.received+=end-start;},reset(){this.received=0;},end(...args){this.finishes.push(args);return Promise.resolve(true);},unhook(...args){return this.end(...args);}});
  const osc=make(),dcs=make();
  return {osc,dcs,terminal:{_core:{_inputHandler:{_parser:{_oscParser:osc,_dcsParser:dcs}}}}};
}

test('control budget aborts accumulated data, ignores the suffix and recovers on a new sequence',async()=>{
  const value=fixture();
  const original=value.osc.put;
  let notifications=0;
  const guard=installControlStringLimit(value.terminal,()=>notifications++);
  assert.equal(notifications,0);
  for(const [parser,finish] of [[value.osc,'end'],[value.dcs,'unhook']]) {
    const data=new Uint32Array(65536).fill(97);
    parser.reset();
    for(let i=0;i<64;i++)parser.put(data,0,data.length);
    assert.equal(parser.received,4<<20);
    assert.equal(await parser[finish](true,false),true);
    assert.deepEqual(parser.finishes,[[true,false]]);
    parser.reset();
    for(let i=0;i<64;i++)parser.put(data,0,data.length);
    parser.put(data,0,1);
    assert.equal(parser.received,0);
    parser.put(data,0,10);
    assert.equal(parser.received,0);
    assert.equal(parser[finish](true),undefined);
    assert.equal(parser.finishes.length,1);
    parser.reset();parser.put(data,0,2);
    assert.equal(parser.received,2);
    await parser[finish](true);
    assert.equal(parser.finishes.length,2);
  }
  assert.equal(notifications,1);
  guard.dispose();guard.dispose();
  assert.equal(value.osc.put,original);
});

test('unsupported control parser fails before modifying either target',()=>{
  const value=fixture(),put=value.osc.put;
  delete value.terminal._core._inputHandler._parser._dcsParser;
  assert.throws(()=>installControlStringLimit(value.terminal),/不兼容/);
  assert.equal(value.osc.put,put);
});
