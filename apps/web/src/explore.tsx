import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {exploreGenres,mergeRatings,type ExternalRating,type ExploreBrowseSource,type ExploreGenre,type ExploreDetails,type ExploreItem,ExplorePage,ExploreRowInfo,ExploreSearchResult,ExploreSource,ExploreSources,ExploreStatus,type StreamingRow} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,useDebounced,useInfinitePages,useNearViewport,duration,link,replaceRoute,invalidate} from './hooks.js';
import {Artwork,Empty,ErrorNotice,FadeImage,Icon,Loading,Modal,Row,RowSkeleton} from './components.js';
import {ratingLinks,Ratings} from './library.js';
import {extrasBody,RequestDialog,RequestOptionsPanel,statusNames,type RequestExtras} from './request-dialog.js';
import {MyRequestsButton} from './my-requests.js';
import {clearStreamingSelections,rowKey,useExplorePrefs} from './explore-prefs.js';
import {StreamingSelector,StreamingStatus,useStreamingSelection} from './explore-streaming.js';
import {detailsPath,TitleDiscovery,type OpenRelatedTitle} from './title-discovery.js';
import {displayName,TitleFacts} from './title-facts.js';
import {DialogNavBar} from './dialog-history.js';
import {TrailerButton} from './trailer.js';
import './explore.css';
import {toast} from './toasts.js';

// Explore: titles beyond this server, from Plex Discover (watchlist and Discover shelves) and TMDB, on one page:
// every source's rows in turn, one search across them all, and filters that narrow both.
// A title's dialog opens this server's copy when there is one, requests it (tk.box's library), or watchlists it on Plex.
const names:Record<ExploreSource,string>={plex:'Plex',tmdb:'TMDB'};
const rowPath=(source:ExploreSource,row:string,page:number,fq:string)=>`/explore/${source}/rows/${encodeURIComponent(row)}?page=${page}${fq}`;
const results=(n:number)=>`${n.toLocaleString()} result${n===1?'':'s'}`;
const listed=(parts:string[],type:Intl.ListFormatType='conjunction')=>new Intl.ListFormat(undefined,{type}).format(parts);

// Filters: original languages, genres, a release year range, a minimum score and request labels to hide, kept in this
// browser. The content type and each row's streaming service start over every time Explore opens.
type Filters={languages:string[];genres:ExploreGenre[];from:string;to:string;min:string;hide:Hideable[]};
type Hideable=ExploreStatus;
const noFilters:Filters={languages:[],genres:[],from:'',to:'',min:'',hide:[]},FILTERS_KEY='tk.box.explore.filters';
const contentTypes=[['all','All'],['movie','Movies'],['show','Shows']] as const;
type ContentType=typeof contentTypes[number][0];
const hideable:Hideable[]=['requested','downloading','partial','available'];
// TMDB's codes; `cn` is its code for Cantonese.
const languageCodes=['en','es','fr','de','it','pt','ja','ko','zh','cn','hi','ta','te','ml','ru','sv','da','no','fi','nl','pl','tr','th','ar','he','id','tl'];
const minScores=['5','6','7','8'];
const languageName=(code:string)=>code==='cn'?'Cantonese':displayName('language',code);
const yearText=(value:unknown)=>typeof value==='string'&&/^\d{4}$/.test(value)&&Number(value)>=1870&&Number(value)<=2100?value:'';
function cleanFilters(value:Partial<Record<keyof Filters,unknown>>):Filters {
  const languages=Array.isArray(value.languages)?value.languages.filter((l):l is string=>typeof l==='string'&&languageCodes.includes(l)):[];
  let from=yearText(value.from),to=yearText(value.to);if(from&&to&&from>to)[from,to]=[to,from];
  const hide=Array.isArray(value.hide)?hideable.filter(h=>(value.hide as unknown[]).includes(h)):[];
  const genres=Array.isArray(value.genres)?exploreGenres.filter(g=>(value.genres as unknown[]).includes(g)):[];
  return {languages,genres,from,to,min:typeof value.min==='string'&&minScores.includes(value.min)?value.min:'',hide};
}
// Until a viewer changes them, rows leave out what is already on its way or here; search never does.
const defaultFilters:Filters={...noFilters,hide:['requested','downloading','available']};
const loadFilters=():Filters=>{try{const saved=localStorage.getItem(FILTERS_KEY);return saved===null?defaultFilters:cleanFilters(JSON.parse(saved));}catch{return defaultFilters;}};
const saveFilters=(f:Filters)=>{try{localStorage.setItem(FILTERS_KEY,JSON.stringify(f));}catch{/* storage unavailable; applies until reload */}};
function filterQuery(f:Filters,hide=true) {
  const q=new URLSearchParams();if(f.languages.length)q.set('lang',f.languages.join(','));if(f.genres.length)q.set('genre',f.genres.join(','));if(f.from)q.set('from',f.from);if(f.to)q.set('to',f.to);if(f.min)q.set('min',f.min);if(hide&&f.hide.length)q.set('hide',f.hide.join(','));
  const text=q.toString();return text?`&${text}`:'';
}
const yearLabel=(f:Filters)=>f.from&&f.to?(f.from===f.to?f.from:`${f.from}–${f.to}`):f.from?`${f.from} or later`:`${f.to} or earlier`;

