import {memo,useEffect,useLayoutEffect,useRef,useState,type ImgHTMLAttributes,type KeyboardEvent,type MouseEvent,type ReactNode,type PointerEvent as ReactPointerEvent,type FocusEvent as ReactFocusEvent} from 'react';
import type {CatalogItem,CatalogPage} from '../../../packages/contracts/src/index.js';
import {duration} from './hooks.js';
import {fullyWatched,partlyWatched,updateWatchState,useNotice,useWithOverride} from './media-actions.js';

const paths:Record<string,ReactNode>={
  filter:<path d="M4 7h16M7 12h10M10 17h4"/>,sort:<path d="M4 6h11M4 12h8M4 18h5m8-9v12m-3-3 3 3 3-3"/>,list:<path d="M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1"/>,
  grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  home:<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>,movies:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M7 5l3 5m4-5 3 5M3 5l3-3h15v3"/></>,
  shows:<><rect x="3" y="7" width="18" height="14" rx="2"/><path d="m8 2 4 5 4-5M8 17h8"/></>,live:<><rect x="3" y="4" width="18" height="14" rx="2"/><path d="m10 8 5 3-5 3zM8 22l4-4 4 4"/></>,
  search:<><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 6 6"/></>,
  play:<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>,
  pause:<><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/></>,
  back:<path d="m15 4-8 8 8 8"/>,next:<path d="m9 4 8 8-8 8"/>,close:<path d="m5 5 14 14M19 5 5 19"/>,star:<path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>,
  info:<><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.1"/></>,check:<path d="m4 12.5 5 5L20 6.5"/>,
  volume:<><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></>,mute:<><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m17 9 5 6m0-6-5 6"/></>,
  fullscreen:<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>,minimize:<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>,
  rewind:<><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 3.5v5h5"/><text x="12" y="15.5" fontSize="7" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">10</text></>,
  forward:<><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5"/><path d="M20 3.5v5h-5"/><text x="12" y="15.5" fontSize="7" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">10</text></>,
  expand:<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>,
  captions:<><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M10.5 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6"/></>,
  gear:<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>,
  speed:<><path d="M4.5 18a9 9 0 1 1 15 0"/><path d="m12 13 4-5"/></>,
  more:<><circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/></>,
  up:<path d="m6 15 6-6 6 6" strokeWidth="2.4"/>,down:<path d="m6 9 6 6 6-6" strokeWidth="2.4"/>,
  grip:<>{[9,15].flatMap(x=>[5,12,19].map(y=><circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="currentColor" stroke="none"/>))}</>,
  restart:<><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 3.5v5h5"/></>,plus:<path d="M12 5v14M5 12h14"/>,
  'skip-back':<><path d="M18 5.5v13a.8.8 0 0 1-1.2.7L7.5 12.7a.8.8 0 0 1 0-1.4l9.3-6.5a.8.8 0 0 1 1.2.7z" fill="currentColor" stroke="none"/><path d="M5.5 5v14" strokeWidth="2.2"/></>,
  'skip-next':<><path d="M6 5.5v13a.8.8 0 0 0 1.2.7l9.3-6.5a.8.8 0 0 0 0-1.4L7.2 4.8A.8.8 0 0 0 6 5.5z" fill="currentColor" stroke="none"/><path d="M18.5 5v14" strokeWidth="2.2"/></>,
  queue:<path d="M3 6h13M3 12h13M3 18h8m4-2.5v5l4.5-2.5z"/>,
  collection:<><rect x="3" y="8" width="14" height="13" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v11"/></>,tag:<><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/></>,unwatched:<><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></>,
  explore:<><circle cx="12" cy="12" r="9.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></>,trending:<path d="m3 17 6-6 4 4 8-8m-5 0h5v5"/>,
  clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  calendar:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4"/></>,
};
paths.settings=paths.gear;
export function Icon({name,size=20}:{name:string;size?:number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.movies}</svg>;
}
export function ErrorNotice({message,retry,dismiss}:{message:string;retry?:()=>void;dismiss?:()=>void}) {return <div className="notice error" role="alert"><span>{message}</span>{retry&&<button onClick={retry}>Try again</button>}{dismiss&&<button className="icon-button" aria-label="Dismiss error" onClick={dismiss}><Icon name="close" size={16}/></button>}</div>;}
export function Empty({title,children}:{title:string;children?:ReactNode}) {return <div className="empty"><h3>{title}</h3>{children&&<p>{children}</p>}</div>;}
export function Loading({cards=false}:{cards?:boolean}) {return cards?<div className="poster-grid" aria-label="Loading titles" role="status">{Array.from({length:8},(_,i)=><div key={i} className="skeleton poster-skeleton"/>)}</div>:<div className="loading" role="status"><span className="spinner"/><span className="sr-only">Loading…</span></div>;}
export const subtitle=(item:CatalogItem)=>item.type==='episode'?`${item.showTitle??''} · S${item.seasonNumber??'?'}:E${item.episodeNumber??'?'}`:item.type==='season'?`${item.episodeCount??'—'} episodes`:item.seasonCount?`${item.seasonCount} seasons · ${item.episodeCount??'—'} episodes`:String(item.year??(item.type==='show'?'TV series':'Movie'));
export const meta=(item:CatalogItem)=>[item.year,item.contentRating,item.type==='show'||item.type==='season'?undefined:duration(item.durationMs),item.rating!==undefined?`★ ${item.rating.toFixed(1)}`:undefined].filter(Boolean).join(' · ');
// Key by source so reused cards fade each new image, including images already in cache.
export function FadeImage(props:ImgHTMLAttributes<HTMLImageElement>) {return <LoadedImage key={props.src} {...props}/>;}
function LoadedImage({className='',onLoad,...props}:ImgHTMLAttributes<HTMLImageElement>) {
  const ref=useRef<HTMLImageElement>(null),[loaded,setLoaded]=useState(false);
  useLayoutEffect(()=>{if(ref.current?.complete&&ref.current.naturalWidth>0)setLoaded(true);},[]);
  return <img {...props} ref={ref} className={`art-image${loaded?' art-image-loaded':''}${className?` ${className}`:''}`} onLoad={event=>{setLoaded(true);onLoad?.(event);}}/>;
}
export const Artwork=({src,alt='',fallback,className}:{src?:string;alt?:string;fallback:ReactNode;className?:string})=>{
  const [failed,setFailed]=useState(false);
  return src&&!failed?<FadeImage className={className} src={src} onError={()=>setFailed(true)} loading="lazy" decoding="async" alt={alt}/>:<span className="art-fallback">{fallback}</span>;
};
const Progress=({item}:{item:CatalogItem})=>item.viewOffsetMs>0&&item.durationMs?<span className="card-progress"><span style={{width:`${Math.min(100,item.viewOffsetMs/item.durationMs*100)}%`}}/></span>:null;
// Card text is split into separate links so the show, season and episode each open on their own.
const CardLink=({id,onOpen,code,skip,children}:{id?:string;onOpen:(id:string)=>void;code?:boolean;skip?:boolean;children:ReactNode})=>
  id?<button className={`card-link${code?' code':''}`} tabIndex={skip?-1:undefined} onClick={()=>onOpen(id)}>{children}</button>:<span className="card-plain">{children}</span>;
