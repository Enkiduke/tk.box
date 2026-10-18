import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useRef,useState} from 'react';
import type {CatalogItem,Library} from '../../../packages/contracts/src/index.js';
import {useApi,useDebounced,link,replaceRoute} from './hooks.js';
import {Empty,ErrorNotice,Icon,Poster,type PlayFn} from './components.js';
import {useCatalogFeed} from './catalog-feed.js';
import {catalogWindow,catalogPages} from './catalog-window.js';
import {readPreference} from './storage.js';

type Layout='grid'|'list';
type Prefs={library:string;genre:string;shelf:'all'|'unwatched';year:string;contentRating:string;sort:'title'|'newest'|'year'|'rating'|'duration';direction:'asc'|'desc';layout:Layout};
type Alphabet={entries:{label:string;offset:number;count:number}[];total:number};
const defaults:Prefs={library:'',genre:'',shelf:'all',year:'',contentRating:'',sort:'title',direction:'asc',layout:'grid'};
function preferences(value:Record<string,unknown>):Prefs {
  const text=(key:string,max=30)=>typeof value[key]==='string'?(value[key] as string).slice(0,max):'';
  return {library:/^\d*$/.test(text('library'))?text('library'):'',genre:/^\d*$/.test(text('genre'))?text('genre'):'',shelf:value.shelf==='unwatched'?'unwatched':'all',year:/^(18[89]\d|19\d\d|20\d\d|2100)$/.test(text('year'))?text('year'):'',contentRating:text('contentRating'),sort:['title','newest','year','rating','duration'].includes(String(value.sort))?value.sort as Prefs['sort']:'title',direction:value.direction==='desc'?'desc':'asc',layout:value.layout==='list'?'list':'grid'};
}
function readPrefs(key:string):Prefs{try{return preferences(JSON.parse(readPreference(localStorage,key)??'{}'));}catch{return defaults;}}
const sortNames={title:'Title',newest:'Date added',year:'Year',rating:'Rating',duration:'Duration'};
type WindowHandle={jump:(index:number)=>void};
const CatalogWindow=forwardRef<WindowHandle,{path?:string;layout:Layout;onOpen:(id:string)=>void;onPlay:PlayFn;onTotal:(total:number|undefined)=>void;onPosition:(index:number)=>void}>(function CatalogWindow({path,layout,onOpen,onPlay,onTotal,onPosition},handle) {
  const root=useRef<HTMLDivElement>(null),feed=useCatalogFeed(path);
  const [geometry,setGeometry]=useState({width:900,top:0,height:800,documentTop:0,controls:56});
  useLayoutEffect(()=>{
    const element=root.current!;let frame=0;
    const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
      // The toolbar sticks below the fixed navigation; rows under either are not visible.
      const bounds=element.getBoundingClientRect(),bar=element.closest('.library-browser')?.querySelector<HTMLElement>('.browse-controls');
      const controls=bar?(parseFloat(getComputedStyle(bar).top)||0)+bar.getBoundingClientRect().height:56;
      const next={width:element.clientWidth,top:Math.max(0,controls+18-bounds.top),height:window.innerHeight-controls,documentTop:bounds.top+window.scrollY,controls};
      setGeometry(g=>g.width===next.width&&g.top===next.top&&g.height===next.height&&g.documentTop===next.documentTop&&g.controls===next.controls?g:next);
    });};
    const resize=new ResizeObserver(measure);resize.observe(element);window.addEventListener('scroll',measure,{passive:true});window.addEventListener('resize',measure);measure();
    return()=>{resize.disconnect();cancelAnimationFrame(frame);window.removeEventListener('scroll',measure);window.removeEventListener('resize',measure);};
  },[path,layout]);
  const gap=18,columns=layout==='list'?1:Math.max(1,Math.floor((geometry.width+gap)/((geometry.width<600?105:geometry.width>1500?175:150)+gap)));
  const width=(geometry.width-(columns-1)*gap)/columns,rowHeight=layout==='list'?104:Math.ceil(width*1.5)+62;
  const range=catalogWindow(feed.count,columns,rowHeight,geometry.top,geometry.height);
  useImperativeHandle(handle,()=>({jump:index=>{feed.load(Math.floor(index/60)*60);window.scrollTo({top:index===0?0:geometry.documentTop+Math.floor(index/columns)*rowHeight-geometry.controls-8,behavior:'instant'});}}),[columns,rowHeight,geometry.documentTop,geometry.controls,feed.load]);
  const anchor=useRef({layout,index:0});
  useLayoutEffect(()=>{if(anchor.current.layout!==layout){const index=anchor.current.index;anchor.current.layout=layout;window.scrollTo({top:index===0?0:geometry.documentTop+Math.floor(index/columns)*rowHeight-geometry.controls-8,behavior:'instant'});}else anchor.current.index=range.visibleIndex;},[layout,range.visibleIndex,columns,rowHeight,geometry.documentTop,geometry.controls]);
  useEffect(()=>{onTotal(feed.total);},[feed.total,onTotal]);
  useEffect(()=>{onPosition(Math.min(feed.count-1,range.visibleIndex+columns-1));},[range.visibleIndex,columns,feed.count,onPosition]);
  const offsets=catalogPages(range.firstRow*columns,(range.endRow+2)*columns,feed.count),signature=offsets.join(',');
  useEffect(()=>{feed.protect(offsets);for(const offset of offsets)feed.load(offset);},[path,signature,feed.loading,feed.total,feed.load]);
  if(!path)return <div ref={root}><Empty title="No library available"/></div>;
  if(feed.total===0)return <div ref={root}><Empty title="No matching titles"/></div>;
  return <div ref={root} className={`catalog-window ${layout==='list'?'catalog-list':''}`} aria-label="Library titles" aria-busy={feed.initial&&feed.loading}>
    {feed.error&&<ErrorNotice message={feed.error.message} retry={feed.retry}/>}
    <div className="catalog-spacer" style={{height:range.height}}>
      {Array.from({length:Math.max(0,range.endRow-range.firstRow)},(_,r)=>{const row=r+range.firstRow;return <div className={`catalog-row ${layout==='list'?'poster-list':''}`} key={row} style={{top:row*rowHeight,gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`}}>{Array.from({length:Math.min(columns,feed.count-row*columns)},(_,c)=>{const index=row*columns+c,item=feed.item(index);return item?<Poster key={item.id} item={item} onOpen={onOpen} onPlay={onPlay}/>:<div key={`loading-${index}`} className="skeleton catalog-placeholder" style={{height:rowHeight-18}} aria-hidden="true"/>;})}</div>;})}
    </div>
    <div className="catalog-status" role="status">{feed.loading?'Loading…':feed.total!==undefined&&range.endRow*columns>=feed.total?'End of library':''}</div>
  </div>;
});

export function LibraryView({type,libraries,params,onOpen,onPlay,accountId}:{type:'movie'|'show';libraries:Library[];params:URLSearchParams;onOpen:(id:string)=>void;onPlay:PlayFn;accountId:string}) {
  const storageKey=`tk.box:browse:${accountId}:${type}`,[saved,setSaved]=useState(()=>readPrefs(storageKey)),page=type==='movie'?'movies':'shows';
  const merged={...saved};for(const key of Object.keys(defaults) as (keyof Prefs)[])if(params.has(key))Object.assign(merged,{[key]:params.get(key)});
  const prefs=preferences(merged),options=libraries.filter(l=>l.type===type),library=options.find(l=>l.key===prefs.library)??options[0],q=params.get('q')??'';
  const [search,setSearch]=useState(q),[total,setTotal]=useState<number>(),[position,setPosition]=useState(0),[draft,setDraft]=useState(prefs);
  const filterPopup=useRef<HTMLDetailsElement>(null),sortPopup=useRef<HTMLDetailsElement>(null),windowRef=useRef<WindowHandle>(null);
  function navigate(values:Partial<Prefs>&{q?:string},replace=false) {
    const next=preferences({...prefs,library:library?.key,...values}),query={...next,q:values.q??q};
    setSaved(next);try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{}
    const hash=link(page,query);if(replace)replaceRoute(hash);else window.location.hash=hash;
  }
  useEffect(()=>{setSearch(q);},[q]);
  const settled=useDebounced(search,250);
  useEffect(()=>{if(settled!==q)navigate({q:settled},true);},[settled]);
  useEffect(()=>{const outside=(event:PointerEvent)=>{for(const ref of [filterPopup,sortPopup])if(ref.current&&!ref.current.contains(event.target as Node))ref.current.open=false;};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')for(const ref of [filterPopup,sortPopup])if(ref.current?.open){ref.current.open=false;ref.current.querySelector('summary')?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[]);
  const query=new URLSearchParams({q,sort:prefs.sort,direction:prefs.direction,genre:prefs.genre,shelf:prefs.shelf,...(prefs.year?{year:prefs.year}:{}),contentRating:prefs.contentRating});
  const path=library?`/catalog/libraries/${library.key}/items?${query}`:undefined;
  const genres=useApi<{genres:{id:string;title:string}[]}>(library?`/catalog/libraries/${library.key}/genres`:undefined);
  const index=useApi<Alphabet>(library&&prefs.sort==='title'?`/catalog/libraries/${library.key}/index?${query}`:undefined);
  useEffect(()=>{window.scrollTo({top:0,behavior:'instant'});},[path]);
  const filterCount=Number(!!prefs.genre)+Number(prefs.shelf!=='all')+Number(!!prefs.year)+Number(!!prefs.contentRating);
  const active=index.data?.entries.filter(e=>e.offset<=position).at(-1)?.label;
  const reset=()=>{setSearch('');navigate({genre:'',shelf:'all',year:'',contentRating:'',q:''});};
  return <section className="library-browser page" aria-label={type==='movie'?'Movies':'TV shows'}>
    <div className="browse-controls"><h1 className="browse-title">{type==='movie'?'Movies':'TV Shows'}</h1>
      {options.length>1&&<select className="browse-library" aria-label="Library" value={library?.key} onChange={e=>navigate({library:e.target.value,genre:''})}>{options.map(l=><option key={l.key} value={l.key}>{l.title}</option>)}</select>}
      <form className="browse-search" onSubmit={e=>{e.preventDefault();navigate({q:search},true);}}><Icon name="search"/><input aria-label="Search titles" placeholder={type==='movie'?'Search movies':'Search TV shows'} maxLength={120} value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button className="icon-button" type="button" aria-label="Clear search" onClick={()=>{setSearch('');navigate({q:''},true);}}><Icon name="close"/></button>}</form>
      <details ref={filterPopup} className="browse-popup" onToggle={e=>{if(e.currentTarget.open)setDraft(prefs);}}><summary role="button" aria-label="Filter library"><Icon name="filter"/><span>Filters</span>{filterCount>0&&<b>{filterCount}</b>}</summary><form className="browse-menu filter-menu" onSubmit={e=>{e.preventDefault();navigate({genre:draft.genre,shelf:draft.shelf,year:draft.year,contentRating:draft.contentRating});if(filterPopup.current){filterPopup.current.open=false;filterPopup.current.querySelector('summary')?.focus();}}}><label>Genre<select aria-label="Genre" value={draft.genre} onChange={e=>setDraft(d=>({...d,genre:e.target.value}))}><option value="">All genres</option>{genres.data?.genres.map(g=><option key={g.id} value={g.id}>{g.title}</option>)}</select></label>{genres.error&&<ErrorNotice message="Genres unavailable" retry={genres.reload}/>}<label>Watch status<select aria-label="Watch status" value={draft.shelf} onChange={e=>setDraft(d=>({...d,shelf:e.target.value as Prefs['shelf']}))}><option value="all">All titles</option><option value="unwatched">Unwatched</option></select></label><div className="filter-pair"><label>Year<input aria-label="Release year" type="number" min="1880" max="2100" placeholder="Any" value={draft.year} onChange={e=>setDraft(d=>({...d,year:e.target.value}))}/></label><label>Content rating<input aria-label="Content rating" placeholder="Any, e.g. PG-13" value={draft.contentRating} maxLength={30} onChange={e=>setDraft(d=>({...d,contentRating:e.target.value}))}/></label></div><div className="button-row"><button className="primary" type="submit">Apply</button><button type="button" onClick={()=>{reset();if(filterPopup.current){filterPopup.current.open=false;filterPopup.current.querySelector('summary')?.focus();}}}>Reset</button></div></form></details>
      <details ref={sortPopup} className="browse-popup"><summary role="button" aria-label="Sort library"><Icon name="sort"/><span>{sortNames[prefs.sort]}</span><span className="sort-arrow">{prefs.direction==='asc'?'↑':'↓'}</span></summary><div className="browse-menu sort-menu"><label>Sort by<select aria-label="Sort by" value={prefs.sort} onChange={e=>navigate({sort:e.target.value as Prefs['sort'],direction:e.target.value==='title'?'asc':'desc'})}>{Object.entries(sortNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Order<select aria-label="Sort direction" value={prefs.direction} onChange={e=>navigate({direction:e.target.value as Prefs['direction']})}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label></div></details>
      <button className="browse-layout icon-button" aria-label={prefs.layout==='grid'?'Show list view':'Show grid view'} onClick={()=>navigate({layout:prefs.layout==='grid'?'list':'grid'})}><Icon name={prefs.layout==='grid'?'list':'grid'}/></button>
      <span className="browse-count" aria-label={total===undefined?'Loading titles':`${total} titles`}>{total?.toLocaleString()}</span>
    </div>
    {filterCount>0&&<div className="active-filters">{prefs.genre&&<button onClick={()=>navigate({genre:''})}>{genres.data?.genres.find(g=>g.id===prefs.genre)?.title??'Genre'} ×</button>}{prefs.shelf==='unwatched'&&<button onClick={()=>navigate({shelf:'all'})}>Unwatched ×</button>}{prefs.year&&<button onClick={()=>navigate({year:''})}>{prefs.year} ×</button>}{prefs.contentRating&&<button onClick={()=>navigate({contentRating:''})}>{prefs.contentRating} ×</button>}<button onClick={reset}>Clear</button></div>}
    <div className={prefs.sort==='title'?'catalog-with-index':''}><CatalogWindow ref={windowRef} path={path} layout={prefs.layout} onOpen={onOpen} onPlay={onPlay} onTotal={setTotal} onPosition={setPosition}/></div>
    {prefs.sort==='title'&&<nav className="alphabet-rail" aria-label="Jump to letter">{index.error?<button title="Retry alphabet" aria-label="Reload alphabet" onClick={index.reload}>↻</button>:index.data&&index.data.total!==total&&total!==undefined?<button title="Refresh alphabet" aria-label="Refresh alphabet" onClick={index.reload}>↻</button>:(index.data?.entries??Array.from('#ABCDEFGHIJKLMNOPQRSTUVWXYZ',label=>({label,offset:0,count:0}))).map(entry=><button key={entry.label} aria-label={`Jump to ${entry.label}`} aria-current={active===entry.label?'location':undefined} disabled={!entry.count} title={`${entry.label} · ${entry.count} titles`} onClick={()=>windowRef.current?.jump(entry.offset)}>{entry.label}</button>)}</nav>}
  </section>;
}
