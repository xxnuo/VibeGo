import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkCharacters, chunkMatches, lowercaseChunks } from '../src/components/blockterm/chunk-search.ts';

test('Unicode chunk lowercasing equals whole-string conversion without source joining',()=>{
  const atoms=['A','Σ','\u0345','\u0301','\u200d',' ',"'",'İ','\u{10400}','\ud800','\udc00'];
  for(const a of atoms) for(const b of atoms) for(const c of atoms) {
    const text=a+b+c;
    for(let split=0;split<=text.length;split++) {
      const chunks=[text.slice(0,split),'',text.slice(split)];
      chunks.join=()=>{throw Error('Unicode source joined');};
      assert.equal([...lowercaseChunks(chunks)].join(''),text.toLowerCase(),JSON.stringify({text,split}));
    }
    const units=text.split('');
    units.join=()=>{throw Error('surrogate source joined');};
    assert.equal([...lowercaseChunks(units)].join(''),text.toLowerCase());
  }
});

test('streaming match coordinates equal whole-string UTF-16 coordinates at every split',()=>{
  for(const text of ['aaaaaaa','İi hello HELLO','ΟΣ ΟΣΑ Σ\u0301Α','\u{10400}\u{10428} X','中👩‍💻中','a\ud800b\udc00']) {
    for(const query of ['aa','i','\u0307','hello','ος','οσ','\u{10428}','X','👩‍💻','\ud800','absent','']) {
      const normalized=text.toLowerCase(),needle=query.toLowerCase(),expected=[];
      if(needle) for(let offset=0;;) {
        const start=normalized.indexOf(needle,offset);
        if(start<0)break;
        expected.push([start,start+needle.length]);offset=start+needle.length;
      }
      for(let split=0;split<=text.length;split++) {
        const chunks=[text.slice(0,split),'',text.slice(split)];
        assert.deepEqual([...chunkMatches(chunks,query)],expected,JSON.stringify({text,query,split}));
        assert.deepEqual([...chunkCharacters(chunks)],[...text]);
      }
      assert.deepEqual([...chunkMatches(text.split(''),query)],expected);
      assert.deepEqual([...chunkCharacters(text.split(''))],[...text]);
    }
  }
});

test('sigma context crosses long ignorable runs without concatenating their source',()=>{
  for(const suffix of ['', 'B']) {
    const chunks=['A','Σ',...Array(10000).fill('\u0345'),suffix];
    chunks.join=()=>{throw Error('context source joined');};
    const lower=[...lowercaseChunks(chunks)];
    assert.equal(lower[1],suffix?'σ':'ς');
    assert.deepEqual([...chunkMatches(chunks,suffix?'σ':'ς')],[[1,2]]);
    assert.deepEqual([...chunkMatches(chunks,suffix?'ς':'σ')],[]);
  }
});

test('long queries stream overlapping prefixes with non-overlapping matches and Unicode offsets',()=>{
  for(const needle of ['a'.repeat(255),'a'.repeat(256),'a'.repeat(257),'ab'.repeat(160)+'ac','İ'.repeat(200),'\u{10400}'.repeat(150)]) {
    const text=('x'+needle+needle+' '+needle.slice(0,-1)+'!'+needle).toLowerCase();
    const normalized=needle.toLowerCase(),expected=[];
    for(let offset=0;;) {
      const index=text.indexOf(normalized,offset);
      if(index<0)break;
      expected.push([index,index+normalized.length]);offset=index+normalized.length;
    }
    for(const size of [1,7,255,256,1000]) {
      const chunks=[];
      for(let i=0;i<text.length;i+=size)chunks.push(text.slice(i,i+size));
      chunks.join=()=>{throw Error('long search joined source');};
      assert.deepEqual([...chunkMatches(chunks,needle)],expected);
    }
  }
  const chunks=Array(100000).fill('a');
  assert.deepEqual([...chunkMatches(chunks,'a'.repeat(8191)+'b')],[]);
});

test('interleaved match iterators retain their own query plan',()=>{
  const query='a'.repeat(300),other='b'.repeat(400);
  const first=chunkMatches([query,query],query);
  assert.deepEqual(first.next().value,[0,300]);
  assert.deepEqual([...chunkMatches([other],other)],[[0,400]]);
  assert.deepEqual(first.next().value,[300,600]);
  assert.equal(first.next().done,true);
});
