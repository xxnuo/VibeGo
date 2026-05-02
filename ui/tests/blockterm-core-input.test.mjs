import assert from 'node:assert/strict';
import test from 'node:test';
import { InputHistory, canNavigateHistory } from '../src/components/blockterm/input-history.ts';

test('reset releases the original draft and frozen history without breaking round trips',()=>{
  const history=new InputHistory();
  const draft='large private draft '.repeat(10000);
  const selection={start:1,end:5,direction:'backward'};
  history.moveWithSelection(1,draft,['old command'],selection);
  history.reset();
  assert.equal(history.original,'');
  assert.deepEqual(history.entries,[]);
  assert.equal(history.originalSelection,null);
  assert.equal(history.index,null);
  history.moveWithSelection(1,'fresh',['new command'],selection);
  assert.deepEqual(history.moveWithSelection(-1,'new command',[],{start:0,end:0,direction:'none'}),{
    text:'fresh',selection,
  });
  assert.equal(history.original,'');
  assert.deepEqual(history.entries,[]);
});

test('history round trip restores selection while recalled commands place cursor at end',()=>{
  const history=new InputHistory();
  const selection={start:2,end:7,direction:'backward'};
  assert.deepEqual(history.moveWithSelection(1,'my draft',['old'],selection),{
    text:'old',selection:{start:3,end:3,direction:'none'},
  });
  assert.deepEqual(history.moveWithSelection(-1,'old',[],{start:1,end:1,direction:'none'}),{
    text:'my draft',selection,
  });
  history.reset();
  assert.deepEqual(history.moveWithSelection(-1,'fresh',[],{start:1,end:1,direction:'none'}),{
    text:'fresh',selection:{start:1,end:1,direction:'none'},
  });
});

test('history traversal freezes candidates and restores the original multiline draft',()=>{
  const history=new InputHistory();
  const draft='draft\nsecond';
  assert.equal(history.move(1,draft,['new\nline','old']),'new\nline');
  assert.equal(history.move(1,'new\nline',['arrived','new\nline','old']),'old');
  assert.equal(history.move(-1,'old',[]),'new\nline');
  assert.equal(history.move(-1,'new\nline',[]),draft);
  assert.equal(history.move(1,draft,['arrived']),'arrived');
});

test('empty history and down from a fresh draft do not replace input',()=>{
  const history=new InputHistory();
  assert.equal(history.move(1,'draft',[]),'draft');
  assert.equal(history.move(-1,'draft',['old']),'draft');
  assert.equal(history.move(1,'draft',['old','old']),'old');
  assert.equal(history.move(1,'old',['old']),'old');
  history.reset();
  assert.equal(history.move(-1,'edited',['old']),'edited');
});

test('plain arrow keys navigate history only at multiline boundaries without a selection',()=>{
  const value='one\ntwo\nthree';
  assert.equal(canNavigateHistory(value,0,0,1),true);
  assert.equal(canNavigateHistory(value,5,5,1),false);
  assert.equal(canNavigateHistory(value,5,5,-1),false);
  assert.equal(canNavigateHistory(value,value.length,value.length,-1),true);
  assert.equal(canNavigateHistory(value,0,value.length,1),false);
});
