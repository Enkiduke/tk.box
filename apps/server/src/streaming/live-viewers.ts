import {opaque} from '../security/vault.js';
import {requireThat} from '../errors.js';
import {ViewerCursor,renderManifest} from './buffer.js';
import type {DiskSegments} from './disk-segments.js';

type Viewer={id:string;owner:string;cursor:ViewerCursor;expires:number};
export class LiveViewers{
  private viewers=new Map<string,Viewer>();
  constructor(private store:DiskSegments,private retentionMs:()=>number,private authorize:(owner:string,programId:string)=>Promise<void>,private leaseMs=45000){}
  create(owner:string,now:number){requireThat(this.viewers.size<100,'VIEWER_LIMIT','Fixture viewer limit reached.',429);const id=opaque();this.viewers.set(id,{id,owner,cursor:new ViewerCursor(this.store.index,this.retentionMs),expires:now+this.leaseMs});return id;}
  private owned(id:string,owner:string,now:number){const v=this.viewers.get(id);requireThat(v&&v.owner===owner&&v.expires>now,'SESSION_NOT_FOUND','Viewing session expired or unavailable.',404);v.expires=now+this.leaseMs;return v;}
  state(id:string,owner:string,now:number){const v=this.owned(id,owner,now);return {...v.cursor.inspect(now),broadcastNowUtc:now,bufferStartUtc:this.store.index.start,bufferEndUtc:this.store.index.end,bufferBytes:this.store.bytes};}
  pause(id:string,owner:string,displayedUtc:number,now:number){requireThat(Number.isFinite(displayedUtc),'INVALID_CURSOR','Invalid presentation time.');this.owned(id,owner,now).cursor.pause(displayedUtc,now);return this.state(id,owner,now);}
  resume(id:string,owner:string,now:number){this.owned(id,owner,now).cursor.resume(now);return this.state(id,owner,now);}
  goLive(id:string,owner:string,now:number){this.owned(id,owner,now).cursor.goLive();return this.state(id,owner,now);}
  async manifest(id:string,owner:string,now:number){
    const v=this.owned(id,owner,now);await this.store.prune(now);const state=v.cursor.inspect(now);
    requireThat(state.state!=='EXPIRED','BUFFER_EXPIRED','Buffer expired. Go Live to continue.',410);
    const all=this.store.available(now);requireThat(all.length>0,'STREAM_WARMING','Waiting for a completed live segment.',503);
    const latest=all.at(-1)!;
    const cursor=state.state==='LIVE'?Math.max(latest.start,Math.min(latest.end-250,now-3000)):state.cursor;
    const segments=state.state==='LIVE'?all.slice(-3):all.filter(s=>s.end>cursor);
    for(const program of new Set(segments.map(s=>s.programId)))await this.authorize(owner,program);
    return renderManifest(segments,false,cursor);
  }
  async segment(id:string,owner:string,uri:string,now:number){const v=this.owned(id,owner,now);requireThat(v.cursor.inspect(now).state!=='EXPIRED','BUFFER_EXPIRED','Buffer expired. Go Live to continue.',410);return this.store.read(uri,now,program=>this.authorize(owner,program));}
  stop(id:string,owner:string,now:number){const v=this.owned(id,owner,now);v.cursor.stop();this.viewers.delete(id);}
  reap(now:number){for(const [id,v] of this.viewers)if(v.expires<=now){v.cursor.stop();this.viewers.delete(id);}}
  get count(){return this.viewers.size;}
  activeCount(now:number){return [...this.viewers.values()].filter(v=>v.expires>now&&v.cursor.inspect(now).state!=='EXPIRED').length;}
}
