import {useEffect,useState} from 'react';
import type {LibrarySettingsView,NamingPreview} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {useApi,useDebounced} from './hooks.js';
import {Card,SectionHead} from './settings-ui.js';
import {toast} from './toasts.js';
import {Loaded,SaveBar,changed,useSave} from './manage-ui.js';

// Admin › Manage › Library settings (docs/PHASE-3.5.md): the movie root, the naming formats (shown, not edited) with a
// live preview, and the seeding numbers.

export function LibrarySettingsPage() {
  const view=useApi<LibrarySettingsView>('/admin/library/settings');
  return <><SectionHead title="Library settings"/>
    <Loaded view={view}>{s=><><Root key={`root${s.revision}`} settings={s}/><Seeding key={`seed${s.revision}`} settings={s}/><Naming settings={s}/></>}</Loaded>
  </>;
}

function Root({settings}:{settings:LibrarySettingsView}) {
  const [movie,setMovie]=useState(settings.roots.movie),save=useSave(changed);
  const submit=()=>void save.run(async()=>{await api('/admin/library/settings','PUT',{expectedRevision:settings.revision,roots:{movie:movie.trim()}});toast.success('Saved');});
  return <form onSubmit={e=>{e.preventDefault();submit();}}><Card title="Movie root">
    <label>Folder<input required spellCheck={false} value={movie} onChange={e=>setMovie(e.target.value)}/></label>
    <SaveBar dirty={movie.trim()!==settings.roots.movie} busy={save.busy} error={save.error} onCancel={()=>{setMovie(settings.roots.movie);save.clear();}} onReload={changed}/>
  </Card></form>;
}

// Ratio and days as typed; the server checks them against IPTorrents' floor too.
function Seeding({settings}:{settings:LibrarySettingsView}) {
  const start=settings.seeding,floor=settings.seedingFloor;
  const [draft,setDraft]=useState({ratio:String(start.ratio),minDays:String(start.minDays),maxDays:String(start.maxDays)}),save=useSave(changed);
  const n={ratio:Number(draft.ratio),minDays:Number(draft.minDays),maxDays:Number(draft.maxDays)};
  const errors={ratio:!(n.ratio>=floor.ratio)?`At least ${floor.ratio}`:undefined,minDays:!(n.minDays>=floor.days)?`At least ${floor.days}`:undefined,
    maxDays:!(n.maxDays>=floor.days)?`At least ${floor.days}`:n.maxDays<n.minDays?'Not under the minimum':undefined};
  const dirty=n.ratio!==start.ratio||n.minDays!==start.minDays||n.maxDays!==start.maxDays,invalid=Object.values(errors).some(Boolean);
  const submit=()=>{if(invalid)return;void save.run(async()=>{await api('/admin/library/settings','PUT',{expectedRevision:settings.revision,seeding:n});toast.success('Saved');});};
  const field=(key:keyof typeof draft,label:string,step:number,min:number)=><label>{label}
    <input type="number" step={step} min={min} aria-invalid={!!errors[key]||undefined} value={draft[key]} onChange={e=>setDraft(d=>({...d,[key]:e.target.value}))}/>
    {errors[key]?<small className="danger-text">{errors[key]}</small>:<small>Minimum {min}</small>}</label>;
  return <form onSubmit={e=>{e.preventDefault();submit();}}><Card title="Seeding">
    <div className="form-columns manage-seeding">
      {field('ratio','Ratio',0.1,floor.ratio)}
      {field('minDays','Min days',1,floor.days)}
      {field('maxDays','Max days',1,floor.days)}
    </div>
    <SaveBar dirty={dirty} busy={save.busy||invalid} error={save.error} onReload={changed}
      onCancel={()=>{setDraft({ratio:String(start.ratio),minDays:String(start.minDays),maxDays:String(start.maxDays)});save.clear();}}/>
  </Card></form>;
}

const SAMPLE='127.Hours.2010.1080p.WEB-DL.DDP5.1.H.264-C76';
function Naming({settings}:{settings:LibrarySettingsView}) {
  const [release,setRelease]=useState(SAMPLE),[tmdb,setTmdb]=useState('44115'),[preview,setPreview]=useState<NamingPreview>(),[error,setError]=useState('');
  const input=useDebounced(`${release}\n${tmdb}`,250);
  useEffect(()=>{
    const [name='',id='']=input.split('\n');
    if(!name.trim()){setPreview(undefined);setError('');return;}
    const controller=new AbortController();
    api<NamingPreview>('/admin/library/naming/preview','POST',{release:name.trim(),...(Number(id)>0?{tmdbId:Number(id)}:{})},controller.signal)
      .then(p=>{setPreview(p);setError('');},e=>{if(!controller.signal.aborted){setPreview(undefined);setError((e as Error).message);}});
    return()=>controller.abort();
  },[input,settings.revision]);
  return <Card title="Naming">
    <div className="downloads-formats">
      <span><small>Movie folder</small><code>{settings.naming.movieFolder}</code></span>
      <span><small>Movie file</small><code>{settings.naming.movieFile}</code></span>
    </div>
    <div className="form-columns downloads-sample">
      <label>Sample release<input spellCheck={false} value={release} onChange={e=>setRelease(e.target.value)}/></label>
      <label>TMDB id<input type="number" min={1} value={tmdb} onChange={e=>setTmdb(e.target.value)}/></label>
    </div>
    {error?<p className="danger-text small">{error}</p>:preview&&<div className="downloads-preview" aria-live="polite">
      <span><small>Folder</small><code>{preview.folder}</code></span>
      <span><small>File</small><code>{preview.file}</code></span>
      <span><small>Path</small><code>{preview.path}</code></span>
    </div>}
  </Card>;
}
