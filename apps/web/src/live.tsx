import {Fragment,useEffect,useRef,useState,type ReactNode} from 'react';
import {useApi,useDebounced,useInfinitePages,clock,link,duration,invalidate} from './hooks.js';
import {api} from './api.js';
import {Empty,ErrorNotice,FadeImage,Loading,Icon,Modal,Row} from './components.js';
import {readPreference} from './storage.js';
import {liveSpeedPx,useHomeSettings} from './home-settings.js';

type Program={title:string;start:number;end:number;subtitle?:string;description?:string;category?:string;continuous?:boolean;status?:'starting_soon'};
// One-line listing, e.g. "Arcane · S1E3 · The Base Violence Necessary for Change".
const fullTitle=(p:Program)=>p.subtitle?`${p.title} · ${p.subtitle}`:p.title;
// Blank slots follow a finished sports event: nothing to list, but not missing guide data either.
type Slot={start:number;end:number;program:Program|null;blank?:true};
export type StationFeed={id:string;name:string;number:number;quality?:string};
type Station={id:string;sourceId?:string;group?:string;name:string;number:number;type:'iptv'|'custom';favorite:boolean;logo?:boolean;logoKey?:string;stack?:string;quality?:string;feeds?:StationFeed[];programs:Slot[]};
type GuideSource={id:string;name:string;count:number};
type Guide={start:number;end:number;offset:number;limit:number;total:number;hasMore:boolean;sources?:GuideSource[];categories?:{id:string;name:string}[];channels:Station[]};
// The source heading a channel starts, when the list spans several sources and this is the first of its source.
// Rows name their group (Favorites, or their source); older servers only their source.
const groupOf=(c:Station)=>c.group??c.sourceId;
function sourceHead(guide:Guide,i:number){const c=guide.channels[i]!,prev=guide.channels[i-1];if((guide.sources?.length??0)<2||(prev&&groupOf(prev)===groupOf(c)))return;return guide.sources!.find(s=>s.id===groupOf(c));}
// Joins loaded pages into one list; a station can shift across a page boundary between fetches.
function joinPages(pages:(Guide|undefined)[]) {
  const first=pages[0];if(!first)return undefined;
  const seen=new Set<string>(),channels:Station[]=[];
  for(const page of pages)for(const c of page?.channels??[])if(!seen.has(c.id)){seen.add(c.id);channels.push(c);}
  return {...first,channels};
}
const reloadGuide=()=>invalidate('/guide');
// Any filter besides the fixed ones is an IPTV source's id, shown as its category (News, Sports…) after All Channels.
const fixedFilters=['all','custom','favorites'];
type Filter=string;
const aligned=()=>Math.floor(Date.now()/1800000)*1800000;
const dateValue=(ms:number)=>{const d=new Date(ms);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const validFilter=(value:string|null):value is Filter=>!!value&&(fixedFilters.includes(value)||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
function savedFilter(account:string):Filter {try{const value=readPreference(sessionStorage,`tk.box:guide:${account}`);return validFilter(value)?value:'all';}catch{return 'all';}}
// Provider names often carry a region prefix ("US: CNN"); show it as a tag instead.
export function stationName(name:string){const m=/^([A-Z]{2,3})s*[:|]s*(.+)$/.exec(name);return m?{region:m[1],label:m[2]!}:{label:name};}
type LogoChannel={id:string;name:string;logo?:boolean;logoKey?:string};
// A custom channel's logoKey changes with the movie airing, giving a new address so the new logo loads.
const logoSrc=(channel:LogoChannel)=>`/api/v1/iptv/channels/${channel.id}/logo${channel.logoKey?`?v=${encodeURIComponent(channel.logoKey)}`:''}`;
export function ChannelLogo({channel,size=40,fill,named,onMissing}:{channel:LogoChannel;size?:number;fill?:boolean;named?:boolean;onMissing?:(src:string)=>void}) {
  const src=logoSrc(channel);
  const [failed,setFailed]=useState<string>(),label=stationName(channel.name).label;
  // A fixed landscape tile: most station logos are wide, so every logo shares one box and one alignment. A named tile
  // without a logo spells out the station instead of its monogram.
  return <span className="channel-logo" style={{width:fill?'100%':Math.round(size*1.6),height:size}} aria-hidden="true">{channel.logo&&failed!==src?<FadeImage key={src} src={src} alt="" loading="lazy" onError={()=>{setFailed(src);onMissing?.(src);}}/>:named?<b className="channel-logo-name">{label}</b>:<b style={{fontSize:size*.34}}>{label.slice(0,2).toUpperCase()}</b>}</span>;
}
// A station shown by its logo, its feed count pinned to the logo's corner. Alone (the guide), the tile fills the cell and
// spells out a station with no logo; with text beside it, the name joins that text instead.
function StationIdentity({channel,size,children}:{channel:Station;size:number;children?:ReactNode}) {
  const [missing,setMissing]=useState<string>(),named=!channel.logo||missing===logoSrc(channel),feeds=channel.feeds?.length??0;
  return <span className={`station-identity${children?'':' alone'}`} title={channel.name}><span className="station-logo"><ChannelLogo channel={channel} size={size} fill={!children} named={!children} onMissing={setMissing}/>{feeds>1&&<span className="feed-count" aria-label={`${feeds} feeds`}>{feeds}</span>}</span>
    {children&&<span className="station-identity-text">{named&&<strong>{stationName(channel.name).label}</strong>}{children}</span>}</span>;
}
const airingNow=(c:Station,now:number)=>c.programs.find(p=>p.program&&p.program.start<=now&&p.program.end>now)?.program??undefined;
const minutesLeft=(p:Program,now:number)=>Math.max(1,Math.ceil((p.end-now)/60000));
// A sports event's lead-in ends when the event starts.
const soon=(p?:Program|null)=>p?.status==='starting_soon';
const timing=(p:Program,now:number)=>p.continuous?'24/7':soon(p)?`Starting soon · ${clock(p.end)}`:`${minutesLeft(p,now)} min left`;
const emptyLabel=(c:Station,now:number)=>c.programs.find(p=>p.start<=now&&p.end>now)?.blank?'':'No guide data';
// A stable shuffle: the same seed gives the same order, and a channel joining or leaving does not move the rest.
const rank=(id:string,seed:string)=>{let h=2166136261;for(const ch of seed+id)h=Math.imul(h^ch.charCodeAt(0),16777619);return h>>>0;};
export const shuffled=<T extends {id:string}>(list:T[],seed:string)=>[...list].sort((a,b)=>rank(a.id,seed)-rank(b.id,seed));
function useNow(){const [now,setNow]=useState(Date.now);useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);return now;}

// Home's Live TV rows: what's on now and next, capped (Settings › Home) so they never become the guide. Regular channels
// and live events are separate rows. Favorites come first; without any, the first channels of the lineup stand in.
// Shuffled, it picks from the first 60.
export function LiveNow({onWatch,busy}:{onWatch:WatchChannel;busy:boolean}) {
  const settings=useHomeSettings(),[seed]=useState(()=>Math.random().toString(36));
  const now=useNow(),start=Math.floor(now/1800000)*1800000,base=`/guide?start=${start}&end=${start+7200000}&limit=${settings.liveShuffle?60:settings.liveCount}&kind=channels`;
  const favorites=useApi<Guide>(`${base}&filter=favorites`),none=favorites.data?.channels.length===0;
  const lineup=useApi<Guide>(none?`${base}&filter=all`:undefined),data=none?lineup:favorites;
  useEffect(()=>{const timer=setInterval(data.reload,60000);return()=>clearInterval(timer);},[start,none]);
  if(data.error)return <ErrorNotice message="Live TV could not be loaded." retry={data.reload}/>;
  if(!data.data?.channels.length)return null;
  // The order is fixed for this visit, so the minute refresh does not reshuffle the row.
  const channels=(settings.liveShuffle?shuffled(data.data.channels,seed):data.data.channels).slice(0,settings.liveCount);
  return <LiveRow title={none?'On Live TV now':'On your channels now'} href={link('live',{filter:none?'all':'favorites'})} channels={channels} now={now} onWatch={onWatch} busy={busy}/>;
}
// Live events on now, in the guide's sport and league order; the row is gone while nothing is on.
export function LiveEventsNow({onWatch,busy}:{onWatch:WatchChannel;busy:boolean}) {
  const settings=useHomeSettings(),now=useNow(),start=Math.floor(now/1800000)*1800000;
  const data=useApi<Guide>(`/guide?start=${start}&end=${start+7200000}&limit=${settings.liveCount}&kind=events`);
  useEffect(()=>{const timer=setInterval(data.reload,60000);return()=>clearInterval(timer);},[start]);
  if(data.error)return <ErrorNotice message="Live events could not be loaded." retry={data.reload}/>;
  if(!data.data?.channels.length)return null;
  return <LiveRow title="Live events now" href={link('live',{filter:'all'})} channels={data.data.channels} now={now} onWatch={onWatch} busy={busy}/>;
}
// Laid out like the poster rows at half height: a 4:3 frame (the logo stands in for art) with a banner like the poster
// overlays, then title and meta below.
function LiveRow({title,href,channels,now,onWatch,busy}:{title:string;href:string;channels:Station[];now:number;onWatch:WatchChannel;busy:boolean}) {
  const settings=useHomeSettings();
  return <Row title={title} href={href} drift={settings.liveScroll?liveSpeedPx[settings.liveSpeed]:0}>{channels.map(c=>{
    const current=airingNow(c,now),next=c.programs.find(p=>p.program&&p.program.start>now)?.program,tune=()=>onWatch(tuneTarget(c),current?.title);
    return <div className="poster-card" key={c.id}>
      <div className="card-frame"><button className="poster-art live-art" disabled={busy} onClick={tune} aria-label={`Watch ${c.name}${current?`, ${current.title}`:''}`}>
        <ChannelLogo channel={c} size={88}/><span className="live-badge">LIVE</span>
        {next&&<span className="live-next"><small>Next {clock(next.start)}</small> {next.title}</span>}
        {current&&<LiveProgress label={timing(current,now)} pct={current.continuous||soon(current)?0:Math.min(100,(now-current.start)/(current.end-current.start)*100)}/>}
      </button><button className="card-play" tabIndex={-1} disabled={busy} aria-label={`Watch ${c.name}`} onClick={tune}><Icon name="play" size={22}/></button></div>
      <span className="poster-title"><span className="card-plain">{current?fullTitle(current):emptyLabel(c,now)||'Off air'}</span></span>
      <span className="poster-meta"><span className="card-plain">{stationName(c.name).label}</span></span>
    </div>;})}</Row>;
}
// The time left sits inside the bar: light text over the track, and a copy clipped to the filled part in dark text.
const LiveProgress=({label,pct}:{label:string;pct:number})=><span className="live-progress"><span>{label}</span><span aria-hidden="true" style={{clipPath:`inset(0 ${100-pct}% 0 0)`}}>{label}</span></span>;
export type WatchChannel=(channel:{id:string;name:string;number:number;stack?:string;feeds?:StationFeed[]},program?:string)=>void;
// A stack is one station with several provider feeds. The server lists the best feed first;
// a viewer's last pick for that station wins while it is still available.
const feedKey=(stack:string)=>`tk.box:feed:${stack}`;
export function rememberFeed(stack:string|undefined,id:string){if(!stack)return;try{localStorage.setItem(feedKey(stack),id);}catch{}}
export function tuneTarget(c:{id:string;name:string;number:number;stack?:string;feeds?:StationFeed[]},feedId?:string) {
  let saved:string|null=null;if(!feedId&&c.stack)try{saved=localStorage.getItem(feedKey(c.stack));}catch{}
  const feed=c.feeds?.find(f=>f.id===(feedId??saved));
  return {...(feed?{id:feed.id,name:feed.name,number:feed.number}:{id:c.id,name:c.name,number:c.number}),stack:c.stack,feeds:c.feeds};
}
export const hasFeed=(c:{id:string;feeds?:{id:string}[]},id?:string)=>!!id&&(c.id===id||!!c.feeds?.some(f=>f.id===id));
export function Live({admin,params,accountId,onWatch,busy,playing}:{admin:boolean;params:URLSearchParams;accountId:string;onWatch:WatchChannel;busy:boolean;playing?:string}) {
  const requested=params.get('filter'),filter=validFilter(requested)?requested:params.get('channel')?'all':savedFilter(accountId);
  const [start,setStart]=useState(aligned),[hours,setHours]=useState(2),[search,setSearch]=useState(''),[error,setError]=useState(''),[favoriteBusy,setFavoriteBusy]=useState<string[]>([]),[selection,setSelection]=useState<{channel:Station;slot?:Slot}>();
  const q=useDebounced(search),now=useNow(),end=start+hours*3600000,channel=params.get('channel')??'';
  const query=new URLSearchParams({start:String(start),end:String(end),filter,q,limit:'50',...(channel?{channel}:{})}).toString();
  const list=useInfinitePages<Guide>(offset=>`/guide?${query}&offset=${offset}`,50,query),guide=joinPages(list.pages);
  const data={data:guide,loading:list.loading,error:!guide&&!list.loading?{message:'The guide could not be loaded.'}:undefined,reload:reloadGuide};
  // Kept across loads so the category chips do not blink out while a new filter's page loads.
  const [categories,setCategories]=useState<{id:string;name:string}[]>([]);
  useEffect(()=>{if(guide?.categories)setCategories(guide.categories);},[guide?.categories]);
  const filters:[Filter,string][]=[['all','All Channels'],...categories.map(c=>[c.id,c.name] as [Filter,string]),['custom','Plex Channels'],['favorites','Favorites']];
  useEffect(()=>{try{sessionStorage.setItem(`tk.box:guide:${accountId}`,filter);}catch{}},[filter,accountId]);
  useEffect(()=>{const timer=setInterval(reloadGuide,60000);return()=>clearInterval(timer);},[]);
  // Roll the guide on at each half hour while it is showing the current slot; a guide paged elsewhere stays put.
  const slot=Math.floor(now/1800000)*1800000,lastSlot=useRef(slot);
  useEffect(()=>{const previous=lastSlot.current;lastSlot.current=slot;if(slot!==previous)setStart(s=>s===previous?slot:s);},[slot]);
  useEffect(()=>{setSelection(undefined);},[start,hours,filter,q,channel]);
  useEffect(()=>{if(selection&&data.data&&!data.data.channels.some(c=>c.id===selection.channel.id))setSelection(undefined);},[data.data]);
  const navigate=(value:Filter)=>{window.location.hash=link('live',{filter:value});};
  async function favorite(c:Station) {
    setError('');setFavoriteBusy(ids=>[...ids,c.id]);
    try{await api(`/iptv/channels/${c.id}/favorite`,'PUT',{favorite:!c.favorite});invalidate('/guide');}
    catch(e){setError((e as Error).message);}finally{setFavoriteBusy(ids=>ids.filter(id=>id!==c.id));}
  }
  const times=Array.from({length:hours*2},(_,i)=>start+i*1800000),livePosition=(now-start)/(end-start)*100;
  const selected=selection?data.data?.channels.find(c=>c.id===selection.channel.id):undefined;
  const current=selected?.programs.find(p=>p.program&&p.program.start<=now&&p.program.end>now)?.program;
  const next=selected?.programs.find(p=>p.program&&p.program.start>now)?.program;
  const program=selection?.slot?.program;
  const watch=(c:Station,feedId?:string)=>{setSelection(undefined);if(feedId)rememberFeed(c.stack,feedId);onWatch(tuneTarget(c,feedId),airingNow(c,now)?.title);};
  return <div className="page live-page">
    <div className="guide-filters"><div className="tabs" aria-label="Channel filters">{filters.map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>navigate(value)}>{label}</button>)}</div><label className="guide-search"><Icon name="search"/><input aria-label="Search channels" placeholder="Channel name" maxLength={120} value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
    <div className="guide-toolbar"><div className="guide-date"><strong>{new Intl.DateTimeFormat(undefined,{weekday:'long',month:'short',day:'numeric'}).format(start)}</strong><input aria-label="Guide date" type="date" value={dateValue(start)} onChange={e=>{if(!e.target.value)return;const [y,m,d]=e.target.value.split('-').map(Number),date=new Date(start);date.setFullYear(y!,m!-1,d!);if(Number.isFinite(date.getTime()))setStart(date.getTime());}}/></div><div className="button-row"><select aria-label="Guide time span" value={hours} onChange={e=>setHours(Number(e.target.value))}><option value="2">2 hours</option><option value="4">4 hours</option></select><button aria-label={`Previous ${hours} hours`} onClick={()=>setStart(s=>s-hours*3600000)}>←</button><button onClick={()=>setStart(aligned())}>Now</button><button aria-label={`Next ${hours} hours`} onClick={()=>setStart(s=>s+hours*3600000)}>→</button><button onClick={data.reload}>Refresh</button></div></div>
    {channel&&<div className="notice subtle"><span>Showing the selected channel.</span><a href={link('live',{filter})}>Show all channels →</a></div>}{error&&<ErrorNotice message={error}/ >}{data.error&&<ErrorNotice message={data.error.message} retry={data.reload}/ >}
    {data.loading&&!data.data?<Loading/>:data.data&&!data.data.channels.length?<Empty title={q?'No matching channels':channel?'Channel unavailable':filter==='favorites'?'No favorite channels yet':filter==='custom'?'No Plex channels yet':'No channels available'}>{q?<button onClick={()=>setSearch('')}>Clear search</button>:channel||filter!=='all'?<button onClick={()=>navigate('all')}>Show All Channels</button>:admin?<a href={link('settings')}>Create a channel or add a source in Settings →</a>:'Your administrator can add and approve channels.'}</Empty>:data.data&&<>
      <div className="guide-caption"><span><i/> On now · select to watch</span><span>{busy?'Tuning channel…':'Upcoming shows open details'}</span></div><div className="guide-scroll"><div className="guide-time"><span>CHANNEL / {data.data.total}</span><div style={{gridTemplateColumns:`repeat(${times.length},1fr)`}}>{times.map(t=><span key={t}>{clock(t)}</span>)}</div></div>{data.data.channels.map((c,i)=>{const head=sourceHead(data.data!,i);return <Fragment key={c.id}>{head&&<div className="guide-source"><span>{head.name}<small>{head.count}</small></span></div>}<div className={`guide-row ${hasFeed(c,channel)?'highlight':''} ${hasFeed(c,playing)?'playing':''}`}><div className="guide-station"><button className={`star ${c.favorite?'active':''}`} disabled={favoriteBusy.includes(c.id)} aria-label={`${c.favorite?'Unfavorite':'Favorite'} ${c.name}`} aria-pressed={c.favorite} onClick={()=>void favorite(c)}><Icon name="star"/></button><button className="station-button" onClick={()=>setSelection({channel:c})} aria-label={`${c.name} details`}><StationIdentity channel={c} size={40}/></button><button className="watch-button" disabled={busy} aria-label={`Watch ${c.name} live`} title="Watch live" onClick={()=>watch(c)}><Icon name="play" size={14}/></button></div><div className="guide-programs">{c.programs.map((p,i)=>{if(p.blank)return <span key={i} className="guide-program blank" aria-hidden="true" style={{left:`${(p.start-start)/(end-start)*100}%`,width:`${(p.end-p.start)/(end-start)*100}%`}}/>;const airing=!!p.program&&p.program.start<=now&&p.program.end>now;const past=p.end<=now;return <button key={i} className={`guide-program ${p.program?'':'no-guide'} ${airing?'airing':''} ${soon(p.program)?'soon':''} ${past?'past':''}`} style={{left:`${(p.start-start)/(end-start)*100}%`,width:`${(p.end-p.start)/(end-start)*100}%`}} disabled={airing&&busy} onClick={()=>airing?watch(c):setSelection({channel:c,slot:p})} title={airing?'Watch live':p.program?.description} aria-label={`${airing?'Watch ':''}${p.program?fullTitle(p.program):'No guide data'},${c.name}, ${clock(p.program?.start??p.start)}`}><strong title={p.program?fullTitle(p.program):'No guide data'}>{p.program?.title??'No guide data'}{p.program?.subtitle&&<em> {p.program.subtitle}</em>}</strong><span>{p.program?.continuous?'24/7':soon(p.program)?`Starting soon · ${clock(p.program!.end)}`:`${clock(p.program?.start??p.start)}–${clock(p.program?.end??p.end)}`}</span>{airing&&!p.program!.continuous&&!soon(p.program)&&<progress aria-label="Program progress" max={p.program!.end-p.program!.start} value={now-p.program!.start}/>}</button>;})}{livePosition>=0&&livePosition<100&&<span className="now-line" style={{left:`${livePosition}%`}} aria-hidden="true"/>}</div></div></Fragment>;})}</div><div ref={list.sentinel} className="list-more">{list.more?<button onClick={list.loadMore}>Load more channels</button>:list.loading?'Loading channels…':`${data.data.channels.length} of ${data.data.total} channels`}</div></>}
    {selected&&selection&&<Modal title={program?.title??selected.name} onClose={()=>setSelection(undefined)}><div className="program-detail"><div className="program-station"><ChannelLogo channel={selected} size={52}/><p className="eyebrow">{selected.name}</p></div><h1>{program?.title??(selection.slot?'No guide data':stationName(selected.name).label)}</h1>{program?.subtitle&&<p className="program-subtitle">{program.subtitle}</p>}{program?<><span className="badge">{soon(program)&&program.end>now?'STARTING SOON':program.start>now?'UPCOMING':program.end<=now?'EARLIER':'ON NOW'}</span>{program.continuous?<p className="detail-meta">Plays around the clock</p>:<p className="detail-meta">{new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(program.start)} · {clock(program.start)}–{clock(program.end)} · {duration(program.end-program.start)}{program.category&&` · ${program.category}`}</p>}{program.description&&<p className="program-description">{program.description}</p>}{soon(program)&&program.start<=now&&program.end>now?<p className="detail-meta">Starts in {minutesLeft(program,now)} minutes</p>:!program.continuous&&program.start<=now&&program.end>now&&<div className="program-progress"><progress aria-label="Program progress" max={program.end-program.start} value={now-program.start}/><span>{minutesLeft(program,now)} minutes remaining</span></div>}</>:<p className="muted">{selection.slot?'The linked guide has no program listing for this time.':'Program information for the selected guide window.'}</p>}{!selection.slot&&<dl className="now-next"><div><dt>ON NOW</dt><dd>{current?.title??'No guide data'}{current?.description&&<small>{current.description}</small>}</dd></div><div><dt>UP NEXT</dt><dd>{next?`${clock(next.start)} · ${next.title}`:'No guide data'}</dd></div></dl>}{(selected.feeds?.length??0)>1&&(!program||(program.start<=now&&program.end>now))&&<div className="feed-choices"><p className="eyebrow">FEEDS</p><div className="segmented">{selected.feeds!.map(f=><button key={f.id} disabled={busy} aria-pressed={hasFeed({id:f.id},playing)} onClick={()=>watch(selected,f.id)} title={`Watch ${f.name}`}>{f.quality??stationName(f.name).label}{f.id===selected.id&&' · default'}</button>)}</div></div>}
      <div className="button-row">{(!program||(program.start<=now&&program.end>now))&&<button className="primary" disabled={busy} onClick={()=>watch(selected)}><Icon name="play"/>{busy?'Tuning…':'Watch live'}</button>}<button disabled={favoriteBusy.includes(selected.id)} onClick={()=>void favorite(selected)}><Icon name="star"/>{selected.favorite?'Remove favorite':'Add to favorites'}</button><button onClick={()=>setSelection(undefined)}>Back to guide</button></div>{program&&program.start>now&&<p className="muted small program-note">This program hasn't started yet. Watch the channel live when it airs.</p>}</div></Modal>}
  </div>;
}
// The player's channel pop-out: what's on now, searchable, one click to switch.
export function ChannelPanel({playing,busy,onWatch}:{playing?:string;busy:boolean;onWatch:WatchChannel}) {
  const now=useNow(),[search,setSearch]=useState(''),[favorites,setFavorites]=useState(false),q=useDebounced(search),start=Math.floor(now/1800000)*1800000;
  const query=new URLSearchParams({start:String(start),end:String(start+3600000),filter:favorites?'favorites':'all',q,limit:'40'}).toString();
  const list=useInfinitePages<Guide>(offset=>`/guide?${query}&offset=${offset}`,40,query);
  const data={data:joinPages(list.pages),error:!list.pages[0]&&!list.loading,reload:reloadGuide};
  return <div className="channel-panel">
    <div className="channel-panel-head"><label className="guide-search"><Icon name="search"/><input aria-label="Search channels" placeholder="Channel name" maxLength={120} value={search} onChange={e=>setSearch(e.target.value)}/></label>
      <div className="segmented"><button aria-pressed={!favorites} onClick={()=>setFavorites(false)}>All</button><button aria-pressed={favorites} onClick={()=>setFavorites(true)}>Favorites</button></div></div>
    {data.error?<ErrorNotice message="Channels could not be loaded." retry={data.reload}/>:!data.data?<Loading/>:!data.data.channels.length?<p className="panel-empty">{q?'No matching channels.':favorites?'No favorite channels yet.':'No channels available.'}</p>:
    <div className="channel-list" role="list">{data.data.channels.map((c,i)=>{const p=airingNow(c,now),current=hasFeed(c,playing),head=sourceHead(data.data!,i);return <Fragment key={c.id}>{head&&<p className="channel-list-source" role="presentation">{head.name}</p>}<button role="listitem" className={`channel-item ${current?'playing':''}`} disabled={busy||current} aria-current={current||undefined} onClick={()=>onWatch(tuneTarget(c),p?.title)} aria-label={`Watch ${c.name}${p?`, ${p.title}`:''}`}>
      <StationIdentity channel={c} size={38}><span className="station-now">{p?fullTitle(p):emptyLabel(c,now)}{p&&!p.continuous&&` · ${timing(p,now)}`}</span></StationIdentity></button></Fragment>;})}</div>}
    {data.data&&<div ref={list.sentinel} className="channel-panel-pages">{list.more?<button onClick={list.loadMore}>Load more</button>:list.loading&&'Loading…'}</div>}
  </div>;
}
