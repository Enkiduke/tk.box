import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {CatalogItem,CatalogPage,ExternalRating,Library} from '../../../packages/contracts/src/index.js';
import {useApi,useApiAll,useDebounced,useNearViewport,duration,link,cachedListItem} from './hooks.js';
import {Empty,ErrorNotice,FadeImage,Loading,Posters,Poster,WideCard,Row,RowSkeleton,Pagination,Modal,Icon,People,meta,useMediaMenu,artworkKey,editArtwork,type PlayFn} from './components.js';
import {useOverrides,useWithOverride} from './media-actions.js';
import {LiveEventsNow,LiveNow,shuffled,type WatchChannel} from './live.js';
import {api} from './api.js';
import {plural} from './settings-ui.js';
import {liveSpeedPx,useHomeSettings} from './home-settings.js';

type BrowseProps={libraries:Library[];onOpen:(id:string)=>void};
type PlayProps={onPlay:PlayFn;busy:boolean};
const items=(library:Library,query:string)=>`/catalog/libraries/${library.key}/items?${query}`;
// The hero and the "Recently added" rows read the same request, so it is fetched once.
const recent=(library:Library)=>items(library,'shelf=recent&limit=20');
const playable=(item:CatalogItem)=>item.type==='movie'||item.type==='episode';
const page=(library:Library)=>library.type==='movie'?'movies':'shows';
const heroTitle=(item:CatalogItem)=>item.type==='episode'?item.showTitle??'TV Show':item.type==='season'?item.showTitle??item.parentTitle??'TV Show':item.title;
const heroDetails=(item:CatalogItem):{text:string;id?:string}[]=>item.type==='episode'?[
  ...(item.seasonNumber!==undefined?[{text:`Season ${item.seasonNumber}`,id:item.parentId}]:[]),
  ...(item.episodeNumber!==undefined?[{text:`Episode ${item.episodeNumber}`,id:item.id}]:[]),
  {text:item.title,id:item.id}
]:item.type==='season'?[{text:item.seasonNumber!==undefined?`Season ${item.seasonNumber}`:item.title,id:item.id}]:[];
const heroSubtitle=(item:CatalogItem)=>heroDetails(item).map(part=>part.text).join(' · ');
function HeroLink({id,onOpen,children}:{id?:string;onOpen:(id:string)=>void;children:string}) {
  return id?<a className="hero-link" href={link('home',{item:id})} onClick={event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();onOpen(id);
  }}>{children}</a>:<span>{children}</span>;
}
function interleave<T>(lists:T[][]) {const out:T[]=[];for(let i=0;i<Math.max(0,...lists.map(l=>l.length));i++)for(const list of lists)if(list[i]!==undefined)out.push(list[i]!);return out;}

