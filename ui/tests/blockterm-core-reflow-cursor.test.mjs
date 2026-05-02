import assert from 'node:assert/strict';
import test from 'node:test';
import { captureLogicalCursor, mapReflowCursor } from '../src/components/blockterm/reflow-cursor.ts';

test('logical cursor capture never reads recycled rows beyond buffer length',()=>{
  const buffer={type:'normal',baseY:0,cursorY:0,cursorX:1,length:1,getLine(index){
    assert.equal(index,0,'must not probe a recycled row');
    return {isWrapped:false,length:3,getCell(column){return {getWidth:()=>1,getCode:()=>column===0?97:0};}};
  }};
  assert.deepEqual(captureLogicalCursor(buffer),{startRow:0,widths:[1],offset:1});
});

test('reflow preserves the pending wrap needed to append at an exact boundary',()=>{
  const cells=Array(12).fill(1);
  assert.deepEqual(mapReflowCursor(cells,12,6),{row:1,column:5,pendingWrap:true});
  assert.deepEqual(mapReflowCursor(cells,12,40),{row:0,column:12,pendingWrap:false});
  assert.deepEqual(mapReflowCursor(cells,11,6),{row:1,column:5,pendingWrap:false});
  assert.deepEqual(mapReflowCursor(cells,6,6),{row:1,column:0,pendingWrap:false});
});

test('wide cells move together and real spaces remain logical content',()=>{
  assert.deepEqual(mapReflowCursor([1,1,1,1,1,2],7,6),{row:1,column:2,pendingWrap:false});
  assert.deepEqual(mapReflowCursor([1,1,1,1,1,2],5,6),{row:1,column:0,pendingWrap:false});
  assert.deepEqual(mapReflowCursor([1,1,1,1,1,1,2],8,6),{row:1,column:2,pendingWrap:false});
  assert.deepEqual(mapReflowCursor([2,2,2],6,6),{row:0,column:5,pendingWrap:true});
  assert.throws(()=>mapReflowCursor([2],1,6),/inside a wide cell/);
});

test('empty content and blank cursor positions have explicit geometry',()=>{
  assert.deepEqual(mapReflowCursor([],0,6),{row:0,column:0,pendingWrap:false});
  assert.deepEqual(mapReflowCursor([],7,6),{row:1,column:1,pendingWrap:false});
  assert.throws(()=>mapReflowCursor([0],0,6),/cell width/);
  assert.throws(()=>mapReflowCursor([],0,1),/geometry/);
  assert.throws(()=>mapReflowCursor([],-1,6),/geometry/);
});