const Sep=({children}:{children:string})=><span className="card-sep">{children}</span>;
const seriesTitle=(item:CatalogItem)=>item.type==='episode'||item.type==='season'?item.showTitle??item.title:item.title;
function CardText({item,onOpen,detail,titleClass,metaClass}:{item:CatalogItem;onOpen:(id:string)=>void;detail:string;titleClass:string;metaClass:string}) {
  const show=item.type==='episode'?item.showId:item.type==='season'?item.showId??item.parentId:item.id;
  return <>
    <span className={titleClass}><CardLink id={show} onOpen={onOpen}>{seriesTitle(item)}</CardLink></span>
    <span className={metaClass}>{item.type==='episode'?<>
      <CardLink id={item.parentId} onOpen={onOpen} code>S{item.seasonNumber??'?'}</CardLink><Sep>:</Sep>
      <CardLink id={item.id} onOpen={onOpen} code skip>E{item.episodeNumber??'?'}</CardLink><Sep> · </Sep>
      <CardLink id={item.id} onOpen={onOpen}>{item.title}</CardLink>
    </>:item.type==='season'&&item.showTitle?<><CardLink id={item.id} onOpen={onOpen}>{item.title}</CardLink><Sep>{` · ${item.episodeCount??'—'} episodes`}</Sep></>
    :<span className="card-plain">{detail}</span>}</span>
  </>;
}
export type PlayFn=(item:CatalogItem,from?:'resume'|'beginning')=>void;
// Where a menu opens decides its entries: Continue Watching can remove a title, details already show Play.
export type MenuContext='card'|'continue'|'upnext'|'detail'|'episode';
type MenuEntry={label:string;icon:string;run:()=>void};
type MenuPosition={x:number;y:number;flipY:number;alignRight:boolean};
function menuGroups(item:CatalogItem,context:MenuContext,onOpen:(id:string)=>void,onPlay?:PlayFn):MenuEntry[][] {
  const playable=item.type==='movie'||item.type==='episode',resumable=playable&&item.viewOffsetMs>0,play:MenuEntry[]=[],state:MenuEntry[]=[],go:MenuEntry[]=[];
  if(onPlay&&context!=='detail'){play.push({label:resumable?'Resume':'Play',icon:'play',run:()=>onPlay(item)});if(resumable)play.push({label:'Play from beginning',icon:'restart',run:()=>onPlay(item,'beginning')});}
  if(!fullyWatched(item))state.push({label:'Mark as watched',icon:'check',run:()=>void updateWatchState(item,'watched')});
  if(partlyWatched(item))state.push({label:'Mark as unwatched',icon:'unwatched',run:()=>void updateWatchState(item,'unwatched')});
  if(playable&&(context==='continue'||(context==='detail'&&resumable)))state.push({label:'Remove from Continue Watching',icon:'close',run:()=>void updateWatchState(item,'removeContinue')});
  if(playable&&context==='upnext')state.push({label:'Remove from Recommended For You',icon:'close',run:()=>void updateWatchState(item,'removeContinue')});
  const show=item.type==='episode'||item.type==='season'?item.showId??(item.type==='season'?item.parentId:undefined):undefined;
  if(show)go.push({label:'Go to show',icon:'shows',run:()=>onOpen(show)});
  if(item.type==='episode'&&item.parentId)go.push({label:'Go to season',icon:'list',run:()=>onOpen(item.parentId!)});
  if(context!=='detail')go.push({label:'More info',icon:'info',run:()=>onOpen(item.id)});
  return [play,state,go].filter(group=>group.length);
}
// Rendered in the top layer (Popover API), so scrolling rows and dialogs never clip it.
function MediaMenu({title,groups,at,onClose}:{title:string;groups:MenuEntry[][];at:MenuPosition;onClose:(restoreFocus:boolean)=>void}) {
  const ref=useRef<HTMLDivElement>(null),closed=useRef(false),close=useRef(onClose);close.current=onClose;
  const finish=(restoreFocus:boolean)=>{if(closed.current)return;closed.current=true;try{ref.current?.hidePopover();}catch{}close.current(restoreFocus);};
  useLayoutEffect(()=>{
    const menu=ref.current!;menu.showPopover();
    const {width,height}=menu.getBoundingClientRect(),margin=8;
    const top=at.y+height>innerHeight-margin?Math.max(margin,at.flipY-height):at.y,left=Math.min(Math.max(margin,at.alignRight?at.x-width:at.x),innerWidth-width-margin);
    menu.style.top=`${top}px`;menu.style.left=`${left}px`;
    menu.querySelector<HTMLElement>('[role=menuitem]')?.focus({preventScroll:true});
    // Clicking a card button can scroll its row into view; only later scrolling dismisses.
    const opened=performance.now(),dismiss=(event:Event)=>{if(performance.now()-opened>300&&!menu.contains(event.target as Node))finish(false);};
    window.addEventListener('scroll',dismiss,{capture:true,passive:true});window.addEventListener('resize',dismiss);
    return()=>{window.removeEventListener('scroll',dismiss,{capture:true});window.removeEventListener('resize',dismiss);};
  },[]);
  const move=(event:KeyboardEvent)=>{
    const items=Array.from(ref.current!.querySelectorAll<HTMLElement>('[role=menuitem]')),index=items.indexOf(document.activeElement as HTMLElement);
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
    else if(event.key==='Home'||event.key==='End'){event.preventDefault();items[event.key==='Home'?0:items.length-1]?.focus();}
    // Handled here so Escape inside the details dialog closes only the menu.
    else if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();event.stopPropagation();finish(true);}
  };
  return <div ref={ref} popover="auto" className="media-menu" role="menu" aria-label={title} onKeyDown={move} onContextMenu={e=>{e.preventDefault();e.stopPropagation();}} onToggle={e=>{if((e.nativeEvent as ToggleEvent).newState==='closed')finish(false);}}>
    {groups.map((group,i)=><div role="group" key={i}>{group.map(entry=><button key={entry.label} role="menuitem" tabIndex={-1} onClick={()=>{finish(true);entry.run();}}><Icon name={entry.icon} size={18}/>{entry.label}</button>)}</div>)}
  </div>;
}
// The "⋯" button and right-click (or the keyboard context-menu key) open the same menu.
export function useMediaMenu(item:CatalogItem,context:MenuContext,onOpen:(id:string)=>void,onPlay?:PlayFn,buttonClass='card-more') {
  const [at,setAt]=useState<MenuPosition>(),returnTo=useRef<HTMLElement|null>(null),closedAt=useRef(0),button=useRef<HTMLButtonElement>(null);
  const open=(position:MenuPosition)=>{returnTo.current=document.activeElement as HTMLElement|null;setAt(position);};
  const fromElement=(element:HTMLElement)=>{const r=element.getBoundingClientRect();open({x:r.right,y:r.bottom+4,flipY:r.top-4,alignRight:true});};
  const onContextMenu=(event:MouseEvent)=>{
    event.preventDefault();
    if(event.clientX||event.clientY)open({x:event.clientX,y:event.clientY,flipY:event.clientY,alignRight:false});
    else if(button.current)fromElement(button.current);
  };
  const title=item.type==='episode'?`${item.showTitle??''} S${item.seasonNumber??'?'}:E${item.episodeNumber??'?'} ${item.title}`.trim():item.title,card=buttonClass==='card-more';
  // A click on the button that light-dismissed the open menu must not reopen it.
  const trigger=<button ref={button} type="button" className={buttonClass} tabIndex={card?-1:undefined} aria-label={`More options for ${title}`} aria-haspopup="menu" aria-expanded={!!at} onClick={e=>{if(!at&&Date.now()-closedAt.current>200)fromElement(e.currentTarget);}}><Icon name="more" size={card?18:22}/></button>;
  const menu=at&&<MediaMenu title={`Options for ${title}`} groups={menuGroups(item,context,onOpen,onPlay)} at={at} onClose={restore=>{closedAt.current=Date.now();setAt(undefined);if(restore)returnTo.current?.focus({preventScroll:true});}}/>;
  return {trigger,menu,onContextMenu,open:!!at};
}
// Memoized: virtualized grids re-render rows while scrolling, but card props rarely change.
// Portrait cards show the series poster for episodes and seasons; episode stills belong to Continue Watching.
// The centered play button sits beside (not inside) the art button, so clicking the rest of the art still opens details.
const PlayOverlay=({item,onPlay}:{item:CatalogItem;onPlay?:PlayFn})=>
  onPlay?<button className="card-play" tabIndex={-1} aria-label={`Play ${item.title}`} onClick={()=>onPlay(item)}><Icon name="play" size={22}/></button>:null;
