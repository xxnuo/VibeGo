import assert from 'node:assert/strict';
import test from 'node:test';
import { Drafts } from '../src/components/blockterm/drafts.ts';

test('native typing and backspace batch by time, action and contiguous cursor',()=>{
  const drafts=new Drafts();
  const edit=(text,cursor,type,time)=>{
    drafts.update('a',text,{type,time,cursor});
    drafts.select('a',text,cursor,cursor,'none');
  };
  edit('a',1,'insertText',0);
  edit('ab',2,'insertText',100);
  edit('abc',3,'insertText',200);
  drafts.travel('a');
  assert.equal(drafts.get('a'),'');
  drafts.travel('a',true);
  assert.equal(drafts.get('a'),'abc');
  edit('ab',2,'deleteContentBackward',300);
  edit('a',1,'deleteContentBackward',400);
  drafts.travel('a');
  assert.equal(drafts.get('a'),'abc');
  edit('abcd',4,'insertText',500);
  edit('abcde',5,'insertText',1100);
  drafts.travel('a');
  assert.equal(drafts.get('a'),'abcd');
  drafts.travel('a');
  assert.equal(drafts.get('a'),'abc');
});

test('selection, atomic edits, blur and composition break native typing batches',()=>{
  for(const boundary of ['selection','paste','blur','composition','programmatic']) {
    const drafts=new Drafts();
    drafts.update('a','a',{type:'insertText',time:0,cursor:1});
    drafts.select('a','a',1,1,'none');
    if(boundary==='selection') {
      drafts.select('a','a',0,0,'none');
      drafts.select('a','a',1,1,'none');
    } else if(boundary==='blur') drafts.endGroup('a');
    else if(boundary==='composition') { drafts.beginGroup('a'); drafts.endGroup('a'); }
    else if(boundary==='programmatic') drafts.update('a','a');
    drafts.update('a','ab',{type:boundary==='paste'?'insertFromPaste':'insertText',time:100,cursor:2});
    drafts.travel('a');
    assert.equal(drafts.get('a'),'a',boundary);
  }
  const drafts=new Drafts();
  drafts.update('a','abc');
  drafts.select('a','abc',1,2,'backward');
  drafts.update('a','axc',{type:'insertText',time:0,cursor:2});
  drafts.select('a','axc',2,2,'none');
  drafts.update('a','axyc',{type:'insertText',time:100,cursor:3});
  drafts.travel('a');
  assert.equal(drafts.get('a'),'axc');
  drafts.travel('a');
  assert.deepEqual(drafts.selection('a'),{start:1,end:2,direction:'backward'});
});

test('empty session focus and blur do not retain selection records',()=>{
  const drafts=new Drafts();
  for(let index=0;index<2500;index++) {
    const key=`session-${index}`;
    drafts.select(key,'',0,0,'none');
    drafts.update(key,'command');
    drafts.select(key,'command',1,4,'backward');
    drafts.clearOnAcknowledgement(key,'command')();
    drafts.select(key,'',0,0,'forward');
    assert.deepEqual(drafts.selection(key),{start:0,end:0,direction:'none'});
  }
  assert.equal(drafts.selections.size,0);
  assert.equal(drafts.values.size,0);
  drafts.update('kept','preserve');
  drafts.select('kept','preserve',1,5,'backward');
  drafts.select('kept','',0,0,'none');
  assert.deepEqual(drafts.selection('kept'),{start:1,end:5,direction:'backward'});
});

test('selection is session scoped, rejects stale text and does not invalidate acknowledgements',()=>{
  const drafts=new Drafts();
  drafts.update('a','hello 中文');
  const acknowledge=drafts.clearOnAcknowledgement('a','hello 中文');
  drafts.select('a','hello 中文',2,7,'backward');
  drafts.select('a','stale',0,0,'none');
  assert.deepEqual(drafts.selection('a'),{start:2,end:7,direction:'backward'});
  assert.deepEqual(drafts.selection('b'),{start:0,end:0,direction:'none'});
  acknowledge();
  assert.deepEqual(drafts.selection('a'),{start:0,end:0,direction:'none'});
  drafts.update('a','new');
  assert.deepEqual(drafts.selection('a'),{start:3,end:3,direction:'none'});
});

test('drafts survive subscribers leaving and remain isolated per session',()=>{
  const drafts=new Drafts();
  let a=0,b=0;
  const off=drafts.subscribe('a',()=>a++);
  drafts.subscribe('b',()=>b++);
  drafts.update('a','line one\n第二行');
  off();
  drafts.update('b','other');
  assert.equal(drafts.get('a'),'line one\n第二行');
  assert.equal(drafts.get('b'),'other');
  assert.equal(a,1);assert.equal(b,1);
});

