import {useEffect,useState} from 'react';
import {api,ApiClientError} from './api.js';
import {Empty,ErrorNotice,Icon,Loading} from './components.js';
import {SectionHead} from './settings-ui.js';
import {qualityTiers} from '../../../packages/contracts/src/index.js';
import './activity.css';

type Source={videoCodec?:string;audioCodec?:string;width?:number;height?:number;container?:string;bitrateKbps?:number};
type Media={title:string;type:string;year?:number;show?:string;album?:string;season?:number;episode?:number;durationMs?:number;posterId?:string};
// `plex` rows are other Plex apps' streams, read from Plex; they carry Plex's own video and audio descriptions.
type Stream={id:string;kind:'vod'|'live'|'custom'|'plex';user:string;client:string;ip:string;local:boolean;startedAt?:number;state:'playing'|'paused'|'buffering';delivery:'direct'|'remux'|'transcode';
  canStop:boolean;video?:string;audio?:string;speed?:number;live?:boolean;
  quality?:string;target?:{maxHeight?:number;maxBitrateKbps?:number};rateKbps:number;source?:Source;channelId?:string;channel?:{name:string;number:number};
  media?:Media;program?:string;behindLiveMs?:number;positionMs?:number;durationMs?:number};
type View={streams:Stream[];transcodes:number;bandwidthKbps:number;wanBandwidthKbps:number;plexError?:string};

const delivery={direct:'Direct play',remux:'Direct stream',transcode:'Transcode'} as const;
const kinds={vod:'Library',live:'Live TV',custom:'Custom channel',plex:'Plex app'} as const;
const mbps=(kbps:number)=>`${(kbps/1000).toFixed(1)} Mbps`;
const clock=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s/60)%60,sec=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${sec}`:`${m}:${sec}`;};
const resolution=(s?:Source)=>!s?.height?undefined:(s.height>=2000||(s.width??0)>=3800)?'4K':`${s.height>=1000||(s.width??0)>=1900?1080:s.height>=700||(s.width??0)>=1260?720:s.height}p`;
const codec=(c?:string)=>c?.toUpperCase();
const qualityName=(q?:string)=>{const tier=qualityTiers.find(t=>t.id===q);return tier?`${tier.height}p · ${mbps(tier.bitrateKbps)}`:q==='original'?'Original':'Auto';};

// Admin › Activity: what everyone is watching right now, in tk.box (library, IPTV, custom channels) and in any other Plex app, refreshed every few seconds.
export function ActivityAdmin() {
  const [view,setView]=useState<View>(),[error,setError]=useState<string>(),[version,setVersion]=useState(0);
  useEffect(()=>{
    let live=true;
    const load=()=>api<View>('/admin/activity').then(v=>{if(live){setView(v);setError(undefined);}},(e:ApiClientError)=>{if(live)setError(e.message);});
    void load();const timer=window.setInterval(()=>{if(!document.hidden)void load();},5000);
    return()=>{live=false;window.clearInterval(timer);};
  },[version]);
  const reload=()=>setVersion(v=>v+1);
  const summary=view&&`${view.streams.length} ${view.streams.length===1?'stream':'streams'}${view.transcodes?` (${view.transcodes} transcoding)`:''} · Bandwidth ${mbps(view.bandwidthKbps)}${view.wanBandwidthKbps?` (WAN ${mbps(view.wanBandwidthKbps)})`:''}`;
  return <><SectionHead title="Activity" description={summary}/>
    {error&&<ErrorNotice message={error} retry={reload}/>}
    {view?.plexError&&<p className="notice">{view.plexError}</p>}
    {!view?(!error&&<Loading/>):!view.streams.length?<Empty title="Nothing is playing">Streams in tk.box and in any Plex app show up here while they play.</Empty>
      :<div className="activity-grid">{view.streams.map(s=><StreamCard key={s.id} stream={s} ended={reload} failed={setError}/>)}</div>}
  </>;
}

function StreamCard({stream:s,ended,failed}:{stream:Stream;ended:()=>void;failed:(message:string)=>void}) {
  const [stopping,setStopping]=useState(false),src=s.source,res=resolution(src);
  const name=s.channel?`${s.channel.number} · ${s.channel.name}`:undefined;
  const m=s.media,title=m?(m.type==='episode'?m.show??m.title:m.title):s.program??name??'Unknown';
  const detail=m?(m.type==='episode'?`S${m.season??'?'} · E${m.episode??'?'} · ${m.title}`:m.type==='track'?[m.show,m.album].filter(Boolean).join(' · ')||undefined:m.year?String(m.year):undefined):undefined;
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
  const progress=s.positionMs!==undefined&&s.durationMs?Math.min(1,s.positionMs/s.durationMs):undefined;
  const rows:[string,string|undefined][]=[
    ['Type',s.kind==='plex'&&s.live?'Plex Live TV':kinds[s.kind]],['Channel',name],['Player',s.client],['Stream',`${delivery[s.delivery]}${s.speed?` (speed ${s.speed.toFixed(1)})`:''}`],['Video',videoLine],['Audio',audioLine],
    ['Quality',s.kind==='vod'?`${qualityName(s.quality)}${src?.bitrateKbps?` (source ${mbps(src.bitrateKbps)})`:''}`:undefined],
    ['Behind live',s.behindLiveMs?clock(s.behindLiveMs):undefined],
    ['Location',`${s.local?'LAN':'WAN'}: ${s.ip}`],
    ['Bandwidth',s.state==='paused'&&!s.rateKbps?'Paused':`${s.delivery==='direct'&&s.kind!=='plex'?'~':''}${mbps(s.rateKbps)}`]
  ];
  // Streams watched in tk.box stand out from those in other Plex apps.
  return <article className={`activity-card${s.kind==='plex'?'':' tkbox'}`}>
    <div className="activity-body">
      <div className={`activity-poster ${m?.posterId?'':'logo'}`}>{poster?<img src={poster} alt="" loading="lazy" onError={e=>{e.currentTarget.style.visibility='hidden';}}/>:<Icon name={s.kind==='live'||s.kind==='custom'||s.live?'live':'movies'} size={32}/>}</div>
      <dl className="activity-details">{rows.filter(([,v])=>v).map(([k,v])=><div key={k}><dt>{k}</dt><dd title={v}>{v}</dd></div>)}</dl>
      {s.canStop&&<button className="icon-button activity-stop" aria-label={`Stop ${s.user}’s stream`} title="Stop this stream" disabled={stopping} onClick={stop}><Icon name="close" size={18}/></button>}
    </div>
    <div className="activity-progress" aria-hidden="true">{progress!==undefined&&<span style={{width:`${progress*100}%`}}/>}</div>
    <footer className="activity-foot">
      <div className="activity-title"><strong><Icon name={s.state==='paused'?'pause':'play'} size={14}/>{title}</strong><small>{[detail,(s.kind==='live'||s.kind==='custom')&&m?name:undefined].filter(Boolean).join(' · ')||kinds[s.kind]}</small></div>
      <div className="activity-who"><strong>{s.kind!=='plex'&&<span className="badge tkbox">tk.box</span>}{s.user}</strong><small>{s.positionMs!==undefined&&s.durationMs?`${clock(s.positionMs)} / ${clock(s.durationMs)}`:s.startedAt?`Watching ${clock(Date.now()-s.startedAt)}`:s.state==='buffering'?'Buffering':s.live?'Live':''}</small></div>
    </footer>
  </article>;
}