const ExploreCard=memo(function ExploreCard({item,onSelect}:{item:ExploreItem;onSelect:(item:ExploreItem)=>void}) {
  const kindLabel=item.kind==='show'?'Show':'Movie';
  const [ref,visible]=useNearViewport<HTMLDivElement>('0px');
  const complete=(['imdb','tomatometer','tmdb'] as const).every(source=>item.ratings?.some(r=>r.source===source));
  const query=new URLSearchParams({kind:item.kind});
  if(item.ids.plex)query.set('plex',item.ids.plex);
  if(item.ids.tmdb)query.set('tmdb',String(item.ids.tmdb));
  const extra=useApi<ExternalRating[]>(visible&&!complete&&(item.ids.plex||item.ids.tmdb)?`/explore/ratings?${query}`:undefined);
  const ratings=mergeRatings(item.ratings,extra.data);
  return <div ref={ref} className={`poster-card explore-card${item.status?` is-${item.status}`:''}`}>
    <div className="card-frame"><button className="poster-art" onClick={()=>onSelect(item)} aria-label={`${item.title}, ${kindLabel}${item.year?`, ${item.year}`:''}${item.status?`, ${statusNames[item.status]}`:''}`}>
      <Artwork src={item.posterUrl} fallback={<><Icon name={item.kind==='movie'?'movies':'shows'}/><span>{item.title}</span></>}/>
      {item.status&&<span className={`explore-badge ${item.status}`}>{statusNames[item.status]}</span>}
      <span className="explore-kind" aria-hidden="true">{kindLabel}{item.year&&<span className="explore-year"> · {item.year}</span>}</span>
    </button></div>
    <span className="poster-title"><span className="card-plain">{item.title}</span></span>
    <Ratings ratings={ratings} compact/>
  </div>;
});
const Cards=({items,onSelect}:{items:ExploreItem[];onSelect:(item:ExploreItem)=>void})=><div className="poster-grid">{items.map(item=><ExploreCard key={item.key} item={item} onSelect={onSelect}/>)}</div>;
const SourceTag=({source}:{source:ExploreSource})=><span className="explore-source">{names[source]}</span>;

