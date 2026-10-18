import {api,ApiClientError} from './api.js';

export type LiveFeed={id:string;name:string;number:number;quality?:string};
type Station={id:string;name:string;number:number;stack?:string;feeds?:LiveFeed[]};
export type LiveSession={kind:'live';id:string;streamUrl:string;delivery:'direct'|'remux'|'transcode';source?:{videoCodec?:string;audioCodec?:string;width?:number;height?:number};channel:Station;program?:string};

// One instance per deliberate tune. Failed feeds stay excluded until the viewer tunes again.
export class LiveFailover {
  private attempted=new Set<string>();
  private cancelled=false;
  private running?:Promise<LiveSession|undefined>;
  constructor(private request:typeof api=api) {}
  cancel(){this.cancelled=true;}
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
    for(const feed of backups) {
      if(!active())return;
      this.attempted.add(feed.id);
      let created:Omit<LiveSession,'kind'|'program'>;
      try{created=await this.request('/live/sessions','POST',{channelId:feed.id});}
      catch(e){
        // A broken/incompatible feed can be skipped; account, server and connection errors stop recovery.
        if(e instanceof ApiClientError&&['LIVE_TUNE_FAILED','LIVE_TUNE_TIMEOUT','CHANNEL_NOT_FOUND','SOURCE_INCOMPATIBLE','QUALITY_NOT_PERMITTED','TRANSCODE_CAPACITY_REACHED'].includes(e.code))continue;
        throw e;
      }
      // A manual stop or channel change can happen during the request. Reclaim any late session.
      if(!active()){await this.request(`/live/sessions/${created.id}`,'DELETE').catch(()=>{});return;}
      return {...created,kind:'live' as const,program:current.program,channel:{...created.channel,stack,feeds:station!.feeds}};
    }
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
