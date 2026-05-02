import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/blockterm-checkpoint-v2.json', import.meta.url)));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route('**/blockterm-checkpoint-cell', route => route.fulfill({ contentType: 'text/html', body: `
    <html><body><script type="module">
    window.fixture = {
      ...(await import('/src/components/blockterm/engine.ts')),
      ...(await import('/src/components/blockterm/checkpoint-protocol.ts')),
      ...(await import('/src/components/blockterm/xterm-checkpoint-cell.ts')),
    };
    </script></body></html>` }));
  await page.goto(`${process.env.BLOCKTERM_URL || 'https://127.0.0.1:11984'}/blockterm-checkpoint-cell`);
  await page.waitForFunction(() => window.fixture, null, { timeout: 90000 });
  const result = await page.evaluate(async fixture => {
    const { BlockEngine, decodeTerminalCheckpoint, createCheckpointCell, createCheckpointRow } = window.fixture;
    const engines = [];
    const make = () => {
      const host = document.createElement('div'); document.body.append(host);
      const engine = new BlockEngine(host, { id: 'checkpoint', cols: 8, rows: 3 });
      engines.push([engine, host]);
      return engine;
    };
    const cellView = c => ({
      text: c.getChars(), width: c.getWidth(),
      fgMode: c.getFgColorMode(), fg: c.getFgColor(), bgMode: c.getBgColorMode(), bg: c.getBgColor(),
      bold: !!c.isBold(), dim: !!c.isDim(), italic: !!c.isItalic(), blink: !!c.isBlink(),
      reverse: !!c.isInverse(), hidden: !!c.isInvisible(), strike: !!c.isStrikethrough(),
      underline: c.getUnderlineStyle(), underlineColor: c.getUnderlineColor(),
      underlineMode: c.getUnderlineColorMode(),
    });
    const state = engine => Array.from({ length: 3 }, (_, y) =>
      Array.from({ length: 8 }, (_, x) => cellView(engine.terminal.buffer.active.getLine(y).getCell(x))));
    const defaults = { Fg: null, Bg: null, UnderlineColor: null, Underline: 0, Attrs: 0 };
    const blankLink = { URL: '', Params: '' };
    const source = (style, text = 'X', width = 1, link = blankLink) =>
      ({ Content: text, Width: width, Style: { ...defaults, ...style }, Link: link });
    const put = (engine, cell, x = 0) => engine.terminal._core._bufferService.buffer.lines.get(0).setCell(x, cell);
    const caught = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
    try {
      const original = make(), restored = make();
      const cases = [];
      for (const [Attrs, sgr] of [[0, '0'], [1, '1'], [2, '2'], [4, '3'], [8, '5'], [32, '7'], [64, '8'], [128, '9'], [239, '1;2;3;5;7;8;9']])
        cases.push({ name: `attrs-${Attrs}`, style: { Attrs }, sgr });
      for (let Underline = 0; Underline <= 5; Underline++)
        cases.push({ name: `underline-${Underline}`, style: { Underline }, sgr: `4:${Underline}` });
      for (const [color, fg, bg, underline] of [
        [{ Kind: 'basic', Value: [1, 0, 0, 0] }, '31', '41', '58;5;1'],
        [{ Kind: 'basic', Value: [15, 0, 0, 0] }, '97', '107', '58;5;15'],
        [{ Kind: 'indexed', Value: [1, 0, 0, 0] }, '38;5;1', '48;5;1', '58;5;1'],
        [{ Kind: 'indexed', Value: [255, 0, 0, 0] }, '38;5;255', '48;5;255', '58;5;255'],
        [{ Kind: 'true', Value: [0x123456, 0, 0, 0] }, '38;2;18;52;86', '48;2;18;52;86', '58;2;18;52;86'],
        [{ Kind: 'rgb', Value: [18, 52, 86, 0] }, '38;2;18;52;86', '48;2;18;52;86', '58;2;18;52;86'],
        [{ Kind: 'rgba16', Value: [0x1212, 0x3434, 0x5656, 65535] }, '38;2;18;52;86', '48;2;18;52;86', '58;2;18;52;86'],
      ]) {
        cases.push({ name: `fg-${color.Kind}-${color.Value[0]}`, style: { Fg: color }, sgr: fg });
        cases.push({ name: `bg-${color.Kind}-${color.Value[0]}`, style: { Bg: color }, sgr: bg });
        // SGR 58 has no basic-16 selector; indexed preserves the same palette slot.
        const underlineColor = color.Kind === 'basic' ? { ...color, Kind: 'indexed' } : color;
        cases.push({ name: `underline-color-${color.Kind}-${color.Value[0]}`, style: { Underline: 3, UnderlineColor: underlineColor }, sgr: `4:3;${underline}` });
      }
      cases.push({ name: 'combined', style: { Fg: { Kind: 'indexed', Value: [123, 0, 0, 0] }, Attrs: 133, Underline: 5 }, sgr: '38;5;123;1;3;9;4:5' });
      const results = [];
      for (const c of cases) {
        const reset = '\x1b]8;;\x1b\\\x1b[0m\x1b[2J\x1b[H';
        await original.write(reset + `\x1b[${c.sgr}mX`);
        await restored.write(reset);
        const before = state(restored);
        const cell = createCheckpointCell(restored.terminal, source(c.style));
        const detached = JSON.stringify(before) === JSON.stringify(state(restored));
        const originalCell = original.terminal.buffer.active.getLine(0).getCell(0);
        const pair = [cellView(originalCell), cellView(cell)];
        put(restored, cell);
        const buffer = restored.terminal._core._bufferService.buffer;
        buffer.x = 1;
        restored.terminal._core._inputHandler._curAttrData = cell.clone();
        await original.write('Y\x1b[0mZ');
        await restored.write('Y\x1b[0mZ');
        results.push({ name: c.name, detached, pair, continuation: [state(original), state(restored)] });
      }

      const unicode = [];
      for (const [text, width] of [['', 0], ['', 1], ['界', 2], ['😀', 2], ['e\u0301', 1], ['👩‍💻', 2], ['\x1b]52;c;AAAA\x07', 1]]) {
        const one = createCheckpointCell(restored.terminal, source({ Underline: 3 }, text, width));
        const two = createCheckpointCell(restored.terminal, source({}, 'other', 1));
        two.extended.underlineStyle = 5;
        put(restored, one);
        const read = restored.terminal.buffer.active.getLine(0).getCell(0);
        unicode.push({ text, width, actual: [read.getChars(), read.getWidth()], isolated: one.extended.underlineStyle === 3 });
      }
      const checkpoint = decodeTerminalCheckpoint(new TextEncoder().encode(JSON.stringify(fixture)));
      const goCells = [];
      for (const screen of checkpoint.Screens) for (const row of screen.Rows) for (const c of row) {
        let id = 0;
        if (c.Link.URL) id = restored.terminal._core._oscLinkService.registerLink({ uri: c.Link.URL, id: 'sample' });
        const cell = createCheckpointCell(restored.terminal, c, id);
        goCells.push([c.Content === cell.getChars(), c.Width === cell.getWidth()]);
      }

      const linked = source({ Underline: 3 }, 'L', 1, { URL: 'https://example.org/', Params: 'id=sample:foo=bar' });
      await original.write('\x1b[0m\x1b[2J\x1b[H\x1b[4:3m\x1b]8;id=sample:foo=bar;https://example.org/\x1b\\L');
      const id = restored.terminal._core._oscLinkService.registerLink({ uri: linked.Link.URL, id: 'sample' });
      const linkCell = createCheckpointCell(restored.terminal, linked, id);
      const links = [cellView(original.terminal.buffer.active.getLine(0).getCell(0)), cellView(linkCell)];
      const emptyLinkIds = [];
      for (const Params of ['', 'id=', 'foo=bar:id=:baz=quux']) {
        const id = restored.terminal._core._oscLinkService.registerLink({ uri: linked.Link.URL });
        const cell = createCheckpointCell(restored.terminal, { ...linked, Link: { ...linked.Link, Params } }, id);
        emptyLinkIds.push(cell.extended.urlId === id);
      }
      const errors = {
        rapid: caught(() => createCheckpointCell(restored.terminal, source({ Attrs: 16 }))),
        alpha: caught(() => createCheckpointCell(restored.terminal, source({ Fg: { Kind: 'rgba16', Value: [1, 2, 3, 4] } }))),
        nul: caught(() => createCheckpointCell(restored.terminal, source({}, '\0'))),
        missingLink: caught(() => createCheckpointCell(restored.terminal, linked)),
        mismatchLink: caught(() => createCheckpointCell(restored.terminal, { ...linked, Link: { ...linked.Link, URL: 'https://other.example/' } }, id)),
        mismatchId: caught(() => createCheckpointCell(restored.terminal, { ...linked, Link: { ...linked.Link, Params: 'id=other' } }, id)),
        unexpectedLink: caught(() => createCheckpointCell(restored.terminal, source({}), id)),
        incompatible: caught(() => createCheckpointCell({ buffer: { active: { getNullCell: () => ({}) } } }, source({}))),
        rowLinks: caught(() => createCheckpointRow(restored.terminal, [source({})], [])),
      };
      const rowInput = [source({}, 'A'), source({}, '', 0), source({}, 'B')];
      const rowResults = [];
      for (const normalized of [false, true]) {
        await restored.write('\x1b]8;;\x1b\\\x1b[0m\x1b[2J\x1b[H');
        const row = normalized ? createCheckpointRow(restored.terminal, rowInput) : rowInput.map(c => createCheckpointCell(restored.terminal, c));
        row.forEach((c, x) => put(restored, c, x));
        restored.terminal._core._bufferService.buffer.x = 1;
        await restored.write('Z');
        rowResults.push(restored.terminal.buffer.active.getLine(0).translateToString(true));
      }
      const wideRow = createCheckpointRow(restored.terminal, [source({}, '界', 2), source({}, '', 0), source({}, '', 0)]);
      const historyRow = createCheckpointRow(restored.terminal, [source({ Underline: 3 }, '界', 2)]);
      return { results, unicode, goCells, links, emptyLinkIds, errors, rowResults,
        wideRow: wideRow.map(c => [c.getChars(), c.getWidth()]),
        historyRow: historyRow.map(c => [c.getChars(), c.getWidth(), c.getUnderlineStyle()]),
      };
    } finally {
      for (const [engine, host] of engines) { engine.dispose(); host.remove(); }
    }
  }, fixture);
  for (const value of result.results) {
    assert.ok(value.detached, value.name);
    assert.deepEqual(value.pair[1], value.pair[0], value.name);
    assert.deepEqual(value.continuation[1], value.continuation[0], `${value.name} continuation`);
  }
  for (const value of result.unicode) {
    assert.deepEqual(value.actual, [value.text, value.width]);
    assert.ok(value.isolated);
  }
  assert.equal(result.goCells.length, 48);
  assert.ok(result.goCells.every(pair => pair.every(Boolean)));
  assert.deepEqual(result.links[1], result.links[0]);
  assert.deepEqual(result.emptyLinkIds, [true, true, true]);
  for (const [name, error] of Object.entries(result.errors)) assert.ok(error, name);
  assert.deepEqual(result.rowResults, ['AZB', 'AZB']);
  assert.deepEqual(result.wideRow, [['界', 2], ['', 0], ['', 1]]);
  assert.deepEqual(result.historyRow, [['界', 2, 3], ['', 0, 3]]);
  console.log(`Checkpoint cells: ${result.results.length} parser/style continuation cases, 48 Go cells, Unicode, literal controls, OSC links, blank normalization, trimmed wide history and fail-closed cases passed`);
} finally {
  await browser.close();
}
