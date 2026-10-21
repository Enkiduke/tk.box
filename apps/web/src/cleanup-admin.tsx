import {useEffect,useState} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,SectionHead,Switch,remember,remembered,useMutation} from './settings-ui.js';
import {ScheduleRow,type ScheduleState} from './artwork-collections.js';
import {JobHistory,type Job} from './artwork-jobs.js';
import {CleanupStatus} from './cleanup-status.js';

// Admin › Server › Clean Up: deletes requested titles once everyone who asked for them has had their time with them,
// by the purge script (apps/cleanup/purge_requests.py), which tk.box runs with these settings. Seerr, Tautulli, Radarr
// and Sonarr are connected in Admin › Connections.
type Library={key:string;title:string;type:string};
type Engine={ready:boolean;version?:string;error?:string};
type Settings={movieLibraries:string[];tvLibraries:string[];dryRun:boolean;deleteFromRadarr:boolean;deleteFromSonarr:boolean;deleteFromSeerr:boolean;
  daysAfterWatched:number;daysAfterUnwatched:number;daysAfterAnyWatchExempt:number;daysAfterExemptWatch:number;exemptUserIds:number[];exemptArrTags:string[];exemptIfInCollection:boolean;
  seasons:{enabled:boolean;protectLatest:boolean;protectSpecials:boolean};leavingSoon:{enabled:boolean;name:string;days:number;poster:boolean};schedule:{enabled:boolean;time:string}};
type Overview={settings:Settings&{revision:number};libraries:Library[];engine:Engine;missing:string[];connected:Record<'seerr'|'tautulli'|'radarr'|'sonarr',boolean>;schedule:ScheduleState;busy:boolean};
const tabs=[['runs','Runs'],['status','Status'],['schedules','Schedules'],['settings','Settings']] as const;
const connections=<a href="#admin?section=connections">Admin › Connections</a>;

