import {useEffect,useState} from 'react';
import type {MyRequests,RequestItem,RequestStatus} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {fetchCached,invalidate,useApi} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {announce} from './media-actions.js';

// Explore › My requests: the viewer's own requests, newest first, with Cancel while nothing is downloading yet.
// The button shows how many changed (available, partly, failed) since the viewer last opened the list.
const names:Record<RequestStatus,string>={queued:'Requested',requested:'Requested',downloading:'Downloading',partial:'Partly available',available:'Available',failed:'Failed',removed:'Removed'};
const tone:Partial<Record<RequestStatus,string>>={available:'available',partial:'partial',downloading:'downloading',failed:'failed',requested:'requested',queued:'requested'};
const seasonText=(item:RequestItem)=>item.kind==='movie'?'Movie':item.seasons.length>1?`Seasons ${item.seasons.map(s=>s.season).join(', ')}`:item.seasons.length?`Season ${item.seasons[0]!.season}`:'Show';
const date=(at:number)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(at);

export function MyRequestsButton() {
  const mine=useApi<MyRequests>('/requests/mine'),[open,setOpen]=useState(false),unseen=mine.data?.unseen??0;
  return <>
    <button className="icon-button toolbar-icon my-requests-button" aria-label={unseen?`My requests, ${unseen} changed`:'My requests'} title="My requests" onClick={()=>setOpen(true)}>
      <Icon name="download"/>{unseen>0&&<span className="my-requests-count" aria-hidden="true">{unseen}</span>}</button>
    {open&&<MyRequestsList mine={mine} onClose={()=>setOpen(false)}/>}
  </>;
}
function MyRequestsList({mine,onClose}:{mine:ReturnType<typeof useApi<MyRequests>>;onClose:()=>void}) {
  const [busy,setBusy]=useState<number>(),[error,setError]=useState('');
  // Opening the list counts as having seen every change in it.
  useEffect(()=>{if(mine.data?.unseen)void api('/requests/mine/seen','POST').then(()=>invalidate('/requests/mine'),()=>undefined);},[mine.data?.unseen]);
  const cancel=async(item:RequestItem)=>{setBusy(item.id);setError('');try{await api(`/requests/${item.id}`,'DELETE');invalidate('/requests/mine');invalidate('/explore/');}catch(e){setError((e as Error).message);}finally{setBusy(undefined);}};
  return <Modal title="My requests" onClose={onClose}>
    <div className="my-requests">
      <h2>My requests</h2>
      {error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}
      {mine.error&&!mine.data?<ErrorNotice message={mine.error.message} retry={mine.reload}/>:!mine.data?<Loading/>:!mine.data.items.length?<Empty title="No requests yet"/>:
        <ul className="my-requests-list">{mine.data.items.map(item=><li key={item.id} className={item.seen?'':'is-new'}>
          <div><strong>{item.title}</strong>{item.year?` (${item.year})`:''}<small>{seasonText(item)} · {date(item.createdAt)}{item.error&&item.status==='failed'?` · ${item.error}`:''}</small></div>
          <span className={`badge explore-status ${tone[item.status]??''}`}>{names[item.status]}</span>
          {['queued','requested','failed'].includes(item.status)?<button disabled={busy===item.id} onClick={()=>void cancel(item)}>Cancel</button>:<span/>}
        </li>)}</ul>}
    </div>
  </Modal>;
}

// The server says one of the viewer's requests changed: lists reload, and a change worth hearing about gets a notice.
const told=new Set<string>();
export async function requestsChanged() {
  invalidate('/requests/mine');invalidate('/explore/');
  const mine=await fetchCached<MyRequests>('/requests/mine').catch(()=>undefined);
  for(const item of mine?.items??[]){
    const key=`${item.id}:${item.status}`;
    if(item.seen||told.has(key)||!['available','partial','failed'].includes(item.status))continue;
    told.add(key);
    announce(item.status==='failed'?`${item.title} couldn’t be requested.`:item.status==='partial'?`Some of ${item.title} is ready to watch.`:`${item.title} is ready to watch.`,item.status==='failed');
  }
}
