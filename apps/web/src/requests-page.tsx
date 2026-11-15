import {memo,useEffect,useState} from 'react';
import type {ExploreItem,MyRequests,RequestArtwork,RequestItem,RequestPage,RequestRelease,RequestStatus,RequestTiming} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {invalidate,link,replaceRoute,useApi,useInfinitePages,useNearViewport} from './hooks.js';
import {Artwork,Empty,ErrorNotice,FadeImage,Icon,Loading} from './components.js';
import {requestStatusLabels,requestTone} from './my-requests.js';
// Request status badges are styled with Explore's.
import './explore.css';
import './requests-page.css';
import {toast} from './toasts.js';

// The Requests site's Requests page: the viewer's own requests (first) or everyone's (not removed ones), as cards with the
// title's backdrop and poster. A card opens the title; the viewer's own requests can be cancelled until downloading.
const PAGE=30;
const views=[['mine','My requests'],['all','All requests']] as const;
const kinds=[['','All'],['movie','Movies'],['show','Shows']] as const;
const statuses:[string,string][]=[['','Any status'],...(['requested','downloading','partial','available','failed'] as RequestStatus[]).map(s=>[s,requestStatusLabels[s]] as [string,string])];
const cancellable=(item:RequestItem)=>['queued','requested','failed'].includes(item.status);
const relative=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'});
const ago=(at:number)=>{
  const seconds=(at-Date.now())/1000;
  for(const [unit,size] of [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60]] as const)if(Math.abs(seconds)>=size)return relative.format(Math.round(seconds/size),unit);
  return 'just now';
};
const exploreItem=(item:RequestItem,art?:RequestArtwork):ExploreItem=>({key:`${item.kind}:tmdb:${item.tmdbId}`,source:'tmdb',kind:item.kind,title:item.title,
  ...(item.year?{year:item.year}:{}),...(art?.posterUrl?{posterUrl:art.posterUrl}:{}),...(art?.backdropUrl?{backdropUrl:art.backdropUrl}:{}),ids:{tmdb:item.tmdbId}});