export function CleanupAdmin() {
  const overview=useApi<Overview>('/admin/cleanup'),[tab,setTabState]=useState(()=>remembered('cleanupTab','runs'));
  const setTab=(t:string)=>{setTabState(t);remember('cleanupTab',t);};
  const head=<SectionHead title="Clean Up"/>;
  if(overview.loading&&!overview.data)return <>{head}<Loading/></>;
  if(overview.error&&!overview.data)return <>{head}<ErrorNotice message={overview.error.message} retry={overview.reload}/></>;
  const data=overview.data!;
  return <>{head}
    <EngineStatus engine={data.engine} recheck={()=>void api<Overview>('/admin/cleanup?recheck=1').then(overview.reload,overview.reload)}/>
    {data.missing.length>0&&<div className="notice"><span>Before clean up can run:<ul>{data.missing.map(m=><li key={m}>{m}</li>)}</ul></span></div>}
    <div className="subtabs" role="tablist" aria-label="Clean Up">{tabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel">{tab==='settings'?<CleanupSettings data={data} changed={overview.reload}/>:tab==='status'?<CleanupStatus/>:tab==='schedules'?<CleanupSchedules data={data} changed={overview.reload}/>:<Runs data={data} changed={overview.reload}/>}</div>
  </>;
}
function EngineStatus({engine,recheck}:{engine:Engine;recheck:()=>void}) {
  if(engine.ready)return <p className="muted small" role="status"><span className="status-dot ok" aria-hidden="true"/> Clean up script ready · Python {engine.version}</p>;
  return <Card title="Set up the clean up script" description="Uses the same Python as Artwork." actions={<button onClick={recheck}><Icon name="restart" size={16}/>Check again</button>}>
    <div className="notice error"><span>{engine.error}</span></div>
    <ol className="artwork-steps">
      <li>Set up Artwork’s Python first (Admin › Artwork shows the steps), or any Python 3.10 or later.</li>
      <li>From the tk.box folder, install the script’s packages into it: <code>artwork-venv/bin/pip install -r apps/cleanup/requirements.txt</code></li>
      <li>Make sure <code>PYTHON_PATH</code> points at that Python, and restart tk.box if you changed it.</li>
    </ol>
  </Card>;
}

function Runs({data,changed}:{data:Overview;changed:()=>void}) {
  const [selected,setSelected]=useState<number>(),[confirm,setConfirm]=useState(false),mutation=useMutation(()=>{invalidate('/admin/cleanup/jobs');changed();});
  const start=(preview:boolean)=>void mutation.run(async()=>{const job=await api<Job>('/admin/cleanup/jobs','POST',{preview});setSelected(job.id);});
  const off=!data.engine.ready||data.missing.length>0||mutation.busy,real=!data.settings.dryRun;
  const also=([['Radarr',data.settings.deleteFromRadarr],['Sonarr',data.settings.deleteFromSonarr],['Seerr',data.settings.deleteFromSeerr]] as const).filter(([,on])=>on).map(([name])=>name);
  return <div className="form-stack">
    <div className="artwork-run">
      <Card title="Preview" description="Lists what is due. Changes nothing." actions={<button className="primary" disabled={off} onClick={()=>start(true)}>Preview</button>}/>
      <Card title="Clean up now" description={real?'Deletes everything that is due.':'Preview only is on, so this only reports.'}
        actions={<button disabled={off} onClick={()=>real?setConfirm(true):start(false)}>Run</button>}/>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <JobHistory script="cleanup" selected={selected} select={setSelected}/>
    {confirm&&<Modal title="Delete what is due?" onClose={()=>setConfirm(false)}>
      <p>Every title whose time is up is deleted from Plex with its files{also.length?`, and from ${also.length>1?`${also.slice(0,-1).join(', ')} and ${also.at(-1)}`:also[0]}`:''}. This can’t be undone. Run a preview first to see the list.</p>
      <div className="button-row"><button className="primary" onClick={()=>{setConfirm(false);start(false);}}>Delete</button><button onClick={()=>setConfirm(false)}>Cancel</button></div>
    </Modal>}
  </div>;
}

// Its own tab, saved with the rest of the settings as they were last saved.
function CleanupSchedules({data,changed}:{data:Overview;changed:()=>void}) {
  const [draft,setDraft]=useState(data.settings.schedule),[done,setDone]=useState(false),mutation=useMutation(changed);
  useEffect(()=>setDraft(data.settings.schedule),[data.settings.revision]);
  const save=()=>void mutation.run(async()=>{const {revision,...saved}=data.settings;await api('/admin/cleanup/settings','PUT',{expectedRevision:revision,...saved,schedule:draft});setDone(true);});
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Schedules" description="Server local time. Needs the Plex token.">
      <div className="artwork-schedules"><ScheduleRow label="Clean up" hint="A preview while Preview only is on." state={data.schedule} value={draft} set={value=>{setDone(false);setDraft(value);}}/></div>
    </Card>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row sticky-actions"><button className="primary" disabled={mutation.busy}>Save schedules</button>{done&&<span className="success" role="status">Saved.</span>}</div>
  </form>;
}

const list=(text:string)=>[...new Set(text.split(',').map(t=>t.trim()).filter(Boolean))];
function CleanupSettings({data,changed}:{data:Overview;changed:()=>void}) {
  const {revision:_,...saved}=data.settings,[draft,setDraft]=useState<Settings>(saved),[ids,setIds]=useState(saved.exemptUserIds.join(', ')),[tags,setTags]=useState(saved.exemptArrTags.join(', '));
  const [done,setDone]=useState(false),mutation=useMutation(changed);
  useEffect(()=>{const {revision:_,...value}=data.settings;setDraft(value);setIds(value.exemptUserIds.join(', '));setTags(value.exemptArrTags.join(', '));},[data.settings.revision]);
  const set=(patch:Partial<Settings>)=>{setDone(false);setDraft(d=>({...d,...patch}));};
  const movies=data.libraries.filter(l=>l.type==='movie'),shows=data.libraries.filter(l=>l.type==='show'),{connected}=data;
  const toggle=(field:'movieLibraries'|'tvLibraries',key:string,on:boolean)=>set({[field]:on?[...draft[field],key]:draft[field].filter(k=>k!==key)});
  const library=(field:'movieLibraries'|'tvLibraries')=>(l:Library)=><label key={l.key} className="checkbox-label"><input type="checkbox" checked={draft[field].includes(l.key)} onChange={e=>toggle(field,l.key,e.target.checked)}/>{l.title}</label>;
  const dayField=(field:'daysAfterWatched'|'daysAfterUnwatched'|'daysAfterAnyWatchExempt'|'daysAfterExemptWatch',label:string,hint:string)=><label>{label}
    <span className="setting-line"><input type="number" min="0" max="3650" required value={draft[field]} onChange={e=>set({[field]:Number(e.target.value)})}/>days</span><small>{hint}</small></label>;
  const needs=(on:boolean,name:string)=>on?undefined:<>Connect {name} in {connections} first.</>;
  const save=()=>void mutation.run(async()=>{
    const userIds=list(ids.replace(/\s+/g,',')).map(Number);
    if(userIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('Exempt users must be Plex user IDs (whole numbers), separated by commas.');
    await api('/admin/cleanup/settings','PUT',{expectedRevision:data.settings.revision,...draft,exemptUserIds:userIds,exemptArrTags:list(tags)});setDone(true);
  });
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Libraries">
      {data.libraries.length?<div className="form-columns">
        <fieldset className="form-stack"><legend>Movies</legend>{movies.length?movies.map(library('movieLibraries')):<small className="muted">No movie libraries.</small>}</fieldset>
        <fieldset className="form-stack"><legend>TV</legend>{shows.length?shows.map(library('tvLibraries')):<small className="muted">No TV libraries.</small>}</fieldset>
      </div>:<Empty title="No libraries">Your Plex account shows no movie or TV libraries.</Empty>}
    </Card>
    <Card title="How long titles stay" description="Shared titles stay until the last request is due.">
      <div className="form-columns">
        {dayField('daysAfterWatched','Watched by the requester','After anyone last watched it.')}
        {dayField('daysAfterUnwatched','Not watched by the requester','After it was added.')}
        {dayField('daysAfterExemptWatch','Requested by an exempt user, who watched it','After an exempt user last watched it.')}
        {dayField('daysAfterAnyWatchExempt','Requested by an exempt user, who hasn’t','After anyone last watched it, or after it was added.')}
      </div>
    </Card>
    <Card title="Protected">
      <div className="form-columns">
        <label>Exempt users<input value={ids} placeholder="e.g. 1234567, 7654321" onChange={e=>{setIds(e.target.value);setDone(false);}}/><small>Plex user IDs, comma-separated (Tautulli › Users)</small></label>
        <label>Radarr and Sonarr tags<input value={tags} placeholder="e.g. keep, favorite" onChange={e=>{setTags(e.target.value);setDone(false);}}/><small>Never deleted</small></label>
      </div>
      <Switch label="Keep titles in a collection" description="Any Plex collection except Leaving Soon." checked={draft.exemptIfInCollection} onChange={v=>set({exemptIfInCollection:v})}/>
    </Card>
    <Card title="TV seasons">
      <Switch label="Season by season" description="Needs Delete from Sonarr." checked={draft.seasons.enabled} onChange={v=>set({seasons:{...draft.seasons,enabled:v}})}/>
      <Switch label="Keep the latest season" checked={draft.seasons.protectLatest} disabled={!draft.seasons.enabled} onChange={v=>set({seasons:{...draft.seasons,protectLatest:v}})}/>
      <Switch label="Keep specials" description="Season 0." checked={draft.seasons.protectSpecials} disabled={!draft.seasons.enabled} onChange={v=>set({seasons:{...draft.seasons,protectSpecials:v}})}/>
    </Card>
    <Card title="Deleting" description="Plex must allow media deletion.">
      <Switch label="Preview only" description="Runs only report what would be deleted." checked={draft.dryRun} onChange={v=>set({dryRun:v})}/>
      <Switch label="Delete from Radarr" description={needs(connected.radarr,'Radarr')??'Removes the movie and its files.'} checked={draft.deleteFromRadarr} onChange={v=>set({deleteFromRadarr:v})}/>
      <Switch label="Delete from Sonarr" description={needs(connected.sonarr,'Sonarr')??'Removes the show or season files.'} checked={draft.deleteFromSonarr} onChange={v=>set({deleteFromSonarr:v})}/>
      <Switch label="Remove from Seerr" description="Clears the request." checked={draft.deleteFromSeerr} onChange={v=>set({deleteFromSeerr:v})}/>
    </Card>
    <Card title="Leaving Soon collection" description="Titles due soon, at the top of each library.">
      <Switch label="Keep a Leaving Soon collection" checked={draft.leavingSoon.enabled} onChange={v=>set({leavingSoon:{...draft.leavingSoon,enabled:v}})}/>
      <div className="form-columns">
        <label>Name<input required maxLength={60} value={draft.leavingSoon.name} disabled={!draft.leavingSoon.enabled} onChange={e=>set({leavingSoon:{...draft.leavingSoon,name:e.target.value}})}/></label>
        <label>Due within<span className="setting-line"><input type="number" min="1" max="365" required value={draft.leavingSoon.days} disabled={!draft.leavingSoon.enabled} onChange={e=>set({leavingSoon:{...draft.leavingSoon,days:Number(e.target.value)}})}/>days</span></label>
      </div>
      <Switch label="Use the Leaving Soon poster" checked={draft.leavingSoon.poster} disabled={!draft.leavingSoon.enabled} onChange={v=>set({leavingSoon:{...draft.leavingSoon,poster:v}})}/>
    </Card>
        {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row sticky-actions"><button className="primary" disabled={mutation.busy}>Save clean up settings</button>{done&&<span className="success" role="status">Saved.</span>}</div>
  </form>;
}
