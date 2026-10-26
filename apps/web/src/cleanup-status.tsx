import {useEffect,useMemo,useState} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {Artwork,Empty,ErrorNotice,Icon,Loading,Modal,useMenu} from './components.js';
import {holdEntries,keepEntry,keepTitle,loadLeaving} from './cleanup-holds.js';
import {date,useMutation} from './settings-ui.js';

// Clean Up › Status: every title the last finished run looked at, as posters grouped by what happens to it and when.
// Written by the script at the end of each preview or clean up, so it is as current as the last run; a title can be
// kept longer from here (a hold), which the next run respects.
type Status='due'|'deleted'|'leaving'|'kept'|'protected'|'not_found'|'error';
type Kind='movie'|'show'|'season';
type Title={title:string;year:number|null;kind:Kind;library:string;status:Status;rule:string|null;reason:string;deletion_date:string|null;
  held_until?:string|null;key?:string|null;rating_key?:string|null;holdable?:boolean};
type Titles={updated:string|null;dryRun:boolean;complete:boolean;items:Title[]};
type RuleDays={daysAfterWatched:number;daysAfterUnwatched:number;daysAfterAnyWatchExempt:number;daysAfterExemptWatch:number};
type Group={id:string;label:string;tone:string;statuses:Status[];blurb:(dryRun:boolean)=>string};
// In the order they are listed: soonest gone first.
const groups:Group[]=[
  {id:'due',label:'Due now',tone:'danger',statuses:['due'],blurb:dry=>dry?'The next clean up would delete these.':'The next clean up deletes these.'},
  {id:'deleted',label:'Deleted',tone:'danger',statuses:['deleted'],blurb:()=>'Deleted by this clean up.'},
  {id:'leaving',label:'Leaving soon',tone:'warning',statuses:['leaving'],blurb:()=>'Inside the Leaving Soon window.'},
  {id:'kept',label:'Kept for now',tone:'ok',statuses:['kept'],blurb:()=>'Not due yet; each shows how long it has left.'},
  {id:'protected',label:'Protected',tone:'',statuses:['protected'],blurb:()=>'Never deleted while a tag, collection or season rule protects them.'},
  {id:'issues',label:'Couldn’t check',tone:'',statuses:['error','not_found'],blurb:()=>'Kept, since the run couldn’t tell when they are due.'},
];
const groupOf=(s:Status)=>groups.find(g=>g.statuses.includes(s))!;
const kinds:Record<Kind,string>={movie:'Movie',show:'Show',season:'Season'};
const ruleDays:Record<string,keyof RuleDays>={'Rule 1':'daysAfterWatched','Rule 2':'daysAfterUnwatched','Rule 3':'daysAfterAnyWatchExempt','Rule 4':'daysAfterExemptWatch'};
const DAY=86400000;
const leaves=(i:Title)=>i.held_until??i.deletion_date;
const day=(iso:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(Date.parse(iso));
const daysLeft=(iso:string,now:number)=>Math.ceil((Date.parse(iso)-now)/DAY);
function when(iso:string|null,now:number) {
  if(!iso)return '';
  const days=daysLeft(iso,now);
  return days>0?`in ${days} day${days===1?'':'s'}`:days===0?'today':`${-days} day${days===-1?'':'s'} ago`;
}
// The corner label on a poster: how long it has left, or what became of it.
function countdown(i:Title,now:number) {
  if(i.status==='deleted')return 'Deleted';
  if(i.status==='due')return 'Due now';
  if(i.status==='protected')return 'Protected';
  if(i.status==='not_found')return 'Not in Plex';
  if(i.status==='error')return 'Error';
  const days=daysLeft(leaves(i)!,now);
  return days<=0?'Today':days===1?'1 day':`${days} days`;
}
const meta=(i:Title)=>[kinds[i.kind],i.year].filter(Boolean).join(' · ');
const poster=(i:Title)=>i.rating_key?`/api/v1/catalog/items/${i.rating_key}/artwork?kind=poster`:undefined;

export function CleanupStatus({rules,busy}:{rules:RuleDays;busy:boolean}) {
  const view=useApi<Titles>('/admin/cleanup/titles');
  // Read again each time the tab opens, since a run may have finished since.
  useEffect(()=>view.reload(),[]);
  const [query,setQuery]=useState(''),[library,setLibrary]=useState(''),[kind,setKind]=useState<Kind|''>(''),[group,setGroup]=useState('');
  const [open,setOpen]=useState<number>();
  const items=view.data?.items??[],now=Date.now();
  const libraries=useMemo(()=>[...new Set(items.map(i=>i.library).filter(Boolean))].sort(),[items]);
  // Everything but the group filter, so each group's count says what choosing it would show.
  const matching=useMemo(()=>{
    const q=query.trim().toLowerCase();
    return items.map((item,index)=>({item,index})).filter(({item:i})=>(!q||i.title.toLowerCase().includes(q))&&(!library||i.library===library)&&(!kind||i.kind===kind));
  },[items,query,library,kind]);
  if(view.loading&&!view.data)return <Loading/>;
  if(view.error&&!view.data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  const data=view.data!;
  if(!data.updated)return <Empty title="No status yet">Run a preview (top right). Every requested title it looks at is shown here.</Empty>;
  const inGroup=(g:Group)=>matching.filter(({item})=>g.statuses.includes(item.status));
  // Soonest first; titles without a date go last, by name.
  const sorted=(list:typeof matching)=>[...list].sort((a,b)=>{
    const x=leaves(a.item),y=leaves(b.item);
    return x&&y?Date.parse(x)-Date.parse(y)||a.item.title.localeCompare(b.item.title):Number(!x)-Number(!y)||a.item.title.localeCompare(b.item.title);
  });
  const present=groups.filter(g=>items.some(i=>g.statuses.includes(i.status)));
  const shown=present.filter(g=>!group||g.id===group).map(g=>({g,list:sorted(inGroup(g))})).filter(s=>s.list.length);
  const selected=open===undefined?undefined:items[open];
  return <div className="form-stack cleanup-board">
    <p className="muted small">From the {data.dryRun?'preview':'clean up'} of {date(Date.parse(data.updated))}.{!data.complete&&' Some titles couldn’t be checked; they are kept and listed under Couldn’t check.'}</p>
    <div className="cleanup-summary" role="group" aria-label="Show titles by status">
      <button type="button" aria-pressed={!group} onClick={()=>setGroup('')}><strong>{matching.length}</strong><span>All titles</span></button>
      {present.map(g=><button type="button" key={g.id} className={g.tone} aria-pressed={group===g.id} onClick={()=>setGroup(group===g.id?'':g.id)}>
        <strong>{inGroup(g).length}</strong><span>{g.label}</span></button>)}
    </div>
    <div className="toolbar cleanup-filters">
      <label className="grow">Search<input type="search" placeholder="Title" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <label>Library<select value={library} onChange={e=>setLibrary(e.target.value)}><option value="">All libraries</option>{libraries.map(l=><option key={l}>{l}</option>)}</select></label>
      <label>Type<select value={kind} onChange={e=>setKind(e.target.value as Kind|'')}><option value="">Any type</option>{(Object.keys(kinds) as Kind[]).map(k=><option key={k} value={k}>{kinds[k]}s</option>)}</select></label>
    </div>
    {shown.length?shown.map(({g,list})=><section key={g.id} className="cleanup-group">
      <div className="cleanup-group-title"><h3>{g.label}</h3><span className="count">{list.length}</span><p>{g.blurb(data.dryRun)}</p></div>
      <div className="cleanup-grid">{list.map(({item,index})=><TitleCard key={index} item={item} now={now} onOpen={()=>setOpen(index)}/>)}</div>
    </section>):<Empty title="Nothing matches">Try other filters.</Empty>}
    {selected&&<TitleDetail item={selected} rules={rules} busy={busy} dryRun={data.dryRun} now={now} onClose={()=>setOpen(undefined)}/>}
  </div>;
}

// Just the poster and its overlays; the name shows on hover. Titles waiting to leave start over or are kept from a right-click.
function TitleCard({item,now,onOpen}:{item:Title;now:number;onOpen:()=>void}) {
  const {tone}=groupOf(item.status),own={key:item.key!,title:item.title};
  const menu=useMenu(item.title,()=>[[...holdEntries(own),keepEntry(own)],[{label:'Details',icon:'info',run:onOpen}]]);
  const waiting=item.holdable&&!!item.key;
  return <><button type="button" className={`cleanup-card${item.status==='deleted'?' gone':''}`} onClick={onOpen} onContextMenu={waiting?menu.onContextMenu:undefined} title={[item.title,meta(item),item.library].filter(Boolean).join(' · ')} aria-label={`${item.title}, ${countdown(item,now)}`}>
    <span className="cleanup-art">
      <Artwork src={poster(item)} fallback={<><Icon name={item.kind==='movie'?'movies':'shows'}/><span>{item.title}</span></>}/>
      <span className={`cleanup-when ${tone}`}>{countdown(item,now)}</span>
      {item.held_until&&<span className="cleanup-held" title={`Held until ${day(item.held_until)}`}><Icon name="clock" size={13}/></span>}
    </span>
  </button>{menu.menu}</>;
}

function TitleDetail({item,rules,busy,dryRun,now,onClose}:{item:Title;rules:RuleDays;busy:boolean;dryRun:boolean;now:number;onClose:()=>void}) {
  const g=groupOf(item.status);
  const mutation=useMutation(()=>{invalidate('/admin/cleanup/titles');void loadLeaving();});
  const hold=(body:{action:'reset'}|{action:'clear'})=>void mutation.run(()=>api('/admin/cleanup/holds','POST',{key:item.key,...body}));
  const at=leaves(item),reset=item.rule&&ruleDays[item.rule]?rules[ruleDays[item.rule]!]:undefined;
  return <Modal title={item.title} onClose={onClose}>
    <div className="cleanup-detail">
      <div className="cleanup-detail-art"><Artwork src={poster(item)} fallback={<Icon name={item.kind==='movie'?'movies':'shows'}/>}/></div>
      <div className="cleanup-detail-body">
        <h2>{item.title}</h2>
        <p className="muted">{[meta(item),item.library].filter(Boolean).join(' · ')}</p>
        <p><span className={`badge ${g.tone}`}>{item.status==='not_found'?'Not in Plex':item.status==='error'?'Error':g.label}</span></p>
        <dl className="cleanup-facts">
          {at&&<><dt>{item.status==='deleted'?'Deleted':'Leaves'}</dt><dd>{day(at)} <span className="muted">· {when(at,now)}</span></dd></>}
          {item.held_until&&item.deletion_date&&<><dt>Rule alone</dt><dd>{day(item.deletion_date)} <span className="muted">· held longer by an administrator</span></dd></>}
          {item.rule&&<><dt>Rule</dt><dd>{item.rule}</dd></>}
          <dt>Why</dt><dd>{item.reason||'—'}</dd>
        </dl>
        {item.holdable?<div className="cleanup-hold">
          <h3>Start over</h3>
          {reset!==undefined&&<div className="cleanup-hold-row">
            <div><strong>Start the clock over</strong><small>{reset} days from today ({item.rule}’s period), until {day(new Date(now+reset*DAY).toISOString())}.</small></div>
            <button disabled={mutation.busy} onClick={()=>hold({action:'reset'})}><Icon name="restart" size={16}/>Start over</button>
          </div>}
          {item.held_until&&<div className="cleanup-hold-row">
            <div><strong>Remove the hold</strong><small>Go back to the rule’s date{item.deletion_date?`, ${day(item.deletion_date)}`:''}.</small></div>
            <button disabled={mutation.busy} onClick={()=>hold({action:'clear'})}><Icon name="close" size={16}/>Remove</button>
          </div>}
          <div className="cleanup-hold-row">
            <div><strong>{item.kind==='movie'?'Keep':'Keep the show'}</strong><small>Tags {item.kind==='movie'?'it in Radarr':'the whole series in Sonarr'} with your first protected tag.</small></div>
            <button disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{await keepTitle({key:item.key!,title:item.title});onClose();})}><Icon name="check" size={16}/>Keep</button>
          </div>
          {mutation.error&&<div className="notice error" role="alert"><span>{mutation.error}</span></div>}
          <p className="cleanup-note">The next {dryRun?'preview or ':''}clean up uses the new date{busy?'; the run going now keeps the dates it started with':''}. A hold only ever keeps a title longer than its rule would.</p>
        </div>:item.status==='deleted'?null:<p className="cleanup-note">{item.status==='protected'?'Protected titles are never deleted, so there is nothing to start over.':item.status==='error'||item.status==='not_found'?'The run couldn’t tell when this title is due, so it is kept.':'Run a preview to be able to start this title over.'}</p>}
      </div>
    </div>
  </Modal>;
}
