import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSnapshotText, lazySnapshotText } from '../src/components/blockterm/snapshot-text.ts';

test('snapshot full text is joined only on demand and cached even when empty', () => {
  for (const chunks of [[], ['中文', 'soft wrap', '\nnext line']]) {
    let joins = 0;
    const expected = chunks.join('');
    chunks.join = (separator) => {
      joins++;
      return Array.prototype.join.call(chunks, separator);
    };
    const read = lazySnapshotText(chunks);
    assert.equal(joins, 0);
    assert.equal(read(), expected);
    assert.equal(read(), expected);
    assert.equal(joins, 1);
  }
});

test('unread block snapshots never join their text chunks', () => {
  const readers = Array.from({ length: 2500 }, () => {
    const chunks = ['output'];
    chunks.join = () => { throw new Error('unused snapshot text was materialized'); };
    return lazySnapshotText(chunks);
  });
  assert.equal(readers.length, 2500);
});

test('snapshot visibility never reads full text and matches trim semantics', () => {
  assert.equal(hasSnapshotText(undefined), false);
  assert.equal(hasSnapshotText(null), false);
  for (const chunks of [[], [' ', '\n\t'], ['\u00a0', '\u3000'], ['中文'], ['\u200b'], ['', '\noutput']]) {
    const snapshot = { textChunks: chunks, get text() { throw new Error('full text read'); } };
    assert.equal(hasSnapshotText(snapshot), Boolean(chunks.join('').trim()));
    // Immutable snapshots are checked once, including empty snapshots.
    Object.defineProperty(snapshot, 'textChunks', { get() { throw new Error('cache missed'); } });
    assert.equal(hasSnapshotText(snapshot), Boolean(chunks.join('').trim()));
  }
});
