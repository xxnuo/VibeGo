import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";

test("plugin host services and workbench integration", async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const globals = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "Event", "CustomEvent", "MutationObserver", "HTMLInputElement", "HTMLSelectElement", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globals) Object.defineProperty(globalThis,name,{ configurable: true, writable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : typeof dom.window[name] === "function" && /^[a-z]/.test(name) ? dom.window[name].bind(dom.window) : dom.window[name] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const vite = await createServer({ appType: "custom", server: { hmr: false, middlewareMode: true } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => { await act(() => root.unmount()); await vite.close(); dom.window.close(); for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis,name,descriptor); else delete globalThis[name]; } });
  const load = path => vite.ssrLoadModule(`/src/${path}`);
  const { createPluginStorage } = await load("framework/host/storage-service.ts");
  const { contextKeys, evaluateWhen } = await load("framework/host/context-key-service.ts");
  const { pluginEvents } = await load("framework/host/event-bus.ts");
  const { commands } = await load("framework/host/command-service.ts");
  const { workbenchRegistry: registry, registerPlugin, definePlugin } = await load("framework/workbench/registry.ts");
  const { useFrameStore: frame } = await load("stores/frame-store.ts");
  const { useSessionStore: sessions } = await load("stores/session-store.ts");
  const { useAppStore: app } = await load("stores/app-store.ts");
  const { usePreviewStore: preview } = await load("stores/preview-store.ts");
  const { fileApi } = await load("api/file.ts");
  const { DialogProvider } = await load("components/common/dialog-provider.tsx");
  const { usePluginHost, PluginHostScope } = await load("framework/host/use-plugin-host.ts");
  const { PluginWorkbenchRuntime } = await load("framework/host/workbench-runtime.tsx");
  const {useTaskbar}=await load("framework/workbench/use-taskbar.ts");
  let host;let taskbar;
  function Probe() { host = usePluginHost(); taskbar=useTaskbar({orientation:"horizontal"});return null; }
  const render = (id = "a", content = React.createElement(Probe)) => act(() => root.render(React.createElement(DialogProvider,null,React.createElement(PluginHostScope.Provider,{ value: { pluginId: "fixture",groupId: id } },content))));
  await t.test("workspace and global mementos persist without crossing namespaces", async () => {
    localStorage.clear();
    const a = createPluginStorage("p:1","a"); const b = createPluginStorage("p:1","b"); const other = createPluginStorage("p:2","a"); const global = createPluginStorage("p:1");
    await a.update("foo:bar", { count: 2 }); await global.update("setting",true);
    assert.deepEqual(a.keys(),["foo:bar"]); assert.deepEqual(createPluginStorage("p:1","a").get("foo:bar"),{ count: 2 });
    assert.equal(b.get("foo:bar","none"),"none"); assert.equal(other.get("foo:bar"),undefined); assert.equal(createPluginStorage("p:1").get("setting"),true);
    await a.delete("foo:bar"); assert.deepEqual(a.keys(),[]);
  });
  await t.test("when parser handles precedence, comparisons, malformed and hostile clauses", () => {
    const values = { "git.isRepo": true,isMobile: false,count: 3,activeTabType: "files",falseKey: true };
    for (const clause of [undefined,"git.isRepo && !isMobile", "(isMobile || git.isRepo) && count >= 3", "activeTabType == files", "falseKey", "false || true && true"]) assert.equal(evaluateWhen(clause,values),true,clause);
    for (const clause of ["git.isRepo && isMobile", "count < 2", "missing", "!missing &&", "true)", "globalThis.alert('x')", "activeTabType ==", "true ||", "true && ()", "constructor", "toString"]) assert.equal(evaluateWhen(clause,values),false,clause);
    contextKeys.set("docker.connected",true); assert.equal(contextKeys.get("docker.connected"),true); assert.equal(contextKeys.evalWhen("docker.connected"),true);
  });
  await t.test("event listeners broadcast and unsubscribe", () => {
    const values = []; const off = pluginEvents.on("save",path => values.push(path)); pluginEvents.emit("save","/a"); off(); pluginEvents.emit("save","/b"); assert.deepEqual(values,["/a"]);
  });
  await t.test("declarative services, commands, editors, and workspace views share a registry", async () => {
    frame.getState().initDefaultGroups(); frame.getState().addFolderGroup("/a","A","a");
    const dispose = registerPlugin(definePlugin({ id: "fixture-a",name: "A",exports: { double: value => value*2 },contributions: { workspaceViews: [{ id: "data",name: "Data",category: "workspace",View: () => null }],commands: [{ id: "data.double",title: "Double",handler: value => value*2 }],customEditors: [{ id: "grid",fileExtensions: [".csv"],Component: () => React.createElement("div",null,"CSV Grid") }],configuration: { properties: { enabled: { type: "boolean", default: true } } },menu: [{ id: "double",title: "Double",location: "project",command: "data.double" }] } }));
    assert.deepEqual(frame.getState().groups[0].pages.map(page => page.type),["files","git","terminal","data"]);
    frame.getState().addFolderGroup("/b","B","b"); assert.equal(frame.getState().groups[1].pages[3].type,"data");
    await render("a");assert.equal(taskbar.getPageTitle("data"),"Data"); assert.equal(host.extensions.getExtension("fixture-a").exports.double(3),6); assert.equal(await host.commands.execute("data.double",4),8);
    assert.equal(registry.getCustomEditors(".CSV")[0].id,"grid"); assert.ok(registry.getMenus("project").some(item => item.id === "fixture-a:double"));
    await act(() => dispose()); assert.equal(host.extensions.getExtension("fixture-a"),undefined); assert.equal(registry.getCustomEditors(".csv").length,0); await assert.rejects(commands.execute("data.double",2));
    assert.equal(frame.getState().groups[0].pages[3].type,"data","disabled plugin retains saved page state");
  });
  await t.test("host storage follows workspace switches and scoped editor updates", async () => {
    await render("a"); await host.storage.workspace.update("x",1); await host.storage.global.update("x",2);
    await render("b"); assert.equal(host.workspace.currentPath,"/b"); assert.equal(host.storage.workspace.get("x"),undefined); assert.equal(host.storage.global.get("x"),2);
    await render("a"); assert.equal(host.storage.workspace.get("x"),1);
    await act(() => host.workspace.openFile("/a/test.ts", { line: 5,column: 4,editorId: "native" }));
    assert.equal(frame.getState().activeGroupId,"a"); assert.equal(host.editor.activeTab.data.line,5); assert.equal(host.editor.activeTab.data.column,4);
    await act(() => host.workspace.openFile("/a/test.ts", { line: 9,column: 2 })); assert.equal(host.editor.activeTab.data.line,9);
    await act(() => host.editor.setDirty(host.editor.activeTab.id,true)); assert.equal(host.editor.activeTab.data.isDirty,true);
    await act(() => host.editor.pinTab(host.editor.activeTab.id)); assert.equal(host.editor.activeTab.pinned,true);
    await act(() => host.editor.closeTab(host.editor.activeTab.id)); assert.equal(host.editor.tabs.length,0);
  });
  await t.test("filesystem and successful saves use the existing API and event path", async () => {
    const originalFetch = globalThis.fetch; const requests = []; const saved = [];
    globalThis.fetch = async (url,init) => { requests.push([url,init]); const data = url.includes("/read") ? { content: "hello" } : url.includes("/check") ? { exist: true } : url.includes("/list") ? { files: [] } : url.includes("/info") ? { size: 5,isDir: false,extension: ".ts",modTime: "today" } : { ok: true }; return new Response(JSON.stringify(data),{ status: 200,headers: {"content-type":"application/json"} }); };
    const off = host.events.onDidSaveDocument(path => saved.push(path));
    try { assert.equal(await host.workspace.fs.readText("/a/test.ts"),"hello"); await host.workspace.fs.writeText("/a/test.ts","world"); assert.equal(await host.workspace.fs.exists("/a/test.ts"),true); assert.equal((await host.workspace.fs.stat("/a/test.ts")).size,5); await host.workspace.fs.mkdir("/a/folder"); await host.workspace.fs.delete("/a/test.ts"); assert.deepEqual(await host.workspace.fs.list("/a"),[]); assert.deepEqual(saved,["/a/test.ts"]); assert.ok(requests.some(([url]) => url === "/api/file/write")); } finally { off(); globalThis.fetch = originalFetch; }
  });
  await t.test("rendered progress supports cancellation and removes completed progress", async () => {
    await render("a",React.createElement(React.Fragment,null,React.createElement(Probe),React.createElement(PluginWorkbenchRuntime)));
    let signal; let resolve;
    let task;
    await act(() => { task = host.ui.withProgress({ title: "Build", cancellable: true },(progress,abort) => { signal=abort; progress(45,"Compile"); return new Promise(done => { resolve=done; }); }); });
    assert.match(document.body.textContent,/Compile/); assert.equal(document.querySelector("progress").value,45);
    await act(() => document.querySelector('button[aria-label="取消"]').click()); assert.equal(signal.aborted,true);
    await act(async () => { resolve(42); assert.equal(await task,42); }); assert.equal(document.querySelector("progress"),null);
  });
  await t.test("workspace, active tab and theme transitions publish host events", async () => {
    const changes = []; const cleanups = [host.events.onDidChangeActiveTab(id => changes.push(["tab",id])),host.events.onDidChangeWorkspace(path => changes.push(["workspace",path])),host.events.onDidChangeTheme(theme => changes.push(["theme",theme]))];
    await act(() => { frame.getState().setActiveGroup("b"); app.getState().setTheme("dark"); frame.getState().addCurrentTab({ id:"event-tab",title:"Event" }); });
    assert.ok(changes.some(([type,value]) => type === "workspace" && value === "/b")); assert.ok(changes.some(([type,value]) => type === "tab" && value === "event-tab")); assert.ok(changes.some(([type,value]) => type === "theme" && value === "dark")); cleanups.forEach(off => off());
  });
  await t.test("scoped resources dispose on unmount and status item mutations render", async () => {
    const { default: StatusBar } = await load("components/frame/status-bar.tsx");
    const { useStatusBarStore } = await load("framework/host/status-bar-service.ts");
    await render("b",React.createElement(React.Fragment,null,React.createElement(Probe),React.createElement(StatusBar)));
    let item;
    await act(() => { item=host.statusBar.createItem({ id:"branch",priority:10 }); item.text="main"; item.show(); }); assert.match(document.body.textContent,/main/);
    await act(() => { item.text="next"; }); assert.match(document.body.textContent,/next/);
    host.commands.register("fixture.dynamic",() => 7); assert.equal(await commands.execute("fixture.dynamic"),7);
    await act(() => root.render(null)); assert.equal(useStatusBarStore.getState().items.length,0); await assert.rejects(commands.execute("fixture.dynamic"));
  });
  await t.test("a render crash is isolated and Retry re-renders only the plugin", async () => {
    const { PluginErrorBoundary } = await load("components/common/plugin-kit/plugin-error-boundary.tsx");
    let crash=true; function Broken() { if (crash) throw new Error("fixture crash"); return React.createElement("span",null,"Recovered"); }
    const error=console.error; console.error=()=>{};
    try { await act(() => root.render(React.createElement(React.Fragment,null,React.createElement("button",null,"Workbench alive"),React.createElement(PluginErrorBoundary,{pluginId:"broken"},React.createElement(Broken))))); assert.match(document.body.textContent,/fixture crash/); assert.match(document.body.textContent,/Workbench alive/); crash=false; await act(() => [...document.querySelectorAll("button")].find(button => button.textContent === "重试").click()); assert.match(document.body.textContent,/Recovered/); } finally { console.error=error; }
  });
  await t.test("custom editor routing, configuration forms and contributed menus render", async () => {
    const { default: FilePreview } = await load("components/preview/file-preview.tsx");
    const { default: PluginSettings } = await load("components/settings/plugin-settings.tsx");
    const { default: NewPageMenu } = await load("components/common/new-page-menu.tsx");
    const { default: ProjectMenu } = await load("components/common/project-menu.tsx");
    const coreIcon = (await load("pages/index.ts")).pageRegistry.get("files").icon;
    const dispose=registerPlugin({id:"ui-fixture",name:"Fixture Settings",contributions:{
      customEditors:[{id:"csv-grid",name:"CSV Grid",fileExtensions:[".csv"],Component:({file})=>React.createElement("div",null,`Grid ${file.name}`)}],
      configuration:{properties:{enabled:{type:"boolean",default:false,title:"Enabled"},name:{type:"string",default:"original",title:"Name"},count:{type:"number",default:3,title:"Count"}}},
      commands:[{id:"fixture.menu",title:"Fixture Command",handler:()=>{window.fixtureInvoked=true;}}],
      keybindings:[{command:"fixture.menu",key:"ctrl+k",when:"!isMobile"}],
      menu:[{id:"custom",location:"new-page",title:"Fixture Page",icon:coreIcon,command:"fixture.menu"},{id:"project",location:"project",title:"Fixture Action",command:"fixture.menu",when:"fixture.visible"}],
      quickOpenProviders:[{id:"symbols",prefix:"@",search:query=>[{id:"symbol",label:`Symbol ${query}`,run:()=>{window.fixtureSymbol=true;}}]}],
    }});
    try {
      await act(() => { frame.getState().setActiveGroup("a"); frame.getState().setFolderView("a","files"); frame.getState().addCurrentTab({id:"csv",title:"data.csv",data:{path:"/a/data.csv"}}); });
      const file={path:"/a/data.csv",name:"data.csv",size:0,extension:".csv",isDir:false};
      await render("a",React.createElement(FilePreview,{file})); assert.match(document.body.textContent,/Grid data.csv/); assert.equal(document.querySelector('select[aria-label="打开方式"]').value,"csv-grid");
      const read=fileApi.read; fileApi.read=async()=>({content:"a,b"});
      try { await act(async()=>{const select=document.querySelector('select[aria-label="打开方式"]');select.value="default";select.dispatchEvent(new window.Event("change",{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,1));}); assert.equal(frame.getState().getCurrentTabs().find(tab=>tab.id==="csv").data.editorId,"default"); assert.doesNotMatch(document.body.textContent,/Grid data.csv/); } finally {fileApi.read=read;}
      await render("a",React.createElement(PluginSettings)); assert.match(document.body.textContent,/Fixture Settings/);
      await act(async()=>document.querySelector('input[type="checkbox"]').click()); assert.equal(createPluginStorage("ui-fixture").get("enabled"),true);
      await render("a",React.createElement(NewPageMenu,{isOpen:true,onClose(){},locale:"zh",onOpenDirectory(){},onNewTerminal(){},onNewTool(){}})); assert.match(document.body.textContent,/Fixture Page/); await act(()=>[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Fixture Page")).click()); assert.equal(window.fixtureInvoked,true);
      await act(()=>contextKeys.set("fixture.visible",false));
      await render("a",React.createElement(ProjectMenu,{isOpen:true,onClose(){},locale:"zh",onOpenSettings(){},onOpenDirectory(){},onShowHomePage(){},onNewPage(){}})); assert.doesNotMatch(document.body.textContent,/Fixture Action/);
      await act(()=>contextKeys.set("fixture.visible",true)); assert.match(document.body.textContent,/Fixture Action/);
      await render("a",React.createElement(PluginWorkbenchRuntime)); window.fixtureInvoked=false;
      await act(()=>window.dispatchEvent(new window.KeyboardEvent("keydown",{key:"k",ctrlKey:true}))); assert.equal(window.fixtureInvoked,true);
      await act(()=>window.dispatchEvent(new window.KeyboardEvent("keydown",{key:"p",ctrlKey:true})));
      await act(async()=>{const input=document.querySelector('input[aria-label="搜索"]'); const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set; setter.call(input,"@foo"); input.dispatchEvent(new window.Event("input",{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,150));});
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150));});
      assert.match(document.body.textContent,/Symbol foo/); await act(()=>[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Symbol foo")).click()); assert.equal(window.fixtureSymbol,true);
    } finally { await act(()=>root.render(null)); dispose(); }
  });
  await t.test("task output and exit notifications replay for fast tasks and cancellation reaches the API", async () => {
    const { tasks }=await load("framework/host/task-service.ts"); const originalFetch=globalThis.fetch;
    let cancelled=false; let controller;
    globalThis.fetch=async(url,init)=>{ if(init.method==="DELETE"){cancelled=true;controller.enqueue(new TextEncoder().encode(' {"exitCode":-1}\n'));controller.close();return new Response('{"ok":true}');}
      const stream=new ReadableStream({start(value){controller=value;value.enqueue(new TextEncoder().encode('{"id":"task-fixture"}\n{"output":"first"}\n'));}});
      return new Response(stream,{status:200}); };
    try { const task=await tasks.runTask({command:"fixture"}); assert.equal(tasks.getActiveTasks()[0].id,task.id); const output=[];task.onDidOutput(chunk=>output.push(chunk));assert.deepEqual(output,["first"]);const exited=new Promise(resolve=>task.onDidExit(resolve));task.kill();assert.equal(await exited,-1);assert.equal(cancelled,true);assert.deepEqual(tasks.getActiveTasks(),[]);let replay;task.onDidExit(code=>{replay=code;});assert.equal(replay,-1); } finally {globalThis.fetch=originalFetch;}
  });
  await t.test("mounted editor receives exact positions and insertions at its selection", async () => {
    const {editorService}=await load("framework/host/editor-service.ts"); const calls=[];
    const editor={setPosition:position=>calls.push(["position",position]),revealPositionInCenter:position=>calls.push(["reveal",position]),focus(){},pushUndoStop(){},getSelection:()=>({startLineNumber:5,startColumn:3,endLineNumber:5,endColumn:6}),updateOptions:options=>calls.push(["options",options]),executeEdits:(source,edits)=>calls.push(["edit",source,edits])};
    const detach=editorService.attach(editor,{line:5,column:3});editorService.insertText("hello");detach();assert.deepEqual(calls[0],["position",{lineNumber:5,column:3}]);assert.equal(calls[3][2][0].text,"hello");assert.throws(()=>editorService.insertText("x"));
  });
  await t.test("pending quick picks and progress dispose with their owning plugin", async () => {
    const {usePluginUIStore}=await load("framework/host/ui-service.ts");
    await render("a");
    let pick;let progress;let resolve;let signal;
    await act(()=>{pick=host.ui.showQuickPick([{id:"one",label:"One"}],{placeholder:"Pick"});progress=host.ui.withProgress({title:"Pending"},(_report,abort)=>{signal=abort;return new Promise(done=>{resolve=done;});});});
    assert.equal(usePluginUIStore.getState().picks.length,1);assert.equal(usePluginUIStore.getState().progress.length,1);
    await act(()=>root.render(null));assert.equal(await pick,null);assert.equal(signal.aborted,true);assert.equal(usePluginUIStore.getState().progress.length,0);
    resolve(1);assert.equal(await progress,1);
  });
  await t.test("keyboard input keeps selection, undo and clipboard behavior", async () => {
    const {applyKeyboardTestInput}=await load("services/keyboard-test-input.ts");
    const textarea=document.createElement("textarea");document.body.append(textarea);textarea.value="abc\ndef";textarea.setSelectionRange(1,2);
    const history={current:[]};const ref={current:textarea};const clipboard={readText:async()=>"clip",writeText:async()=>{}};
    const setText=value=>{textarea.value=value;};const input=value=>applyKeyboardTestInput({type:"char",value},ref,history,setText,()=>{},clipboard);
    input("X");await new Promise(resolve=>setTimeout(resolve,1));assert.equal(textarea.value,"aXc\ndef");assert.equal(textarea.selectionStart,2);
    input("Undo");await new Promise(resolve=>setTimeout(resolve,1));assert.equal(textarea.value,"abc\ndef");textarea.setSelectionRange(0,0);input("Paste");await new Promise(resolve=>setTimeout(resolve,1));assert.equal(textarea.value,"clipabc\ndef");textarea.remove();
  });
  await t.test("closing a workspace while terminal creation is pending cannot restore orphan state", async () => {
    const {terminalApi}=await load("api/terminal.ts");const {useTerminalStore}=await load("stores/terminal-store.ts");
    await act(()=>frame.getState().addFolderGroup("/late","Late","late"));await render("late");
    const create=terminalApi.create;const del=terminalApi.delete;let resolve;let deleted;
    terminalApi.create=()=>new Promise(done=>{resolve=done;});terminalApi.delete=async id=>{deleted=id;return{ok:true};};
    try{const creation=host.terminal.create();await act(()=>frame.getState().removeGroup("late"));resolve({id:"late-terminal",name:"Late"});await assert.rejects(creation,/Workspace changed/);assert.equal(deleted,"late-terminal");assert.equal(useTerminalStore.getState().terminalsByGroup.late,undefined);}finally{terminalApi.create=create;terminalApi.delete=del;}
  });
  await t.test("workspace extension tabs survive the existing session round-trip", async () => {
    await act(() => root.render(null));
    const { sessionApi } = await load("api/session.ts"); const { settingsApi } = await load("api/settings.ts"); const { terminalApi } = await load("api/terminal.ts"); const { getTerminalWorkspaceGroupIds } = await load("stores/session-workspace-guard.ts");
    let saved; const patches=[]; const mock=(object,key,value)=>{ patches.push([object,key,object[key]]); object[key]=value; };
    mock(sessionApi,"update",async()=>({ok:true})); mock(sessionApi,"patchWorkspace",async(_id,state)=>{saved=structuredClone(state);return {ok:true};}); mock(sessionApi,"get",async()=>({id:"fixture",workspace_state:saved})); mock(settingsApi,"set",async()=>({ok:true})); mock(terminalApi,"syncWorkspace",async()=>({ok:true})); mock(terminalApi,"list",async()=>({terminals:[]}));
    const initAutoSave=sessions.getState().initAutoSave; sessions.setState({currentSessionId:"fixture",workspaceRevision:0,loading:false,sessionInitialized:true,initAutoSave(){}});
    try { frame.getState().setActiveGroup("a"); frame.getState().setFolderView("a","data"); frame.getState().addCurrentTab({id:"database",title:"Data",data:{query:"select 1"}}); await sessions.getState().saveCurrentSession(); sessions.setState({currentSessionId:null}); frame.getState().initDefaultGroups(); await sessions.getState().switchSession("fixture"); assert.equal(sessions.getState().error,null); assert.equal(frame.getState().getCurrentPageType(),"data"); assert.equal(frame.getState().getCurrentTabs()[0].data.query,"select 1"); assert.deepEqual([...getTerminalWorkspaceGroupIds(frame.getState().groups)],["a","b"]); } finally { for (const [object,key,value] of patches) object[key]=value; sessions.setState({initAutoSave,currentSessionId:null}); }
  });
});
