import {memo,useEffect,useRef,useState,type ReactNode} from 'react';
import type {ExploreDetails,ExploreItem,ExplorePage,ExploreRowInfo,ExploreSearchResult,ExploreSource,ExploreSources,ExploreStatus} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,useDebounced,useInfinitePages,useNearViewport,duration,link,replaceRoute,invalidate} from './hooks.js';
import {Artwork,Empty,ErrorNotice,FadeImage,Icon,Loading,Modal,People,Row,RowSkeleton} from './components.js';
import {Ratings} from './library.js';
import {RequestDialog} from './request-dialog.js';
import './explore.css';

// Explore: titles beyond this server, from Plex Discover (watchlist and Discover shelves), Seerr and Trakt, on one page:
// every source's rows in turn, one search across them all, and filters that narrow both.
// A title's dialog opens this server's copy when there is one, requests it through Seerr, or watchlists it on Plex.
const names:Record<ExploreSource,string>={plex:'Plex',seerr:'Seerr',trakt:'Trakt'};
const statusNames:Record<ExploreStatus,string>={available:'Available',partial:'Partly available',requested:'Requested'};
const rowPath=(source:ExploreSource,row:string,page:number,fq:string)=>`/explore/${source}/rows/${encodeURIComponent(row)}?page=${page}${fq}`;
const cardMeta=(item:ExploreItem)=>[item.rating?`${item.rating.toFixed(1)}★`:undefined,item.year,item.kind==='show'?(item.episodeCount?`${item.episodeCount} eps`:'TV series'):item.durationMs?duration(item.durationMs):undefined].filter(Boolean).join(' · ');
const results=(n:number)=>`${n.toLocaleString()} result${n===1?'':'s'}`;
const listed=(parts:string[])=>new Intl.ListFormat(undefined,{type:'conjunction'}).format(parts);

// Filters: original languages, a release year range and a minimum score, kept in this browser.
type Filters={languages:string[];from:string;to:string;min:string};
const noFilters:Filters={languages:[],from:'',to:'',min:''},FILTERS_KEY='tk.box.explore.filters';
// TMDB's codes; `cn` is its code for Cantonese.
const languageCodes=['en','es','fr','de','it','pt','ja','ko','zh','cn','hi','ta','te','ml','ru','sv','da','no','fi','nl','pl','tr','th','ar','he','id','tl'];
const minScores=['5','6','7','8'];
const languageName=(code:string)=>code==='cn'?'Cantonese':displayName('language',code);
const yearText=(value:unknown)=>typeof value==='string'&&/^\d{4}$/.test(value)&&Number(value)>=1870&&Number(value)<=2100?value:'';
function cleanFilters(value:Partial<Record<keyof Filters,unknown>>):Filters {
  const languages=Array.isArray(value.languages)?value.languages.filter((l):l is string=>typeof l==='string'&&languageCodes.includes(l)):[];
  let from=yearText(value.from),to=yearText(value.to);if(from&&to&&from>to)[from,to]=[to,from];
  return {languages,from,to,min:typeof value.min==='string'&&minScores.includes(value.min)?value.min:''};
}
const loadFilters=():Filters=>{try{return cleanFilters(JSON.parse(localStorage.getItem(FILTERS_KEY)??'{}'));}catch{return noFilters;}};
const saveFilters=(f:Filters)=>{try{localStorage.setItem(FILTERS_KEY,JSON.stringify(f));}catch{/* storage unavailable; applies until reload */}};
function filterQuery(f:Filters) {
  const q=new URLSearchParams();if(f.languages.length)q.set('lang',f.languages.join(','));if(f.from)q.set('from',f.from);if(f.to)q.set('to',f.to);if(f.min)q.set('min',f.min);
  const text=q.toString();return text?`&${text}`:'';
}
const yearLabel=(f:Filters)=>f.from&&f.to?(f.from===f.to?f.from:`${f.from}–${f.to}`):f.from?`${f.from} or later`:`${f.to} or earlier`;

