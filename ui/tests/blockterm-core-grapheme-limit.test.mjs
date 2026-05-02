import assert from 'node:assert/strict';
import test from 'node:test';
import { installGraphemeLimit } from '../src/components/blockterm/xterm-grapheme-limit.ts';

function fixture() {
  let fail=false;
  const line={text:'e'+'\u0301'.repeat(127),getWidth:()=>1,getString(){return this.text;},addCodepointToCell(_index,code){this.text+=String.fromCodePoint(code);}};
  const unicode={charProperties:()=>5};
  const handler={print(data,start,end){for(let i=start;i<end;i++) {unicode.charProperties(data[i],2);if(fail)throw Error('parser failure');line.addCodepointToCell(0,data[i],1);}}};
  const terminal={_core:{unicodeService:unicode,_inputHandler:handler,_bufferService:{buffer:{x:1,y:0,ybase:0,lines:{get:()=>line}}}}};
  return {line,unicode,handler,terminal,setFail:()=>{fail=true;}};
}

test('grapheme protection is instance-local and does not alter external width queries',()=>{
  const first=fixture(),other=fixture();
  const originalPrint=first.handler.print,originalProperties=first.unicode.charProperties,originalAdd=first.line.addCodepointToCell;
  let notifications=0;
  const guard=installGraphemeLimit(first.terminal,()=>notifications++);
  assert.equal(first.unicode.charProperties(0x301,2),5);
  assert.equal(first.line.addCodepointToCell,originalAdd);
  assert.equal(notifications,0);
  first.handler.print(new Uint32Array([0x301,0x301]),0,2);
  assert.equal(notifications,1);
  assert.equal(Buffer.byteLength(first.line.text),255);
  assert.equal(first.line.addCodepointToCell,originalAdd);
  other.handler.print(new Uint32Array([0x301]),0,1);
  assert.equal(Buffer.byteLength(other.line.text),257);
  guard.dispose();guard.dispose();
  assert.equal(first.handler.print,originalPrint);
  assert.equal(first.unicode.charProperties,originalProperties);
});

test('grapheme protection restores a pending row override when parsing throws',()=>{
  const value=fixture(),add=value.line.addCodepointToCell;
  const guard=installGraphemeLimit(value.terminal);
  value.setFail();
  assert.throws(()=>value.handler.print(new Uint32Array([0x301]),0,1),/parser failure/);
  assert.equal(value.line.addCodepointToCell,add);
  assert.equal(value.unicode.charProperties(0x301,2),5);
  guard.dispose();
  assert.throws(()=>installGraphemeLimit({}),/不兼容/);
});
