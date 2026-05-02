import assert from 'node:assert/strict';
import test from 'node:test';
import { installSavedCursorStyle } from '../src/components/blockterm/xterm-saved-style.ts';

function fixture() {
  const ext = (urlId = 0, value = 0) => ({ urlId, value, clone() { return ext(this.urlId, this.value); } });
  const attrs = (urlId = 0, value = 0) => ({ extended: ext(urlId, value), updateExtended() { this.updated = true; } });
  const buffers = [{ savedCurAttrData: attrs(), ybase: 0, y: 0 }, { savedCurAttrData: attrs(), ybase: 0, y: 0 }];
  const data = new Map([[1, { uri: 'https://one.example/', id: 'one' }]]);
  let next = 10;
  const handler = { _activeBuffer: buffers[0], _curAttrData: attrs(1, 3),
    saveCursor() { return true; }, restoreCursor() { return true; },
    softReset() { this._curAttrData = attrs(); return true; },
  };
  const markers = [];
  const service = { getLinkData: id => data.get(id), registerLink(link) { data.set(++next, link); return next; }, addLineToLink(id, row) { markers.push([id, row]); } };
  const terminal = { _core: { _inputHandler: handler, _oscLinkService: service } };
  return { handler, buffers, data, terminal, attrs, markers };
}

test('saved extended attributes are independent per buffer and restored links survive marker expiry', () => {
  const f = fixture();
  const guard = installSavedCursorStyle(f.terminal);
  assert.equal(f.handler.saveCursor(), true);
  f.handler._curAttrData.extended.value = 5;
  f.data.delete(1);
  f.handler._activeBuffer = f.buffers[1];
  f.handler._curAttrData = f.attrs(0, 2);
  f.handler.saveCursor();
  f.handler._curAttrData.extended.value = 1;
  f.handler.restoreCursor();
  assert.equal(f.handler._curAttrData.extended.value, 2);
  f.handler._activeBuffer = f.buffers[0];
  f.handler.restoreCursor();
  assert.equal(f.handler._curAttrData.extended.value, 3);
  assert.equal(f.handler._curAttrData.updated, true);
  assert.equal(f.data.get(f.handler._curAttrData.extended.urlId).uri, 'https://one.example/');
  f.handler._curAttrData.extended.value = 4;
  assert.equal(f.buffers[0].savedCurAttrData.extended.value, 3);
  guard.dispose();
});

test('soft reset and saving an unlinked pen clear saved link context', () => {
  for (const reset of [true, false]) {
    const f = fixture();
    const guard = installSavedCursorStyle(f.terminal);
    f.handler.saveCursor();
    if (reset) f.handler.softReset();
    else { f.handler._curAttrData = f.attrs(); f.handler.saveCursor(); }
    f.handler._curAttrData = f.attrs(1, 5);
    f.handler.restoreCursor();
    assert.equal(f.handler._curAttrData.extended.value, 0);
    assert.equal(f.handler._curAttrData.extended.urlId, 0);
    guard.dispose();
  }
});

test('disposal is idempotent, instance local and does not overwrite later wrappers', () => {
  const first = fixture(), second = fixture();
  const original = first.handler.saveCursor;
  const originalRestore = first.handler.restoreCursor;
  const other = second.handler.saveCursor;
  const guard = installSavedCursorStyle(first.terminal);
  assert.notEqual(first.handler.saveCursor, original);
  assert.equal(second.handler.saveCursor, other);
  const wrapper = () => false;
  first.handler.saveCursor = wrapper;
  guard.dispose(); guard.dispose();
  assert.equal(first.handler.saveCursor, wrapper);
  assert.equal(first.handler.restoreCursor, originalRestore);
  assert.throws(() => installSavedCursorStyle({}), /不兼容/);
});

test('repeated restores reuse anonymous link registrations and track restored rows', () => {
  const f = fixture();
  f.data.set(1, { uri: 'https://one.example/' });
  const guard = installSavedCursorStyle(f.terminal);
  f.handler.saveCursor();
  for (let i = 0; i < 100; i++) f.handler.restoreCursor();
  assert.equal(f.data.size, 1);
  f.data.delete(1);
  f.handler.restoreCursor();
  const id = f.handler._curAttrData.extended.urlId;
  assert.notEqual(id, 1);
  f.buffers[0].ybase = 3;
  f.buffers[0].y = 2;
  for (let i = 0; i < 100; i++) f.handler.restoreCursor();
  assert.equal(f.data.size, 1);
  assert.equal(f.handler._curAttrData.extended.urlId, id);
  assert.deepEqual(f.markers.at(-1), [id, 5]);
  guard.dispose();
});
