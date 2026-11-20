import {useEffect,useState} from 'react';
import {api,ApiClientError} from './api.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {Panel} from './manage-ui.js';
import {qualityTiers} from '../../../packages/contracts/src/playback.js';
import {ACTIVITY_REFRESH_MS,activityElapsed,activityPosition,formatActivityTime,useActivityClock,type ActivityTiming} from './activity-time.js';
import './activity.css';

type Source={videoCodec?:string;audioCodec?:string;width?:number;height?:number;container?:string;bitrateKbps?:number};
type Media={title:string;type:string;year?:number;show?:string;album?:string;season?:number;episode?:number;durationMs?:number;posterId?:string};
// `plex` rows are other Plex apps' streams, read from Plex; they carry Plex's own video and audio descriptions.
type Stream=ActivityTiming&{id:string;kind:'vod'|'live'|'custom'|'plex';user:string;client:string;ip:string;local:boolean;startedAt?:number;delivery:'direct'|'remux'|'transcode';
  canStop:boolean;video?:string;audio?:string;speed?:number;live?:boolean;
  quality?:string;target?:{maxHeight?:number;maxBitrateKbps?:number};rateKbps:number;source?:Source;channelId?:string;channel?:{name:string;number:number};
  media?:Media;program?:string;behindLiveMs?:number};
type View={streams:Stream[];transcodes:number;bandwidthKbps:number;wanBandwidthKbps:number;plexError?:string};

const delivery={direct:'Direct play',remux:'Direct stream',transcode:'Transcode'} as const;
const kinds={vod:'Library',live:'Live TV',custom:'Custom channel',plex:'Plex app'} as const;
const states={playing:'Playing',paused:'Paused',buffering:'Buffering'} as const;
const mbps=(kbps:number)=>`${(kbps/1000).toFixed(1)} Mbps`;
const resolution=(s?:Source)=>!s?.height?undefined:(s.height>=2000||(s.width??0)>=3800)?'4K':`${s.height>=1000||(s.width??0)>=1900?1080:s.height>=700||(s.width??0)>=1260?720:s.height}p`;
const codec=(c?:string)=>c?.toUpperCase();
const qualityName=(q?:string)=>{const tier=qualityTiers.find(t=>t.id===q);return tier?`${tier.height}p · ${mbps(tier.bitrateKbps)}`:q==='original'?'Original':'Auto';};
const clock=new Intl.DateTimeFormat(undefined,{timeStyle:'short'});

// What everyone is watching right now, in tk.box (library, IPTV, custom channels) and in any other Plex app,
// re-read every few seconds while the page is visible. Admin › Activity keeps it on every tab for the count.
export function useLiveActivity() {
  const [view,setView]=useState<View&{receivedAt:number}>(),[error,setError]=useState<string>(),[version,setVersion]=useState(0);
  const now=useActivityClock(!!view?.streams.length);
  useEffect(()=>{
    let live=true;
    const load=()=>api<View>('/admin/activity').then(v=>{if(live){setView({...v,receivedAt:Date.now()});setError(undefined);}},(e:ApiClientError)=>{if(live)setError(e.message);});
    void load();const timer=window.setInterval(()=>{if(!document.hidden)void load();},ACTIVITY_REFRESH_MS);
    return()=>{live=false;window.clearInterval(timer);};
  },[version]);
  const summary=view&&(view.streams.length
    ?`${view.streams.length} ${view.streams.length===1?'stream':'streams'}${view.transcodes?` · ${view.transcodes} transcoding`:''} · ${mbps(view.bandwidthKbps)}${view.wanBandwidthKbps?` (${mbps(view.wanBandwidthKbps)} WAN)`:''}`
    :'Nothing playing');
  return {view,error,setError,now,elapsedMs:view?activityElapsed(now,view.receivedAt):0,summary,reload:()=>setVersion(v=>v+1)};
}
export type LiveActivity=ReturnType<typeof useLiveActivity>;

export function NowPlaying({live}:{live:LiveActivity}) {
  const {view,error,now,elapsedMs,reload,setError}=live;
  return <>
    {error&&<ErrorNotice message={error} retry={reload}/>}
    {view?.plexError&&<p className="notice">{view.plexError}</p>}
    {!view?(!error&&<Loading/>):view.streams.length===0?<Panel><div className="ui-empty">Nothing playing</div></Panel>:
      <section className="activity-grid" aria-label="Live activity">{view.streams.map(s=><StreamCard key={s.id} stream={s} now={now} elapsedMs={elapsedMs} ended={reload} failed={setError}/>)}</section>}
  </>;
}

