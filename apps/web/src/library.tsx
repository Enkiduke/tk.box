import {useEffect,useState} from 'react';
import type {CatalogItem,CatalogPage,Library} from '../../../packages/contracts/src/index.js';
import {useApi,useApiAll,useDebounced,useNearViewport,duration,link} from './hooks.js';
import {Empty,ErrorNotice,FadeImage,Loading,Posters,Poster,WideCard,Row,RowSkeleton,Pagination,Modal,Icon,meta,useMediaMenu,type PlayFn} from './components.js';
import {useOverrides,useWithOverride} from './media-actions.js';
import {LiveNow,shuffled,type WatchChannel} from './live.js';
import {api} from './api.js';
import {liveSpeedPx,useHomeSettings} from './home-settings.js';

type BrowseProps={libraries:Library[];onOpen:(id:string)=>void};
type PlayProps={onPlay:PlayFn;busy:boolean};
const items=(library:Library,query:string)=>`/catalog/libraries/${library.key}/items?${query}`;
// The hero and the "Recently added" rows read the same request, so it is fetched once.
const recent=(library:Library)=>items(library,'shelf=recent&limit=20');
const playable=(item:CatalogItem)=>item.type==='movie'||item.type==='episode';
const page=(library:Library)=>library.type==='movie'?'movies':'shows';
const heroTitle=(item:CatalogItem)=>item.type==='episode'?item.showTitle??'TV Show':item.type==='season'?item.showTitle??item.parentTitle??'TV Show':item.title;
const heroSubtitle=(item:CatalogItem)=>item.type==='episode'?[item.seasonNumber!==undefined?`Season ${item.seasonNumber}`:undefined,item.episodeNumber!==undefined?`Episode ${item.episodeNumber}`:undefined,item.title].filter(Boolean).join(' · '):item.type==='season'?(item.seasonNumber!==undefined?`Season ${item.seasonNumber}`:item.title):undefined;
function interleave<T>(lists:T[][]) {const out:T[]=[];for(let i=0;i<Math.max(0,...lists.map(l=>l.length));i++)for(const list of lists)if(list[i]!==undefined)out.push(list[i]!);return out;}

