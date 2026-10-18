import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const dir = await mkdtemp(join(tmpdir(),'tk.box-built-'));
const port = await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const address=s.address();assert.ok(address&&typeof address==='object');s.close(()=>done(address.port));});});
const env = {...process.env, APP_HOST:'127.0.0.1',APP_PORT:String(port),DEPLOYMENT_MODE:'local',DATA_DIR:dir,CACHE_DIR:join(dir,'cache'),TRUSTED_PROXY_CIDRS:''};
for(const key of ['PUBLIC_BASE_URL','SECRET_KEY_FILE','PLEX_MACHINE_ID','PLEX_OWNER_ACCOUNT_ID','PLEX_REQUIRED_LIBRARY_IDS']) delete env[key as keyof typeof env];
const launch=()=>spawn(process.execPath,['dist/apps/server/src/index.js'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const first=launch();let firstLogs='';first.stdout.on('data',b=>{firstLogs+=String(b);});first.stderr.on('data',b=>{firstLogs+=String(b);});
try {
  const until=Date.now()+10000;let ready=false;
  while(Date.now()<until&&!ready){try{ready=(await fetch(`http://127.0.0.1:${port}/health`)).ok;}catch{}if(!ready)await delay(50);}
  assert.ok(ready,`Compiled server did not become healthy: ${firstLogs}`);
  const html=await fetch(`http://127.0.0.1:${port}/`);assert.equal(html.status,200);assert.ok((await html.text()).includes('id="root"'));
  const setup=await fetch(`http://127.0.0.1:${port}/api/v1/setup`);assert.equal((await setup.json() as {plexConfigured:boolean}).plexConfigured,false);
  const protectedRoute=await fetch(`http://127.0.0.1:${port}/api/v1/libraries`);assert.equal(protectedRoute.status,401);
  for(const route of ['/api/v1/iptv/channels','/api/v1/admin/iptv/sources'])assert.equal((await fetch(`http://127.0.0.1:${port}${route}`)).status,401);
  const second=launch();let logs='';second.stdout.on('data',b=>{logs+=String(b);});second.stderr.on('data',b=>{logs+=String(b);});
  const secondExit=once(second,'exit');const timeout=setTimeout(()=>second.kill('SIGKILL'),10000);
  const [code]=await secondExit;clearTimeout(timeout);assert.equal(code,1);assert.ok(logs.includes('EADDRINUSE'));
  assert.ok(!firstLogs.includes('fixture-account-token'));
  console.log('Compiled server: configurable listener, frontend/health, protected API and explicit port-collision failure passed.');
} finally {if(first.exitCode===null&&first.signalCode===null){const exited=once(first,'exit');first.kill('SIGTERM');await exited;}await rm(dir,{recursive:true,force:true});}
