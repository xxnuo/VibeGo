import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/blockterm-checkpoint-v2.json', import.meta.url)));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route('**/blockterm-checkpoint-buffer', route => route.fulfill({ contentType: 'text/html', body: `<script type="module">
    window.fixture={...(await import('/src/components/blockterm/engine.ts')),...(await import('/src/components/blockterm/checkpoint-protocol.ts')),...(await import('/src/components/blockterm/xterm-checkpoint-buffer.ts'))};
  </script>` }));
  await page.goto(`${process.env.BLOCKTERM_URL || 'https://127.0.0.1:11984'}/blockterm-checkpoint-buffer`);
  await page.waitForFunction(() => window.fixture, null, { timeout: 90000 });
  const result = await page.evaluate(async fixture => {
    const { BlockEngine, decodeTerminalCheckpoint, prepareCheckpointBuffers, checkpointLinkKey } = window.fixture;
    const host = document.createElement('div'); document.body.append(host);
    const engine = new BlockEngine(host, { id: 'prepare', cols: 8, rows: 3 });
    const term = engine.terminal;
    const decode = value => decodeTerminalCheckpoint(new TextEncoder().encode(JSON.stringify(value)));
    try {
      await engine.write('KEEP\r\n\x1b[31mcurrent');
      const service = term._core._oscLinkService;
      const link = fixture.Screens[0].Rows[0][5].Link;
      const linkId = service.registerLink({ uri: link.URL, id: 'sample' });
      const links = new Map([[checkpointLinkKey(link), linkId]]);
      const live = () => JSON.stringify({
        screen: term.buffer.active.type, text: engine.snapshot().text,
        cursor: [term.buffer.active.cursorX, term.buffer.active.cursorY],
        normal: term._core._bufferService.buffers.normal.lines.get(0).translateToString(false),
        links: service._dataByLinkId.size,
        buffers: ['normal', 'alt'].map(name => {
          const b = term._core._bufferService.buffers[name];
          return { x: b.x, y: b.y, ybase: b.ybase, ydisp: b.ydisp, savedX: b.savedX, savedY: b.savedY,
            top: b.scrollTop, bottom: b.scrollBottom, tabs: b.tabs,
            lines: Array.from({ length: b.lines.length }, (_, y) => {
              const line = b.lines.get(y);
              return { cells: Array.from(line._data), text: line.translateToString(false), wrapped: line.isWrapped };
            }),
          };
        }),
        pen: { fg: term._core._inputHandler._curAttrData.fg, bg: term._core._inputHandler._curAttrData.bg,
          ext: term._core._inputHandler._curAttrData.extended.ext, url: term._core._inputHandler._curAttrData.extended.urlId },
      });
      const before = live();
      const raw = structuredClone(fixture);
      raw.Screens[0].History = [[raw.Screens[0].Rows[0][0]], raw.Screens[0].Rows[0]];
      raw.Screens[0].HistoryLimit = 2;
      raw.Screens[0].Saved.X = 7; raw.Screens[0].Saved.Y = 2; raw.Screens[0].SavedPhantom = true;
      raw.Screens[1].Cursor.X = 7; raw.Phantom = true;
      raw.Tabs = [1, 4, 7];
      raw.Screens[0].Scroll.Min.Y = 1;
      const source = decode(raw);
      const wraps = [[false, false, false, true, false], [false, false, true]];
      const prepared = prepareCheckpointBuffers(term, source, wraps, links);
      const v3 = structuredClone(raw); v3.Version = 3; v3.Wraps = wraps;
      const automatic = prepareCheckpointBuffers(term, decode(v3), undefined, links);
      const authoritative = prepareCheckpointBuffers(term, decode(v3), [[], []], links);
      if (JSON.stringify(automatic.screens.map(s => s.lines.map(l => l.isWrapped))) !== JSON.stringify(wraps) ||
          JSON.stringify(authoritative.screens.map(s => s.lines.map(l => l.isWrapped))) !== JSON.stringify(wraps))
        throw Error('v3 layout was not authoritative');
      const unchanged = before === live();
      const normal = prepared.screens[0], alternate = prepared.screens[1];
      const read = (line, column) => { const c = term.buffer.active.getNullCell(); line.loadCell(column, c); return [c.getChars(), c.getWidth(), c.getFgColor(), c.getUnderlineStyle(), service.getLinkData(c.extended.urlId)?.uri ?? null]; };
      const projection = {
        stage: prepared.stage, active: prepared.active,
        history: normal.ybase, viewport: normal.ydisp,
        saved: [normal.savedX, normal.savedY], cursor: [alternate.x, alternate.y],
        scroll: [normal.scrollTop, normal.scrollBottom], tabs: normal.tabs,
        counts: prepared.screens.map(s => s.lines.length),
        wraps: prepared.screens.map(s => s.lines.map(line => line.isWrapped)),
        wide: [read(normal.lines[0], 0), read(normal.lines[0], 1), read(normal.lines[0], 7)],
        linked: read(normal.lines[2], 5),
      };
      source.Screens[0].Rows[0][0].Content = 'mutated';
      normal.lines[0].setCell(0, alternate.pen);
      const independent = read(normal.lines[2], 0)[0] === '界' && before === live();
      const failures = [];
      const reject = (name, value, layout = wraps, ids = links) => {
        let error = '';
        try { prepareCheckpointBuffers(term, decode(value), layout, ids); } catch (e) { error = e.message; }
        failures.push({ name, error, unchanged: before === live() });
      };
      const mutate = (fn) => { const d = structuredClone(raw); fn(d); return d; };
      reject('legacy', mutate(d => { d.Version = 1; delete d.SavedCharsets; }));
      const unknownLayout = structuredClone(v3); unknownLayout.Wraps[0] = null;
      reject('unknown v3 layout cannot be overridden', unknownLayout);
      reject('unknown saved state', mutate(d => d.SavedCharsets[1] = null));
      reject('missing wraps', raw, null);
      reject('wrong wraps', raw, [[], []]);
      reject('sparse wraps', raw, [Array(5), wraps[1]]);
      reject('unregistered link', raw, wraps, new Map());
      reject('alternate history', mutate(d => { d.Screens[1].History = [[]]; d.Screens[1].HistoryLimit = 1; }));
      reject('horizontal region', mutate(d => d.Screens[0].Scroll.Min.X = 1));
      reject('history wider than viewport', mutate(d => d.Screens[0].History[0] = Array(9).fill(d.Screens[0].Rows[0][2])));
      reject('late second-screen failure', mutate(d => d.Screens[1].Rows[2][7].Style.Attrs = 16));
      reject('invalid phantom', mutate(d => d.Screens[1].Cursor.X = 1));
      reject('expanded empty history budget', mutate(d => { d.Screens[0].History = Array.from({ length: 8193 }, () => []); d.Screens[0].HistoryLimit = 8193; }), [Array(8196).fill(false), wraps[1]]);
      term.options.scrollback = 1;
      reject('insufficient history capacity', raw);
      term.options.scrollback = 100000;
      const template = term._core._bufferService.buffers.normal.lines.get(0), clone = template.clone;
      template.clone = () => template;
      try { reject('aliasing clone', raw); } finally { template.clone = clone; }
      return { unchanged, independent, projection, failures };
    } finally { engine.dispose(); host.remove(); }
  }, fixture);
  assert.ok(result.unchanged);
  assert.ok(result.independent);
  const p = result.projection;
  assert.equal(p.stage, 'buffers-only'); assert.equal(p.active, 1);
  assert.deepEqual(p.counts, [5, 3]); assert.equal(p.history, 2); assert.equal(p.viewport, 2);
  assert.deepEqual(p.saved, [8, 4]); assert.deepEqual(p.cursor, [8, 0]);
  assert.deepEqual(p.scroll, [1, 2]); assert.deepEqual(p.tabs, { 1: true, 4: true, 7: true });
  assert.deepEqual(p.wraps, [[false, false, false, true, false], [false, false, true]]);
  assert.deepEqual(p.wide.map(c => c.slice(0, 2)), [['界', 2], ['', 0], ['', 1]]);
  assert.equal(p.linked[4], 'https://example.org/');
  for (const failure of result.failures) { assert.ok(failure.error, failure.name); assert.ok(failure.unchanged, failure.name); }
  console.log('Checkpoint buffer preparation: independent dual screens/history, authoritative v3 layout and 15 non-mutating rejection paths passed');
} finally { await browser.close(); }
