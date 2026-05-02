import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const base = process.env.BLOCKTERM_URL || "https://127.0.0.1:11984";
const browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC"] });
const errors = [];
try {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.route('**/src/components/blockterm/engine.ts*',async route=>{
      const response=await route.fetch();
      const source=await response.text();
      assert.ok(source.includes('async apply(event) {'));
      await route.fulfill({response,body:source.replace('async apply(event) {','async apply(event) { window.testTerminal=this.terminal;')});
    });
    page.on('response',response=>{if(response.status()>=400) errors.push(`HTTP ${response.status()} ${response.url()}`);});
    page.on("pageerror", (error) => {errors.push(error.message); console.error(error.message)});
    page.on("console", (item) => { if(item.type()==="error") { errors.push(item.text()); console.error(item.text()); } });
    const group = `core-smoke-${crypto.randomUUID()}`;
    await page.route("**/blockterm-test", (route) => route.fulfill({ contentType: "text/html", body: `
      <html><head></head><body><div id="test" style="height:100dvh"></div>
      <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
      window.__vite_plugin_react_preamble_installed__=true;
      const React=(await import('/node_modules/.vite/deps/react.js')).default;
      const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      await import('/src/index.css');
      const {default:Page}=await import('/src/components/blockterm/page.tsx');
      createRoot(document.getElementById('test')).render(React.createElement(Page,{groupId:${JSON.stringify(group)}}));
      </script></body></html>` }));
    await page.goto(`${base}/blockterm-test`);
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    const input = page.getByRole("textbox", { name: "命令输入", exact: true });
    await input.waitFor();
    await page.waitForFunction(() => { const node = document.querySelector('textarea[aria-label="命令输入"]'); return node && !node.disabled; });
    const run = async (command) => {
      await input.fill(command);
      await page.getByRole("button", { name: "执行命令", exact: true }).click();
      await page.waitForFunction(() => {const node=document.querySelector('textarea[aria-label="命令输入"]');return node && !node.disabled && node.value==='';}).catch(async error=>{
        console.error({command,errors,view:await page.locator('[data-blockterm-core]').innerText()});
        throw error;
      });
    };
    await run("export LC_ALL=C VG_CORE_SMOKE=retained; cd /tmp");
    const rapidInputs=[];
    const observeInput=request=>{
      if(new URL(request.url()).pathname.endsWith('/input')) rapidInputs.push(request.postDataJSON().data);
    };
    page.on('request',observeInput);
    for(let index=0;index<12;index++) {
      await run("VG_RAPID_COUNT=$(( ${VG_RAPID_COUNT:-0} + 1 )); printf 'RAPID_%s\\n' \"$VG_RAPID_COUNT\"");
      await page.getByText(`RAPID_${index+1}`,{exact:true}).first().waitFor();
      await page.waitForFunction(()=>document.activeElement===document.querySelector('textarea[aria-label="命令输入"]'));
    }
    page.off('request',observeInput);
    assert.deepEqual(rapidInputs,[],'Command buttons must not send terminal control bytes');
    await input.fill("sleep 1; printf 'FOCUS_DONE\\n'");
    await page.getByRole('button',{name:'执行命令',exact:true}).click();
    const retainedSearch=page.getByRole('textbox',{name:'搜索命令和输出'});
    await retainedSearch.focus();
    await page.getByText('FOCUS_DONE',{exact:true}).first().waitFor();
    await page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node&&!node.disabled;});
    assert.equal(await retainedSearch.evaluate(node=>document.activeElement===node),true,'Completion must not steal search focus');
    await input.fill("printf 'SEARCH_HEAD\\n'; for i in {1..160}; do printf 'search_row_%s\\n' \"$i\"; done; printf 'SEARCH_READY\\n'; IFS= read -r answer; printf 'SEARCH_INPUT_%s\\n' \"$answer\"");
    await page.getByRole('button',{name:'执行命令',exact:true}).click();
    await page.getByText('SEARCH_READY',{exact:true}).waitFor().catch(async error=>{
      console.error({width,errors,view:await page.locator('[data-blockterm-core]').innerText()});
      throw error;
    });
    const liveInput=page.locator('.xterm-helper-textarea');
    await liveInput.press('Control+Shift+F');
    const liveSearch=page.getByRole('textbox',{name:'搜索命令和输出'});
    await liveSearch.fill('SEARCH_HEAD');
    await page.getByText('实时输出：已定位匹配',{exact:true}).waitFor();
    await page.waitForFunction(()=>{
      const terminal=window.testTerminal,buffer=terminal.buffer.active;
      return buffer.baseY>100 && buffer.viewportY<buffer.baseY && terminal.getSelection()==='SEARCH_HEAD';
    });
    await page.getByRole('button',{name:'回到最新输出',exact:true}).click();
    await page.waitForFunction(()=>{
      const terminal=window.testTerminal,buffer=terminal.buffer.active;
      return buffer.baseY>100 && buffer.viewportY===buffer.baseY && terminal.getSelection()==='';
    });
    assert.equal(await liveSearch.inputValue(),'');
    await liveInput.press('O');
    await liveInput.press('K');
    await liveInput.press('Enter');
    await page.getByText('SEARCH_INPUT_OK',{exact:true}).first().waitFor();
    await page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node && !node.disabled;});
    await run("printf '\\033[32mCORE_%s\\033[0m\\n' \"$VG_CORE_SMOKE\"");
    await page.getByText("CORE_retained", { exact: true }).first().waitFor();
    await input.fill("printf 'NATIVE_OK\\n'");
    await input.press("Tab");
    await page.locator('.xterm-helper-textarea').last().focus();
    await page.keyboard.press('Enter');
    await page.getByText('NATIVE_OK',{exact:true}).first().waitFor();
    await page.waitForFunction(()=>{
      const input=document.querySelector('textarea[aria-label="命令输入"]');
      return input && !input.disabled && document.activeElement===input;
    }).catch(async error=>{console.error(await page.evaluate(()=>({active:document.activeElement?.outerHTML,composer:document.querySelector('textarea[aria-label="命令输入"]')?.outerHTML,phase:window.testTerminal?.buffer.active.type})));throw error;});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `../temp/blockterm-core-${width}.png` });
    await page.reload();
    await page.waitForFunction(() => { const node = document.querySelector('textarea[aria-label="命令输入"]'); return node && !node.disabled; }, null, { timeout: 20000 });
    await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('CORE_retained');
    try {
      await page.getByText("CORE_retained", { exact: true }).first().waitFor();
    } catch (error) {
      await page.screenshot({path:`../temp/blockterm-reload-failure-${width}.png`});
      console.error(await page.locator('[data-blockterm-core]').innerText());
      throw error;
    }
    await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('');
    await input.fill("printf '\\033[?1049hTUI_TEST'; read -r line; printf '\\033[?1049lDONE_%s\\n' \"$line\"");
    await page.getByRole("button", {name:"执行命令",exact:true}).click();
    await page.getByText("TUI_TEST",{exact:true}).waitFor();
    await page.locator('.xterm-helper-textarea').last().focus();
    await page.keyboard.type('interactive');
    await page.keyboard.press('Enter');
    await page.getByText('DONE_interactive',{exact:true}).first().waitFor();
    const historySearch=page.getByRole('textbox',{name:'搜索命令和输出'});
    await historySearch.fill('TUI_TEST');
    const alternateHistory=page.getByText('全屏程序最后画面',{exact:true}).locator('..');
    await alternateHistory.waitFor();
    assert.ok((await alternateHistory.locator('[data-blockterm-output]').innerText()).includes('TUI_TEST'));
    await page.reload();
    await page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node && !node.disabled;});
    await historySearch.fill('TUI_TEST');
    await alternateHistory.waitFor();
    assert.ok((await alternateHistory.locator('[data-blockterm-output]').innerText()).includes('TUI_TEST'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await historySearch.fill('');
    if (process.env.BLOCKTERM_TUI_SMOKE === '1') {
      await input.fill("for i in {0..199}; do printf 'PAGER_%03d\\n' \"$i\"; done | LESS= LESSOPEN= LESSCLOSE= LESSHISTFILE=- less");
      await page.getByRole('button',{name:'执行命令',exact:true}).click();
      const terminal=page.locator('.xterm');
      await terminal.getByText('PAGER_000',{exact:true}).waitFor();
      await terminal.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press('Space');
      await terminal.getByText('PAGER_040',{exact:true}).waitFor();
      await page.keyboard.type('/PAGER_180');
      await page.keyboard.press('Enter');
      await terminal.getByText('PAGER_181',{exact:true}).waitFor();
      await page.keyboard.press('q');
      await page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node&&!node.disabled;});
      assert.equal(await terminal.evaluate(node=>!!node.closest('[inert]')),true);
      await historySearch.fill('PAGER_181');
      await alternateHistory.waitFor();
      assert.ok((await alternateHistory.locator('[data-blockterm-output]').innerText()).includes('PAGER_181'));
      await historySearch.fill('');
      await run("printf 'AFTER_BROWSER_LESS\\n'");
      await page.getByText('AFTER_BROWSER_LESS',{exact:true}).first().waitFor();
      await input.fill("vim -Nu NONE -i NONE -n --cmd 'set encoding=utf-8' -c \"call setline(1, 'VIM_READY')\"");
      await page.getByRole('button',{name:'执行命令',exact:true}).click();
      await terminal.getByText('VIM_READY',{exact:true}).waitFor();
      await terminal.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type('ggO');
      await page.keyboard.type('VIM_BROWSER_');
      await page.keyboard.insertText('中文');
      await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent.includes('VIM_BROWSER_中文')).catch(async error=>{
        console.error(await terminal.innerText());
        throw error;
      });
      await page.keyboard.press('Escape');
      await page.keyboard.type(':q!');
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node&&!node.disabled;});
      assert.equal(await terminal.evaluate(node=>!!node.closest('[inert]')),true);
      await historySearch.fill('VIM_BROWSER_中文');
      await alternateHistory.waitFor();
      assert.ok((await alternateHistory.locator('[data-blockterm-output]').innerText()).includes('VIM_BROWSER_中文'));
      await historySearch.fill('');
      await run("printf 'AFTER_BROWSER_VIM\\n'");
      await page.getByText('AFTER_BROWSER_VIM',{exact:true}).first().waitFor();
    }
    await run(')');
    await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('syntax error');
    await page.getByText(/syntax error/).first().waitFor();
    await page.getByText('未执行',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('');
    await run("for i in {1..300}; do printf 'long_%s\\n' \"$i\"; done");
    await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('long_300');
    await page.getByText('long_300',{exact:true}).first().waitFor();
    await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('');
    await run("head -c 1200000 /dev/zero; printf 'RAW_DOWNLOAD\\000\\377\\033[32m中文\\033[0m\\n'");
    const rawBlock = page.locator('section[data-block-id]').filter({ has: page.getByText(/RAW_DOWNLOAD/, { exact: false }) }).last();
    const blockId = await rawBlock.getAttribute('data-block-id');
    assert.ok(blockId);
    await expect.poll(()=>page.evaluate(async ({group,blockId})=>{
      const {coreApi}=await import('/src/components/blockterm/api.ts');
      const {sessions}=await coreApi.list(group);
      if(sessions.length!==1) return false;
      const {blocks}=await coreApi.blocks(sessions[0].id);
      return blocks.some(block=>block.id===blockId&&block.status==='done');
    },{group,blockId}),{timeout:30000}).toBe(true);
    const recorded = await page.evaluate(async ({ group, blockId }) => {
      const { coreApi } = await import('/src/components/blockterm/api.ts');
      const { sessions } = await coreApi.list(group);
      if (sessions.length !== 1) throw new Error('Expected exactly one fixture session');
      const data = [];
      let after = 0;
      let through;
      let pages=0;
      const pageInfo=[];
      for (;;) {
        const result = await coreApi.output(sessions[0].id, blockId, after, undefined, through);
        if(!Number.isSafeInteger(result.through) || (through!==undefined && result.through!==through)) throw new Error('Output snapshot boundary changed');
        through=result.through;
        pages++;
        pageInfo.push({after,through,count:result.events.length,more:result.has_more});
        for (const event of result.events) {
          if (event.seq <= after) throw new Error('Output cursor did not advance');
          after = event.seq;
          data.push(event.data || '');
        }
        if (!result.has_more) return {data,pages,pageInfo,session:await coreApi.get(sessions[0].id)};
        if (!result.events.length) throw new Error('Empty continuation page');
      }
    }, { group, blockId });
    assert.ok(recorded.pages>=2,`Large real PTY output must span multiple download pages: ${JSON.stringify({blockId,pages:recorded.pages,pageInfo:recorded.pageInfo,session:recorded.session,records:recorded.data.length,bytes:recorded.data.reduce((sum,data)=>sum+Buffer.from(data,'base64').length,0)})}`);
    const expected = Buffer.concat(recorded.data.map(data => Buffer.from(data, 'base64')));
    assert.ok(expected.includes(Buffer.alloc(1200000)), `All real PTY NUL bytes must be retained: block=${blockId} bytes=${expected.length} pages=${recorded.pages}`);
    assert.ok(expected.includes(Buffer.concat([
      Buffer.from('RAW_DOWNLOAD'), Buffer.from([0, 255]), Buffer.from('\x1b[32m中文\x1b[0m\r\n'),
    ])), 'Persisted PTY output must preserve binary, ANSI and UTF-8 bytes');
    const downloadEvent = page.waitForEvent('download');
    await rawBlock.getByRole('button', { name: '命令块操作', exact: true }).click();
    await page.getByRole('dialog', { name: '命令块操作', exact: true }).getByRole('button', { name: '下载已记录的原始输出', exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), `blockterm-${blockId}.ansi`);
    const stream = await download.createReadStream();
    assert.ok(stream);
    const downloaded = [];
    for await (const chunk of stream) downloaded.push(chunk);
    assert.deepEqual(Buffer.concat(downloaded), expected);
    const oscDestination='https://example.test/osc8';
    const oscLabel='OSC8_REPORT_中文';
    await historySearch.fill('');
    await run("printf '\\033]8;;https://example.test/osc8\\007OSC8_REPORT_中文\\033]8;;\\007\\n'");
    await historySearch.fill(oscLabel);
    const oscLinks=page.getByRole('link',{name:oscDestination,exact:true});
    await oscLinks.first().waitFor();
    assert.equal((await oscLinks.allTextContents()).join(''),oscLabel);
    const oscBlock=await oscLinks.first().evaluate(node=>node.closest('[data-block-id]').dataset.blockId);
    await page.reload();
    await page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node&&!node.disabled;});
    await historySearch.fill(oscLabel);
    await oscLinks.first().waitFor();
    assert.equal((await oscLinks.allTextContents()).join(''),oscLabel);
    assert.equal(await oscLinks.first().evaluate(node=>node.closest('[data-block-id]').dataset.blockId),oscBlock);
    await historySearch.fill('');
    // A non-interactive child leaves delayed output on the real PTY without
    // the interactive shell's own background-job announcement.
    await run("bash -c '(sleep 0.4; printf \"\\033[3\"; sleep 0.1; printf \"1mBG_RED_中文\\033[0m\\n\") &'");
    await historySearch.fill('BG_RED_中文');
    const backgroundText=page.locator('[data-output-row]').getByText('BG_RED_中文',{exact:true}).first();
    const readBackground=async()=>{
      await backgroundText.waitFor();
      return backgroundText.evaluate(node=>{
        const block=node.closest('[data-block-id]');
        return {id:block.dataset.blockId,color:getComputedStyle(node).color,command:block.querySelector('[data-block-command]')?.textContent??''};
      });
    };
    const backgroundBefore=await readBackground();
    assert.equal(backgroundBefore.command,'','Delayed PTY text must belong to a background block');
    const channels=backgroundBefore.color.match(/[\d.]+/g).map(Number);
    assert.ok(channels[0]>channels[1]*1.5 && channels[0]>channels[2]*1.5,`Expected red background output, got ${backgroundBefore.color}`);
    await page.reload();
    await page.waitForFunction(()=>{const node=document.querySelector('textarea[aria-label="命令输入"]');return node&&!node.disabled;});
    await historySearch.fill('BG_RED_中文');
    assert.deepEqual(await readBackground(),backgroundBefore,'Reload must preserve background ownership and color');
    await historySearch.fill('');
    await input.fill('exit');
    await input.press('Tab');
    const nativeInput=page.locator('.xterm-helper-textarea').last();
    await nativeInput.focus();
    assert.equal(await nativeInput.evaluate(node=>node===document.activeElement),true);
    await page.keyboard.press('Enter');
    await page.getByPlaceholder('会话已结束',{exact:true}).waitFor();
    assert.equal(await nativeInput.evaluate(node=>!!node.closest('[inert]')),true);
    await page.reload();
    await page.getByPlaceholder('会话已结束',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'搜索命令和输出'}).fill('RAW_DOWNLOAD');
    await page.locator(`section[data-block-id="${blockId}"]`).waitFor();
    await context.close();
    console.log(`viewport ${width} passed`);
  }
  const appContext = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
  const app = await appContext.newPage();
  app.on('pageerror', (error) => errors.push(error.message));
  await app.goto(base);
  await app.waitForFunction(async () => {
    const { useFrameStore } = await import('/src/stores/frame-store.ts');
    const { useSessionStore } = await import('/src/stores/session-store.ts');
    return useFrameStore.getState().groups.length > 0 && useSessionStore.getState().sessionInitialized && !useSessionStore.getState().loading;
  });
  await app.getByRole('button',{name:'新建页面',exact:true}).click();
  await app.getByText('BlockTerm',{exact:true}).click();
  await app.locator('[data-blockterm-core]').waitFor();
  await app.getByRole('button', {name:'新建会话',exact:true}).click();
  await app.waitForFunction(() => { const node = document.querySelector('textarea[aria-label="命令输入"]'); return node && !node.disabled; });
  await app.getByRole('textbox',{name:'命令输入',exact:true}).fill("printf 'APP_CORE_OK\\n'");
  await app.getByRole('button',{name:'执行命令',exact:true}).click();
  await app.getByText('APP_CORE_OK',{exact:true}).first().waitFor();
  assert.equal(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await app.getByRole('button',{name:'结束会话',exact:true}).click();
  await appContext.close();
  console.log('real app BlockTerm entry passed');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