test('late command acknowledgement clears only its matching draft',()=>{
  const drafts=new Drafts();
  drafts.update('a','submitted');
  drafts.update('b','keep');
  drafts.update('a','new edit');
  drafts.update('a',value=>value==='submitted'?'':value);
  assert.equal(drafts.get('a'),'new edit');
  drafts.update('a',value=>value==='new edit'?'':value);
  assert.equal(drafts.get('a'),'');
  assert.equal(drafts.get('b'),'keep');
});

test('acknowledgement preserves a new edit even when its text returns to the original',()=>{
  const drafts=new Drafts();
  drafts.update('a','echo original');
  const acknowledge=drafts.clearOnAcknowledgement('a','echo original');
  drafts.update('a','echo new');
  drafts.update('a','echo original');
  acknowledge();
  assert.equal(drafts.get('a'),'echo original');
  const current=drafts.clearOnAcknowledgement('a','echo original');
  drafts.update('b','unrelated');
  current();
  assert.equal(drafts.get('a'),'');
  assert.equal(drafts.get('b'),'unrelated');
});

test('clearing and recreating a draft invalidates old acknowledgements',()=>{
  const drafts=new Drafts();
  drafts.update('a','same');
  const acknowledge=drafts.clearOnAcknowledgement('a','same');
  drafts.update('a','');
  drafts.update('a','same');
  acknowledge();
  assert.equal(drafts.get('a'),'same');
});

test('undo and redo restore session text and selection without accepting stale acknowledgements',()=>{
  const drafts=new Drafts();
  drafts.update('a','original');
  drafts.select('a','original',1,5,'backward');
  const stale=drafts.clearOnAcknowledgement('a','original');
  drafts.update('a','edited');
  drafts.update('b','other');
  assert.equal(drafts.travel('a'),true);
  assert.equal(drafts.get('a'),'original');
  assert.deepEqual(drafts.selection('a'),{start:1,end:5,direction:'backward'});
  stale();
  assert.equal(drafts.get('a'),'original');
  assert.equal(drafts.travel('a',true),true);
  assert.equal(drafts.get('a'),'edited');
  drafts.travel('a');
  drafts.update('a','new branch');
  assert.equal(drafts.travel('a',true),false);
  drafts.clearOnAcknowledgement('a','new branch')();
  assert.equal(drafts.travel('a'),false);
  assert.equal(drafts.travel('a',true),false);
  assert.equal(drafts.get('b'),'other');
});

test('undo history bounds count and retained UTF-16 text',()=>{
  const drafts=new Drafts();
  for(let index=0;index<150;index++) drafts.update('a',String(index));
  let count=0;
  while(drafts.travel('a')) count++;
  assert.equal(count,100);
  for(let index=0;index<10;index++) drafts.update('large',String(index)+'x'.repeat(400000));
  const history=drafts.histories.get('large');
  assert.ok([...history.undo,...history.redo].reduce((sum,item)=>sum+item.text.length*2,0)<=2*1024*1024);
});

test('composition groups undo once, isolate sessions, and end before the next edit',()=>{
  const drafts=new Drafts();
  drafts.update('a','echo ');
  drafts.beginGroup('a');
  drafts.update('a','echo n');
  drafts.update('a','echo ni');
  drafts.update('a','echo 你');
  drafts.update('b','separate');
  drafts.endGroup('a');
  drafts.update('a','echo 你好');
  drafts.travel('a');
  assert.equal(drafts.get('a'),'echo 你');
  drafts.travel('a');
  assert.equal(drafts.get('a'),'echo ');
  drafts.travel('a',true);
  assert.equal(drafts.get('a'),'echo 你');
  assert.equal(drafts.get('b'),'separate');
  drafts.beginGroup('a');
  drafts.endGroup('a');
  drafts.travel('a');
  assert.equal(drafts.get('a'),'echo ');
});

test('cancelled composition preserves redo and adds no empty undo step',()=>{
  const drafts=new Drafts();
  drafts.update('a','before');
  drafts.update('a','after');
  drafts.travel('a');
  drafts.beginGroup('a');
  drafts.update('a','before pin');
  drafts.update('a','before');
  drafts.endGroup('a');
  assert.equal(drafts.travel('a',true),true);
  assert.equal(drafts.get('a'),'after');
  drafts.travel('a');
  drafts.travel('a');
  assert.equal(drafts.get('a'),'');
  drafts.update('a','base');
  drafts.update('a','old redo');
  drafts.travel('a');
  drafts.beginGroup('a');
  drafts.update('a','new composition');
  drafts.endGroup('a');
  assert.equal(drafts.travel('a',true),false);
});
