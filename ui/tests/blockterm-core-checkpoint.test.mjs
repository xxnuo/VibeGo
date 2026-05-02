import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeTerminalCheckpoint } from '../src/components/blockterm/checkpoint-protocol.ts';

const fixture = readFileSync(new URL('./fixtures/blockterm-checkpoint-v1.json', import.meta.url));
const original = JSON.parse(fixture);
const encode = value => Buffer.from(JSON.stringify(value));
const decode = value => decodeTerminalCheckpoint(encode(value));

test('v3 preserves authoritative wrap layouts and rejects invalid or mixed metadata', () => {
  const v3 = JSON.parse(readFileSync(new URL('./fixtures/blockterm-checkpoint-v3.json', import.meta.url)));
  assert.deepEqual(decode(v3).Wraps, [[false,false,false],[false,true,false]]);
  const unknown = structuredClone(v3); unknown.Wraps = [null,null];
  assert.deepEqual(decode(unknown).Wraps, [null,null]);
  const history = structuredClone(v3);
  history.Screens[0].History = [[]]; history.Screens[0].HistoryLimit = 1;
  history.Wraps[0] = [false,true,true,false];
  assert.deepEqual(decode(history).Wraps[0], history.Wraps[0]);
  for (const mutate of [
    d => delete d.Wraps, d => d.Wraps.pop(), d => d.Wraps[0].pop(),
    d => d.Wraps[0][0] = null, d => d.Wraps[0][0] = 0,
    d => d.Version = 2, d => d.Version = 4,
    d => delete d.SavedCharsets,
  ]) { const bad = structuredClone(v3); mutate(bad); assert.throws(() => decode(bad)); }
});

test('v2 preserves saved character maps and explicitly marks legacy unknown state', () => {
  const v2 = JSON.parse(readFileSync(new URL('./fixtures/blockterm-checkpoint-v2.json', import.meta.url)));
  const d = decode(v2);
  assert.equal(d.Version, 2);
  assert.equal(d.SavedCharsets[0].Charsets[1]['113'], '─');
  assert.equal(d.SavedCharsets[0].GR, 1);
  assert.equal(decodeTerminalCheckpoint(fixture).SavedCharsets, undefined);
  const legacy = structuredClone(v2);
  legacy.SavedCharsets = [null, null];
  assert.deepEqual(decode(legacy).SavedCharsets, [null, null]);
  for (const mutate of [
    d => delete d.SavedCharsets,
    d => d.SavedCharsets.pop(),
    d => d.SavedCharsets[0].Charsets.pop(),
    d => d.SavedCharsets[0].GL = 4,
    d => d.SavedCharsets[0].GR = -1,
    d => d.SavedCharsets[0].Single = 1,
    d => d.SavedCharsets[0].Charsets[0] = { '256': 'x' },
    d => d.SavedCharsets[0].Charsets[0] = { '1': '界'.repeat(86) },
    d => d.SavedCharsets[0].Extra = true,
    d => d.Version = 1,
    d => d.Version = 3,
  ]) { const bad = structuredClone(v2); mutate(bad); assert.throws(() => decode(bad)); }
});

test('decodes the real Go v1 checkpoint without flattening continuation state', () => {
  const d = decodeTerminalCheckpoint(fixture);
  assert.equal(d.Version, 1);
  assert.equal(d.Active, 1);
  assert.equal(d.Cols, 8);
  assert.equal(d.Rows, 3);
  assert.deepEqual(d.Tabs, []); // Go nil slice is JSON null.
  assert.equal(d.Screens[0].Rows[0][0].Content, '界');
  assert.equal(d.Screens[0].Rows[0][1].Width, 0);
  assert.deepEqual(d.Screens[0].Rows[0][0].Style.Fg, { Kind: 'basic', Value: [1, 0, 0, 0] });
  assert.equal(d.Screens[0].Rows[0][4].Style.Underline, 3);
  assert.equal(d.Screens[0].Rows[0][5].Link.URL, 'https://example.org/');
  assert.equal(d.Screens[1].Rows[0][0].Content, 'A');
  assert.deepEqual(d.Modes, original.Modes);
  assert.deepEqual(d.Colors, original.Colors);
  d.Screens[0].Rows[0][0].Content = 'changed';
  assert.equal(decodeTerminalCheckpoint(fixture).Screens[0].Rows[0][0].Content, '界');
});

test('rejects malformed and ambiguous encodings before state import', () => {
  for (const source of [
    '', '{}', 'null', '[]', `${fixture} {}`, '[',
    fixture.toString().replace('"Version": 1', '"Version": 1, "Version": 1'),
    fixture.toString().replace('"Version": 1', '"Version": 1, "version": 1'),
    fixture.toString().replace('"Version": 1', '"Version": 1, "\\u0056ersion": 1'),
    fixture.toString().replace('"Width": 2', '"Width": 2, "width": 2'),
    fixture.toString().replace('"Version": 1', '"Version": 1, "__proto__": {}'),
    '['.repeat(33) + '0' + ']'.repeat(33),
    `{"x":[${'0,'.repeat(1 << 19)}0]}`,
    '\ufeff' + fixture,
  ]) assert.throws(() => decodeTerminalCheckpoint(Buffer.from(source)));
  assert.throws(() => decodeTerminalCheckpoint(Buffer.from([0xff])));
  assert.throws(() => decodeTerminalCheckpoint(Buffer.alloc((8 << 20) + 1, 32)));
});

