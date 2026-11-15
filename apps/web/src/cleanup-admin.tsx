import {useEffect,useId,useRef,useState} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,SectionHead,Switch,remember,remembered,useMutation} from './settings-ui.js';
import {ScheduleRow,type ScheduleState} from './schedule-picker.js';
import type {CleanupUsersView} from '../../../packages/contracts/src/index.js';
import type {Scheduled} from '../../../packages/contracts/src/schedule.js';
import {openConsole,type Job} from './admin-console.js';
import {CleanupStatus} from './cleanup-status.js';
import {toast} from './toasts.js';

// Admin › Server › Clean Up: deletes requested titles once everyone who asked for them has had their time with them,
// by the purge script (apps/cleanup/purge_requests.py), which tk.box runs with these settings. Radarr and
// Sonarr are connected in Admin › Connections.
type Library={key:string;title:string;type:string};
type Engine={ready:boolean;version?:string;error?:string};
type Settings={movieLibraries:string[];tvLibraries:string[];dryRun:boolean;deleteFromRadarr:boolean;deleteFromSonarr:boolean;
  daysAfterWatched:number;daysAfterUnwatched:number;daysAfterAnyWatchExempt:number;daysAfterExemptWatch:number;exemptUserIds:number[];exemptArrTags:string[];exemptIfInCollection:boolean;collectionKinds:Record<CollectionKind,boolean>;
  seasons:{enabled:boolean;protectLatest:boolean;protectSpecials:boolean};leavingSoon:{enabled:boolean;name:string;days:number;poster:boolean};schedule:Scheduled};
type Overview={settings:Settings&{revision:number};libraries:Library[];engine:Engine;missing:string[];connected:Record<'radarr'|'sonarr',boolean>;schedule:ScheduleState;busy:boolean};
const tabs=[['status','Status'],['schedules','Schedules'],['settings','Settings']] as const;
const connections=<a href="#admin?section=connections&category=downloads">Admin › Connections</a>;

