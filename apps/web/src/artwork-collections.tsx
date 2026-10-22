import {useEffect,useState,type ReactNode} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,Switch,date as when,remember,remembered,useMutation} from './settings-ui.js';
import {JobHistory,type Job} from './artwork-jobs.js';

// Admin › Collections: Plex collections the engine keeps. Franchise, streaming and chart collections come from
// TMDb and your libraries; custom and seasonal ones are defined here (by hand, from a curated universe or a public list),
// and Radarr can fetch a seasonal collection's missing movies. Definitions are kept in the engine's own format.
type Library={key:string;title:string;type:string};
type Member={rating_key?:string;tmdb_id?:number;imdb_id?:string;title?:string;year?:number};
type Definition={name:string;library:string;type:'movie'|'tv';enabled?:boolean;schedule?:string;sync?:'sync'|'append';members?:Member[];
  rules?:{genres?:string[];year_from?:number;year_to?:number;title_contains?:string};visibility?:{home?:boolean;shared?:boolean;recommended?:boolean};
  acquire?:boolean;cleanup?:'keep'|'remove-delete';source?:{url:string;limit?:number;refresh?:boolean}};
type Franchise={sync:boolean;franchises:boolean;minItems:number;mode:'sync'|'append';streaming:'off'|'originals'|'available';region:string;recent:boolean;recentMovieDays:number;recentEpisodeDays:number};
type Radarr={url:string;rootFolder:string;qualityProfileId:number;search:boolean};
type Kept={name:string;library:string;kind:'franchise'|'streaming';items:number;rating_key?:string};
type Daily={enabled:boolean;time:string};type EveryFew={enabled:boolean;minutes:number};
type Schedules={custom:Daily;all:Daily;added:EveryFew};
export type ScheduleState={lastRun?:number;note?:string};
type View={revision:number;definitions:Definition[]|null;franchise:Franchise;radarr:Radarr;radarrKeySet:boolean;defaults:Definition[];kept:{updated:string|null;collections:Kept[]};schedules:Schedules;scheduleStates:Record<keyof Schedules,ScheduleState>;libraries:Library[];upload:boolean};
const tabs=[['collections','Collections'],['jobs','Jobs'],['schedules','Schedules'],['settings','Settings']] as const;
const keyOf=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/collection$/,'');
const memberText=(m:Member)=>m.tmdb_id?`tmdb:${m.tmdb_id}`:m.rating_key?`plex:${m.rating_key}`:m.imdb_id?`imdb:${m.imdb_id}`:m.year?`${m.title} | ${m.year}`:m.title??'';
const parseMembers=(text:string):Member[]=>text.split('\n').map(s=>s.trim()).filter(Boolean).map(line=>{
  if(/^imdb:tt\d+$/i.test(line))return {imdb_id:line.slice(5).toLowerCase()};
  let match=line.match(/^(tmdb|plex):(\d+)$/i);if(match)return match[1]!.toLowerCase()==='tmdb'?{tmdb_id:Number(match[2])}:{rating_key:match[2]!};
  match=line.match(/^(.*?)\s*\|\s*(\d{4})$/);return match?{title:match[1]!.trim(),year:Number(match[2])}:{title:line};
});

