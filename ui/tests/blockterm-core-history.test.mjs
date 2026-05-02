import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoryPager } from '../src/components/blockterm/history-pager.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};

test('late results and failures from replaced queries cannot affect the new page', async () => {
  const requests=[];
  const pager=new HistoryPager((scope,query,offset,signal)=>{
    const request={...deferred(),scope,query,offset,signal};requests.push(request);return request.promise;
  });
  pager.reset('a','old');
  const old=pager.load();
  pager.reset('a','new');
  const current=pager.load();
  assert.equal(requests[0].signal.aborted,true);
  requests[0].resolve({blocks:[{id:'old'}],has_more:true});
  assert.equal(await old,null);
  assert.equal(pager.loading,true);
  requests[1].resolve({blocks:[{id:'new'}],has_more:true,next_cursor:'new-cursor'});
  assert.deepEqual((await current).blocks,[{id:'new'}]);
  const more=pager.load();
  pager.reset('b','another');
  requests[2].reject(new Error('late failure'));
  assert.equal(await more,null);
});

test('duplicate load is suppressed and pagination uses the server cursor despite duplicate rows', async () => {
  const request=deferred();
  const offsets=[];
  const pager=new HistoryPager((_scope,_query,cursor)=>{offsets.push(cursor);return cursor ? Promise.resolve({blocks:[{id:'x'}],has_more:false}) : request.promise;});
  pager.reset('a','');
  const first=pager.load();
  assert.equal(await pager.load(),null);
  request.resolve({blocks:[{id:'x'},{id:'x'}],has_more:true,next_cursor:'next'});
  assert.deepEqual((await first).blocks,[{id:'x'}]);
  await pager.load();
  assert.deepEqual(offsets,['','next']);
});

test('failed page retries the same offset and cancelled views publish nothing', async () => {
  let fail=true;
  const offsets=[];
  const pager=new HistoryPager(async (_scope,_query,offset)=>{
    offsets.push(offset);if(fail)throw new Error('offline');return {blocks:[{id:'ok'}],has_more:false};
  });
  pager.reset('a','');
  await assert.rejects(pager.load(),/offline/);
  fail=false;
  assert.equal((await pager.load()).blocks[0].id,'ok');
  assert.equal(await pager.load(),null);
  assert.deepEqual(offsets,['','']);
  pager.reset('a','');pager.cancel();
  assert.equal(await pager.load(),null);
});

test('missing or repeated continuation cursors cannot loop forever', async()=>{
  let cursor='next';
  const pager=new HistoryPager(async()=>({blocks:[{id:'x'}],has_more:true,next_cursor:cursor}));
  pager.reset('a','');
  await pager.load();
  await assert.rejects(pager.load(),/游标未推进/);
  cursor='';
  await assert.rejects(pager.load(),/游标未推进/);
});

test('completed results remain invalidatable until the consumer publishes them', async () => {
  const pager=new HistoryPager(async ()=>({blocks:[{id:'old'}],has_more:false}));
  pager.reset('a','old');
  const result=await pager.load();
  pager.reset('a','new');
  assert.equal(result.signal.aborted,true);
});

test('multi-page cursor cycles preserve accepted records and allow a corrected retry',async()=>{
  const cursors=[];
  const pages=[
    {blocks:[{id:'one'}],has_more:true,next_cursor:'A'},
    {blocks:[{id:'two'}],has_more:true,next_cursor:'B'},
    {blocks:[{id:'rejected'}],has_more:true,next_cursor:'A'},
    {blocks:[{id:'three'}],has_more:true,next_cursor:'C'},
    {blocks:[{id:'fresh'}],has_more:true,next_cursor:'A'},
  ];
  const pager=new HistoryPager(async(_scope,_query,cursor)=>{cursors.push(cursor);return pages.shift();});
  pager.reset('scope','query');
  await pager.load();
  await pager.load();
  await assert.rejects(pager.load(),/游标未推进/);
  assert.equal(pager.loading,false);
  assert.deepEqual((await pager.load()).blocks,[{id:'one'},{id:'two'},{id:'three'}]);
  assert.deepEqual(cursors,['','A','B','B']);
  pager.reset('scope','new query');
  assert.deepEqual((await pager.load()).blocks,[{id:'fresh'}]);
});

test('malformed history pages leave records and cursor unchanged for retry',async()=>{
  for(const malformed of [null,{},
    {blocks:null,has_more:true,next_cursor:'B'},
    {blocks:[null],has_more:true,next_cursor:'B'},
    {blocks:[{id:''}],has_more:true,next_cursor:'B'},
    {blocks:[{id:1}],has_more:true,next_cursor:'B'},
    {blocks:[],has_more:'false',next_cursor:'B'},
    {blocks:[],has_more:true,next_cursor:42},
  ]) {
    const requested=[];
    const pages=[{blocks:[{id:'kept'}],has_more:true,next_cursor:'A'},malformed,
      {blocks:[{id:'next'}],has_more:true,next_cursor:'B'}];
    const pager=new HistoryPager(async(_scope,_query,cursor)=>{requested.push(cursor);return pages.shift();});
    pager.reset('scope','query');
    await pager.load();
    await assert.rejects(pager.load(),/响应无效/);
    assert.equal(pager.loading,false);
    assert.deepEqual((await pager.load()).blocks,[{id:'kept'},{id:'next'}]);
    assert.deepEqual(requested,['','A','A']);
  }
});