function Hero({libraries,onOpen,onPlay,busy}:BrowseProps&PlayProps) {
  const data=useApiAll<CatalogPage>(libraries.map(recent));
  const featured=interleave(data.data.map(p=>p?.items.filter(i=>i.backdropUrl)??[])).slice(0,6);
  // The previous slide stays fully visible underneath while the new one fades in over it, so a switch never dips to black.
  const [slide,setSlide]=useState({index:0,prev:-1}),[paused,setPaused]=useState(false);
  const count=Math.max(1,featured.length),index=slide.index%count,prev=slide.prev<0?-1:slide.prev%count,item=featured[index];
  const show=(next:(i:number)=>number)=>setSlide(s=>{const i=next(s.index%count);return i===s.index%count?s:{index:i,prev:s.index%count};});
  // Advance every 8s; keyed on index so picking a dot restarts the clock.
  useEffect(()=>{
    if(paused||featured.length<2)return;
    const timer=setInterval(()=>{if(!document.hidden)show(i=>(i+1)%featured.length);},8000);
    return()=>clearInterval(timer);
  },[paused,index,featured.length]);
  if(!item)return data.loading?<div className="hero hero-loading" aria-busy="true"/>:<div className="hero-spacer"/>;
  // Pause while interacting with title links or buttons, or while keyboard focus is inside.
  return <section className="hero" aria-label="Featured" onFocus={e=>setPaused(e.target.matches(':focus-visible'))} onBlur={()=>setPaused(false)}>
    {featured.map((media,i)=><div key={media.id} className={`hero-slide${i===index?' is-active':i===prev?' is-prev':''}`}>
      <FadeImage className="hero-art" src={media.backdropUrl} alt="" fetchPriority={i===index?'high':'low'} decoding="async"/>
    </div>)}
    <div className="hero-shade"/>
    <div className="hero-content" key={`content-${item.id}`}>
      <p className="hero-kicker">{item.type==='movie'?'Movie':'TV Shows'} · Recently added</p>
      <h1 onPointerEnter={()=>setPaused(true)} onPointerLeave={()=>setPaused(false)}><HeroLink id={item.type==='episode'?item.showId:item.type==='season'?item.showId??item.parentId:item.id} onOpen={onOpen}>{heroTitle(item)}</HeroLink></h1>
      {heroDetails(item).length>0&&<p className="hero-episode" onPointerEnter={()=>setPaused(true)} onPointerLeave={()=>setPaused(false)}>{heroDetails(item).map((part,i)=><span key={i}>{i>0&&' · '}<HeroLink id={part.id} onOpen={onOpen}>{part.text}</HeroLink></span>)}</p>}
      <p className="hero-meta">{[meta(item),item.genres.slice(0,2).join(' · ')].filter(Boolean).join(' · ')}</p>
      {item.summary&&<p className="hero-summary">{item.summary}</p>}
      <div className="button-row" onPointerEnter={()=>setPaused(true)} onPointerLeave={()=>setPaused(false)}>
        {playable(item)?<button className="primary large" disabled={busy} onClick={()=>onPlay(item,item.viewOffsetMs>0?'resume':undefined)}><Icon name="play"/>{item.viewOffsetMs>0?'Resume':'Play'}</button>:<button className="primary large" onClick={()=>onOpen(item.id)}><Icon name="play"/>Episodes</button>}
        <button className="secondary large" onClick={()=>onOpen(item.id)}><Icon name="info"/>More info</button>
      </div>
    </div>
    {featured.length>1&&<div className="hero-dots" role="group" aria-label="Featured titles">{featured.map((media,i)=><button key={media.id} aria-label={`Show ${[heroTitle(media),heroSubtitle(media)].filter(Boolean).join(' · ')}`} aria-pressed={index===i} onClick={()=>show(()=>i)}/>)}</div>}
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
  // The first row's visible cards load ahead of everything lazy below the fold.
  const first=(i:number,row:'resume'|'next')=>i<6&&(row==='resume'||!resume.length);
  return <>
    {resume.length>0&&<Row title="Continue watching" className="row-wide">{resume.map((item,i)=><WideCard key={item.id} item={item} onOpen={onOpen} onPlay={onPlay} priority={first(i,'resume')}/>)}</Row>}
    {next.length>0&&<Row title="Recommended For You" className="row-wide">{next.map((item,i)=><WideCard key={item.id} item={item} context="upnext" onOpen={onOpen} onPlay={onPlay} priority={first(i,'next')}/>)}</Row>}
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
      {settings.liveRow&&<><LiveEventsNow onWatch={onWatch} busy={busy}/><LiveNow onWatch={onWatch} busy={busy}/></>}
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
const airDate=(date?:string)=>date?new Date(`${date}T00:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):undefined;
const ratingNames:Record<ExternalRating['source'],string>={imdb:'IMDb',tomatometer:'Rotten Tomatoes Tomatometer',popcornmeter:'Rotten Tomatoes Popcornmeter',tmdb:'TMDB'};
// Rating source logos, bundled from Overseerr (src/assets). Rotten Tomatoes has a fresh and a rotten mark for each meter.
const ratingIcons={
  imdb:new URL('./assets/ratings/imdb.svg',import.meta.url).href,tmdb:new URL('./assets/ratings/tmdb.svg',import.meta.url).href,
  tomatometer:new URL('./assets/ratings/tomatometer-fresh.svg',import.meta.url).href,tomatometerRotten:new URL('./assets/ratings/tomatometer-rotten.svg',import.meta.url).href,
  popcornmeter:new URL('./assets/ratings/popcornmeter-upright.svg',import.meta.url).href,popcornmeterRotten:new URL('./assets/ratings/popcornmeter-spilled.svg',import.meta.url).href
};
function RatingMark({rating}:{rating:ExternalRating}) {
  const icon=rating.fresh===false&&rating.source==='tomatometer'?ratingIcons.tomatometerRotten:rating.fresh===false&&rating.source==='popcornmeter'?ratingIcons.popcornmeterRotten:ratingIcons[rating.source];
  return <img className={`rating-mark ${rating.source}`} src={icon} alt="" aria-hidden="true"/>;
}
export type RatingLinks=Partial<Record<'imdb'|'rottentomatoes'|'tmdb',string>>;
// Each score links to the title on its site when the page is known.
export function Ratings({ratings,links={}}:{ratings:ExternalRating[];links?:RatingLinks}) {
  return <ul className="ratings">{ratings.map(rating=>{
    const value=rating.source==='imdb'?rating.score.toFixed(1):`${Math.round(rating.score*10)}%`,href=links[rating.source==='imdb'||rating.source==='tmdb'?rating.source:'rottentomatoes'];
    const content=<><RatingMark rating={rating}/><span className="sr-only">{ratingNames[rating.source]}</span>{value}</>;
    return <li key={rating.source} title={ratingNames[rating.source]}>{href?<a className="rating-link" href={href} target="_blank" rel="noreferrer">{content}</a>:content}</li>;
  })}</ul>;
}
// A library title's pages on the rating sites. Rotten Tomatoes' address comes from the server, which asks Seerr.
const ratingLinks=(item:CatalogItem):RatingLinks=>{
  const kind=item.type==='movie'||item.type==='show'?item.type:undefined;
  return {...(item.imdbId?{imdb:`https://www.imdb.com/title/${item.imdbId}/`}:{}),...(kind&&item.tmdbId?{tmdb:`https://www.themoviedb.org/${kind==='movie'?'movie':'tv'}/${item.tmdbId}`}:{}),
    ...(kind?{rottentomatoes:`/api/v1/explore/rottentomatoes?${new URLSearchParams({title:item.title,...(item.tmdbId?{kind,tmdb:String(item.tmdbId)}:{})})}`}:{})};
};
// Year (or air date for an episode), content rating and runtime. Plex's own score shows only when no third-party ones came.
const facts=(item:CatalogItem)=>[item.type==='episode'?airDate(item.airDate)??item.year:item.year,item.contentRating,playable(item)?duration(item.durationMs):undefined,
  !item.ratings&&item.rating!==undefined?`★ ${item.rating.toFixed(1)}`:undefined].filter(Boolean);
