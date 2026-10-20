import {memo,useEffect,useState,type ReactNode} from 'react';
import type {ExploreDetails,ExploreItem,ExplorePage,ExploreRowInfo,ExploreSource,ExploreSources,ExploreStatus} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,useDebounced,useInfinitePages,useNearViewport,duration,link,replaceRoute,invalidate} from './hooks.js';
import {Artwork,Empty,ErrorNotice,FadeImage,Icon,Loading,Modal,Row,RowSkeleton} from './components.js';
import {Ratings} from './library.js';
import {RequestDialog} from './request-dialog.js';
import './explore.css';

// Explore: titles beyond this server, from Plex Discover (watchlist and Discover shelves), Seerr and Trakt.
// A title's dialog opens this server's copy when there is one, requests it through Seerr, or watchlists it on Plex.
const names:Record<ExploreSource,string>={plex:'Plex',seerr:'Seerr',trakt:'Trakt'};
const statusNames:Record<ExploreStatus,string>={available:'Available',partial:'Partly available',requested:'Requested'};
const rowPath=(source:ExploreSource,row:string,page=1)=>`/explore/${source}/rows/${encodeURIComponent(row)}?page=${page}`;
const cardMeta=(item:ExploreItem)=>[item.rating?`${item.rating.toFixed(1)}★`:undefined,item.year,item.kind==='show'?(item.episodeCount?`${item.episodeCount} eps`:'TV series'):item.durationMs?duration(item.durationMs):undefined].filter(Boolean).join(' · ');
const results=(n:number)=>`${n.toLocaleString()} result${n===1?'':'s'}`;

const ExploreCard=memo(function ExploreCard({item,onSelect}:{item:ExploreItem;onSelect:(item:ExploreItem)=>void}) {
  return <div className={`poster-card explore-card${item.status?` is-${item.status}`:''}`}>
    <div className="card-frame"><button className="poster-art" onClick={()=>onSelect(item)} aria-label={`${item.title}${item.year?`, ${item.year}`:''}${item.status?`, ${statusNames[item.status]}`:''}`}>
      <Artwork src={item.posterUrl} fallback={<><Icon name={item.kind==='movie'?'movies':'shows'}/><span>{item.title}</span></>}/>
      {item.status&&<span className={`explore-badge ${item.status}`}>{statusNames[item.status]}</span>}
    </button></div>
    <span className="poster-title"><span className="card-plain">{item.title}</span></span>
    <span className="poster-meta"><span className="card-plain">{cardMeta(item)}</span></span>
  </div>;
});
const Cards=({items,onSelect}:{items:ExploreItem[];onSelect:(item:ExploreItem)=>void})=><div className="poster-grid">{items.map(item=><ExploreCard key={item.key} item={item} onSelect={onSelect}/>)}</div>;

function ExploreRow({source,row,onSelect}:{source:ExploreSource;row:ExploreRowInfo;onSelect:(item:ExploreItem)=>void}) {
  const [ref,near]=useNearViewport<HTMLDivElement>(),data=useApi<ExplorePage>(near?rowPath(source,row.id):undefined),page=data.data;
  const heading=<span className="explore-row-title"><Icon name={row.icon} size={20}/>{row.title}{page?.total!==undefined&&page.total>0&&<span className="explore-count">{results(page.total)}</span>}</span>;
  return <div ref={ref} className="lazy-row">{!page?(data.error?<section className="row"><div className="row-heading"><h2>{heading}</h2></div><div className="explore-row-error"><ErrorNotice message={data.error.message} retry={data.reload}/></div></section>:<RowSkeleton title={row.title}/>)
    :page.items.length?<Row title={heading} href={link('explore',{source,row:row.id})}>{page.items.map(item=><ExploreCard key={item.key} item={item} onSelect={onSelect}/>)}</Row>:null}</div>;
}
function ExploreRows({source,onSelect}:{source:ExploreSource;onSelect:(item:ExploreItem)=>void}) {
  const rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`);
  if(rows.error)return <ErrorNotice message={rows.error.message} retry={rows.reload}/>;
  if(!rows.data)return <div className="explore-rows"><RowSkeleton title="Loading"/></div>;
  return <div className="explore-rows">{rows.data.rows.map(row=><ExploreRow key={row.id} source={source} row={row} onSelect={onSelect}/>)}</div>;
}
// "See all": every page of one row.
function ExploreGrid({source,row,onSelect}:{source:ExploreSource;row:string;onSelect:(item:ExploreItem)=>void}) {
  const rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`),info=rows.data?.rows.find(r=>r.id===row);
  const list=useInfinitePages<ExplorePage>(index=>rowPath(source,row,index+1),1,`${source}/${row}`),first=list.pages[0];
  const items=list.pages.flatMap(p=>p?.items??[]),unique=items.filter((item,i)=>items.findIndex(other=>other.key===item.key)===i);
  return <section className="explore-grid">
    <div className="explore-grid-head"><a className="crumb" href={link('explore',{source})}><Icon name="back" size={14}/>{names[source]}</a><h1>{info?.title??''}{first?.total!==undefined&&<span className="explore-count">{results(first.total)}</span>}</h1></div>
    {!first&&list.loading?<Loading cards/>:!first?<ErrorNotice message="This row could not be loaded." retry={()=>invalidate(`/explore/${source}/rows/`)}/>:unique.length?<Cards items={unique} onSelect={onSelect}/>:<Empty title="Nothing here yet"/>}
    {list.more&&<div ref={list.sentinel} className="explore-more">{list.loading&&<Loading/>}</div>}
  </section>;
}
function ExploreSearch({source,q,onSelect}:{source:ExploreSource;q:string;onSelect:(item:ExploreItem)=>void}) {
  const data=useApi<{items:ExploreItem[]}>(`/explore/${source}/search?q=${encodeURIComponent(q)}`);
  return <section className="explore-grid">
    <div className="explore-grid-head"><h1>Results from {names[source]}{data.data&&<span className="explore-count">{results(data.data.items.length)}</span>}</h1></div>
    {data.loading&&!data.data?<Loading cards/>:data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>:data.data?.items.length?<Cards items={data.data.items} onSelect={onSelect}/>:<Empty title={`Nothing on ${names[source]} matches “${q}”`}/>}
  </section>;
}

