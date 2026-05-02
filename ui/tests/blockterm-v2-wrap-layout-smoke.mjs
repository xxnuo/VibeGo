import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const cases = [
  ['pending', 'abcd', [false,false,false]],
  ['soft', 'abcdE', [false,true,false]],
  ['hard', 'abcd\r\nE', [false,false,false]],
  ['history', 'abcdefghijklm', [false,true,true,true]],
  ['wide', 'abc界X', [false,true,false]],
  ['selector', 'abc☀️X', [false,true,false]],
  ['linefeed clears', 'abcdE\x1b[1;1H\n', [false,false,false]],
  ['insert', 'abcdE\x1b[1;1H\x1b[L', [false,false,true]],
  ['delete', 'abcdE\x1b[2;1H\x1b[M', [false,false,false]],
  ['erase line', 'abcdE\x1b[2K', [false,false,false]],
  ['erase left preserves', 'abcdE\x1b[1K', [false,true,false]],
  ['erase chars preserves', 'abcdE\r\x1b[4X', [false,true,false]],
  ['erase right clears', 'abcdE\r\x1b[K', [false,false,false]],
  ['erase above clears', 'abcdefghi\x1b[2;4H\x1b[1J', [false,false,false]],
  ['erase display', 'abcdE\x1b[2J', [false,false,false]],
  ['no wrap', '\x1b[?7labcdEF', [false,false,false]],
];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route('**/blockterm-wrap-layout', route => route.fulfill({ contentType: 'text/html', body: `<script type="module">
    window.fixture=await import('/src/components/blockterm/engine.ts');
  </script>` }));
  await page.goto(`${process.env.BLOCKTERM_URL || 'https://127.0.0.1:11984'}/blockterm-wrap-layout`);
  await page.waitForFunction(() => window.fixture, null, { timeout: 90000 });
  const results = await page.evaluate(async cases => {
    const results = [];
    for (const [name,input,want] of cases) for (const split of [false,true]) {
      const host = document.createElement('div'); document.body.append(host);
      const engine = new window.fixture.BlockEngine(host, { id: name, cols: 4, rows: 3 });
      try {
        const bytes = new TextEncoder().encode(input);
        if (split) for (const byte of bytes) await engine.write(new Uint8Array([byte]));
        else await engine.write(bytes);
        const buffer = engine.terminal.buffer.active;
        results.push({ name, split, want, actual: Array.from({length:buffer.length}, (_, y) => buffer.getLine(y).isWrapped) });
      } finally { engine.dispose(); host.remove(); }
    }
    return results;
  }, cases);
  for (const result of results) assert.deepEqual(result.actual,result.want,`${result.name}, split=${result.split}`);
  console.log(`Wrap layout: ${results.length} whole/split cases match backend expectations for history, Unicode, edits and hard/soft line boundaries`);
} finally { await browser.close(); }