const ExploreCard=memo(function ExploreCard({item,onSelect}:{item:ExploreItem;onSelect:(item:ExploreItem)=>void}) {
  return <div className={`poster-card explore-card${item.status?` is-${item.status}`:''}`}>
    <div className="card-frame"><button className="poster-art" onClick={()=>onSelect(item)} aria-label={`${item.title}, ${item.kind==='show'?'TV':'Movie'}${item.year?`, ${item.year}`:''}${item.status?`, ${statusNames[item.status]}`:''}`}>
      <Artwork src={item.posterUrl} fallback={<><Icon name={item.kind==='movie'?'movies':'shows'}/><span>{item.title}</span></>}/>
      {item.status&&<span className={`explore-badge ${item.status}`}>{statusNames[item.status]}</span>}
      <span className="explore-kind" aria-hidden="true">{item.kind==='show'?'TV':'Movie'}</span>
    </button></div>
    <span className="poster-title"><span className="card-plain">{item.title}</span></span>
    <span className="poster-meta"><span className="card-plain">{cardMeta(item)}</span></span>
  </div>;
});
const Cards=({items,onSelect}:{items:ExploreItem[];onSelect:(item:ExploreItem)=>void})=><div className="poster-grid">{items.map(item=><ExploreCard key={item.key} item={item} onSelect={onSelect}/>)}</div>;
const SourceTag=({source}:{source:ExploreSource})=><span className="explore-source">{names[source]}</span>;

function ExploreRow({source,row,fq,onSelect}:{source:ExploreSource;row:ExploreRowInfo;fq:string;onSelect:(item:ExploreItem)=>void}) {
  const [ref,near]=useNearViewport<HTMLDivElement>(),data=useApi<ExplorePage>(near?rowPath(source,row.id,1,fq):undefined),page=data.data;
  const heading=<span className="explore-row-title"><Icon name={row.icon} size={20}/>{row.title}<SourceTag source={source}/>{page?.total!==undefined&&page.total>0&&<span className="explore-count">{results(page.total)}</span>}</span>;
  return <div ref={ref} className="lazy-row">{!page?(data.error?<section className="row"><div className="row-heading"><h2>{heading}</h2></div><div className="explore-row-error"><ErrorNotice message={data.error.message} retry={data.reload}/></div></section>:<RowSkeleton title={row.title}/>)
    :page.items.length?<Row title={heading} href={link('explore',{source,row:row.id})}>{page.items.map(item=><ExploreCard key={item.key} item={item} onSelect={onSelect}/>)}</Row>:null}</div>;
}
// One source's rows. A source that fails says so in place and leaves the others.
function SourceRows({source,fq,onSelect}:{source:ExploreSource;fq:string;onSelect:(item:ExploreItem)=>void}) {
  const rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`);
  if(rows.error)return <div className="explore-row-error"><ErrorNotice message={`${names[source]}: ${rows.error.message}`} retry={rows.reload}/></div>;
  if(!rows.data)return <RowSkeleton title="Loading"/>;
  return <>{rows.data.rows.map(row=><ExploreRow key={row.id} source={source} row={row} fq={fq} onSelect={onSelect}/>)}</>;
}
// "See all": every page of one row.
function ExploreGrid({source,row,fq,onSelect}:{source:ExploreSource;row:string;fq:string;onSelect:(item:ExploreItem)=>void}) {
  const rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`),info=rows.data?.rows.find(r=>r.id===row);
  const list=useInfinitePages<ExplorePage>(index=>rowPath(source,row,index+1,fq),1,`${source}/${row}${fq}`),first=list.pages[0];
  const items=list.pages.flatMap(p=>p?.items??[]),unique=items.filter((item,i)=>items.findIndex(other=>other.key===item.key)===i);
  return <section className="explore-grid">
    <div className="explore-grid-head"><a className="crumb" href={link('explore')}><Icon name="back" size={14}/>Explore</a><h1>{info?.title??''}<SourceTag source={source}/>{first?.total!==undefined&&<span className="explore-count">{results(first.total)}</span>}</h1></div>
    {!first&&list.loading?<Loading cards/>:!first?<ErrorNotice message="This row could not be loaded." retry={()=>invalidate(`/explore/${source}/rows/`)}/>:unique.length?<Cards items={unique} onSelect={onSelect}/>:list.more?null:<Empty title={fq?'Nothing here matches your filters':'Nothing here yet'}/>}
    {list.more&&<div ref={list.sentinel} className="explore-more">{list.loading&&<Loading/>}</div>}
  </section>;
}
function ExploreSearch({q,fq,onSelect}:{q:string;fq:string;onSelect:(item:ExploreItem)=>void}) {
  const data=useApi<ExploreSearchResult>(`/explore/search?q=${encodeURIComponent(q)}${fq}`),failed=data.data?.failed??[];
  return <section className="explore-grid">
    <div className="explore-grid-head"><h1>Results{data.data&&<span className="explore-count">{results(data.data.items.length)}</span>}</h1></div>
    {failed.length>0&&<p className="explore-note muted">{listed(failed.map(s=>names[s]))} could not be searched just now.</p>}
    {data.loading&&!data.data?<Loading cards/>:data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>:data.data?.items.length?<Cards items={data.data.items} onSelect={onSelect}/>:<Empty title={fq?`Nothing matches “${q}” with your filters`:`Nothing matches “${q}”`}/>}
  </section>;
}

