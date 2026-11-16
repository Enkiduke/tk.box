import {useEffect,useState} from 'react';
import type {LibrarySettingsView,NamingPreview} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {useApi,useDebounced} from './hooks.js';
import {SectionHead} from './settings-ui.js';
import {toast} from './toasts.js';
import {Field,FieldError,Loaded,Panel,SaveBar,changed,useSave} from './manage-ui.js';

// Admin › Downloads › Settings (docs/PHASE-3.5.md, docs/UI.md): where movies go, when seeding torrents go, and
// how files are named (shown, not edited) with a live preview.

export function LibrarySettingsPage() {
  const view=useApi<LibrarySettingsView>('/admin/library/settings');
  return <><SectionHead title="Download settings"/>
    <Loaded view={view}>{s=><><Storage key={`s${s.revision}`} settings={s}/><Naming settings={s}/></>}</Loaded>
  </>;
}

type Draft={root:string;ratio:string;minDays:string;maxDays:string};
const draftOf=(s:LibrarySettingsView):Draft=>({root:s.roots.movie,ratio:String(s.seeding.ratio),minDays:String(s.seeding.minDays),maxDays:String(s.seeding.maxDays)});

// The movie root and the seeding numbers, saved together. The server checks them against IPTorrents' floor too.
function Storage({settings}:{settings:LibrarySettingsView}) {
  const start=draftOf(settings),floor=settings.seedingFloor;
  const [draft,setDraft]=useState(start),save=useSave(changed);
  const set=(patch:Partial<Draft>)=>setDraft(d=>({...d,...patch}));
  const n={ratio:Number(draft.ratio),minDays:Number(draft.minDays),maxDays:Number(draft.maxDays)};
  const errors={root:!draft.root.trim().startsWith('/')?'A full path, starting with /':undefined,ratio:!(n.ratio>=floor.ratio)?`At least ${floor.ratio}`:undefined,
    minDays:!(n.minDays>=floor.days)?`At least ${floor.days} days`:undefined,maxDays:!(n.maxDays>=floor.days)?`At least ${floor.days} days`:n.maxDays<n.minDays?'Not under the minimum':undefined};
  const dirty=JSON.stringify(draft)!==JSON.stringify(start),invalid=Object.values(errors).some(Boolean);
  const submit=()=>{if(invalid)return;void save.run(async()=>{
    const seedingChanged=n.ratio!==settings.seeding.ratio||n.minDays!==settings.seeding.minDays||n.maxDays!==settings.seeding.maxDays;
    await api('/admin/library/settings','PUT',{expectedRevision:settings.revision,...(draft.root.trim()!==settings.roots.movie?{roots:{movie:draft.root.trim()}}:{}),...(seedingChanged?{seeding:n}:{})});
    toast.success('Saved');});};
  const num=(key:'ratio'|'minDays'|'maxDays',step:number,unit:string)=><><div className="ui-range">
    <input type="number" step={step} aria-invalid={!!errors[key]} value={draft[key]} onChange={e=>set({[key]:e.target.value})}/>{unit}</div><FieldError>{errors[key]}</FieldError></>;
  return <form onSubmit={e=>{e.preventDefault();submit();}}>
    <Panel flush title="Movies" footer={<SaveBar dirty={dirty} busy={save.busy} error={save.error} invalid={invalid} onCancel={()=>{setDraft(start);save.clear();}} onReload={changed}/>}>
      <Field label="Root folder" hint="Where movie folders are made"><input className="wide ui-mono" spellCheck={false} aria-invalid={!!errors.root} value={draft.root} onChange={e=>set({root:e.target.value})}/><FieldError>{errors.root}</FieldError></Field>
      <Field label="Seeding ratio" hint={`At least ${floor.ratio}`}>{num('ratio',0.1,'×')}</Field>
      <Field label="Minimum days" hint={`At least ${floor.days} (IPTorrents)`}>{num('minDays',1,'days')}</Field>
      <Field label="Maximum days" hint="Removed then, whatever the ratio">{num('maxDays',1,'days')}</Field>
    </Panel>
  </form>;
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
  return <Panel flush title="Naming">
    <Field label="Folder format"><code className="ui-code">{settings.naming.movieFolder}</code></Field>
    <Field label="File format"><code className="ui-code">{settings.naming.movieFile}</code></Field>
    <Field label="Try a release" hint="As an import would name it">
      <input className="wide ui-mono" spellCheck={false} aria-label="Release name" value={release} onChange={e=>setRelease(e.target.value)}/>
      <input type="number" min={1} aria-label="TMDB id" placeholder="TMDB id" value={tmdb} onChange={e=>setTmdb(e.target.value)} style={{minWidth:0,width:120}}/>
    </Field>
    <Field label="Result">{error?<span className="danger-text">{error}</span>:preview?<div className="ui-preview" aria-live="polite">
      <code className="ui-code" title="Folder">{preview.folder}</code><code className="ui-code" title="File">{preview.file}</code><small>{preview.path}</small></div>:<span className="ui-dash">—</span>}</Field>
  </Panel>;
}
