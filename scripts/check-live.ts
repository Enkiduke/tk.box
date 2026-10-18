import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {EncoderBudget} from '../apps/server/src/streaming/policy.js';
import {LocalMediaWorker,runProcess} from '../apps/server/src/streaming/ffmpeg.js';
import {DiskSegments} from '../apps/server/src/streaming/disk-segments.js';
import {LiveViewers} from '../apps/server/src/streaming/live-viewers.js';
import {renderManifest} from '../apps/server/src/streaming/buffer.js';
import {FixtureBroadcast} from './lib/fixture-broadcast.js';

const root=resolve('.local/live-spike');await mkdir(root,{recursive:true});const run=await mkdtemp(join(root,'check-'));
const db=openDatabase(':memory:'),budget=new EncoderBudget(()=>2),store=new DiskSegments(join(run,'cache'),2*1024*1024,()=>30000,0);await store.initialize();
const worker=new LocalMediaWorker(budget,process.env.FFMPEG_PATH??'ffmpeg',process.env.FFPROBE_PATH??'ffprobe');
const broadcast=new FixtureBroadcast(db,join(run,'work'),store,worker,{a:join(root,'source-a.mp4'),b:join(root,'source-b.avi')});
const viewers=new LiveViewers(store,()=>30000,async()=>{}),a=viewers.create('a',Date.now()),b=viewers.create('b',Date.now());
let pausedAt:number|undefined,resumedAt:number|undefined,crossed=false,warmupMs=0,peakBytes=0;
try{
  console.log('Running a 17-second real-clock playout and retained-media check.');
  while(Date.now()-broadcast.anchor<17000){
    await broadcast.tick();assert.equal(broadcast.failure,undefined);const now=Date.now(),elapsed=now-broadcast.anchor;peakBytes=Math.max(peakBytes,store.bytes);
    if(!pausedAt&&store.available(now).length){warmupMs=elapsed;pausedAt=store.available(now)[0]!.start+500;viewers.pause(a,'a',pausedAt,now);}
    if(pausedAt&&elapsed>=6500&&!resumedAt){assert.equal(viewers.state(a,'a',now).cursor,pausedAt);viewers.resume(a,'a',now);resumedAt=now;}
    if(resumedAt){const state=viewers.state(a,'a',now);assert.ok(Math.abs(state.cursor-(pausedAt!+now-resumedAt))<1);if(state.cursor>=broadcast.anchor+8000)crossed=true;}
    assert.equal(viewers.state(b,'b',now).state,'LIVE');await delay(100);
  }
  assert.ok(pausedAt&&resumedAt&&crossed,'Delayed cursor must cross the real program boundary.');
  const now=Date.now();assert.ok((await viewers.manifest(a,'a',now)).includes('#EXT-X-START'));await assert.rejects(viewers.segment(a,'b','s-0.ts',now),{code:'SESSION_NOT_FOUND'});
  const snapshot=join(run,'snapshot');await mkdir(snapshot);
  const segments=store.available(now);
  for(const s of segments)await writeFile(join(snapshot,s.uri),(await store.read(s.uri,now,async()=>{})).bytes);
  const file=join(snapshot,'index.m3u8');await writeFile(file,renderManifest(segments,true));
  const decoded=await runProcess(process.env.FFMPEG_PATH??'ffmpeg',['-hide_banner','-loglevel','warning','-i',file.replaceAll('\\','/'),'-progress','pipe:1','-f','null','-']);
  const frames=Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);assert.equal(frames,segments.length*50);assert.equal(decoded.packetCorruptionWarnings,0);
  viewers.goLive(a,'a',Date.now());assert.equal(viewers.state(a,'a',Date.now()).state,'LIVE');
  const workerStarts=broadcast.workerStarts;assert.ok(workerStarts<=3,'Two viewers must share per-program work.');await broadcast.stop();assert.equal(store.bytes,0);assert.equal(budget.count,0);
  const later=Date.now()+4000;assert.ok(broadcast.scheduler.current('fixture-live',later).offsetMs>=0);assert.equal(broadcast.workerStarts,workerStarts);
  const report={generatedAt:new Date().toISOString(),warmupMs,realClockDurationMs:17000,pausedCursorHeld:true,delayedCursorCrossedBoundary:crossed,independentLiveViewer:true,goLive:true,sharedWorkerStarts:workerStarts,decodedFrames:frames,packetCorruptionWarnings:decoded.packetCorruptionWarnings,peakCacheBytes:peakBytes,cacheBytesAfterStop:store.bytes,encoderPermitsAfterStop:budget.count,maxSegmentPublicationLagMs:broadcast.maxPublishLagMs,limitation:'Generated 320x180 sources only; browser and real Plex/provider/host checks are separate.'};
  await writeFile(join(root,'continuous-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await broadcast.stop();db.close();await rm(run,{recursive:true,force:true});}
