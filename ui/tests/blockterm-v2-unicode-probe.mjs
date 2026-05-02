import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = process.env.BLOCKTERM_URL || 'https://127.0.0.1:11984';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route('**/blockterm-unicode', route => route.fulfill({ contentType: 'text/html', body: `
    <html><body><script type="module">
      const {BlockEngine}=await import('/src/components/blockterm/engine.ts');
      window.fixture={BlockEngine};
    </script></body></html>` }));
  await page.goto(`${base}/blockterm-unicode`);
  await page.waitForFunction(() => window.fixture, null, { timeout: 90000 });
  const results = await page.evaluate(async () => {
    const {BlockEngine} = window.fixture;
    const run = async (text, split) => {
      const host = document.createElement('div');
      document.body.append(host);
      const engine = new BlockEngine(host, {id:'unicode',group_id:'test',shell:'bash',cwd:'/tmp',phase:'ready',cols:5,rows:3,seq:0});
      const data = new TextEncoder().encode(text);
      if (split === 'framed') {
        let seq=0;
        for (const byte of data) await engine.apply({type:'terminal',session_id:'unicode',seq:++seq,data:btoa(String.fromCharCode(byte))});
      } else if (split === 'runes') {
        for (const rune of text) await new Promise(resolve => engine.terminal.write(rune, resolve));
      } else if (split) {
        for (const byte of data) await new Promise(resolve => engine.terminal.write(new Uint8Array([byte]), resolve));
      } else await new Promise(resolve => engine.terminal.write(data, resolve));
      const buffer = engine.terminal.buffer.active;
      const result = {
        version: engine.terminal.unicode.activeVersion,
        text: engine.snapshot().text,
        searchFound: engine.searchOutput('X'),
        selection: engine.terminal.getSelection(),
        cursor: [buffer.cursorX, buffer.cursorY],
        cells: Array.from({length:3}, (_,y) => Array.from({length:5}, (_,x) => {
          const cell = buffer.getLine(y).getCell(x);
          return [cell.getChars(),cell.getWidth()];
        })),
      };
      engine.dispose(); host.remove();
      return result;
    };
    const cases=[];
    const resizedCursors=[];
    for(const [save,restore] of [['\x1b7','\x1b8'],['\x1b[s','\x1b[u'],['\x1b[?1049h','\x1b[?1049l']]) {
      for(const [cols,rows] of [[4,2],[12,4]]) {
        const host=document.createElement('div');document.body.append(host);
        const engine=new BlockEngine(host,{id:'resize-cursor',cols:8,rows:3});
        try {
          await engine.write('\x1b[3;1Habcdefgh'+save+'\x1b[H');
          await engine.apply({session_id:'resize-cursor',seq:1,type:'resize',data:btoa(JSON.stringify({cols,rows}))});
          await engine.write(restore);
          const buffer=engine.terminal.buffer.active;
          const cursor=[buffer.cursorX,buffer.cursorY];
          await engine.write('X');
          resizedCursors.push({cols,rows,cursor,cell:buffer.getLine(buffer.baseY+Math.min(2,rows-1)).getCell(Math.min(8,cols-1)).getChars()});
        } finally {engine.dispose();host.remove();}
      }
    }
    const alternateModes=[];
    for(const mode of [47,1047]) {
      const host=document.createElement('div');document.body.append(host);
      const engine=new BlockEngine(host,{id:'alternate-mode',cols:8,rows:3});
      try {
        const on=`\x1b[?${mode}h`,off=`\x1b[?${mode}l`;
        await engine.write('NORMAL\x1b[2;4H'+on);
        const entry=[engine.terminal.buffer.active.cursorX,engine.terminal.buffer.active.cursorY];
        const screen=engine.terminal.buffer.active.type;
        await engine.write('A'+on);
        const retained=engine.terminal.buffer.active.getLine(1).getCell(3).getChars();
        await engine.apply({session_id:'alternate-mode',seq:1,type:'resize',data:btoa(JSON.stringify({cols:4,rows:2}))});
        await engine.write('\x1b[1;2H'+off+'X');
        const exit=[engine.terminal.buffer.active.cursorX,engine.terminal.buffer.active.cursorY];
        const written=engine.terminal.buffer.active.getLine(engine.terminal.buffer.active.baseY).getCell(1).getChars();
        alternateModes.push({mode,entry,screen,retained,exit,written});
      } finally {engine.dispose();host.remove();}
    }
    const margins=[];
    for (const prefix of ['', '\x1b[?1049h']) {
      const input=prefix+'\x1b[?7labcde\u0301X\u0308';
      margins.push({whole:await run(input,false),framed:await run(input,'framed')});
    }
    for (const cluster of ['中','e\u0301','\u2764\ufe0f','\u231a\ufe0e','\u2615\ufe0e','\u2764\ufe0f\ufe0e','\u{1f1e8}\u{1f1f3}','1\ufe0f\u20e3','👋🏿','👩‍💻','👨‍👩‍👧‍👦']) {
      for (const prefix of ['', 'abc', 'abcd']) {
        const input=prefix+cluster+'X';
        cases.push({input,whole:await run(input,false),split:await run(input,true),runes:await run(input,'runes'),framed:await run(input,'framed')});
      }
    }
    const controlBoundary=async stringControl=>{
      const host=document.createElement('div'); document.body.append(host);
      const engine=new BlockEngine(host,{id:'boundary',cols:12,rows:3});
      try {
        await engine.write(new Uint8Array([0xe2]));
        await engine.write(stringControl?'\r\n':new TextEncoder().encode('\r\n'));
        await engine.write(new Uint8Array([0x82,0xac,0x58]));
        return {text:engine.snapshot().text,cursor:[engine.terminal.buffer.active.cursorX,engine.terminal.buffer.active.cursorY]};
      } finally {engine.dispose();host.remove();}
    };
    const blockBoundary=async()=>{
      const host=document.createElement('div'); document.body.append(host);
      const engine=new BlockEngine(host,{id:'boundary',cols:12,rows:3});
      let seq=0;
      const block=(id,status)=>engine.apply({session_id:'boundary',seq:++seq,type:'block',block_id:id,data:btoa(JSON.stringify({id,session_id:'boundary',status}))});
      const output=(id,bytes)=>engine.apply({session_id:'boundary',seq:++seq,type:'output',block_id:id,data:btoa(String.fromCharCode(...bytes))});
      try {
        await block('first','running');
        await output('first',[0xe2]);
        await block('first','done');
        await block('second','running');
        await output('second',[0x82,0xac,0x58]);
        await block('second','done');
        return {first:engine.outputText('first'),second:engine.outputText('second')};
      } finally {engine.dispose();host.remove();}
    };
    const capped=async(prefix,size,enabled=true,body='e'+'\u0301\u200d\u0308'.repeat(512))=>{
      const host=document.createElement('div');document.body.append(host);
      const engine=new BlockEngine(host,{id:'cap',cols:5,rows:3});
      try {
        if(!enabled) engine.graphemeLimit.dispose();
        const input=prefix+body+'\x1b[31mX';
        const data=new TextEncoder().encode(input);
        for(let start=0;start<data.length;start+=size) await engine.write(data.subarray(start,start+size));
        const buffer=engine.terminal.buffer.active;
        const cells=Array.from({length:3},(_,y)=>Array.from({length:5},(_,x)=>{
          const cell=buffer.getLine(y).getCell(x);
          return {text:cell.getChars(),width:cell.getWidth(),fg:cell.getFgColor()};
        }));
        return {cells,cursor:[buffer.cursorX,buffer.cursorY],text:engine.snapshot(true).text};
      } finally {engine.dispose();host.remove();}
    };
    const caps=[];
    for(const prefix of ['', 'abcd', '\x1b[?1049h', '\x1b[?1049habcd'])
      caps.push({whole:await capped(prefix,65536),split:await capped(prefix,7),partition:await capped(prefix,257)});
    return {cases,alternateModes,resizedCursors,margins,caps,growth:await capped('abcd',7,true,'\u2764'+'\u0301'.repeat(126)+'\ufe0f'),uncapped:await capped('',65536,false),controlString:await controlBoundary(true),controlBytes:await controlBoundary(false),blockBoundary:await blockBoundary()};
  });
  assert.ok(Buffer.byteLength(results.uncapped.cells[0][0].text)>256,'uncapped xterm comparison must reproduce accumulation');
  for(const alternate of results.alternateModes) {
    assert.equal(alternate.screen,'alternate');
    assert.deepEqual(alternate.entry,[3,1]);
    assert.equal(alternate.retained,'A');
    assert.deepEqual(alternate.exit,[2,0]);
    assert.equal(alternate.written,'X');
  }
  for(const resized of results.resizedCursors) {
    assert.deepEqual(resized.cursor,[Math.min(8,resized.cols-1),Math.min(2,resized.rows-1)],'saved cursor must map into resized geometry');
    assert.equal(resized.cell,'X','restored cursor must write without losing output or wrapping early');
  }
  for(const margin of results.margins) {
    assert.deepEqual(margin.framed,margin.whole,'no-wrap margin must not depend on input partition');
    assert.deepEqual(margin.whole.cells[0][3],['d',1]);
    assert.deepEqual(margin.whole.cells[0][4],['X\u0308',1]);
    assert.equal(margin.whole.cursor[1],0,'no-wrap output must remain on the first row');
  }
  for(const cap of results.caps) {
    assert.deepEqual(cap.split,cap.whole,'capped screen differs by input partition');
    assert.deepEqual(cap.partition,cap.whole);
    const cells=cap.whole.cells.flat();
    assert.ok(cells.some(cell=>cell.text.startsWith('e')&&Buffer.byteLength(cell.text)>=253));
    assert.ok(cells.every(cell=>Buffer.byteLength(cell.text)<=256));
    assert.equal(cells.find(cell=>cell.text==='X').fg,1,'SGR after capped cluster must be retained');
  }
  assert.equal(results.growth.cells[0][4].width,1,'dropped variation selector must not widen or relocate the cell');
  assert.ok(!results.growth.cells[0][4].text.includes('\ufe0f'));
  assert.deepEqual(results.growth.cursor,[1,1]);
  assert.deepEqual(results.controlString,results.controlBytes,'Internal control strings must break incomplete UTF-8 exactly like PTY bytes');
  assert.deepEqual(results.blockBoundary,{first:'',second:'X'},'Incomplete UTF-8 must not synthesize a character across command blocks');
  const failures=[];
  for (const item of results.cases) {
    assert.equal(item.whole.version, '15-graphemes');
    assert.equal(item.whole.searchFound, true);
    assert.equal(item.whole.selection, 'X');
    assert.ok(item.whole.text.includes(item.input), `snapshot lost grapheme: ${item.input}`);
    assert.deepEqual(item.framed,item.whole,`engine UTF-8 framing failed: ${item.input}`);
    for (const mode of ['split','runes']) {
      if (JSON.stringify(item[mode]) !== JSON.stringify(item.whole)) failures.push({ input:item.input, mode, expected:item.whole.cursor, actual:item[mode].cursor });
    }
  }
  assert.equal(results.cases.find(item => item.input === '👩‍💻X').whole.cells[0][0][1], 2);
  assert.ok(!failures.some(item=>item.mode==='runes'),'Complete rune writes must remain compatible');
  // Raw writes bypass the production UTF-8 framer; report upstream differences
  // without requiring that an upstream decoder bug remain present forever.
  console.log(JSON.stringify({ rawCompatible:failures.length===0, framedCompatible:true, cases: results.cases.length, failures }));
} finally {
  await browser.close();
}
