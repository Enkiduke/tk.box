import {useEffect,useState} from 'react';
import type {RequestArtwork,RequestItem,RequestOptions,RequestPage,RequestSettings,RequestStatus,RequestsSiteStatus} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {invalidate,useApi,useNearViewport} from './hooks.js';
import {Artwork,Empty,ErrorNotice,FadeImage,Icon,Loading} from './components.js';
import {Card,SectionHead,Switch,date,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';

// Admin › Requests: every request (docs/REQUESTS.md), where requests go (tk.box's profiles for movies, Sonarr for shows), and the Requests site.
export const requestStatusNames:Record<RequestStatus,string>={queued:'Queued',requested:'Requested',downloading:'Downloading',partial:'Partly available',available:'Available',failed:'Failed',removed:'Removed'};
const statusFilters=[['','All'] as const,...Object.entries(requestStatusNames)];
const kindFilters=[['','All'],['movie','Movies'],['show','Shows']] as const;
const tone:Partial<Record<RequestStatus,string>>={available:'ok',partial:'ok',downloading:'warning',failed:'danger'};
const removedBy:Record<string,string>={requester:'by the requester',admin:'by an administrator',cleanup:'by Clean Up',arr:'from Radarr or Sonarr'};
const seasonText=(item:RequestItem)=>item.kind==='movie'?'Movie':item.seasons.length?`Season${item.seasons.length>1?'s':''} ${item.seasons.map(s=>s.season).join(', ')}`:'Show';

export function RequestsAdmin() {
  return <><SectionHead title="Requests"/><RequestList/><RequestDefaults/><RequestsSite/></>;
}

function RequestFilter({label,options,value,onChange}:{label:string;options:readonly (readonly [string,string])[];value:string;onChange:(value:string)=>void}) {
  return <div className="toggle-group" role="radiogroup" aria-label={label}>
    {options.map(([id,name],index)=><button key={id} type="button" role="radio" aria-checked={value===id} tabIndex={value===id?0:-1}
      onClick={()=>{if(value!==id)onChange(id);}}
      onKeyDown={event=>{
        const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0;
        if(!step)return;
        event.preventDefault();
        const next=(index+step+options.length)%options.length;
        onChange(options[next]![0]);
        event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();
      }}>{name}</button>)}
  </div>;
}

function RequestList() {
  const [status,setStatus]=useState(''),[kind,setKind]=useState(''),[q,setQ]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1);
  useEffect(()=>{const t=setTimeout(()=>{setSearch(q.trim());setPage(1);},300);return()=>clearTimeout(t);},[q]);
  const query=new URLSearchParams({page:String(page),...(status?{status}:{}),...(kind?{kind}:{}),...(search?{q:search}:{})});
  const list=useApi<RequestPage>(`/admin/requests?${query}`),mutation=useMutation(()=>invalidate('/admin/requests?'));
  const act=(item:RequestItem,action:'retry'|'remove')=>void mutation.run(async()=>{if(action==='retry'){await api(`/admin/requests/${item.id}/retry`,'POST');toast.info(`Retrying ${item.title}`);}else{await api(`/admin/requests/${item.id}`,'DELETE');toast.success(`Removed ${item.title}`);}});
  return <Card>
    <div className="requests-filters">
      <RequestFilter label="Media type" options={kindFilters} value={kind} onChange={value=>{setKind(value);setPage(1);}}/>
      <RequestFilter label="Status" options={statusFilters} value={status} onChange={value=>{setStatus(value);setPage(1);}}/>
      <input type="search" aria-label="Search titles and people" placeholder="Title or person" value={q} maxLength={120} onChange={e=>setQ(e.target.value)}/>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    {list.error&&!list.data?<ErrorNotice message={list.error.message} retry={list.reload}/>:!list.data?<Loading/>:!list.data.items.length?<Empty title="No requests"/>:<>
      <ul className="requests-list" role="list">
        {list.data.items.map(item=><RequestRow key={item.id} item={item} busy={mutation.busy} act={act}/>)}
      </ul>
      <div className="button-row requests-pager"><span className="muted small">{list.data.total} in all</span>
        <button disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button><button disabled={!list.data.hasMore} onClick={()=>setPage(p=>p+1)}>Next</button></div>
    </>}
  </Card>;
}

