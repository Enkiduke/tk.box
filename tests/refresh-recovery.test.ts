import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { SourceSnapshots } from '../apps/server/src/persistence/source-snapshots.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { parseM3u, parseXmltv } from '../apps/server/src/providers/iptv.js';
import { RecoveryController } from '../apps/server/src/streaming/recovery.js';
import { AppError } from '../apps/server/src/errors.js';
import { SharedPipelines } from '../apps/server/src/streaming/pipelines.js';

test('independent source intervals and encrypted last-good snapshots survive failures and restart', () => {
  const path = mkdtempSync(join(tmpdir(),'tk.box-sources-')), file = join(path,'cache.sqlite'), vault = new Vault(randomBytes(32)); let db = openDatabase(file);
  try {
    let cache = new SourceSnapshots(db,vault); cache.create('m3u','m3u',true,0); cache.create('xml','xmltv',true,0); cache.create('upload','xmltv',false,0);
    assert.equal(cache.status('m3u').interval_hours,12); assert.equal(cache.status('xml').interval_hours,6); assert.equal(cache.status('upload').next_due,null);
    const snapshot = parseM3u(readFileSync(new URL('./fixtures/live.m3u',import.meta.url),'utf8'));
    cache.commit('m3u',0,snapshot,true,100); cache.fail('m3u',200); assert.deepEqual(cache.snapshot('m3u'),snapshot);
    assert.throws(()=>cache.commit('m3u',1,{},false,300)); assert.equal(cache.status('m3u').revision,1);
    const guide = parseXmltv(readFileSync(new URL('./fixtures/guide.xml',import.meta.url),'utf8')); cache.commit('xml',0,guide,true,100);
    cache.setInterval('m3u',24,300); assert.equal(cache.status('xml').interval_hours,6);
    assert.throws(()=>cache.setInterval('m3u',.5,400)); assert.equal(cache.status('m3u').interval_hours,24);
    db.close(); db=openDatabase(file); cache=new SourceSnapshots(db,vault); assert.deepEqual(cache.snapshot('xml'),guide); assert.equal(cache.status('m3u').interval_hours,24);
    const raw=db.prepare('SELECT encrypted_snapshot FROM source_snapshots WHERE id=?').get('m3u') as {encrypted_snapshot:string}; assert.ok(!raw.encrypted_snapshot.includes('provider.invalid'));
  } finally {db.close();rmSync(path,{recursive:true,force:true});}
});
test('network recovery is coordinated once, exhausts finite budget, and only manual Retry resets terminal failure', async () => {
  const waited:number[]=[]; const recovery=new RecoveryController(async ms=>{waited.push(ms);}); let connections=0;
  const connect=async()=>{connections++;throw new AppError('UPSTREAM_TIMEOUT','fixture');};
  const results=await Promise.allSettled(Array.from({length:6},()=>recovery.recover('UPSTREAM_DISCONNECTED',connect)));
  assert.ok(results.every(r=>r.status==='rejected'));assert.equal(connections,3);assert.deepEqual(waited,[2000,5000,10000]);assert.equal(recovery.state,'failed');
  await assert.rejects(recovery.recover('UPSTREAM_TIMEOUT',connect),{code:'RETRY_REQUIRED'}); assert.equal(connections,3);
  recovery.manualRetry();await recovery.recover('UPSTREAM_TIMEOUT',async()=>{connections++;});assert.equal(recovery.state,'active');assert.equal(recovery.attemptCount,1);
  recovery.markStable(1000);assert.equal(recovery.attemptCount,1);recovery.markStable(30000);assert.equal(recovery.attemptCount,0);
});
test('capacity, policy, rate limit and cancellation do not create extra recovery attempts', async () => {
  for(const code of ['TRANSCODE_CAPACITY_REACHED','QUALITY_NOT_PERMITTED','HTTP_429','IPTV_CONNECTION_LIMIT']){
    let calls=0;const recovery=new RecoveryController(async()=>{calls++;});await assert.rejects(recovery.recover(code,async()=>{calls++;}));assert.equal(calls,0);
  }
  const recovery=new RecoveryController(async(_ms,signal)=>{recovery.stop();signal.throwIfAborted();});let calls=0;
  await assert.rejects(recovery.recover('UPSTREAM_TIMEOUT',async()=>{calls++;}),{code:'RECOVERY_STOPPED'});assert.equal(calls,0);
});
test('joining while final upstream closes waits for cleanup, then starts a new permitted connection',async()=>{
  const registry=new SharedPipelines(),key={sourceId:'source',channelId:'station',credentialScope:'scope',rendition:'original',tracks:'default',protocol:'hls'},policy={sharingAllowed:true,maxConnections:1};
  let finishStop:()=>void=()=>{}, starts=0;
  const first=await registry.join(key,policy,'a',async()=>{},async()=>{starts++;return{stop:()=>new Promise<void>(resolve=>{finishStop=resolve;})};});
  const closing=first();await Promise.resolve();await Promise.resolve();
  const second=registry.join(key,policy,'b',async()=>{},async()=>{starts++;return{stop:async()=>{}};});
  await Promise.resolve();assert.equal(starts,1);finishStop();await closing;const release=await second;assert.equal(starts,2);await release();
});
