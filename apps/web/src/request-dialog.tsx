import {useEffect,useRef,useState} from 'react';
import type {ExploreDetails,ExploreItem,ExploreSeason,ExploreStatus,RequestOptions} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {seasonList,seasonModes,seasonsFor,type SeasonMode} from './request-seasons.js';

export const statusNames:Record<ExploreStatus,string>={available:'Available',partial:'Partly available',downloading:'Downloading',requested:'Requested'};
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
const freeSpace=(bytes?:number)=>bytes===undefined?'':` · ${(bytes/1024**4>=1?`${(bytes/1024**4).toFixed(1)} TB`:`${Math.round(bytes/1024**3)} GB`)} free`;
type Extras={profileId?:number;rootFolder?:string;tags?:number[]};

// The request window: which seasons, and for administrators where it goes in Radarr or Sonarr (profile, which is also
// how 4K is chosen, root folder and tags). Every request is approved as it is made.
export function RequestDialog({item,request,admin,onClose,onDone}:{item:ExploreItem;request:NonNullable<ExploreDetails['request']>;admin:boolean;onClose:()=>void;onDone:(message:string)=>void}) {
  const ref=useRef<HTMLDialogElement>(null),close=useRef(onClose);close.current=onClose;
  // A second dialog over the title's own; closing it leaves the page locked for the one underneath.
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
  const show=item.kind==='show',seasons=request.seasons,[mode,setMode]=useState<SeasonMode>('all'),[picked,setPicked]=useState<number[]>([]);
  const chosen=show?seasonsFor(mode,seasons,{picked}):[],open=seasons.filter(s=>!s.status).map(s=>s.number);
  const episodes=seasons.filter(s=>chosen.includes(s.number)).reduce((n,s)=>n+(s.episodeCount??0),0);
  const [expanded,setExpanded]=useState(false);
  // Collapsed, Advanced reads nothing and the request uses Admin › Requests' defaults.
  const options=useApi<RequestOptions>(admin&&expanded?`/admin/requests/options?kind=${item.kind}`:undefined),o=options.data;
  const [extras,setExtras]=useState<Extras>({});
  useEffect(()=>{if(o)setExtras({profileId:o.defaults.profileId||o.profiles[0]?.id,rootFolder:o.defaults.rootFolder||o.rootFolders[0]?.path,tags:o.defaults.tags});},[o]);
  const set=(patch:Extras)=>setExtras(e=>({...e,...patch}));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async()=>{
    if(busy||(show&&!chosen.length))return;setBusy(true);setError('');
    try {
      const advanced=admin&&expanded&&o?.connected?Object.fromEntries(Object.entries(extras).filter(([,v])=>v!==undefined&&v!=='')):{};
      await api('/requests','POST',{kind:item.kind,tmdb:item.ids.tmdb,...(show&&chosen.length<open.length?{seasons:chosen}:{}),...advanced});
      invalidate('/explore/');invalidate('/requests/mine');onDone(`Requested ${item.title}${show?` · ${seasonList(chosen)}`:''}.`);
    } catch(e){setError((e as Error).message);setBusy(false);}
  };
  return <dialog ref={ref} className="request-dialog" aria-label={`Request ${item.title}`} onCancel={e=>{e.preventDefault();close.current();}} onClick={e=>{if(e.target===ref.current)close.current();}}>
    <form className="request-form" onSubmit={e=>{e.preventDefault();void submit();}}>
      <header className="request-head"><div><p className="request-kicker">Request {show?'Series':'Movie'}</p><h2>{item.title}</h2></div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close"/></button></header>
      {show&&seasons.length>1&&<div className="request-field">
        <label className="request-label" htmlFor="request-mode">Seasons</label>
        <select id="request-mode" value={mode} onChange={e=>setMode(e.target.value as SeasonMode)}>
          {seasonModes.map(([value,label])=>{const count=value==='manual'?open.length:seasonsFor(value,seasons).length;return <option key={value} value={value} disabled={!count}>{label}{value!=='manual'&&count?` · ${seasonList(seasonsFor(value,seasons))}`:''}</option>;})}
        </select>
        {mode==='manual'?<SeasonTable seasons={seasons} picked={picked} setPicked={setPicked}/>
          :<p className="muted small">{chosen.length?`${seasonList(chosen)}${episodes?` · ${plural(episodes,'episode')}`:''}`:'Nothing to request for this choice.'}{seasons.length>open.length?' Seasons already on the server or requested are left out.':''}{mode==='all'&&chosen.length?' New seasons are added as they air.':''}</p>}
      </div>}
      {admin&&<details className="request-advanced" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}>
        <summary><Icon name="next" size={16}/>Advanced</summary>
        <div className="request-advanced-body">
          {options.error?<ErrorNotice message={options.error.message} retry={options.reload}/>:!o?<Loading/>:!o.connected?<p className="muted small">{show?'Sonarr':'Radarr'} isn’t connected.</p>:<>
            {o.profiles.length>0&&<label className="request-field"><span className="request-label">Quality Profile</span><select value={extras.profileId} onChange={e=>set({profileId:Number(e.target.value)})}>{o.profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===o.defaults.profileId?' (Default)':''}</option>)}</select></label>}
            {o.rootFolders.length>1&&<label className="request-field"><span className="request-label">Root Folder</span><select value={extras.rootFolder} onChange={e=>set({rootFolder:e.target.value})}>{o.rootFolders.map(r=><option key={r.path} value={r.path}>{r.path}{freeSpace(r.freeSpace)}{r.path===o.defaults.rootFolder?' (Default)':''}</option>)}</select></label>}
            {o.tags.length>0&&<div className="request-field"><span className="request-label">Tags</span><div className="explore-chips">{o.tags.map(t=>{const on=extras.tags?.includes(t.id)??false;
              return <button key={t.id} type="button" className="explore-chip" aria-pressed={on} onClick={()=>set({tags:on?(extras.tags??[]).filter(x=>x!==t.id):[...(extras.tags??[]),t.id]})}>{t.label}</button>;})}</div></div>}
          </>}
        </div>
      </details>}
      {error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}
      <footer className="request-foot"><button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy||(show&&!chosen.length)}>{busy?'Requesting…':show&&chosen.length?`Request ${plural(chosen.length,'season')}`:'Request'}</button></footer>
    </form>
  </dialog>;
}
// Manual: every season with a switch. Seasons on the server or requested show their state instead.
function SeasonTable({seasons,picked,setPicked}:{seasons:ExploreSeason[];picked:number[];setPicked:(next:number[])=>void}) {
  const open=seasons.filter(s=>!s.status).map(s=>s.number),all=open.length>0&&open.every(n=>picked.includes(n));
  const toggle=(n:number)=>setPicked(picked.includes(n)?picked.filter(x=>x!==n):[...picked,n].sort((a,b)=>a-b));
  return <div className="request-table" role="table" aria-label="Seasons">
    <div className="request-row request-row-head" role="row"><span role="columnheader"><input type="checkbox" role="switch" className="switch" aria-label="All seasons" checked={all} disabled={!open.length} onChange={()=>setPicked(all?[]:open)}/></span><span role="columnheader">Season</span><span role="columnheader">Episodes</span><span role="columnheader">Status</span></div>
    {seasons.map(s=><label key={s.number} className={`request-row${s.status?' is-taken':''}`} role="row" title={s.name}>
      <span role="cell"><input type="checkbox" role="switch" className="switch" disabled={!!s.status} checked={!!s.status||picked.includes(s.number)} onChange={()=>toggle(s.number)}/></span>
      <span role="cell" className="request-season-name">Season {s.number}{s.name&&!/^(season|series) \d+$/i.test(s.name)?<small>{s.name}</small>:null}</span>
      <span role="cell" className="muted">{s.episodeCount??'—'}</span>
      <span role="cell"><span className={`badge explore-status ${s.status??'open'}`}>{s.status?statusNames[s.status]:'Not Requested'}</span></span>
    </label>)}
  </div>;
}