function RequestRow({item,busy,act}:{item:RequestItem;busy:boolean;act:(item:RequestItem,action:'retry'|'remove')=>void}) {
  const [ref,near]=useNearViewport<HTMLLIElement>('240px');
  const {data:art}=useApi<RequestArtwork>(near?`/admin/requests/${item.id}/artwork`:undefined);
  return <li ref={ref} className="request-row">
    {art?.backdropUrl&&<FadeImage className="request-backdrop" src={art.backdropUrl} alt="" loading="lazy" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>}
    <div className="request-poster" aria-hidden="true">
      <Artwork key={art?.posterUrl} src={art?.posterUrl} fallback={<Icon name={item.kind==='movie'?'movies':'shows'}/>}/>
    </div>
    <div className="request-title">
      <strong>{item.title}</strong>{item.year&&<span className="request-year"> {item.year}</span>}
      <small>{seasonText(item)}</small>
    </div>
    <div className="request-by">
      <span className="sr-only">Requested by </span>{item.accountName}
      <small>{date(item.createdAt)}</small>
    </div>
    <div className="request-status">
      <span className="sr-only">Status </span><span className={`badge ${tone[item.status]??''}`}>{requestStatusNames[item.status]}</span>
      {item.error&&<small className="danger">{item.error}</small>}
      {item.status==='removed'&&item.removedBy&&<small>{removedBy[item.removedBy]}</small>}
    </div>
    {item.status!=='removed'&&<div className="button-row request-actions">
      {item.status==='failed'&&<button aria-label={`Retry ${item.title}`} disabled={busy} onClick={()=>act(item,'retry')}>Retry</button>}
      <button aria-label={`Remove ${item.title}`} disabled={busy} onClick={()=>act(item,'remove')}>Remove</button>
    </div>}
  </li>;
}

