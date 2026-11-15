import {useEffect,useState} from 'react';
import type {DownloadsActivity,DownloadsGrab,DownloadsSeeding,GrabState,InteractiveSearch,LibrarySettingsView,LibraryTitleView,NamingPreview,
  PickProfile,PickProfileView,PickRules,ScoreRuleView,WantedList} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {invalidate,link,replaceRoute,useApi,useDebounced} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading} from './components.js';
import {Card,MoveButtons,SectionHead,Switch,date,moveTo,plural,remember,remembered,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';

// Admin › Downloads (docs/ARR-REPLACEMENT.md, "Admin UI"): tk.box's own library for movies, from what is downloading to
// the pick rules and naming. A title opens from Activity or Wanted (?title=<id>).
const tabs=[['activity','Activity'],['wanted','Wanted'],['rules','Pick rules'],['library','Library']] as const;
type Tab=typeof tabs[number][0];
const REFRESH_MS=10000,HOUR=3600000,GB=1024**3;
const stateNames:Record<GrabState,string>={sending:'Sending',downloading:'Downloading',unpacking:'Unpacking',importing:'Importing',imported:'Imported',seeding:'Seeding',done:'Done',failed:'Failed',cancelled:'Cancelled'};
const stateTone:Partial<Record<GrabState,string>>={imported:'ok',done:'ok',failed:'danger',downloading:'warning',unpacking:'warning',importing:'warning',sending:'warning'};
const gb=(bytes?:number)=>bytes===undefined?'—':bytes>=GB?`${(bytes/GB).toFixed(1)} GB`:`${Math.round(bytes/1024**2)} MB`;
function when(at:number|undefined,now=Date.now()) {
  if(!at)return '—';
  const ms=at-now,abs=Math.abs(ms);
  if(abs<45000)return ms<0?'just now':'now';
  const [n,unit]=abs<HOUR?[Math.round(abs/60000),'min']:abs<48*HOUR?[Math.round(abs/HOUR),'h']:[Math.round(abs/(24*HOUR)),'d'];
  return ms<0?`${n} ${unit} ago`:`in ${n} ${unit}`;
}
const titleHref=(id:number)=>link('admin',{section:'downloads',title:id});
const TitleLink=({id,title,year}:{id:number;title:string;year?:number})=><a className="jobs-name" href={titleHref(id)}>{title}{year?<span className="muted"> ({year})</span>:null}</a>;
const GrabBadge=({state}:{state:GrabState})=><span className={`badge ${stateTone[state]??''}`}>{stateNames[state]}</span>;
const changed=()=>invalidate('/admin/library');
// Re-reads a view every 10 s while the page is visible.
function useRefresh(reload:()=>void) {useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)reload();},REFRESH_MS);return()=>clearInterval(t);},[]);}