function StreamCard({stream:s,now,elapsedMs,ended,failed}:{stream:Stream;now:number;elapsedMs:number;ended:()=>void;failed:(message:string)=>void}) {
  const [stopping,setStopping]=useState(false),src=s.source,res=resolution(src);
  const name=s.channel?`${s.channel.number} · ${s.channel.name}`:undefined;
  const m=s.media,title=m?(m.type==='episode'?m.show??m.title:m.title):s.program??name??'Unknown';
  const episode=m?.season!=null&&m.episode!=null?`S${m.season}E${m.episode}`:undefined;
  const detail=m?(m.type==='episode'?[m.show&&m.title,episode].filter(Boolean).join(' · '):m.type==='track'?[m.show,m.album].filter(Boolean).join(' · '):m.year?.toString()):undefined;
  const subtitle=[detail,title!==name?name:undefined].filter(Boolean).join(' · ');
  const kind=s.kind==='plex'&&s.live?'Plex Live TV':kinds[s.kind];
  const poster=m?.posterId?`/api/v1/catalog/items/${m.posterId}/artwork?kind=poster`:s.channelId?`/api/v1/iptv/channels/${s.channelId}/logo`:undefined;
  // Live relays always convert audio to AAC; library streams that are not direct may too, so only the source is named.
  const video=[codec(src?.videoCodec),res].filter(Boolean).join(' '),target=s.target?.maxHeight?`${s.target.maxHeight}p`:'';
  const videoLine=s.kind==='plex'?s.video:s.delivery==='transcode'?`Transcode (${video||'source'} → H264${target?` ${target}`:''})`:s.delivery==='remux'?`Copy (${video||'source'})`:`Direct play (${video||'source'})`;
  const audioLine=s.kind==='plex'?s.audio:src?.audioCodec?(s.kind==='vod'?codec(src.audioCodec):`${codec(src.audioCodec)} → AAC`):undefined;
  const stop=()=>{
    if(!window.confirm(`Stop ${s.user}’s stream of ${title}?`))return;
    setStopping(true);
    api(`/admin/activity/${s.id}`,'DELETE').then(ended,(e:ApiClientError)=>{setStopping(false);if(e.status===404)ended();else failed(e.message);});
  };
  const playback=activityPosition(s,elapsedMs);
  const time=playback?.time??(s.startedAt!==undefined?`Connected ${formatActivityTime(now-s.startedAt)}`:undefined);
  // Time left at normal speed, and when it ends if it keeps playing.
  const leftMs=s.positionMs!==undefined&&s.durationMs?Math.max(0,s.durationMs-s.positionMs-(s.state==='playing'?elapsedMs:0)):undefined;
  const left=leftMs!==undefined?`${formatActivityTime(leftMs)} left${s.state==='playing'?` · ends ${clock.format(now+leftMs)}`:''}`:undefined;
  const behindLiveMs=s.behindLiveMs===undefined?undefined:s.behindLiveMs+(s.state==='paused'?elapsedMs:0);
  const bandwidth=s.state==='paused'&&!s.rateKbps?'Paused':`${s.delivery==='direct'&&s.kind!=='plex'?'~':''}${mbps(s.rateKbps)}`;
  const rows:[string,string|undefined][]=[
    ['Playback time',time],['Remaining',left],['Video',videoLine],['Audio',audioLine],['Speed',s.speed?.toFixed(1)],
    ['Quality',s.kind==='vod'?`${qualityName(s.quality)}${src?.bitrateKbps?` (source ${mbps(src.bitrateKbps)})`:''}`:undefined],
    ['Behind live',behindLiveMs?formatActivityTime(behindLiveMs):undefined],
    ['Location',`${s.local?'LAN':'WAN'}: ${s.ip}`],
    ['Bandwidth',bandwidth]
  ];
  // Streams watched in tk.box stand out from those in other Plex apps.
  return <article className={`activity-card${s.kind==='plex'?'':' tkbox'}`}>
    <div className="activity-body">
      <div className={`activity-poster ${m?.posterId?'':'logo'}`}>{poster?<img src={poster} alt="" loading="lazy" onError={e=>{e.currentTarget.style.visibility='hidden';}}/>:<Icon name={s.kind==='live'||s.kind==='custom'||s.live?'live':'movies'} size={21}/>}</div>
      <div className="activity-info">
        <strong title={title}>{title}</strong>
        {subtitle&&<small title={subtitle}>{subtitle}</small>}
        <small title={[s.user,s.client].filter(Boolean).join(' · ')}><b>{s.user}</b>{s.client?` · ${s.client}`:''}</small>
        <small className="activity-state" title={`${states[s.state]} · ${kind} · ${delivery[s.delivery]}`}>
          <span data-state={s.state}>{states[s.state]}</span> · {kind} · <span data-delivery={s.delivery}>{delivery[s.delivery]}</span>
        </small>
      </div>
      {s.canStop&&<button type="button" className="icon-button activity-stop" aria-label={`Stop ${s.user}’s stream`} title="Stop this stream" disabled={stopping} onClick={stop}><Icon name="close" size={16}/></button>}
    </div>
    <div className="activity-facts">
      {videoLine&&<span title={[videoLine,audioLine].filter(Boolean).join(' · ')}>{videoLine}</span>}
      <span>{s.local?'LAN':'WAN'} · {bandwidth}{left?` · ${left}`:''}</span>
    </div>
    <details className="activity-disclosure">
      <summary>Stream details</summary>
      <dl className="activity-details">{rows.filter(([,v])=>v).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </details>
    {playback&&<div className="activity-progress" aria-hidden="true"><span style={{width:`${playback.progress*100}%`}}/></div>}
  </article>;
}