function RequestDefaults() {
  const settings=useApi<RequestSettings>('/admin/requests/settings');
  const movie=useApi<RequestOptions>('/admin/requests/options?kind=movie'),show=useApi<RequestOptions>('/admin/requests/options?kind=show');
  const [draft,setDraft]=useState<RequestSettings>(),mutation=useMutation(()=>invalidate('/admin/requests/settings'));
  useEffect(()=>{if(settings.data)setDraft(settings.data);},[settings.data?.revision]);
  if(settings.error&&!settings.data)return <Card title="Where requests go"><ErrorNotice message={settings.error.message} retry={settings.reload}/></Card>;
  if(!draft)return <Card title="Where requests go"><Loading/></Card>;
  const save=()=>void mutation.run(async()=>{const {revision,...value}=draft;await api('/admin/requests/settings','PUT',{expectedRevision:revision,...value});toast.success('Request settings saved');});
  return <form onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Where requests go" description="Administrators can change these per request.">
      <div className="form-columns">
        <Destination title="Movies" service="tk.box" options={movie} value={draft.movie} set={v=>{setDraft({...draft,movie:{...draft.movie,...v}});}}/>
        <Destination title="Shows" service="Sonarr" options={show} value={draft.show} set={v=>{setDraft({...draft,show:{...draft.show,...v}});}}/>
      </div>
      <Switch label="Season folders" checked={draft.show.seasonFolders} onChange={v=>{setDraft({...draft,show:{...draft.show,seasonFolders:v}});}}/>
      <Switch label="Search when added" checked={draft.searchOnAdd} onChange={v=>{setDraft({...draft,searchOnAdd:v});}}/>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save</button></div>
    </Card>
  </form>;
}
function Destination({title,service,options,value,set}:{title:string;service:string;options:ReturnType<typeof useApi<RequestOptions>>;value:RequestSettings['movie'];set:(patch:Partial<RequestSettings['movie']>)=>void}) {
  const o=options.data;
  // On tk.box (Admin › Downloads) the profiles are its pick profiles, and there is no folder or tag to pick.
  if(o?.tkbox)return <fieldset className="requests-destination"><legend>{title}</legend>
    <label>Quality profile<select value={o.profiles.some(p=>p.id===value.profileId)?value.profileId:0} onChange={e=>set({profileId:Number(e.target.value)})}><option value={0}>Default profile</option>{o.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
  </fieldset>;
  return <fieldset className="requests-destination"><legend>{title}</legend>
    {options.error?<ErrorNotice message={options.error.message} retry={options.reload}/>:!o?<Loading/>:!o.connected?<p className="muted small">{service} isn’t connected. Add it in <a href="#admin?section=connections&category=downloads">Admin › Connections</a>.</p>:<>
      <label>Quality profile<select value={value.profileId} onChange={e=>set({profileId:Number(e.target.value)})}><option value={0}>{service}’s first{o.profiles[0]?` (${o.profiles[0].name})`:''}</option>{o.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Root folder<select value={value.rootFolder} onChange={e=>set({rootFolder:e.target.value})}><option value="">{service}’s first{o.rootFolders[0]?` (${o.rootFolders[0].path})`:''}</option>{o.rootFolders.map(r=><option key={r.path} value={r.path}>{r.path}</option>)}</select></label>
      {o.tags.length>0&&<div className="requests-tags" role="group" aria-label={`${title} tags`}><span>Tags</span>{o.tags.map(t=><label key={t.id}><input type="checkbox" checked={value.tags.includes(t.id)}
        onChange={e=>set({tags:e.target.checked?[...value.tags,t.id]:value.tags.filter(x=>x!==t.id)})}/>{t.label}</label>)}</div>}
    </>}
  </fieldset>;
}

// The Requests site: Explore, Calendar and each viewer's requests on a port of its own. Saving applies it at once.
function RequestsSite() {
  const site=useApi<RequestsSiteStatus>('/admin/requests/site');
  const [on,setOn]=useState(false),[port,setPort]=useState(''),[url,setUrl]=useState(''),mutation=useMutation(()=>invalidate('/admin/requests/site'));
  useEffect(()=>{if(!site.data)return;setOn(site.data.port!==null);setPort(String(site.data.port??site.data.appPort+1));setUrl(site.data.publicUrl??'');},[site.data?.revision]);
  if(site.error&&!site.data)return <Card title="Requests site"><ErrorNotice message={site.error.message} retry={site.reload}/></Card>;
  if(!site.data)return <Card title="Requests site"><Loading/></Card>;
  const data=site.data,edit=<T,>(set:(v:T)=>void)=>set;
  const save=()=>void mutation.run(async()=>{await api('/admin/requests/site','PUT',{expectedRevision:data.revision,port:on?Number(port):null,publicUrl:on&&data.publicAddress?url.trim()||null:null});toast.success('Requests site saved');});
  const status=data.running?<span className="success">Running on port {data.running}</span>:data.error?<span className="warning-text">{data.error}</span>:<span className="muted">Off</span>;
  return <form onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Requests site" actions={status}>
      <Switch label="On" checked={on} onChange={edit(setOn)}/>
      {on&&<div className="form-columns">
        <label>Port<input type="number" min={1024} max={65535} required value={port} onChange={e=>edit(setPort)(e.target.value)}/></label>
        {data.publicAddress&&<label>Public address<input type="url" required placeholder="https://requests.example.com" value={url} onChange={e=>edit(setUrl)(e.target.value)}/></label>}
      </div>}
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save</button></div>
    </Card>
  </form>;
}