export function DownloadsAdmin({params}:{params:URLSearchParams}) {
  const titleId=Number(params.get('title'))||undefined;
  const asked=params.get('tab')??remembered('downloadsTab','activity');
  const tab=(tabs.some(([id])=>id===asked)?asked:'activity') as Tab;
  const setTab=(id:Tab)=>{remember('downloadsTab',id);replaceRoute(link('admin',{section:'downloads',tab:id}));};
  if(titleId)return <TitleView id={titleId}/>;
  return <><SectionHead title="Downloads"/>
    <div className="subtabs" role="tablist" aria-label="Downloads">{tabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel">{tab==='activity'?<Activity/>:tab==='wanted'?<Wanted/>:tab==='rules'?<PickRulesTab/>:<LibraryTab/>}</div>
  </>;
}

// ---- Activity ----

function Activity() {
  const view=useApi<DownloadsActivity>('/admin/library/activity'),mutation=useMutation(changed);useRefresh(view.reload);
  if(view.error&&!view.data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data)return <Loading/>;
  const {open,seeding=[],failed,history,jobs}=view.data,now=Date.now();
  const retry=(path:string,what:string)=>void mutation.run(async()=>{await api(path,'POST');toast.info(`Retrying ${what}`);});
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Card title="Downloading" actions={<span className="muted small">{open.length}</span>}>
      {!open.length?<p className="muted small">Nothing downloading</p>:<GrabTable grabs={open} columns={['quality','protocol','progress','state']}/>}
    </Card>
    {!!seeding.length&&<Card title="Seeding" actions={<span className="muted small">{seeding.length}</span>}><SeedingTable torrents={seeding} now={now}/></Card>}
    <Card title="Failed">
      {!failed.length?<p className="muted small">No failures</p>:<div className="table-scroll"><table className="jobs-table"><thead><tr><th>Title</th><th>Reason</th><th>When</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{failed.map(g=><tr key={g.id}><td><TitleLink id={g.titleId} title={g.title} year={g.year}/><small>{g.releaseName}</small></td>
          <td className="danger-text">{g.error??'Failed'}</td><td title={g.finishedAt?date(g.finishedAt):undefined}>{when(g.finishedAt,now)}</td>
          <td><button className="link-button" disabled={mutation.busy} onClick={()=>retry(`/admin/library/grabs/${g.id}/retry`,g.title)}>Retry</button></td></tr>)}</tbody></table></div>}
    </Card>
    <Card title="Queue" actions={<span className="muted small">{jobs.length}</span>}>
      {!jobs.length?<p className="muted small">Nothing queued</p>:<div className="table-scroll"><table className="jobs-table"><thead><tr><th>Job</th><th>Title</th><th>State</th><th>Tries</th><th>Runs</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{jobs.map(j=><tr key={j.id}><td>{j.label}{j.lastError&&<small className={j.state==='failed'?'danger-text':undefined}>{j.lastError}</small>}</td>
          <td>{j.titleId?<TitleLink id={j.titleId} title={j.subject??''}/>:'—'}</td>
          <td><span className={`badge ${j.state==='failed'?'danger':j.state==='running'?'warning':''}`}>{j.state==='failed'?'Failed':j.state==='running'?'Running':'Queued'}</span></td>
          <td>{j.attempts}/{j.maxAttempts}</td><td>{j.state==='queued'?when(j.runAt,now):'—'}</td>
          <td>{j.state==='failed'&&<button className="link-button" disabled={mutation.busy} onClick={()=>retry(`/admin/library/jobs/${j.id}/retry`,j.label.toLowerCase())}>Retry</button>}</td></tr>)}</tbody></table></div>}
    </Card>
    <Card title="History">
      {!history.length?<p className="muted small">Nothing yet</p>:<GrabTable grabs={history} columns={['quality','state','when']}/>}
    </Card>
  </>;
}

// Seeding torrents: ratio and days as qBittorrent last gave them, and when the seeding rule removes each.
function SeedingTable({torrents,now}:{torrents:DownloadsSeeding[];now:number}) {
  return <div className="table-scroll"><table className="jobs-table downloads-grabs"><thead><tr><th>Title</th><th>Ratio</th><th>Days</th><th>Removed</th></tr></thead>
    <tbody>{torrents.map(t=><tr key={t.id}><td><TitleLink id={t.titleId} title={t.title} year={t.year}/><small>{t.releaseName} · {gb(t.size)}</small></td>
      <td>{t.ratio!==undefined?t.ratio.toFixed(2):'—'}</td><td>{t.seedingDays!==undefined?t.seedingDays.toFixed(1):'—'}</td>
      <td title={t.removeAt?date(t.removeAt):undefined}>{t.removeAt===undefined?'—':t.removeAt<=now?'Next check':when(t.removeAt,now)}</td></tr>)}</tbody></table></div>;
}

type GrabColumn='quality'|'protocol'|'progress'|'state'|'when';
const columnNames:Record<GrabColumn,string>={quality:'Quality',protocol:'Protocol',progress:'Progress',state:'State',when:'When'};
function GrabTable({grabs,columns,linked=true}:{grabs:DownloadsGrab[];columns:GrabColumn[];linked?:boolean}) {
  const now=Date.now();
  const cell=(g:DownloadsGrab,c:GrabColumn)=>c==='quality'?<>{g.quality}{g.upgrade&&<small>Upgrade</small>}</>:c==='protocol'?(g.protocol==='usenet'?'Usenet':'Torrent')
    :c==='progress'?<div className="downloads-progress" title={g.progress!==undefined?`${Math.round(g.progress*100)}%`:undefined}><span style={{width:`${Math.round((g.progress??0)*100)}%`}}/></div>
    :c==='state'?<><GrabBadge state={g.state}/>{g.error&&g.state!=='failed'&&<small>{g.error}</small>}</>:when(g.importedAt??g.finishedAt??g.sentAt,now);
  return <div className="table-scroll"><table className="jobs-table downloads-grabs"><thead><tr><th>{linked?'Title':'Release'}</th>{columns.map(c=><th key={c}>{columnNames[c]}</th>)}</tr></thead>
    <tbody>{grabs.map(g=><tr key={g.id}><td>{linked?<><TitleLink id={g.titleId} title={g.title} year={g.year}/><small>{g.releaseName} · {gb(g.size)}</small></>:<>{g.releaseName}<small>{gb(g.size)} · {g.indexer}</small></>}</td>
      {columns.map(c=><td key={c}>{cell(g,c)}</td>)}</tr>)}</tbody></table></div>;
}

// ---- Wanted ----

function Wanted() {
  const view=useApi<WantedList>('/admin/library/wanted'),mutation=useMutation(changed);useRefresh(view.reload);
  if(view.error&&!view.data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data)return <Loading/>;
  const now=Date.now(),items=view.data.items;
  const search=(id:number,title:string)=>void mutation.run(async()=>{await api(`/admin/library/titles/${id}/search`,'POST');toast.info(`Searching for ${title}`);});
  const pause=(id:number,paused:boolean)=>void mutation.run(()=>api(`/admin/library/titles/${id}/pause`,'POST',{paused}));
  return <Card title="Wanted" actions={<span className="muted small">{plural(items.length,'movie')}</span>}>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    {!items.length?<Empty title="Nothing wanted"/>:<div className="table-scroll"><table className="jobs-table"><thead><tr><th>Title</th><th>Wanted</th><th>Next search</th><th>Misses</th><th>State</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{items.map(w=><tr key={w.id} className={w.paused?'is-off':undefined}>
        <td><TitleLink id={w.id} title={w.title} year={w.year}/></td>
        <td>{w.why==='missing'?'Missing':<>Below cutoff<small>{w.quality}</small></>}</td>
        <td title={w.nextAt?date(w.nextAt):undefined}>{w.paused||w.grab?'—':w.nextAt&&w.nextAt<=now?'Due':when(w.nextAt,now)}{w.lastAt&&<small>Last {when(w.lastAt,now)}</small>}</td>
        <td>{w.misses}</td>
        <td>{w.paused?<><span className="badge danger">Paused</span>{w.pausedReason&&<small>{w.pausedReason}</small>}</>:w.grab?<GrabBadge state={w.grab}/>:<span className="badge">Waiting</span>}</td>
        <td><div className="button-row">{!w.paused&&<button disabled={mutation.busy||!!w.grab} onClick={()=>search(w.id,w.title)}>Search now</button>}
          <button disabled={mutation.busy} onClick={()=>pause(w.id,!w.paused)}>{w.paused?'Unpause':'Pause'}</button></div></td>
      </tr>)}</tbody></table></div>}
  </Card>;
}

// ---- Title ----

function TitleView({id}:{id:number}) {
  const path=`/admin/library/titles/${id}`,view=useApi<LibraryTitleView>(path),mutation=useMutation(changed);useRefresh(view.reload);
  const back=<a className="link-button" href={link('admin',{section:'downloads'})}><Icon name="back" size={16}/>Downloads</a>;
  if(view.error&&!view.data)return <><SectionHead title="Downloads">{back}</SectionHead><ErrorNotice message={view.error.message} retry={view.reload}/></>;
  if(!view.data)return <><SectionHead title="Downloads">{back}</SectionHead><Loading/></>;
  const t=view.data,now=Date.now();
  const update=(body:{profileId?:number;keep?:boolean})=>void mutation.run(()=>api(path,'PUT',body));
  const search=()=>void mutation.run(async()=>{await api(`${path}/search`,'POST');toast.info(`Searching for ${t.title}`);});
  const pause=()=>void mutation.run(()=>api(`${path}/pause`,'POST',{paused:!t.paused}));
  const status=t.paused?<span className="badge danger">Paused</span>:!t.monitored?<span className="badge">Not monitored</span>:t.wanted.wanted?<span className="badge warning">{t.wanted.why==='missing'?'Missing':'Below cutoff'}</span>:<span className="badge ok">Have</span>;
  return <><SectionHead title={`${t.title}${t.year?` (${t.year})`:''}`}>{back}</SectionHead>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Card title="Movie" actions={status}>
      <div className="form-columns">
        <label>Profile<select value={t.profileId} disabled={mutation.busy} onChange={e=>update({profileId:Number(e.target.value)})}>{t.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="downloads-facts">
          <span><small>Next search</small>{t.paused||!t.monitored?'—':when(t.nextAt,now)}</span>
          <span><small>Last search</small>{when(t.lastAt,now)}</span>
          <span><small>Misses</small>{t.misses}</span>
          <span><small>Digital</small>{t.released.digital??'—'}</span>
        </div>
      </div>
      <Switch label="Keep" checked={t.keep} disabled={mutation.busy} onChange={keep=>update({keep})}/>
      {t.pausedReason&&<p className="danger-text small">{t.pausedReason}</p>}
      <div className="button-row"><button className="primary" disabled={mutation.busy||t.paused||!t.monitored} onClick={search}>Search</button>
        <button disabled={mutation.busy} onClick={pause}>{t.paused?'Unpause':'Pause'}</button></div>
    </Card>
    <Card title="Files">
      {!t.files.length?<p className="muted small">No file</p>:<div className="table-scroll"><table className="jobs-table"><thead><tr><th>File</th><th>Quality</th><th>Size</th><th>Imported</th></tr></thead>
        <tbody>{t.files.map(f=><tr key={f.id}><td className="downloads-path">{f.path}{f.releaseName&&<small>{f.releaseName}</small>}</td>
          <td>{f.quality}{f.proper&&<small>Proper</small>}</td><td>{gb(f.size)}</td><td title={date(f.importedAt)}>{when(f.importedAt,now)}</td></tr>)}</tbody></table></div>}
    </Card>
    {t.grabs.length>0&&<Card title="Downloads"><GrabTable grabs={t.grabs} columns={['quality','state','when']} linked={false}/></Card>}
    <InteractiveSearchCard path={path} title={t.title}/>
  </>;
}

function InteractiveSearchCard({path,title}:{path:string;title:string}) {
  const [result,setResult]=useState<InteractiveSearch>(),[showRejected,setShowRejected]=useState(false),[grabbed,setGrabbed]=useState('');
  const search=useMutation(()=>{}),grab=useMutation(changed);
  const run=()=>void search.run(async()=>{setGrabbed('');setResult(await api<InteractiveSearch>(`${path}/interactive`,'POST'));});
  const take=(guid:string,name:string)=>void grab.run(async()=>{await api(`${path}/grab`,'POST',{guid});setGrabbed(guid);toast.success(`Grabbed ${name}`);});
  const rejected=result?.releases.filter(r=>!r.accepted).length??0;
  const shown=result?.releases.filter(r=>r.accepted||showRejected)??[];
  return <Card title="Interactive search" actions={<>{result&&rejected>0&&<Switch label={`Rejected (${rejected})`} checked={showRejected} onChange={setShowRejected}/>}
    <button className="primary" disabled={search.busy} onClick={run}><Icon name="search" size={16}/>{search.busy?'Searching…':result?'Search again':'Search'}</button></>}>
    {search.error&&<ErrorNotice message={search.error}/>}
    {grab.error&&<ErrorNotice message={grab.error} dismiss={()=>grab.setError('')}/>}
    {result?.indexers.filter(i=>i.error).map(i=><div key={i.indexer} className="notice"><span>{i.indexer}: {i.error}</span></div>)}
    {result&&(!shown.length?<p className="muted small">{result.releases.length?'Nothing accepted':'Nothing found'}</p>:
      <div className="table-scroll"><table className="jobs-table downloads-releases"><thead><tr><th>Release</th><th>Quality</th><th>Score</th><th>Size</th><th>Source</th><th>Age</th><th><span className="sr-only">Grab</span></th></tr></thead>
        <tbody>{shown.map(r=><tr key={`${r.indexer}:${r.guid}`} className={r.accepted?undefined:'is-off'}>
          <td>{r.name}{r.reasons.map(reason=><small key={reason} className={reason.startsWith('rejected')?'danger-text':undefined}>{reason}</small>)}</td>
          <td>{r.quality??'—'}{r.upgrade&&<small>Upgrade</small>}</td><td>{r.score>0?`+${r.score}`:r.score}</td><td>{gb(r.size)}</td>
          <td>{r.indexer}<small>{r.protocol==='usenet'?'Usenet':'Torrent'}{r.grabs!==undefined?` · ${plural(r.grabs,'grab')}`:''}</small></td>
          <td>{r.publishedAt?when(r.publishedAt).replace(' ago',''):'—'}</td>
          <td>{grabbed===r.guid?<span className="success small">Grabbed</span>:<button className={r.accepted?'primary':undefined} disabled={grab.busy||!r.quality||!!grabbed}
            title={r.accepted?undefined:'Grab it anyway'} aria-label={`Grab ${r.name} for ${title}`} onClick={()=>take(r.guid,r.name)}>Grab</button>}</td>
        </tr>)}</tbody></table></div>)}
  </Card>;
}

// ---- Pick rules ----

function PickRulesTab() {
  const rules=useApi<PickRules>('/admin/library/rules'),settings=useApi<LibrarySettingsView>('/admin/library/settings');
  if((rules.error&&!rules.data)||(settings.error&&!settings.data))return <ErrorNotice message={(rules.error??settings.error)!.message} retry={()=>{rules.reload();settings.reload();}}/>;
  if(!rules.data||!settings.data)return <Loading/>;
  return <>
    <PickSettings key={settings.data.revision} settings={settings.data} profiles={rules.data.profiles}/>
    <Profiles data={rules.data} defaultProfile={settings.data.defaultProfile}/>
    <ScoreRules key={rules.data.rulesVersion} data={rules.data}/>
  </>;
}

function PickSettings({settings,profiles}:{settings:LibrarySettingsView;profiles:PickProfileView[]}) {
  const [earlyCopies,setEarlyCopies]=useState(settings.earlyCopies),[protocol,setProtocol]=useState(settings.protocol),[defaultProfile,setDefaultProfile]=useState(settings.defaultProfile);
  const mutation=useMutation(changed);
  const save=()=>void mutation.run(async()=>{await api('/admin/library/settings','PUT',{expectedRevision:settings.revision,earlyCopies,protocol,defaultProfile});toast.success('Saved');});
  return <form onSubmit={e=>{e.preventDefault();save();}}><Card title="Choosing">
    <Switch label="Early copies" checked={earlyCopies} onChange={setEarlyCopies}/>
    <div className="form-columns">
      <label>Protocol<select value={protocol} onChange={e=>setProtocol(e.target.value as typeof protocol)}><option value="usenet-first">Usenet first</option><option value="torrent-first">Torrents first</option></select></label>
      <label>Default profile<select value={defaultProfile} onChange={e=>setDefaultProfile(Number(e.target.value))}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row"><button className="primary" disabled={mutation.busy}>Save</button></div>
  </Card></form>;
}

function Profiles({data,defaultProfile}:{data:PickRules;defaultProfile:number}) {
  const [picked,setPicked]=useState<number|'new'>(defaultProfile);
  const current=picked==='new'?undefined:data.profiles.find(p=>p.id===picked)??data.profiles[0];
  const base=data.profiles.find(p=>p.id===defaultProfile)??data.profiles[0];
  return <Card title="Profiles" actions={<><select aria-label="Profile" value={picked==='new'?'new':current?.id} onChange={e=>setPicked(e.target.value==='new'?'new':Number(e.target.value))}>
      {data.profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===defaultProfile?' (Default)':''}</option>)}{picked==='new'&&<option value="new">New profile</option>}</select>
    <button type="button" onClick={()=>setPicked('new')}><Icon name="plus" size={16}/>New</button></>}>
    {picked==='new'?<ProfileEditor key="new" ladder={data.ladder} earlyCopies={data.earlyCopies} start={{name:'',value:base!.value}} saved={id=>setPicked(id)}/>
      :current&&<ProfileEditor key={current.id+current.version} ladder={data.ladder} earlyCopies={data.earlyCopies} profile={current} isDefault={current.id===defaultProfile}
        start={{name:current.name,value:current.value}} saved={setPicked} deleted={()=>setPicked(defaultProfile)}/>}
  </Card>;
}

