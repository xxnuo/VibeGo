import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlLease } from '../src/components/blockterm/control-lease.ts';

test('renewals serialize and late acquisition is released after stop',async()=>{
  let finish,claims=0,releases=0;
  const states=[];
  const lease=new ControlLease(()=>{claims++;return new Promise(resolve=>finish=resolve);},async()=>{releases++;},value=>states.push(value));
  const pending=lease.renew();
  await lease.renew();
  assert.equal(claims,1);
  lease.stop();
  assert.equal(releases,1);
  finish();
  await pending;
  assert.equal(releases,2);
  assert.deepEqual(states,[]);
  await lease.renew();
  assert.equal(claims,1);
});

test('failed renewal revokes local control and can recover',async()=>{
  let failed=false;
  const states=[];
  const lease=new ControlLease(async()=>{if(failed)throw Error('denied');},async()=>{},value=>states.push(value));
  await lease.renew();
  failed=true;
  await lease.renew();
  failed=false;
  await lease.renew();
  assert.deepEqual(states,[true,false,true]);
  lease.stop();
});