function EpisodeRow({episode:source,current,onPlay,onOpen,busy}:{episode:CatalogItem;current?:boolean;onOpen:(id:string)=>void}&PlayProps) {
  const episode=useWithOverride(source),actions=useMediaMenu(episode,'episode',onOpen,onPlay,'episode-more');
  const kicker=[episode.episodeNumber!==undefined?`Episode ${episode.episodeNumber}`:undefined,airDate(episode.airDate),duration(episode.durationMs)].filter(Boolean).join(' · ');
  return <li className={actions.open?'menu-open':undefined} onContextMenu={actions.onContextMenu}><button className="episode" aria-current={current||undefined} disabled={busy} onClick={()=>onPlay(episode)} aria-label={`Play episode ${episode.episodeNumber??''}: ${episode.title}`}>
    <span className="episode-thumb">{episode.posterUrl?<FadeImage src={episode.posterUrl} alt="" loading="lazy" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>:null}<span className="episode-play"><Icon name="play" size={18}/></span>{episode.watched&&<span className="watched-badge" title="Watched"><Icon name="check" size={12}/></span>}{episode.viewOffsetMs>0&&episode.durationMs&&<span className="card-progress"><span style={{width:`${Math.min(100,episode.viewOffsetMs/episode.durationMs*100)}%`}}/></span>}</span>
    <span className="episode-info"><span className="episode-kicker">{current?'Now viewing · ':''}{kicker}</span><strong className="episode-name">{episode.title}</strong>{episode.summary&&<span className="episode-summary">{episode.summary}</span>}</span>
  </button>{actions.trigger}{actions.menu}</li>;
}
function Episodes({seasonId,current,onPlay,onOpen,busy,onUpNext}:{seasonId:string;current?:string;onOpen:(id:string)=>void;onUpNext:(item?:CatalogItem)=>void}&PlayProps) {
  const [offset,setOffset]=useState(0),data=useApi<CatalogPage>(`/catalog/items/${seasonId}/children?offset=${offset}&limit=60`),list=data.data?.items;
  useEffect(()=>{if(list)onUpNext(upNextOf(list));},[list]);
  if(data.loading&&!list)return <Loading/>;
  if(data.error)return <ErrorNotice message={data.error.message} retry={data.reload}/>;
  if(!list?.length)return <Empty title="No episodes available"/>;
  return <><ol className="episode-list">{list.map(episode=><EpisodeRow key={episode.id} episode={episode} current={episode.id===current} onPlay={onPlay} onOpen={onOpen} busy={busy}/>)}</ol><Pagination page={data.data!} onChange={setOffset}/></>;
}
const seasonDone=(s:CatalogItem)=>s.episodeCount!==undefined&&(s.watchedEpisodeCount??0)>=s.episodeCount;
const seasonProgress=(s:CatalogItem)=>s.episodeCount===undefined?undefined:s.watchedEpisodeCount&&s.watchedEpisodeCount<s.episodeCount?`${s.watchedEpisodeCount} of ${s.episodeCount} watched`:`${s.episodeCount} episode${s.episodeCount===1?'':'s'}`;
function SeasonPicker({seasons,current,onPick}:{seasons:CatalogItem[];current?:CatalogItem;onPick:(season:CatalogItem)=>void}) {
  const popup=useRef<HTMLDetailsElement>(null);
  const close=()=>{if(popup.current?.open){popup.current.open=false;popup.current.querySelector('summary')?.focus();}};
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(popup.current&&!popup.current.contains(event.target as Node))popup.current.open=false;};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[]);
  return <details ref={popup} className="browse-popup season-picker" onKeyDown={event=>{
    // Escape closes the season list, not the whole dialog.
    if(event.key==='Escape'&&popup.current?.open){event.preventDefault();event.stopPropagation();close();}
  }}><summary role="button" aria-label={`Season: ${current?.title??''}. Change season`}><span>{current?.title}</span><Icon name="down" size={14}/></summary>
    <ul className="browse-menu season-menu">{seasons.map(s=><li key={s.id}><button type="button" aria-current={s.id===current?.id||undefined} onClick={()=>{close();if(s.id!==current?.id)onPick(s);}}>
      <span>{s.title}</span><span className="season-menu-detail">{seasonDone(s)&&<Icon name="check" size={14}/>}{seasonProgress(s)}</span>
    </button></li>)}</ul>
  </details>;
}
function SeasonCard({season:source,onOpen}:{season:CatalogItem;onOpen:(id:string)=>void}) {
  const season=useWithOverride(source),partial=!seasonDone(season)&&(season.watchedEpisodeCount??0)>0&&season.episodeCount;
  return <li><button className="season-card" onClick={()=>onOpen(season.id)} aria-label={`${season.title}, ${seasonProgress(season)??''}`}>
    <span className="season-poster">{season.posterUrl?<FadeImage src={season.posterUrl} alt="" loading="lazy" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>:<span className="season-poster-fallback">{season.title}</span>}
      {seasonDone(season)&&<span className="watched-badge" title="Watched"><Icon name="check" size={12}/></span>}
      {partial&&<span className="card-progress"><span style={{width:`${(season.watchedEpisodeCount??0)/partial*100}%`}}/></span>}</span>
    <strong>{season.title}</strong><span className="season-card-detail">{seasonProgress(season)}</span>
  </button></li>;
}
// A series with several seasons shows their posters; each opens its season. A single season lists its episodes here.
function Seasons({show,onUpNext,...play}:{show:CatalogItem;onOpen:(id:string)=>void;onUpNext:(item?:CatalogItem)=>void}&PlayProps) {
  const seasons=useApi<CatalogPage>(`/catalog/items/${show.id}/children?limit=60`),list=seasons.data?.items,season=list&&seasonOf(list),many=(list?.length??0)>1;
  // The Play button still needs the up-next episode when no episode list is loaded.
  useEffect(()=>{
    if(!many||!season)return;let live=true;
    api<CatalogPage>(`/catalog/items/${season.id}/children?limit=60`).then(page=>{if(live)onUpNext(upNextOf(page.items));},()=>{});
    return()=>{live=false;};
  },[many,season?.id]);
  if(seasons.error)return <section className="detail-episodes"><ErrorNotice message={seasons.error.message} retry={seasons.reload}/></section>;
  if(!season)return <section className="detail-episodes">{seasons.loading?<Loading/>:<Empty title="No seasons available"/>}</section>;
  return <section className="detail-episodes">
    <div className="episodes-heading"><h2>{many?'Seasons':'Episodes'}</h2>{!many&&<span className="muted">{season.title}</span>}</div>
    {many?<ul className="season-grid">{list!.map(s=><SeasonCard key={s.id} season={s} onOpen={play.onOpen}/>)}</ul>:<Episodes key={season.id} seasonId={season.id} onUpNext={onUpNext} {...play}/>}
  </section>;
}
// A season's episodes, with a picker that opens the show's other seasons.
function SeasonEpisodes({season,onUpNext,...play}:{season:CatalogItem;onOpen:(id:string)=>void;onUpNext:(item?:CatalogItem)=>void}&PlayProps) {
  const siblings=useApi<CatalogPage>(season.parentId?`/catalog/items/${season.parentId}/children?limit=60`:undefined),list=siblings.data?.items??[];
  return <section className="detail-episodes"><div className="episodes-heading"><h2>Episodes</h2>{list.length>1&&<SeasonPicker seasons={list} current={list.find(s=>s.id===season.id)??season} onPick={s=>play.onOpen(s.id)}/>}</div>
    <Episodes seasonId={season.id} onUpNext={onUpNext} {...play}/></section>;
}
type DetailProps={id:string;onOpen:(id:string)=>void;error?:string;admin?:boolean}&PlayProps;
// One dialog stays open while it moves from title to title (show, season, episode); only its contents change.
export function Details({onClose,...props}:{onClose:()=>void}&DetailProps) {
  const item=useApi<CatalogItem>(`/catalog/items/${props.id}`);
  return <Modal title={item.data?.title??'Media details'} onClose={onClose} variant="media" scrollKey={props.id}><DetailBody key={props.id} {...props}/></Modal>;
}
function DetailBody({id,onOpen,onPlay,busy,error,admin}:DetailProps) {
  // A title from a list on screen draws at once; the full record fills in cast, ratings and the rest.
  const [seed]=useState(()=>cachedListItem<CatalogItem>(id));
  const item=useApi<CatalogItem>(`/catalog/items/${id}`),media=useWithOverride(item.data??(item.error?undefined:seed)),actions=useMediaMenu(media??{id,libraryId:'',type:'movie',title:'',summary:'',viewOffsetMs:0,watched:false,genres:[]},'detail',onOpen,onPlay,'secondary large icon-only'),[upNext,setUpNext]=useState<CatalogItem>();
  const target=media&&playable(media)?media:upNext,[failedLogo,setFailedLogo]=useState<string>();
  // An episode leads with its own still, uncovered, since the still often carries the episode's title card.
  const still=media?.type==='episode'?media.posterUrl:undefined,art=still??media?.backdropUrl??media?.posterUrl;
  const parent=media?.type==='episode'?{id:media.showId??media.parentId,title:media.showTitle??media.parentTitle}:media?.type==='season'?{id:media.parentId,title:media.parentTitle}:undefined;
  const credits=media&&(media.type==='movie'||media.type==='show')?{kind:media.type,tmdb:media.tmdbId}:{};
  const people=media&&([
    ['Starring',!!media.cast?.length&&<People names={media.cast.slice(0,5)} {...credits}/>],[media.directors&&media.directors.length>1?'Directors':'Director',!!media.directors?.length&&<People names={media.directors} {...credits}/>],
    ['Genres',media.genres.join(', ')],['Studio',media.studio]
  ] as [string,ReactNode][]).filter(row=>!!row[1]);
  const progress=media?.episodeCount!==undefined&&media.type!=='episode'?Math.min(1,(media.watchedEpisodeCount??0)/Math.max(1,media.episodeCount)):undefined;
  const heading=media&&<div className="detail-heading">
    {parent?.id&&<button className="crumb" onClick={()=>onOpen(parent.id!)}><Icon name="back" size={14}/>{parent.title??'Back'}</button>}
    {media.type==='episode'&&<p className="detail-eyebrow">{media.seasonNumber!==undefined&&media.parentId?<button className="text-button" onClick={()=>onOpen(media.parentId!)}>Season {media.seasonNumber}</button>:null}{media.episodeNumber!==undefined&&<span>Episode {media.episodeNumber}</span>}</p>}
    <h1 className="detail-title">{media.logoUrl&&failedLogo!==media.logoUrl?<img className="detail-logo" src={media.logoUrl} alt={media.title} decoding="async" fetchPriority="high" onError={()=>setFailedLogo(media.logoUrl)}/>:media.title}</h1>
    {(facts(media).length>0||media.ratings||media.watched)&&<div className="detail-facts">
      {facts(media).length>0&&<p className="detail-meta">{facts(media).map((fact,i)=><span key={i}>{fact}</span>)}{media.watched&&<span className="badge">Watched</span>}</p>}
      {media.ratings&&<Ratings ratings={media.ratings} links={ratingLinks(media)}/>}
    </div>}
    {progress!==undefined&&<p className="detail-progress"><span className="detail-progress-bar"><span style={{width:`${progress*100}%`}}/></span>{media.watchedEpisodeCount??0} of {media.episodeCount} episodes watched</p>}
    {error&&<ErrorNotice message={error}/>}
    <div className="button-row">
      <button className="primary large" disabled={busy||!target} onClick={()=>target&&onPlay(target,target.viewOffsetMs>0?'resume':undefined)}><Icon name="play"/>{!target?'Play':target.viewOffsetMs>0?'Resume':'Play'}{target&&target!==media&&<span className="button-detail">S{target.seasonNumber??'?'}:E{target.episodeNumber??'?'}</span>}{target&&target.viewOffsetMs>0&&target.durationMs?<span className="button-detail">{duration(target.durationMs-target.viewOffsetMs)} left</span>:null}</button>
      {target&&target.viewOffsetMs>0&&<button className="secondary large" disabled={busy} onClick={()=>onPlay(target,'beginning')}>Start over</button>}
      {admin&&artworkKey(media)&&<button className="secondary large" onClick={()=>editArtwork(artworkKey(media)!)}><Icon name="image"/>Edit artwork</button>}
      {actions.trigger}{actions.menu}
    </div>
  </div>;
  return <>
    {item.loading&&!media?<div className="detail-loading"><Loading/></div>:item.error?<div className="detail-body"><ErrorNotice message={item.error.message} retry={item.reload}/></div>:media&&<>
      <div className={`detail-hero${art?'':' no-art'}${still?' still':''}`}>
        {art&&<FadeImage src={art} alt="" decoding="async" fetchPriority="high" onError={e=>{e.currentTarget.hidden=true;}}/>}<div className="detail-shade"/>
        {!still&&<div className="detail-hero-content">{heading}</div>}
      </div>
      {still&&<div className="detail-head">{heading}</div>}
      <div className="detail-body">
        <div className="detail-main">
          {media.tagline&&<p className="tagline">{media.tagline}</p>}
          <p className="synopsis">{media.summary||'No synopsis available.'}</p>
          {/* Each collection the title is in opens that collection under Movies or TV Shows, closing this dialog. */}
          {media.collections?.map(c=><a key={c.id} className="detail-collection" href={link(c.kind==='show'?'shows':'movies',{view:'collections',collection:c.id,library:media.libraryId})}>
            <span className="detail-collection-art">{c.posterUrl?<FadeImage src={c.posterUrl} alt="" loading="lazy" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>:null}<Icon name="collection" size={18}/></span>
            <span className="detail-collection-text"><span className="detail-collection-label">Part of</span><strong>{c.title}</strong>{c.count!==undefined&&<span className="detail-collection-count">{plural(c.count,c.kind==='show'?'show':'movie')}</span>}</span>
            <Icon name="next" size={18}/>
          </a>)}
        </div>
        {people&&people.length>0&&<dl className="detail-people">{people.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      </div>
      {media.type==='show'&&<Seasons show={media} onUpNext={setUpNext} onPlay={onPlay} onOpen={onOpen} busy={busy}/>}
      {media.type==='season'&&<SeasonEpisodes key={media.id} season={media} onUpNext={setUpNext} onPlay={onPlay} onOpen={onOpen} busy={busy}/>}
      {media.type==='episode'&&media.parentId&&<section className="detail-episodes"><div className="episodes-heading"><h2>{media.seasonNumber!==undefined?`Season ${media.seasonNumber}`:'More episodes'}</h2></div><Episodes seasonId={media.parentId} current={media.id} onUpNext={()=>{}} onPlay={onPlay} onOpen={onOpen} busy={busy}/></section>}
    </>}
  </>;
}