function ProfileEditor({ladder,earlyCopies,profile,isDefault,start,saved,deleted}:{ladder:string[];earlyCopies:string[];profile?:PickProfileView;isDefault?:boolean;
  start:{name:string;value:PickProfile};saved:(id:number)=>void;deleted?:()=>void}) {
  const [name,setName]=useState(start.name),[value,setValue]=useState(start.value),mutation=useMutation(changed);
  const allowed=new Set(value.qualities.filter(q=>q.allowed).map(q=>q.name));
  const toggle=(q:string,on:boolean)=>setValue(v=>({...v,qualities:ladder.map(n=>({name:n,allowed:n===q?on:v.qualities.some(x=>x.name===n&&x.allowed)}))}));
  const size=(key:'movieSize'|'episodeSize',i:0|1,text:string)=>setValue(v=>{const next=[...v[key]] as [number,number];next[i]=Number(text);return {...v,[key]:next};});
  const save=()=>void mutation.run(async()=>{
    const result=profile?await api<PickRules>(`/admin/library/profiles/${profile.id}`,'PUT',{expectedVersion:profile.version,name:name.trim(),value})
      :await api<PickRules>('/admin/library/profiles','POST',{name:name.trim(),value});
    const id=profile?.id??result.profiles.find(p=>p.name.toLowerCase()===name.trim().toLowerCase())?.id;
    toast.success(`${name.trim()} saved`);if(id)saved(id);});
  const remove=()=>void mutation.run(async()=>{await api(`/admin/library/profiles/${profile!.id}`,'DELETE');toast.success(`${profile!.name} deleted`);deleted?.();});
  return <form className="downloads-profile" onSubmit={e=>{e.preventDefault();save();}}>
    <label>Name<input required maxLength={40} value={name} onChange={e=>setName(e.target.value)}/></label>
    <div className="table-scroll"><table className="jobs-table downloads-ladder"><thead><tr><th>Quality</th><th>Allowed</th><th>Cutoff</th></tr></thead>
      <tbody>{[...ladder].reverse().map(q=>{const early=earlyCopies.includes(q);return <tr key={q} className={allowed.has(q)?undefined:'is-off'}>
        <td>{q}{early&&<small>Early copy</small>}</td>
        <td><input type="checkbox" aria-label={`Allow ${q}`} checked={allowed.has(q)} onChange={e=>toggle(q,e.target.checked)}/></td>
        <td>{!early&&<input type="radio" name={`cutoff-${profile?.id??'new'}`} aria-label={`Cutoff ${q}`} checked={value.cutoff===q} disabled={!allowed.has(q)} onChange={()=>setValue(v=>({...v,cutoff:q}))}/>}</td>
      </tr>;})}</tbody></table></div>
    <div className="form-columns">
      <fieldset className="downloads-range"><legend>Movie size (GB)</legend>
        <input type="number" aria-label="Smallest movie" min={0} max={500} step={0.1} value={value.movieSize[0]} onChange={e=>size('movieSize',0,e.target.value)}/>–
        <input type="number" aria-label="Largest movie" min={0} max={500} step={0.1} value={value.movieSize[1]} onChange={e=>size('movieSize',1,e.target.value)}/></fieldset>
      <fieldset className="downloads-range"><legend>Episode size (GB)</legend>
        <input type="number" aria-label="Smallest episode" min={0} max={500} step={0.1} value={value.episodeSize[0]} onChange={e=>size('episodeSize',0,e.target.value)}/>–
        <input type="number" aria-label="Largest episode" min={0} max={500} step={0.1} value={value.episodeSize[1]} onChange={e=>size('episodeSize',1,e.target.value)}/></fieldset>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row"><button className="primary" disabled={mutation.busy}>Save</button>
      {profile&&<button type="button" className="danger" disabled={mutation.busy||isDefault||profile.used>0} title={isDefault?'The default profile':profile.used?`${plural(profile.used,'title')} use it`:undefined} onClick={remove}>Delete</button>}
      {profile&&profile.used>0&&<span className="muted small">{plural(profile.used,'title')}</span>}</div>
  </form>;
}

