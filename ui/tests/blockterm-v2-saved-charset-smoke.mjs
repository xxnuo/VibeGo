import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route('**/blockterm-saved-charset', route => route.fulfill({ contentType: 'text/html', body: `<script type="module">window.BlockEngine=(await import('/src/components/blockterm/engine.ts')).BlockEngine;</script>` }));
  await page.goto(`${process.env.BLOCKTERM_URL || 'https://127.0.0.1:11984'}/blockterm-saved-charset`);
  await page.waitForFunction(() => window.BlockEngine, null, { timeout: 90000 });
  const result = await page.evaluate(async () => {
    const run = async (prefix, suffix, split = false, guarded = true) => {
      const host = document.createElement('div'); document.body.append(host);
      const engine = new window.BlockEngine(host, { id: 'charset', cols: 12, rows: 3, resize_mode: 'reflow-v1' });
      if (!guarded) engine.savedCursorCharset.dispose();
      try {
        const data = new TextEncoder().encode(prefix + suffix);
        if (split) for (const byte of data) await engine.write(new Uint8Array([byte]));
        else await engine.write(data);
        return engine.snapshot().text;
      } finally { engine.dispose(); host.remove(); }
    };
    const cases = [];
    for (const [save, restore] of [['\x1b7', '\x1b8'], ['\x1b[s', '\x1b[u'], ['\x1b[?1048h', '\x1b[?1048l'], ['\x1b[?1049h', '\x1b[?1049l']]) {
      for (const [name, initial, changed, suffix, expected] of [
        ['G0', '\x1b(0', '\x1b(B', 'q', '─'],
        ['G1', '\x1b)0\x0e', '\x1b)B\x0f', 'q\x0fq\x0eq', '─q─'],
        ['G2', '\x1b*0\x1bn', '\x1b*B\x0f', 'q', '─'],
        ['G3', '\x1b+0\x1bo', '\x1b+B\x0f', 'q', '─'],
        ['SS2', '\x1b*0\x1bN', '\x1b*B', 'qq', '─q'],
        ['SS3', '\x1b+0\x1bO', '\x1b+B', 'qq', '─q'],
      ]) for (const split of [false, true]) cases.push({ name, save, split, expected, actual: await run(initial + save + changed, restore + suffix, split) });
    }
    const resets = [];
    for (const reset of ['\x1b[!p', '\x1bc']) resets.push(await run('\x1b(0\x1b*0\x1bN\x1b7', reset + '\x1b8q'));
    const baseline = await run('\x1b)0\x0e\x1b7\x1b)B\x0f', '\x1b8q\x0eq', false, false);
    const screens = await run('\x1b(0\x1b7\x1b[?1047h\x1b(B\x1b7\x1b(0\x1b8q', '\x1b[?1047l\x1b8q');
    const nonASCII = await run('\x1b*0\x1bN', '😀q');
    const combining = [];
    for (const prefix of ['\x1b(0', '\x1b)0\x0e', '\x1b*0\x1bN', '\x1b+0\x1bO']) {
      for (const text of ['q\u0301', 'q\u0301\u0308', 'q\u0301X'])
        for (const split of [false, true]) combining.push({ expected: text.replace('q', '─'), actual: await run(prefix, text, split) });
    }
    const shiftAfterMark = await run('A\x1b*0\x1bN', '\u0301q');
    return { cases, resets, baseline, screens, nonASCII, combining, shiftAfterMark };
  });
  for (const value of result.cases) assert.equal(value.actual, value.expected, JSON.stringify(value));
  assert.deepEqual(result.resets, ['q', 'q']);
  assert.notEqual(result.baseline, '──', 'unpatched effective charset loses designation at SO');
  assert.equal(result.screens, '─');
  assert.equal(result.nonASCII, '😀q');
  for (const value of result.combining) assert.equal(value.actual, value.expected);
  assert.equal(result.shiftAfterMark, 'A\u0301q');
  console.log('Saved charsets: 48 ESC/CSI/1048/1049 whole/split G0-G3 and single-shift cases, resets, screen isolation and baseline mismatch passed');
} finally { await browser.close(); }
