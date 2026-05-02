import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser=await chromium.launch();
try {
  const page=await browser.newPage({ignoreHTTPSErrors:true});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/blockterm-text',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
    <html><body><div id="terminal"></div><script type="module">
    import {BlockEngine} from '/src/components/blockterm/engine.ts';
    import {captureLogicalCursor,mapReflowCursor} from '/src/components/blockterm/reflow-cursor.ts';
    import {captureReflowAnchor} from '/src/components/blockterm/reflow-anchor.ts';
    import {restoreReflowCursor,readSavedCursor,installSavedWrapRestore} from '/src/components/blockterm/xterm-cursor.ts';
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const React=(await import('${process.env.BLOCKTERM_VITE_DEPS||'/node_modules/.vite/deps'}/react.js')).default;
    const {createRoot}=(await import('${process.env.BLOCKTERM_VITE_DEPS||'/node_modules/.vite/deps'}/react-dom_client.js')).default;
    const {BlockOutput,HighlightedCommand}=await import('/src/components/blockterm/block-output.tsx');
    await import('/src/index.css');
    window.readSnapshot=async text=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'text',cols:6,rows:24});
      try {
        await new Promise(resolve=>engine.terminal.write(text,resolve));
        window.lastSnapshot=engine.snapshot();
        return window.lastSnapshot.text;
      } finally {engine.dispose();}
    };
    window.showSearch=(query,key='output',searchTarget)=>(window.searchRoot??=createRoot(document.getElementById('terminal'))).render(React.createElement(BlockOutput,{snapshot:window.lastSnapshot,query,key,searchTarget}));
    window.inspectCommand=async(command,query,selected)=>{
      (window.searchRoot??=createRoot(document.getElementById('terminal'))).render(React.createElement(HighlightedCommand,{command,query,selected}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const host=document.getElementById('terminal');
      return {text:host.textContent,marks:[...host.querySelectorAll('mark')].map(mark=>mark.textContent),active:[...host.querySelectorAll('mark[data-active-match]')].map(mark=>mark.textContent),scripts:host.querySelectorAll('script').length};
    };
    window.showWideSearch=async()=>{
      const host=document.createElement('div');document.body.append(host);
      const engine=new BlockEngine(host,{id:'wide-search',cols:120,rows:24});
      try {
        await new Promise(resolve=>engine.terminal.write('TARGET '+'界'.repeat(35)+' TARGET',resolve));
        window.lastSnapshot=engine.snapshot();
      } finally {engine.dispose();host.remove();}
      document.getElementById('terminal').style.width='240px';
      window.showSearch('TARGET');
    };
    window.testLiveSearch=async()=>{
      const host=document.createElement('div');document.body.append(host);
      const engine=new BlockEngine(host,{id:'live-search',cols:12,rows:24});
      const input=[];engine.terminal.onData(data=>input.push(data));
      let results;engine.onSearchResults(value=>results=value);
      try {
        const write=text=>new Promise(resolve=>engine.terminal.write(text,resolve));
        await write('你好 target\\r\\nsecond target');
        const found=engine.searchOutput('target');
        const firstCount={...results};
        const first=engine.terminal.getSelectionPosition();
        engine.searchOutput('target','next');
        const secondCount={...results};
        const second=engine.terminal.getSelectionPosition();
        engine.searchOutput('target','refresh');
        const refreshedSecond=engine.terminal.getSelectionPosition();
        engine.searchOutput('target','previous');
        const previous=engine.terminal.getSelectionPosition();
        engine.searchOutput('target','last');
        const lastBoundary=engine.terminal.getSelectionPosition();
        const lastBoundaryCount={...results};
        engine.searchOutput('target','first');
        const firstBoundary=engine.terminal.getSelectionPosition();
        const firstBoundaryCount={...results};
        const missing=engine.searchOutput('APPENDED');
        await write('\\r\\nAPPENDED');
        const appended=engine.searchOutput('APPENDED');
        const selected=engine.terminal.getSelection();
        engine.searchOutput('');
        const cleared=engine.terminal.getSelection();
        await write('\\r\\n'+'LIMIT '.repeat(1005));
        engine.searchOutput('LIMIT');
        const limited={...results};
        engine.searchOutput('LIMIT','last');
        const limitedLast={results:{...results},position:engine.terminal.getSelectionPosition(),text:engine.terminal.getSelection()};
        engine.searchOutput('LIMIT','first');
        const limitedFirst={results:{...results},position:engine.terminal.getSelectionPosition(),text:engine.terminal.getSelection()};
        const boundarySteps=[
          engine.stepOutputSearch('LIMIT','previous'),
          engine.stepOutputSearch('LIMIT','previous'),
          engine.stepOutputSearch('LIMIT','next'),
          engine.stepOutputSearch('LIMIT','next'),
          engine.stepOutputSearch('ABSENT_MATCH','next'),
          engine.stepOutputSearch('APPENDED','next'),
          engine.stepOutputSearch('APPENDED','next'),
        ];
        engine.searchOutput('');
        const markersAfterClear=engine.terminal.markers.length;
        let seq=0;
        const send=(type,data)=>engine.apply({session_id:'live-search',block_id:'cleanup',seq:++seq,type,data:btoa(JSON.stringify(data))});
        await send('block',{id:'cleanup',status:'running'});
        await write('cleanup target');
        engine.searchOutput('target');
        const markersDuringSearch=engine.terminal.markers.length;
        await send('block',{id:'cleanup',status:'done',exit_code:0});
        const markersAfterDone=engine.terminal.markers.length;
        engine.searchOutput('target');
        await send('state',{id:'live-search',phase:'exited'});
        const markersAfterExit=engine.terminal.markers.length;
        const delayedCleanup=[];
        for(let cycle=0;cycle<8;cycle++) {
          engine.searchOutput('target');
          await write(' target');
          // Allow onWriteParsed to schedule the addon's 200ms refresh before clearing.
          await new Promise(resolve=>setTimeout(resolve,30));
          engine.searchOutput('');
          await new Promise(resolve=>setTimeout(resolve,250));
          delayedCleanup.push({markers:engine.terminal.markers.length,selection:engine.terminal.getSelection()});
        }
        return {found,first,second,refreshedSecond,previous,firstBoundary,lastBoundary,firstBoundaryCount,lastBoundaryCount,missing,appended,selected,cleared,input,firstCount,secondCount,limited,limitedLast,limitedFirst,boundarySteps,markersAfterClear,markersDuringSearch,markersAfterDone,markersAfterExit,delayedCleanup};
      } finally {engine.dispose();host.remove();}
    };
    window.testDisposedEngineReleasesHistory=async()=>{
      const host=document.createElement('div');document.body.append(host);
      const engine=new BlockEngine(host,{id:'dispose',cols:40,rows:24});
      let disposed=false;
      let seq=0;
      const send=(type,data)=>engine.apply({session_id:'dispose',block_id:'block',seq:++seq,type,data:btoa(typeof data==='string'?data:JSON.stringify(data))});
      try {
        await send('block',{id:'block',kind:'background',status:'running'});
        await send('output','NORMAL_HISTORY');engine.freeze();engine.outputText('block');
        const retained=engine.snapshots.get('block');
        await send('output','\\x1b[?1049hALT_HISTORY');engine.freeze();
        const before=[engine.blocks.size,engine.snapshots.size,engine.alternateSnapshots.size];
        engine.dispose();
        disposed=true;
        return {before,after:[engine.blocks.size,engine.snapshots.size,engine.alternateSnapshots.size],current:engine.current,textCache:engine.textCache,frozen:engine.frozen,retained:retained.text,styles:engine.snapshotStyles.size};
      } finally {if(!disposed)engine.dispose();host.remove();}
    };
    window.testSnapshotStyleSharing=async()=>{
      const host=document.createElement('div');document.body.append(host);
      const engine=new BlockEngine(host,{id:'styles',cols:80,rows:24});
      try {
        const write=text=>new Promise(resolve=>engine.terminal.write(text,resolve));
        await write(Array.from({length:1200},(_,index)=>(index%2?'\\x1b[31m':'\\x1b[32m')+'line_'+index+'\\r\\n').join(''));
        const first=engine.snapshot();
        const second=engine.snapshot();
        const spans=first.styledRows.flat();
        const palette=new Set(spans.map(span=>span.style));
        const shared=second.styledRows.flat().every(span=>palette.has(span.style));
        const frozen=spans.every(span=>Object.isFrozen(span.style));
        await write(Array.from({length:400},(_,index)=>'\\x1b[38;2;'+Math.floor(index/256)+';'+(index%256)+';123mX').join(''));
        engine.snapshot();
        return {rows:first.rows,styles:palette.size,shared,frozen,first:first.textChunks[0],last:first.text.includes('line_1199'),cache:engine.snapshotStyles.size};
      } finally {engine.dispose();host.remove();}
    };
    window.testCompletionCursorAttributes=async()=>{
      const results=[];
      for(const finish of ['block','state']){
        const host=document.createElement('div');document.body.append(host);
        const engine=new BlockEngine(host,{id:'completion',cols:40,rows:24});
        let seq=0;
        const send=(type,data)=>engine.apply({session_id:'completion',block_id:'command',seq:++seq,type,data:btoa(typeof data==='string'?data:JSON.stringify(data))});
        try {
          await send('block',{id:'command',kind:'command',status:'running'});
          await send('output','\\x1b[31mA');
          await send(finish,finish==='block'?{id:'command',kind:'command',status:'done'}:{id:'completion',phase:'exited'});
          await send('terminal','B');
          results.push({text:engine.snapshot().text,foreground:engine.terminal.buffer.normal.getLine(0).getCell(1).getFgColor()});
        } finally {engine.dispose();host.remove();}
      }
      return results;
    };
    window.testBackgroundEventReplay=async()=>{
      const encode=data=>btoa(String.fromCharCode(...data));
      const bytes=text=>new TextEncoder().encode(text);
      const prefix=bytes('\\x1b[31m\\x1b]0;hidden title\\x07\\x1bPignored payload\\x1b\\\\\\x1b[?2004l');
      const output=bytes('中文😀background\\x1b[0m');
      const events=[];
      const push=(type,data,block_id)=>events.push({session_id:'background-replay',seq:events.length+1,type,block_id,data:encode(data)});
      for(const ch of prefix)push('terminal',new Uint8Array([ch]));
      push('block',bytes(JSON.stringify({id:'background',kind:'background',status:'done'})),'background');
      for(const ch of output)push('output',new Uint8Array([ch]),'background');
      const run=async()=>{
        const host=document.createElement('div');document.body.append(host);
        const engine=new BlockEngine(host,{id:'background-replay',cols:40,rows:24});
        try {
          for(const event of events){
            await engine.apply(event);
            engine.publishBackground();
          }
          const snapshot=engine.snapshots.get('background');
          return {text:snapshot?.text,styled:snapshot?.styledRows.flat().map(span=>span.text).join('').trim(),foreground:engine.terminal.buffer.normal.getLine(0).getCell(0).getFgColor(),paste:engine.terminal.modes.bracketedPasteMode,blocks:engine.blocks.size,cursor:engine.cursor};
        } finally {engine.dispose();host.remove();}
      };
      return {first:await run(),replay:await run(),count:events.length};
    };
    window.testScreenSnapshotIsolation=async()=>{
      const host=document.createElement('div');document.body.append(host);
      const engine=new BlockEngine(host,{id:'isolation',cols:40,rows:24});
      let seq=0;
      const send=(type,id,data)=>engine.apply({session_id:'isolation',block_id:id,seq:++seq,type,data:btoa(data)});
      const styled=snapshot=>snapshot?.styledRows.flat().map(span=>span.text).join('').trim();
      try {
        await send('block','first',JSON.stringify({id:'first',kind:'background',status:'running'}));
        await send('output','first','NORMAL');
        engine.publishBackground();
        const original=engine.snapshots.get('first');
        engine.publishBackground();
        const reused=original===engine.snapshots.get('first');
        await send('output','first','\\x1b[?1049h\\x1b[2J\\x1b[HALTERNATE');
        engine.publishBackground();
        const originalAlternate=engine.alternateSnapshots.get('first');
        engine.publishBackground();
        const reusedAlternate=originalAlternate===engine.alternateSnapshots.get('first');
        const during={normal:engine.snapshots.get('first')?.text,normalStyled:styled(engine.snapshots.get('first')),alternate:engine.alternateSnapshots.get('first')?.text};
        // A new block may arrive without a prior completion event during recovery.
        await send('block','second',JSON.stringify({id:'second',status:'running'}));
        await send('output','second','SECOND');
        engine.freeze();
        const second=engine.snapshots.get('second');
        await send('output','second','!');engine.freeze();
        const refreshed=engine.snapshots.get('second')!==second && engine.snapshots.get('second').text==='SECOND!';
        const beforeResize=engine.snapshots.get('second');
        engine.terminal.resize(30,20);engine.freeze();
        const resized=engine.snapshots.get('second')!==beforeResize && engine.snapshots.get('second').cols===30;
        return {reused,reusedAlternate,refreshed,resized,during,normal:engine.snapshots.get('first')?.text,normalStyled:styled(engine.snapshots.get('first')),alternate:engine.alternateSnapshots.get('first')?.text,second:second?.text};
      } finally {engine.dispose();host.remove();}
    };
    window.testRepeatedResize=async(glyph='界')=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'repeat',cols:40,rows:24,resize_mode:'reflow-v1'});
      let seq=0;
      const send=(type,data)=>engine.apply({session_id:'repeat',block_id:'live',seq:++seq,type,data:btoa(String.fromCharCode(...new TextEncoder().encode(data)))});
      try {
        await send('block',JSON.stringify({id:'live',status:'running'}));
        let expected='';
        for(let index=0;index<60;index++) {
          const text=String(index).padStart(2,'0')+(index%2===0?glyph+' ':'-');
          expected+=text;
          await send('output',text);
          const before=captureLogicalCursor(engine.terminal.buffer.normal);
          try {await send('resize',JSON.stringify({cols:[6,17,40,9][index%4],rows:24}));}
          catch(error){throw new Error('Resize '+index+' failed: '+error.message+' cursor='+engine.terminal.buffer.normal.cursorY+' base='+engine.terminal.buffer.normal.baseY+' mapped='+JSON.stringify(mapReflowCursor(before.widths,before.offset,engine.terminal.cols))+' start='+before.startRow+' offset='+before.offset+' total='+before.widths.reduce((a,b)=>a+b,0));}
          if(engine.outputText('live')!==expected) throw new Error('Output changed at resize '+index+': '+engine.outputText('live'));
          if(engine.terminal.markers.length!==0) throw new Error('Leaked reflow marker');
        }
        await send('output','!');
        return {actual:engine.outputText('live'),expected:expected+'!'};
      } finally {engine.dispose();}
    };
    window.testSavedScrollback=async()=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'saved-history',cols:40,rows:24});
      try {
        await new Promise(resolve=>engine.terminal.write('abcdefghijklmnop\\x1b[1;9H\\x1b7\\r\\n'+'later\\r\\n'.repeat(50),resolve));
        const saved=captureReflowAnchor(engine.terminal,readSavedCursor(engine.terminal));
        engine.terminal.options.reflowCursorLine=true;
        engine.terminal.resize(6,24);
        const visible=saved.resolve();
        const history=saved.resolve(true);
        const restored=restoreReflowCursor(engine.terminal,history,true);
        const actual=readSavedCursor(engine.terminal);
        saved.dispose();
        return {visible,history,restored,absoluteRow:actual.row+engine.terminal.buffer.normal.baseY,column:actual.column};
      } finally {engine.dispose();}
    };
    window.testSavedReflow=async(pending=false,sequence='\\x1b8')=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'saved',cols:40,rows:24});
      const restoreHook=installSavedWrapRestore(engine.terminal);
      try {
        const source=pending?'abcdefghijkl\\x1b[31m\\x1b7\\x1b[0m\\x1b[1;3H':'abcdefghijklmnop\\x1b[1;9H\\x1b7\\x1b[1;3H';
        await new Promise(resolve=>engine.terminal.write(source,resolve));
        const point=readSavedCursor(engine.terminal);
        const saved=captureReflowAnchor(engine.terminal,point);
        const active=captureReflowAnchor(engine.terminal);
        engine.terminal.options.reflowCursorLine=true;
        engine.terminal.resize(6,24);
        const restored=restoreReflowCursor(engine.terminal,active.resolve());
        const restoredSaved=restoreReflowCursor(engine.terminal,saved.resolve(),true);
        active.dispose();saved.dispose();
        await new Promise(resolve=>engine.terminal.write(sequence+'X',resolve));
        const buffer=engine.terminal.buffer.active;
        const cell=buffer.getLine(buffer.baseY+buffer.cursorY).getCell(buffer.cursorX-1);
        return {point,restored,restoredSaved,text:engine.snapshot().text,foreground:cell.getFgColor()};
      } finally {restoreHook?.dispose();engine.dispose();}
    };
    window.testReflowContinuation=async(text,columns,suffix)=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'continuation',cols:40,rows:24});
      try {
        await new Promise(resolve=>engine.terminal.write(text,resolve));
        const anchor=captureReflowAnchor(engine.terminal);
        engine.terminal.options.reflowCursorLine=true;
        engine.terminal.resize(columns,24);
        const mapped=anchor.resolve();
        const restored=mapped&&restoreReflowCursor(engine.terminal,mapped);
        anchor.dispose();
        await new Promise(resolve=>engine.terminal.write(suffix,resolve));
        return {restored,text:engine.snapshot().text};
      } finally {engine.dispose();}
    };
    window.testReflowAnchor=async()=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'anchor',cols:40,rows:24});
      try {
        await new Promise(resolve=>engine.terminal.write('previous long line\\r\\nfirst second',resolve));
        const before=engine.terminal.markers.length;
        const anchor=captureReflowAnchor(engine.terminal);
        engine.terminal.options.reflowCursorLine=true;
        engine.terminal.resize(6,24);
        const narrow=anchor.resolve();
        engine.terminal.resize(40,24);
        const wide=anchor.resolve();
        anchor.dispose();anchor.dispose();
        const disposed=anchor.resolve();
        const after=engine.terminal.markers.length;
        const trimmed=captureReflowAnchor(engine.terminal);
        engine.terminal.reset();
        const reset=trimmed.resolve();
        trimmed.dispose();
        return {narrow,wide,disposed,before,after,reset};
      } finally {engine.dispose();}
    };
    window.captureCursor=async(text,columns)=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'capture',cols:6,rows:24});
      try {
        await new Promise(resolve=>engine.terminal.write(text,resolve));
        const captured=captureLogicalCursor(engine.terminal.buffer.active);
        return captured&&{...captured,mapped:mapReflowCursor(captured.widths,captured.offset,columns)};
      } finally {engine.dispose();}
    };
    window.testTextCache=async(mode='reflow-v1')=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'cache',cols:40,rows:24,resize_mode:mode});
      let seq=0;
      const send=(type,data)=>engine.apply({session_id:'cache',block_id:'live',seq:++seq,type,data:btoa(data)});
      try {
        await send('block',JSON.stringify({id:'live',status:'running'}));
        await send('output','first');
        const buffer=engine.terminal.buffer.normal;
        const original=buffer.getLine.bind(buffer);
        let reads=0;
        buffer.getLine=index=>{reads++;return original(index);};
        const first=engine.outputText('live');
        const initialReads=reads;
        const second=engine.outputText('live');
        const cachedReads=reads;
        await send('output',' second');
        const appended=engine.outputText('live');
        const appendReads=reads;
        await send('resize',JSON.stringify({cols:6,rows:24}));
        const resized=engine.outputText('live');
        const resizeReads=reads;
        await send('output','!');
        await send('resize',JSON.stringify({cols:40,rows:24}));
        const continued=engine.outputText('live');
        return {first,second,initialReads,cachedReads,appended,appendReads,resized,resizeReads,continued,markers:engine.terminal.markers.length};
      } finally {engine.dispose();}
    };
    window.verifyRejectedEventCursor=async()=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'protocol',cols:40,rows:24});
      try {
        let rejected=false;
        try { await engine.apply({session_id:'protocol',seq:1,type:'future-checkpoint',data:''}); }
        catch { rejected=true; }
        const rejectedCursor=engine.cursor;
        const invalidPayloads=[];
        for(const item of [
          {type:'block',block_id:'b',data:btoa(JSON.stringify({id:'other',status:'running'}))},
          {type:'state',data:btoa(JSON.stringify({id:'other',phase:'ready'}))},
          {type:'resize',data:btoa(JSON.stringify({cols:9999,rows:24}))},
          {type:'state',data:''},
        ]) {
          let failed=false;
          try {await engine.apply({session_id:'protocol',seq:1,...item});}catch{failed=true;}
          invalidPayloads.push(failed&&engine.cursor===0&&engine.blocks.size===0&&engine.session.id==='protocol'&&engine.terminal.cols===40&&engine.terminal.rows===24);
        }
        await engine.apply({session_id:'protocol',seq:1,type:'terminal',data:btoa('VALID_AFTER_REJECTION')});
        await engine.apply({session_id:'protocol',seq:1,type:'hello',data:'e30='});
        let staleHello=false;
        try {await engine.apply({session_id:'protocol',seq:0,type:'hello',data:'e30='});}catch{staleHello=true;}
        const preservedWatermark=engine.watermark;
        await engine.apply({session_id:'protocol',seq:2,type:'hello',data:'e30='});
        return {rejected,rejectedCursor,invalidPayloads,staleHello,preservedWatermark,watermark:engine.watermark,cursor:engine.cursor,text:engine.snapshot().text};
      } finally {engine.dispose();}
    };
    window.verifyLiveLinkPolicy=()=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'live-links',cols:40,rows:24});
      const originalOpen=window.open,originalConfirm=window.confirm;
      const opened=[],confirmed=[];
      let accept=true;
      window.open=(...args)=>{opened.push(args);return null;};
      window.confirm=value=>{confirmed.push(value);return accept;};
      try {
        const activate=uri=>engine.terminal.options.linkHandler.activate(new MouseEvent('click'),uri,{});
        for(const uri of ['javascript:alert(1)','https://user:pass@example.test','https://example.test/'+'a'.repeat(8192)])activate(uri);
        const blocked={opened:opened.length,confirmed:confirmed.length};
        activate('https://example.test/allowed');
        accept=false;
        activate('https://example.test/cancelled');
        return {blocked,opened,confirmed:confirmed.length};
      } finally {window.open=originalOpen;window.confirm=originalConfirm;engine.dispose();}
    };
    window.verifyOsc8Snapshots=async()=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'osc',cols:40,rows:24});
      try {
        let seq=0;
        const send=(type,data)=>engine.apply({session_id:'osc',block_id:'first',seq:++seq,type,data:btoa(typeof data==='string'?data:JSON.stringify(data))});
        await send('block',{id:'first',status:'running'});
        await send('output','\\x1b[?1049h\\x1b]8;;https://example.test/alternate\\x07ALT_REPORT\\x1b]8;;\\x07\\x1b[?1049lplain');
        await send('block',{id:'first',status:'done'});
        const alternate=engine.alternateSnapshots.get('first');
        const normal=engine.snapshots.get('first');
        return {text:alternate?.text,links:alternate?.links,normalLinks:normal?.links};
      } finally {engine.dispose();}
    };
    window.replayLifecycle=async events=>{
      const engine=new BlockEngine(document.getElementById('terminal'),{id:'text',cols:40,rows:24});
      try {
        const screens=[];
        const cursors=[];
        const mouseModes=[];
        for(const event of events){
          await engine.apply(event);
          if(event.checkScreen) {screens.push(engine.terminal.buffer.active.type);cursors.push(engine.terminal._core.coreService.isCursorHidden);mouseModes.push(engine.terminal.modes.mouseTrackingMode);}
        }
        const focusReports=[];
        const listener=engine.terminal.onData(value=>focusReports.push(value));
        engine.terminal.focus();
        engine.terminal.blur();
        listener.dispose();
        return {screens,cursors,mouseModes,alternate:engine.alternateSnapshots.get('first')?.text,alternateStyled:engine.alternateSnapshots.get('first')?.styledRows.flat().map(span=>span.text).join('').trim(),liveFirst:engine.outputText('first'),first:engine.snapshots.get('first')?.text,second:engine.snapshots.get('second')?.text,mouse:engine.terminal.modes.mouseTrackingMode,screen:engine.terminal.buffer.active.type,focusReports};
      } finally {engine.dispose();}
    };
    </script></body></html>`}));
  await page.goto(`${process.env.BLOCKTERM_URL||'https://127.0.0.1:11984'}/blockterm-text`);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(page.url()).origin});
  await page.waitForFunction(()=>typeof window.readSnapshot==='function');
  const liveLinkPolicy=await page.evaluate(()=>window.verifyLiveLinkPolicy());
  assert.deepEqual(liveLinkPolicy,{blocked:{opened:0,confirmed:0},opened:[['https://example.test/allowed','_blank','noopener,noreferrer']],confirmed:2});
  const rejectedEvent=await page.evaluate(()=>window.verifyRejectedEventCursor());
  assert.equal(rejectedEvent.rejected,true);
  assert.equal(rejectedEvent.rejectedCursor,0,'Unknown events must not advance the replay cursor');
  assert.deepEqual(rejectedEvent.invalidPayloads,[true,true,true,true],'Invalid payloads must leave session, blocks, geometry and cursor unchanged');
  assert.equal(rejectedEvent.cursor,1);
  assert.equal(rejectedEvent.staleHello,true);
  assert.equal(rejectedEvent.preservedWatermark,1);
  assert.equal(rejectedEvent.watermark,2);
  assert.equal(rejectedEvent.text,'VALID_AFTER_REJECTION');
  const oscSnapshot=await page.evaluate(()=>window.verifyOsc8Snapshots());
  assert.equal(oscSnapshot.text,'ALT_REPORT');
  assert.deepEqual(oscSnapshot.links,[[{start:0,end:10,href:'https://example.test/alternate'}]]);
  assert.ok(!oscSnapshot.normalLinks?.flat().length,'Alternate-screen links must not leak into the normal snapshot');
  const repeated=await page.evaluate(()=>window.testRepeatedResize());
  assert.equal(repeated.actual,repeated.expected);
  const special=await page.evaluate(()=>window.testRepeatedResize('ç•Œ'));
  assert.equal(special.actual,special.expected);
  const historical=await page.evaluate(()=>window.testSavedScrollback());
  assert.equal(historical.visible,null);
  assert.ok(historical.history.row<0);
  assert.equal(historical.restored,true);
  assert.equal(historical.absoluteRow,1);
  assert.equal(historical.column,2);
  const saved=await page.evaluate(()=>window.testSavedReflow());
  assert.deepEqual(saved.point,{row:0,column:8});
  assert.equal(saved.restored,true);
  assert.equal(saved.restoredSaved,true);
  assert.equal(saved.text,'abcdefghXjklmnop');
  for(const sequence of ['\x1b8','\x1b[u']) {
    const pending=await page.evaluate(sequence=>window.testSavedReflow(true,sequence),sequence);
    assert.equal(pending.text,'abcdefghijklX');
    assert.equal(pending.foreground,1,'Saved red attribute must survive cursor restoration');
  }
  for(const [text,columns,suffix,expected] of [
    ['first second',6,'!','first second!'],
    ['hello界',6,'文','hello界文'],
    ['hello 界',6,'!','hello 界!'],
    ['e\u0301 abcdef',6,'!','e\u0301 abcdef!'],
    ['first second',6,'\rX','first Xecond'],
  ]) {
    const result=await page.evaluate(({text,columns,suffix})=>window.testReflowContinuation(text,columns,suffix),{text,columns,suffix});
    assert.equal(result.restored,true);
    assert.equal(result.text,expected,JSON.stringify({text,columns,suffix}));
  }
  const anchor=await page.evaluate(()=>window.testReflowAnchor());
  assert.deepEqual(anchor.narrow,{row:4,column:5,pendingWrap:true});
  assert.deepEqual(anchor.wide,{row:1,column:12,pendingWrap:false});
  assert.equal(anchor.disposed,null);
  assert.equal(anchor.reset,null);
  assert.equal(anchor.after,anchor.before);
  for(const [text,widths,offset] of [
    ['hello界',[1,1,1,1,1,2],7],
    ['hello 界',[1,1,1,1,1,1,2],8],
    ['e\u0301 abcdef',[1,1,1,1,1,1,1,1],8],
    ['first second',Array(12).fill(1),12],
  ]) {
    const captured=await page.evaluate(({text})=>window.captureCursor(text,40),{text});
    assert.deepEqual(captured.widths,widths,text);
    assert.equal(captured.offset,offset,text);
    assert.deepEqual(captured.mapped,{row:0,column:offset,pendingWrap:false},text);
  }
  assert.equal(await page.evaluate(()=>window.captureCursor('\x1b[?1049h',40)),null);
  const middle=await page.evaluate(()=>window.captureCursor('first second\x1b[1;3H',40));
  assert.equal(middle.offset,2);
  assert.equal(middle.widths.length,12);
  const cache=await page.evaluate(()=>window.testTextCache());
  const legacy=await page.evaluate(()=>window.testTextCache('screen'));
  assert.equal(legacy.resized,'first ');
  assert.equal(cache.first,'first');
  assert.equal(cache.second,'first');
  assert.ok(cache.initialReads>0);
  assert.equal(cache.cachedReads,cache.initialReads);
  assert.equal(cache.appended,'first second');
  assert.ok(cache.appendReads>cache.cachedReads);
  assert.equal(cache.resized,'first second');
  assert.ok(cache.resizeReads>cache.appendReads);
  assert.equal(cache.continued,'first second!');
  assert.equal(cache.markers,0);
  for(const text of ['hello world','ab    cd','hello界','hell 界','abc   界','你好世界','e\u0301 abcd ef','abc\r\ndef']) {
    assert.equal(await page.evaluate(text=>window.readSnapshot(text),text),text.replaceAll('\r\n','\n'),JSON.stringify(text));
  }
  for(const split of [false,true]) {
    for(const explicitExit of [false,true]) {
      const events=[];
      const push=(type,block_id,data,checkScreen=false)=>events.push({session_id:'text',seq:events.length+1,type,block_id,data:Buffer.from(data).toString('base64'),checkScreen});
      const block=(id,status)=>push('block',id,JSON.stringify({id,session_id:'text',command:id,status}));
      const output=(id,text,check=false)=>{
        const bytes=Buffer.from(text);
        if(split){for(const byte of bytes)push('output',id,Buffer.from([byte]));if(check)events.at(-1).checkScreen=true;}
        else push('output',id,bytes,check);
      };
      block('first','running');
      output('first','before\r\n\x1b[?1049h\x1b[2J\x1b[H界面\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?1004h',true);
      if(explicitExit)output('first','\x1b[?1049lafter');
      block('first','done');
      events.at(-1).checkScreen=true;
      push('terminal','', 'prompt redraw');
      block('second','running');
      output('second','next command');
      block('second','done');
      const result=await page.evaluate(events=>window.replayLifecycle(events),events);
      assert.deepEqual(result.screens,['alternate','normal']);
      assert.deepEqual(result.cursors,[true,false]);
      assert.equal(result.first,explicitExit?'before\nafter':'before');
      assert.equal(result.liveFirst,result.first);
      assert.equal(result.alternate,'界面');
      assert.equal(result.alternateStyled,'界面');
      assert.equal(result.second,'next command');
      assert.equal(result.screen,'normal');
      assert.equal(result.mouse,'none');
      assert.deepEqual(result.focusReports,[]);
    }
  }
  for (const mode of [47,1047,1049]) {
    for (const split of [false,true]) {
      const events=[];
      const push=(type,id,data)=>events.push({session_id:'text',seq:events.length+1,type,block_id:id,data:Buffer.from(data).toString('base64')});
      push('block','first',JSON.stringify({id:'first',session_id:'text',command:'first',status:'running'}));
      const output=`normal\x1b[?${mode}h\x1b[2J\x1b[HOLD\x1b[?${mode}l\x1b[?${mode}h\x1b[2J\x1b[HLAST界面\x1b[?${mode}l\x1b[?${mode}l`;
      if(split) for(const byte of Buffer.from(output)) push('output','first',Buffer.from([byte]));
      else push('output','first',output);
      push('block','first',JSON.stringify({id:'first',session_id:'text',command:'first',status:'done'}));
      push('block','second',JSON.stringify({id:'second',session_id:'text',command:'second',status:'running'}));
      push('output','second','\x1b[?1049h\x1b[2J\x1b[HNEXT\x1b[?1049l');
      push('block','second',JSON.stringify({id:'second',session_id:'text',command:'second',status:'done'}));
      const result=await page.evaluate(events=>window.replayLifecycle(events),events);
      assert.equal(result.alternate,'LAST界面',`mode ${mode}, split ${split}`);
      assert.equal(result.alternateStyled,'LAST界面');
      assert.equal(result.screen,'normal');
    }
  }
  await page.evaluate(()=>window.readSnapshot('hello world\r\n'+'line\r\n'.repeat(180)+'hel\x1b[31mlo \x1b[0mworld'));
  const runningEvents=[
    {type:'block',data:JSON.stringify({id:'first',session_id:'text',status:'running',command:'stream'})},
    {type:'output',data:'still running\r\n中文 output'},
  ].map((event,index)=>({...event,session_id:'text',block_id:'first',seq:index+1,data:Buffer.from(event.data).toString('base64')}));
  const live=await page.evaluate(events=>window.replayLifecycle(events),runningEvents);
  assert.equal(live.first,undefined,'Running output has not been frozen');
  assert.equal(live.liveFirst,'still running\n中文 output');
  const exitEvents=[
    {type:'state',data:JSON.stringify({id:'text',phase:'editing'})},
    {type:'terminal',data:'native input\x1b[?1049h\x1b[?9h\x1b[?1006h\x1b[?1004h',checkScreen:true},
    {type:'state',data:JSON.stringify({id:'text',phase:'exited'}),checkScreen:true},
  ].map((event,index)=>({...event,session_id:'text',seq:index+1,data:Buffer.from(event.data).toString('base64')}));
  const exited=await page.evaluate(events=>window.replayLifecycle(events),exitEvents);
  assert.deepEqual(exited.screens,['alternate','normal']);
  assert.deepEqual(exited.mouseModes,['x10','none']);
  assert.equal(exited.mouse,'none');
  assert.deepEqual(exited.focusReports,[]);
  await page.evaluate(()=>window.showSearch('lo wo'));
  await page.getByText('输出匹配 1 / 2',{exact:true}).waitFor();
  await page.evaluate(()=>window.showSearch('lo wo','output',{index:1}));
  await page.getByText('输出匹配 2 / 2',{exact:true}).waitFor();
  await page.evaluate(()=>window.showSearch('lo wo','output',{index:0}));
  await page.getByText('输出匹配 1 / 2',{exact:true}).waitFor();
  const selectionCopy=await page.evaluate(()=>{
    const host=document.querySelector('[data-blockterm-output]');
    const first=host.querySelector('[data-output-row="0"]');
    const last=host.querySelector('[data-output-row="2"]');
    const range=document.createRange();range.setStart(first,0);range.setEnd(last,last.childNodes.length);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
    const clipboardData=new DataTransfer();
    const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData});
    host.dispatchEvent(event);
    selection.removeAllRanges();
    return {text:clipboardData.getData('text/plain'),handled:event.defaultPrevented};
  });
  assert.deepEqual(selectionCopy,{text:'hello world\nline',handled:true},'Selection copy must preserve hard breaks without adding soft-wrap newlines');
  await page.locator('[data-blockterm-output]').focus();
  await page.evaluate(async()=>{
    await navigator.clipboard.writeText('reverse-selection-sentinel');
    const host=document.querySelector('[data-blockterm-output]');
    const point=(row,offset)=>{
      const walker=document.createTreeWalker(host.querySelector(`[data-output-row="${row}"]`),NodeFilter.SHOW_TEXT);
      let node;
      while((node=walker.nextNode())) {
        if(offset<=node.textContent.length) return [node,offset];
        offset-=node.textContent.length;
      }
      throw new Error('Selection endpoint outside rendered text');
    };
    const [anchor,anchorOffset]=point(1,3);
    const [focus,focusOffset]=point(0,2);
    document.getSelection().setBaseAndExtent(anchor,anchorOffset,focus,focusOffset);
  });
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async()=>await navigator.clipboard.readText()==='llo wor');
  await page.evaluate(()=>document.getSelection().removeAllRanges());
  const dragStart=await page.locator('[data-output-row="0"]').boundingBox();
  const dragEnd=await page.locator('[data-output-row="2"]').boundingBox();
  assert.ok(dragStart&&dragEnd);
  await page.evaluate(()=>navigator.clipboard.writeText('mouse-selection-sentinel'));
  await page.mouse.move(dragStart.x+1,dragStart.y+dragStart.height/2);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x+dragEnd.width+2,dragEnd.y+dragEnd.height/2,{steps:12});
  await page.mouse.up();
  assert.ok(await page.evaluate(()=>!document.getSelection().isCollapsed),'Mouse drag must create a native selection');
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async()=>await navigator.clipboard.readText()==='hello world\nline');
  await page.evaluate(()=>document.getSelection().removeAllRanges());
  await page.getByRole('button',{name:'下一处输出匹配',exact:true}).click();
  await page.getByText('输出匹配 2 / 2',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]')?.scrollTop>1000);
  // Scroll coordinates update before the virtualizer commits the destination rows.
  // Wait for both old highlights to unmount and the active destination to render.
  await page.waitForFunction(()=>
    [...document.querySelectorAll('#terminal mark')].map(node=>node.textContent).join('')==='lo wo' &&
    [...document.querySelectorAll('#terminal mark[data-active-match]')].map(node=>node.textContent).join('')==='lo wo'
  );
  assert.ok((await page.locator('#terminal').textContent()).includes('hello '));
  assert.equal((await page.locator('#terminal mark').allTextContents()).join(''),'lo wo');
  assert.equal((await page.locator('#terminal mark[data-active-match]').allTextContents()).join(''),'lo wo');
  await page.getByRole('button',{name:'下一处输出匹配',exact:true}).click();
  await page.getByText('输出匹配 1 / 2',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]')?.scrollTop===0);
  await page.getByRole('button',{name:'上一处输出匹配',exact:true}).click();
  await page.getByText('输出匹配 2 / 2',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]')?.scrollTop>1000);
  await page.evaluate(()=>window.showSearch(''));
  await page.waitForFunction(()=>!document.querySelector('#terminal mark'));
  await page.locator('[data-blockterm-output]').evaluate(node=>{node.scrollTop=320;});
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]').scrollTop===320);
  const oldOutput=await page.locator('[data-blockterm-output]').elementHandle();
  await page.evaluate(()=>window.showSearch('','remounted'));
  await page.waitForFunction(node=>!node.isConnected,oldOutput);
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]').scrollTop===320);
  const outputRegion=page.getByRole('region',{name:'命令输出滚动区',exact:true});
  await outputRegion.focus();
  assert.equal(await outputRegion.evaluate(node=>document.activeElement===node),true);
  await outputRegion.evaluate(node=>node.scrollTop=0);
  await page.locator('[data-output-row="0"]').waitFor();
  const selectedText=await page.evaluate(()=>{
    const row=document.querySelector('[data-output-row="0"]');
    const range=document.createRange();range.selectNodeContents(row);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return {text:selection.toString(),content:row.textContent,select:getComputedStyle(row).userSelect};
  });
  assert.ok(selectedText.text.length>0,JSON.stringify(selectedText));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await outputRegion.evaluate(node=>node.scrollTop=node.scrollHeight);
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]').scrollTop>1000);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>document.getSelection().toString()),selectedText.text,'Selected output must survive row virtualization');
  const broadSelection=await page.evaluate(()=>{
    const rows=[...document.querySelectorAll('[data-output-row]')];
    const first=rows[0],last=rows.at(-1);
    const range=document.createRange();range.setStart(first,0);range.setEnd(last,last.childNodes.length);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const end=Number(last.dataset.outputRow);
    return {end,text:window.lastSnapshot.textChunks.slice(0,end+1).join('')};
  });
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await outputRegion.evaluate(node=>node.scrollTop=node.scrollHeight/2);
  assert.ok(broadSelection.end>150,'Fixture must span more than the 100-row viewport');
  await page.waitForFunction(()=>document.querySelectorAll('[data-output-row]').length<=113);
  assert.equal(await page.locator('[data-output-row="0"]').count(),1);
  assert.equal(await page.locator(`[data-output-row="${broadSelection.end}"]`).count(),1);
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async expected=>await navigator.clipboard.readText()===expected,broadSelection.text);
  await page.evaluate(()=>{document.getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  await page.locator('[data-output-row="0"]').waitFor({state:'detached'});
  await outputRegion.evaluate(node=>node.scrollTop=320);
  await outputRegion.press('PageDown');
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]').scrollTop>400);
  assert.equal(await outputRegion.evaluate(node=>document.activeElement===node),true);
  await page.evaluate(()=>window.showWideSearch());
  await page.getByText('输出匹配 1 / 2',{exact:true}).waitFor();
  await page.getByRole('button',{name:'下一处输出匹配',exact:true}).click();
  await page.waitForFunction(()=>{
    const host=document.querySelector('[data-blockterm-output]');
    const mark=host?.querySelector('mark[data-active-match]');
    if(!host||!mark) return false;
    const a=host.getBoundingClientRect(),b=mark.getBoundingClientRect();
    return host.scrollLeft>100 && b.left>=a.left-1 && b.right<=a.right+1;
  });
  await page.getByRole('button',{name:'上一处输出匹配',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]')?.scrollLeft===0);
  await page.getByRole('button',{name:'下一处输出匹配',exact:true}).click();
  await page.getByText('输出匹配 2 / 2',{exact:true}).waitFor();
  await page.evaluate(()=>window.showSearch(''));
  await page.waitForFunction(()=>!document.querySelector('mark'));
  await page.evaluate(()=>window.showSearch('TARGET'));
  await page.getByText('输出匹配 1 / 2',{exact:true}).waitFor({timeout:3000});
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]')?.scrollLeft===0);
  await page.evaluate(()=>window.showSearch(''));
  await page.waitForFunction(()=>!document.querySelector('#terminal mark'));
  await page.locator('[data-blockterm-output]').evaluate(node=>{node.scrollLeft=200;});
  const oldWideOutput=await page.locator('[data-blockterm-output]').elementHandle();
  await page.evaluate(()=>window.showSearch('','wide-remounted'));
  await page.waitForFunction(node=>!node.isConnected,oldWideOutput);
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]').scrollLeft===200);
  const searchResult=await page.evaluate(()=>window.testLiveSearch());
  const backgroundReplay=await page.evaluate(()=>window.testBackgroundEventReplay());
  assert.deepEqual(await page.evaluate(()=>window.testDisposedEngineReleasesHistory()),{before:[1,1,1],after:[0,0,0],current:null,textCache:null,frozen:null,retained:'NORMAL_HISTORY',styles:0});
  const styleSharing=await page.evaluate(()=>window.testSnapshotStyleSharing());
  assert.ok(styleSharing.rows>=1200);
  assert.ok(styleSharing.styles<=3,'Repeated terminal styles should share a bounded palette');
  assert.equal(styleSharing.shared,true);
  assert.equal(styleSharing.frozen,true);
  assert.equal(styleSharing.first,'line_0');
  assert.equal(styleSharing.last,true);
  assert.equal(styleSharing.cache,256,'Unique true-color output must not grow the style cache without bound');
  assert.deepEqual(await page.evaluate(()=>window.testCompletionCursorAttributes()),[{text:'AB',foreground:1},{text:'AB',foreground:1}]);
  assert.deepEqual(backgroundReplay.first,{text:'中文😀background',styled:'中文😀background',foreground:1,paste:false,blocks:1,cursor:backgroundReplay.count});
  assert.deepEqual(backgroundReplay.replay,backgroundReplay.first,'Fresh engine replay must preserve background text and terminal modes');
  assert.deepEqual(await page.evaluate(()=>window.testScreenSnapshotIsolation()),{
    reused:true,reusedAlternate:true,refreshed:true,resized:true,
    during:{normal:'NORMAL',normalStyled:'NORMAL',alternate:'ALTERNATE'},
    normal:'NORMAL',normalStyled:'NORMAL',alternate:'ALTERNATE',second:'SECOND'
  });
  assert.equal(searchResult.found,true);
  assert.deepEqual(searchResult.firstCount,{resultIndex:0,resultCount:2});
  assert.deepEqual(searchResult.secondCount,{resultIndex:1,resultCount:2});
  assert.deepEqual(searchResult.refreshedSecond,searchResult.second);
  assert.deepEqual(searchResult.firstBoundary,searchResult.first);
  assert.deepEqual(searchResult.lastBoundary,searchResult.second);
  assert.deepEqual(searchResult.firstBoundaryCount,{resultIndex:0,resultCount:2});
  assert.deepEqual(searchResult.lastBoundaryCount,{resultIndex:1,resultCount:2});
  assert.equal(searchResult.limited.resultCount,1000);
  assert.equal(searchResult.limitedLast.text,'LIMIT');
  assert.equal(searchResult.limitedFirst.text,'LIMIT');
  assert.deepEqual(searchResult.limitedLast.results,{resultIndex:-1,resultCount:1000});
  assert.deepEqual(searchResult.limitedFirst.results,{resultIndex:0,resultCount:1000});
  assert.ok(searchResult.limitedLast.position.start.y>searchResult.limitedFirst.position.start.y);
  assert.deepEqual(searchResult.boundarySteps,[
    {found:true,wrapped:true},
    {found:true,wrapped:false},
    {found:true,wrapped:false},
    {found:true,wrapped:true},
    {found:false,wrapped:false},
    {found:true,wrapped:false},
    {found:true,wrapped:true},
  ]);
  assert.equal(searchResult.markersAfterClear,0);
  assert.ok(searchResult.markersDuringSearch>0);
  assert.equal(searchResult.markersAfterDone,0);
  assert.equal(searchResult.markersAfterExit,0);
  assert.deepEqual(searchResult.delayedCleanup,Array.from({length:8},()=>({markers:0,selection:''})));
  assert.notDeepEqual(searchResult.first,searchResult.second);
  assert.deepEqual(searchResult.first,searchResult.previous);
  assert.equal(searchResult.missing,false);
  assert.equal(searchResult.appended,true);
  assert.equal(searchResult.selected,'APPENDED');
  assert.equal(searchResult.cleared,'');
  assert.deepEqual(searchResult.input,[]);
  const command='\nİi 中文\ne\u0301 界😀 <script>literal</script>';
  for(const [query,selected,marks,active] of [
    ['i',1,['İ','i','i','i','i'],['i']],
    ['中文',0,['中文'],['中文']],
    ['e\u0301',0,['e\u0301'],['e\u0301']],
    ['😀',0,['😀'],['😀']],
    ['<script>',0,['<script>'],['<script>']],
    ['missing',0,[],[]],
    ['',0,[],[]],
  ]) {
    const result=await page.evaluate(({command,query,selected})=>window.inspectCommand(command,query,selected),{command,query,selected});
    assert.deepEqual(result,{text:command,marks,active,scripts:0},'Command highlighting must preserve original Unicode and literal markup');
  }
  const linkURL='https://example.test/path';
  await page.evaluate(()=>window.readSnapshot('before https://exa\x1b[31mmple.test\x1b[0m/path after'));
  await page.evaluate(()=>window.showSearch('example','links'));
  await page.locator('[data-blockterm-output] a').first().waitFor();
  const links=await page.locator('[data-blockterm-output] a').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,href:node.href,rel:node.rel,target:node.target})));
  assert.ok(links.length>1,'Fixture must split the link across rows/styles');
  assert.equal(links.map(link=>link.text).join(''),linkURL);
  assert.ok(links.every(link=>link.href===linkURL&&link.rel==='noopener noreferrer'&&link.target==='_blank'));
  assert.equal(await page.getByRole('link',{name:linkURL,exact:true}).count(),links.length,'Every wrapped fragment must expose the complete accessible link name');
  assert.ok(await page.locator('[data-blockterm-output] a').evaluateAll(nodes=>nodes.every(node=>node.title===node.getAttribute('href'))));
  assert.equal(await page.locator('[data-blockterm-output] a mark').allTextContents().then(parts=>parts.join('')),'example');
  const linkDrag=await page.locator('[data-blockterm-output] a').evaluateAll(nodes=>{
    const first=nodes[0].getBoundingClientRect(),last=nodes.at(-1).getBoundingClientRect();
    return {x:first.left+0.5,y:first.y+first.height/2,endX:last.right-0.5,endY:last.y+last.height/2};
  });
  await page.mouse.move(linkDrag.x,linkDrag.y);
  await page.mouse.down();
  await page.mouse.move(linkDrag.endX,linkDrag.endY,{steps:16});
  await page.mouse.up();
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async expected=>await navigator.clipboard.readText()===expected,linkURL);
  const selectionGuard=await page.locator('[data-blockterm-output] a').first().evaluate(node=>{
    const range=document.createRange();range.selectNodeContents(node);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
    const event=new MouseEvent('click',{bubbles:true,cancelable:true});node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(selectionGuard,true,'Selected link text must not navigate on release');
  await page.evaluate(()=>document.getSelection().removeAllRanges());
  await page.context().route('https://example.test/**',route=>route.fulfill({contentType:'text/plain',body:'local link fixture'}));
  const popupPromise=page.context().waitForEvent('page');
  await page.locator('[data-blockterm-output] a').first().click();
  const popup=await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(),linkURL);
  assert.equal(await popup.evaluate(()=>window.opener===null),true);
  await popup.close();
  await page.evaluate(()=>window.readSnapshot('https://example.test/focus\r\n'+'line\r\n'.repeat(220)));
  await page.evaluate(()=>window.showSearch('','focused-link'));
  const focusedLink=page.locator('[data-output-row="0"] a');
  await focusedLink.waitFor();
  await page.getByRole('region',{name:'命令输出滚动区',exact:true}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await focusedLink.evaluate(node=>document.activeElement===node),true,'Tab must reach the first output link');
  await page.locator('[data-blockterm-output]').evaluate(node=>node.scrollTop=node.scrollHeight);
  await page.waitForFunction(()=>document.querySelector('[data-blockterm-output]').scrollTop>1000);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await focusedLink.evaluate(node=>document.activeElement===node),true,'Scrolling must retain the focused link row');
  assert.ok(await page.locator('[data-output-row]').count()<=113,'Focus must retain only one extra row');
  await page.getByRole('region',{name:'命令输出滚动区',exact:true}).focus();
  await page.locator('[data-output-row="0"]').waitFor({state:'detached'});
  for(const terminator of ['\x07','\x1b\\']) {
    const label='查看 中文😀 e\u0301 报告';
    const destination='https://example.test/report';
    await page.evaluate(({terminator,label,destination})=>window.readSnapshot(`\x1b]8;;${destination}${terminator}${label.replace('中文','\x1b[31m中文\x1b[0m')}\x1b]8;;${terminator} plain`),{terminator,label,destination});
    await page.evaluate(()=>window.showSearch('中文','osc-link'));
    await page.getByRole('link',{name:destination,exact:true}).first().waitFor();
    const labels=await page.locator('[data-blockterm-output] a').allTextContents();
    assert.equal(labels.join(''),label,'OSC link cells must preserve Unicode, wrapping and the exact closing boundary');
    assert.equal(await page.locator('[data-blockterm-output] a mark').allTextContents().then(parts=>parts.join('')),'中文');
  }
  await page.evaluate(()=>window.readSnapshot('\x1b]8;;javascript:alert(1)\x07UNSAFE_LABEL\x1b]8;;\x07'));
  await page.evaluate(()=>window.showSearch('','unsafe-osc-link'));
  await page.getByRole('region',{name:'命令输出滚动区',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-blockterm-output] a'));
  const casing=await page.evaluate(async()=>{
    const {lowercaseChunks,chunkMatches}=await import('/src/components/blockterm/chunk-search.ts');
    const results=[];
    for(const text of ['AΣ\u0345','\u0345Σ','AΣ\u0345B','ΟΣ ΟΣΑ','\u{10400}Σİ']) {
      for(let split=0;split<=text.length;split++)
        results.push({expected:text.toLowerCase(),actual:[...lowercaseChunks([text.slice(0,split),'',text.slice(split)])].join('')});
      results.push({expected:text.toLowerCase(),actual:[...lowercaseChunks(text.split(''))].join('')});
    }
    const longQuery='a'.repeat(300)+'B';
    results.push({expected:'[[0,301],[301,602]]',actual:JSON.stringify([...chunkMatches((longQuery+longQuery).split(''),longQuery)])});
    return results;
  });
  for(const result of casing) assert.equal(result.actual,result.expected,'browser Unicode chunk normalization');
  assert.deepEqual(errors,[]);
  console.log('real xterm snapshots preserve soft-wrap spaces, wide glyphs, combining text and hard line breaks');
} finally {await browser.close();}
