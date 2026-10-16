import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

test('workspace core: intent dispatch, inverse recovery and compacted snapshots', async t => {
  const dom = new JSDOM('<div></div>', {url:'http://localhost'});
  const keys = ['window','document','localStorage','sessionStorage','WebSocket'];
  const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
  class Socket {
    static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3; static instances=[];
    readyState=0;
    constructor(url) { this.url=url; Socket.instances.push(this); }
    close() { this.readyState=3; queueMicrotask(() => this.onclose?.()); }
    receive(value) { this.onmessage?.({data:JSON.stringify(value)}); }
  }
  for (const key of keys) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='WebSocket'?Socket:dom.window[key]});
  const vite = await createServer({appType:'custom', configFile:false, optimizeDeps:{noDiscovery:true,include:[]}, resolve:{alias:{'@':fileURLToPath(new URL('../src',import.meta.url))}},server:{middlewareMode:true,hmr:false,ws:false}});
  const load = path => vite.ssrLoadModule(`/src/${path}`);
  const {useFrameStore:frame} = await load('stores/frame-store.ts');
  const {useWorkspaceSyncStore:sync} = await load('stores/workspace-sync-store.ts');
  const {workspaceApi} = await load('api/workspace-sync.ts');
  const {workspaceActions:actions} = await load('stores/workspace-actions.ts');
  const {computeInvertedMutation,rollbackMutation} = await load('stores/workspace-inverter.ts');
  const {inventoryFromFrame,reduceInventory,frameFromInventory} = await load('stores/workspace-inventory.ts');
  const {ApiError} = await load('api/request.ts');
  let authority, counter=0, requests=[];
  const submit = async m => {
    requests.push(m); authority=reduceInventory(authority,m);
    authority.workspace={...authority.workspace,revision:authority.workspace.revision+1};
    return {event:{mutation:m},revision:authority.workspace.revision};
  };
  const reset = async () => {
    await sync.getState().flush(); sync.getState().disconnect(); sync.setState({outbox:[]});
    frame.getState().initDefaultGroups();
    frame.getState().addFolderGroup('/repo','Repo','folder');
    frame.getState().addFolderGroup('/other','Other','other');
    frame.getState().addToolGroup('fixture','Tool','tool');
    frame.getState().addTab('folder',{id:'a',title:'A',pinned:true,data:{path:'/repo/a'}},'folder-files');
    frame.getState().addTab('folder',{id:'b',title:'B',pinned:false,data:{path:'/repo/b'}},'folder-files');
    frame.getState().addTab('tool',{id:'tool-tab',title:'Tool tab'});
    frame.getState().setActiveGroup('folder');
    authority={workspace:{id:`ws-${++counter}`,name:'Workspace',revision:1,data:'{}'},...inventoryFromFrame(frame.getState().groups,`ws-${counter}`),storage:[],terminals:[]};
    requests=[]; workspaceApi.submitMutation=submit; workspaceApi.getSnapshot=async()=>structuredClone(authority);
    await sync.getState().connect(authority.workspace.id,structuredClone(authority));
  };
  const envelope = action => ({...action,id:crypto.randomUUID(),workspace_id:authority.workspace.id,client_id:'test',base_revision:1,created_at:Date.now()});
  const ticks = () => new Promise(resolve=>setImmediate(resolve));
  t.after(async()=>{workspaceApi.submitMutation=submit;await sync.getState().flush();sync.getState().disconnect();await vite.close();dom.window.close();for(const [key,value]of original){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});

  await t.test('twelve inverse types restore assets, child tabs and actual previous pin state',async()=>{
    await reset();
    const cases=[
      ['folder/add',{id:'new',name:'New',path:'/new',position:5}],
      ['folder/remove',{id:'folder'}],
      ['folder/reorder',{folder_ids:['other','folder']}],
      ['folder/update-data',{id:'folder',name:'Changed',path:'/change',data:{changed:true}}],
      ['tab/open',{id:'new-tab',folder_id:'folder',title:'New',tab_type:'file',position:5}],
      ['tab/close',{id:'a',folder_id:'folder',page_id:'folder-files'}],
      ['tab/pin',{id:'a',folder_id:'folder',page_id:'folder-files',pinned:true}],
      ['tab/update',{id:'a',folder_id:'folder',page_id:'folder-files',title:'Changed',data:{extra:true}}],
      ['tool/open',{id:'new-tool',page_id:'fixture',name:'New tool',position:5}],
      ['tool/close',{id:'tool'}],
      ['tool/update-data',{id:'tool',name:'Renamed',data:{extra:true}}],
      ['workspace/rename',{name:'Renamed'}],
    ];
    const before=structuredClone(authority);
    const view = state => frameFromInventory(state,[]).map(group=>({...group,activePageId:null,activeTabId:null,pages:group.pages?.map(page=>({...page,activeTabId:null}))}));
    for(const [type,payload] of cases){
      const m=envelope({type,payload}); assert.ok(computeInvertedMutation(m,before).length,type);
      const restored=rollbackMutation(before,m);
      assert.deepEqual(view(restored),view(before),type);assert.equal(restored.workspace.name,before.workspace.name,type);
      assert.deepEqual(authority,before,'inverter must remain pure');
    }
    const duplicate=envelope({type:'tab/open',payload:{id:'a',folder_id:'folder',page_id:'folder-files',title:'A'}});
    assert.deepEqual(computeInvertedMutation(duplicate,before),[],'duplicate opens cannot close existing tabs');
    for (const [type,id] of [['folder/add','tool'],['tool/open','folder']]) {
      assert.deepEqual(rollbackMutation(before,envelope({type,payload:{id,name:'Conflict',page_id:'fixture'}})),before,'owner ID conflict must preserve existing child tabs');
    }

  });

  await t.test('native intent dispatch preserves ACK order, preview slot and local-only edits',async()=>{
    await reset();await actions.openTab('folder',{id:'c',title:'C',pinned:true,page_id:'folder-files'});
    const order=()=>frame.getState().groups.find(group=>group.id==='folder').pages.find(page=>page.id==='folder-files').tabs.map(tab=>tab.id);
    assert.deepEqual(order(),['c','b','a']);await sync.getState().flush();assert.deepEqual(order(),['c','b','a']);
    assert.equal(requests.filter(m=>m.type==='tab/open').length,1);
    frame.getState().openPreviewTab({id:'preview',title:'Preview'});
    assert.deepEqual(order(),['c','preview','a']);await sync.getState().flush();assert.deepEqual(order(),['c','preview','a']);
    const count=requests.length;
    frame.getState().updateTab('folder','a',{data:{isDirty:true,line:12,column:2}},'folder-files');frame.getState().setActiveTab('folder','a','folder-files');
    await sync.getState().flush();assert.equal(requests.length,count);
    frame.getState().reorderCurrentTabs('a','c');await sync.getState().flush();assert.deepEqual(order(),['a','c','preview']);
    sync.getState().disconnect();frame.getState().addFolderGroup('/detached','Detached');assert.equal(sync.getState().outbox.length,0);
    const source=await readFile(new URL('../src/stores/workspace-sync-store.ts',import.meta.url),'utf8');
    assert.doesNotMatch(source,/useFrameStore\.subscribe|diffInventory|applyingRemote/);
  });

  await t.test('folder metadata updates preserve authoritative order when Home is visible',async()=>{
    await reset();
    const positions=authority.folders.map(({id,position})=>({id,position}));
    frame.getState().showHomePage();
    frame.getState().updateGroupData('folder',{encoding:'utf8'});
    await sync.getState().flush();
    assert.deepEqual(authority.folders.map(({id,position})=>({id,position})),positions);
    assert.equal(JSON.parse(authority.folders.find(folder=>folder.id==='folder').data).encoding,'utf8');
  });

  for(const status of [400,404,409,410]) await t.test(`${status}: rollback precedes stalled snapshot and preserves later intent`,async()=>{
    await reset();let reject, refreshed=false, finishRefresh;
    workspaceApi.submitMutation=()=>new Promise((_,fail)=>{reject=fail;});
    workspaceApi.getSnapshot=()=>{refreshed=true;return new Promise(resolve=>{finishRefresh=resolve;});};
    frame.getState().removeTab('folder','a','folder-files');frame.getState().addTab('folder',{id:'later',title:'Later'},'folder-files');
    reject(status===409 ? Object.assign(new Error('conflict'),{status}) : new ApiError('rejected',status,{}));
    await ticks();assert.ok(refreshed);
    const tabs=frame.getState().groups.find(group=>group.id==='folder').pages.find(page=>page.id==='folder-files').tabs;
    assert.ok(tabs.some(tab=>tab.id==='a'));assert.ok(tabs.some(tab=>tab.id==='later'));assert.equal(sync.getState().outbox.length,1);
    workspaceApi.submitMutation=submit;finishRefresh(structuredClone(authority));await sync.getState().flush();assert.equal(sync.getState().outbox.length,0);
  });

  await t.test('rollback rebases over peers even when refresh fails',async()=>{
    await reset();let reject;workspaceApi.submitMutation=()=>new Promise((_,fail)=>{reject=fail;});workspaceApi.getSnapshot=async()=>{throw new TypeError('offline');};
    frame.getState().updateTab('folder','a',{title:'Local'},'folder-files');
    const peer=envelope({type:'tab/update',payload:{...authority.tabs.find(tab=>tab.id==='a'),title:'Peer',data:{peer:true}}});
    authority=reduceInventory(authority,peer);authority.workspace.revision=2;sync.getState().applyRemoteMutation(peer,2);
    reject(new ApiError('conflict',409,{}));await sync.getState().flush();
    const tab=frame.getState().groups.find(group=>group.id==='folder').pages[0].tabs.find(tab=>tab.id==='a');
    assert.equal(tab.title,'Peer');assert.equal(tab.data.peer,true);assert.equal(sync.getState().outbox.length,0);
  });

  await t.test('large queued batches advance unsent bases without altering attempted retries',async()=>{
    await reset();const bases=[];
    workspaceApi.submitMutation=async mutation=>{bases.push(mutation.base_revision);assert.equal('attempted' in mutation,false);return submit(mutation);};
    sync.getState().dispatchBatch(Array.from({length:510},(_,index)=>({type:'workspace/rename',payload:{name:`Name ${index}`}})));
    await sync.getState().flush();assert.equal(bases.length,510);assert.deepEqual(bases,Array.from({length:510},(_,index)=>index+1));
    let attempted;
    workspaceApi.submitMutation=async mutation=>{attempted=mutation;throw new TypeError('offline');};
    await sync.getState().dispatch('workspace/rename',{name:'Offline'});await sync.getState().flush();
    const originalBase=attempted.base_revision;
    sync.setState({revision:originalBase+100});
    workspaceApi.submitMutation=async mutation=>{assert.equal(mutation.base_revision,originalBase);return submit(mutation);};
    await ticks();await sync.getState().flush();
  });

  await t.test('compacted snapshot hydrates without echo and advances socket cursor',async()=>{
    await reset();const snapshot=structuredClone(authority);snapshot.workspace.revision=2000;
    snapshot.folders.push({id:'remote',workspace_id:snapshot.workspace.id,path:'/remote',name:'Remote',position:3,data:'{}'});
    Socket.instances.at(-1).receive({type:'workspace:snapshot',snapshot,revision:2000});
    assert.equal(sync.getState().revision,2000);assert.ok(frame.getState().groups.some(group=>group.id==='remote'));assert.equal(requests.length,0);
    Socket.instances.at(-1).close();await ticks();workspaceApi.getSnapshot=async()=>snapshot;await sync.getState().refresh();
    assert.equal(new URL(Socket.instances.at(-1).url).searchParams.get('after'),'2000');
  });
});