function Hero({libraries,onOpen,onPlay,busy}:BrowseProps&PlayProps) {
  const data=useApiAll<CatalogPage>(libraries.map(recent));
  const featured=interleave(data.data.map(p=>p?.items.filter(i=>i.backdropUrl)??[])).slice(0,6);
  const [index,setIndex]=useState(0),[paused,setPaused]=useState(false),item=featured[index%Math.max(1,featured.length)];
  // Advance every 8s; keyed on index so picking a dot restarts the clock. Reduced motion only drops the fades (CSS).
  useEffect(()=>{
    if(paused||featured.length<2)return;
    const timer=setInterval(()=>{if(!document.hidden)setIndex(i=>(i+1)%featured.length);},8000);
    return()=>clearInterval(timer);
  },[paused,index,featured.length]);
  // Warm the next backdrop so it is ready before the next rotation.
  useEffect(()=>{const next=featured[(index+1)%Math.max(1,featured.length)];if(next?.backdropUrl)new Image().src=next.backdropUrl;},[index,featured.length]);
  if(!item)return data.loading?<div className="hero hero-loading" aria-busy="true"/>:<div className="hero-spacer"/>;
  // Pause only while the pointer is on the buttons or keyboard focus is inside, not for a mouse resting anywhere on the art.
  return <section className="hero" aria-label="Featured" onFocus={e=>setPaused(e.target.matches(':focus-visible'))} onBlur={()=>setPaused(false)}>
    <FadeImage key={item.id} className="hero-art" src={item.backdropUrl} alt="" fetchPriority="high" decoding="async"/>
    <div className="hero-shade"/>
    <div className="hero-content" key={`content-${item.id}`}>
      <p className="hero-kicker">{item.type==='movie'?'Movie':'TV Shows'} · Recently added</p>
      <h1>{heroTitle(item)}</h1>
      {heroSubtitle(item)&&<p className="hero-episode">{heroSubtitle(item)}</p>}
      <p className="hero-meta">{[meta(item),item.genres.slice(0,2).join(' · ')].filter(Boolean).join(' · ')}</p>
      {item.summary&&<p className="hero-summary">{item.summary}</p>}
      <div className="button-row" onPointerEnter={()=>setPaused(true)} onPointerLeave={()=>setPaused(false)}>
        {playable(item)?<button className="primary large" disabled={busy} onClick={()=>onPlay(item)}><Icon name="play"/>{item.viewOffsetMs>0?'Resume':'Play'}</button>:<button className="primary large" onClick={()=>onOpen(item.id)}><Icon name="play"/>Episodes</button>}
        <button className="secondary large" onClick={()=>onOpen(item.id)}><Icon name="info"/>More info</button>
      </div>
    </div>
    {featured.length>1&&<div className="hero-dots" role="group" aria-label="Featured titles">{featured.map((media,i)=><button key={media.id} aria-label={`Show ${[heroTitle(media),heroSubtitle(media)].filter(Boolean).join(' · ')}`} aria-pressed={index%featured.length===i} onClick={()=>setIndex(i)}/>)}</div>}
  </section>;
}
// Plex's On Deck mixes titles paused partway with the next episode of shows the viewer keeps
// watching. Paused titles are Continue watching; untouched next episodes are Recommended.
function OnDeckRows({libraries,onOpen,onPlay}:BrowseProps&PlayProps) {
  const data=useApiAll<CatalogPage>(libraries.map(l=>items(l,'shelf=continue&limit=20')));
  const overrides=useOverrides(),list=interleave(data.data.map(p=>p?.items??[])).filter(item=>!overrides.get(item.id)?.continueHidden);
  const paused=(item:CatalogItem)=>(overrides.get(item.id)?.viewOffsetMs??item.viewOffsetMs)>0;
  const resume=list.filter(paused),next=list.filter(item=>!paused(item));
  if(data.loading&&!list.length)return <RowSkeleton title="Continue watching" wide/>;
  return <>
    {resume.length>0&&<Row title="Continue watching" className="row-wide">{resume.map(item=><WideCard key={item.id} item={item} onOpen={onOpen} onPlay={onPlay}/>)}</Row>}
    {next.length>0&&<Row title="Recommended For You" className="row-wide">{next.map(item=><WideCard key={item.id} item={item} context="upnext" onOpen={onOpen} onPlay={onPlay}/>)}</Row>}
  </>;
}
// With a seed the titles come in a stable shuffled order, cut to a row's worth.
function LazyRow({title,path,href,drift,seed,onOpen,onPlay}:{title:string;path:string;href:string;drift?:number;seed?:string;onOpen:(id:string)=>void;onPlay:PlayFn}) {
  const [ref,near]=useNearViewport<HTMLDivElement>(),data=useApi<CatalogPage>(near?path:undefined),list=data.data&&(seed?shuffled(data.data.items,seed).slice(0,20):data.data.items);
  return <div ref={ref} className="lazy-row">{!data.data?(data.error?<section className="row"><div className="row-heading"><h2>{title}</h2></div><ErrorNotice message={data.error.message} retry={data.reload}/></section>:<RowSkeleton title={title}/>):list?.length?<Row title={title} href={href} drift={drift}>{list.map(item=><Poster key={item.id} item={item} onOpen={onOpen} onPlay={onPlay}/>)}</Row>:null}</div>;
}
// Collections set to "Visible on Home" in Plex (holiday ones included), a row each in Plex's order.
// They leave Home on their own once Plex stops promoting them; if Plex can't list them, Home goes without.
// Like the Live TV row they can drift endlessly and shuffle, per the Home settings; the order is fixed for this visit.
function PromotedRows({libraries,onOpen,onPlay}:BrowseProps&PlayProps) {
  const settings=useHomeSettings(),drift=settings.collectionScroll?liveSpeedPx[settings.collectionSpeed]:0,[seed]=useState(()=>Math.random().toString(36));
  const data=useApi<{collections:{id:string;title:string;libraryId:string}[]}>('/catalog/home/collections');
  return <>{data.data?.collections.map(c=>{const library=libraries.find(l=>l.key===c.libraryId);
    return library&&<LazyRow key={`collection-${c.id}`} title={c.title} path={`/catalog/collections/${c.id}/items?limit=${settings.collectionShuffle?60:20}`} href={link(page(library),{library:library.key,view:'collections',collection:c.id})} drift={drift} seed={settings.collectionShuffle?seed:undefined} onOpen={onOpen} onPlay={onPlay}/>;})}</>;
}
export function Home({libraries,onOpen,onPlay,onWatch,busy}:BrowseProps&PlayProps&{onWatch:WatchChannel}) {
  const settings=useHomeSettings();
  if(!libraries.length)return <div className="page"><Empty title="No libraries available">Your Plex account needs access to Movies and TV libraries.</Empty></div>;
  return <div className="home">
    <Hero libraries={libraries} onOpen={onOpen} onPlay={onPlay} busy={busy}/>
    <div className="rows">
      <OnDeckRows libraries={libraries} onOpen={onOpen} onPlay={onPlay} busy={busy}/>
      {settings.collectionRows&&<PromotedRows libraries={libraries} onOpen={onOpen} onPlay={onPlay} busy={busy}/>}
      {libraries.map(l=><LazyRow key={`recent-${l.key}`} title={`Recently added in ${l.title}`} path={recent(l)} href={link(page(l),{library:l.key,sort:'newest',direction:'desc'})} onOpen={onOpen} onPlay={onPlay}/>)}
      {settings.liveRow&&<LiveNow onWatch={onWatch} busy={busy}/>}
    </div>
  </div>;
}
export {LibraryView} from './catalog-browser.js';