function ExploreRow({source,row,fq,onSelect}:{source:ExploreBrowseSource;row:ExploreRowInfo;fq:string;onSelect:(item:ExploreItem)=>void}) {
  const [ref,near]=useNearViewport<HTMLDivElement>();
  const stream=useStreamingSelection(near&&row.streaming?row.id as StreamingRow:undefined);
  const data=useApi<ExplorePage>(near&&(!row.streaming||stream.query)?rowPath(source,row.id,1,fq+stream.query):undefined),page=data.data;
  const cards=useMemo(()=>page?.items.map(item=><ExploreCard key={item.key} item={item} onSelect={onSelect}/>),[page,onSelect]);
  const title=page?.title??row.title;
  const heading=<span className="explore-row-title"><Icon name={row.icon} size={20}/>{title}<SourceTag source={source}/>{page?.total!==undefined&&page.total>0&&<span className="explore-count">{results(page.total)}</span>}</span>;
  if(row.streaming)return <div ref={ref} className="lazy-row">
    <Row className="explore-streaming-row" title={heading} href={stream.query?link('explore',{source,row:row.id,provider:stream.selected}):undefined}
      headerActions={stream.data&&<StreamingSelector title={title} services={stream.services} selected={stream.selected} onSelect={stream.select}/>}>
      {stream.error||stream.data&&!stream.services.length?<StreamingStatus catalog={stream}/>
        :data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>
        :!page?<div className="explore-row-status"><Loading/></div>
        :page.items.length?cards
        :<p className="muted small explore-row-status">{fq?'Nothing here matches your filters':'No titles found for this selection'}</p>}
    </Row>
  </div>;
  return <div ref={ref} className="lazy-row">{!page?(data.error?<section className="row"><div className="row-heading"><h2>{heading}</h2></div><div className="explore-row-error"><ErrorNotice message={data.error.message} retry={data.reload}/></div></section>:<RowSkeleton title={row.title}/>)
    :page.items.length?<Row title={heading} href={link('explore',{source,row:row.id})}>{cards}</Row>:null}</div>;
}
// One source's rows, less those the viewer hid in Settings › Explore. A source that fails says so in place and leaves the others.
function SourceRows({source,hiddenRows,fq,onSelect}:{source:ExploreBrowseSource;hiddenRows:string[];fq:string;onSelect:(item:ExploreItem)=>void}) {
  const rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`);
  if(rows.error)return <div className="explore-row-error"><ErrorNotice message={`${names[source]}: ${rows.error.message}`} retry={rows.reload}/></div>;
  if(!rows.data)return <RowSkeleton title="Loading"/>;
  return <>{rows.data.rows.filter(row=>!hiddenRows.includes(rowKey(source,row.id))).map(row=><ExploreRow key={row.id} source={source} row={row} fq={fq} onSelect={onSelect}/>)}</>;
}
// "See all": every page of one row.
function ExploreGrid({source,row,fq,provider,onSelect}:{source:ExploreSource;row:string;fq:string;provider:string|null;onSelect:(item:ExploreItem)=>void}) {
  const rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`),info=rows.data?.rows.find(r=>r.id===row);
  const stream=useStreamingSelection(info?.streaming?row as StreamingRow:undefined,provider);
  const heading=info?.title??'';
  const choose=(selected:number|'all')=>{stream.select(selected);replaceRoute(link('explore',{source,row,provider:selected}));};
  const selector=info?.streaming&&stream.data&&<StreamingSelector title={heading} services={stream.services} selected={stream.selected} onSelect={choose}/>;
  return <section className="explore-grid">
    <a className="crumb" href={link('explore')}><Icon name="back" size={14}/>Explore</a>
    {info?.streaming&&<><div className="explore-grid-head"><h1>{heading}<SourceTag source={source}/></h1></div>{selector}</>}
    {rows.error?<ErrorNotice message={rows.error.message} retry={rows.reload}/>:!rows.data?<Loading cards/>
      :!info?<Empty title="This row is unavailable"/>
      :info.streaming&&!stream.query?stream.loading?<Loading cards/>:<StreamingStatus catalog={stream}/>
      :<ExploreGridPages key={fq+stream.query} source={source} row={row} fq={fq+stream.query} filtered={!!fq} title={info.streaming?undefined:heading} onSelect={onSelect}/>}
  </section>;
}
function ExploreGridPages({source,row,fq,filtered,title,onSelect}:{source:ExploreSource;row:string;fq:string;filtered:boolean;title?:string;onSelect:(item:ExploreItem)=>void}) {
  const list=useInfinitePages<ExplorePage>(index=>rowPath(source,row,index+1,fq),1,`${source}/${row}${fq}`),first=list.pages[0];
  const seen=new Set<string>();
  const unique=list.pages.flatMap(p=>p?.items??[]).filter(item=>{
    if(seen.has(item.key))return false;
    seen.add(item.key);
    return true;
  });
  return <>
    {title&&<div className="explore-grid-head"><h1>{first?.title??title}<SourceTag source={source}/>{first?.total!==undefined&&<span className="explore-count">{results(first.total)}</span>}</h1></div>}
    {unique.length?<Cards items={unique} onSelect={onSelect}/>:list.loading?<Loading cards/>:!list.error&&!list.more?<Empty title={filtered?'Nothing here matches your filters':'Nothing here yet'}/>:null}
    {list.error?<ErrorNotice message={list.error instanceof Error?list.error.message:'This row could not be loaded.'} retry={list.retry}/>
      :list.more?<div ref={list.sentinel} className="explore-more"><button type="button" onClick={list.loadMore}>Load more</button></div>:null}
  </>;
}
function ExploreSearch({q,sources,fq,onSelect}:{q:string;sources:ExploreSource[];fq:string;onSelect:(item:ExploreItem)=>void}) {
  const data=useApi<ExploreSearchResult>(`/explore/search?q=${encodeURIComponent(q)}&sources=${sources.join(',')}${fq}`),failed=data.data?.failed??[];
  return <section className="explore-grid">
    <div className="explore-grid-head"><h1>Results{data.data&&<span className="explore-count">{results(data.data.items.length)}</span>}</h1></div>
    {failed.length>0&&<p className="explore-note muted">{listed(failed.map(s=>names[s]))} could not be searched just now.</p>}
    {data.loading&&!data.data?<Loading cards/>:data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>:data.data?.items.length?<Cards items={data.data.items} onSelect={onSelect}/>:<Empty title={fq?`Nothing matches “${q}” with your filters`:`Nothing matches “${q}”`}/>}
  </section>;
}