function FilterMenu({filters,onChange}:{filters:Filters;onChange:(next:Filters)=>void}) {
  const popup=useRef<HTMLDetailsElement>(null),[draft,setDraft]=useState(filters);
  const close=()=>{if(popup.current?.open){popup.current.open=false;popup.current.querySelector('summary')?.focus();}};
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(popup.current&&!popup.current.contains(event.target as Node))popup.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[]);
  const count=Number(filters.languages.length>0)+Number(!!(filters.from||filters.to))+Number(!!filters.min);
  const toggle=(code:string,on:boolean)=>setDraft(d=>({...d,languages:on?[...d.languages,code]:d.languages.filter(l=>l!==code)}));
  return <details ref={popup} className="browse-popup" onToggle={e=>{if(e.currentTarget.open)setDraft(filters);}}>
    <summary role="button" aria-label="Filter Explore"><Icon name="filter"/><span>Filters</span>{count>0&&<b>{count}</b>}</summary>
    <form className="browse-menu filter-menu explore-filter-menu" onSubmit={e=>{e.preventDefault();onChange(cleanFilters(draft));close();}}>
      <fieldset className="explore-languages"><legend>Language</legend>
        <div>{languageCodes.map(code=><label key={code}><input type="checkbox" checked={draft.languages.includes(code)} onChange={e=>toggle(code,e.target.checked)}/>{languageName(code)}</label>)}</div>
      </fieldset>
      <div className="explore-years"><label>Released from<input aria-label="Released from year" type="number" min="1870" max="2100" placeholder="Any" value={draft.from} onChange={e=>setDraft(d=>({...d,from:e.target.value}))}/></label>
        <label>to<input aria-label="Released to year" type="number" min="1870" max="2100" placeholder="Any" value={draft.to} onChange={e=>setDraft(d=>({...d,to:e.target.value}))}/></label></div>
      <label>Rating<select aria-label="Minimum rating" value={draft.min} onChange={e=>setDraft(d=>({...d,min:e.target.value}))}><option value="">Any rating</option>{minScores.map(n=><option key={n} value={n}>{n}+ ★</option>)}</select></label>
      <div className="button-row"><button className="primary" type="submit">Apply</button><button type="button" onClick={()=>{onChange(noFilters);close();}}>Reset</button></div>
    </form>
  </details>;
}
function ActiveFilters({filters,onChange}:{filters:Filters;onChange:(next:Filters)=>void}) {
  if(!filters.languages.length&&!filters.from&&!filters.to&&!filters.min)return null;
  return <div className="active-filters">
    {filters.languages.length>0&&<button onClick={()=>onChange({...filters,languages:[]})}>{listed(filters.languages.map(languageName))} ×</button>}
    {(filters.from||filters.to)&&<button onClick={()=>onChange({...filters,from:'',to:''})}>{yearLabel(filters)} ×</button>}
    {filters.min&&<button onClick={()=>onChange({...filters,min:''})}>{filters.min}+ ★ ×</button>}
    <button onClick={()=>onChange(noFilters)}>Clear</button>
  </div>;
}

