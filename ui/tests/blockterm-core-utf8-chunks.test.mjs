import assert from 'node:assert/strict';
import test from 'node:test';
import { CompleteUTF8Chunks } from '../src/components/blockterm/utf8-chunks.ts';

test('all byte partitions preserve valid and malformed terminal bytes', () => {
  const encoder = new TextEncoder();
  for (const data of [encoder.encode('A中\u200d💻\x1b[31m'), new Uint8Array([0xff,0xe0,0x80,0x80,0xed,0xa0,0x80,0xf4,0xbf,0xff,0xe2,0x80])]) {
    for (let width=1;width<=data.length;width++) {
      const stream = new CompleteUTF8Chunks();
      const out=[];
      for (let start=0;start<data.length;start+=width) out.push(...stream.push(data.subarray(start,start+width)));
      const tail=stream.flush();
      assert.ok(tail.length<=3);
      out.push(...tail);
      assert.deepEqual(new Uint8Array(out),data);
      assert.equal(stream.flush().length,0);
    }
  }
});

test('ZWJ is emitted only when its complete bytes arrive', () => {
  const stream=new CompleteUTF8Chunks();
  assert.equal(stream.push(new Uint8Array([0xe2])).length,0);
  assert.equal(stream.push(new Uint8Array([0x80])).length,0);
  assert.deepEqual(stream.push(new Uint8Array([0x8d])),new Uint8Array([0xe2,0x80,0x8d]));
  assert.deepEqual(stream.push(new Uint8Array([65])),new Uint8Array([65]));
});

test('valid UTF-8 output chunks never end inside a codepoint', () => {
  const input = new TextEncoder().encode('A中\u200d💻\u0080\u0800\u1000\u{10000}Z');
  for (let width=1;width<=input.length;width++) {
    const stream=new CompleteUTF8Chunks();
    for (let start=0;start<input.length;start+=width) {
      const chunk=stream.push(input.subarray(start,start+width));
      assert.doesNotThrow(()=>new TextDecoder('utf-8',{fatal:true}).decode(chunk));
    }
    assert.equal(stream.flush().length,0);
  }
});
