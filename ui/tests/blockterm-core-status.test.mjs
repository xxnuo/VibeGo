import assert from 'node:assert/strict';
import test from 'node:test';
import { blockStatus, blockDuration } from '../src/components/blockterm/block-status.ts';
const block={kind:'command',status:'done',exit_code:0,created_at:1000,finished_at:1500};

test('status distinguishes success, failure, interruption and unknown completion',()=>{
  assert.equal(blockStatus(block).label,'完成');
  assert.equal(blockStatus({...block,success:false}).failed,true);
  assert.equal(blockStatus({...block,exit_code:7}).failed,true);
  assert.equal(blockStatus({...block,exit_code:130}).label,'中断');
  assert.equal(blockStatus({...block,exit_code:141}).failed,false);
  assert.equal(blockStatus({...block,exit_code:null}).label,'已结束');
  assert.equal(blockStatus({...block,status:'running',exit_code:7}).label,'运行中');
  assert.equal(blockStatus({...block,success:true,native_exit_code:7}).failed,false);
  assert.deepEqual(blockStatus({...block,status:'not_executed',exit_code:null,shell_status:2}),{label:'未执行',failed:false});
});

test('duration is fixed for finished blocks and advances only for active blocks',()=>{
  assert.equal(blockDuration(block,10000),'500 ms');
  assert.equal(blockDuration({...block,status:'running',finished_at:0},3500),'2.5 s');
  assert.equal(blockDuration({...block,status:'running',finished_at:0},63000),'1 m 2 s');
  assert.equal(blockDuration({...block,finished_at:500},10000),'0 ms');
  assert.equal(blockDuration({...block,finished_at:0},10000),'');
  assert.equal(blockDuration({...block,started_at:1400},10000),'100 ms');
  assert.equal(blockDuration({...block,status:'running',started_at:3000,finished_at:0},3500),'500 ms');
});