const blankRule=():ScoreRuleView=>({name:'',pattern:'',points:0,ban:false,applies:'both'});
function ScoreRules({data}:{data:PickRules}) {
  const [rules,setRules]=useState(data.rules),mutation=useMutation(changed);
  const set=(i:number,patch:Partial<ScoreRuleView>)=>setRules(list=>list.map((r,j)=>j===i?{...r,...patch}:r));
  const save=()=>void mutation.run(async()=>{
    await api('/admin/library/rules','PUT',{expectedVersion:data.rulesVersion,rules:rules.map(({label,...r})=>({...r,name:r.name.trim(),pattern:r.pattern.trim(),...(label?.trim()?{label:label.trim()}:{})}))});
    toast.success('Score rules saved');});
  return <form onSubmit={e=>{e.preventDefault();save();}}><Card title="Score rules" actions={<button type="button" onClick={()=>setRules(list=>[...list,blankRule()])}><Icon name="plus" size={16}/>Add</button>}>
    <div className="table-scroll"><table className="jobs-table downloads-rules"><thead><tr><th><span className="sr-only">Order</span></th><th>Name</th><th>Label</th><th>Pattern</th><th>Points</th><th>Ban</th><th>Applies to</th><th><span className="sr-only">Remove</span></th></tr></thead>
      <tbody>{rules.map((r,i)=><tr key={i}>
        <td><MoveButtons name={r.name||'rule'} index={i} count={rules.length} onMove={to=>setRules(list=>moveTo(list,i,to))}/></td>
        <td><input required maxLength={60} aria-label="Name" value={r.name} onChange={e=>set(i,{name:e.target.value})}/></td>
        <td><input maxLength={20} pattern="[A-Za-z0-9 +.\-]*" aria-label="Label" value={r.label??''} onChange={e=>set(i,{label:e.target.value})}/></td>
        <td><input required maxLength={200} spellCheck={false} aria-label="Pattern" className="downloads-pattern" value={r.pattern} onChange={e=>set(i,{pattern:e.target.value})}/></td>
        <td><input type="number" min={-1000} max={1000} aria-label="Points" disabled={r.ban} value={r.ban?'':r.points} onChange={e=>set(i,{points:Number(e.target.value)})}/></td>
        <td><input type="checkbox" aria-label="Ban" checked={r.ban} onChange={e=>set(i,{ban:e.target.checked})}/></td>
        <td><select aria-label="Applies to" value={r.applies} onChange={e=>set(i,{applies:e.target.value as ScoreRuleView['applies']})}><option value="both">Both</option><option value="movie">Movies</option><option value="show">Shows</option></select></td>
        <td><button type="button" className="icon-button" aria-label={`Remove ${r.name||'rule'}`} onClick={()=>setRules(list=>list.filter((_,j)=>j!==i))}><Icon name="trash" size={16}/></button></td>
      </tr>)}</tbody></table></div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row"><button className="primary" disabled={mutation.busy}>Save</button>{JSON.stringify(rules)!==JSON.stringify(data.rules)&&<button type="button" onClick={()=>setRules(data.rules)}>Undo</button>}</div>
  </Card></form>;
}

// ---- Library ----

function LibraryTab() {
  const settings=useApi<LibrarySettingsView>('/admin/library/settings');
  if(settings.error&&!settings.data)return <ErrorNotice message={settings.error.message} retry={settings.reload}/>;
  if(!settings.data)return <Loading/>;
  return <><Roots key={settings.data.revision} settings={settings.data}/><Naming settings={settings.data}/></>;
}
function Roots({settings}:{settings:LibrarySettingsView}) {
  const [movie,setMovie]=useState(settings.roots.movie),mutation=useMutation(changed);
  const save=()=>void mutation.run(async()=>{await api('/admin/library/settings','PUT',{expectedRevision:settings.revision,roots:{movie:movie.trim()}});toast.success('Saved');});
  return <form onSubmit={e=>{e.preventDefault();save();}}><Card title="Roots">
    <label>Movies<input required spellCheck={false} value={movie} onChange={e=>setMovie(e.target.value)}/></label>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row"><button className="primary" disabled={mutation.busy||movie.trim()===settings.roots.movie}>Save</button></div>
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