// A select-like dropdown of checkboxes; its list opens over the rest of the menu.
function Checklist<T extends string>({label,empty,options,name,chosen,join='conjunction',onChange}:{label:string;empty:string;options:readonly T[];name:(option:T)=>string;chosen:T[];join?:Intl.ListFormatType;onChange:(next:T[])=>void}) {
  return <div className="explore-pick"><span>{label}</span>
    <details><summary aria-label={label}>{chosen.length?listed(chosen.map(name),join):empty}</summary>
      <div>{options.map(option=><label key={option}><input type="checkbox" checked={chosen.includes(option)} onChange={e=>onChange(options.filter(o=>o===option?e.target.checked:chosen.includes(o)))}/>{name(option)}</label>)}</div>
    </details>
  </div>;
}
function FilterMenu({filters,labels,onChange}:{filters:Filters;labels:boolean;onChange:(next:Filters)=>void}) {
  const popup=useRef<HTMLDetailsElement>(null),[draft,setDraft]=useState(filters);
  const close=useCallback((restoreFocus:boolean)=>{
    const menu=popup.current;
    if(!menu?.open)return;
    menu.open=false;
    menu.querySelectorAll<HTMLDetailsElement>('.explore-pick details[open]').forEach(pick=>{pick.open=false;});
    if(restoreFocus)menu.querySelector('summary')?.focus();
  },[]);
  const apply=useCallback(()=>{
    if(draft!==filters)onChange(cleanFilters(draft));
  },[draft,filters,onChange]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{
      const menu=popup.current,target=event.target as Node;
      if(!menu?.open)return;
      if(!menu.contains(target)){
        apply();
        close(false);
        return;
      }
      menu.querySelectorAll<HTMLDetailsElement>('.explore-pick details[open]').forEach(pick=>{if(!pick.contains(target))pick.open=false;});
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close(true);};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[apply,close]);
  const count=Number(filters.languages.length>0)+Number(filters.genres.length>0)+Number(!!(filters.from||filters.to))+Number(!!filters.min)+filters.hide.length;
  const toggleHide=(status:Hideable,on:boolean)=>setDraft(d=>({...d,hide:hideable.filter(h=>h===status?on:d.hide.includes(h))}));
  return <details ref={popup} className="browse-popup">
    <summary role="button" aria-label="Filter Explore" onClick={e=>{
      if(popup.current?.open){e.preventDefault();apply();close(true);}
      else setDraft(filters);
    }}><Icon name="filter"/><span>Filters</span>{count>0&&<b>{count}</b>}</summary>
    <form className="browse-menu filter-menu explore-filter-menu" onSubmit={e=>{e.preventDefault();apply();close(true);}}>
      <Checklist label="Language" empty="Any language" options={languageCodes} name={languageName} chosen={draft.languages} join="disjunction" onChange={languages=>setDraft(d=>({...d,languages}))}/>
      <Checklist label="Genre" empty="Any genre" options={exploreGenres} name={g=>g} chosen={draft.genres} join="disjunction" onChange={genres=>setDraft(d=>({...d,genres}))}/>
      <div className="explore-years"><label>Released from<input aria-label="Released from year" type="number" min="1870" max="2100" placeholder="Any" value={draft.from} onChange={e=>setDraft(d=>({...d,from:e.target.value}))}/></label>
        <label>to<input aria-label="Released to year" type="number" min="1870" max="2100" placeholder="Any" value={draft.to} onChange={e=>setDraft(d=>({...d,to:e.target.value}))}/></label></div>
      <label>Rating<select aria-label="Minimum rating" value={draft.min} onChange={e=>setDraft(d=>({...d,min:e.target.value}))}><option value="">Any rating</option>{minScores.map(n=><option key={n} value={n}>{n}+ ★</option>)}</select></label>
      {labels&&<div className="explore-hide">{hideable.map(h=><label key={h}><input type="checkbox" checked={draft.hide.includes(h)} onChange={e=>toggleHide(h,e.target.checked)}/>Hide {statusNames[h].toLowerCase()}</label>)}</div>}
      <div className="button-row"><button className="primary" type="submit">Apply</button><button type="button" onClick={()=>{onChange(defaultFilters);close(true);}}>Reset</button></div>
    </form>
  </details>;
}
// Search ignores the hidden labels, so their chips leave while searching.
function ActiveFilters({filters,searching,onChange}:{filters:Filters;searching:boolean;onChange:(next:Filters)=>void}) {
  const hidden=searching?[]:filters.hide;
  if(!filters.languages.length&&!filters.genres.length&&!filters.from&&!filters.to&&!filters.min&&!hidden.length)return null;
  return <div className="active-filters">
    {filters.languages.length>0&&<button onClick={()=>onChange({...filters,languages:[]})}>{listed(filters.languages.map(languageName),'disjunction')} ×</button>}
    {filters.genres.length>0&&<button onClick={()=>onChange({...filters,genres:[]})}>{listed(filters.genres,'disjunction')} ×</button>}
    {(filters.from||filters.to)&&<button onClick={()=>onChange({...filters,from:'',to:''})}>{yearLabel(filters)} ×</button>}
    {filters.min&&<button onClick={()=>onChange({...filters,min:''})}>{filters.min}+ ★ ×</button>}
    {hidden.map(h=><button key={h} onClick={()=>onChange({...filters,hide:filters.hide.filter(x=>x!==h)})}>No {statusNames[h].toLowerCase()} ×</button>)}
    <button onClick={()=>onChange(noFilters)}>Clear</button>
  </div>;
}

