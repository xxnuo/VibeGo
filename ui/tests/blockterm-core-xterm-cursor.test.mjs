import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreReflowCursor } from '../src/components/blockterm/xterm-cursor.ts';

test('cursor adapter refuses unsupported internals, alternate screen and invalid coordinates',()=>{
  const cursor={row:0,column:5,pendingWrap:true};
  const active={type:'normal',cursorX:0,cursorY:0};
  const terminal={cols:6,rows:24,buffer:{active},refresh:()=>{}};
  assert.equal(restoreReflowCursor(terminal,cursor),false);
  const internal={x:1,y:0};
  terminal._core={_bufferService:{buffer:internal}};
  assert.equal(restoreReflowCursor(terminal,cursor),false);
  internal.x=0;
  active.type='alternate';
  assert.equal(restoreReflowCursor(terminal,cursor),false);
  active.type='normal';
  assert.equal(restoreReflowCursor(terminal,{...cursor,row:24}),false);
  assert.equal(restoreReflowCursor(terminal,{...cursor,column:2}),false);
  assert.equal(internal.x,0);
  assert.equal(restoreReflowCursor(terminal,cursor),true);
  assert.equal(internal.x,6);
});
