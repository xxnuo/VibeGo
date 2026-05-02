import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const port=process.env.BLOCKTERM_TEST_PORT||'29731';
const base=`http://127.0.0.1:${port}`;
const cache=await mkdtemp(join(tmpdir(),'blockterm-vite-'));
const server=spawn(process.execPath,['--input-type=module','-e',`import {createServer} from 'vite'; const server=await createServer({cacheDir:process.env.BLOCKTERM_VITE_CACHE,server:{host:'127.0.0.1',port:Number(process.env.BLOCKTERM_TEST_PORT),strictPort:true}}); await server.listen(); process.send({ready:true});`],{cwd,stdio:['inherit','inherit','inherit','ipc'],env:{...process.env,BLOCKTERM_VITE_CACHE:cache,BLOCKTERM_TEST_PORT:port}});
let startupError;
let ownServerReady=false;
server.on('message',message=>{if(message.ready) ownServerReady=true;});
server.on('error',error=>{startupError=error;});
const exited=once(server,'exit');
try {
  let ready=false;
  for(let attempt=0;attempt<150;attempt++) {
    if(startupError) throw startupError;
    if(server.exitCode!==null) throw Error(`Vite exited: ${server.exitCode}`);
    if(ownServerReady) try {ready=(await fetch(`${base}/@vite/client`,{signal:AbortSignal.timeout(1000)})).ok;} catch {}
    if(ready) break;
    await delay(200);
  }
  if(!ready) throw Error('Vite did not become ready');
  let ran=0;
  for(const script of ['blockterm-v2-wrap-layout-smoke.mjs','blockterm-v2-checkpoint-buffer-smoke.mjs','blockterm-v2-saved-charset-smoke.mjs','blockterm-v2-saved-style-smoke.mjs','blockterm-v2-checkpoint-cell-smoke.mjs','blockterm-v2-unicode-probe.mjs','blockterm-v2-control-limit-smoke.mjs','blockterm-v2-gap-smoke.mjs','blockterm-v2-drafts-smoke.mjs','blockterm-v2-text-smoke.mjs','blockterm-v2-exit-smoke.mjs','blockterm-v2-virtual-smoke.mjs']) {
    if(process.env.BLOCKTERM_SMOKE_ONLY && script!==process.env.BLOCKTERM_SMOKE_ONLY) continue;
    ran++;
    const child=spawn(process.execPath,[`tests/${script}`],{cwd,stdio:'inherit',env:{...process.env,BLOCKTERM_URL:base,BLOCKTERM_VITE_DEPS:`/@fs${cache}/deps`}});
    const [code,signal]=await once(child,'exit');
    if(code!==0) throw Error(`${script} failed: ${code??signal}`);
  }
  if(!ran) throw Error('BLOCKTERM_SMOKE_ONLY did not match a smoke test');
} finally {
  if(server.exitCode===null) server.kill('SIGTERM');
  const kill=setTimeout(()=>server.kill('SIGKILL'),5000);
  try {await exited;} finally {clearTimeout(kill);await rm(cache,{recursive:true,force:true});}
}
