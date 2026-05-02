import assert from 'node:assert/strict';
import test from 'node:test';
import { InputQueue } from '../src/components/blockterm/input-queue.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('backpressure bounds pending input and discards the unsent suffix',async()=>{
  for(const queue of [new InputQueue(2,100),new InputQueue(100,4)]) {
    const pending=deferred(),sent=[],errors=[];
    const first=queue.enqueue(()=>{sent.push('first');return pending.promise;},()=>true,error=>errors.push(error),2);
    await Promise.resolve();
    const second=queue.enqueue(async()=>sent.push('discarded'),()=>true,error=>errors.push(error),2);
    await queue.enqueue(async()=>sent.push('overflow'),()=>true,error=>errors.push(error),1);
    assert.equal(errors.length,1);
    assert.match(errors[0].message,/积压/);
    await queue.enqueue(async()=>sent.push('overflow remainder'),()=>true,error=>errors.push(error),1);
    assert.equal(errors.length,2,'The remainder of a burst must be rejected until the active request settles');
    pending.resolve();
    await Promise.all([first,second]);
    await queue.enqueue(async()=>sent.push('fresh'),()=>true,error=>errors.push(error),2);
    assert.deepEqual(sent,['first','fresh']);
  }
});

test('a single oversized paste is rejected without dispatch',async()=>{
  const queue=new InputQueue(10,4),errors=[];
  await queue.enqueue(async()=>assert.fail('oversized input dispatched'),()=>true,error=>errors.push(error),5);
  assert.equal(errors.length,1);
  await queue.enqueue(async()=>{},()=>true,error=>errors.push(error),4);
  assert.equal(errors.length,1);
});

test('overflow before dispatch also rejects the remainder of the same burst',async()=>{
  const queue=new InputQueue(2,100),sent=[],errors=[],jobs=[];
  for(let index=0;index<4;index++) jobs.push(queue.enqueue(async()=>sent.push(index),()=>true,error=>errors.push(error)));
  await Promise.all(jobs);
  assert.deepEqual(sent,[]);
  assert.equal(errors.length,2);
  await queue.enqueue(async()=>sent.push('fresh'),()=>true,error=>errors.push(error));
  assert.deepEqual(sent,['fresh']);
});

test('invalidation settles unsent inputs before an active request completes',async()=>{
  const queue=new InputQueue(2,4),pending=deferred(),sent=[];
  const fail=error=>assert.fail(String(error));
  const first=queue.enqueue(()=>pending.promise,()=>true,fail,2);
  await Promise.resolve();
  const stale=queue.enqueue(async()=>sent.push('stale'),()=>true,fail,2);
  queue.invalidate();
  await stale;
  const fresh=queue.enqueue(async()=>sent.push('fresh'),()=>true,fail,2);
  assert.deepEqual(sent,[],'Fresh input must still wait for the active request');
  pending.resolve();
  await Promise.all([first,fresh]);
  assert.deepEqual(sent,['fresh']);
});

test('disconnect discards queued keys even after control is restored',async()=>{
  const queue=new InputQueue(),pending=deferred(),sent=[];
  const fail=()=>assert.fail('unexpected error');
  queue.enqueue(()=>{sent.push('first');return pending.promise;},()=>true,fail);
  const stale=queue.enqueue(async()=>sent.push('stale'),()=>true,fail);
  await Promise.resolve();
  assert.deepEqual(sent,['first']);
  queue.invalidate();
  const fresh=queue.enqueue(async()=>sent.push('fresh'),()=>true,fail);
  pending.resolve();
  await Promise.all([stale,fresh]);
  assert.deepEqual(sent,['first','fresh']);
});

test('permission is checked at dispatch and uncertain failures drop pending suffix',async()=>{
  const queue=new InputQueue(),pending=deferred(),sent=[],errors=[];
  let allowed=true;
  queue.enqueue(()=>pending.promise,()=>true,error=>errors.push(error));
  const blocked=queue.enqueue(async()=>sent.push('blocked'),()=>allowed,error=>errors.push(error));
  await Promise.resolve();
  allowed=false;
  pending.resolve();
  await blocked;
  assert.deepEqual(sent,[]);
  queue.enqueue(async()=>{throw new Error('lost acknowledgement');},()=>true,error=>errors.push(error));
  await queue.enqueue(async()=>sent.push('unsafe suffix'),()=>true,error=>errors.push(error));
  assert.equal(errors.length,1);
  await queue.enqueue(async()=>sent.push('new input'),()=>true,error=>errors.push(error));
  assert.deepEqual(sent,['new input']);
  assert.match(errors[0].message,/发送未确认.*可能已执行.*lost acknowledgement/);
  assert.equal(errors[0].cause.message,'lost acknowledgement');
});

test('late failure from an invalidated connection cannot cancel fresh input',async()=>{
  const queue=new InputQueue(),pending=deferred(),sent=[];
  const fail=()=>assert.fail('stale failure was published');
  queue.enqueue(()=>pending.promise,()=>true,fail);
  await Promise.resolve();
  queue.invalidate();
  const fresh=queue.enqueue(async()=>sent.push('fresh'),()=>true,fail);
  pending.reject(new Error('old connection'));
  await fresh;
  assert.deepEqual(sent,['fresh']);
});

test('throwing error observers cannot poison subsequent input or leak capacity',async()=>{
  const queue=new InputQueue(1,2),sent=[];
  await assert.rejects(queue.enqueue(async()=>{throw new Error('network failure');},()=>true,()=>{throw new Error('observer failure');},2),/observer failure/);
  await queue.enqueue(async()=>sent.push('fresh'),()=>true,error=>assert.fail(String(error)),2);
  assert.deepEqual(sent,['fresh']);
});

test('permission predicate failures discard the suffix and release queued capacity',async()=>{
  const queue=new InputQueue(2,4),sent=[],errors=[];
  const first=queue.enqueue(async()=>sent.push('forbidden'),()=>{throw new Error('permission state unavailable');},error=>errors.push(error),2);
  const suffix=queue.enqueue(async()=>sent.push('suffix'),()=>true,error=>errors.push(error),2);
  await Promise.all([first,suffix]);
  assert.equal(errors.length,1);
  assert.deepEqual(sent,[]);
  assert.equal(errors[0].message,'permission state unavailable','Pre-dispatch failures must not claim input was sent');
  await queue.enqueue(async()=>sent.push('fresh'),()=>true,error=>assert.fail(String(error)),4);
  assert.deepEqual(sent,['fresh']);
});

test('throwing overflow observers reject asynchronously and the queue recovers',async()=>{
  const queue=new InputQueue(2,4),pending=deferred(),sent=[];
  const fail=error=>assert.fail(String(error));
  const first=queue.enqueue(()=>{sent.push('first');return pending.promise;},()=>true,fail,2);
  await Promise.resolve();
  const discarded=queue.enqueue(async()=>sent.push('discarded'),()=>true,fail,2);
  let rejected;
  assert.doesNotThrow(()=>{
    rejected=queue.enqueue(async()=>sent.push('overflow'),()=>true,()=>{throw new Error('observer failed');},1);
  });
  await assert.rejects(rejected,/observer failed/);
  await discarded;
  pending.resolve();
  await first;
  await queue.enqueue(async()=>sent.push('fresh'),()=>true,fail,4);
  assert.deepEqual(sent,['first','fresh']);
});