// `requestsButton` false leaves out My requests, for the Requests site, which has its own Requests page.
export function Explore({params,admin,onSelect,requestsButton=true}:{params:URLSearchParams;admin:boolean;onSelect:(item:ExploreItem)=>void;requestsButton?:boolean}) {
  const sources=useApi<ExploreSources>('/explore/sources'),data=sources.data,prefs=useExplorePrefs();
  // Sources in the administrator's order, leaving out those switched off (by the administrator or the viewer) or not set up.
  const offered=data?data.order.filter(s=>s==='plex'?data.plex:data[s].configured):[],available=offered.filter(s=>!prefs.hidden.includes(s));
  const source=available.find(s=>s===params.get('source'));
  const row=params.get('row')??'',query=params.get('q')??'',[text,setText]=useState(query),q=useDebounced(text.trim(),400);
  const [filters,setFilters]=useState(loadFilters),[contentType,changeContentType]=useState<ContentType>('all');
  const changeFilters=(next:Filters)=>{setFilters(next);saveFilters(next);};
  const kindQuery=contentType==='all'?'':`&kind=${contentType}`,fq=filterQuery(filters)+kindQuery,searchFq=filterQuery(filters,false)+kindQuery;
  // Leaving Explore forgets each row's chosen streaming service, so coming back shows All again.
  useEffect(()=>clearStreamingSelections,[]);
  // Typing searches in place; the address keeps the query so Back returns to it.
  useEffect(()=>{if(q!==query)replaceRoute(link('explore',{q}));},[q]);
  if(sources.error)return <div className="page"><ErrorNotice message={sources.error.message} retry={sources.reload}/></div>;
  if(!data)return <div className="page"><Loading/></div>;
  const searchable=available;
  const searchLabel=searchable.length?`Search ${listed(searchable.map(s=>names[s]))}`:'Search Explore';
  return <div className="page toolbar-page explore-page">
    <div className="page-toolbar explore-controls"><h1 className="sr-only">Explore</h1>
      <div className="toolbar-group explore-content-type" role="group" aria-label="Explore content type">
        {contentTypes.map(([type,label])=><button key={type} type="button" aria-pressed={contentType===type} onClick={()=>changeContentType(type)}>{label}</button>)}
      </div>
      <form className="browse-search explore-search" role="search" onSubmit={e=>{e.preventDefault();replaceRoute(link('explore',{q:text.trim()}));}}><Icon name="search"/><input aria-label={searchLabel} placeholder={searchLabel} maxLength={120} value={text} onChange={e=>setText(e.target.value)}/>{text&&<button className="icon-button" type="button" aria-label="Clear search" onClick={()=>{setText('');replaceRoute(link('explore'));}}><Icon name="close"/></button>}</form>
      <FilterMenu filters={filters} labels onChange={changeFilters}/>
      {requestsButton&&<MyRequestsButton/>}
      <button className="icon-button toolbar-icon" aria-label="Refresh" title="Refresh" onClick={()=>void api('/explore/refresh','POST').catch(()=>undefined).then(()=>invalidate('/explore/'))}><Icon name="restart"/></button>
    </div>
    <ActiveFilters filters={filters} searching={!!query} onChange={changeFilters}/>
    {!query&&!row&&data.order.includes('tmdb')&&!prefs.hidden.includes('tmdb')&&!data.tmdb.configured&&<p className="explore-note muted">
      {admin?<>Add a TMDB key in <a href="#admin?section=connections&category=metadata">Admin › Connections</a> to enable streaming discovery and recommendations.</>:<>Streaming discovery and recommendations require a TMDB key from the server administrator.</>}
    </p>}
    {/* Plex Discover doesn't say a title's language; TMDB is where it is looked up. */}
    {filters.languages.length>0&&!data.tmdb.configured&&<p className="explore-note muted">Plex titles without a language are hidden while a language filter is on.</p>}
    {query?<ExploreSearch key={`${query}${searchable.join()}${searchFq}`} q={query} sources={searchable} fq={searchFq} onSelect={onSelect}/>
      :row&&source?<ExploreGrid key={`${source}-${row}${fq}`} source={source} row={row} fq={fq} provider={params.get('provider')} onSelect={onSelect}/>
      :available.length?<div className="explore-rows">{available.map(s=><SourceRows key={s} source={s} hiddenRows={prefs.hiddenRows} fq={fq} onSelect={onSelect}/>)}</div>
      :<Empty title="No browse sources"><a href="#settings?section=explore">Explore settings</a></Empty>}
  </div>;
}

