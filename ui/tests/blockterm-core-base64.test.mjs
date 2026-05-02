import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBase64Bytes } from '../src/components/blockterm/base64.ts';

test('output decoding preserves every byte across small and large payloads',()=>{
  for(const length of [0,1,2,3,255,256,8191,8192,8193,300000]) {
    const expected=Buffer.from(Array.from({length},(_,index)=>index%256));
    assert.deepEqual(Buffer.from(decodeBase64Bytes(expected.toString('base64'))),expected);
  }
  assert.throws(()=>decodeBase64Bytes('not!base64'));
});
