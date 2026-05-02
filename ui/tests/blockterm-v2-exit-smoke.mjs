import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base=process.env.BLOCKTERM_URL||'https://127.0.0.1:11984';
const browser=await chromium.launch();
try {
  for (const phase of ['exited','editing']) {
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const session={id:'exited',group_id:'exited',shell:'bash',cwd:'/tmp',phase,cols:44,rows:24,seq:259};
  const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64');
  const block={id:'last',session_id:session.id,kind:'command',command:'final output',status:'running',created_at:1};
  const events=[];
  const push=(type,data)=>events.push({session_id:session.id,block_id:block.id,seq:events.length+1,type,data:encode(data)});
  push('block',block);
  for(let i=0;i<256;i++) push('output',`EXIT_ROW_${i}\r\n`);
  push('block',{...block,status:'done',exit_code:0,finished_at:2});
  push('state',{...session,phase:'exited'});
  let connections=0;
  const acknowledgements=[];
  await page.route('**/api/blockterm/v2/**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/sessions')?{sessions:[session]}:{blocks:[],has_more:false}}));
  await page.routeWebSocket('**/events?*',socket=>{
    connections++;
    let end=0;
    const send=()=>{
      const start=end;
      end=Math.min(end+128,events.length);
      socket.send(JSON.stringify(events.slice(start,end)));
    };
    socket.onMessage(raw=>{
      const {ack}=JSON.parse(raw);
      acknowledgements.push(ack);
      if(ack===end&&end<events.length) send();
    });
    socket.send(JSON.stringify([{session_id:session.id,type:'hello',seq:events.length,data:''}]));
    send();
  });
  await page.route('**/blockterm-exit',route=>route.fulfill({contentType:'text/html',body:`
    <html><body><div id="test" style="height:100dvh"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const React=(await import('${process.env.BLOCKTERM_VITE_DEPS||'/node_modules/.vite/deps'}/react.js')).default;
    const {createRoot}=(await import('${process.env.BLOCKTERM_VITE_DEPS||'/node_modules/.vite/deps'}/react-dom_client.js')).default;
    await import('/src/index.css');
    const {default:Page}=await import('/src/components/blockterm/page.tsx');
    createRoot(document.getElementById('test')).render(React.createElement(Page,{groupId:'exited'}));
    </script></body></html>`}));
  await page.goto(`${base}/blockterm-exit`);
  await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('EXIT_ROW_255');
  await page.locator('[data-block-id="last"]').getByText('EXIT_ROW_255',{exact:true}).waitFor().catch(async error=>{
    console.error(JSON.stringify({phase,errors,acknowledgements,body:await page.locator('body').innerText()}));
    throw error;
  });
  assert.deepEqual(acknowledgements,[0,128,256,259]);
  await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('EXIT_ROW_0');
  await page.locator('[data-block-id="last"]').getByText('EXIT_ROW_0',{exact:true}).waitFor();
  assert.equal(await page.getByPlaceholder('会话已结束',{exact:true}).isDisabled(),true);
  const terminalInput=page.locator('.xterm-helper-textarea');
  assert.equal(await terminalInput.evaluate(node=>!!node.closest('[inert][aria-hidden="true"]')),true);
  await terminalInput.evaluate(node=>node.focus());
  assert.equal(await terminalInput.evaluate(node=>node===document.activeElement),false);
  await page.waitForTimeout(1500);
  assert.equal(connections,1);
  assert.deepEqual(errors,[]);
  console.log('exited session replays all three ACK-gated batches and preserves first/last output');
  await page.close();
  }
} finally {await browser.close();}
