import assert from 'node:assert/strict';
import test from 'node:test';
import { installSavedCursorCharset } from '../src/components/blockterm/xterm-saved-charset.ts';

function fixture() {
  const charset = { _charsets: [{ q: '─' }, undefined, { q: '│' }, { q: '┼' }], glevel: 0, charset: undefined,
    setgLevel(level) { this.glevel = level; this.charset = this._charsets[level]; },
    setgCharset(index, value) { this._charsets[index] = value; if (index === this.glevel) this.charset = value; },
  };
  charset.setgLevel(0);
  const output = [], escapes = new Map();
  let fail = false;
  const handler = { _activeBuffer: {}, saveCursor: () => true, restoreCursor: () => true,
    softReset() { charset._charsets = []; charset.setgLevel(0); return true; },
    reset() { this._activeBuffer = {}; charset._charsets = []; charset.setgLevel(0); },
    print(data, start, end) { if (fail) throw Error('print failed'); for (let i = start; i < end; i++) { const c = String.fromCodePoint(data[i]); output.push(charset.charset?.[c] ?? c); } },
  };
  const terminal = { _core: { _inputHandler: handler, _charsetService: charset }, parser: {
    registerEscHandler({ final }, callback) { escapes.set(final, callback); return { dispose() { escapes.delete(final); } }; },
  } };
  return { terminal, charset, handler, output, escapes, setFail: value => fail = value };
}

test('saved designations and GL are cloned per screen and survive reselection', () => {
  const f = fixture(), guard = installSavedCursorCharset(f.terminal);
  const normal = f.handler._activeBuffer;
  f.handler.saveCursor();
  f.charset._charsets[0].q = 'changed';
  f.charset.setgLevel(1);
  f.handler._activeBuffer = {};
  f.handler.saveCursor();
  f.charset.setgLevel(2);
  f.handler.restoreCursor();
  assert.equal(f.charset.glevel, 1);
  f.handler._activeBuffer = normal;
  f.handler.restoreCursor();
  assert.equal(f.charset.glevel, 0);
  assert.equal(f.charset.charset.q, '─');
  f.charset._charsets[0].q = 'again';
  f.handler.restoreCursor();
  assert.equal(f.charset.charset.q, '─');
  guard.dispose();
});

test('single shifts consume one printable codepoint and restore charset on failure', () => {
  const f = fixture(), guard = installSavedCursorCharset(f.terminal);
  f.escapes.get('N')();
  f.handler.print(new Uint32Array(), 0, 0);
  f.handler.print(new Uint32Array([113, 113]), 0, 2);
  assert.deepEqual(f.output, ['│', '─']);
  f.escapes.get('O')();
  f.handler.saveCursor();
  f.setFail(true);
  assert.throws(() => f.handler.print(new Uint32Array([113]), 0, 1), /print failed/);
  assert.equal(f.charset.charset.q, '─');
  f.setFail(false);
  f.handler.restoreCursor();
  f.handler.print(new Uint32Array([113, 113]), 0, 2);
  assert.deepEqual(f.output.slice(-2), ['┼', '─']);
  guard.dispose();
});

test('resets clear saved charset and pending shift; disposal restores owned hooks', () => {
  for (const reset of ['softReset', 'reset']) {
    const f = fixture(), original = f.handler.print, guard = installSavedCursorCharset(f.terminal);
    f.escapes.get('N')(); f.handler.saveCursor(); f.handler[reset](); f.handler.restoreCursor();
    f.handler.print(new Uint32Array([113]), 0, 1);
    assert.deepEqual(f.output, ['q']);
    guard.dispose(); guard.dispose();
    assert.equal(f.handler.print, original);
    assert.equal(f.escapes.size, 0);
  }
  assert.throws(() => installSavedCursorCharset({}), /不兼容/);
});