function SearchLibrary({library,q,onOpen,onPlay}:{library:Library;q:string;onOpen:(id:string)=>void;onPlay:PlayFn}) {
  const [offset,setOffset]=useState(0),data=useApi<CatalogPage>(items(library,String(new URLSearchParams({q,offset:String(offset),limit:'24'}))));
  if(data.data&&!data.data.items.length&&!offset)return null;
  return <section className="search-group"><h2>{library.title}{data.data?.total!==undefined&&<span>{data.data.total}</span>}</h2>{data.loading&&!data.data?<Loading cards/>:data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>:data.data&&<><Posters items={data.data.items} onOpen={onOpen} onPlay={onPlay}/><Pagination page={data.data} onChange={setOffset}/></>}</section>;
}
export function Search({libraries,params,onOpen,onPlay,onSearchChange}:BrowseProps&{params:URLSearchParams;onPlay:PlayFn;onSearchChange:(value:string)=>void}) {
  const text=params.get('q')??'',q=useDebounced(text.trim(),300);
  const channels=useApi<{channels:{id:string;name:string;number:number}[]}>(q?'/iptv/channels':undefined);
  const matches=channels.data?.channels.filter(c=>c.name.toLocaleLowerCase().includes(q.toLocaleLowerCase())||String(c.number)===q).slice(0,12)??[];
  // Library hooks are keyed by query, so each result set remounts with a fresh page offset.
  return <div className="page search-page">
    <h1 className="search-heading">Search</h1>
    <form className="search-box" role="search" onSubmit={e=>{e.preventDefault();onSearchChange(text.trim());}}><Icon name="search" size={22}/><input autoFocus={window.matchMedia('(max-width:760px)').matches} aria-label="Search movies, shows and channels" placeholder="Titles, people, channels…" value={text} maxLength={120} onChange={e=>onSearchChange(e.target.value)}/>{text&&<button type="button" className="icon-button" aria-label="Clear search" onClick={()=>onSearchChange('')}><Icon name="close" size={18}/></button>}</form>
    {q?<>{matches.length>0&&<section className="search-group"><h2>Channels</h2><div className="channel-chips">{matches.map(c=><a href={link('live',{channel:c.id})} key={c.id}>{c.name}</a>)}</div></section>}
      {channels.error&&<ErrorNotice message="Channels could not be searched." retry={channels.reload}/>}
      {libraries.map(l=><SearchLibrary key={`${q}-${l.key}`} library={l} q={q} onOpen={onOpen} onPlay={onPlay}/>)}</>
    :<Empty title="Find something to watch">Search your movies, TV shows and channels.</Empty>}
  </div>;
}

