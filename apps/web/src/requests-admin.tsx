import {useEffect,useState} from 'react';
import type {RequestItem,RequestOptions,RequestPage,RequestSettings,RequestStatus} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {invalidate,useApi} from './hooks.js';
import {Empty,ErrorNotice,Loading} from './components.js';
import {Card,SectionHead,Switch,date,useMutation} from './settings-ui.js';

// Admin › Requests: every request (docs/REQUESTS.md) and where requests go in Radarr and Sonarr.
export const requestStatusNames:Record<RequestStatus,string>={queued:'Queued',requested:'Requested',downloading:'Downloading',partial:'Partly available',available:'Available',failed:'Failed',removed:'Removed'};
const tone:Partial<Record<RequestStatus,string>>={available:'ok',partial:'ok',downloading:'warning',failed:'danger'};
const removedBy:Record<string,string>={requester:'by the requester',admin:'by an administrator',cleanup:'by Clean Up',arr:'from Radarr or Sonarr'};
const seasonText=(item:RequestItem)=>item.kind==='movie'?'Movie':item.seasons.length?`Season${item.seasons.length>1?'s':''} ${item.seasons.map(s=>s.season).join(', ')}`:'Show';

export function RequestsAdmin() {
  return <><SectionHead title="Requests"/><RequestList/><RequestDefaults/></>;
}

function RequestList() {
  const [status,setStatus]=useState(''),[kind,setKind]=useState(''),[q,setQ]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1);
  useEffect(()=>{const t=setTimeout(()=>{setSearch(q.trim());setPage(1);},300);return()=>clearTimeout(t);},[q]);
  const query=new URLSearchParams({page:String(page),...(status?{status}:{}),...(kind?{kind}:{}),...(search?{q:search}:{})});
  const list=useApi<RequestPage>(`/admin/requests?${query}`),mutation=useMutation(()=>invalidate('/admin/requests'));
  const act=(item:RequestItem,action:'retry'|'remove')=>void mutation.run(()=>action==='retry'?api(`/admin/requests/${item.id}/retry`,'POST'):api(`/admin/requests/${item.id}`,'DELETE'));
  return <Card title="All requests">
    <div className="requests-filters">
      <select aria-label="Status" value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">Every status</option>{Object.entries(requestStatusNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="Kind" value={kind} onChange={e=>{setKind(e.target.value);setPage(1);}}><option value="">Movies and shows</option><option value="movie">Movies</option><option value="show">Shows</option></select>
      <input type="search" aria-label="Search titles and people" placeholder="Title or person" value={q} maxLength={120} onChange={e=>setQ(e.target.value)}/>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    {list.error&&!list.data?<ErrorNotice message={list.error.message} retry={list.reload}/>:!list.data?<Loading/>:!list.data.items.length?<Empty title="No requests"/>:<>
      <div className="table-scroll"><table className="requests-table"><thead><tr><th>Title</th><th>Requested by</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{list.data.items.map(item=><tr key={item.id}>
          <td><strong>{item.title}</strong>{item.year?` (${item.year})`:''}<small>{seasonText(item)}</small></td>
          <td>{item.accountName}<small>{date(item.createdAt)}</small></td>
          <td><span className={`badge ${tone[item.status]??''}`}>{requestStatusNames[item.status]}</span>
            {item.error&&<small className="danger">{item.error}</small>}
            {item.status==='removed'&&item.removedBy&&<small>{removedBy[item.removedBy]??''}</small>}</td>
          <td><div className="button-row">{item.status==='failed'&&<button disabled={mutation.busy} onClick={()=>act(item,'retry')}>Retry</button>}
            {item.status!=='removed'&&<button disabled={mutation.busy} onClick={()=>act(item,'remove')}>Remove</button>}</div></td>
        </tr>)}</tbody></table></div>
      <div className="button-row requests-pager"><span className="muted small">{list.data.total} in all</span>
        <button disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button><button disabled={!list.data.hasMore} onClick={()=>setPage(p=>p+1)}>Next</button></div>
    </>}
  </Card>;
}

function RequestDefaults() {
  const settings=useApi<RequestSettings>('/admin/requests/settings');
  const movie=useApi<RequestOptions>('/admin/requests/options?kind=movie'),show=useApi<RequestOptions>('/admin/requests/options?kind=show');
  const [draft,setDraft]=useState<RequestSettings>(),[done,setDone]=useState(false),mutation=useMutation(()=>invalidate('/admin/requests/settings'));
  useEffect(()=>{if(settings.data)setDraft(settings.data);},[settings.data?.revision]);
  if(settings.error&&!settings.data)return <Card title="Where requests go"><ErrorNotice message={settings.error.message} retry={settings.reload}/></Card>;
  if(!draft)return <Card title="Where requests go"><Loading/></Card>;
  const save=()=>void mutation.run(async()=>{const {revision,...value}=draft;await api('/admin/requests/settings','PUT',{expectedRevision:revision,...value});setDone(true);});
  return <form onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Where requests go" description="Administrators can change these per request.">
      <div className="form-columns">
        <Destination title="Movies" service="Radarr" options={movie} value={draft.movie} set={v=>{setDone(false);setDraft({...draft,movie:{...draft.movie,...v}});}}/>
        <Destination title="Shows" service="Sonarr" options={show} value={draft.show} set={v=>{setDone(false);setDraft({...draft,show:{...draft.show,...v}});}}/>
      </div>
      <Switch label="Season folders" checked={draft.show.seasonFolders} onChange={v=>{setDone(false);setDraft({...draft,show:{...draft.show,seasonFolders:v}});}}/>
      <Switch label="Search when added" checked={draft.searchOnAdd} onChange={v=>{setDone(false);setDraft({...draft,searchOnAdd:v});}}/>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </Card>
  </form>;
}
function Destination({title,service,options,value,set}:{title:string;service:string;options:ReturnType<typeof useApi<RequestOptions>>;value:RequestSettings['movie'];set:(patch:Partial<RequestSettings['movie']>)=>void}) {
  const o=options.data;
  return <fieldset className="requests-destination"><legend>{title}</legend>
    {options.error?<ErrorNotice message={options.error.message} retry={options.reload}/>:!o?<Loading/>:!o.connected?<p className="muted small">{service} isn’t connected. Add it in <a href="#admin?section=connections&category=downloads">Admin › Connections</a>.</p>:<>
      <label>Quality profile<select value={value.profileId} onChange={e=>set({profileId:Number(e.target.value)})}><option value={0}>{service}’s first{o.profiles[0]?` (${o.profiles[0].name})`:''}</option>{o.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Root folder<select value={value.rootFolder} onChange={e=>set({rootFolder:e.target.value})}><option value="">{service}’s first{o.rootFolders[0]?` (${o.rootFolders[0].path})`:''}</option>{o.rootFolders.map(r=><option key={r.path} value={r.path}>{r.path}</option>)}</select></label>
      {o.tags.length>0&&<div className="requests-tags" role="group" aria-label={`${title} tags`}><span>Tags</span>{o.tags.map(t=><label key={t.id}><input type="checkbox" checked={value.tags.includes(t.id)}
        onChange={e=>set({tags:e.target.checked?[...value.tags,t.id]:value.tags.filter(x=>x!==t.id)})}/>{t.label}</label>)}</div>}
    </>}
  </fieldset>;
}
