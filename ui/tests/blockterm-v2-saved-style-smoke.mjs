import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route('**/blockterm-saved-style', route => route.fulfill({ contentType: 'text/html', body: `
    <html><body><script type="module">
      window.BlockEngine=(await import('/src/components/blockterm/engine.ts')).BlockEngine;
    </script></body></html>` }));
  await page.goto(`${process.env.BLOCKTERM_URL || 'https://127.0.0.1:11984'}/blockterm-saved-style`);
  await page.waitForFunction(() => window.BlockEngine, null, { timeout: 90000 });
  const results = await page.evaluate(async () => {
    const run = async (save, restore, kind, enabled = true) => {
      const host = document.createElement('div'); document.body.append(host);
      const engine = new window.BlockEngine(host, { id: 'saved-style', cols: 8, rows: 3, resize_mode: 'reflow-v1' });
      if (!enabled) { engine.savedCursorCharset?.dispose(); engine.savedCursorStyle?.dispose(); }
      const term = engine.terminal;
      const link = (url, id = '') => `\x1b]8;${id};${url}\x1b\\`;
      const first = 'https://first.example/', second = 'https://second.example/';
      const read = (x = 1, y = 0) => {
        const cell = term.buffer.active.getLine(y).getCell(x);
        return { text: cell.getChars(), underline: cell.getUnderlineStyle(), color: cell.getUnderlineColor(),
          mode: cell.getUnderlineColorMode(), link: term._core._oscLinkService.getLinkData(cell.extended.urlId)?.uri ?? null };
      };
      try {
        if (kind === 'style') await engine.write(`\x1b[4:3;58;2;12;34;56mA${save}\x1b[4:5;58;5;123mB${restore}X`);
        if (kind === 'link') await engine.write(`${link(first, 'id=first')}A${save}${link(second, 'id=second')}B${restore}X`);
        if (kind === 'no-link') await engine.write(`A${save}${link(second)}B${restore}\x1b[4mX`);
        if (kind === 'soft-reset') {
          await engine.write(`\x1b[4:3;58;2;12;34;56m${link(first)}A${save}\x1b[!p${restore}\x1b[4mX`);
          return read(0);
        }
        if (kind === 'hard-reset') {
          await engine.write(`\x1b[4:3;58;2;12;34;56m${link(first)}A${save}\x1bc${restore}\x1b[4mX`);
          return read(0);
        }
        if (kind === 'no-save') {
          await engine.write(`\x1b[4:3;58;2;12;34;56m${link(first)}A${restore}\x1b[4mX`);
          return read(0);
        }
        if (kind === 'expired-link') {
          term.options.scrollback = 0;
          await engine.write(`${link(first, 'id=expired')}A${save}${link('')}`);
          const oldId = term._core._bufferService.buffer.savedCurAttrData.extended.urlId;
          await engine.write('\r\n'.repeat(8));
          const oldRemoved = !term._core._oscLinkService.getLinkData(oldId);
          await engine.write(`${restore}X`);
          return { ...read(), oldRemoved };
        }
        if (kind === 'both-screens') {
          await engine.write('\x1b[4:3;58;2;12;34;56mA\x1b7\x1b[?1047h\x1b[H\x1b[4:5;58;5;123mC\x1b7\x1b[4:1mD\x1b8X');
          const alternate = read();
          await engine.write('\x1b[?1047l\x1b8X');
          return { alternate, normal: read() };
        }
        if (kind === 'pending-wrap') {
          await engine.write(`\x1b[4:3;58;2;12;34;56mABCDEFGH${save}\r\x1b[0mZ${restore}X`);
          return read(0, 1);
        }
        if (kind === 'alt-soft-reset') {
          await engine.write('\x1b[4:3;58;2;12;34;56mA\x1b[?1049h\x1b[!p\x1b[?1049lX');
          return read();
        }
        if (kind === 'anonymous-repeat') {
          term.options.scrollback = 0;
          await engine.write(`${link(first)}A${save}${link('')}${restore.repeat(100)}`);
          const counts = [term._core._oscLinkService._dataByLinkId.size];
          await engine.write(`${link('')}${'\r\n'.repeat(8)}${restore.repeat(100)}X`);
          counts.push(term._core._oscLinkService._dataByLinkId.size);
          return { counts, cell: read() };
        }
        return read();
      } finally { engine.dispose(); host.remove(); }
    };
    const cases = [];
    for (const [save, restore] of [['\x1b7', '\x1b8'], ['\x1b[s', '\x1b[u'], ['\x1b[?1048h', '\x1b[?1048l'], ['\x1b[?1049h', '\x1b[?1049l']])
      for (const kind of ['style', 'link', 'no-link']) cases.push({ save, kind, value: await run(save, restore, kind) });
    const extra = {};
    for (const kind of ['soft-reset', 'hard-reset', 'no-save', 'expired-link', 'both-screens', 'pending-wrap', 'alt-soft-reset', 'anonymous-repeat']) extra[kind] = await run('\x1b7', '\x1b8', kind);
    return { cases, extra, baseline: await run('\x1b7', '\x1b8', 'style', false) };
  });
  for (const { save, kind, value } of results.cases) {
    assert.equal(value.text, 'X');
    if (kind === 'style') {
      assert.equal(value.underline, 3, `${JSON.stringify(save)} underline restored`);
      assert.equal(value.color, 0x0c2238);
      assert.equal(value.mode, 0x3000000);
    } else assert.equal(value.link, kind === 'link' ? 'https://first.example/' : null, kind);
  }
  assert.notEqual(results.baseline.underline, 3, 'unpatched parser reproduces lost extended style');
  for (const name of ['soft-reset', 'hard-reset', 'no-save']) {
    assert.equal(results.extra[name].text, 'X', name);
    assert.equal(results.extra[name].underline, 1, name);
    assert.equal(results.extra[name].mode, 0, name);
    assert.equal(results.extra[name].link, null, name);
  }
  assert.ok(results.extra['expired-link'].oldRemoved);
  assert.equal(results.extra['expired-link'].link, 'https://first.example/');
  assert.equal(results.extra['both-screens'].alternate.underline, 5);
  assert.equal(results.extra['both-screens'].alternate.color, 123);
  assert.equal(results.extra['both-screens'].normal.underline, 3);
  assert.equal(results.extra['both-screens'].normal.color, 0x0c2238);
  for (const name of ['pending-wrap', 'alt-soft-reset']) {
    assert.equal(results.extra[name].text, 'X', name);
    assert.equal(results.extra[name].underline, 3, name);
    assert.equal(results.extra[name].color, 0x0c2238, name);
  }
  assert.deepEqual(results.extra['anonymous-repeat'].counts, [1, 1]);
  assert.equal(results.extra['anonymous-repeat'].cell.link, 'https://first.example/');
  console.log('Saved cursor styles: ESC/CSI/1048/1049, independent screens, reset and expired-link recovery passed; unpatched loss reproduced');
} finally { await browser.close(); }
