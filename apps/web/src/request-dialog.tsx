import {useEffect,useRef,useState} from 'react';
import type {ExploreDetails,ExploreItem,ExploreRequestExtras,ExploreSeason,ExploreSeerrAccount,ExploreSeerrOptions,ExploreSeerrUser,ExploreStatus} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {seasonList,seasonModes,seasonsFor,type SeasonMode} from './request-seasons.js';

const statusNames:Record<ExploreStatus,string>={available:'Available',partial:'Partly available',requested:'Requested'};
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
const freeSpace=(bytes?:number)=>bytes===undefined?'':` · ${(bytes/1024**4>=1?`${(bytes/1024**4).toFixed(1)} TB`:`${Math.round(bytes/1024**3)} GB`)} free`;

// Seerr's request window: what will be requested, whether it is approved on its own, and, for those Seerr allows,
// the Radarr/Sonarr server, quality profile, folder, tags and the user it is requested for. Opening it signs the
// viewer in to Seerr with their Plex account if they are not yet.
export function RequestDialog({item,seerr,onClose,onDone}:{item:ExploreItem;seerr:NonNullable<ExploreDetails['seerr']>;onClose:()=>void;onDone:(message:string)=>void}) {
  const ref=useRef<HTMLDialogElement>(null),close=useRef(onClose);close.current=onClose;
  // A second dialog over the title's own; closing it leaves the page locked for the one underneath.
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
  const account=useApi<ExploreSeerrAccount>('/explore/seerr/account'),me=account.data,show=item.kind==='show';
  const both=seerr.requestable&&seerr.requestable4k,[fourK,setFourK]=useState(!seerr.requestable);
  const allowed=me&&(fourK?me.fourK[item.kind]:me.canRequest[item.kind]);
  const seasons=fourK?seerr.seasons4k:seerr.seasons,[mode,setMode]=useState<SeasonMode>('all'),[picked,setPicked]=useState<number[]>([]);
  useEffect(()=>{setPicked([]);},[fourK]);
  const chosen=show?seasonsFor(mode,seasons,{picked}):[],open=seasons.filter(s=>!s.status).map(s=>s.number);
  const episodes=seasons.filter(s=>chosen.includes(s.number)).reduce((n,s)=>n+(s.episodeCount??0),0);
  const [server,setServer]=useState<number>();
  const [expanded,setExpanded]=useState(false);
  // Collapsed, Advanced reads nothing and the request uses Seerr's defaults.
  const options=useApi<ExploreSeerrOptions>(expanded&&me?.advanced?`/explore/seerr/options?${new URLSearchParams({kind:item.kind,is4k:String(fourK),...(server!==undefined?{server:String(server)}:{})})}`:undefined);
  const users=useApi<{users:ExploreSeerrUser[]}>(expanded&&me?.requestAs?'/explore/seerr/users':undefined);
  const [extras,setExtras]=useState<ExploreRequestExtras>({});
  // A new server (or quality) starts again from its own defaults.
  useEffect(()=>{const o=options.data;if(o)setExtras(e=>({...(e.userId?{userId:e.userId}:{}),...(o.serverId!==undefined?{serverId:o.serverId}:{}),...(o.profileId!==undefined?{profileId:o.profileId}:{}),
    ...(o.rootFolder?{rootFolder:o.rootFolder}:{}),...(o.languageProfileId!==undefined?{languageProfileId:o.languageProfileId}:{}),tags:o.defaultTags}));},[options.data]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const autoApprove=me&&me.autoApprove[`${item.kind}${fourK?'4k':''}` as keyof ExploreSeerrAccount['autoApprove']];
  const submit=async()=>{
    if(busy||!allowed||(show&&!chosen.length))return;setBusy(true);setError('');
    try {
      await api('/explore/request','POST',{kind:item.kind,tmdb:item.ids.tmdb,is4k:fourK,...(show?{seasons:chosen}:{}),...(!expanded?{}:me?.advanced&&options.data?extras:extras.userId?{userId:extras.userId}:{})});
      invalidate('/explore/');onDone(`Requested ${item.title}${show?` · ${seasonList(chosen)}`:''}${fourK?' in 4K':''}.`);
    } catch(e){setError((e as Error).message);setBusy(false);}
  };
  const o=options.data,set=(patch:ExploreRequestExtras)=>setExtras(e=>({...e,...patch}));
  return <dialog ref={ref} className="request-dialog" aria-label={`Request ${item.title}`} onCancel={e=>{e.preventDefault();close.current();}} onClick={e=>{if(e.target===ref.current)close.current();}}>
    <form className="request-form" onSubmit={e=>{e.preventDefault();void submit();}}>
      <header className="request-head"><div><p className="request-kicker">Request {show?'Series':'Movie'}</p><h2>{item.title}</h2></div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close"/></button></header>
      {account.loading&&!me?<div className="request-loading"><Loading/><span className="muted small">Signing in to Seerr…</span></div>
      :account.error?<ErrorNotice message={account.error.message} retry={account.reload}/>:me&&<>
        {!allowed?<div className="notice error"><span>Your Seerr account can’t request {show?'shows':'movies'}{fourK?' in 4K':''}.</span></div>
          :autoApprove?<div className="notice request-notice"><Icon name="info" size={18}/><span>This request will be approved automatically.</span></div>
          :<div className="notice subtle"><Icon name="info" size={18}/><span>An administrator will review this request.</span></div>}
        {both&&<div className="request-field"><span className="request-label">Quality</span><div className="toggle-group" role="radiogroup" aria-label="Quality"><button type="button" role="radio" aria-checked={!fourK} onClick={()=>setFourK(false)}>Standard</button><button type="button" role="radio" aria-checked={fourK} onClick={()=>setFourK(true)}>4K</button></div></div>}
        {show&&seasons.length>1&&<div className="request-field">
          <label className="request-label" htmlFor="request-mode">Seasons</label>
          <select id="request-mode" value={mode} onChange={e=>setMode(e.target.value as SeasonMode)}>
            {seasonModes.map(([value,label])=>{const count=value==='manual'?open.length:seasonsFor(value,seasons).length;return <option key={value} value={value} disabled={!count}>{label}{value!=='manual'&&count?` · ${seasonList(seasonsFor(value,seasons))}`:''}</option>;})}
          </select>
          {mode==='manual'?<SeasonTable seasons={seasons} picked={picked} setPicked={setPicked}/>
            :<p className="muted small">{chosen.length?`${seasonList(chosen)}${episodes?` · ${plural(episodes,'episode')}`:''}`:'Nothing to request for this choice.'}{seasons.length>open.length?` Seasons already on the server or requested are left out.`:''}</p>}
        </div>}
        {(me.advanced||me.requestAs)&&<details className="request-advanced" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}>
          <summary><Icon name="next" size={16}/>Advanced</summary>
          <div className="request-advanced-body">
          {me.advanced&&(options.error?<ErrorNotice message={options.error.message} retry={options.reload}/>:!o?<Loading/>:<>
            {o.servers.length>1&&<label className="request-field"><span className="request-label">Destination Server</span><select value={o.serverId} onChange={e=>setServer(Number(e.target.value))}>{o.servers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
            {o.profiles.length>0&&<label className="request-field"><span className="request-label">Quality Profile</span><select value={extras.profileId} onChange={e=>set({profileId:Number(e.target.value)})}>{o.profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===o.profileId?' (Default)':''}</option>)}</select></label>}
            {o.rootFolders.length>1&&<label className="request-field"><span className="request-label">Root Folder</span><select value={extras.rootFolder} onChange={e=>set({rootFolder:e.target.value})}>{o.rootFolders.map(r=><option key={r.path} value={r.path}>{r.path}{freeSpace(r.freeSpace)}{r.path===o.rootFolder?' (Default)':''}</option>)}</select></label>}
            {o.languageProfiles.length>1&&<label className="request-field"><span className="request-label">Language Profile</span><select value={extras.languageProfileId} onChange={e=>set({languageProfileId:Number(e.target.value)})}>{o.languageProfiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===o.languageProfileId?' (Default)':''}</option>)}</select></label>}
            {o.tags.length>0&&<div className="request-field"><span className="request-label">Tags</span><div className="explore-chips">{o.tags.map(t=>{const on=extras.tags?.includes(t.id)??false;
              return <button key={t.id} type="button" className="explore-chip" aria-pressed={on} onClick={()=>set({tags:on?extras.tags!.filter(x=>x!==t.id):[...(extras.tags??[]),t.id]})}>{t.label}</button>;})}</div></div>}
          </>)}
          {me.requestAs&&(users.error?<ErrorNotice message={users.error.message} retry={users.reload}/>:!users.data?(!me.advanced&&<Loading/>):users.data.users.length>1&&<label className="request-field"><span className="request-label">Request As</span>
          <select value={extras.userId??''} onChange={e=>set({userId:e.target.value?Number(e.target.value):undefined})}><option value="">{me.user?`${me.user} (you)`:'Yourself'}</option>
            {users.data.users.filter(u=>u.name!==me.user).map(u=><option key={u.id} value={u.id}>{u.name}{u.email&&u.email!==u.name?` (${u.email})`:''}</option>)}</select></label>)}
          </div>
        </details>}
      </>}
      {error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}
      <footer className="request-foot"><button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy||!allowed||(show&&!chosen.length)}>{busy?'Requesting…':show&&chosen.length?`Request ${plural(chosen.length,'season')}`:'Request'}{fourK?' in 4K':''}</button></footer>
    </form>
  </dialog>;
}
// Manual: every season with a switch, as Seerr lists them. Seasons on the server or requested show their state instead.
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
