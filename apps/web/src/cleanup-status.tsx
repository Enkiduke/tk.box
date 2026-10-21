import {useEffect,useMemo,useState} from 'react';
import {useApi} from './hooks.js';
import {Empty,ErrorNotice,Loading} from './components.js';
import {date} from './settings-ui.js';

// Clean Up › Status: every title the last finished run looked at, by library, with what happens to it and when.
// Written by the script at the end of each preview or clean up, so it is as current as the last run.
type Status='due'|'deleted'|'leaving'|'kept'|'protected'|'not_found'|'error';
type Kind='movie'|'show'|'season';
type Title={title:string;year:number|null;kind:Kind;library:string;status:Status;rule:string|null;reason:string;deletion_date:string|null};
type Titles={updated:string|null;dryRun:boolean;complete:boolean;items:Title[]};
type SortKey='title'|'library'|'status'|'date';
// In the order they sort by: soonest gone first.
const statuses:Record<Status,[string,string]>={due:['Due','danger'],deleted:['Deleted','danger'],leaving:['Leaving soon','warning'],kept:['Kept','ok'],protected:['Protected',''],error:['Error','danger'],not_found:['Not in Plex','']};
const order=Object.keys(statuses) as Status[];
const kinds:Record<Kind,string>={movie:'Movie',show:'Show',season:'Season'};
const DAY=86400000;
function when(iso:string|null,now:number) {
  if(!iso)return '';
  const at=Date.parse(iso),days=Math.ceil((at-now)/DAY);
  return days>0?`in ${days} day${days===1?'':'s'}`:days===0?'today':`${-days} day${days===-1?'':'s'} ago`;
}

export function CleanupStatus() {
  const view=useApi<Titles>('/admin/cleanup/titles');
  // Read again each time the tab opens, since a run may have finished since.
  useEffect(()=>view.reload(),[]);
  const [query,setQuery]=useState(''),[library,setLibrary]=useState(''),[status,setStatus]=useState<Status|''>(''),[kind,setKind]=useState<Kind|''>('');
  const [sort,setSort]=useState<{key:SortKey;up:boolean}>({key:'date',up:true});
  const items=view.data?.items??[],now=Date.now();
  const libraries=useMemo(()=>[...new Set(items.map(i=>i.library).filter(Boolean))].sort(),[items]);
  const shown=useMemo(()=>{
    const q=query.trim().toLowerCase();
    const list=items.filter(i=>(!q||i.title.toLowerCase().includes(q))&&(!library||i.library===library)&&(!status||i.status===status)&&(!kind||i.kind===kind));
    const dir=sort.up?1:-1,at=(i:Title)=>i.deletion_date?Date.parse(i.deletion_date):null;
    return list.sort((a,b)=>{
      if(sort.key==='date'){
        // Titles without a date (protected, not in Plex) go last whichever way dates sort.
        const x=at(a),y=at(b);
        return x===null||y===null?Number(x===null)-Number(y===null)||a.title.localeCompare(b.title):dir*(x-y);
      }
      const by=sort.key==='title'?a.title.localeCompare(b.title):sort.key==='library'?a.library.localeCompare(b.library):order.indexOf(a.status)-order.indexOf(b.status);
      return dir*by||a.title.localeCompare(b.title);
    });
  },[items,query,library,status,kind,sort]);
  if(view.loading&&!view.data)return <Loading/>;
  if(view.error&&!view.data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  const data=view.data!;
  if(!data.updated)return <Empty title="No status yet">Run a preview in the Runs tab. Every requested title it looks at is listed here.</Empty>;
  const count=(s:Status)=>items.filter(i=>(!library||i.library===library)&&i.status===s).length;
  const head=(key:SortKey,label:string)=><th aria-sort={sort.key===key?(sort.up?'ascending':'descending'):undefined}>
    <button type="button" className="sort-button" onClick={()=>setSort(s=>({key,up:s.key===key?!s.up:true}))}>{label}{sort.key===key&&<span aria-hidden="true">{sort.up?' ↑':' ↓'}</span>}</button></th>;
  return <div className="form-stack">
    <p className="muted small">From the {data.dryRun?'preview':'clean up'} of {date(Date.parse(data.updated))}.{!data.complete&&' Some titles couldn’t be checked; they are kept and marked Error or Not in Plex.'}</p>
    <div className="toolbar cleanup-filters">
      <label className="grow">Search<input type="search" placeholder="Title" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <label>Library<select value={library} onChange={e=>setLibrary(e.target.value)}><option value="">All libraries</option>{libraries.map(l=><option key={l}>{l}</option>)}</select></label>
      <label>Status<select value={status} onChange={e=>setStatus(e.target.value as Status|'')}><option value="">Any status</option>
        {order.filter(s=>count(s)).map(s=><option key={s} value={s}>{statuses[s][0]} ({count(s)})</option>)}</select></label>
      <label>Type<select value={kind} onChange={e=>setKind(e.target.value as Kind|'')}><option value="">Any type</option>{(Object.keys(kinds) as Kind[]).map(k=><option key={k} value={k}>{kinds[k]}s</option>)}</select></label>
    </div>
    {shown.length?<div className="table-scroll"><table className="cleanup-status">
      <thead><tr>{head('title','Title')}{head('library','Library')}{head('status','Status')}{head('date','Leaves')}<th>Why</th></tr></thead>
      <tbody>{shown.map((i,n)=>{const [label,tone]=statuses[i.status];return <tr key={`${i.library}\0${i.title}\0${n}`}>
        <td><strong>{i.title}</strong><small className="muted">{[kinds[i.kind],i.year].filter(Boolean).join(' · ')}</small></td>
        <td>{i.library||'—'}</td>
        <td><span className={`badge ${tone}`}>{label}</span></td>
        <td>{i.deletion_date?<>{new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(Date.parse(i.deletion_date))}<small className="muted">{when(i.deletion_date,now)}</small></>:'—'}</td>
        <td><small>{i.rule?`${i.rule}: `:''}{i.reason}</small></td>
      </tr>;})}</tbody>
    </table></div>:<Empty title="Nothing matches">Try other filters.</Empty>}
    <p className="muted small">{shown.length} of {items.length} titles</p>
  </div>;
}