test('rejects invalid geometry, cells, modes and metadata without changing the fixture', () => {
  const mutations = {
    version: d => d.Version = 2,
    unknown: d => d.Future = true,
    missing: d => delete d.Phantom,
    dimensions: d => d.Cols = 4097,
    geometryBudget: d => { d.Cols = 4096; d.Rows = 9; },
    fractional: d => d.Rows = 1.5,
    active: d => d.Active = 2,
    screenCount: d => d.Screens.pop(),
    paletteCount: d => d.Palette.pop(),
    colorsCount: d => d.Colors.pop(),
    defaultColor: d => d.Colors[0] = null,
    charsetCount: d => d.Charsets.pop(),
    charsetKey: d => d.Charsets[0] = { '01': 'x' },
    charsetValue: d => d.Charsets[0] = { '1': '界'.repeat(86) },
    singleShift: d => d.Single = 1,
    lastRune: d => d.Last = 0xd800,
    loneSurrogate: d => d.Title = '\ud800',
    modes: d => d.Modes = [],
    duplicateMode: d => d.Modes.push(d.Modes[0]),
    modeSetting: d => d.Modes[0].Setting = 5,
    tabs: d => d.Tabs = [1, 1],
    tabOrder: d => d.Tabs = [2, 1],
    tabBounds: d => d.Tabs = [8],
    activeCursor: d => d.Screens[1].Cursor.X = 8,
    savedCursor: d => d.Screens[0].Saved.Y = 3,
    cursorStyle: d => d.Screens[0].Cursor.Style = 3,
    cursorBoolean: d => d.Screens[0].Cursor.Hidden = 0,
    scroll: d => d.Screens[0].Scroll.Max.X = 9,
    emptyScroll: d => d.Screens[0].Scroll.Min.X = 8,
    rowCount: d => d.Screens[0].Rows.pop(),
    rowWidth: d => d.Screens[0].Rows[0].pop(),
    width: d => d.Screens[0].Rows[0][0].Width = 3,
    spacer: d => d.Screens[0].Rows[0][1].Width = 1,
    spacerContent: d => d.Screens[0].Rows[0][1].Content = 'x',
    wideLastColumn: d => d.Screens[0].Rows[0][7].Width = 2,
    graphemeBytes: d => d.Screens[0].Rows[0][0].Content = '界'.repeat(86),
    underline: d => d.Screens[0].Rows[0][0].Style.Underline = 6,
    attrs: d => d.Screens[0].Rows[0][0].Style.Attrs = 256,
    color: d => d.Screens[0].Rows[0][0].Style.Fg.Value[0] = 16,
    colorLength: d => d.Screens[0].Rows[0][0].Style.Fg.Value.pop(),
    colorUnused: d => d.Screens[0].Rows[0][0].Style.Fg.Value[1] = 1,
    link: d => d.Screens[0].Rows[0][0].Link.URL = false,
    historyLimit: d => { d.Screens[0].HistoryLimit = 0; d.Screens[0].History = [[]]; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const d = structuredClone(original);
    mutate(d);
    assert.throws(() => decode(d), undefined, name);
  }
  assert.equal(decodeTerminalCheckpoint(fixture).Version, 1);
});

test('preserves legal history trimming, inactive old geometry and literal control text', () => {
  const d = structuredClone(original);
  d.Screens[0].Cursor.X = 4095;
  d.Screens[0].Cursor.Y = 4095;
  d.Screens[0].HistoryLimit = 1;
  d.Screens[0].History = [[d.Screens[0].Rows[0][0]]]; // Trimmed wide spacer.
  d.Screens[1].Rows[0][0].Content = '\x1b]52;c;AAAA\x07';
  d.Charsets[0] = { '255': '界' };
  const decoded = decode(d);
  assert.equal(decoded.Screens[0].History[0][0].Width, 2);
  assert.equal(decoded.Screens[1].Rows[0][0].Content, d.Screens[1].Rows[0][0].Content);
  for (const color of [
    null,
    { Kind: 'basic', Value: [15, 0, 0, 0] },
    { Kind: 'indexed', Value: [255, 0, 0, 0] },
    { Kind: 'true', Value: [0xffffff, 0, 0, 0] },
    { Kind: 'rgb', Value: [1, 2, 255, 0] },
    { Kind: 'rgba16', Value: [1, 2, 3, 65535] },
  ]) {
    d.Palette[0] = color;
    assert.deepEqual(decode(d).Palette[0], color);
  }
});

test('checks each color representation and exact UTF-8 grapheme boundary', () => {
  const d = structuredClone(original);
  for (const color of [
    { Kind: 'indexed', Value: [256, 0, 0, 0] },
    { Kind: 'true', Value: [0x1000000, 0, 0, 0] },
    { Kind: 'rgb', Value: [0, 0, 256, 0] },
    { Kind: 'rgb', Value: [0, 0, 0, 1] },
    { Kind: 'rgba16', Value: [0, 0, 0, 65536] },
    { Kind: 'rgba16', Value: [-1, 0, 0, 0] },
    { Kind: 'basic', Value: [1.5, 0, 0, 0] },
    { Kind: 'future', Value: [0, 0, 0, 0] },
  ]) {
    d.Palette[0] = color;
    assert.throws(() => decode(d));
  }
  d.Palette[0] = null;
  d.Screens[1].Rows[0][0].Content = '😀'.repeat(64);
  assert.equal(decode(d).Screens[1].Rows[0][0].Content, '😀'.repeat(64));
  d.Screens[1].Rows[0][0].Content += 'a';
  assert.throws(() => decode(d));
});

test('rejects oversized history payload before model allocation', () => {
  const d = structuredClone(original);
  const blank = d.Screens[1].Rows[0][7];
  d.Screens[0].HistoryLimit = 17;
  d.Screens[0].History = Array.from({ length: 17 }, () => Array(4096).fill(blank));
  const bytes = encode(d);
  assert.ok(bytes.length > 8 << 20);
  assert.throws(() => decodeTerminalCheckpoint(bytes));
});