// Request, and for administrators a ▾ menu beside it with the request options, which Request then sends.
function RequestButton({className,busy,admin,kind,onRequest}:{className:string;busy:boolean;admin:boolean;kind:ExploreItem['kind'];onRequest:(extras?:RequestExtras)=>void}) {
  const [open,setOpen]=useState(false),ref=useRef<HTMLDivElement>(null),menu=useRef<HTMLDivElement>(null);
  const [extras,setExtras]=useState<RequestExtras>({});
  // The menu drops below the button. The title header clips what overflows it, so the menu sits in the dialog's
  // content instead, placed under the button.
  const [place,setPlace]=useState<{host:HTMLElement;top:number;left:number}>();
  useLayoutEffect(()=>{
    if(!open){setPlace(undefined);return;}
    const measure=()=>{
      const button=ref.current,host=button?.closest<HTMLElement>('.modal-content');
      if(!button||!host)return;
      const at=button.getBoundingClientRect(),within=host.getBoundingClientRect();
      setPlace({host,top:at.bottom-within.top+6,left:at.left-within.left});
    };
    measure();window.addEventListener('resize',measure);
    return()=>window.removeEventListener('resize',measure);
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{const target=e.target as Node;if(!ref.current?.contains(target)&&!menu.current?.contains(target))setOpen(false);};
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape,true);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);};
  },[open]);
  const main=<button className={className} disabled={busy} onClick={()=>{setOpen(false);onRequest(admin?extras:undefined);}}><Icon name="plus"/>Request</button>;
  if(!admin)return main;
  return <div ref={ref} className={`request-split ${className.split(' ')[0]}`}>
    {main}
    <button className={`${className} request-split-toggle`} disabled={busy} aria-label="Request options" aria-expanded={open} onClick={()=>setOpen(!open)}><Icon name="down" size={16}/></button>
    {open&&place&&createPortal(<div ref={menu} className="request-split-menu" style={{top:place.top,left:place.left}}>
      <RequestOptionsPanel kind={kind} extras={extras} setExtras={setExtras}/>
    </div>,place.host)}
  </div>;
}

