import {mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {ChannelScheduler} from '../../apps/server/src/services/scheduler.js';
import type {Db} from '../../apps/server/src/persistence/database.js';
import {LocalMediaWorker,probeLocal} from '../../apps/server/src/streaming/ffmpeg.js';
import {DiskSegments} from '../../apps/server/src/streaming/disk-segments.js';
import {readGeneratedHls} from '../../apps/server/src/streaming/hls-files.js';
import {AppError,requireThat} from '../../apps/server/src/errors.js';
import {TsContinuity} from '../../apps/server/src/streaming/ts-continuity.js';

// Experimental playout of two fixed eight-second generated sources. It is never mounted
// by tk.box's app and is not a strategy for pre-encoding whole Plex movies.
export class FixtureBroadcast{
  readonly scheduler:ChannelScheduler;readonly anchor:number;
  private batch?:{dir:string;items:Awaited<ReturnType<typeof readGeneratedHls>>;published:Set<number>;end:number};
  private workDir?:string;
  private inFlight?:Promise<void>;private cancellation=new AbortController();private activatedAt?:number;
  private continuity=new TsContinuity();
  failure?:string;workerStarts=0;maxPublishLagMs=0;
  constructor(db:Db,private root:string,private store:DiskSegments,private worker:LocalMediaWorker,private sources:{a:string;b:string}){
    this.scheduler=new ChannelScheduler(db);
    const initial=db.prepare('SELECT effective_at FROM publications WHERE channel_id=? ORDER BY revision LIMIT 1').get('fixture-live') as {effective_at:number}|undefined;
    this.anchor=initial?.effective_at??Date.now();
    if(!initial)this.scheduler.publish('fixture-live',[
      {occurrenceId:'a',mediaId:'fixture-a',title:'Generated A',durationMs:8000,mediaOffsetMs:0},
      {occurrenceId:'b',mediaId:'fixture-b',title:'Generated B',durationMs:8000,mediaOffsetMs:0}
    ],0,this.anchor,'fixture');
  }
  private async removeBatch(){if(this.workDir){const dir=resolve(this.workDir),rel=relative(resolve(this.root),dir);requireThat(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'UNSAFE_CACHE_PATH','Work directory escapes the fixture root.');await rm(dir,{recursive:true,force:true});this.batch=undefined;this.workDir=undefined;}}
  tick(now=Date.now()):Promise<void>{
    if(this.inFlight)return this.inFlight;
    if(this.failure)return Promise.resolve(); // Capacity/policy failure remains terminal until explicit Retry.
    this.activatedAt??=now;
    this.inFlight=this.run(now).catch(e=>{if(!this.cancellation.signal.aborted)this.failure=e instanceof AppError?e.code:'FIXTURE_PLAYOUT_FAILED';}).finally(()=>{this.inFlight=undefined;});return this.inFlight;
  }
  private async publishReady(now:number){
    if(!this.batch)return;
    for(const item of this.batch.items){const s=item.segment;if(s.end>now||this.batch.published.has(s.sequence))continue;
      if(s.end>this.activatedAt!){await writeFile(item.mediaPath,this.continuity.rewrite(await readFile(item.mediaPath)));await this.store.publish(s,item.mediaPath,item.initPath);this.maxPublishLagMs=Math.max(this.maxPublishLagMs,now-s.end);}
      this.batch.published.add(s.sequence);
    }
    if(this.batch.end<=now&&this.batch.published.size===this.batch.items.length)await this.removeBatch();
  }
  private async run(now:number){
    this.cancellation.signal.throwIfAborted();await this.publishReady(now);await this.store.prune(now);
    const slot=this.scheduler.current('fixture-live',now);
    if(!this.batch){
      const dir=join(this.root,`program-${slot.start}`);this.workDir=dir;await mkdir(dir,{recursive:true});this.workerStarts++;
      const input=slot.entry.occurrenceId==='a'?this.sources.a:this.sources.b;
      const fixture=await probeLocal(input,process.env.FFPROBE_PATH??'ffprobe',this.cancellation.signal);
      requireThat(fixture.source.width===320&&fixture.source.height===180&&fixture.source.codec===(slot.entry.occurrenceId==='a'?'h264':'mpeg4')&&fixture.durationMs>=7900&&fixture.durationMs<=8200,'FIXTURE_PROFILE_REQUIRED','This experiment only accepts its generated eight-second 320x180 sources.');
      await this.worker.hls(input,dir,{kind:slot.entry.occurrenceId==='a'?'remux':'cpu',audioEncode:slot.entry.occurrenceId!=='a'},0,8000,{signal:this.cancellation.signal});
      const items=await readGeneratedHls(dir,{start:slot.start,programId:slot.entry.mediaId,revision:slot.revision,sequence:(slot.start-this.anchor)/2000,discontinuitySequence:(slot.start-this.anchor)/8000});
      requireThat(items.length===4&&Math.abs(items.at(-1)!.segment.end-slot.end)<1,'FIXTURE_TIMELINE_MISMATCH','Generated media does not match the fixed fixture schedule.');
      this.batch={dir,items,published:new Set(),end:slot.end};await this.publishReady(Date.now());
    }
  }
  async stop(){this.cancellation.abort();await this.inFlight;await this.removeBatch();await this.store.clear();this.activatedAt=undefined;this.cancellation=new AbortController();this.continuity=new TsContinuity();}
  async retry(){await this.inFlight;await this.removeBatch();this.failure=undefined;}
}