export function ArtworkCollections({engineReady}:{engineReady:boolean}) {
  const view=useApi<View>(engineReady?'/admin/artwork/collections':undefined),[draft,setDraft]=useState<{definitions:Definition[];franchise:Franchise;radarr:Radarr;schedules:Schedules}>();
  const [editing,setEditing]=useState<number>(),[discover,setDiscover]=useState(false),[dirty,setDirty]=useState(false),[saved,setSaved]=useState(''),[date,setDate]=useState(''),[tab,setTabState]=useState(()=>remembered('collectionsTab','collections'));
  const setTab=(t:string)=>{setTabState(t);remember('collectionsTab',t);};
  const mutation=useMutation(view.reload),run=useMutation(()=>invalidate('/admin/artwork/jobs?script=collections')),[ran,setRan]=useState(false),[job,setJob]=useState<number>(),[title,setTitle]=useState('');
  const reset=()=>{const d=view.data;if(!d)return;setDraft({definitions:JSON.parse(JSON.stringify(d.definitions??d.defaults)) as Definition[],franchise:d.franchise,radarr:d.radarr,schedules:d.schedules});setDirty(false);};
  useEffect(reset,[view.data?.revision,!!view.data]);
  if(!engineReady)return <Empty title="The artwork engine isn’t set up">Set it up (above) to manage collections.</Empty>;
  if(view.loading&&!view.data)return <Loading/>;
  if(view.error)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data||!draft)return null;
  const data=view.data,libraries=data.libraries.filter(l=>['movie','show'].includes(l.type));
  const change=(next:Partial<typeof draft>)=>{setDraft({...draft,...next});setDirty(true);setSaved('');};
  const franchise=(patch:Partial<Franchise>)=>change({franchise:{...draft.franchise,...patch}}),radarr=(patch:Partial<Radarr>)=>change({radarr:{...draft.radarr,...patch}});
  const setDefinition=(index:number,value:Definition|null)=>change({definitions:value?draft.definitions.map((d,i)=>i===index?value:d):draft.definitions.filter((_,i)=>i!==index)});
  const save=()=>void mutation.run(async()=>{await api('/admin/artwork/collections','PUT',{expectedRevision:data.revision,value:draft});setSaved('Saved. Preview the plan to see what would change in Plex.');});
  // A job queued from the Collections tab says so there; one queued from the Jobs tab opens in its history.
  const start=(body:object)=>void run.run(async()=>{const queued=await api<Job>('/admin/artwork/collections/run','POST',body);setJob(queued.id);setRan(tab!=='jobs');});
  const presets=data.defaults.filter(p=>!draft.definitions.some(e=>keyOf(e.name)===keyOf(p.name)));
  const blocked=dirty?'Save your changes first':undefined,needsUpload=!data.upload?'Turn on Send results to Plex in Artwork › Settings first':undefined;
  return <div className="form-stack">
    <div className="subtabs" role="tablist" aria-label="Collections">{tabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel" className="form-stack">
      {tab==='jobs'?<>
        <div className="artwork-run">
          <Card title="Every collection" description="Franchise, streaming and chart, then custom." actions={<>
            <button disabled={run.busy||!!blocked} title={blocked} onClick={()=>start({kind:'franchise',mode:'plan'})}>Preview</button>
            <button className="primary" disabled={run.busy||!!blocked||!data.upload} title={blocked??needsUpload} onClick={()=>start({kind:'franchise',mode:'apply'})}>Apply</button></>}/>
          <Card title="Custom and seasonal collections" description="Preview as of another day to check seasonal dates.">
            <div className="button-row"><label className="artwork-inline">as of<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
              <button disabled={run.busy||!!blocked} title={blocked} onClick={()=>start({kind:'custom',mode:'plan',...(date?{date}:{})})}>Preview</button>
              <button className="primary" disabled={run.busy||!!blocked||!data.upload} title={blocked??needsUpload} onClick={()=>start({kind:'custom',mode:'apply'})}>Apply</button></div>
          </Card>
          <Card title="One title" description={`Adds it to matching custom collections.${data.upload?'':' Preview only while sending is off.'}`}>
            <form className="button-row" onSubmit={e=>{e.preventDefault();start({kind:'added',mode:data.upload?'apply':'plan',ratingKey:title});}}>
              <input className="grow" aria-label="Plex ID" inputMode="numeric" pattern="\d{1,10}" required placeholder="Plex ID, e.g. 12345" value={title} onChange={e=>setTitle(e.target.value.trim())}/>
              <button className="primary" disabled={run.busy||!!blocked} title={blocked}>{data.upload?'Apply':'Preview'}</button></form>
          </Card>
        </div>
        <JobHistory script="collections" selected={job} select={setJob}/>
      </>:tab==='settings'?<>
        <Card title="Franchise, streaming and chart collections" description="Turning one off leaves existing collections in Plex.">
          <Switch label="Franchise collections for movies" description="e.g. The Lord of the Rings" checked={draft.franchise.franchises} onChange={v=>franchise({franchises:v})}/>
          <Switch label="Streaming collections for TV shows" description="e.g. Netflix Shows" checked={draft.franchise.streaming!=='off'} onChange={v=>franchise({streaming:v?'originals':'off'})}/>
          {draft.franchise.streaming!=='off'&&<div className="form-columns">
            <label>Shows it holds<select value={draft.franchise.streaming} onChange={e=>franchise({streaming:e.target.value as Franchise['streaming']})}><option value="originals">Shows that aired on the service</option><option value="available">Shows streaming there now</option></select></label>
            {draft.franchise.streaming==='available'&&<label>Streaming country<input maxLength={2} pattern="[A-Z]{2}" value={draft.franchise.region} onChange={e=>franchise({region:e.target.value.toUpperCase()})}/></label>}
          </div>}
          {(draft.franchise.franchises||draft.franchise.streaming!=='off')&&<div className="form-columns">
            <label>Titles a collection needs<input type="number" min="1" max="50" value={draft.franchise.minItems} onChange={e=>franchise({minItems:Number(e.target.value)})}/></label>
            <label>Membership<select value={draft.franchise.mode} onChange={e=>franchise({mode:e.target.value as Franchise['mode']})}><option value="sync">Add and remove to match TMDb</option><option value="append">Only add</option></select></label></div>}
          <Switch label="Newly Released and New Episodes" checked={draft.franchise.recent} onChange={v=>franchise({recent:v})}/>
          {draft.franchise.recent&&<div className="form-columns">
            <label>Newly Released: movies from the last (days)<input type="number" min="1" max="3650" value={draft.franchise.recentMovieDays} onChange={e=>franchise({recentMovieDays:Number(e.target.value)})}/></label>
            <label>New Episodes: aired in the last (days)<input type="number" min="1" max="3650" value={draft.franchise.recentEpisodeDays} onChange={e=>franchise({recentEpisodeDays:Number(e.target.value)})}/></label></div>}
          <Switch label="Update them with every full artwork run" checked={draft.franchise.sync} onChange={v=>franchise({sync:v})}/>
        </Card>
        <Card title="Radarr downloads" description="For seasonal collections that download missing movies.">
          {!data.radarr.url&&<p className="muted small">Radarr isn’t connected. Add it in <a href="#admin?section=connections">Admin › Connections</a>.</p>}
          <QualityProfile value={draft.radarr.qualityProfileId} set={qualityProfileId=>radarr({qualityProfileId})}/>
          <Switch label="Search for movies when added" checked={draft.radarr.search} onChange={v=>radarr({search:v})}/>
        </Card>
      </>:tab==='schedules'?<>
        <Card title="Schedules" description="Server local time.">
          {!data.upload&&<p className="muted small">Send results to Plex is off, so these are skipped until it’s on.</p>}
          <div className="artwork-schedules">
            <ScheduleRow label="Custom and seasonal collections" hint="Syncs custom; shows or hides seasonal." state={data.scheduleStates.custom} value={draft.schedules.custom} set={custom=>change({schedules:{...draft.schedules,custom}})}/>
            <ScheduleRow label="Every collection" hint="Franchise, streaming and chart, then custom." state={data.scheduleStates.all} value={draft.schedules.all} set={all=>change({schedules:{...draft.schedules,all}})}/>
            <ScheduleRow label="Newly added titles" hint="As Plex adds them, plus a periodic check." state={data.scheduleStates.added} value={draft.schedules.added} set={added=>change({schedules:{...draft.schedules,added}})}/>
          </div>
        </Card>
      </>:<>
        <KeptList kept={data.kept} franchise={data.franchise} actions={<>
          <button disabled={run.busy||!!blocked} title={blocked} onClick={()=>start({kind:'franchise',mode:'plan'})}>Preview the plan</button>
          <button disabled={run.busy||!!blocked||!data.upload} title={blocked??needsUpload} onClick={()=>start({kind:'franchise',mode:'apply'})}>Apply now</button></>} settings={()=>setTab('settings')}/>
        <Card title="Custom and seasonal collections" description="Picked titles, Plex rules or public lists." actions={<>
          <button onClick={()=>setDiscover(true)}><Icon name="explore" size={16}/>Discover</button>
          <button onClick={()=>{change({definitions:[...draft.definitions,{name:'New collection',library:libraries[0]?.title??'',type:libraries[0]?.type==='show'?'tv':'movie',enabled:false,sync:'append',members:[]}]});setEditing(draft.definitions.length);}}><Icon name="plus" size={16}/>New</button></>}>
          {data.definitions===null&&<p className="muted small">Seasonal presets, all off. Pick a library, turn some on, then save.</p>}
          {draft.definitions.length?<div className="table-scroll"><table><thead><tr><th>Collection</th><th>Library</th><th>When</th><th>On</th><th/></tr></thead><tbody>{draft.definitions.map((d,i)=><tr key={i}>
            <td><strong>{d.name}</strong><small>{d.source?'From a list':`${d.members?.length??0} picks`}{d.rules&&Object.keys(d.rules).length?' · rules':''}{d.acquire?' · Radarr':''}</small></td>
            <td>{d.library||<span className="danger">Choose one</span>}<small>{d.type==='tv'?'TV':'Movies'}</small></td><td>{d.schedule||'All year'}</td>
            <td><input type="checkbox" role="switch" className="switch" aria-label={`${d.name} on`} checked={d.enabled!==false} onChange={e=>setDefinition(i,{...d,enabled:e.target.checked})}/></td>
            <td><div className="button-row"><button onClick={()=>setEditing(i)}>Edit</button><button className="icon-button" aria-label={`Remove ${d.name}`} onClick={()=>setDefinition(i,null)}><Icon name="close" size={16}/></button></div></td></tr>)}</tbody></table></div>
            :<Empty title="No custom collections">Add one, or find one with Discover.</Empty>}
          {presets.length>0&&data.definitions!==null&&<div className="button-row"><button onClick={()=>change({definitions:[...draft.definitions,...JSON.parse(JSON.stringify(presets)) as Definition[]]})}>Add the {presets.length} seasonal presets you don’t have</button></div>}
          <div className="button-row"><button disabled={run.busy||!!blocked} title={blocked} onClick={()=>start({kind:'custom',mode:'plan',...(date?{date}:{})})}>Preview the plan</button>
            <label className="artwork-inline">as of<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
            <button disabled={run.busy||!!blocked||!data.upload} title={blocked??needsUpload} onClick={()=>start({kind:'custom',mode:'apply'})}>Apply now</button></div>
        </Card>
      </>}
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}{run.error&&<ErrorNotice message={run.error}/>}{ran&&tab!=='jobs'&&<p className="success small" role="status">Queued. <button type="button" className="link-button" onClick={()=>{setRan(false);setTab('jobs');}}>Follow it in Jobs</button></p>}
    {(dirty||saved)&&<div className="button-row sticky-actions">{dirty&&<><button className="primary" disabled={mutation.busy} onClick={save}>Save collections</button><button onClick={reset}>Discard changes</button></>}{saved&&!dirty&&<span className="success" role="status">{saved}</span>}</div>}
    {editing!==undefined&&draft.definitions[editing]&&<EditDefinition value={draft.definitions[editing]!} libraries={libraries} onClose={()=>setEditing(undefined)} save={value=>{setDefinition(editing,value);setEditing(undefined);}}/>}
    {discover&&<Discover libraries={libraries} existing={draft.definitions} onClose={()=>setDiscover(false)} add={entry=>{change({definitions:[...draft.definitions,entry]});setDiscover(false);setEditing(draft.definitions.length);}}/>}
  </div>;
}
// The saved Radarr's quality profiles by name; the engine is given the chosen one's ID, and none means Radarr's first.
function QualityProfile({value,set}:{value:number;set:(id:number)=>void}) {
  const view=useApi<{connected:boolean;profiles:{id:number;name:string}[]}>('/admin/artwork/collections/radarr-profiles'),profiles=view.data?.profiles??[];
  return <label className="narrow">Quality profile<select value={value} disabled={!view.data?.connected} onChange={e=>set(Number(e.target.value))}>
      <option value={0}>Radarr’s first profile{profiles[0]?` (${profiles[0].name})`:''}</option>
      {profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
      {value>0&&!profiles.some(p=>p.id===value)&&<option value={value}>{view.data?.connected?`Missing profile (ID ${value})`:`ID ${value}`}</option>}</select>
    {view.error?<small className="danger">{view.error.message}</small>:view.loading&&!view.data?<small>Loading profiles from Radarr…</small>:null}</label>;
}
// One scheduled job: a switch, its time of day (or minutes between checks), and when it last ran.
export function ScheduleRow<T extends Daily|EveryFew>({label,hint,state,value,set}:{label:string;hint:string;state?:ScheduleState;value:T;set:(value:T)=>void}) {
  const status=state?.lastRun||state?.note?[state.lastRun&&`Last run ${when(state.lastRun)}`,state.note].filter(Boolean).join(' · '):'';
  return <div className={`artwork-schedule${value.enabled?'':' off'}`}>
    <div className="switch-text"><strong>{label}</strong><small>{hint}</small>{status&&<small className="artwork-schedule-status">{status}</small>}</div>
    <div className="artwork-schedule-control">{'time' in value
      ?<label className="artwork-inline">Daily at<input type="time" aria-label={`${label} time`} required value={value.time} disabled={!value.enabled} onChange={e=>set({...value,time:e.target.value})}/></label>
      :<label className="artwork-inline">Every<input type="number" min="5" max="1440" required aria-label={`${label}: minutes between checks`} value={value.minutes} disabled={!value.enabled} onChange={e=>set({...value,minutes:Number(e.target.value)})}/>min</label>}</div>
    <input type="checkbox" role="switch" className="switch" aria-label={label} checked={value.enabled} onChange={e=>set({...value,enabled:e.target.checked})}/>
  </div>;
}
// The franchise and streaming collections the last full run kept in Plex, for the kinds that are on (as saved).
function KeptList({kept,franchise,actions,settings}:{kept:View['kept'];franchise:Franchise;actions:ReactNode;settings:()=>void}) {
  const on={franchise:franchise.franchises,streaming:franchise.streaming!=='off'};
  const [kind,setKind]=useState<'all'|Kept['kind']>('all'),[query,setQuery]=useState('');
  const rows=kept.collections.filter(c=>on[c.kind]),words=query.trim().toLowerCase();
  const shown=rows.filter(c=>(kind==='all'||c.kind===kind)&&(!words||`${c.name} ${c.library}`.toLowerCase().includes(words)));
  const count=(k:Kept['kind'])=>rows.filter(c=>c.kind===k).length;
  return <Card title="Franchise and streaming collections" description={kept.updated?`As of ${new Date(`${kept.updated}T00:00`).toLocaleDateString()}`:'Listed after the first full run.'}>
    {!on.franchise&&!on.streaming?<p className="muted small">Franchise and streaming collections are off. Turn them on in <button type="button" className="link-button" onClick={settings}>Settings</button>.</p>
    :rows.length?<>
      <div className="setting-line">
        {on.franchise&&on.streaming&&<div className="toggle-group" role="radiogroup" aria-label="Kind">{([['all',`All ${rows.length}`],['franchise',`Franchises ${count('franchise')}`],['streaming',`Streaming ${count('streaming')}`]] as const).map(([k,label])=><button key={k} type="button" role="radio" aria-checked={kind===k} onClick={()=>setKind(k)}>{label}</button>)}</div>}
        <input className="grow" type="search" placeholder="Search collections" aria-label="Search collections" value={query} onChange={e=>setQuery(e.target.value)}/></div>
      {shown.length?<div className="table-scroll"><table><thead><tr><th>Collection</th><th>Library</th><th>Kind</th><th>Titles</th></tr></thead><tbody>{shown.map(c=><tr key={`${c.library}\0${c.name}`}>
        <td><strong>{c.name}</strong></td><td>{c.library}</td><td>{c.kind==='franchise'?'Franchise':'Streaming'}</td><td>{c.items}</td></tr>)}</tbody></table></div>
        :<Empty title="No matches">Try another search.</Empty>}</>
      :<Empty title="None yet">Apply them now, or wait for the next full run.</Empty>}
    <div className="button-row">{actions}</div>
  </Card>;
}
function EditDefinition({value,libraries,onClose,save}:{value:Definition;libraries:Library[];onClose:()=>void;save:(value:Definition)=>void}) {
  const [d,setD]=useState(value),[members,setMembers]=useState((value.members??[]).map(memberText).join('\n'));
  const set=(patch:Partial<Definition>)=>setD(x=>({...x,...patch}));
  const rules=d.rules??{},rule=(patch:Partial<NonNullable<Definition['rules']>>)=>{const next={...rules,...patch} as Record<string,unknown>;for(const k of Object.keys(next))if(next[k]===undefined||next[k]===''||(Array.isArray(next[k])&&!(next[k] as unknown[]).length))delete next[k];set({rules:next as Definition['rules']});};
  const refreshed=!!d.source&&d.source.refresh!==false,visibility=d.visibility??{};
  return <Modal title={d.name||'Collection'} onClose={onClose}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();const next:Definition={...d,members:refreshed?d.members??[]:parseMembers(members)};if(next.rules&&!Object.keys(next.rules).length)delete next.rules;if(!next.schedule)delete next.schedule;if(!next.acquire){delete next.acquire;if(next.cleanup==='remove-delete')delete next.cleanup;}save(next);}}>
      <div className="form-columns">
        <label>Name<input required maxLength={120} value={d.name} onChange={e=>set({name:e.target.value})}/></label>
        <label>Plex library<select required value={d.library} onChange={e=>{const l=libraries.find(x=>x.title===e.target.value);set({library:e.target.value,...(l?{type:l.type==='show'?'tv':'movie'}:{})});}}><option value="">Choose a library</option>{libraries.map(l=><option key={l.key} value={l.title}>{l.title}</option>)}{d.library&&!libraries.some(l=>l.title===d.library)&&<option value={d.library}>{d.library}</option>}</select></label>
        <label>Membership<select value={d.sync??'append'} onChange={e=>set({sync:e.target.value as 'sync'|'append'})}><option value="append">Only add new members</option><option value="sync">Add and remove to match</option></select></label>
        <label>Shown from–to<input placeholder="10/01-10/31" pattern="\d{2}/\d{2}-\d{2}/\d{2}" value={d.schedule??''} onChange={e=>set({schedule:e.target.value.trim()})}/><small>MM/DD-MM/DD; empty for all year.</small></label>
      </div>
      <Switch label="On" checked={d.enabled!==false} onChange={v=>set({enabled:v})}/>
      {d.source&&<div className="form-columns"><label>List address<input type="url" value={d.source.url} onChange={e=>set({source:{...d.source!,url:e.target.value}})}/></label>
        <label>Most titles<input type="number" min="1" max="250" value={d.source.limit??50} onChange={e=>set({source:{...d.source!,limit:Number(e.target.value)}})}/></label>
        <Switch label="Keep up to date from the list" description="Each collection run uses the list as it is then." checked={d.source.refresh!==false} onChange={v=>set({source:{...d.source!,refresh:v}})}/></div>}
      <label>{d.source?'Saved titles':'Titles'}<textarea rows={8} disabled={refreshed} placeholder={'tmdb:948\nAlien | 1979'} value={members} onChange={e=>setMembers(e.target.value)}/>
        <small>{refreshed?'Kept up to date from the list; turn that off to edit these.':'One per line: tmdb:948, imdb:tt0077651, plex:12345, or Halloween | 1978 (titles must match Plex).'}</small></label>
      <details open={!!Object.keys(rules).length}><summary>Plex rules (titles that match are added too)</summary><div className="form-columns">
        <label>Genres<input placeholder="Horror, Thriller" value={(rules.genres??[]).join(', ')} onChange={e=>rule({genres:e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})}/></label>
        <label>Year from<input type="number" min="1" max="9999" value={rules.year_from??''} onChange={e=>rule({year_from:e.target.value?Number(e.target.value):undefined})}/></label>
        <label>Year through<input type="number" min="1" max="9999" value={rules.year_to??''} onChange={e=>rule({year_to:e.target.value?Number(e.target.value):undefined})}/></label>
        <label>Title contains<input value={rules.title_contains??''} onChange={e=>rule({title_contains:e.target.value||undefined})}/></label></div></details>
      <details><summary>Where it shows in Plex</summary>
        {(['home','shared','recommended'] as const).map(k=><Switch key={k} label={{home:'Your Home',shared:'Friends’ Home',recommended:'Library recommendations'}[k]} checked={visibility[k]??true} onChange={v=>set({visibility:{...visibility,[k]:v}})}/>)}</details>
      {d.type==='movie'&&<details open={!!d.acquire}><summary>Radarr</summary>
        <Switch label="Download missing movies" description="Needs Radarr and TMDb IDs." checked={!!d.acquire} onChange={v=>set({acquire:v})}/>
        {d.acquire&&<label>After the season ends<select value={d.cleanup??'keep'} onChange={e=>set({cleanup:e.target.value as 'keep'|'remove-delete'})}><option value="keep">Keep downloaded movies</option><option value="remove-delete">Delete the movies it downloaded</option></select></label>}</details>}
      <div className="button-row"><button className="primary">Done</button><button type="button" onClick={onClose}>Cancel</button><span className="muted small">Save collections to keep this.</span></div>
    </form>
  </Modal>;
}
type Row={key?:string;name:string;url:string|null;description?:string;type:'movie'|'tv';provider:string};
type Preview={name:string;url:string;type:'movie'|'tv';limit:number;provider:string;items:{title:string;year?:number;member:Member}[]};
const providers=[['all','Every source'],['tmdb','TMDb'],['trakt','Trakt'],['mdblist','MDBList'],['imdb','IMDb'],['letterboxd','Letterboxd'],['flixpatrol','FlixPatrol']] as const;
function Discover({libraries,existing,onClose,add}:{libraries:Library[];existing:Definition[];onClose:()=>void;add:(entry:Definition)=>void}) {
  const [mode,setMode]=useState<'recommendations'|'universes'|'browse'|'url'>('universes'),[type,setType]=useState<'movie'|'tv'>('movie'),[provider,setProvider]=useState('all'),[query,setQuery]=useState('');
  const [rows,setRows]=useState<Row[]>(),[preview,setPreview]=useState<Preview>(),[url,setUrl]=useState(''),[limit,setLimit]=useState(50),mutation=useMutation(()=>{});
  const [name,setName]=useState(''),[library,setLibrary]=useState(''),[refresh,setRefresh]=useState(true),[problem,setProblem]=useState('');
  const find=()=>void mutation.run(async()=>{setPreview(undefined);const r=await api<{results:Row[]}>('/admin/artwork/collections/discover','POST',{mode,provider,query,type});setRows(r.results);});
  const open=(body:object)=>void mutation.run(async()=>{const r=await api<Preview>('/admin/artwork/collections/discover','POST',{mode:'preview',...body});setPreview(r);setName(r.name);setLibrary(libraries.find(l=>(l.type==='show'?'tv':'movie')===r.type)?.title??'');setProblem('');});
  useEffect(()=>{if(mode==='universes'||mode==='recommendations')find();},[mode,type]);
  return <Modal title="Discover collections" onClose={onClose}>
    <div className="form-stack artwork-discover">
      <div className="toggle-group" role="radiogroup" aria-label="Find collections">{([['universes','Universes'],['recommendations','Recommended'],['browse','Search lists'],['url','Import a list']] as const).map(([m,label])=><button key={m} type="button" role="radio" aria-checked={mode===m} onClick={()=>{setMode(m);setRows(undefined);setPreview(undefined);setQuery('');}}>{label}</button>)}</div>
      {!preview&&(mode==='url'?<form className="setting-line" onSubmit={e=>{e.preventDefault();open({url,type,limit});}}><input className="grow" type="url" required placeholder="A public TMDb, IMDb, Trakt, Letterboxd, MDBList or FlixPatrol list" value={url} onChange={e=>setUrl(e.target.value)}/>
          <select aria-label="Movies or TV" value={type} onChange={e=>setType(e.target.value as 'movie'|'tv')}><option value="movie">Movies</option><option value="tv">TV</option></select><input aria-label="Most titles" type="number" min="1" max="250" value={limit} onChange={e=>setLimit(Number(e.target.value))}/><button className="primary" disabled={mutation.busy}>Preview</button></form>
        :<form className="setting-line" onSubmit={e=>{e.preventDefault();find();}}>
          {mode==='universes'?<select aria-label="Movies or TV" value={type} onChange={e=>setType(e.target.value as 'movie'|'tv')}><option value="movie">Movies</option><option value="tv">TV</option></select>
            :<select aria-label="Source" value={provider} onChange={e=>setProvider(e.target.value)}>{providers.filter(([p])=>mode!=='browse'||p!=='all').map(([p,label])=><option key={p} value={p}>{label}</option>)}</select>}
          <input className="grow" type="search" placeholder="Search" value={query} onChange={e=>setQuery(e.target.value)}/><button disabled={mutation.busy||(mode==='browse'&&provider==='all')}>Search</button></form>)}
      {mutation.busy&&<Loading/>}{mutation.error&&<ErrorNotice message={mutation.error}/>}
      {preview?<div className="form-stack">
        <button className="back-link" onClick={()=>setPreview(undefined)}><Icon name="back" size={16}/>Back</button>
        <h3>{preview.name} <small className="muted">{preview.items.length} {preview.type==='tv'?'shows':'movies'}</small></h3>
        <ol className="artwork-discover-list">{preview.items.map((item,i)=><li key={i}>{item.title}{item.year?<small className="muted"> {item.year}</small>:null}</li>)}</ol>
        <form className="form-stack" onSubmit={e=>{e.preventDefault();
          if(existing.some(x=>x.library===library&&(keyOf(x.name)===keyOf(name)||x.source?.url===preview.url))){setProblem('This name or list is already in that library. Edit that collection instead.');return;}
          add({name:name.trim(),library,type:preview.type,enabled:false,sync:'append',members:preview.items.map(i=>i.member),source:{url:preview.url,limit:preview.limit,refresh}});}}>
          <div className="form-columns"><label>Name<input required value={name} onChange={e=>setName(e.target.value)}/></label>
            <label>Plex library<select required value={library} onChange={e=>setLibrary(e.target.value)}><option value="">Choose a library</option>{libraries.filter(l=>(l.type==='show'?'tv':'movie')===preview.type).map(l=><option key={l.key} value={l.title}>{l.title}</option>)}</select></label></div>
          <Switch label="Keep this list up to date" description="Each collection run uses the list as it is then." checked={refresh} onChange={setRefresh}/>
          {problem&&<p className="danger small">{problem}</p>}
          <div className="button-row"><button className="primary">Add collection</button><span className="muted small">It starts off; review it, turn it on and save.</span></div>
        </form></div>
      :rows&&(rows.length?<ul className="artwork-discover-rows">{rows.map((r,i)=><li key={i}><span className="grow"><strong>{r.name}</strong><small className="muted">{r.description||'Public list'} · {r.type==='tv'?'TV':'Movies'}</small></span>
          {r.url?<button disabled={mutation.busy} onClick={()=>open({...(r.key?{universe:r.key,limit:250}:{url:r.url,limit:50}),type:r.type})}>Preview titles</button>:<button onClick={()=>{setMode('browse');setProvider(r.provider);setRows(undefined);}}>Browse lists</button>}</li>)}</ul>
        :<Empty title="No collections found">Try another search, or import a list by its address.</Empty>)}
      <p className="muted small">TMDb and MDBList need keys in Connections. IMDb may refuse imports.</p>
    </div>
  </Modal>;
}