export function ExploreDialog({item:start,admin,onClose,onOpen,onOpenRelated}:{item:ExploreItem;admin:boolean;onClose:()=>void;onOpen?:(id:string)=>void;onOpenRelated:OpenRelatedTitle}) {
  const {region}=useExplorePrefs();
  const details=useApi<ExploreDetails>(detailsPath(start,region)),info=details.data,request=info?.request;
  // The card's own artwork and text show at once; details fill in what the card lacked.
  const item:ExploreItem={...start,...info?.item,posterUrl:start.posterUrl??info?.item.posterUrl,backdropUrl:info?.item.backdropUrl??start.backdropUrl,summary:info?.item.summary??start.summary,ids:{...start.ids,...info?.item.ids}};
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const status=info?.item.status??start.status,art=item.backdropUrl??item.posterUrl;
  const facts=[item.year,info?.contentRating,item.kind==='show'?(item.episodeCount?`${item.episodeCount} episodes`:'TV series'):item.durationMs?duration(item.durationMs):undefined,info?.status,
    !info?.ratings.length&&item.rating?`★ ${item.rating.toFixed(1)}`:undefined].filter(Boolean);
  // The request window, for a show's seasons, with any options from Request's menu.
  const [requesting,setRequesting]=useState<false|{extras?:RequestExtras}>(false),canRequest=!!request?.requestable;
  const run=async(action:()=>Promise<unknown>,message:string)=>{if(busy)return;setBusy(true);setError('');try{await action();toast.success(message);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  // Request asks only when there are seasons to choose; anything else is requested at once with Admin › Requests'
  // defaults, or for administrators the options from the ▾ menu beside it.
  const needsWindow=item.kind==='show'&&(request?.seasons.length??0)>1;
  const requestNow=(extras?:RequestExtras)=>void run(async()=>{await api('/requests','POST',{kind:item.kind,tmdb:item.ids.tmdb,...extrasBody(extras)});invalidate('/explore/');invalidate('/requests/mine');},`Requested ${item.title}`);
  const startRequest=(extras?:RequestExtras)=>{if(!needsWindow){requestNow(extras);return;}setError('');setRequesting({extras});};
  const watchlist=(add:boolean)=>void run(async()=>{await api('/explore/watchlist','PUT',{plex:item.ids.plex,add});invalidate('/explore/details');invalidate('/explore/plex/rows/watchlist');},add?'Added to your Plex watchlist':'Removed from your Plex watchlist');
  const feedback=<>{error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}</>;
  return <Modal title={item.title} onClose={onClose} variant="media">
    <DialogNavBar title={item.title}/>
    <div className={`detail-hero${art?'':' no-art'}`}>
      {art&&<FadeImage src={art} alt="" decoding="async" fetchPriority="high" onError={e=>{e.currentTarget.hidden=true;}}/>}<div className="detail-shade"/>
      <div className="detail-hero-content explore-hero">
        {item.posterUrl&&<FadeImage className="explore-hero-poster" src={item.posterUrl} alt="" decoding="async"/>}
        <div className="detail-heading">
          <h1 className="detail-title">{item.title}</h1>
          <div className="detail-facts">
            {facts.length>0&&<p className="detail-meta">{facts.map((fact,i)=><span key={i}>{fact}</span>)}</p>}
            <Ratings ratings={info?.ratings} links={{...ratingLinks({title:item.title,kind:item.kind,...item.ids}),
              ...Object.fromEntries(info?.links.map(l=>[l.site,l.url])??[])}}/>
            {status&&<p className="explore-badges"><span className={`badge explore-status ${status}`}>{statusNames[status]}</span></p>}
          </div>
          <div className="button-row">
            {info?.libraryId&&onOpen&&<button className="primary large" onClick={()=>onOpen(info.libraryId!)}><Icon name="play"/>Watch</button>}
            {canRequest&&<RequestButton className={info?.libraryId&&onOpen?'secondary large':'primary large'} busy={busy} admin={admin} kind={item.kind} onRequest={startRequest}/>}
            <TrailerButton trailer={info?.trailer} title={item.title}/>
            {info?.watchlisted!==undefined&&item.ids.plex&&<button className="secondary large" aria-pressed={info.watchlisted} disabled={busy} onClick={()=>watchlist(!info.watchlisted)}><Icon name={info.watchlisted?'check':'star'}/>{info.watchlisted?'On Watchlist':'Watchlist'}</button>}
            {(details.loading&&!info||busy)&&<span className="spinner small-spinner" aria-label={busy?'Working':'Loading details'}/>}
          </div>
        </div>
      </div>
    </div>
    <div className="detail-body title-detail-body">
      <div className="explore-main">
        {details.error&&<ErrorNotice message={details.error.message} retry={details.reload}/>}
        {info?.tagline&&<p className="tagline">{info.tagline}</p>}
        <p className="synopsis">{item.summary||'No synopsis available.'}</p>
        {feedback}
      </div>
      <TitleFacts kind={item.kind} info={info} genres={item.genres}/>
    </div>
    <TitleDiscovery kind={item.kind} ids={item.ids} cast={info?.cast} onOpen={onOpenRelated}/>
    {requesting&&request&&<RequestDialog item={item} request={request} extras={requesting.extras} onClose={()=>setRequesting(false)} onDone={message=>{setRequesting(false);toast.success(message);}}/>}
  </Modal>;
}
