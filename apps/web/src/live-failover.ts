import {api,ApiClientError} from './api.js';

export type LiveFeed={id:string;name:string;number:number;quality?:string};
type Station={id:string;name:string;number:number;stack?:string;feeds?:LiveFeed[]};
export type LiveSession={kind:'live';id:string;streamUrl:string;delivery:'direct'|'remux'|'transcode';source?:{videoCodec?:string;audioCodec?:string;width?:number;height?:number};channel:Station;program?:string;timeshift?:boolean};
type Created=Omit<LiveSession,'kind'|'program'>;
// A broken/incompatible feed can be skipped; account, server and connection errors stop recovery.
const skippable=['LIVE_TUNE_FAILED','LIVE_TUNE_TIMEOUT','CHANNEL_NOT_FOUND','SOURCE_INCOMPATIBLE','QUALITY_NOT_PERMITTED','TRANSCODE_CAPACITY_REACHED'];

// One instance per deliberate tune. Failed feeds stay excluded until the viewer tunes again.
export class LiveFailover {
  private attempted=new Set<string>();
  private cancelled=false;
  private running?:Promise<LiveSession|undefined>;
  constructor(private request:typeof api=api) {}
  cancel(){this.cancelled=true;}
  // Opens the chosen feed, moving on to the station's other feeds when it cannot be started.
  // Resolves undefined when cancelled; rejects with the chosen feed's error when no feed starts.
  async tune(channel:Station,program:string|undefined,isCurrent:()=>boolean):Promise<LiveSession|undefined> {
    const ids=[channel.id,...(channel.feeds??[]).map(f=>f.id).filter(id=>id!==channel.id)];
    const {created,error}=await this.open(ids,()=>!this.cancelled&&isCurrent());
    if(created)return {...created,kind:'live',program,channel:{...created.channel,stack:channel.stack,feeds:channel.feeds}};
    if(error)throw error;
  }
  recover(current:LiveSession,isCurrent:()=>boolean):Promise<LiveSession|undefined> {
    return this.running??=this.run(current,isCurrent).finally(()=>{this.running=undefined;});
  }
  private async run(current:LiveSession,isCurrent:()=>boolean) {
    const active=()=>!this.cancelled&&isCurrent(),stack=current.channel.stack;
    if(!stack||!active())return;
    this.attempted.add(current.channel.id);
    // Refresh visibility: a feed hidden since tuning must not be picked from an old guide snapshot.
    const lineup=await this.request<{channels:Station[]}>('/iptv/channels');
    const station=lineup.channels.find(c=>c.stack===stack);
    const backups=station?.feeds?.filter(f=>!this.attempted.has(f.id))??[];
    if(!active()||!backups.length)return;
    // Release this viewer before opening a replacement, including on one-connection plans.
    try{await this.request(`/live/sessions/${current.id}`,'DELETE');}
    catch(e){if(!(e instanceof ApiClientError&&e.status===404))throw e;}
    const {created}=await this.open(backups.map(f=>f.id),active);
    if(created)return {...created,kind:'live' as const,program:current.program,channel:{...created.channel,stack,feeds:station!.feeds}};
  }
  // Tries each feed in order, keeping the first skipped error for when none starts.
  private async open(ids:string[],active:()=>boolean):Promise<{created?:Created;error?:ApiClientError}> {
    let error:ApiClientError|undefined;
    for(const id of ids) {
      if(!active())return {};
      this.attempted.add(id);
      let created:Created;
      try{created=await this.request('/live/sessions','POST',{channelId:id});}
      catch(e){if(e instanceof ApiClientError&&skippable.includes(e.code)){error??=e;continue;}throw e;}
      // A manual stop or channel change can happen during the request. Reclaim any late session.
      if(!active()){await this.request(`/live/sessions/${created.id}`,'DELETE').catch(()=>{});return {};}
      return {created};
    }
    return {error};
  }
}

// Detect streams that keep serving a playlist but no longer advance the video clock.
export class LivePlaybackWatchdog {
  private lastTime?:number;
  private progressedAt?:number;
  private checkedAt?:number;
  check(now:number,time:number,suspended:boolean) {
    const gap=this.checkedAt===undefined?0:now-this.checkedAt;this.checkedAt=now;
    if(suspended||this.lastTime===undefined||Math.abs(time-this.lastTime)>.05||gap>6000){this.lastTime=time;this.progressedAt=now;return false;}
    return now-this.progressedAt!>=20000;
  }
}
