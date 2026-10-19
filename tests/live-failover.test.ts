import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiClientError,type api} from '../apps/web/src/api.js';
import {LiveFailover,LivePlaybackWatchdog,type LiveSession} from '../apps/web/src/live-failover.js';

const feed=(id:string)=>({id,name:id,number:1});
const session=(id:string):LiveSession=>({kind:'live',id:`session-${id}`,streamUrl:`/${id}.m3u8`,delivery:'remux',channel:{...feed(id),stack:'source:station',feeds:['primary','backup','third'].map(feed)},program:'Now airing'});
type Call={path:string;method:string;body?:unknown};
function transport(handle:(call:Call)=>unknown|Promise<unknown>) {
  const calls:Call[]=[];
  const request=(async(path:string,method='GET',body?:unknown)=>{const call={path,method,body};calls.push(call);return handle(call);}) as typeof api;
  return {request,calls};
}
const lineup=(...ids:string[])=>({channels:[{...feed(ids[0]!),stack:'source:station',feeds:ids.map(feed)}]});
const tuned=(call:Call)=>(call.body as {channelId:string}).channelId;

test('live failover releases the failed session, skips broken backups, and preserves station context',async()=>{
  const {request,calls}=transport(call=>{
    if(call.method==='GET')return lineup('primary','backup','third');
    if(call.method==='DELETE')return {};
    if(tuned(call)==='backup')throw new ApiClientError('Offline','LIVE_TUNE_FAILED',502);
    return session(tuned(call));
  });
  const result=await new LiveFailover(request).recover(session('primary'),()=>true);
  assert.equal(result?.channel.id,'third');assert.equal(result?.program,'Now airing');assert.equal(result?.channel.stack,'source:station');
  assert.deepEqual(calls.map(c=>[c.method,c.path]),[['GET','/iptv/channels'],['DELETE','/live/sessions/session-primary'],['POST','/live/sessions'],['POST','/live/sessions']]);
  assert.deepEqual(calls.filter(c=>c.method==='POST').map(tuned),['backup','third']);
});

test('subsequent failures try each feed only once, and a deliberate tune starts a new budget',async()=>{
  const {request,calls}=transport(call=>call.method==='GET'?lineup('primary','backup','third'):call.method==='DELETE'?{}:session(tuned(call)));
  const recovery=new LiveFailover(request),second=await recovery.recover(session('primary'),()=>true);
  const third=await recovery.recover(second!,()=>true);
  assert.equal(third?.channel.id,'third');assert.equal(await recovery.recover(third!,()=>true),undefined);
  assert.deepEqual(calls.filter(c=>c.method==='POST').map(tuned),['backup','third']);
  assert.equal((await new LiveFailover(request).recover(session('primary'),()=>true))?.channel.id,'backup');
});

test('backup selection uses the current lineup and stays within the original station',async()=>{
  const {request,calls}=transport(call=>call.method==='GET'?{channels:[...lineup('third').channels,{...feed('other'),stack:'other-source:station',feeds:[feed('other')]}]}:call.method==='DELETE'?{}:session(tuned(call)));
  assert.equal((await new LiveFailover(request).recover(session('primary'),()=>true))?.channel.id,'third');
  assert.deepEqual(calls.filter(c=>c.method==='POST').map(tuned),['third']);
  const empty=transport(()=>({channels:[]}));
  assert.equal(await new LiveFailover(empty.request).recover(session('primary'),()=>true),undefined);
  assert.equal(empty.calls.length,1,'no replacement or stop when no backup is visible');
});

test('concurrent failures share one recovery and a cancelled late tune is reclaimed',async()=>{
  let finish!:(result:LiveSession)=>void;
  const pending=new Promise<LiveSession>(done=>{finish=done;});
  const {request,calls}=transport(call=>call.method==='GET'?lineup('primary','backup'):call.method==='DELETE'?{}:pending);
  const recovery=new LiveFailover(request),current=session('primary');
  const first=recovery.recover(current,()=>true),second=recovery.recover(current,()=>true);
  assert.equal(first,second);
  await new Promise(done=>setImmediate(done));recovery.cancel();finish(session('backup'));
  assert.equal(await first,undefined);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.equal(calls.at(-1)?.path,'/live/sessions/session-backup');assert.equal(calls.at(-1)?.method,'DELETE');
});

