import {useEffect,useRef,useState} from 'react';
import {api,ApiClientError} from './api.js';
import {Icon} from './components.js';

type Stream={id:string;kind:'vod'|'live'|'custom'|'plex';user:string;client:string;state:'playing'|'paused'|'buffering';delivery:'direct'|'remux'|'transcode';live?:boolean;
  channel?:{name:string;number:number};program?:string;media?:{title:string;type:string;year?:number;show?:string;season?:number;episode?:number}};
type View={streams:Stream[];transcodes:number;bandwidthKbps:number};

const delivery={direct:'Direct play',remux:'Direct stream',transcode:'Transcode'} as const;
const mbps=(kbps:number)=>`${(kbps/1000).toFixed(1)} Mbps`;
const titleOf=(s:Stream)=>{const m=s.media;return m?(m.type==='episode'?`${m.show??m.title} · S${m.season??'?'}:E${m.episode??'?'}`:m.year?`${m.title} (${m.year})`:m.title):s.program??s.channel?.name??'Unknown';};

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
      {count>0&&<ul>{view!.streams.map(s=><li key={s.id}>
        <Icon name={s.state==='paused'?'pause':'play'} size={14}/>
        <div><strong>{s.user}</strong><span title={titleOf(s)}>{titleOf(s)}</span><small>{[s.kind==='plex'?(s.live?'Plex Live TV':'Plex app'):s.kind==='vod'?undefined:s.kind==='live'?'Live TV':'Custom channel',delivery[s.delivery],s.client].filter(Boolean).join(' · ')}</small></div>
      </li>)}</ul>}
      <a href="#admin?section=activity" onClick={()=>pop.current?.hidePopover()}>Open Activity</a>
    </div>
  </>;
}