export const Poster=memo(function Poster({item:source,onOpen,onPlay}:{item:CatalogItem;onOpen:(id:string)=>void;onPlay?:PlayFn}) {
  const item=useWithOverride(source),title=seriesTitle(item),actions=useMediaMenu(item,'card',onOpen,onPlay);
  const detail=item.type==='episode'?`S${item.seasonNumber??'?'}:E${item.episodeNumber??'?'} · ${item.title}`:item.type==='season'&&item.showTitle?`${item.title} · ${item.episodeCount??'—'} episodes`:subtitle(item);
  return <div className={`poster-card${actions.open?' menu-open':''}`} onContextMenu={actions.onContextMenu}>
    <div className="card-frame"><button className="poster-art" onClick={()=>onOpen(item.id)} aria-label={`${title}, ${detail}`}><Artwork src={item.showPosterUrl??item.posterUrl} fallback={<><Icon name={item.type==='movie'?'movies':'shows'}/><span>{title}</span></>}/>{fullyWatched(item)&&<span className="watched-badge" title="Watched"><Icon name="check" size={12}/></span>}<Progress item={item}/></button><PlayOverlay item={item} onPlay={onPlay}/>{actions.trigger}</div>
    <CardText item={item} onOpen={onOpen} detail={detail} titleClass="poster-title" metaClass="poster-meta"/>
    {actions.menu}
  </div>;
});
// Landscape card used by Continue Watching and Recommended: backdrop art, progress and time remaining.
export const WideCard=memo(function WideCard({item:source,context='continue',onOpen,onPlay}:{item:CatalogItem;context?:'continue'|'upnext';onOpen:(id:string)=>void;onPlay?:PlayFn}) {
  const item=useWithOverride(source),actions=useMediaMenu(item,context,onOpen,onPlay);
  const left=item.durationMs&&item.viewOffsetMs?item.durationMs-item.viewOffsetMs:undefined;
  return <div className={`wide-card${actions.open?' menu-open':''}`} onContextMenu={actions.onContextMenu}>
    <div className="card-frame"><button className="wide-art" onClick={()=>onOpen(item.id)} aria-label={`Open ${item.title}`}>
      <Artwork src={item.type==='episode'?item.posterUrl??item.backdropUrl:item.backdropUrl??item.posterUrl} fallback={<Icon name={item.type==='movie'?'movies':'shows'}/>}/>
      <Progress item={item}/>
    </button><PlayOverlay item={item} onPlay={onPlay}/>{actions.trigger}</div>
    <div className="wide-info"><CardText item={item} onOpen={onOpen} detail={left?`${duration(left)} left`:subtitle(item)} titleClass="wide-title" metaClass="wide-meta"/></div>
    {actions.menu}
  </div>;
});
export function Posters({items,onOpen,onPlay}:{items:CatalogItem[];onOpen:(id:string)=>void;onPlay?:PlayFn}) {return <div className="poster-grid">{items.map(item=><Poster key={item.id} item={item} onOpen={onOpen} onPlay={onPlay}/>)}</div>;}
// Confirms watch-state changes (and reports failures) without blocking the page.
export function ActionNotice() {
  const notice=useNotice();
  return <div className="action-notice" role="status" aria-live="polite">{notice&&<div key={notice.id} className={`notice${notice.error?' error':''}`}><Icon name={notice.error?'info':'check'} size={18}/><span>{notice.text}</span></div>}</div>;
}
// Horizontal, swipeable row with edge arrows that appear on hover (pointer devices only).
export function Row({title,href,children,className='',drift=0}:{title:ReactNode;href?:string;children:ReactNode;className?:string;drift?:number}) {
  const ref=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null),[edges,setEdges]=useState({start:true,end:false}),[loops,setLoops]=useState(false);
  // Only re-renders when an edge changes.
  const update=()=>{const el=ref.current;if(!el)return;const start=el.scrollLeft<8,end=el.scrollLeft+el.clientWidth>=el.scrollWidth-8;setEdges(e=>e.start===start&&e.end===end?e:{start,end});};
  useEffect(()=>{update();const el=ref.current;if(!el)return;const resize=new ResizeObserver(update);resize.observe(el);return()=>resize.disconnect();},[]);
  const looping=drift>0&&loops,endless=useEndless(ref,track,looping,drift);
  // Loop only when the cards overflow; a short row stays still and is not repeated.
  useEffect(()=>{
    if(!drift){setLoops(false);return;}const el=ref.current;if(!el)return;
    // One set's width (cards plus the gap after the last), measured the same way with or without the copies so it settles.
    const check=()=>{const style=getComputedStyle(el),pad=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight),gap=parseFloat(style.columnGap)||0;setLoops((endless.copies()?endless.setWidth():el.scrollWidth-pad+gap)>el.clientWidth);};
    check();const resize=new ResizeObserver(check);resize.observe(el);return()=>resize.disconnect();
  });
  const scroll=(direction:number)=>ref.current?.scrollBy({left:direction*ref.current.clientWidth*.85,behavior:'smooth'});
  return <section className={`row ${className}`}>
    <div className="row-heading"><h2>{href?<a href={href}>{title}<span className="row-more">See all <Icon name="next" size={14}/></span></a>:title}</h2></div>
    <div className="row-viewport" {...endless.handlers}>
      {(looping||!edges.start)&&<button className="row-arrow left" tabIndex={-1} aria-hidden="true" onClick={()=>scroll(-1)}><Icon name="back" size={28}/></button>}
      <div className={`row-scroll ${looping?'row-endless':''}`} ref={ref} onScroll={update}>{looping?<div className="row-track" ref={track}>
        {/* Identical sets: the view rests in the second and jumps back by one set width, which looks seamless. The drift can
            carry it up to one more set past wherever it rests, so two copies follow. */}
        <div className="row-set" inert aria-hidden="true">{children}</div><div className="row-set">{children}</div><div className="row-set" inert aria-hidden="true">{children}</div><div className="row-set" inert aria-hidden="true">{children}</div>
      </div>:children}</div>
      {(looping||!edges.end)&&<button className="row-arrow right" tabIndex={-1} aria-hidden="true" onClick={()=>scroll(1)}><Icon name="next" size={28}/></button>}
    </div>
  </section>;
}
// Drifts an endless row sideways at `speed` px/s. It holds still while the pointer is over the row, keyboard focus
// is inside it, or it is off screen; scrolling by hand still works while it is held. It ignores the system's reduced-motion
// preference on purpose: Settings › Home turns it off, and Windows reports reduced motion whenever animation effects are off.
// The drift is one transform animation on the track, which the browser runs on the compositor: it stays smooth and
// sub-pixel while the page is busy, and costs no script or layout per frame. Hand scrolling moves the scroll position as usual.
function useEndless(ref:{current:HTMLDivElement|null},track:{current:HTMLDivElement|null},on:boolean,speed:number) {
  const held=useRef({hover:false,focus:false}),sync=useRef<()=>void>(()=>{});
  const sets=()=>Array.from(track.current?.children??[]).filter(c=>c.classList.contains('row-set')).map(c=>c.firstElementChild as HTMLElement|null);
  const copies=()=>sets().length===4;
  const setWidth=()=>{const [a,b]=sets();return a&&b?b.offsetLeft-a.offsetLeft:0;};
  // Keeps the view inside the second set by jumping a whole set width, so either direction can go on forever.
  const wrap=(x:number)=>{const w=setWidth();if(!w)return x;while(x<w)x+=w;while(x>=w*2)x-=w;return x;};
  useEffect(()=>{
    const el=ref.current,tr=track.current;if(!on||!el||!tr)return;
    let animation:Animation|undefined,width=0,visible=true;
    const offset=()=>(animation?.effect?.getComputedTiming().progress??0)*width;
    // Moves what the drift has covered into the scroll position, so hand scrolling starts from what is on screen.
    const bake=()=>{if(!animation)return;const moved=offset();animation.pause();animation.currentTime=0;el.scrollLeft=wrap(Math.round(el.scrollLeft+moved));};
    sync.current=()=>{
      if(!animation)return;
      if(held.current.hover||held.current.focus){if(animation.playState!=='paused'||offset())bake();}
      else if(visible)animation.play();else animation.pause();
    };
    // (Re)starts the animation for the current set width, keeping how far it had got.
    const build=()=>{
      const next=setWidth();if(next===width)return;
      const progress=animation?.effect?.getComputedTiming().progress??0;animation?.cancel();animation=undefined;width=next;
      if(width<=el.clientWidth)return;
      if(el.scrollLeft<width||el.scrollLeft>=width*2)el.scrollLeft=wrap(el.scrollLeft||width);
      const duration=width/speed*1000;
      animation=tr.animate([{transform:'translateX(0)'},{transform:`translateX(${-width}px)`}],{duration,iterations:Infinity});
      animation.currentTime=progress*duration;sync.current();
    };
    build();
    const resize=new ResizeObserver(build);resize.observe(el);resize.observe(tr);
    const seen=new IntersectionObserver(([entry])=>{visible=!!entry?.isIntersecting;sync.current();});seen.observe(el);
    // A hand scroll that runs into an outer set is moved back to the matching spot in the middle one.
    const settle=()=>{const x=wrap(el.scrollLeft);if(Math.abs(x-el.scrollLeft)>1)el.scrollLeft=x;};
    el.addEventListener('scrollend',settle);
    return()=>{animation?.cancel();resize.disconnect();seen.disconnect();el.removeEventListener('scrollend',settle);sync.current=()=>{};};
  },[on,speed]);
  const handlers={
    onPointerEnter:(e:ReactPointerEvent<HTMLElement>)=>{if(e.pointerType==='mouse'){held.current.hover=true;sync.current();}},
    onPointerLeave:()=>{held.current.hover=false;sync.current();},
    onFocus:(e:ReactFocusEvent<HTMLElement>)=>{held.current.focus=e.target.matches(':focus-visible');sync.current();},
    onBlur:()=>{held.current.focus=false;sync.current();},
  };
  return {handlers,setWidth,copies};
}
export function RowSkeleton({title,wide=false}:{title:string;wide?:boolean}) {
  return <section className="row" aria-busy="true"><div className="row-heading"><h2>{title}</h2></div><div className="row-scroll">{Array.from({length:8},(_,i)=><div key={i} className={`skeleton ${wide?'wide-skeleton':'poster-skeleton'}`}/>)}</div></section>;
}
export function Pagination({page,onChange}:{page:CatalogPage;onChange:(offset:number)=>void}) {
  if(!page.offset&&!page.hasMore)return null;
  return <div className="pagination"><span>{page.total!==undefined?`${page.total.toLocaleString()} titles`:''}{page.items.length?` · ${page.offset+1}–${page.offset+page.items.length}`:''}</span><div><button disabled={!page.offset} onClick={()=>onChange(Math.max(0,page.offset-page.limit))}>Previous</button><button disabled={!page.hasMore} onClick={()=>onChange(page.offset+page.limit)}>Next</button></div></div>;
}
export function Modal({title,onClose,children,variant}:{title:string;onClose:()=>void;children:ReactNode;variant?:'media'}) {
  const ref=useRef<HTMLDialogElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();document.documentElement.classList.add('modal-open');return()=>{dialog.close();document.documentElement.classList.remove('modal-open');};},[]);
  return <dialog ref={ref} className={variant==='media'?'media-dialog':''} aria-label={title} onCancel={e=>{e.preventDefault();close.current();}} onClick={e=>{if(e.target===ref.current)close.current();}}><div className="modal-content"><button className="icon-button modal-close" aria-label="Close" onClick={onClose}><Icon name="close"/></button>{children}</div></dialog>;
}
