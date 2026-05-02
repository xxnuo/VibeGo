import assert from 'node:assert/strict';
import test from 'node:test';
import { findTextRow, findTextRanges, findTextMatchRows, buildTextSearch } from '../src/components/blockterm/buffer-text.ts';

test('highlight mapping streams ordinary rows without joining output',()=>{
  const chunks=Array.from({length:2000},(_,index)=>`${index?'\n':''}ROW ${index} TARGET`);
  chunks.join=()=>{throw Error('highlight search joined all output');};
  assert.equal(findTextRow(chunks,'TARGET'),0);
  const result=buildTextSearch(chunks,'target');
  assert.equal(result.matchRows.length,2000);
  assert.deepEqual(result.rows[1999],[{start:9,end:15,match:1999}]);
});

test('highlight mapping preserves split supplementary code points and expanding case folds',()=>{
  assert.deepEqual(findTextRanges(['\ud801','','\udc00'],'\u{10428}'),[[[0,1]],[],[[0,1]]]);
  assert.deepEqual(findTextRanges(['İ',' ','İ'],'\u0307'),[[[0,1]],[],[[0,1]]]);
});

test('search locates matches spanning soft-wrapped physical rows',()=>{
  assert.equal(findTextRow(['hello ','world'],'lo wo'),0);
  assert.equal(findTextRow(['first','\nhello ','world'],'WORLD'),2);
  assert.equal(findTextRow(['first','\nhello ','world'],'firsthello'),-1);
  assert.equal(findTextRow(['first','\nhello ','world'],'hello world'),1);
  assert.equal(findTextRow(['hello'],'missing'),-1);
  assert.equal(findTextRow(['hello'],''),-1);
});

test('search highlights all matches across soft wraps and hard line breaks',()=>{
  assert.deepEqual(findTextRanges(['hello ','world hello'],'lo wo'), [[[3,6]],[[0,2]]]);
  assert.deepEqual(findTextRanges(['hello','\nhello'],'hello'), [[[0,5]],[[0,5]]]);
  assert.deepEqual(findTextRanges(['hello','\nworld'],'lowo'), [[],[]]);
  assert.deepEqual(findTextRanges(['abc abc'],'ABC'), [[[0,3],[4,7]]]);
  assert.deepEqual(findTextRanges(['abc'],''), [[]]);
});

test('highlight offsets retain original Unicode positions after case conversion',()=>{
  assert.deepEqual(findTextRanges(['İ abc'],'abc'), [[[2,5]]]);
  assert.deepEqual(findTextRanges(['İ'],'i'), [[[0,1]]]);
  assert.deepEqual(findTextRanges(['Ο','Σ'],'ος'), [[[0,1]],[[0,1]]]);
  assert.deepEqual(findTextRanges(['你好','世界'],'好世'), [[[1,2]],[[0,1]]]);
  assert.deepEqual(findTextRanges(['😀 ok'],'ok'), [[[3,5]]]);
  assert.deepEqual(findTextRanges(['e\u0301 ','abcd'],'\u0301 ab'), [[[1,3]],[[0,2]]]);
});

test('match navigation counts logical occurrences, not physical fragments',()=>{
  assert.deepEqual(findTextMatchRows(['hello ','world hello world'],'lo wo'),[0,1]);
  assert.deepEqual(findTextRanges(['hello ','world hello world'],'lo wo',1),[[],[[9,14]]]);
  assert.deepEqual(findTextMatchRows(['İ','\nabc abc'],'abc'),[1,1]);
  assert.deepEqual(findTextMatchRows(['abc'],''),[]);
});

test('search index retains shared match identities across rows and newline-only matches',()=>{
  const index=buildTextSearch(['hello ','world hello world'],'lo wo');
  assert.deepEqual(index.matchRows,[0,1]);
  assert.deepEqual(index.rows,[[{start:3,end:6,match:0}],[{start:0,end:2,match:0},{start:9,end:14,match:1}]]);
  assert.deepEqual(buildTextSearch(['abc','\n','\nend'],'\n'),{rows:[[],[],[]],matchRows:[1,2]});
});

test('large output index maps sparse matches without character-sized offset tables',()=>{
  const chunks=Array.from({length:20000},(_,i)=>(i?'\n':'')+'界'.repeat(40)+(i%1000===0?' TARGET':''));
  const index=buildTextSearch(chunks,'target');
  assert.deepEqual(index.matchRows,Array.from({length:20},(_,i)=>i*1000));
  assert.deepEqual(index.rows[19000],[{start:41,end:47,match:19}]);
  assert.equal(index.rows.flat().length,20);
});

test('search row offsets account for case expansion and empty rows',()=>{
  assert.equal(findTextRow(['İ','abcdef',' TARGET'],'target'),2);
  assert.equal(findTextRow(['','\n','\n你好','世界'],'好世'),2);
  assert.equal(findTextRow(['e\u0301 ','abcd'],'\u0301 ab'),0);
  assert.equal(findTextRow(['Ο','Σ'],'ος'),0);
});

test('dense matches emit stable row indexes across empty chunks and repeated cross-row spans',()=>{
  const chunks=Array.from({length:3000},()=>['a','','bc']).flat();
  const index=buildTextSearch(chunks,'abc');
  assert.deepEqual(index.matchRows,Array.from({length:3000},(_,i)=>i*3));
  for(let i=0;i<3000;i++) {
    assert.deepEqual(index.rows[i*3],[{start:0,end:1,match:i}]);
    assert.deepEqual(index.rows[i*3+1],[]);
    assert.deepEqual(index.rows[i*3+2],[{start:0,end:2,match:i}]);
  }
  assert.deepEqual(buildTextSearch(['','\n','a','\n','','b'],'\na\nb'),{
    matchRows:[1],rows:[[],[],[{start:0,end:1,match:0}],[],[],[{start:0,end:1,match:0}]],
  });
});