export function CleanupAdmin() {
  const overview=useApi<Overview>('/admin/cleanup'),[tab,setTabState]=useState(()=>(t=>tabs.some(([id])=>id===t)?t:'status')(remembered('cleanupTab','status')));
  const setTab=(t:string)=>{setTabState(t);remember('cleanupTab',t);};
  const head=<SectionHead title="Clean Up"/>;
  if(overview.loading&&!overview.data)return <>{head}<Loading/></>;
  if(overview.error&&!overview.data)return <>{head}<ErrorNotice message={overview.error.message} retry={overview.reload}/></>;
  const data=overview.data!;
  return <><RunActions data={data} changed={overview.reload}/>
    <EngineStatus engine={data.engine} recheck={()=>void api<Overview>('/admin/cleanup?recheck=1').then(overview.reload,overview.reload)}/>
    {data.missing.length>0&&<div className="notice"><span>Before clean up can run:<ul>{data.missing.map(m=><li key={m}>{m}</li>)}</ul></span></div>}
    <div className="subtabs" role="tablist" aria-label="Clean Up">{tabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel">{tab==='settings'?<CleanupSettings data={data} changed={overview.reload}/>:tab==='schedules'?<CleanupSchedules data={data} changed={overview.reload}/>:<CleanupStatus rules={data.settings} busy={data.busy}/>}</div>
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

// The section's header: a preview and a real run, whose output opens in the Console.
function RunActions({data,changed}:{data:Overview;changed:()=>void}) {
  const [confirm,setConfirm]=useState(false),mutation=useMutation(()=>{invalidate('/admin/cleanup/jobs');changed();});
  const start=(preview:boolean)=>void mutation.run(async()=>openConsole(await api<Job>('/admin/cleanup/jobs','POST',{preview})));
  const off=!data.engine.ready||data.missing.length>0||mutation.busy,real=!data.settings.dryRun;
  const also=([['Radarr',data.settings.deleteFromRadarr],['Sonarr',data.settings.deleteFromSonarr]] as const).filter(([,on])=>on).map(([name])=>name);
  return <>
    <SectionHead title="Clean Up">
      <button className="primary" disabled={off} title="Lists what is due. Changes nothing." onClick={()=>start(true)}>Preview</button>
      <button disabled={off||!real} title={real?'Deletes everything that is due.':'Preview only is on in Settings, so runs only report.'} onClick={()=>setConfirm(true)}><Icon name="trash" size={16}/>Clean up now</button>
    </SectionHead>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    {confirm&&<Modal title="Delete what is due?" onClose={()=>setConfirm(false)}>
      <p>Every title whose time is up is deleted from Plex with its files{also.length?`, and from ${also.length>1?`${also.slice(0,-1).join(', ')} and ${also.at(-1)}`:also[0]}`:''}. This can’t be undone. Run a preview first to see the list.</p>
      <div className="button-row"><button className="primary" onClick={()=>{setConfirm(false);start(false);}}>Delete</button><button onClick={()=>setConfirm(false)}>Cancel</button></div>
    </Modal>}
  </>;
}

// Its own tab, saved with the rest of the settings as they were last saved.
function CleanupSchedules({data,changed}:{data:Overview;changed:()=>void}) {
  const [draft,setDraft]=useState(data.settings.schedule),mutation=useMutation(changed);
  useEffect(()=>setDraft(data.settings.schedule),[data.settings.revision]);
  const save=()=>void mutation.run(async()=>{const {revision,...saved}=data.settings;await api('/admin/cleanup/settings','PUT',{expectedRevision:revision,...saved,schedule:draft});toast.success('Schedules saved');});
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Schedules" description="Server local time. Needs the Plex token.">
      <div className="artwork-schedules"><ScheduleRow label="Clean up" hint="A preview while Preview only is on." state={data.schedule} min={60} value={draft} set={value=>{setDraft(value);}}/></div>
    </Card>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row sticky-actions"><button className="primary" disabled={mutation.busy}>Save schedules</button></div>
  </form>;
}

const list=(text:string)=>[...new Set(text.split(',').map(t=>t.trim()).filter(Boolean))];
type CollectionKind='franchise'|'streaming'|'custom'|'seasonal'|'other';
const collectionKinds:[CollectionKind,string][]=[['franchise','Franchise'],['streaming','Streaming'],['custom','Custom'],['seasonal','Seasonal'],['other','Other Plex collections']];
type RetentionField='daysAfterWatched'|'daysAfterUnwatched'|'daysAfterAnyWatchExempt'|'daysAfterExemptWatch';
function RetentionRow({audience,title,anchor,value,onChange}:{audience:string;title:string;anchor:string;value:number;onChange:(days:number)=>void}) {
  const id=useId();
  return <div className="cleanup-rule">
    <div className="cleanup-rule-copy"><label htmlFor={id}><span className="sr-only">{audience}: </span>{title}</label><p id={`${id}-anchor`}>{anchor}</p></div>
    <div className="cleanup-duration"><span aria-hidden="true">Keep for</span><div><input id={id} type="number" min="0" max="3650" step="1" required value={value} aria-describedby={`${id}-anchor ${id}-unit`} onChange={e=>onChange(Number(e.target.value))}/><span id={`${id}-unit`}>days</span></div></div>
  </div>;
}
function RetentionUsers({selected,onChange}:{selected:number[];onChange:(ids:number[])=>void}) {
  const directory=useApi<CleanupUsersView>('/admin/cleanup/users');
  const [query,setQuery]=useState(''),popup=useRef<HTMLDetailsElement>(null),id=useId();
  useEffect(()=>{
    const outside=(event:MouseEvent)=>{if(popup.current?.open&&!popup.current.contains(event.target as Node))popup.current.open=false;};
    document.addEventListener('click',outside);
    return()=>document.removeEventListener('click',outside);
  },[]);
  const users=[...(directory.data?.users??[])].sort((a,b)=>a.name.localeCompare(b.name));
  const known=new Map(users.map(user=>[user.accountId,user.name]));
  const unavailable=[...new Set(selected)].filter(accountId=>!known.has(accountId));
  const options:CleanupUsersView['users']=[...users,...unavailable.map(accountId=>({accountId,name:`Plex user ${accountId}`}))];
  const search=query.trim().toLowerCase();
  const visible=options.filter(user=>!search||user.name.toLowerCase().includes(search)||user.username?.toLowerCase().includes(search));
  return <div className="cleanup-users">
    <span id={`${id}-label`}>Plex users</span>
    <details ref={popup} className="checklist" onToggle={e=>{if(!e.currentTarget.open)setQuery('');}} onKeyDown={e=>{
      if(e.key==='Escape'&&e.currentTarget.open){e.stopPropagation();e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}
    }}>
      <summary aria-labelledby={`${id}-label ${id}-value`} aria-describedby={`${id}-hint`}>
        <span id={`${id}-value`}>{selected.length?selected.map(accountId=>known.get(accountId)??`Plex user ${accountId}`).join(', '):'Select Plex users'}</span>
        <Icon name="next" size={14}/>
      </summary>
      <div className="checklist-menu" role="group" aria-labelledby={`${id}-label`}>
        {options.length>0&&<input type="search" placeholder="Find a Plex user" aria-label="Find a Plex user" value={query}
          onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}}/>}
        {directory.loading&&<p className="small muted" role="status">Loading Plex users…</p>}
        {directory.error&&<p className="small" role="status">{directory.error.message}</p>}
        {!directory.error&&directory.data?.directoryIncomplete&&<p className="small muted" role="status">Plex returned a partial user list.</p>}
        {(directory.error||directory.data?.directoryIncomplete)&&<button type="button" className="link-button small" onClick={directory.reload} disabled={directory.loading}>Retry user list</button>}
        {!directory.loading&&!directory.error&&!visible.length&&<p className="small muted" role="status">{search?'No matching Plex users.':'No Plex users available.'}</p>}
        {visible.map(({accountId,name,username})=><div key={accountId} className="checklist-row"><label>
          <input type="checkbox" checked={selected.includes(accountId)} onChange={e=>onChange(e.target.checked?[...selected,accountId]:selected.filter(value=>value!==accountId))}/>
          <span className="grow">{name}{username&&username!==name&&<small> ({username})</small>}</span>
          {!known.has(accountId)&&!directory.loading&&<small>Saved selection</small>}
        </label></div>)}
      </div>
    </details>
    <small id={`${id}-hint`}>Choose the users whose requests get longer retention. Leave empty to use standard retention for everyone.</small>
  </div>;
}
function CleanupSettings({data,changed}:{data:Overview;changed:()=>void}) {
  const {revision:_,...saved}=data.settings,[draft,setDraft]=useState<Settings>(saved),[tags,setTags]=useState(saved.exemptArrTags.join(', '));
  const mutation=useMutation(changed);
  useEffect(()=>{const {revision:_,...value}=data.settings;setDraft(value);setTags(value.exemptArrTags.join(', '));},[data.settings.revision]);
  const set=(patch:Partial<Settings>)=>{setDraft(d=>({...d,...patch}));};
  const movies=data.libraries.filter(l=>l.type==='movie'),shows=data.libraries.filter(l=>l.type==='show'),{connected}=data;
  const toggle=(field:'movieLibraries'|'tvLibraries',key:string,on:boolean)=>set({[field]:on?[...draft[field],key]:draft[field].filter(k=>k!==key)});
  const library=(field:'movieLibraries'|'tvLibraries')=>(l:Library)=><label key={l.key} className="checkbox-label"><input type="checkbox" checked={draft[field].includes(l.key)} onChange={e=>toggle(field,l.key,e.target.checked)}/>{l.title}</label>;
  const rule=(field:RetentionField,audience:string,title:string,anchor:string)=><RetentionRow audience={audience} title={title} anchor={anchor} value={draft[field]} onChange={days=>set({[field]:days})}/>;
  const needs=(on:boolean,name:string)=>on?undefined:<>Connect {name} in {connections} first.</>;
  const save=()=>void mutation.run(async()=>{
    await api('/admin/cleanup/settings','PUT',{expectedRevision:data.settings.revision,...draft,exemptArrTags:list(tags)});toast.success('Clean Up settings saved');
  });
  return <form className="form-stack cleanup-settings" onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Run mode" className={draft.dryRun?'':'danger-zone'}>
      <Switch label="Preview only" description="When on, manual and scheduled runs only report what would happen. Plex, files and collections stay unchanged." checked={draft.dryRun} onChange={v=>set({dryRun:v})}/>
      <p className={`cleanup-note${draft.dryRun?'':' cleanup-delete-note'}`}>{draft.dryRun?'No files will be deleted with this setting.':'Clean up now and scheduled runs will delete due titles and their files. Preview always changes nothing.'} Changes take effect after saving.</p>
    </Card>
    <Card title="Libraries to clean up" description="Only available requests in these Plex libraries are checked.">
      {data.libraries.length?<div className="form-columns">
        <fieldset className="form-stack"><legend>Movies</legend>{movies.length?movies.map(library('movieLibraries')):<small className="muted">No movie libraries.</small>}</fieldset>
        <fieldset className="form-stack"><legend>TV</legend>{shows.length?shows.map(library('tvLibraries')):<small className="muted">No TV libraries.</small>}</fieldset>
      </div>:<Empty title="No libraries">Your Plex account shows no movie or TV libraries.</Empty>}
    </Card>
    <Card title="Retention rules" description="Each request gets a deadline. A shared title stays until every requester’s deadline has passed.">
      <div className="cleanup-rule-group">
        <div className="cleanup-group-head"><h4>Standard retention</h4><p>Applies to requests from everyone except the users listed below.</p></div>
        {rule('daysAfterWatched','Standard retention','Requester has watched','Count from the most recent watch by anyone. Each new watch restarts this timer.')}
        {rule('daysAfterUnwatched','Standard retention','Requester has not watched','Count from when the title was added. If someone else watches it, it also stays the "Requester watched" days after their last watch, whichever is later.')}
      </div>
      <div className="cleanup-rule-group">
        <div className="cleanup-group-head"><h4>Longer retention for selected users <span className="badge">Optional</span></h4><p>Replaces the standard rules for their requests. These titles can still be deleted when their time is up.</p></div>
        <RetentionUsers selected={draft.exemptUserIds} onChange={exemptUserIds=>set({exemptUserIds})}/>
        {rule('daysAfterExemptWatch','Selected-user retention','Any selected user has watched','Count from the most recent watch by any user listed above. Watches by other users do not restart this timer.')}
        {rule('daysAfterAnyWatchExempt','Selected-user retention','No selected user has watched','Count from the most recent watch by anyone, or from when the title was added if nobody has watched.')}
      </div>
      <details className="cleanup-help"><summary>What counts as watched?</summary><p>A play tk.box saw counts, in its own player or Plex’s apps, as does the saved watch history. A partial play counts. A show or season does not need to be finished. Set a timer to 0 days to make it due as soon as its condition applies. Due titles are removed on the next cleanup run that deletes files.</p></details>
    </Card>
    <Card title="Always keep" description="These protections override the retention rules for a title and all its seasons.">
      <label>Protected Radarr and Sonarr tags<input value={tags} placeholder="e.g. keep, favorite" onChange={e=>{setTags(e.target.value);}}/><small>Any matching tag prevents deletion. Separate tags with commas. Leave blank for no tag protection.</small></label>
      <Switch label="Keep titles in Plex collections" description={`Never “${draft.leavingSoon.name}”, your Leaving Soon collection.`} checked={draft.exemptIfInCollection} onChange={v=>set({exemptIfInCollection:v})}/>
      {draft.exemptIfInCollection&&<fieldset className="form-stack"><legend>Collections that protect</legend>
        {collectionKinds.map(([kind,label])=><label key={kind} className="checkbox-label"><input type="checkbox" checked={draft.collectionKinds[kind]} onChange={e=>set({collectionKinds:{...draft.collectionKinds,[kind]:e.target.checked}})}/>{label}</label>)}
      </fieldset>}
    </Card>
    <Card title="TV seasons" description="Use the same retention timers for individual seasons or for the whole show.">
      <Switch label="Clean up individual seasons" description="Requires Sonarr and Delete from Sonarr below. When off, the whole show is evaluated together." checked={draft.seasons.enabled} onChange={v=>set({seasons:{...draft.seasons,enabled:v}})}/>
      {draft.seasons.enabled&&<div className="cleanup-season-options">
        <Switch label="Keep the latest season" description="Protects the highest numbered season currently in Plex." checked={draft.seasons.protectLatest} onChange={v=>set({seasons:{...draft.seasons,protectLatest:v}})}/>
        <Switch label="Keep specials" description="Protects season 0 during individual-season cleanup." checked={draft.seasons.protectSpecials} onChange={v=>set({seasons:{...draft.seasons,protectSpecials:v}})}/>
        <details className="cleanup-help"><summary>Season timers and single-season shows</summary><p>Season watches are checked separately. For timers based on when content was added, the newest episode’s added date is used.</p><p>A show with only season 1, with or without specials, is evaluated as a whole show. The two season protections above do not apply to that whole-show deletion. A lone later season keeps its season protections.</p></details>
      </div>}
    </Card>
    <Card title="Also remove from connected apps" description="A run that deletes always removes due content from Plex with its files. These options control the other apps. Plex must allow media deletion.">
      <Switch label="Delete from Radarr" description={needs(connected.radarr,'Radarr')??'Removes the movie and its files.'} checked={draft.deleteFromRadarr} onChange={v=>set({deleteFromRadarr:v})}/>
      <Switch label="Delete from Sonarr" description={needs(connected.sonarr,'Sonarr')??'Removes whole shows, or unmonitors episodes and removes their files when cleaning up individual seasons.'} checked={draft.deleteFromSonarr} onChange={v=>set({deleteFromSonarr:v})}/>
    </Card>
    <Card title="Leaving Soon collection" description="Show whole titles approaching their deadline in a Plex collection. This does not add extra time before deletion.">
      <Switch label="Maintain a Leaving Soon collection" description="Updated only during runs with Preview only off. Individual seasons appear in Status, but are not added to the collection." checked={draft.leavingSoon.enabled} onChange={v=>set({leavingSoon:{...draft.leavingSoon,enabled:v}})}/>
      {draft.leavingSoon.enabled&&<>
      <div className="form-columns">
        <label>Collection name<input required maxLength={60} value={draft.leavingSoon.name} onChange={e=>set({leavingSoon:{...draft.leavingSoon,name:e.target.value}})}/></label>
        <label>Add titles due within<span className="cleanup-days-input"><input type="number" min="1" max="365" step="1" required value={draft.leavingSoon.days} onChange={e=>set({leavingSoon:{...draft.leavingSoon,days:Number(e.target.value)}})}/>days</span></label>
      </div>
      <Switch label="Use the Leaving Soon poster" checked={draft.leavingSoon.poster} onChange={v=>set({leavingSoon:{...draft.leavingSoon,poster:v}})}/>
      </>}
    </Card>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row sticky-actions"><button className="primary" disabled={mutation.busy}>{mutation.busy?'Saving…':'Save clean up settings'}</button><span className="muted small">Save settings, then run a preview (top right) to review the results.</span></div>
  </form>;
}
