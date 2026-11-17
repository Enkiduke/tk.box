import {useState} from 'react';
import type {ConnectionTest,DownloaderView,IndexerView} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {invalidate} from './hooks.js';
import {ErrorNotice} from './components.js';
import {Switch,plural,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';

// The editors for tk.box's own indexers and downloaders, opened from Admin › Connections › Indexers & downloaders.

const numbers=(text:string)=>text.split(/[\s,]+/).filter(Boolean).map(Number);
const validNumbers=(text:string)=>numbers(text).every(n=>Number.isInteger(n)&&n>0);
const refresh=()=>{invalidate('/admin/indexers');invalidate('/admin/downloaders');};

function TestButton({path,disabled}:{path:string;disabled?:boolean}) {
  const [busy,setBusy]=useState(false);
  const run=async()=>{setBusy(true);try{toast.success((await api<ConnectionTest>(path,'POST')).detail);}catch(e){toast.error((e as Error).message);}finally{setBusy(false);refresh();}};
  return <button type="button" disabled={busy||disabled} onClick={()=>void run()}>{busy?'Testing…':'Test'}</button>;
}

export function NzbGeekEditor({indexer,onClose}:{indexer:IndexerView;onClose:()=>void}) {
  const s=indexer.settings;
  const [enabled,setEnabled]=useState(indexer.enabled),[key,setKey]=useState(''),[movies,setMovies]=useState(s.categories.movies.join(', ')),[tv,setTv]=useState(s.categories.tv.join(', '));
  const [hourly,setHourly]=useState(String(s.hourlyCap)),[daily,setDaily]=useState(String(s.dailyCap));
  const mutation=useMutation(refresh);
  const valid=validNumbers(movies)&&validNumbers(tv);
  const save=async()=>{
    const saved=await mutation.run(async()=>{
      await api('/admin/indexers/nzbgeek','PUT',{enabled,...(key.trim()?{key:key.trim()}:{}),settings:{categories:{movies:numbers(movies),tv:numbers(tv)},hourlyCap:Number(hourly),dailyCap:Number(daily)}});
    });
    if(saved){toast.success('NZBGeek saved');onClose();}
  };
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();if(valid)void save();}}>
    <Switch label="On" checked={enabled} onChange={setEnabled}/>
    <label>API key<input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={indexer.secretSet?'Saved. Enter a new value to replace it.':''} onChange={e=>setKey(e.target.value)}/></label>
    <div className="form-columns">
      <label>Movie categories<input value={movies} aria-invalid={!validNumbers(movies)} onChange={e=>setMovies(e.target.value)}/></label>
      <label>TV categories<input value={tv} aria-invalid={!validNumbers(tv)} onChange={e=>setTv(e.target.value)}/></label>
      <label>Searches an hour<input type="number" min={1} max={10000} required value={hourly} onChange={e=>setHourly(e.target.value)}/></label>
      <label>Searches a day<input type="number" min={1} max={100000} required value={daily} onChange={e=>setDaily(e.target.value)}/></label>
    </div>
    <small className="muted">Today {plural(indexer.today.searches,'search')} · {plural(indexer.today.grabs,'grab')} · {indexer.thisHour} this hour</small>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row">
      <button className="primary" disabled={mutation.busy||!valid}>{mutation.busy?'Saving…':'Save settings'}</button>
      <TestButton path="/admin/indexers/nzbgeek/test" disabled={!indexer.secretSet}/>
      <button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

// IPTorrents' categories as Newznab ids; a parent takes every site category under it.
const iptMovies=[[2000,'Movies'],[2010,'Foreign'],[2030,'SD'],[2040,'HD'],[2045,'UHD'],[2050,'BluRay'],[2060,'3D'],[2070,'DVD'],[2080,'WEB-DL']] as const;
const iptTv=[[5000,'TV'],[5010,'WEB-DL'],[5020,'Foreign'],[5030,'SD'],[5040,'HD']] as const;
function CategoryChecks({label,options,value,onChange}:{label:string;options:readonly (readonly [number,string])[];value:number[];onChange:(next:number[])=>void}) {
  return <fieldset className="form-stack"><legend>{label}</legend><div className="button-row">{options.map(([id,name])=><label key={id} className="checkbox-label">
    <input type="checkbox" checked={value.includes(id)} onChange={e=>onChange(e.target.checked?[...value,id].sort((a,b)=>a-b):value.filter(v=>v!==id))}/>{name} <small className="muted">{id}</small></label>)}</div></fieldset>;
}