export function RequestsPage({params,onSelect}:{params:URLSearchParams;onSelect:(item:ExploreItem)=>void}) {
  const view=params.get('view')==='all'?'all':'mine',kind=params.get('kind')??'',status=params.get('status')??'';
  const mine=useApi<MyRequests>('/requests/mine'),unseen=mine.data?.unseen??0;
  const go=(changes:Record<string,string>)=>replaceRoute(link('requests',Object.fromEntries(Object.entries({view,kind,status,...changes}).filter(([key,value])=>value&&!(key==='view'&&value==='mine')))));
  const [busy,setBusy]=useState<number>(),[error,setError]=useState('');
  const cancel=async(item:RequestItem)=>{setBusy(item.id);setError('');try{await api(`/requests/${item.id}`,'DELETE');invalidate('/requests/mine');invalidate('/requests?');invalidate('/explore/');toast.success(`Cancelled ${item.title}`);}catch(e){setError((e as Error).message);}finally{setBusy(undefined);}};
  const card=(item:RequestItem,own:boolean)=><RequestCard key={item.id} item={item} own={own} busy={busy===item.id} onCancel={cancel} onSelect={onSelect}/>;
  return <div className="page toolbar-page requests-page">
    <div className="page-toolbar requests-toolbar"><h1 className="sr-only">Requests</h1>
      <div className="toolbar-group" role="group" aria-label="Whose requests">
        {views.map(([id,label])=><button key={id} type="button" aria-pressed={view===id} onClick={()=>go({view:id})}>{label}{id==='mine'&&unseen>0&&<span className="requests-unseen" aria-label={`${unseen} changed`}>{unseen}</span>}</button>)}
      </div>
      <div className="toolbar-group" role="group" aria-label="Media type">
        {kinds.map(([id,label])=><button key={id} type="button" aria-pressed={kind===id} onClick={()=>go({kind:id})}>{label}</button>)}
      </div>
      <select className="requests-status-filter" aria-label="Status" value={status} onChange={e=>go({status:e.target.value})}>
        {statuses.map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </select>
    </div>
    {error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}
    {view==='mine'?<Mine mine={mine} kind={kind} status={status} card={card}/>:<Everyone kind={kind} status={status} card={card}/>}
  </div>;
}

function Everyone({kind,status,card}:{kind:string;status:string;card:(item:RequestItem,own:boolean)=>React.ReactNode}) {
  const query=(offset:number)=>`/requests?${new URLSearchParams({page:String(offset/PAGE+1),...(kind?{kind}:{}),...(status?{status}:{})})}`;
  const {pages,loading,error,retry,more,sentinel,loadMore}=useInfinitePages<RequestPage>(query,PAGE,`${kind}|${status}`);
  const items=pages.flatMap(page=>page?.items??[]);
  if(error&&!items.length)return <ErrorNotice message={(error as Error).message??"Requests couldn’t be loaded."} retry={retry}/>;
  if(!items.length)return loading?<Loading/>:<Empty title="No requests"/>;
  return <><ul className="request-cards">{items.map(item=>card(item,!!item.mine))}</ul>
    <div ref={sentinel}/>{more&&<div className="button-row requests-more"><button onClick={loadMore}>More</button></div>}{loading&&<Loading/>}</>;
}

function Mine({mine,kind,status,card}:{mine:ReturnType<typeof useApi<MyRequests>>;kind:string;status:string;card:(item:RequestItem,own:boolean)=>React.ReactNode}) {
  // Opening your requests counts as having seen every change in them.
  useEffect(()=>{if(mine.data?.unseen)void api('/requests/mine/seen','POST').then(()=>invalidate('/requests/mine'),()=>undefined);},[mine.data?.unseen]);
  if(mine.error&&!mine.data)return <ErrorNotice message={mine.error.message} retry={mine.reload}/>;
  if(!mine.data)return <Loading/>;
  const items=mine.data.items.filter(item=>(!kind||item.kind===kind)&&(!status||item.status===status||status==='requested'&&item.status==='queued'));
  if(!items.length)return <Empty title={mine.data.items.length?'No requests match':'No requests yet'}/>;
  return <ul className="request-cards">{items.map(item=>card(item,true))}</ul>;
}

const seasonsText=(item:RequestItem)=>item.kind==='movie'?'Movie':item.seasons.length?`Season${item.seasons.length>1?'s':''}`:'Series';
const releaseDateFormat=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
const localDayFormat=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit'});
const movieReleaseLabels={
  theatrical:{past:'Theatrical release',future:'In theaters from'},
  digital:{past:'Released digitally',future:'Digital release'},
  physical:{past:'Released on disc',future:'Disc release'}
};

function ReleaseFact({release}:{release:RequestRelease}) {
  let day:string,label:string,note:string|undefined;
  if(release.kind==='episode') {
    day=release.day;
    label=`S${release.season} E${release.episode} ${release.aired?'aired':'airs'}`;
  } else {
    if(!release.date)return <div><dt>Release</dt><dd>Waiting for release</dd></div>;
    const {format}=release.date;
    day=release.date.day;
    const future=day>localDayFormat.format(new Date());
    label=movieReleaseLabels[format][future?'future':'past'];
    if(format==='theatrical'&&!future)note='Home release date unknown';
    else if(release.waitingForRelease&&!future)note='Waiting for release';
  }
  return <div><dt>Release</dt><dd>{label} <time dateTime={day}>{releaseDateFormat.format(new Date(`${day}T00:00:00Z`))}</time>
    {note&&<small className="request-card-release-note">{note}</small>}
  </dd></div>;
}

const RequestCard=memo(function RequestCard({item,own,busy,onCancel,onSelect}:{item:RequestItem;own:boolean;busy:boolean;onCancel:(item:RequestItem)=>void;onSelect:(item:ExploreItem)=>void}) {
  const [ref,near]=useNearViewport<HTMLLIElement>('400px');
  const {data:art}=useApi<RequestArtwork>(near?`/requests/${item.id}/artwork`:undefined);
  const timingPath=near&&item.status!=='removed'?`/requests/${item.id}/timing?v=${item.status}-${item.statusAt}`:undefined;
  const {data:timing,error:timingError}=useApi<RequestTiming>(timingPath);
  const added=timing?timing.kind==='added':item.status==='available';
  let timingFallback='—';
  if(timingError)timingFallback='Unavailable';
  else if(timing?.kind==='added')timingFallback='Date unavailable';
  else if(timing?.kind==='searched')timingFallback=timing.unavailable?'Search history unavailable':'No search recorded';
  const tone=requestTone[item.status];
  const open=()=>onSelect(exploreItem(item,art));
  return <li ref={ref} className={`request-card${own&&!item.seen?' is-new':''}`} data-tone={tone}>
    {art?.backdropUrl&&<FadeImage className="request-card-backdrop" src={art.backdropUrl} alt="" loading="lazy" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>}
    <div className="request-card-shade"/>
    <button type="button" className="request-card-poster" aria-label={`Open ${item.title}`} onClick={open}>
      <Artwork key={art?.posterUrl} src={art?.posterUrl} fallback={<Icon name={item.kind==='movie'?'movies':'shows'}/>}/>
    </button>
    <div className="request-card-title">
      {item.year&&<span className="request-card-year">{item.year}</span>}
      <button type="button" className="request-card-name" onClick={open}>{item.title}</button>
      <span className="request-card-kind">{seasonsText(item)}{item.seasons.map(s=><span key={s.season} className={`request-season${s.available?' available':''}`} title={s.available?'In Plex':undefined}>{s.season}</span>)}</span>
    </div>
    <dl className="request-card-facts">
      <div><dt>Status</dt><dd><span className={`badge explore-status ${tone??''}`}>{requestStatusLabels[item.status]}</span>{item.error&&item.status==='failed'&&<small className="request-card-error">{item.error}</small>}</dd></div>
      <div><dt>Requested</dt><dd><time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{ago(item.createdAt)}</time> by <strong>{own?'you':item.accountName}</strong></dd></div>
      {timing?.kind==='searched'&&timing.release&&<ReleaseFact release={timing.release}/>}
      {item.status!=='removed'&&<div><dt>{added?'Added':'Searched'}</dt><dd>{timing?.at!==undefined
        ?<time dateTime={new Date(timing.at).toISOString()} title={new Date(timing.at).toLocaleString()}>{ago(timing.at)}</time>
        :timingFallback}</dd></div>}
    </dl>
    <div className="request-card-actions">{own&&cancellable(item)&&<button disabled={busy} onClick={()=>onCancel(item)}><Icon name="close" size={16}/>Cancel request</button>}</div>
  </li>;
});
