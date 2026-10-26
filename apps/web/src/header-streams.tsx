import {useEffect,useRef,useState} from 'react';
import {api,ApiClientError} from './api.js';
import {Icon} from './components.js';

type Stream={id:string;kind:'vod'|'live'|'custom'|'plex';user:string;client:string;state:'playing'|'paused'|'buffering';delivery:'direct'|'remux'|'transcode';live?:boolean;
  channelId?:string;channel?:{name:string;number:number};program?:string;positionMs?:number;durationMs?:number;
  media?:{title:string;type:string;year?:number;show?:string;season?:number;episode?:number;posterId?:string}};
type View={streams:Stream[];transcodes:number;bandwidthKbps:number};

const delivery={direct:'Direct play',remux:'Direct stream',transcode:'Transcode'} as const;
const mbps=(kbps:number)=>`${(kbps/1000).toFixed(1)} Mbps`;
const clock=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s/60)%60,sec=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${sec}`:`${m}:${sec}`;};
const titleOf=(s:Stream)=>{const m=s.media;return m?(m.type==='episode'?m.show??m.title:m.title):s.program??s.channel?.name??'Unknown';};
const detailOf=(s:Stream)=>{const m=s.media;return m?(m.type==='episode'?`S${m.season??'?'} · E${m.episode??'?'} · ${m.title}`:m.year?String(m.year):undefined):s.program&&s.channel?s.channel.name:undefined;};
const kindOf=(s:Stream)=>s.kind==='plex'?(s.live?'Plex Live TV':'Plex app'):s.kind==='live'?'Live TV':s.kind==='custom'?'Custom channel':undefined;

// Admins' header count of what is playing right now, from Admin › Activity; clicking it lists who is watching what.
// It checks every 15 seconds, and every 5 while the list is open.
export function HeaderStreams() {
  const [view,setView]=useState<View>(),[error,setError]=useState<string>(),[open,setOpen]=useState(false);
  const button=useRef<HTMLButtonElement>(null),pop=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let live=true;
    const load=()=>api<View>('/admin/activity').then(v=>{if(live){setView(v);setError(undefined);}},(e:ApiClientError)=>{if(live)setError(e.message);});
    void load();const timer=window.setInterval(()=>{if(!document.hidden)void load();},open?5000:15000);
    return()=>{live=false;window.clearInterval(timer);};
  },[open]);
  // The list opens under the button, right-aligned with it.
  const place=()=>{
    const b=button.current?.getBoundingClientRect(),p=pop.current;if(!b||!p)return;
    p.style.top=`${b.bottom+8}px`;p.style.right=`${Math.max(8,innerWidth-b.right)}px`;
  };
  const count=view?.streams.length??0;
  const label=!view?'Active streams':`${count} active ${count===1?'stream':'streams'}`;
  return <>
    <button ref={button} type="button" className={`nav-streams${count?' active':''}`} popoverTarget="header-streams" aria-label={label} title={label} aria-expanded={open}>
      <Icon name="play" size={18}/><span>{view?count:'–'}</span>
    </button>
    <div ref={pop} id="header-streams" popover="auto" className="streams-pop" role="dialog" aria-label="Active streams" onBeforeToggle={e=>{if((e.nativeEvent as ToggleEvent).newState==='open')place();}} onToggle={e=>setOpen((e.nativeEvent as ToggleEvent).newState==='open')}>
      <header><strong>{label}</strong>{view&&count>0&&<small>{[view.transcodes?`${view.transcodes} transcoding`:undefined,mbps(view.bandwidthKbps)].filter(Boolean).join(' · ')}</small>}</header>
      {error&&<p className="streams-pop-note error">{error}</p>}
      {view&&!count&&<p className="streams-pop-note">Nothing is playing.</p>}
      {count>0&&<ul>{view!.streams.map(s=>{
        const poster=s.media?.posterId?`/api/v1/catalog/items/${s.media.posterId}/artwork?kind=poster`:s.channelId?`/api/v1/iptv/channels/${s.channelId}/logo`:undefined;
        const progress=s.positionMs!==undefined&&s.durationMs?Math.min(1,s.positionMs/s.durationMs):undefined,detail=detailOf(s);
        return <li key={s.id}>
          <div className={`streams-poster${s.media?.posterId?'':' logo'}`}>{poster?<img src={poster} alt="" loading="lazy" onError={e=>{e.currentTarget.style.visibility='hidden';}}/>:<Icon name={s.kind==='vod'?'movies':'live'} size={20}/>}</div>
          <div className="streams-info">
            <strong><Icon name={s.state==='paused'?'pause':'play'} size={12}/>{s.user}{s.kind!=='plex'&&<span className="badge tkbox">tk.box</span>}</strong>
            <span title={[titleOf(s),detail].filter(Boolean).join(' · ')}>{titleOf(s)}{detail&&<em> · {detail}</em>}</span>
            <small>{[kindOf(s),delivery[s.delivery]].filter(Boolean).join(' · ')}</small>
            {progress!==undefined&&<div className="streams-progress"><span className="streams-bar"><span style={{width:`${progress*100}%`}}/></span><small>{clock(s.positionMs!)} / {clock(s.durationMs!)}</small></div>}
          </div>
        </li>;
      })}</ul>}
      <a href="#admin?section=activity" onClick={()=>pop.current?.hidePopover()}>Open Activity</a>
    </div>
  </>;
}
