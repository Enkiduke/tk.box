import {useEffect,useState} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,SectionHead,Switch,remember,remembered,useMutation} from './settings-ui.js';
import {ArtworkTitles} from './artwork-titles.js';
import {LayoutAdvanced,LayoutEditor} from './artwork-layouts.js';
import {ArtworkCollections,ScheduleRow,type ScheduleState} from './artwork-collections.js';
import {JobHistory,type Job} from './artwork-jobs.js';

// Admin › Artwork: custom posters, season posters and episode title cards, made by the artwork engine
// (apps/artwork/overlayrr.py) and sent to Plex, where every Plex app and tk.box picks them up.
type Library={key:string;title:string;type:string};
type Engine={ready:boolean;version?:string;error?:string};
type LayoutType='movie'|'tv'|'custom'|'collection'|'streaming'|'chart';
type Schedules={scrub:{enabled:boolean;time:string};added:{enabled:boolean;minutes:number}};
type Settings={revision:number;libraries:string[];upload:boolean;uploadLogo:boolean;includeSeasons:boolean;includeEpisodes:boolean;includeCollections:boolean;
  missingArt:'stock'|'skip';quality:number;workers:number;language:string;completionLabel:string;defaultLayout:string;layoutByLibrary:Record<string,string>;layoutByType:Partial<Record<LayoutType,string>>;
  schedules:Schedules;keysSet:Record<string,boolean>};
type Overview={settings:Settings;layouts:string[];libraries:Library[];engine:Engine;queue:{running:number|null;queued:number};schedules:Record<keyof Schedules,ScheduleState>};
const tabs=[['titles','Titles'],['layouts','Layouts'],['jobs','Jobs'],['schedules','Schedules'],['settings','Settings']] as const;

