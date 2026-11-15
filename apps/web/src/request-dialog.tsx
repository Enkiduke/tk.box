import {useEffect,useRef,useState} from 'react';
import type {ExploreDetails,ExploreItem,ExploreSeason,ExploreStatus,RequestOptions} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {seasonList,seasonModes,seasonsFor,type SeasonMode} from './request-seasons.js';

export const statusNames:Record<ExploreStatus,string>={available:'Available',partial:'Partly available',downloading:'Downloading',requested:'Requested'};
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
// An administrator's request options: the quality profile (which is also how 4K is chosen) and Keep (Clean Up's
// protected tag). Root folder and tags come from Admin › Requests.
export type RequestExtras={profileId?:number;keep?:boolean};

// The options in Request's ▾ menu, read when it first opens; Request itself sends them.
export function RequestOptionsPanel({kind,extras,setExtras}:{kind:ExploreItem['kind'];extras:RequestExtras;setExtras:(update:(current:RequestExtras)=>RequestExtras)=>void}) {
  const options=useApi<RequestOptions>(`/admin/requests/options?kind=${kind}`),o=options.data;
  useEffect(()=>{if(o)setExtras(x=>x.profileId?x:{...x,profileId:o.defaults.profileId||o.profiles[0]?.id});},[o]);
  if(options.error)return <ErrorNotice message={options.error.message} retry={options.reload}/>;
  if(!o)return <Loading/>;
  if(!o.connected)return <p className="muted small">{kind==='show'?'Sonarr':'Radarr'} isn’t connected.</p>;
  return <div className="request-options">
    {o.profiles.length>0&&<label className="request-field"><span className="request-label">Quality profile</span>
      <select value={extras.profileId} onChange={e=>setExtras(x=>({...x,profileId:Number(e.target.value)}))}>{o.profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===o.defaults.profileId?' (Default)':''}</option>)}</select></label>}
    <label className="request-keep" title={o.keepTag?`Tags it “${o.keepTag}” so Clean Up never removes it`:'Add a protected tag in Clean Up › Settings first'}>
      <strong>Keep</strong><input type="checkbox" role="switch" className="switch" checked={!!extras.keep} disabled={!o.keepTag} onChange={e=>setExtras(x=>({...x,keep:e.target.checked}))}/></label>
  </div>;
}
export const extrasBody=(extras?:RequestExtras)=>extras?{...(extras.profileId?{profileId:extras.profileId}:{}),...(extras.keep?{keep:true}:{})}:{};

// The request window, for a show's seasons, with any options chosen in Request's menu. Every request is approved as it is made.
export function RequestDialog({item,request,extras,onClose,onDone}:{item:ExploreItem;request:NonNullable<ExploreDetails['request']>;extras?:RequestExtras;onClose:()=>void;onDone:(message:string)=>void}) {
  const ref=useRef<HTMLDialogElement>(null),close=useRef(onClose);close.current=onClose;
  // A second dialog over the title's own; closing it leaves the page locked for the one underneath.
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
  const show=item.kind==='show',seasons=request.seasons,[mode,setMode]=useState<SeasonMode>('all'),[picked,setPicked]=useState<number[]>([]);
  const chosen=show?seasonsFor(mode,seasons,{picked}):[],open=seasons.filter(s=>!s.status).map(s=>s.number);
  const episodes=seasons.filter(s=>chosen.includes(s.number)).reduce((n,s)=>n+(s.episodeCount??0),0);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async()=>{
    if(busy||(show&&!chosen.length))return;setBusy(true);setError('');
    try {
      await api('/requests','POST',{kind:item.kind,tmdb:item.ids.tmdb,...(show&&chosen.length<open.length?{seasons:chosen}:{}),...extrasBody(extras)});
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