export function IptorrentsEditor({indexer,onClose}:{indexer:IndexerView;onClose:()=>void}) {
  const s=indexer.settings,saved=indexer.iptorrents;
  const [enabled,setEnabled]=useState(indexer.enabled),[rss,setRss]=useState(''),[cookie,setCookie]=useState(''),[agent,setAgent]=useState(saved?.userAgent??'');
  const [movies,setMovies]=useState<number[]>(s.categories.movies),[tv,setTv]=useState<number[]>(s.categories.tv),[free,setFree]=useState(s.freeleechOnly);
  const [hourly,setHourly]=useState(String(s.hourlyCap)),[daily,setDaily]=useState(String(s.dailyCap));
  const mutation=useMutation(refresh);
  const save=async()=>{
    const ok=await mutation.run(async()=>{
      await api('/admin/indexers/iptorrents','PUT',{enabled,...(rss.trim()?{rssUrl:rss.trim()}:{}),...(cookie.trim()?{cookie:cookie.trim()}:{}),
        ...(agent.trim()!==(saved?.userAgent??'')?{userAgent:agent.trim()}:{}),
        settings:{categories:{movies,tv},freeleechOnly:free,hourlyCap:Number(hourly),dailyCap:Number(daily)}});
    });
    if(ok){toast.success('IPTorrents saved');onClose();}
  };
  const secret=(set:boolean|undefined)=>set?'Saved. Enter a new value to replace it.':'';
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();void save();}}>
    <Switch label="On" checked={enabled} onChange={setEnabled}/>
    <label>RSS address<input type="password" autoComplete="off" spellCheck={false} value={rss} placeholder={secret(saved?.rssSet)} onChange={e=>setRss(e.target.value)}/></label>
    <label>Cookie<input type="password" autoComplete="off" spellCheck={false} value={cookie} placeholder={secret(saved?.cookieSet)} onChange={e=>setCookie(e.target.value)}/>
      <small className="muted">Copy the full Cookie value from Request Headers on the signed-in iptorrents.com/t page, including the uid and pass entries.</small>
    </label>
    <label>User agent<input autoComplete="off" spellCheck={false} value={agent} onChange={e=>setAgent(e.target.value)}/></label>
    <CategoryChecks label="Movie categories" options={iptMovies} value={movies} onChange={setMovies}/>
    <CategoryChecks label="TV categories" options={iptTv} value={tv} onChange={setTv}/>
    <Switch label="Freeleech only" checked={free} onChange={setFree}/>
    <div className="form-columns">
      <label>Searches an hour<input type="number" min={1} max={10000} required value={hourly} onChange={e=>setHourly(e.target.value)}/></label>
      <label>Searches a day<input type="number" min={1} max={100000} required value={daily} onChange={e=>setDaily(e.target.value)}/></label>
    </div>
    <small className="muted">Today {plural(indexer.today.searches,'search')} · {plural(indexer.today.grabs,'grab')} · {indexer.thisHour} this hour</small>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row">
      <button className="primary" disabled={mutation.busy||!movies.length}>{mutation.busy?'Saving…':'Save settings'}</button>
      <TestButton path="/admin/indexers/iptorrents/test" disabled={!saved?.cookieSet}/>
      <button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

export function QbittorrentEditor({downloader,onClose}:{downloader:DownloaderView;onClose:()=>void}) {
  const s=downloader.settings;
  const [url,setUrl]=useState(downloader.url),[key,setKey]=useState('');
  const [movie,setMovie]=useState(s.categories.movie),[show,setShow]=useState(s.categories.show);
  const mutation=useMutation(refresh);
  const save=async()=>{
    const ok=await mutation.run(async()=>{
      await api('/admin/downloaders/qbittorrent','PUT',{url:url.trim(),...(key.trim()?{key:key.trim()}:{}),
        settings:{categories:{movie:movie.trim(),show:show.trim()}}});
    });
    if(ok){toast.success('qBittorrent saved');onClose();}
  };
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();void save();}}>
    <label>Server address<input type="url" placeholder="http://127.0.0.1:8080" value={url} onChange={e=>setUrl(e.target.value)}/></label>
    <label>API key<input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={downloader.secretSet?'Saved. Enter a new value to replace it.':''} onChange={e=>setKey(e.target.value)}/></label>
    <div className="form-columns">
      <label>Movie category<input required pattern="[\w.\-]+" value={movie} onChange={e=>setMovie(e.target.value)}/></label>
      <label>TV category<input required pattern="[\w.\-]+" value={show} onChange={e=>setShow(e.target.value)}/></label>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row">
      <button className="primary" disabled={mutation.busy}>{mutation.busy?'Saving…':'Save settings'}</button>
      <TestButton path="/admin/downloaders/qbittorrent/test" disabled={!downloader.url}/>
      <button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

const priorities=[['','Category’s own'],['-1','Low'],['0','Normal'],['1','High'],['2','Force']] as const;
export function SabnzbdEditor({downloader,onClose}:{downloader:DownloaderView;onClose:()=>void}) {
  const s=downloader.settings;
  const [url,setUrl]=useState(downloader.url),[key,setKey]=useState(''),[movie,setMovie]=useState(s.categories.movie),[show,setShow]=useState(s.categories.show),[priority,setPriority]=useState(s.priority===undefined?'':String(s.priority));
  const mutation=useMutation(refresh);
  const save=async()=>{
    const saved=await mutation.run(async()=>{
      await api('/admin/downloaders/sabnzbd','PUT',{url:url.trim(),...(key.trim()?{key:key.trim()}:{}),settings:{categories:{movie:movie.trim(),show:show.trim()},...(priority?{priority:Number(priority)}:{})}});
    });
    if(saved){toast.success('SABnzbd saved');onClose();}
  };
  const ready=!!downloader.url&&downloader.secretSet;
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();void save();}}>
    <label>Server address<input type="url" placeholder="http://127.0.0.1:8080" value={url} onChange={e=>setUrl(e.target.value)}/></label>
    <label>API key<input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={downloader.secretSet?'Saved. Enter a new value to replace it.':''} onChange={e=>setKey(e.target.value)}/></label>
    <div className="form-columns">
      <label>Movie category<input required pattern="[\w.\-]+" value={movie} onChange={e=>setMovie(e.target.value)}/></label>
      <label>TV category<input required pattern="[\w.\-]+" value={show} onChange={e=>setShow(e.target.value)}/></label>
      <label>Priority<select value={priority} onChange={e=>setPriority(e.target.value)}>{priorities.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row">
      <button className="primary" disabled={mutation.busy}>{mutation.busy?'Saving…':'Save settings'}</button>
      <TestButton path="/admin/downloaders/sabnzbd/test" disabled={!ready}/>
      <button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button>
    </div>
  </form>;
}