const upNextOf=(episodes:CatalogItem[])=>episodes.find(e=>e.viewOffsetMs>0&&!e.watched)??episodes.find(e=>!e.watched)??episodes[0];
const seasonOf=(seasons:CatalogItem[])=>seasons.find(s=>s.title!=='Specials'&&(s.watchedEpisodeCount??0)<(s.episodeCount??1))??seasons[0];
// Shows and seasons play their up-next episode, picked the same way the details view picks it.
export async function playableOf(item:CatalogItem):Promise<CatalogItem|undefined> {
  if(playable(item))return item;
  const children=(id:string)=>api<CatalogPage>(`/catalog/items/${id}/children?limit=60`).then(p=>p.items);
  const season=item.type==='show'?seasonOf(await children(item.id)):item;
  return season&&upNextOf(await children(season.id));
}
function EpisodeRow({episode:source,onPlay,onOpen,busy}:{episode:CatalogItem;onOpen:(id:string)=>void}&PlayProps) {
  const episode=useWithOverride(source),actions=useMediaMenu(episode,'episode',onOpen,onPlay,'episode-more');
  return <li className={actions.open?'menu-open':undefined} onContextMenu={actions.onContextMenu}><button className="episode" disabled={busy} onClick={()=>onPlay(episode)} aria-label={`Play episode ${episode.episodeNumber??''}: ${episode.title}`}>
    <span className="episode-number">{episode.episodeNumber??'—'}</span>
    <span className="episode-thumb">{episode.posterUrl?<FadeImage src={episode.posterUrl} alt="" loading="lazy" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>:null}<span className="episode-play"><Icon name="play" size={18}/></span>{episode.viewOffsetMs>0&&episode.durationMs&&<span className="card-progress"><span style={{width:`${Math.min(100,episode.viewOffsetMs/episode.durationMs*100)}%`}}/></span>}</span>
    <span className="episode-info"><span className="episode-title"><strong>{episode.title}</strong><span>{episode.watched?<Icon name="check" size={14}/>:null}{duration(episode.durationMs)}</span></span>{episode.summary&&<span className="episode-summary">{episode.summary}</span>}</span>
  </button>{actions.trigger}{actions.menu}</li>;
}
function Episodes({seasonId,onPlay,onOpen,busy,onUpNext}:{seasonId:string;onOpen:(id:string)=>void;onUpNext:(item?:CatalogItem)=>void}&PlayProps) {
  const [offset,setOffset]=useState(0),data=useApi<CatalogPage>(`/catalog/items/${seasonId}/children?offset=${offset}&limit=60`),list=data.data?.items;
  useEffect(()=>{if(list)onUpNext(upNextOf(list));},[list]);
  if(data.loading&&!list)return <Loading/>;
  if(data.error)return <ErrorNotice message={data.error.message} retry={data.reload}/>;
  if(!list?.length)return <Empty title="No episodes available"/>;
  return <><ol className="episode-list">{list.map(episode=><EpisodeRow key={episode.id} episode={episode} onPlay={onPlay} onOpen={onOpen} busy={busy}/>)}</ol><Pagination page={data.data!} onChange={setOffset}/></>;
}
function Seasons({show,onUpNext,...play}:{show:CatalogItem;onOpen:(id:string)=>void;onUpNext:(item?:CatalogItem)=>void}&PlayProps) {
  const seasons=useApi<CatalogPage>(`/catalog/items/${show.id}/children?limit=60`),list=seasons.data?.items??[],[chosen,setChosen]=useState<string>();
  const season=list.find(s=>s.id===chosen)??seasonOf(list);
  return <section className="detail-episodes"><div className="episodes-heading"><h2>Episodes</h2>{list.length>1?<select aria-label="Season" value={season?.id} onChange={e=>setChosen(e.target.value)}>{list.map(s=><option key={s.id} value={s.id}>{s.title}{s.episodeCount!==undefined?` (${s.episodeCount})`:''}</option>)}</select>:season&&<span className="muted">{season.title}</span>}</div>
    {seasons.error?<ErrorNotice message={seasons.error.message} retry={seasons.reload}/>:!season?(seasons.loading?<Loading/>:<Empty title="No seasons available"/>):<Episodes key={season.id} seasonId={season.id} onUpNext={onUpNext} {...play}/>}
  </section>;
}
export function Details({id,onClose,onOpen,onPlay,busy,error}:{id:string;onClose:()=>void;onOpen:(id:string)=>void;error?:string}&PlayProps) {
  const item=useApi<CatalogItem>(`/catalog/items/${id}`),media=useWithOverride(item.data),actions=useMediaMenu(media??{id,libraryId:'',type:'movie',title:'',summary:'',viewOffsetMs:0,watched:false,genres:[]},'detail',onOpen,onPlay,'secondary large icon-only'),[upNext,setUpNext]=useState<CatalogItem>();
  const target=media&&playable(media)?media:upNext,art=media?.backdropUrl??media?.posterUrl;
  const parent=media?.type==='episode'?{id:media.showId??media.parentId,title:media.showTitle??media.parentTitle}:media?.type==='season'?{id:media.parentId,title:media.parentTitle}:undefined;
  return <Modal title={media?.title??'Media details'} onClose={onClose} variant="media">
    {item.loading&&!media?<div className="detail-loading"><Loading/></div>:item.error?<div className="detail-body"><ErrorNotice message={item.error.message} retry={item.reload}/></div>:media&&<>
      <div className={`detail-hero ${art?'':'no-art'}`}>
        {art&&<FadeImage src={art} alt="" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>}<div className="detail-shade"/>
        <div className="detail-hero-content">
          {parent?.id&&<button className="crumb" onClick={()=>onOpen(parent.id!)}><Icon name="back" size={14}/>{parent.title??'Back'}</button>}
          <h1>{media.title}</h1>
          {error&&<ErrorNotice message={error}/>}
          <div className="button-row">
            <button className="primary large" disabled={busy||!target} onClick={()=>target&&onPlay(target)}><Icon name="play"/>{!target?'Play':target.viewOffsetMs>0?'Resume':'Play'}{target&&target!==media&&<span className="button-detail">S{target.seasonNumber??'?'}:E{target.episodeNumber??'?'}</span>}{target&&target.viewOffsetMs>0&&target.durationMs?<span className="button-detail">{duration(target.durationMs-target.viewOffsetMs)} left</span>:null}</button>
            {target&&target.viewOffsetMs>0&&<button className="secondary large" disabled={busy} onClick={()=>onPlay(target,'beginning')}>Start over</button>}
            {actions.trigger}{actions.menu}
          </div>
        </div>
      </div>
      <div className="detail-body">
        <div className="detail-main">
          <p className="detail-meta">{media.type==='episode'&&<span>S{media.seasonNumber??'?'}:E{media.episodeNumber??'?'}</span>}{meta(media)&&<span>{meta(media)}</span>}{media.episodeCount!==undefined&&<span>{media.watchedEpisodeCount??0} of {media.episodeCount} episodes watched</span>}{media.watched&&<span className="badge">Watched</span>}</p>
          <p className="synopsis">{media.summary||'No synopsis available.'}</p>
        </div>
        {media.genres.length>0&&<p className="detail-side"><span>Genres:</span> {media.genres.join(', ')}</p>}
      </div>
      {media.type==='show'&&<Seasons show={media} onUpNext={setUpNext} onPlay={onPlay} onOpen={onOpen} busy={busy}/>}
      {media.type==='season'&&<section className="detail-episodes"><div className="episodes-heading"><h2>Episodes</h2></div><Episodes seasonId={media.id} onUpNext={setUpNext} onPlay={onPlay} onOpen={onOpen} busy={busy}/></section>}
    </>}
  </Modal>;
}
