import assert from 'node:assert/strict';
import test from 'node:test';
import { copyOutputRange } from '../src/components/blockterm/range-copy.ts';

test('cross-block selection uses model sections including unmounted intermediate output',()=>{
  const sections=[
    {block:'a',screen:'normal',chunks:['hello ','界','\nlast']},
    {block:'a',screen:'alternate',chunks:['TUI']},
    {block:'b',screen:'command',chunks:['printf middle']},
    {block:'b',screen:'normal',chunks:['middle output']},
    {block:'c',screen:'command',chunks:['echo done']},
    {block:'c',screen:'normal',chunks:['done 😀']},
  ];
  const start={block:'a',screen:'normal',row:0,offset:3};
  const end={block:'c',screen:'normal',row:0,offset:4};
  assert.equal(copyOutputRange(sections,start,end),'lo 界\nlast\nTUI\nprintf middle\nmiddle output\necho done\ndone');
  assert.equal(copyOutputRange(sections,{...start,row:1,offset:0},{...start,row:2,offset:2}),'界\nla');
  assert.equal(copyOutputRange(sections,end,start),null);
  assert.equal(copyOutputRange(sections,{...start,row:99},end),null);
  assert.equal(copyOutputRange(sections,start,{...end,offset:99}),null);
  assert.equal(copyOutputRange([],start,end),null);
});

test('command endpoints retain literal leading newlines and partial text',()=>{
  const sections=[{block:'a',screen:'command',chunks:['\necho 界']},{block:'a',screen:'normal',chunks:['done']},{block:'b',screen:'command',chunks:['next command']}];
  const start={block:'a',screen:'command',row:0,offset:0};
  const end={block:'b',screen:'command',row:0,offset:4};
  assert.equal(copyOutputRange(sections,start,end),'\necho 界\ndone\nnext');
  assert.equal(copyOutputRange(sections,{...start,offset:2},{block:'a',screen:'normal',row:0,offset:2}),'cho 界\ndo');
});