export function Explore({params,admin,onOpen}:{params:URLSearchParams;admin:boolean;onOpen:(id:string)=>void}) {
  const sources=useApi<ExploreSources>('/explore/sources'),data=sources.data;
  // Sources in the administrator's order, leaving out those switched off or not set up.
  const available=data?data.order.filter(s=>s==='plex'?data.plex:data[s].configured):[];
  const wanted=params.get('source') as ExploreSource|null,source=wanted&&available.includes(wanted)?wanted:undefined;
  const row=params.get('row')??'',query=params.get('q')??'',[text,setText]=useState(query),q=useDebounced(text.trim(),400);
  const [filters,setFilters]=useState(loadFilters),fq=filterQuery(filters);
  const [selected,setSelected]=useState<ExploreItem>();
  const changeFilters=(next:Filters)=>{setFilters(next);saveFilters(next);};
  // Typing searches in place; the address keeps the query so Back returns to it.
  useEffect(()=>{if(q!==query)replaceRoute(link('explore',{q}));},[q]);
  if(sources.error)return <div className="page"><ErrorNotice message={sources.error.message} retry={sources.reload}/></div>;
  if(!data)return <div className="page"><Loading/></div>;
  if(!available.length)return <div className="page"><Empty title="Nothing to explore">{admin?<>Every source is switched off in <a href="#admin?section=explore">Admin › Explore</a>.</>:'Explore has no sources right now.'}</Empty></div>;
  const searchLabel=`Search ${listed(available.map(s=>names[s]))}`;
  return <div className="page explore-page">
    <div className="browse-controls explore-controls"><h1 className="sr-only">Explore</h1>
      <form className="browse-search explore-search" role="search" onSubmit={e=>{e.preventDefault();replaceRoute(link('explore',{q:text.trim()}));}}><Icon name="search"/><input aria-label={searchLabel} placeholder={searchLabel} maxLength={120} value={text} onChange={e=>setText(e.target.value)}/>{text&&<button className="icon-button" type="button" aria-label="Clear search" onClick={()=>{setText('');replaceRoute(link('explore'));}}><Icon name="close"/></button>}</form>
      <FilterMenu filters={filters} onChange={changeFilters}/>
      <button className="icon-button browse-layout" aria-label="Refresh" title="Refresh" onClick={()=>void api('/explore/refresh','POST').catch(()=>undefined).then(()=>invalidate('/explore/'))}><Icon name="restart"/></button>
    </div>
    <ActiveFilters filters={filters} onChange={changeFilters}/>
    {/* Plex and Trakt titles carry Seerr's labels only when the server can read Seerr's media list with the API key. */}
    {admin&&data.seerr.configured&&!data.seerr.statuses&&<p className="explore-note muted">Add the Seerr API key in <a href="#admin?section=connections">Admin › Connections</a> to show Available and Requested on Plex and Trakt titles.</p>}
    {data.trakt.configured&&!data.trakt.linked&&!query&&!row&&<p className="explore-note muted">Connect your Trakt account in <a href="#settings">Settings › Explore</a> to see your Trakt watchlist and recommendations.</p>}
    {/* Plex Discover doesn't say a title's language; Seerr is where it is looked up. */}
    {filters.languages.length>0&&!data.seerr.configured&&<p className="explore-note muted">Plex titles don’t list their language, so they are hidden while a language filter is on.</p>}
    {query?<ExploreSearch key={`${query}${fq}`} q={query} fq={fq} onSelect={setSelected}/>
      :row&&source?<ExploreGrid key={`${source}-${row}${fq}`} source={source} row={row} fq={fq} onSelect={setSelected}/>
      :<div className="explore-rows">{available.map(s=><SourceRows key={s} source={s} fq={fq} onSelect={setSelected}/>)}</div>}
    {selected&&<ExploreDialog item={selected} seerrOn={data.seerr.configured} onClose={()=>setSelected(undefined)} onOpen={id=>{setSelected(undefined);onOpen(id);}}/>}
  </div>;
}

