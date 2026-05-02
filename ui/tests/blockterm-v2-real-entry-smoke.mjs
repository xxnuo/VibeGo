import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Opt-in: opens a real, disposable PTY through the application UI.
const base=process.env.BLOCKTERM_REAL_ENTRY_URL;
if(!base) throw Error('Set BLOCKTERM_REAL_ENTRY_URL to an approved development instance');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
let created=false;
let sessionId;
const pageErrors=[];
const terminalWrites=[];
page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/input')) terminalWrites.push(Buffer.from(request.postDataJSON().data,'base64').toString());});
const connections=new Map();
page.on('websocket',socket=>{
  const match=new URL(socket.url()).pathname.match(/\/sessions\/([^/]+)\/events$/);
  if(match) connections.set(match[1],(connections.get(match[1])||0)+1);
});
page.on('pageerror',error=>pageErrors.push(error.message));
try {
  await page.goto(base,{waitUntil:'networkidle'});
  await page.locator('[data-blockterm-core]').waitFor();
  assert.equal(await page.locator('[data-blockterm-local-toolbar]').count(),0,'The real page must use the shared frame toolbar');
  assert.equal(await page.locator('[data-blockterm-session-controls]').count(),1);
  assert.equal(await page.locator('[data-blockterm-core] [data-blockterm-session-controls]').count(),0,'Session navigation must not duplicate the frame navigation');
  const creation=page.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname==='/api/blockterm/v2/sessions');
  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  const response=await creation;
  assert.ok(response.ok());
  const initial=await response.json();
  sessionId=initial.id;
  assert.ok(sessionId);
  created=true;
  const input=page.getByRole('textbox',{name:'命令输入',exact:true});
  const ready=()=>page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node&&!node.disabled;});
  await ready();
  assert.equal(await page.getByRole('combobox',{name:'终端会话',exact:true}).inputValue(),sessionId);
  await input.fill('ls /tm');
  await page.getByRole('button',{name:'Shell 补全',exact:true}).click();
  assert.equal(await input.evaluate(node=>document.activeElement===node),true);
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="命令输入"]')?.value==='ls /tmp/');
  await page.getByText('路径补全 · /tmp/',{exact:true}).waitFor();
  await input.press('Escape');
  await page.screenshot({path:'/tmp/vibego-real-entry-paths.png',animations:'disabled'});
  await input.fill('git st');
  const promptBeforeCompletion=await input.boundingBox();
  await input.press('Tab');
  await page.getByRole('listbox',{name:'命令补全候选',exact:true}).getByRole('option').first().waitFor();
  const promptWithCompletion=await input.boundingBox();
  assert.ok(Math.abs(promptWithCompletion.y-promptBeforeCompletion.y)<2,'Completion must not push the prompt');
  const completionBounds=await page.locator('[data-completion-overlay]').boundingBox();
  const viewport=page.viewportSize();
  assert.ok(completionBounds.x>=0 && completionBounds.y>=0 && completionBounds.x+completionBounds.width<=viewport.width && completionBounds.y+completionBounds.height<=viewport.height,'Completion stays inside the viewport');
  assert.equal(await input.inputValue(),'git sta');
  await input.pressSequentially('t');
  await page.waitForFunction(()=>document.querySelector('[role="listbox"][aria-label="命令补全候选"]')?.querySelectorAll('[role="option"]').length===1);
  await page.screenshot({path:'/tmp/vibego-real-entry-command-completion.png',animations:'disabled'});
  await input.press('Enter');
  assert.equal(await input.inputValue(),'git status ');
  assert.equal(await page.locator('section[data-block-id]').count(),0,'Accepting a command suggestion must not run it');
  await input.fill("printf 'VIBEGO_REAL_ENTRY_OK\\n'; false");
  await page.getByRole('button',{name:'执行命令',exact:true}).click();
  await page.getByText('VIBEGO_REAL_ENTRY_OK',{exact:true}).first().waitFor();
  await ready();
  for(const width of [320,1280]) {
    await page.setViewportSize({width,height:844});
    await page.waitForFunction(()=>{
      const output=document.querySelector('[data-blockterm-scroll]')?.getBoundingClientRect();
      const editor=document.querySelector('[data-terminal-input-area]')?.getBoundingClientRect();
      return output && editor && output.height<240 && Math.abs(editor.top-output.bottom)<2;
    });
    assert.ok(await page.locator('[data-blockterm-core] .xterm-screen').evaluate(node=>node.getBoundingClientRect().height>240),'A short transcript must not shrink the PTY grid to transcript height');
    await page.screenshot({path:`/tmp/vibego-real-entry-flow-${width}.png`,animations:'disabled'});
  }
  const completed=page.locator('section[data-block-id]').filter({hasText:'VIBEGO_REAL_ENTRY_OK'});
  const blockCount=await page.locator('section[data-block-id]').count();
  await page.setViewportSize({width:1280,height:844});
  await completed.getByRole('button',{name:'命令块操作',exact:true}).click();
  const blockMenu=page.getByRole('dialog',{name:'命令块操作',exact:true});
  await blockMenu.waitFor();
  assert.equal(await blockMenu.getAttribute('data-slot'),'popover-content');
  await page.screenshot({path:'/tmp/vibego-real-entry-block-menu.png',animations:'disabled'});
  await blockMenu.getByRole('button',{name:'编辑命令',exact:true}).click();
  await blockMenu.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='命令输入');
  assert.equal(await input.inputValue(),"printf 'VIBEGO_REAL_ENTRY_OK\\n'; false");
  assert.equal(await page.locator('section[data-block-id]').count(),blockCount,'Block menu editing must not execute');
  await completed.getByRole('button',{name:'命令块操作',exact:true}).click();
  await blockMenu.getByRole('button',{name:'在此块中查找',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='搜索命令和输出');
  const scopedSearch=page.getByRole('textbox',{name:'搜索命令和输出',exact:true});
  await scopedSearch.fill('VIBEGO_REAL_ENTRY_OK');
  await page.locator('[data-search-scope]').waitFor();
  assert.equal(await page.locator('section[data-block-id]').count(),1);
  for(const width of [320,1280]) {
    await page.setViewportSize({width,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.getByRole('button',{name:'下一个匹配块',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'下一处输出匹配',exact:true}).count(),0);
    await page.screenshot({path:`/tmp/vibego-real-entry-block-search-${width}.png`,animations:'disabled'});
  }
  await page.getByRole('button',{name:'搜索全部块',exact:true}).click();
  await scopedSearch.press('Enter');
  await page.getByText('内容匹配 1 / 2',{exact:true}).waitFor();
  await scopedSearch.press('Enter');
  await page.getByText('内容匹配 2 / 2',{exact:true}).waitFor();
  assert.equal(await page.locator('section[data-block-id]').count(),1,'Enter must visit command and output matches in the same block');
  for(const width of [320,1280]) {
    await page.setViewportSize({width,height:844});
    const navigation=page.locator('[data-search-navigation]');
    assert.equal(await navigation.count(),1);
    assert.ok((await navigation.boundingBox()).height<=48,'Search navigation must fit one compact toolbar');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`/tmp/vibego-real-entry-global-search-${width}.png`,animations:'disabled'});
  }
  await scopedSearch.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('[data-search-scope]'));
  await page.setViewportSize({width:390,height:844});
  await input.fill("printf 'VIBEGO_REAL_ENTRY_");
  await page.locator('[data-inline-history-suggestion]').waitFor();
  for(const width of [320,1280]) {
    await page.setViewportSize({width,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`/tmp/vibego-real-entry-input-${width}.png`,animations:'disabled'});
  }
  await page.setViewportSize({width:390,height:844});
  await input.fill("printf 'VIBEGO_RUNNING_OK\\n'; sleep 30");
  await page.getByRole('button',{name:'执行命令',exact:true}).click();
  await page.locator('[data-running-command]').waitFor();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="终端会话"] option:checked')?.textContent.includes('运行中'));
  const running=page.locator('section[data-block-id]').filter({hasText:'VIBEGO_RUNNING_OK'});
  await running.getByRole('button',{name:'折叠输出',exact:true}).click();
  await page.waitForFunction(()=>!!document.querySelector('[data-live-viewport]').closest('[inert]'));
  await page.screenshot({path:'/tmp/vibego-real-entry-folded.png',animations:'disabled'});
  await page.getByRole('button',{name:'返回正在运行的终端',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.getByRole('button',{name:'中断',exact:true}).click();
  await ready();
  await page.getByText('VIBEGO_RUNNING_OK',{exact:true}).first().waitFor();
  if(process.env.BLOCKTERM_REAL_VIM==='1') {
    await input.fill('/usr/bin/vim -Nu NONE -n -i NONE');
    await page.getByRole('button',{name:'执行命令',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-blockterm-scroll]')?.dataset.alternateScreen==='true');
    for(const width of [320,1280]) {
      await page.setViewportSize({width,height:844});
      await page.waitForFunction(()=>{
        const area=document.querySelector('[data-blockterm-scroll]')?.getBoundingClientRect();
        const screen=document.querySelector('.xterm-screen')?.getBoundingClientRect();
        return area&&screen&&screen.width>=area.width-40&&screen.height>=area.height-40&&screen.top>=area.top&&screen.bottom<=area.bottom+1&&screen.right<=area.right+1;
      });
      await page.screenshot({path:`/tmp/vibego-real-entry-vim-${width}.png`,animations:'disabled'});
    }
    const terminalInput=page.locator('.xterm-helper-textarea');
    const writesBeforeHistory=terminalWrites.length;
    await page.getByRole('button',{name:'下一条失败命令',exact:true}).click();
    await page.getByRole('button',{name:'返回全屏程序',exact:true}).waitFor();
    await page.getByText('VIBEGO_REAL_ENTRY_OK',{exact:true}).first().waitFor();
    await page.getByRole('button',{name:'返回全屏程序',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-blockterm-scroll]')?.dataset.alternateScreen==='true');
    await page.getByRole('button',{name:'查看历史输出',exact:true}).click();
    await page.getByRole('button',{name:'返回全屏程序',exact:true}).waitFor();
    await page.screenshot({path:'/tmp/vibego-real-entry-vim-history.png',animations:'disabled'});
    await page.getByRole('button',{name:'返回正在运行的终端',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
    await terminalInput.press('Control+Shift+F');
    const search=page.getByRole('textbox',{name:'搜索命令和输出',exact:true});
    await search.fill('VIBEGO_REAL_ENTRY_OK');
    await page.getByText('VIBEGO_REAL_ENTRY_OK',{exact:true}).first().waitFor();
    await search.press('Escape');
    await page.waitForFunction(()=>document.querySelector('[data-blockterm-scroll]')?.dataset.alternateScreen==='true'&&document.activeElement?.classList.contains('xterm-helper-textarea'));
    assert.deepEqual(terminalWrites.slice(writesBeforeHistory).filter(data=>!/^\x1b\[[IO]$/.test(data)),[],'History navigation and search may send focus reports, but never command input to Vim');
    await terminalInput.press('Escape');
    await terminalInput.pressSequentially(':q!');
    await terminalInput.press('Enter');
    await ready();
    assert.equal(await page.locator('[data-alternate-screen]').count(),0);
    await page.getByText('VIBEGO_RUNNING_OK',{exact:true}).first().waitFor();
    await page.setViewportSize({width:390,height:844});
  }
  await input.fill('cd /tmp');
  await page.getByRole('button',{name:'执行命令',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-command-context]')?.textContent.includes('/tmp'));
  await page.waitForFunction(()=>document.querySelector('select[aria-label="终端会话"] option:checked')?.textContent.includes('/tmp'));
  await ready();
  assert.equal(connections.get(sessionId),1,'Session label updates must not reconnect the active terminal');
  await page.getByRole('button',{name:'结束会话',exact:true}).click();
  await page.getByPlaceholder('会话已结束',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="终端会话"] option:checked')?.textContent.includes('已结束'));
  created=false;
  await page.setViewportSize({width:320,height:844});
  await page.screenshot({path:'/tmp/vibego-real-entry-ended.png',animations:'disabled'});
  const previousId=sessionId;
  const restart=page.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname==='/api/blockterm/v2/sessions');
  await page.getByRole('button',{name:'在此目录新建终端',exact:true}).click();
  const restarted=await restart;
  assert.ok(restarted.ok());
  const replacement=await restarted.json();
  sessionId=replacement.id;
  created=true;
  assert.notEqual(sessionId,previousId);
  assert.equal(replacement.cwd,'/tmp');
  assert.equal(replacement.shell,initial.shell);
  await ready();
  assert.equal(await input.inputValue(),'');
  assert.equal(await page.locator('section[data-block-id]').count(),0,'New session must not replay historical commands');
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({base,sessionId,viewports:[320,390,1280],realCommand:true,historyGhost:true,foldReveal:true,interrupt:true,recreateInCwd:true,pageErrors}));
} finally {
  try {
    if(created) {
      assert.equal(await page.getByRole('combobox',{name:'终端会话',exact:true}).inputValue(),sessionId,'Only close the session created by this test');
      await page.getByRole('button',{name:'结束会话',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('textarea[aria-label="命令输入"]')?.placeholder==='会话已结束');
      console.log('Created test session ended; history retained.');
    }
  } finally {await browser.close();}
}