export function Explore({params,admin,onOpen}:{params:URLSearchParams;admin:boolean;onOpen:(id:string)=>void}) {
  const sources=useApi<ExploreSources>('/explore/sources'),data=sources.data;
  const available=data?(['plex','seerr','trakt'] as const).filter(s=>s==='plex'?data.plex:data[s].configured):[];
  const wanted=params.get('source') as ExploreSource|null,source=wanted&&available.includes(wanted)?wanted:available[0];
  const row=params.get('row')??'',query=params.get('q')??'',[text,setText]=useState(query),q=useDebounced(text.trim(),400);
  const [selected,setSelected]=useState<ExploreItem>();
  useEffect(()=>{setText(query);},[source]);
  // Typing searches in place; the address keeps the query so Back returns to it.
  useEffect(()=>{if(source&&q!==query)replaceRoute(link('explore',{source,q}));},[q]);
  const choose=(next:ExploreSource)=>{setText('');window.location.hash=link('explore',{source:next});};
  if(sources.error)return <div className="page"><ErrorNotice message={sources.error.message} retry={sources.reload}/></div>;
  if(!data||!source)return <div className="page"><Loading/></div>;
  return <div className="page explore-page">
    <div className="browse-controls explore-controls"><h1 className="sr-only">Explore</h1>
      <nav className="browse-tabs" aria-label="Catalog source">{available.map(s=><button key={s} type="button" aria-current={source===s?'page':undefined} onClick={()=>choose(s)}>{names[s]}</button>)}</nav>
      <form className="browse-search explore-search" role="search" onSubmit={e=>{e.preventDefault();replaceRoute(link('explore',{source,q:text.trim()}));}}><Icon name="search"/><input aria-label={`Search ${names[source]}`} placeholder={`Search ${names[source]}`} maxLength={120} value={text} onChange={e=>setText(e.target.value)}/>{text&&<button className="icon-button" type="button" aria-label="Clear search" onClick={()=>{setText('');replaceRoute(link('explore',{source}));}}><Icon name="close"/></button>}</form>
      <button className="icon-button browse-layout" aria-label="Refresh" title="Refresh" onClick={()=>invalidate('/explore/')}><Icon name="restart"/></button>
    </div>
    {/* Plex and Trakt titles carry Seerr's labels only when the server can read Seerr's media list with the API key. */}
    {admin&&source!=='seerr'&&data.seerr.configured&&!data.seerr.statuses&&<p className="explore-note muted">Add the Seerr API key in <a href="#settings">Settings › Explore</a> to show Available and Requested on these titles.</p>}
    {source==='trakt'&&!data.trakt.linked&&<p className="explore-note muted">Connect your Trakt account in <a href="#settings">Settings › Explore</a> to see your Trakt watchlist and recommendations.</p>}
    {query?<ExploreSearch key={`${source}-${query}`} source={source} q={query} onSelect={setSelected}/>:row?<ExploreGrid key={`${source}-${row}`} source={source} row={row} onSelect={setSelected}/>:<ExploreRows key={source} source={source} onSelect={setSelected}/>}
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
    ['Genres',info.genres.join(', ')],['Starring',info.cast.slice(0,5).join(', ')],
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
      {art&&<FadeImage src={art} alt="" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>}<div className="detail-shade"/>
      <div className="detail-hero-content explore-hero">
        {item.posterUrl&&<FadeImage className="explore-hero-poster" src={item.posterUrl} alt="" decoding="async"/>}
        <div className="detail-heading">
          <h1 className="detail-title">{item.title}</h1>
          <div className="detail-facts">
            {facts.length>0&&<p className="detail-meta">{facts.map((fact,i)=><span key={i}>{fact}</span>)}</p>}
            {info&&info.ratings.length>0&&<Ratings ratings={info.ratings}/>}
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
