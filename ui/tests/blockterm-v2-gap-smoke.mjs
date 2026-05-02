import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const base=process.env.BLOCKTERM_URL||'https://127.0.0.1:11984';
const browser=await chromium.launch();
try {
  for (const [phase,width] of [['running',390],['editing',320]]) {
    const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width,height:844}});
    const errors=[],inputs=[];
    page.on('pageerror',error=>errors.push(error.message));
    const session={id:'gap',group_id:'gap',shell:'bash',cwd:'/tmp',phase,cols:40,rows:24,seq:2};
    const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64');
    const events=[
      {session_id:'gap',type:'state',seq:1,data:encode(session)},
      {session_id:'gap',type:'terminal',seq:2,data:encode('RETAINED_OUTPUT\r\n')},
    ];
    let socket,ack=0;
    await page.route('**/api/blockterm/v2/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path.endsWith('/input')) inputs.push(Buffer.from(route.request().postDataJSON().data,'base64').toString());
      return route.fulfill({json:path.endsWith('/sessions')?{sessions:[session]}:{ok:true,blocks:[],has_more:false}});
    });
    await page.routeWebSocket('**/events?*',connection=>{
      socket=connection;
      connection.onMessage(raw=>{ack=JSON.parse(raw).ack;});
      connection.send(JSON.stringify([{session_id:'gap',type:'hello',seq:events.length,data:encode(session)},...events]));
    });
    await page.route('**/blockterm-gap',route=>route.fulfill({contentType:'text/html',body:`
      <html><body><div id="test" style="height:100dvh"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      const React=(await import('${process.env.BLOCKTERM_VITE_DEPS||'/node_modules/.vite/deps'}/react.js')).default;
      const {createRoot}=(await import('${process.env.BLOCKTERM_VITE_DEPS||'/node_modules/.vite/deps'}/react-dom_client.js')).default;
      await import('/src/index.css');
      const {default:Page}=await import('/src/components/blockterm/page.tsx');
      createRoot(document.getElementById('test')).render(React.createElement(Page,{groupId:'gap'}));
      </script></body></html>`}));
    await page.goto(`${base}/blockterm-gap`);
    const terminal=page.locator('.xterm-helper-textarea');
    await page.waitForFunction(()=>document.querySelector('.xterm-helper-textarea')?.readOnly===false);
    await terminal.press('a');
    await expect.poll(()=>inputs.length).toBe(1);
    assert.deepEqual(inputs,['a']);
    const notice=page.getByText('显示保护已忽略超长字形或控制序列；已保存的原始输出未被此保护改写。',{exact:true});
    assert.equal(await notice.count(),0);
    const projection={session_id:'gap',type:'terminal',seq:3,data:encode('e'+'\u0301'.repeat(300)+'\r\n')};
    events.push(projection);
    socket.send(JSON.stringify([projection]));
    await notice.waitFor();
    assert.equal(await terminal.evaluate(node=>node.readOnly),false,'display protection must not stop observable input');
    assert.equal(await page.getByRole('button',{name:'EOF',exact:true}).isDisabled(),false);
    await terminal.press('b');
    await expect.poll(()=>inputs.length).toBe(2);
    const gap={session_id:'gap',type:'gap',seq:4,data:encode('output quota exceeded')};
    events.push(gap);
    socket.send(JSON.stringify([gap]));
    await page.getByText('输出记录已停止，当前画面不再更新。仅可中断程序或关闭会话；已记录内容仍可搜索和复制。',{exact:true}).waitFor();
    assert.equal(await terminal.evaluate(node=>node.readOnly),true);
    assert.equal(await page.getByRole('button',{name:'EOF',exact:true}).isDisabled(),true);
    await terminal.press('b');
    await terminal.press('Enter');
    await page.waitForTimeout(100);
    assert.deepEqual(inputs,['a','b']);
    await terminal.press('Control+c');
    await page.getByRole('button',{name:'中断',exact:true}).click();
    await expect.poll(()=>inputs.length).toBe(4);
    assert.deepEqual(inputs,['a','b','\x03','\x03']);
    await page.reload();
    await notice.waitFor();
    await page.getByText('输出记录已停止，当前画面不再更新。仅可中断程序或关闭会话；已记录内容仍可搜索和复制。',{exact:true}).waitFor();
    assert.equal(await terminal.evaluate(node=>node.readOnly),true);
    socket.send(JSON.stringify([{session_id:'gap',type:'state',seq:5,data:encode({...session,phase:'ready',error:''})}]));
    await expect.poll(()=>ack).toBe(5);
    if(phase==='running') {
      await page.getByRole('textbox',{name:'命令输入',exact:true}).waitFor();
      assert.equal(await page.getByRole('textbox',{name:'命令输入',exact:true}).isDisabled(),true);
    } else {
      assert.equal(await terminal.evaluate(node=>node.readOnly),true);
      assert.equal(await page.getByRole('button',{name:'EOF',exact:true}).isDisabled(),true);
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('output gaps disable blind terminal input, retain interrupts and survive replay/state changes');
} finally {await browser.close();}