function detailsPath(item:ExploreItem) {
  const q=new URLSearchParams({kind:item.kind,title:item.title});
  if(item.year)q.set('year',String(item.year));
  for(const key of ['tmdb','imdb','tvdb','plex'] as const){const value=item.ids[key];if(value!==undefined)q.set(key,String(value));}
  return `/explore/details?${q}`;
}
const siteNames:Record<ExploreDetails['links'][number]['site'],string>={tmdb:'TMDB',tvdb:'TVDB',imdb:'IMDb',rottentomatoes:'Rotten Tomatoes',trakt:'Trakt'};
const displayName=(type:'language'|'region',code:string)=>{try{return new Intl.DisplayNames(undefined,{type}).of(code)??code;}catch{return code;}};
const longDate=(iso:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:'long',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));

// Beside the synopsis, the same quiet label-over-value list as the library's details.
function Facts({item,info}:{item:ExploreItem;info:ExploreDetails}) {
  const rows:[string,ReactNode][]=[
    [item.kind==='show'?'Network':info.studios.length>1?'Studios':'Studio',item.kind==='show'?info.network:info.studios.join(', ')],
    [item.kind==='movie'?'Released':'Premiered',info.released&&longDate(info.released)],
    [info.countries.length>1?'Countries':'Country',info.countries.length>0&&<span className="explore-countries">{info.countries.map(c=><span key={c.name}>{c.flagUrl&&<img src={c.flagUrl} alt="" className="explore-flag"/>}{c.code?displayName('region',c.code):c.name}</span>)}</span>],
    ['Language',info.language&&displayName('language',info.language)],
    ['Genres',info.genres.join(', ')],['Starring',info.cast.length>0&&<People names={info.cast.slice(0,5)} kind={item.kind} tmdb={item.ids.tmdb}/>],
    ['Streaming on',info.providers.length>0&&<span className="explore-providers">{info.providers.map(p=>p.logoUrl?<img key={p.name} src={p.logoUrl} alt={p.name} title={p.name}/>:<span key={p.name}>{p.name}</span>)}</span>]];
  return <aside className="explore-facts">
    <dl className="detail-people">{rows.filter(([,value])=>!!value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {info.links.length>0&&<p className="explore-links">{info.links.map(l=><a key={l.site} href={l.url} target="_blank" rel="noreferrer">{siteNames[l.site]}</a>)}</p>}
  </aside>;
}
function ExploreDialog({item:start,seerrOn,onClose,onOpen}:{item:ExploreItem;seerrOn:boolean;onClose:()=>void;onOpen:(id:string)=>void}) {
  const details=useApi<ExploreDetails>(detailsPath(start)),info=details.data,seerr=info?.seerr;
  // The card's own artwork and text show at once; details fill in what the card lacked.
  const item:ExploreItem={...start,...info?.item,posterUrl:start.posterUrl??info?.item.posterUrl,backdropUrl:info?.item.backdropUrl??start.backdropUrl,summary:info?.item.summary??start.summary,ids:{...start.ids,...info?.item.ids}};
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState('');
  const status=info?.item.status??start.status,art=item.backdropUrl??item.posterUrl;
  const facts=[item.year,info?.contentRating,item.kind==='show'?(item.episodeCount?`${item.episodeCount} episodes`:'TV series'):item.durationMs?duration(item.durationMs):undefined,info?.status,
    !info?.ratings.length&&item.rating?`★ ${item.rating.toFixed(1)}`:undefined].filter(Boolean);
  const [requesting,setRequesting]=useState(false),canRequest=!!seerr&&(seerr.requestable||seerr.requestable4k);
  const run=async(action:()=>Promise<unknown>,message:string)=>{if(busy)return;setBusy(true);setError('');setDone('');try{await action();setDone(message);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const watchlist=(add:boolean)=>void run(async()=>{await api('/explore/watchlist','PUT',{plex:item.ids.plex,add});invalidate('/explore/details');invalidate('/explore/plex/rows/watchlist');},add?'Added to your Plex watchlist.':'Removed from your Plex watchlist.');
  const feedback=<>{error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}{done&&<p className="success explore-done" role="status"><Icon name="check" size={16}/>{done}</p>}</>;
  return <Modal title={item.title} onClose={onClose} variant="media">
    <div className={`detail-hero${art?'':' no-art'}`}>
      {art&&<FadeImage src={art} alt="" decoding="async" fetchPriority="high" onError={e=>{e.currentTarget.hidden=true;}}/>}<div className="detail-shade"/>
      <div className="detail-hero-content explore-hero">
        {item.posterUrl&&<FadeImage className="explore-hero-poster" src={item.posterUrl} alt="" decoding="async"/>}
        <div className="detail-heading">
          <h1 className="detail-title">{item.title}</h1>
          <div className="detail-facts">
            {facts.length>0&&<p className="detail-meta">{facts.map((fact,i)=><span key={i}>{fact}</span>)}</p>}
            {info&&info.ratings.length>0&&<Ratings ratings={info.ratings} links={Object.fromEntries(info.links.map(l=>[l.site,l.url]))}/>}
            {(status||seerr?.status4k)&&<p className="explore-badges">{status&&<span className={`badge explore-status ${status}`}>{statusNames[status]}</span>}{seerr?.status4k&&<span className={`badge explore-status ${seerr.status4k}`}>4K · {statusNames[seerr.status4k]}</span>}</p>}
          </div>
          <div className="button-row">
            {info?.libraryId&&<button className="primary large" onClick={()=>onOpen(info.libraryId!)}><Icon name="play"/>Watch</button>}
            {canRequest&&<button className={info?.libraryId?'secondary large':'primary large'} disabled={busy} onClick={()=>{setDone('');setError('');setRequesting(true);}}><Icon name="plus"/>Request</button>}
            {info?.watchlisted!==undefined&&item.ids.plex&&<button className="secondary large" aria-pressed={info.watchlisted} disabled={busy} onClick={()=>watchlist(!info.watchlisted)}><Icon name={info.watchlisted?'check':'star'}/>{info.watchlisted?'On Watchlist':'Watchlist'}</button>}
            {(details.loading&&!info||busy)&&<span className="spinner small-spinner" aria-label={busy?'Working':'Loading details'}/>}
          </div>
        </div>
      </div>
    </div>
    <div className="explore-body">
      <div className="explore-main">
        {details.error&&<ErrorNotice message={details.error.message} retry={details.reload}/>}
        {info?.tagline&&<p className="tagline">{info.tagline}</p>}
        <p className="synopsis">{item.summary||'No synopsis available.'}</p>
        {seerrOn&&info&&!seerr&&<p className="muted small">Seerr does not know this title, so it can’t be requested.</p>}
        {feedback}
      </div>
      {info&&<Facts item={item} info={info}/>}
    </div>
    {requesting&&seerr&&<RequestDialog item={item} seerr={seerr} onClose={()=>setRequesting(false)} onDone={message=>{setRequesting(false);setDone(message);}}/>}
  </Modal>;
}
