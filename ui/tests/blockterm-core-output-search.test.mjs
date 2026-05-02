import assert from 'node:assert/strict';
import test from 'node:test';
import { countOutputMatches, hasOutputMatch, nextOutputMatch, outputMatchOrdinal } from '../src/components/blockterm/output-search.ts';

test('chunk search matches whole-string casing and non-overlap at every partition',()=>{
  for(const text of ['aaaaaaa','İi\nHELLO hello','ΟΣ ΟΣΑ Σ\u0301Α','\u{10400}\u{10428} X','command\noutput\nalt','中👩‍💻中']) {
    for(const query of ['aa','i','hello','ος','οσ','σ\u0301α','\u{10428}','\noutput\n','中','👩‍💻','missing','']) {
      const normalized=text.toLowerCase(),needle=query.toLowerCase();
      let expected=0;
      if(needle) for(let offset=0;;) {
        const found=normalized.indexOf(needle,offset);
        if(found<0) break;
        expected++;offset=found+needle.length;
      }
      for(let split=0;split<=text.length;split++) {
        const chunks=[text.slice(0,split),'',text.slice(split)];
        const source={textChunks:chunks,get text(){throw Error('full snapshot text must remain lazy');}};
        assert.equal(countOutputMatches(source,query),expected,JSON.stringify({text,query,split}));
        assert.equal(hasOutputMatch(chunks,query),expected>0);
      }
      const chars=text.split('');
      assert.equal(countOutputMatches({textChunks:chars,get text(){throw Error('joined getter');}},query),expected);
    }
  }
});

test('output search traverses matches across blocks and screens in both directions', () => {
  const entries = [{block:'a',screen:'normal',count:2},{block:'a',screen:'alternate',count:1},{block:'b',screen:'normal',count:1}];
  let target = null;
  for (const ordinal of [0,1,2,3,0]) {
    target = nextOutputMatch(entries,target,1);
    assert.equal(outputMatchOrdinal(entries,target),ordinal);
  }
  target = nextOutputMatch(entries,target,-1);
  assert.deepEqual(target,{block:'b',screen:'normal',index:0});
  assert.equal(outputMatchOrdinal(entries,{block:'a',screen:'normal',index:9}),-1);
  assert.equal(outputMatchOrdinal(entries,{block:'missing',screen:'normal',index:0}),-1);
  assert.equal(nextOutputMatch([],target,1),null);
  assert.deepEqual(nextOutputMatch(entries,null,-1),target);
});

test('large ordinary snapshots search without joining chunks or reading full text',()=>{
  const chunks=Array.from({length:10000},(_,index)=>`row ${index} MATCH\n`);
  chunks.join=()=>{throw Error('ordinary search must not concatenate history');};
  const snapshot={textChunks:chunks,get text(){throw Error('full snapshot text materialized');}};
  assert.equal(countOutputMatches(snapshot,'match'),10000);
  assert.equal(hasOutputMatch(chunks,'MATCH\nrow 9999'),true);
  assert.equal(hasOutputMatch(chunks,'not recorded'),false);
});

test('counts match case-insensitive non-overlapping rendered output', () => {
  const snapshot = {text:'界界界 İi\nHELLO hello'};
  assert.equal(countOutputMatches(snapshot,'界界'),1);
  assert.equal(countOutputMatches(snapshot,'i'),2);
  assert.equal(countOutputMatches(snapshot,'hello'),2);
  assert.equal(countOutputMatches(snapshot,'hello'),2);
  assert.equal(countOutputMatches(snapshot,''),0);
  assert.equal(countOutputMatches(snapshot,'missing'),0);
  assert.equal(countOutputMatches({command:'echo echo'},'echo'),2);
});

test('command matches precede normal and alternate output', () => {
  const entries = [{block:'a',screen:'command',count:2},{block:'a',screen:'normal',count:1},{block:'a',screen:'alternate',count:1}];
  let target = nextOutputMatch(entries,null,1);
  assert.deepEqual(target,{block:'a',screen:'command',index:0});
  target = nextOutputMatch(entries,target,1);
  assert.deepEqual(target,{block:'a',screen:'command',index:1});
  target = nextOutputMatch(entries,target,1);
  assert.deepEqual(target,{block:'a',screen:'normal',index:0});
  target = nextOutputMatch(entries,target,1);
  assert.deepEqual(target,{block:'a',screen:'alternate',index:0});
});
