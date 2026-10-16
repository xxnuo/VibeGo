import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("workspace mutation engine preserves inventory, viewport and durable intent", async t => {
  const dom = new JSDOM("<div id='root'></div>",{url:"http://localhost"});
  const globals=["window","document","localStorage","sessionStorage","WebSocket"];
  const original=new Map(globals.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  class Socket {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;static instances=[];
    readyState=0;
    constructor(url){this.url=url;Socket.instances.push(this);}
    close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}
    receive(value){this.onmessage?.({data:JSON.stringify(value)});}
  }
  for(const key of globals)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==="WebSocket"?Socket:dom.window[key]});
  const vite=await createServer({appType:"custom",configFile:false,optimizeDeps:{noDiscovery:true,include:[]},resolve:{alias:{"@":fileURLToPath(new URL("../src",import.meta.url))}},server:{middlewareMode:true,hmr:false,ws:false}});
  const load=path=>vite.ssrLoadModule(`/src/${path}`);
  const {useFrameStore:frame}=await load("stores/frame-store.ts");
  const {useWorkspaceSyncStore:sync,subscribeWorkspaceMutation}=await load("stores/workspace-sync-store.ts");
  const {workspaceApi}=await load("api/workspace-sync.ts");
  const {inventoryFromFrame,reduceInventory}=await load("stores/workspace-inventory.ts");
  const {createPluginStorage}=await load("framework/host/storage-service.ts");
  const {useTerminalStore:terminals}=await load("stores/terminal-store.ts");
  const {saveWorkspaceViewport,workspaceSnapshotState}=await load("stores/workspace-viewport.ts");
  let authority;let workspaceId="ws";let sequence=0;const requests=[];
  const submit=async mutation=>{
    requests.push(structuredClone(mutation));
    authority=reduceInventory(authority,mutation);
    authority.workspace={...authority.workspace,revision:authority.workspace.revision+1};
    return{ok:true,revision:authority.workspace.revision,mutation_id:mutation.id,event:{type:"mutation:committed",revision:authority.workspace.revision,mutation}};
  };
  workspaceApi.submitMutation=submit;
  workspaceApi.getSnapshot=async()=>structuredClone(authority);
  const reset=async()=>{
    workspaceId=`ws-${++sequence}`;
    sync.getState().disconnect();sync.setState({outbox:[]});sessionStorage.removeItem("vibego:workspace-outbox:v1");terminals.getState().reset();
    frame.getState().initDefaultGroups();frame.getState().addFolderGroup("/repo","Repo","folder");
    frame.getState().addTab("folder",{id:"file-a",title:"a.ts",data:{type:"code",path:"/repo/a.ts"}},"folder-files");
    authority={workspace:{id:workspaceId,name:"Workspace",revision:1,data:"{}"},...inventoryFromFrame(frame.getState().groups,workspaceId),storage:[],terminals:[]};
    workspaceApi.submitMutation=submit;workspaceApi.getSnapshot=async()=>structuredClone(authority);requests.length=0;
    await sync.getState().connect(workspaceId,authority);
  };
  const remote=(type,payload)=>{
    const mutation={id:crypto.randomUUID(),workspace_id:workspaceId,client_id:"peer",type,payload,created_at:Date.now(),base_revision:authority.workspace.revision};
    authority=reduceInventory(authority,mutation);authority.workspace={...authority.workspace,revision:authority.workspace.revision+1};
    sync.getState().applyRemoteMutation(mutation,authority.workspace.revision);return mutation;
  };
  t.after(async()=>{await sync.getState().flush();sync.getState().disconnect();await vite.close();dom.window.close();for(const[key,value]of original){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});

  await t.test("peer folders, tools, tabs and data never steal local focus or echo",async()=>{
    await reset();
    remote("folder/add",{id:"peer-folder",name:"Peer",path:"/peer"});
    remote("tool/open",{id:"desktop",page_id:"remote-desktop",name:"Desktop",data:{qualityPreset:"sharp"}});
    remote("tab/open",{id:"peer-tab",folder_id:"folder",page_id:"folder-files",title:"Preview",tab_type:"preview",data:{type:"preview",port:3000}});
    remote("tool/update-data",{id:"desktop",data:{qualityPreset:"smooth"}});
    assert.equal(frame.getState().activeGroupId,"folder");assert.equal(frame.getState().getCurrentActiveTabId(),"file-a");
    assert.equal(frame.getState().groups.find(group=>group.id==="desktop").data.qualityPreset,"smooth");assert.equal(requests.length,0);
    remote("tab/close",{id:"peer-tab",folder_id:"folder",page_id:"folder-files"});remote("folder/remove",{id:"peer-folder"});
    assert.equal(frame.getState().activeGroupId,"folder");assert.equal(frame.getState().getCurrentActiveTabId(),"file-a");
  });
  await t.test("terminal creation stays unique regardless of broadcast and response order", async () => {
    for (const broadcastFirst of [true, false]) {
      await reset();
      const existing = { id: "existing", name: "Terminal 1", group_id: "folder", status: "running" };
      remote("terminal/open", { terminals: [existing] });
      terminals.getState().setActiveId("folder", existing.id);

      const root = {
        id: "created", name: "Terminal 2", group_id: "folder", status: "running",
        cwd: "/repo", current_cwd: "/repo/subdir", readonly: true, runtime_type: "local",
      };
      const complete = terminal => terminals.getState().addTerminal("folder", {
        id: terminal.id, name: terminal.name, cwd: "/repo", parentId: terminal.parent_id,
      });
      if (!broadcastFirst) complete(root);
      remote("terminal/open", { terminals: [existing, root] });
      if (broadcastFirst) {
        assert.equal(terminals.getState().activeIdByGroup.folder, existing.id);
        complete(root);
      }
      const state = terminals.getState();
      assert.deepEqual(state.getTerminals("folder").map(terminal => terminal.id), [existing.id, root.id]);
      assert.equal(state.activeIdByGroup.folder, root.id);
      assert.equal(state.focusedIdByGroup.folder, root.id);
      assert.equal(state.listManagerOpenByGroup.folder, false);
      assert.deepEqual(state.terminalLayouts[root.id], { type: "terminal", terminalId: root.id });
      assert.equal(state.getTerminals("folder")[1].currentCwd, root.current_cwd);
      assert.equal(state.getTerminals("folder")[1].readonly, true);

      const child = { id: "child", name: "Terminal 3", group_id: "folder", parent_id: root.id, status: "running" };
      if (!broadcastFirst) complete(child);
      remote("terminal/open", { terminals: [existing, root, child] });
      if (broadcastFirst) complete(child);
      terminals.getState().splitTerminal(root.id, root.id, child.id, "horizontal");
      assert.deepEqual(terminals.getState().getTerminals("folder").map(terminal => terminal.id), [existing.id, root.id, child.id]);
      assert.deepEqual(terminals.getState().getRootTerminals("folder").map(terminal => terminal.id), [existing.id, root.id]);
      assert.equal(terminals.getState().activeIdByGroup.folder, root.id);
      assert.equal(terminals.getState().terminalLayouts[root.id].second.terminalId, child.id);

      remote("terminal/close", { terminals: [existing, root, { ...child, status: "exited" }] });
      complete(child);
      assert.equal(terminals.getState().getTerminals("folder").find(terminal => terminal.id === child.id).status, "exited");
    }
  });
  await t.test("all local asset entry points emit atomic actions without viewport or dirty data",async()=>{
    await reset();
    frame.getState().setActiveGroup("folder");frame.getState().showHomePage();frame.getState().setActiveGroup("folder");
    frame.getState().setActivePage("folder","folder-files");assert.equal(requests.length,0);
    frame.getState().addFolderGroup("/second","Second","second");
    frame.getState().addToolGroup("fixture","Fixture","tool");
    frame.getState().setActiveGroup("folder");
    frame.getState().addTab("folder",{id:"default-editor",title:"Code",data:{type:"code",editorId:"default"}},"folder-files");
    frame.getState().addTab("folder",{id:"diff",title:"Diff",data:{type:"diff",originalPath:"a",modifiedPath:"b"}},"folder-files");
    frame.getState().addTab("folder",{id:"custom",title:"Custom",data:{editorId:"csv",path:"/repo/a.csv"}},"folder-files");
    frame.getState().updateTab("folder","custom",{pinned:true},"folder-files");
    frame.getState().updateTab("folder","custom",{data:{isDirty:true,line:42,column:7}},"folder-files");
    await sync.getState().dispatch("plugin/mutate",{plugin_id:"fixture",action:"refresh",data:{value:1}});
    await sync.getState().flush();
    for(const kind of ["folder/add","tool/open","tab/open","tab/pin","plugin/mutate"])assert.ok(requests.some(mutation=>mutation.type===kind),kind);
    assert.ok(requests.some(mutation=>mutation.payload.id==="default-editor"&&mutation.payload.tab_type==="file"));
    assert.ok(requests.some(mutation=>mutation.payload.tab_type==="diff"));assert.ok(requests.some(mutation=>mutation.payload.tab_type==="custom_editor"));
    assert.doesNotMatch(JSON.stringify(requests),/activeGroupId|activeTabId|isDirty|"line"|"column"/);
    assert.equal(sync.getState().outbox.length,0);assert.deepEqual(JSON.parse(sessionStorage.getItem("vibego:workspace-outbox:v1")),[]);
  });
  await t.test("offline mutations survive refresh and stay queued until acknowledged",async()=>{
    await reset();workspaceApi.submitMutation=async()=>{throw new TypeError("offline");};
    frame.getState().addFolderGroup("/offline","Offline","offline");await sync.getState().flush();
    const queued=JSON.parse(sessionStorage.getItem("vibego:workspace-outbox:v1"));assert.equal(queued.length,1);
    remote("folder/add",{id:"from-peer",path:"/peer",name:"Peer"});
    await sync.getState().refresh();
    assert.ok(frame.getState().groups.some(group=>group.id==="offline"));assert.ok(frame.getState().groups.some(group=>group.id==="from-peer"));
    workspaceApi.submitMutation=submit;await new Promise(resolve=>setTimeout(resolve,0));await sync.getState().flush();
    assert.equal(sync.getState().outbox.length,0);assert.equal(authority.folders.length,3);assert.equal(requests[0].id,queued[0].id);
  });
  await t.test("plugin mementos synchronize by workspace, plugin, group and key",async()=>{
    await reset();const a=createPluginStorage("fixture",workspaceId,"folder"),b=createPluginStorage("fixture",workspaceId,"other"),other=createPluginStorage("other",workspaceId,"folder");
    await a.update("config",{model:"first"});await sync.getState().flush();
    assert.deepEqual(a.get("config"),{model:"first"});assert.equal(b.get("config"),undefined);assert.equal(other.get("config"),undefined);
    remote("plugin/storage-update",{plugin_id:"fixture",scope:"folder",key:"config",value:{model:"peer"}});
    assert.deepEqual(a.get("config"),{model:"peer"});await a.delete("config");await sync.getState().flush();assert.deepEqual(a.keys(),[]);
    sync.getState().disconnect();await assert.rejects(a.update("stale",1),/Workspace changed/);
  });
  await t.test("viewport persistence contains focus and local order without shared assets or drafts",async()=>{
    await reset();
    const state=workspaceSnapshotState(authority);
    state.activeGroupId="folder";state.terminalLayouts={root:{type:"terminal",terminalId:"root"}};
    state.fileManagerByGroup={folder:{searchQuery:"private draft"}};
    saveWorkspaceViewport(workspaceId,state);
    const raw=sessionStorage.getItem(`vibego:viewport:${workspaceId}`);
    assert.doesNotMatch(raw,/openGroups|openTools|terminalsByGroup|terminalLayouts|private draft|searchQuery|\/repo/);
    assert.equal(workspaceSnapshotState(authority).activeGroupId,"folder");
    assert.deepEqual(workspaceSnapshotState(authority).fileManagerByGroup,{});
  });
  await t.test("slow previous workspace hydration cannot replace a newer workspace",async()=>{
    await reset();let resolve;workspaceApi.getSnapshot=()=>new Promise(done=>{resolve=done;});
    const previous=sync.getState().connect("old");const next={...structuredClone(authority),workspace:{...authority.workspace,id:"new"}};
    await sync.getState().connect("new",next);resolve({...authority,workspace:{...authority.workspace,id:"old"}});await previous;
    assert.equal(sync.getState().currentWorkspaceId,"new");assert.equal(sync.getState().snapshot.workspace.id,"new");
  });
  await t.test("revision gaps reconnect from the delivered cursor and replay plugin messages once",async()=>{
    await reset();const received=[];const off=subscribeWorkspaceMutation(mutation=>received.push(mutation.id));
    const event={id:"plugin-gap",workspace_id:workspaceId,client_id:"peer",type:"plugin/mutate",payload:{plugin_id:"fixture",action:"refresh",data:42},created_at:Date.now(),base_revision:1};
    const revision=sync.getState().revision;authority.workspace.revision=revision+2;
    sync.getState().applyRemoteMutation(event,revision+2);await new Promise(resolve=>setTimeout(resolve,0));
    const socket=Socket.instances.at(-1);assert.ok(Number(new URL(socket.url).searchParams.get("after"))<authority.workspace.revision);
    socket.receive({type:"mutation:committed",revision:revision+2,mutation:event});socket.receive({type:"mutation:committed",revision:revision+2,mutation:event});
    assert.deepEqual(received,["plugin-gap"]);off();
  });
  await t.test("catalog subscription starts after restoring the remembered workspace",async()=>{
    await reset();
    const {useSessionStore:sessions}=await load("stores/session-store.ts");
    const {sessionApi}=await load("api/session.ts");const {terminalApi}=await load("api/terminal.ts");
    const {settingsApi}=await load("api/settings.ts");
    const list=sessionApi.list,terminalList=terminalApi.list,settingsSet=settingsApi.set;
    settingsApi.set=async()=>({ok:true});
    let resolve;sessionApi.list=()=>new Promise(done=>{resolve=done;});terminalApi.list=async()=>({terminals:[]});
    sessionStorage.setItem("workspaceCurrentSessionId",workspaceId);
    sessions.setState({currentSessionId:null,sessions:[],loading:false,sessionInitialized:false});
    try {
      const pending=sessions.getState().initSession();
      assert.equal(Socket.instances.some(socket=>new URL(socket.url).searchParams.get("workspace_id")==="*"),false);
      resolve({sessions:[{id:workspaceId,name:"Workspace"}],page:1,page_size:50,total:1});
      assert.equal(await pending,true);assert.equal(sessions.getState().currentSessionId,workspaceId);
      assert.ok(Socket.instances.some(socket=>new URL(socket.url).searchParams.get("workspace_id")==="*"));
    } finally {sessionApi.list=list;terminalApi.list=terminalList;settingsApi.set=settingsSet;}
  });
});
