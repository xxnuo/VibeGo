import assert from 'node:assert/strict';
import test from 'node:test';
import {deleteCommandText,insertCommandText} from '../src/components/blockterm/command-edit.ts';

test('line deletion preserves other lines and handles newline boundaries',()=>{
  assert.deepEqual(deleteCommandText('one\ntwo three',7,7,'u'),{text:'one\n three',cursor:4});
  assert.deepEqual(deleteCommandText('one\ntwo',0,0,'u'),{text:'one\ntwo',cursor:0});
  assert.deepEqual(deleteCommandText('one\ntwo',1,1,'k'),{text:'o\ntwo',cursor:1});
  assert.deepEqual(deleteCommandText('one\ntwo',3,3,'k'),{text:'onetwo',cursor:3});
  assert.deepEqual(deleteCommandText('one\ntwo',4,4,'u'),{text:'one\ntwo',cursor:4});
});
test('word deletion preserves preceding spaces and whole Unicode words',()=>{
  for(const text of ['echo 中文🙂  ','echo word\n  '])
    assert.deepEqual(deleteCommandText(text,text.length,text.length,'w'),{text:'echo ',cursor:5});
  assert.deepEqual(deleteCommandText('   ',3,3,'w'),{text:'',cursor:0});
  assert.deepEqual(deleteCommandText('',0,0,'w'),{text:'',cursor:0});
});
test('all editing actions delete only the active selection',()=>{
  for(const action of ['u','k','w'])
    assert.deepEqual(deleteCommandText('echo hello world',5,10,action),{text:'echo  world',cursor:5});
});

test('inserting killed text replaces selection and leaves cursor after Unicode text',()=>{
  assert.deepEqual(insertCommandText('echo old tail',5,8,'中文🙂'),{text:'echo 中文🙂 tail',cursor:9});
  assert.deepEqual(insertCommandText('ab',1,1,'x\ny'),{text:'ax\nyb',cursor:4});
});

test('every deletion can be restored exactly across multiline and Unicode selections',()=>{
  for(const text of ['', '\n', 'a\n\nb', '  echo 中文🙂 \n\t', 'e\u0301cho\tvalue']) {
    for(let start=0;start<=text.length;start++) {
      for(let end=start;end<=text.length;end++) {
        for(const action of ['u','k','w']) {
          const deleted=deleteCommandText(text,start,end,action);
          assert.ok(deleted.cursor>=0&&deleted.cursor<=deleted.text.length);
          const count=text.length-deleted.text.length;
          assert.ok(count>=0);
          const killed=text.slice(deleted.cursor,deleted.cursor+count);
          const restored=insertCommandText(deleted.text,deleted.cursor,deleted.cursor,killed);
          assert.equal(restored.text,text,JSON.stringify({text,start,end,action}));
          if(start!==end) {
            assert.equal(deleted.cursor,start);
            assert.equal(killed,text.slice(start,end));
          }
        }
      }
    }
  }
});

test('forward deletion removes a whole grapheme and leaves kill-style selection semantics intact',()=>{
  for(const grapheme of ['🙂','e\u0301','👩‍💻','🇨🇳']) {
    const text=`a${grapheme}b`;
    for(let cursor=1;cursor<1+grapheme.length;cursor++)
      assert.deepEqual(deleteCommandText(text,cursor,cursor,'d'),{text:'ab',cursor:1});
  }
  assert.deepEqual(deleteCommandText('ab',2,2,'d'),{text:'ab',cursor:2});
  assert.deepEqual(deleteCommandText('a\nb',1,1,'d'),{text:'ab',cursor:1});
  assert.deepEqual(deleteCommandText('abcd',1,3,'d'),{text:'ad',cursor:1});
});

test('backward deletion preserves whole graphemes, line joins and beginning boundaries',()=>{
  for(const grapheme of ['🙂','e\u0301','👩‍💻','🇨🇳']) {
    const text=`a${grapheme}b`;
    for(let cursor=2;cursor<=1+grapheme.length;cursor++)
      assert.deepEqual(deleteCommandText(text,cursor,cursor,'h'),{text:'ab',cursor:1});
  }
  assert.deepEqual(deleteCommandText('ab',0,0,'h'),{text:'ab',cursor:0});
  assert.deepEqual(deleteCommandText('a\nb',2,2,'h'),{text:'ab',cursor:1});
  assert.deepEqual(deleteCommandText('abcd',1,3,'h'),{text:'ad',cursor:1});
});