test('navigation during lineup refresh prevents a replacement from starting',async()=>{
  let current=true;
  const {request,calls}=transport(()=>{current=false;return lineup('primary','backup');});
  assert.equal(await new LiveFailover(request).recover(session('primary'),()=>current),undefined);
  assert.equal(calls.length,1);
});

test('account, rate limit and connection failures stop the chain instead of trying every feed',async()=>{
  for(const [code,status] of [['FORBIDDEN',403],['RATE_LIMITED',429],['LIVE_CONNECTIONS_FULL',503]] as const){
    const {request,calls}=transport(call=>{
      if(call.method==='GET')return lineup('primary','backup','third');
      if(call.method==='DELETE')return {};
      throw new ApiClientError('Unavailable',code,status);
    });
    await assert.rejects(new LiveFailover(request).recover(session('primary'),()=>true),{code});
    assert.equal(calls.filter(c=>c.method==='POST').length,1);
  }
});

test('a vanished failed session does not prevent trying a backup',async()=>{
  const {request}=transport(call=>{
    if(call.method==='GET')return lineup('primary','backup');
    if(call.method==='DELETE')throw new ApiClientError('Gone','SESSION_NOT_FOUND',404);
    return session(tuned(call));
  });
  assert.equal((await new LiveFailover(request).recover(session('primary'),()=>true))?.channel.id,'backup');
});

test('tuning moves past a feed that cannot start, and those feeds are not retried by later recovery',async()=>{
  const station={...feed('primary'),stack:'source:station',feeds:['backup','primary','third'].map(feed)};
  const {request,calls}=transport(call=>{
    if(call.method==='GET')return lineup('backup','primary','third');
    if(call.method==='DELETE')return {};
    if(tuned(call)!=='third')throw new ApiClientError('4K','QUALITY_NOT_PERMITTED',422);
    return session(tuned(call));
  });
  const recovery=new LiveFailover(request),result=await recovery.tune(station,'Now airing',()=>true);
  assert.equal(result?.channel.id,'third');assert.equal(result?.program,'Now airing');assert.equal(result?.channel.feeds?.length,3);
  assert.deepEqual(calls.map(tuned),['primary','backup','third'],'the chosen feed first, then the rest in order');
  assert.equal(await recovery.recover(result!,()=>true),undefined);
});

test('tuning reports the chosen feed\'s error when no feed starts, and stops on a non-feed error',async()=>{
  const station={...feed('primary'),stack:'source:station',feeds:['primary','backup'].map(feed)};
  const failing=transport(call=>{throw tuned(call)==='primary'?new ApiClientError('4K','QUALITY_NOT_PERMITTED',422):new ApiClientError('Offline','LIVE_TUNE_FAILED',502);});
  await assert.rejects(new LiveFailover(failing.request).tune(station,undefined,()=>true),{code:'QUALITY_NOT_PERMITTED'});
  assert.equal(failing.calls.length,2);
  const full=transport(()=>{throw new ApiClientError('Full','LIVE_CONNECTIONS_FULL',503);});
  await assert.rejects(new LiveFailover(full.request).tune(station,undefined,()=>true),{code:'LIVE_CONNECTIONS_FULL'});
  assert.equal(full.calls.length,1);
  const single=transport(call=>session(tuned(call)));
  assert.equal((await new LiveFailover(single.request).tune(feed('lone'),undefined,()=>true))?.channel.id,'lone');
});

test('live watchdog detects a stopped clock but allows progress, pauses, seeks and suspended browser timers',()=>{
  const watchdog=new LivePlaybackWatchdog();
  for(let now=0;now<20000;now+=2000)assert.equal(watchdog.check(now,10,false),false);
  assert.equal(watchdog.check(20000,10,false),true);
  assert.equal(watchdog.check(22000,11,false),false,'new video progress resets the timer');
  for(let now=24000;now<=60000;now+=2000)assert.equal(watchdog.check(now,11,true),false,'pause or seek');
  assert.equal(watchdog.check(62000,11,false),false,'resume has a fresh grace period');
  assert.equal(watchdog.check(120000,11,false),false,'browser suspension is not a stream failure');
  for(let now=122000;now<140000;now+=2000)assert.equal(watchdog.check(now,11,false),false);
  assert.equal(watchdog.check(140000,11,false),true);
});