// `title` is a Plex rating key, from a title's details (Edit artwork).
export function ArtworkAdmin({params}:{params:URLSearchParams}) {
  const overview=useApi<Overview>('/admin/artwork'),title=params.get('title')??undefined,[tab,setTabState]=useState(()=>title?'titles':remembered('artworkTab','titles')),[advanced,setAdvanced]=useState(false);
  const setTab=(t:string)=>{setTabState(t);remember('artworkTab',t);};
  useEffect(()=>{if(title)setTabState('titles');},[title]);
  const head=<SectionHead title="Artwork"/>;
  if(overview.loading&&!overview.data)return <>{head}<Loading/></>;
  if(overview.error&&!overview.data)return <>{head}<ErrorNotice message={overview.error.message} retry={overview.reload}/></>;
  const data=overview.data!;
  return <>{head}
    <EngineStatus engine={data.engine} recheck={()=>void api<Overview>('/admin/artwork?recheck=1').then(overview.reload,overview.reload)}/>
    <div className="subtabs" role="tablist" aria-label="Artwork">{tabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel">
      {tab==='settings'?<ArtworkSettings data={data} changed={overview.reload}/>
        :tab==='schedules'?<ArtworkSchedules data={data} changed={overview.reload}/>
        :tab==='layouts'?(advanced?<LayoutAdvanced names={data.layouts} inUse={name=>used(data.settings,name)} changed={overview.reload} back={()=>setAdvanced(false)}/>:<LayoutEditor engineReady={data.engine.ready} advanced={()=>setAdvanced(true)}/>)
        :tab==='jobs'?<Jobs data={data}/>
        :<ArtworkTitles ratingKey={title} engineReady={data.engine.ready} upload={data.settings.upload}/>}
    </div>
  </>;
}
// Admin › Collections: its own section, though it shares the artwork engine (and its setup notice) with Artwork.
export function CollectionsAdmin() {
  const overview=useApi<Overview>('/admin/artwork');
  const head=<SectionHead title="Collections"/>;
  if(overview.loading&&!overview.data)return <>{head}<Loading/></>;
  if(overview.error&&!overview.data)return <>{head}<ErrorNotice message={overview.error.message} retry={overview.reload}/></>;
  const data=overview.data!;
  return <>{head}
    <EngineStatus engine={data.engine} recheck={()=>void api<Overview>('/admin/artwork?recheck=1').then(overview.reload,overview.reload)}/>
    <ArtworkCollections engineReady={data.engine.ready}/>
  </>;
}
const used=(settings:Settings,name:string)=>[settings.defaultLayout,...Object.values(settings.layoutByLibrary),...Object.values(settings.layoutByType)].includes(name);
function EngineStatus({engine,recheck}:{engine:Engine;recheck:()=>void}) {
  if(engine.ready)return <p className="muted small" role="status"><span className="status-dot ok" aria-hidden="true"/> Artwork engine ready · Python {engine.version}</p>;
  return <Card title="Set up the artwork engine" description="A bundled Python script, run as its own process." actions={<button onClick={recheck}><Icon name="restart" size={16}/>Check again</button>}>
    <div className="notice error"><span>{engine.error}</span></div>
    <ol className="artwork-steps">
      <li>Install Python 3.10 or later on this server.</li>
      <li>From the tk.box folder, create a virtual environment for it: <code>python3 -m venv artwork-venv</code></li>
      <li>Install its packages: <code>artwork-venv/bin/pip install -r apps/artwork/requirements.txt</code></li>
      <li>Set <code>PYTHON_PATH</code> to <code>artwork-venv/bin/python</code> (its full path) in tk.box’s environment and restart tk.box.</li>
    </ol>
  </Card>;
}

function ArtworkSettings({data,changed}:{data:Overview;changed:()=>void}) {
  const {revision:_,keysSet:___,schedules:__,...saved}=data.settings,[draft,setDraft]=useState(saved),[done,setDone]=useState(false),mutation=useMutation(changed);
  useEffect(()=>{const {revision:_,keysSet:__,schedules:___,...value}=data.settings;setDraft(value);},[data.settings.revision]);
  const set=(patch:Partial<typeof draft>)=>{setDone(false);setDraft(d=>({...d,...patch}));};
  const toggleLibrary=(key:string,on:boolean)=>{const layoutByLibrary={...draft.layoutByLibrary};if(!on)delete layoutByLibrary[key];set({libraries:on?[...draft.libraries,key]:draft.libraries.filter(k=>k!==key),layoutByLibrary});};
  const libraryLayout=(key:string,layout:string)=>{const layoutByLibrary={...draft.layoutByLibrary};if(layout)layoutByLibrary[key]=layout;else delete layoutByLibrary[key];set({layoutByLibrary});};
  const typeLayout=(type:LayoutType,layout:string)=>{const layoutByType={...draft.layoutByType};if(layout)layoutByType[type]=layout;else delete layoutByType[type];set({layoutByType});};
  const layoutOptions=(none:string)=><><option value="">{none}</option>{data.layouts.map(name=><option key={name} value={name}>{name}</option>)}</>;
  const save=()=>void mutation.run(async()=>{
    await api('/admin/artwork/settings','PUT',{expectedRevision:data.settings.revision,...draft,schedules:data.settings.schedules});setDone(true);
  });
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
    <Card title="Libraries">
      {data.libraries.length?<div className="table-scroll"><table><thead><tr><th>Library</th><th>Layout</th></tr></thead><tbody>{data.libraries.map(l=>{const on=draft.libraries.includes(l.key);return <tr key={l.key}>
        <td><label className="checkbox-label"><input type="checkbox" checked={on} onChange={e=>toggleLibrary(l.key,e.target.checked)}/>{l.title}<small className="muted">{l.type==='show'?'TV':'Movies'}</small></label></td>
        <td><select aria-label={`${l.title} layout`} disabled={!on} value={draft.layoutByLibrary[l.key]??''} onChange={e=>libraryLayout(l.key,e.target.value)}>{layoutOptions('By kind of title (below)')}</select></td></tr>;})}</tbody></table></div>
        :<Empty title="No libraries">Your Plex account shows no movie or TV libraries.</Empty>}
      <div className="form-columns">
        <label>Default layout<select value={draft.defaultLayout} onChange={e=>set({defaultLayout:e.target.value})}>{data.layouts.map(name=><option key={name} value={name}>{name}</option>)}</select></label>
        <label>Movies<select value={draft.layoutByType.movie??''} onChange={e=>typeLayout('movie',e.target.value)}>{layoutOptions('The default layout')}</select></label>
        <label>TV shows<select value={draft.layoutByType.tv??''} onChange={e=>typeLayout('tv',e.target.value)}>{layoutOptions('The default layout')}</select></label>
        <label>Custom collections<select value={draft.layoutByType.custom??''} onChange={e=>typeLayout('custom',e.target.value)}>{layoutOptions('Their library’s layout')}</select></label>
        <label>Collections<select value={draft.layoutByType.collection??''} onChange={e=>typeLayout('collection',e.target.value)}>{layoutOptions('Their library’s layout')}</select></label>
        <label>Streaming collections<select value={draft.layoutByType.streaming??''} onChange={e=>typeLayout('streaming',e.target.value)}>{layoutOptions('Their library’s layout')}</select></label>
        <label>Chart collections<select value={draft.layoutByType.chart??''} onChange={e=>typeLayout('chart',e.target.value)}>{layoutOptions('Their library’s layout')}</select></label>
      </div>
    </Card>
    <Card title="What gets made">
      <Switch label="Season posters" checked={draft.includeSeasons} onChange={v=>set({includeSeasons:v})}/>
      <Switch label="Episode title cards" description="Needs a layout with episode options." checked={draft.includeEpisodes} onChange={v=>set({includeEpisodes:v})}/>
      <Switch label="Collection posters" checked={draft.includeCollections} onChange={v=>set({includeCollections:v})}/>
      <label className="narrow">When no suitable artwork is found<select value={draft.missingArt} onChange={e=>set({missingArt:e.target.value as 'stock'|'skip'})}><option value="stock">Use an ordinary poster (episodes keep Plex’s image)</option><option value="skip">Leave the title alone</option></select></label>
    </Card>
    <Card title="Sending to Plex" description="Off: results stay on this server.">
      <Switch label="Send results to Plex" checked={draft.upload} onChange={v=>set({upload:v})}/>
      <Switch label="Also send logos" checked={draft.uploadLogo} disabled={!draft.upload} onChange={v=>set({uploadLogo:v})}/>
      <label className="narrow">Plex label for finished titles<input value={draft.completionLabel} maxLength={60} onChange={e=>set({completionLabel:e.target.value})}/><small>Empty for none.</small></label>
    </Card>
    <p className="muted small">Provider keys are in <a href="#admin?section=connections">Connections</a>.</p>
    <Card title="Output">
      <div className="form-columns">
        <label>JPEG quality<input type="number" min="50" max="100" required value={draft.quality} onChange={e=>set({quality:Number(e.target.value)})}/></label>
        <label>Titles at a time<input type="number" min="1" max="8" required value={draft.workers} onChange={e=>set({workers:Number(e.target.value)})}/></label>
        <label>Artwork language<input value={draft.language} pattern="[a-z]{2}" maxLength={2} required onChange={e=>set({language:e.target.value})}/><small>e.g. en</small></label>
      </div>
    </Card>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row sticky-actions"><button className="primary" disabled={mutation.busy}>Save artwork settings</button>{done&&<span className="success" role="status">Saved.</span>}</div>
  </form>;
}

// Its own tab, saved with the rest of the settings as they were last saved.
function ArtworkSchedules({data,changed}:{data:Overview;changed:()=>void}) {
  const [draft,setDraft]=useState(data.settings.schedules),[done,setDone]=useState(false),mutation=useMutation(changed);
  useEffect(()=>setDraft(data.settings.schedules),[data.settings.revision]);
  const save=()=>void mutation.run(async()=>{
    const {revision,keysSet:_,...saved}=data.settings;
    await api('/admin/artwork/settings','PUT',{expectedRevision:revision,...saved,schedules:draft});setDone(true);
  });
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
    <SchedulesCard schedules={draft} states={data.schedules} set={value=>{setDone(false);setDraft(value);}}/>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row sticky-actions"><button className="primary" disabled={mutation.busy}>Save schedules</button>{done&&<span className="success" role="status">Saved.</span>}</div>
  </form>;
}
// When artwork jobs run on their own: changed titles daily at a server-local time, and newly added titles as Plex adds
// them (with a check every N minutes besides). Collections have their own schedules (Admin › Collections).
function SchedulesCard({schedules,states,set}:{schedules:Schedules;states:Overview['schedules'];set:(value:Schedules)=>void}) {
  return <Card title="Schedules" description="Server local time.">
    <div className="artwork-schedules">
      <ScheduleRow label="Update changed titles" hint="Where artwork, layouts or settings changed." state={states.scrub} value={schedules.scrub} set={scrub=>set({...schedules,scrub})}/>
      <ScheduleRow label="Newly added titles" hint="As Plex adds them, plus a periodic check." state={states.added} value={schedules.added} set={added=>set({...schedules,added})}/>
    </div>
    <p className="muted small">Needs the Plex token in <a href="#admin?section=connections">Connections</a>.</p>
  </Card>;
}

function Jobs({data}:{data:Overview}) {
  const [selected,setSelected]=useState<number>(),[item,setItem]=useState({ratingKey:'',seasons:true,episodes:false,remake:false}),[confirm,setConfirm]=useState(false);
  const mutation=useMutation(()=>invalidate('/admin/artwork/jobs'));
  const start=(body:object)=>void mutation.run(async()=>{const job=await api<Job>('/admin/artwork/jobs','POST',body);setSelected(job.id);});
  const off=!data.engine.ready||mutation.busy,where=data.settings.upload?'':' Sending to Plex is off.';
  return <div className="form-stack">
    {!data.settings.libraries.length&&<div className="notice"><span>Choose the libraries to make artwork for in the Settings tab first.</span></div>}
    <div className="artwork-run">
      <Card title="Update changed titles" description={`Only what changed since the last run.${where}`} actions={<button className="primary" disabled={off} onClick={()=>start({kind:'changed'})}>Run</button>}/>
      <Card title="Rebuild every title" description="Every title, from scratch." actions={<button disabled={off} onClick={()=>setConfirm(true)}>Run</button>}/>
      <Card title="One title" description="By Plex ID, from its Plex web address.">
        <form className="form-stack" onSubmit={e=>{e.preventDefault();start({kind:'item',...item});}}>
          <input aria-label="Plex ID" inputMode="numeric" pattern="\d{1,10}" required placeholder="Plex ID, e.g. 12345" value={item.ratingKey} onChange={e=>setItem(i=>({...i,ratingKey:e.target.value.trim()}))}/>
          <div className="button-row"><label className="checkbox-label"><input type="checkbox" checked={item.seasons} onChange={e=>setItem(i=>({...i,seasons:e.target.checked}))}/>Seasons</label>
            <label className="checkbox-label"><input type="checkbox" checked={item.episodes} onChange={e=>setItem(i=>({...i,episodes:e.target.checked}))}/>Episodes</label>
            <label className="checkbox-label"><input type="checkbox" checked={item.remake} onChange={e=>setItem(i=>({...i,remake:e.target.checked}))}/>Remake</label>
            <button className="primary" disabled={off}>Run</button></div>
        </form>
      </Card>
      <Card title="Send saved results again" description="Re-upload saved results to Plex." actions={<button disabled={off||!data.settings.upload} title={data.settings.upload?undefined:'Turn on Send results to Plex first'} onClick={()=>start({kind:'refresh'})}>Run</button>}/>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <JobHistory script="artwork" selected={selected} select={setSelected}/>
    {confirm&&<Modal title="Rebuild every title?" onClose={()=>setConfirm(false)}>
      <p>Every title in the chosen libraries is made again, even where nothing changed{data.settings.upload?', and sent to Plex':''}. On a large library this takes a long time and many artwork requests.</p>
      <div className="button-row"><button className="primary" onClick={()=>{setConfirm(false);start({kind:'all'});}}>Rebuild all</button><button onClick={()=>setConfirm(false)}>Cancel</button></div>
    </Modal>}
  </div>;
}
