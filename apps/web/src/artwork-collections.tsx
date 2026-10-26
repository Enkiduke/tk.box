import {useEffect,useRef,useState} from 'react';
import type {CatalogPage} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,useDebounced,invalidate} from './hooks.js';
import {Artwork,Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,Switch,date as when,plural,remember,remembered,useMutation} from './settings-ui.js';
import {openConsole,type Job} from './admin-console.js';
import {exportCollection,plexOnly,readCollections,type Definition,type ListFilter,type ListSort,type Member,type Source,type Visibility} from './collection-files.js';
import {chooseTitles,type Candidate,type LeftOut} from './list-choice.js';
import {ScheduleRow,type ScheduleState} from './schedule-picker.js';
import type {Scheduled} from '../../../packages/contracts/src/schedule.js';
import {hidesFromRecent} from '../../../packages/contracts/src/collections.js';

// Admin › Collections: every Plex collection the engine keeps, in one grid. Franchise and streaming collections come
// from TMDb and your libraries; custom and seasonal ones are defined here (by hand, from a curated universe or a public
// list), and Radarr can fetch a seasonal collection's missing movies. What's here is what Plex holds: turning one off,
// or removing it, takes it out of Plex on the next run. Definitions are kept in the engine's own format.
type Library={key:string;title:string;type:string};
// A franchise or streaming collection set apart from how it's made: turned off, where it shows, or titles taken out (by Plex ID).
type Automatic={name:string;library:string;kind:'franchise'|'streaming';enabled?:boolean;visibility?:Visibility;exclude?:string[]};
type Franchise={sync:boolean;franchises:boolean;minItems:number;mode:'sync'|'append';streaming:'off'|'originals'|'available';region:string;recent:boolean;recentMovieDays:number;recentEpisodeDays:number};
type Radarr={url:string;rootFolder:string;qualityProfileId:number;search:boolean};
type Kept={name:string;library:string;kind:'franchise'|'streaming'|'custom';items:number;rating_key?:string;off?:boolean};
type Schedules={custom:Scheduled;all:Scheduled;added:Scheduled};
type View={revision:number;definitions:Definition[]|null;automatic:Automatic[];franchise:Franchise;radarr:Radarr;radarrKeySet:boolean;defaults:Definition[];kept:{updated:string|null;collections:Kept[]};schedules:Schedules;scheduleStates:Record<keyof Schedules,ScheduleState>;libraries:Library[];upload:boolean};
type Draft={definitions:Definition[];automatic:Automatic[];franchise:Franchise;radarr:Radarr;schedules:Schedules};
const tabs=[['collections','Collections'],['calendar','Calendar'],['schedules','Schedules'],['settings','Settings']] as const;
// New collections start out of every Home screen and recommendation row.
const hidden={home:false,shared:false,recommended:false};
const keyOf=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/collection$/,'');
const idOf=(c:{library:string;name:string})=>`${c.library}\0${keyOf(c.name)}`;
const memberText=(m:Member)=>m.tmdb_id?`tmdb:${m.tmdb_id}`:m.rating_key?`plex:${m.rating_key}`:m.imdb_id?`imdb:${m.imdb_id}`:m.year?`${m.title} | ${m.year}`:m.title??'';
const parseMembers=(text:string):Member[]=>text.split('\n').map(s=>s.trim()).filter(Boolean).map(line=>{
  if(/^imdb:tt\d+$/i.test(line))return {imdb_id:line.slice(5).toLowerCase()};
  let match=line.match(/^(tmdb|plex):(\d+)$/i);if(match)return match[1]!.toLowerCase()==='tmdb'?{tmdb_id:Number(match[2])}:{rating_key:match[2]!};
  match=line.match(/^(.*?)\s*\|\s*(\d{4})$/);return match?{title:match[1]!.trim(),year:Number(match[2])}:{title:line};
});
// One tile in the grid: a franchise or streaming collection, or a custom or seasonal one (`index` into the definitions).
type Kind='franchise'|'streaming'|'custom'|'seasonal';
type Tile={id:string;name:string;library:string;kind:Kind;on:boolean;items?:number;ratingKey?:string;when?:string;index?:number};
const kinds:[Kind,string][]=[['franchise','Franchise'],['streaming','Streaming'],['custom','Custom'],['seasonal','Seasonal']];
const kindLabel=(k:Kind)=>kinds.find(([id])=>id===k)![1];
// 10/01-10/31 as "Oct 1 – Oct 31".
const season=(schedule:string)=>schedule.split('-').map(part=>{const [m,d]=part.split('/').map(Number);return new Date(2000,m!-1,d).toLocaleDateString(undefined,{month:'short',day:'numeric'});}).join(' – ');

export function ArtworkCollections({engineReady}:{engineReady:boolean}) {
  const view=useApi<View>(engineReady?'/admin/artwork/collections':undefined),[draft,setDraft]=useState<Draft>();
  const [editing,setEditing]=useState<number>(),[opened,setOpened]=useState<string>(),[discover,setDiscover]=useState(false),[importing,setImporting]=useState(false),[dirty,setDirty]=useState(false),[saved,setSaved]=useState(''),[tab,setTabState]=useState(()=>(t=>tabs.some(([id])=>id===t)?t:'collections')(remembered('collectionsTab','collections')));
  const setTab=(t:string)=>{setTabState(t);remember('collectionsTab',t);};
  const mutation=useMutation(view.reload);
  const reset=()=>{const d=view.data;if(!d)return;setDraft({definitions:(JSON.parse(JSON.stringify(d.definitions??d.defaults)) as (Definition&{sync?:string})[]).map(({sync:_,...x})=>x),automatic:d.automatic??[],franchise:d.franchise,radarr:d.radarr,schedules:d.schedules});setDirty(false);};
  useEffect(reset,[view.data?.revision,!!view.data]);
  // Franchise counts from Plex now (through the Discover index), so movies gone since the last full run show at once.
  const [live,setLive]=useState<Map<string,number>>();
  useEffect(()=>{if(!view.data)return;let current=true;
    void api<{results:{library:string;name:string;items:number}[];index:{built:number|null}}>('/admin/artwork/collections/discover','POST',{mode:'franchises'})
      .then(r=>{if(current&&r.index.built!==null)setLive(new Map(r.results.map(c=>[idOf(c),c.items])));},()=>{});
    return ()=>{current=false;};},[!!view.data,view.data?.kept.updated]);
  if(!engineReady)return <Empty title="The artwork engine isn’t set up">Set it up (above) to manage collections.</Empty>;
  if(view.loading&&!view.data)return <Loading/>;
  if(view.error)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data||!draft)return null;
  const data=view.data,libraries=data.libraries.filter(l=>['movie','show'].includes(l.type));
  const change=(next:Partial<Draft>)=>{setDraft({...draft,...next});setDirty(true);setSaved('');};
  const franchise=(patch:Partial<Franchise>)=>change({franchise:{...draft.franchise,...patch}}),radarr=(patch:Partial<Radarr>)=>change({radarr:{...draft.radarr,...patch}});
  const setDefinition=(index:number,value:Definition|null)=>change({definitions:value?draft.definitions.map((d,i)=>i===index?value:d):draft.definitions.filter((_,i)=>i!==index)});
  // A franchise or streaming collection that's on, with no visibility of its own and nothing taken out, needs no entry.
  const setAutomatic=(tile:Tile,patch:Partial<Automatic>)=>{
    const rest=draft.automatic.filter(a=>idOf(a)!==tile.id),current=draft.automatic.find(a=>idOf(a)===tile.id);
    const next:Automatic={name:tile.name,library:tile.library,kind:tile.kind as Automatic['kind'],...current,...patch};
    if(!next.exclude?.length)delete next.exclude;
    change({automatic:next.enabled===false||next.visibility||next.exclude?[...rest,next]:rest});
  };
  // Saving also applies every collection to Plex (when results go to Plex); the run opens in the Console.
  const save=()=>void mutation.run(async()=>{
    await api('/admin/artwork/collections','PUT',{expectedRevision:data.revision,value:draft});
    if(!data.upload){setSaved('Saved. Turn on Send results to Plex in Artwork › Settings to apply it.');return;}
    openConsole(await api<Job>('/admin/artwork/collections/run','POST',{kind:'all',mode:'apply'}));invalidate('/admin/artwork/jobs');setSaved('Saved and applying to Plex.');
  });
  const presets=data.defaults.filter(p=>!draft.definitions.some(e=>keyOf(e.name)===keyOf(p.name)));
  const tiles=collectionTiles(draft,data.kept.collections,data.kept.updated!==null,live),open=tiles.find(t=>t.id===opened);
  const types=draft.franchise.franchises||draft.franchise.streaming!=='off';
  return <div className="form-stack">
    <div className="subtabs" role="tablist" aria-label="Collections">{tabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel" className="form-stack">
      {tab==='settings'?<>
        <Card title="Made for you" description="Turning one off removes its collections from Plex on the next run.">
          <Switch label="Franchise collections" description="Movies from the same TMDb collection, e.g. The Lord of the Rings" checked={draft.franchise.franchises} onChange={v=>franchise({franchises:v})}/>
          <Switch label="Streaming collections" description="TV shows by streaming service, e.g. Netflix Shows" checked={draft.franchise.streaming!=='off'} onChange={v=>franchise({streaming:v?'originals':'off'})}/>
          {draft.franchise.streaming!=='off'&&<div className="form-columns">
            <label>Shows it holds<select value={draft.franchise.streaming} onChange={e=>franchise({streaming:e.target.value as Franchise['streaming']})}><option value="originals">Shows that aired on the service</option><option value="available">Shows streaming there now</option></select></label>
            {draft.franchise.streaming==='available'&&<label>Streaming country<input maxLength={2} pattern="[A-Z]{2}" value={draft.franchise.region} onChange={e=>franchise({region:e.target.value.toUpperCase()})}/></label>}
          </div>}
          {types&&<div className="form-columns">
            <label>Titles a collection needs<input type="number" min="1" max="50" value={draft.franchise.minItems} onChange={e=>franchise({minItems:Number(e.target.value)})}/></label>
            <label>Membership<select value={draft.franchise.mode} onChange={e=>franchise({mode:e.target.value as Franchise['mode']})}><option value="sync">Add and remove to match TMDb</option><option value="append">Only add</option></select></label></div>}
          <Switch label="Newly Released and New Episodes" checked={draft.franchise.recent} onChange={v=>franchise({recent:v})}/>
          {draft.franchise.recent&&<div className="form-columns">
            <label>Newly Released: movies from the last (days)<input type="number" min="1" max="3650" value={draft.franchise.recentMovieDays} onChange={e=>franchise({recentMovieDays:Number(e.target.value)})}/></label>
            <label>New Episodes: aired in the last (days)<input type="number" min="1" max="3650" value={draft.franchise.recentEpisodeDays} onChange={e=>franchise({recentEpisodeDays:Number(e.target.value)})}/></label></div>}
        </Card>
        <Card title="Radarr downloads" description="For seasonal collections that download missing movies.">
          {!data.radarr.url&&<p className="muted small">Radarr isn’t connected. Add it in <a href="#admin?section=connections">Admin › Connections</a>.</p>}
          <QualityProfile value={draft.radarr.qualityProfileId} set={qualityProfileId=>radarr({qualityProfileId})}/>
          <Switch label="Search for movies when added" checked={draft.radarr.search} onChange={v=>radarr({search:v})}/>
        </Card>
      </>:tab==='schedules'?<Card title="Schedules" description="Server local time.">
          {!data.upload&&<p className="muted small">Send results to Plex is off, so these are skipped until it’s on.</p>}
          <div className="artwork-schedules">
            <ScheduleRow label="Every collection" hint="Franchise, streaming and chart, then custom and seasonal." state={data.scheduleStates.all} min={60} value={draft.schedules.all} set={all=>change({schedules:{...draft.schedules,all}})}/>
            <ScheduleRow label="Custom and seasonal" hint="Syncs custom; shows or hides seasonal." state={data.scheduleStates.custom} min={60} value={draft.schedules.custom} set={custom=>change({schedules:{...draft.schedules,custom}})}/>
            <ScheduleRow label="Newly added titles" hint="As Plex adds them, plus a periodic check." state={data.scheduleStates.added} min={5} value={draft.schedules.added} set={added=>change({schedules:{...draft.schedules,added}})}/>
          </div>
          <Switch label="Also with every full artwork run" description="Runs every collection before the artwork." checked={draft.franchise.sync} onChange={v=>franchise({sync:v})}/>
        </Card>:tab==='calendar'?<Card title="Calendar" description="When each seasonal collection shows in Plex.">
        <SeasonCalendar definitions={draft.definitions} open={setEditing}/>
      </Card>:<Card title="Collections" description={data.kept.updated?`Plex as of ${new Date(`${data.kept.updated}T00:00`).toLocaleDateString()}. Turning one off removes it from Plex on the next run.`:'Turning one off removes it from Plex on the next run.'} actions={<>
          <button onClick={()=>setDiscover(true)}><Icon name="explore" size={16}/>Discover</button>
          <button onClick={()=>setImporting(true)}><Icon name="upload" size={16}/>Import</button>
          <button onClick={()=>{change({definitions:[...draft.definitions,{name:'New collection',library:libraries[0]?.title??'',type:libraries[0]?.type==='show'?'tv':'movie',enabled:false,members:[],visibility:hidden}]});setEditing(draft.definitions.length);}}><Icon name="plus" size={16}/>New</button></>}>
        {data.definitions===null&&<p className="muted small">Seasonal presets, all off. Pick a library, turn some on, then save.</p>}
        <CollectionGrid tiles={tiles} open={t=>t.index===undefined?setOpened(t.id):setEditing(t.index)}
          toggle={(t,on)=>t.index===undefined?setAutomatic(t,{enabled:on}):setDefinition(t.index,{...draft.definitions[t.index]!,enabled:on})}/>
        {presets.length>0&&data.definitions!==null&&<div className="button-row"><button onClick={()=>change({definitions:[...draft.definitions,...JSON.parse(JSON.stringify(presets)) as Definition[]]})}>Add the {presets.length} seasonal presets you don’t have</button></div>}
      </Card>}
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {(dirty||saved)&&<div className="button-row sticky-actions">{dirty&&<><button className="primary" disabled={mutation.busy} onClick={save}>Save collections</button><button onClick={reset}>Discard changes</button></>}{saved&&!dirty&&<span className="success" role="status">{saved}</span>}</div>}
    {editing!==undefined&&draft.definitions[editing]&&<EditDefinition value={draft.definitions[editing]!} libraries={libraries} onClose={()=>setEditing(undefined)}
      save={value=>{setDefinition(editing,value);setEditing(undefined);}} remove={()=>{setDefinition(editing,null);setEditing(undefined);}}/>}
    {open&&<AutomaticCollection tile={open} setting={draft.automatic.find(a=>idOf(a)===open.id)} onClose={()=>setOpened(undefined)} save={patch=>{setAutomatic(open,patch);setOpened(undefined);}}/>}
    {discover&&<Discover libraries={libraries} existing={draft.definitions} onClose={()=>setDiscover(false)} add={entry=>{change({definitions:[...draft.definitions,entry]});setDiscover(false);}}/>}
    {importing&&<ImportCollections libraries={libraries} existing={draft.definitions} onClose={()=>setImporting(false)}
      add={entries=>{const replaced=new Set(entries.map(idOf));change({definitions:[...draft.definitions.filter(d=>!replaced.has(idOf(d))),...entries]});setImporting(false);}}/>}
  </div>;
}
// The grid's tiles: the franchise and streaming collections the last run found (for the kinds that are on; off ones
// too, while they still have the titles), then the custom and seasonal definitions, matched to what the last run kept
// for their posters. A setting for one the last run no longer found (its titles are gone) stays saved, so it's still
// off if they come back, but isn't shown; before any run has been recorded, the settings are all there is to show.
// With `live` counts (Plex now), a franchise collection's count is today's, and one that's off and has fallen below
// the titles a collection needs is left out, as the next run would.
function collectionTiles(draft:Draft,kept:Kept[],recorded:boolean,live?:Map<string,number>):Tile[] {
  const on={franchise:draft.franchise.franchises,streaming:draft.franchise.streaming!=='off'},settings=new Map(draft.automatic.map(a=>[idOf(a),a]));
  const auto=new Map<string,Tile>();
  for(const k of kept)if(k.kind!=='custom'&&on[k.kind])auto.set(idOf(k),{id:idOf(k),name:k.name,library:k.library,kind:k.kind,on:true,items:k.items,ratingKey:k.rating_key});
  if(!recorded)for(const a of draft.automatic)if(on[a.kind]&&!auto.has(idOf(a)))auto.set(idOf(a),{id:idOf(a),name:a.name,library:a.library,kind:a.kind,on:true});
  for(const t of auto.values()){
    t.on=settings.get(t.id)?.enabled!==false;
    if(live&&t.kind==='franchise'){t.items=live.get(t.id)??0;if(!t.on&&t.items<draft.franchise.minItems)auto.delete(t.id);}
  }
  const custom=new Map(kept.filter(k=>k.kind==='custom').map(k=>[idOf(k),k]));
  const defined=draft.definitions.map((d,index):Tile=>{const k=custom.get(idOf(d));return {id:`custom:${index}`,name:d.name,library:d.library,kind:d.schedule?'seasonal':'custom',on:d.enabled!==false,
    items:k?.items??(d.source?undefined:d.members?.length??0),ratingKey:k?.rating_key,when:d.schedule||undefined,index};});
  return [...auto.values(),...defined].sort((a,b)=>a.name.localeCompare(b.name));
}
function CollectionGrid({tiles,open,toggle}:{tiles:Tile[];open:(tile:Tile)=>void;toggle:(tile:Tile,on:boolean)=>void}) {
  const [kind,setKind]=useState<'all'|Kind>('all'),[query,setQuery]=useState(''),words=query.trim().toLowerCase();
  const count=(k:Kind)=>tiles.filter(t=>t.kind===k).length,present=kinds.filter(([k])=>count(k)>0);
  const shown=tiles.filter(t=>(kind==='all'||t.kind===kind)&&(!words||`${t.name} ${t.library}`.toLowerCase().includes(words)));
  if(!tiles.length)return <Empty title="No collections yet">Add one, find one with Discover, or apply to make the franchise collections.</Empty>;
  return <>
    <div className="setting-line">
      {present.length>1&&<div className="toggle-group" role="radiogroup" aria-label="Kind">{([['all','All'],...present] as ['all'|Kind,string][]).map(([k,label])=><button key={k} type="button" role="radio" aria-checked={kind===k} onClick={()=>setKind(k)}>{label} {k==='all'?tiles.length:count(k)}</button>)}</div>}
      <input className="grow" type="search" placeholder="Search collections" aria-label="Search collections" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    {shown.length?<ul className="kept-grid">{shown.map(t=><li key={t.id} className={`kept-card${t.on?'':' off'}`} title={`${t.name} · ${t.library} · ${kindLabel(t.kind)}${t.on?'':' · Off'}`}>
      <button type="button" className="kept-open" aria-label={`${t.name}, ${kindLabel(t.kind)}`} onClick={()=>open(t)}>
        <Artwork src={t.ratingKey?`/api/v1/catalog/collections/${t.ratingKey}/artwork`:undefined} alt={t.name} fallback={<><Icon name="collection"/><span>{t.name}</span></>}/></button>
      {t.items!==undefined&&<span className="kept-count" aria-label={`${t.items} titles`}>{t.items}</span>}
      {t.when&&<span className="kept-when">{season(t.when)}</span>}
      <input type="checkbox" role="switch" className="switch kept-switch" aria-label={`${t.name} on`} checked={t.on} onChange={e=>toggle(t,e.target.checked)}/></li>)}</ul>
      :<Empty title="No matches">Try another search.</Empty>}
  </>;
}
// The seasonal collections on one year, Jan to Dec: a bar for when each shows (one that runs past New Year wraps to
// January), ordered by when it starts, with a line at today. Positions are days in a leap year, so Feb 29 has a place.
const dayOf=(part:string)=>{const [m,d]=part.split('/').map(Number);return (Date.UTC(2000,m!-1,d)-Date.UTC(2000,0,1))/864e5;};
const monthDays=[31,29,31,30,31,30,31,31,30,31,30,31],months=monthDays.map(n=>`${n}fr`).join(' ');
function SeasonCalendar({definitions,open}:{definitions:Definition[];open:(index:number)=>void}) {
  const rows=definitions.map((d,index)=>({d,index})).filter(({d})=>/^\d{2}\/\d{2}-\d{2}\/\d{2}$/.test(d.schedule??''))
    .map(r=>{const [from,to]=r.d.schedule!.split('-').map(dayOf) as [number,number];return {...r,from,to:to+1};}).sort((a,b)=>a.from-b.from);
  if(!rows.length)return <Empty title="No seasonal collections">Give a collection a Shown from–to range to see it here.</Empty>;
  const now=new Date(),today=dayOf(`${now.getMonth()+1}/${now.getDate()}`),pct=(day:number)=>`${day/366*100}%`;
  return <div className="season-calendar" style={{['--today' as string]:pct(today+.5)}}>
    <div className="season-row season-head"><span/><div className="season-track" style={{gridTemplateColumns:months}}>
      {monthDays.map((_,m)=><span key={m}>{new Date(2000,m,1).toLocaleDateString(undefined,{month:'short'})}</span>)}</div></div>
    {rows.map(({d,index,from,to})=>{const live=from<to?today>=from&&today<to:today>=from||today<to;
      return <button key={index} type="button" className={`season-row${d.enabled===false?' off':''}`} title={`${d.name} · ${season(d.schedule!)}${d.enabled===false?' · Off':''}`} onClick={()=>open(index)}>
        <span className="season-name"><strong>{d.name}</strong><small>{season(d.schedule!)}{d.enabled===false?' · Off':live?' · Showing now':''}</small></span>
        <div className="season-track" style={{gridTemplateColumns:months}}>{monthDays.map((_,m)=><i key={m}/>)}
          {(from<to?[[from,to]]:[[from,366],[0,to]]).map(([a,b])=><b key={a} style={{left:pct(a!),width:pct(b!-a!)}}/>)}</div>
      </button>;})}
  </div>;
}
// A franchise or streaming collection: its titles as Plex has them (TMDb decides what's in it), whether it's on, and
// where it shows.
function AutomaticCollection({tile,setting,onClose,save}:{tile:Tile;setting?:Automatic;onClose:()=>void;save:(patch:Partial<Automatic>)=>void}) {
  const [on,setOn]=useState(setting?.enabled!==false),[visibility,setVisibility]=useState(setting?.visibility),[exclude,setExclude]=useState(setting?.exclude??[]);
  const titles=useApi<CatalogPage>(tile.ratingKey?`/catalog/collections/${tile.ratingKey}/items?limit=60`:undefined),all=titles.data?.items??[],items=all.filter(i=>!exclude.includes(i.id));
  const more=(titles.data?.total??all.length)-all.length;
  return <Modal title={tile.name} onClose={onClose}>
    <form className="collection-editor" onSubmit={e=>{e.preventDefault();save({enabled:on,visibility,exclude});}}>
      <div className="collection-editor-head">
        <h2 className="collection-editor-title">{tile.name}</h2>
        <Switch label={on?'On':'Off'} checked={on} onChange={setOn}/>
      </div>
      <p className="muted small">{kindLabel(tile.kind)} collection in {tile.library}. Its titles come from TMDb and follow your library{tile.kind==='streaming'?' and the services’ catalogs':''}; ones you remove stay out.{on?'':' Off, it comes out of Plex on the next run.'}</p>
      <section className="collection-editor-titles">
        <div className="collection-editor-section-head"><h3>Titles {tile.items!==undefined&&<span className="count">{tile.items}</span>}</h3></div>
        {!tile.ratingKey?<p className="collection-editor-empty muted small">{on?'Not in Plex yet. Apply to make it.':'Not in Plex.'}</p>
          :titles.error?<ErrorNotice message={titles.error.message} retry={titles.reload}/>:!titles.data?<Loading/>
          :<div className="collection-editor-grid"><ul className="title-grid">{items.map(i=><li key={i.id} className="title-tile" title={i.year?`${i.title} (${i.year})`:i.title}>
            <span className="title-tile-art"><Artwork src={i.posterUrl} alt="" fallback={<><Icon name={i.type==='movie'?'movies':'shows'}/><span>{i.title}</span></>}/>
              <button type="button" className="icon-button title-tile-remove" aria-label={`Remove ${i.title}`} onClick={()=>setExclude(x=>[...x,i.id])}><Icon name="close" size={14}/></button></span>
            <span className="title-tile-name">{i.title}</span>{i.year?<small>{i.year}</small>:null}</li>)}</ul>
            {more>0&&<p className="muted small">And {more} more.</p>}</div>}
        <Removed count={exclude.length} restore={()=>setExclude([])}/>
      </section>
      <div className="collection-editor-options">
        <section className="collection-editor-panel">
          <Switch label="Show on Home" description={`${homeHint}${visibility?'':' Left as Plex has it until you change it.'}`} checked={onHome(visibility)} onChange={v=>setVisibility(everywhere(v))}/>
        </section>
      </div>
      <div className="button-row collection-editor-foot"><button className="primary">Done</button><button type="button" onClick={onClose}>Cancel</button><span className="muted small">Save collections to keep this.</span></div>
    </form>
  </Modal>;
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
// A member's poster and name from TMDb, kept for the page's life so reopening a collection doesn't ask again.
// undefined while it is being looked up; null when TMDb has no match (or isn't set up).
type TitleCard={tmdb_id:number;title:string;year?:number;poster?:string};
const cards=new Map<string,TitleCard|null>(),cardKey=(type:Definition['type'],m:Member)=>`${type}:${memberText(m)}`;
let tmdbConfigured=true;
const plain=({rating_key,tmdb_id,imdb_id,title,year}:Member):Member=>({...rating_key?{rating_key}:{},...tmdb_id?{tmdb_id}:{},...imdb_id?{imdb_id}:{},...title?{title}:{},...Number(year)?{year:Number(year)}:{}});
function useTitleCards(type:Definition['type'],members:Member[]) {
  const [,redraw]=useState(0),missing=members.filter(m=>!cards.has(cardKey(type,m))).slice(0,500),wanted=missing.map(memberText).join('\n');
  useEffect(()=>{
    if(!missing.length)return;
    const done=(items:(TitleCard|null)[])=>{missing.forEach((m,i)=>cards.set(cardKey(type,m),items[i]??null));redraw(n=>n+1);};
    api<{configured:boolean;items:(TitleCard|null)[]}>('/admin/artwork/collections/titles/lookup','POST',{type,members:missing.map(plain)})
      .then(r=>{tmdbConfigured=r.configured;done(r.items);},()=>done([]));
  },[type,wanted]);
  return (m:Member)=>cards.get(cardKey(type,m));
}
function TitleTile({member,card,type,remove,why}:{member:Member;card:TitleCard|null|undefined;type:Definition['type'];remove?:()=>void;why?:string}) {
  const name=card?.title||member.title||(member.rating_key?`Plex title ${member.rating_key}`:member.imdb_id??`TMDb ${member.tmdb_id}`),year=card?.year??member.year;
  const src=card?.poster??(member.rating_key?`/api/v1/catalog/items/${member.rating_key}/artwork?kind=poster`:undefined),label=year?`${name} (${year})`:name;
  return <li className={`title-tile${why?' left-out':''}`} title={why?`${label}: ${why}`:label}>
    <span className="title-tile-art">{card===undefined&&!member.rating_key?<span className="title-tile-wait"/>:<Artwork src={src} alt="" fallback={<><Icon name={type==='tv'?'shows':'movies'}/><span>{name}</span></>}/>}
      {remove&&<button type="button" className="icon-button title-tile-remove" aria-label={`Remove ${name}`} onClick={remove}><Icon name="close" size={14}/></button>}</span>
    <span className="title-tile-name">{name}</span>{why?<small>{why}</small>:year?<small>{year}</small>:null}
  </li>;
}
function TitleGrid({type,members,remove,left=[]}:{type:Definition['type'];members:Member[];remove?:(index:number)=>void;left?:LeftOut[]}) {
  const card=useTitleCards(type,[...members,...left.map(l=>l.member)]);
  return <ul className="title-grid">{members.map((m,i)=><TitleTile key={`${memberText(m)}\0${i}`} member={m} card={card(m)} type={type} remove={remove&&(()=>remove(i))}/>)}
    {left.map((l,i)=><TitleTile key={`left\0${memberText(l.member)}\0${i}`} member={{...l.member,...(l.member.title?{}:{title:l.title})}} card={card(l.member)} type={type} why={l.why}/>)}</ul>;
}
// TMDb's matches for what's typed, as posters; picking one adds it by its TMDb ID.
function TitleSearch({type,members,add}:{type:Definition['type'];members:Member[];add:(m:Member)=>void}) {
  const [query,setQuery]=useState(''),q=useDebounced(query.trim(),350),[found,setFound]=useState<{q:string;results?:TitleCard[];error?:string}>();
  useEffect(()=>{
    if(!q){setFound(undefined);return;}
    const stop=new AbortController();setFound(f=>({q,results:f?.results}));
    api<{results:TitleCard[]}>(`/admin/artwork/collections/titles/search?${new URLSearchParams({q,type})}`,'GET',undefined,stop.signal)
      .then(r=>setFound({q,results:r.results}),(e:Error)=>{if(!stop.signal.aborted)setFound({q,error:e.message});});
    return()=>stop.abort();
  },[q,type]);
  const picked=new Set(members.flatMap(m=>m.tmdb_id?[m.tmdb_id]:[])),noun=type==='tv'?'shows':'movies';
  return <div className="title-search">
    <label className="title-search-box"><Icon name="search" size={18}/><input type="search" aria-label={`Search for ${noun}`} placeholder={`Search for ${noun} to add`} value={query}
      onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();if(e.key==='Escape'&&query){e.preventDefault();e.stopPropagation();setQuery('');}}}/>
      {query&&<button type="button" className="icon-button" aria-label="Clear search" onClick={()=>setQuery('')}><Icon name="close" size={16}/></button>}</label>
    {query.trim()&&<div className="title-search-results">
      {found?.error?<p className="danger small">{found.error}</p>:!found?.results?<p className="muted small">Searching…</p>:!found.results.length?<p className="muted small">No {noun} match “{found.q}”.</p>
        :<ul className="title-grid">{found.results.map(c=>{const added=picked.has(c.tmdb_id);return <li key={c.tmdb_id} className="title-tile">
          <button type="button" className={`title-tile-art title-pick${added?' added':''}`} disabled={added} aria-label={added?`${c.title} is added`:`Add ${c.title}`} onClick={()=>{cards.set(cardKey(type,{tmdb_id:c.tmdb_id}),c);add({tmdb_id:c.tmdb_id});}}>
            <Artwork src={c.poster} alt="" fallback={<><Icon name={type==='tv'?'shows':'movies'}/><span>{c.title}</span></>}/>
            <span className="title-pick-badge"><Icon name={added?'check':'plus'} size={16}/></span></button>
          <span className="title-tile-name">{c.title}</span>{c.year?<small>{c.year}</small>:null}</li>;})}</ul>}
    </div>}
  </div>;
}
// One switch for where a collection shows: everyone's Home screen and the library's Recommended tab, together.
const homeHint='On everyone’s Home screen and in the library’s Recommended tab.';
const onHome=(v?:Visibility)=>!!v&&Object.values(v).some(Boolean),everywhere=(on:boolean)=>({home:on,shared:on,recommended:on});
// Without `remove`, it's a collection found in Discover that isn't added yet: Add checks it with `check` (a problem
// keeps it open), and `found` is the partly owned TMDb collection it came from, if any.
function EditDefinition({value,libraries,onClose,save,remove,check,found}:{value:Definition;libraries:Library[];onClose:()=>void;save:(value:Definition)=>void;remove?:()=>void;check?:(value:Definition)=>string|undefined;found?:Row}) {
  const [d,setD]=useState(value),[members,setMembers]=useState(value.members??[]),[exclude,setExclude]=useState(value.exclude??[]),[paste,setPaste]=useState<string>(),[problem,setProblem]=useState(''),[exporting,setExporting]=useState(false);
  const set=(patch:Partial<Definition>)=>setD(x=>({...x,...patch}));
  const refreshed=!!d.source&&d.source.refresh!==false,visibility=d.visibility??{};
  const add=(more:Member[])=>{
    const back=new Set(more.map(memberText));setExclude(list=>list.filter(m=>!back.has(memberText(m))));
    setMembers(list=>{const have=new Set(list.map(memberText));return [...list,...more.filter(m=>{const k=memberText(m);return !have.has(k)&&!!have.add(k);})];});
  };
  // A removed title is remembered, so it stays out of a list that's kept up to date and comes out of the Plex collection.
  const drop=(gone:Member[])=>{const keys=new Set(gone.map(memberText));setMembers(list=>list.filter(m=>!keys.has(memberText(m))));setExclude(list=>[...list.filter(m=>!keys.has(memberText(m))),...gone]);};
  // A list that's kept up to date is read whole once (and again when its address changes); which of its titles the
  // collection keeps is then worked out here as the size, sort, filters and removed titles change, as each run would.
  const listUrl=useDebounced(refreshed?d.source!.url.trim():'',600),[list,setList]=useState<{rows?:Candidate[];details?:boolean;error?:string}>();
  useEffect(()=>{
    if(!listUrl){setList(undefined);return;}
    const stop=new AbortController();setList({});
    api<Preview>('/admin/artwork/collections/discover','POST',{mode:'preview',url:listUrl,type:d.type,limit:250,candidates:true},stop.signal)
      .then(r=>setList({rows:r.candidates??[],details:r.details}),(e:Error)=>{if(!stop.signal.aborted)setList({error:e.message});});
    return()=>stop.abort();
  },[listUrl,d.type]);
  const size=Math.min(250,Math.max(1,Math.round(d.source?.limit??50)||50));
  const chosen=refreshed&&list?.rows?chooseTitles(list.rows,d.source!,size,exclude):undefined;
  const out=new Set(exclude.map(memberText)),shown=chosen?chosen.kept.map(r=>r.member):members.filter(m=>!out.has(memberText(m)));
  // The collection as it stands in the editor, as Done saves it and Export copies it.
  const finished=()=>{const next:Definition={...d,members:shown,exclude};if(!exclude.length)delete next.exclude;if(next.rules&&!Object.keys(next.rules).length)delete next.rules;if(!next.schedule)delete next.schedule;if(!next.acquire){delete next.acquire;delete next.hide_recent;if(next.cleanup&&next.cleanup!=='keep')delete next.cleanup;}if(next.cleanup==='rotate'&&!refreshed)delete next.cleanup;return next;};
  return <Modal title={d.name||'Collection'} onClose={onClose}>
    <form className="collection-editor" onSubmit={e=>{e.preventDefault();const next=finished();const wrong=check?.(next);if(wrong){setProblem(wrong);return;}save(next);}}>
      <div className="collection-editor-head">
        <input className="collection-editor-name" aria-label="Name" placeholder="Collection name" required maxLength={120} value={d.name} onChange={e=>set({name:e.target.value})}/>
        <Switch label={d.enabled!==false?'On':'Off'} checked={d.enabled!==false} onChange={v=>set({enabled:v})}/>
      </div>
      <div className="collection-editor-fields">
        <label>Plex library<select required value={d.library} onChange={e=>{const l=libraries.find(x=>x.title===e.target.value);set({library:e.target.value,...(l?{type:l.type==='show'?'tv':'movie'}:{})});}}><option value="">Choose a library</option>{libraries.map(l=><option key={l.key} value={l.title}>{l.title}</option>)}{d.library&&!libraries.some(l=>l.title===d.library)&&<option value={d.library}>{d.library}</option>}</select></label>
        <label>Shown from–to<input placeholder="All year, or 10/01-10/31" pattern="\d{2}/\d{2}-\d{2}/\d{2}" title="MM/DD-MM/DD" value={d.schedule??''} onChange={e=>set({schedule:e.target.value.trim()})}/></label>
      </div>
      {found&&keyOf(d.name)===keyOf(found.name)&&d.library===found.library&&<p className="muted small">Named like its franchise collection, it takes that collection over in Plex.</p>}
      {d.source&&<section className="collection-editor-panel">
        <div className="collection-editor-source">
          <label className="grow">List address<input type="url" value={d.source.url} onChange={e=>set({source:{...d.source!,url:e.target.value}})}/></label>
          <label>Collection size<input type="number" min="1" max="250" value={d.source.limit??50} onChange={e=>set({source:{...d.source!,limit:Number(e.target.value)}})}/></label>
        </div>
        <Switch label="Keep up to date from the list" description="Each collection run uses the list as it is then. Turn this off to pick titles yourself." checked={d.source.refresh!==false} onChange={v=>set({source:{...d.source!,refresh:v}})}/>
        {refreshed&&<ListChoice source={d.source} type={d.type} rows={list?.rows} change={source=>set({source})} details={list?.details}/>}
      </section>}
      <section className="collection-editor-titles">
        <div className="collection-editor-section-head">
          <h3>Titles <span className="count">{shown.length}</span></h3>
          {!refreshed&&<div className="button-row">
            <button type="button" onClick={()=>setPaste(p=>p===undefined?'':undefined)}>{paste===undefined?'Add by ID':'Close'}</button>
            {shown.length>0&&<button type="button" onClick={()=>drop(shown)}>Remove all</button>}</div>}
        </div>
        {refreshed?<p className="muted small">These come from the list and are refreshed on every run; ones you remove stay out.</p>:<>
          {!tmdbConfigured&&<p className="muted small">Add a TMDb key in Artwork › Settings to search for titles and see their posters.</p>}
          <TitleSearch type={d.type} members={members} add={m=>add([m])}/>
          {paste!==undefined&&<div className="collection-editor-paste">
            <textarea rows={4} autoFocus placeholder={'One per line: tmdb:948, imdb:tt0077651, plex:12345, or Halloween | 1978'} value={paste} onChange={e=>setPaste(e.target.value)}/>
            <button type="button" disabled={!paste.trim()} onClick={()=>{add(parseMembers(paste));setPaste(undefined);}}>Add</button></div>}
        </>}
        {refreshed&&list?.error&&<p className="danger small">The list couldn’t be read: {list.error}</p>}
        {refreshed&&list&&!list.rows&&!list.error&&<p className="muted small">Reading the list…</p>}
        {shown.length||chosen?.left.length?<div className="collection-editor-grid"><TitleGrid type={d.type} members={shown} remove={i=>drop([shown[i]!])} left={chosen?.left}/></div>
          :<p className="collection-editor-empty muted small">{refreshed?(list&&!list.rows&&!list.error?'Reading the list…':'The list hasn’t been read yet.'):'No titles yet. Search above to add some.'}</p>}
        <Removed count={exclude.length} restore={()=>add(exclude)}/>
      </section>
      <div className="collection-editor-options">
        <section className="collection-editor-panel">
          <Switch label="Show on Home" description={homeHint} checked={onHome(visibility)} onChange={v=>set({visibility:everywhere(v)})}/>
        </section>
        {d.type==='movie'&&<section className="collection-editor-panel">
          <Switch label="Download missing movies" description={found?`Radarr adds the ${(found.total??0)-(found.owned??0)} missing while the collection is on.`:'Needs Radarr and TMDb IDs.'} checked={!!d.acquire} onChange={v=>set({acquire:v})}/>
          {d.acquire&&<label>Downloaded movies<select value={d.cleanup??'keep'} onChange={e=>set({cleanup:e.target.value as NonNullable<Definition['cleanup']>})}><option value="keep">Keep them</option><option value="remove-delete">Delete them when the season ends</option>{refreshed&&<option value="rotate">Delete each once it leaves the list</option>}</select></label>}
          {d.acquire&&d.cleanup==='rotate'&&<p className="muted small">None goes while someone is watching it. Movies you already had are never deleted.</p>}
          {d.acquire&&<Switch label="Hide downloads from Recently added" checked={hidesFromRecent(d)} onChange={v=>set({hide_recent:v})}/>}
        </section>}
      </div>
      {exporting&&<ExportBox definition={finished()}/>}
      {problem&&<p className="danger small">{problem}</p>}
      <div className="button-row collection-editor-foot"><button className="primary">{remove?'Done':'Add collection'}</button><button type="button" onClick={onClose}>{remove?'Cancel':'Back'}</button>
        {remove&&<button type="button" aria-expanded={exporting} onClick={()=>setExporting(x=>!x)}><Icon name="download" size={16}/>Export</button>}<span className="muted small">Save collections to keep this.</span>
        {remove&&<button type="button" className="danger collection-editor-remove" onClick={remove}>Remove collection</button>}</div>
    </form>
  </Modal>;
}
// How many titles were taken out of a collection, and a way to put them back.
const sortNames:[ListSort,string][]=[['list','List order'],['rating','Highest rated on TMDb'],['oldest','Oldest first'],['newest','Newest first'],['anniversary','Round anniversaries first'],['random','Random, new each week']];
// TMDb's genres and the US ratings, so each shows even when this week's list has none of it.
const tmdbGenres={movie:['Action','Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Fantasy','History','Horror','Music','Mystery','Romance','Science Fiction','TV Movie','Thriller','War','Western'],
  tv:['Action & Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Kids','Mystery','News','Reality','Sci-Fi & Fantasy','Soap','Talk','War & Politics','Western']};
const usRatings={movie:['G','PG','PG-13','R','NC-17','NR'],tv:['TV-Y','TV-Y7','TV-G','TV-PG','TV-14','TV-MA','NR']};
const languageName=(code:string)=>{try{return new Intl.DisplayNames(['en'],{type:'language'}).of(code)??code;}catch{return code;}};
type Option={value:string;label:string;count:number};
// The choices a list offers, the ones it has most of first (or in `order`), each with how many of its titles have it.
function options(values:(string|null)[][],extra:string[],label:(v:string)=>string=v=>v,order?:string[]):Option[] {
  const counts=new Map<string,number>();
  for(const v of [...(order??[]),...extra])counts.set(v,counts.get(v)??0);
  for(const list of values)for(const v of new Set(list.map(x=>x??'NR')))counts.set(v,(counts.get(v)??0)+1);
  const all=[...counts].map(([value,count])=>({value,label:label(value),count}));
  return order?all.sort((a,b)=>(order.indexOf(a.value)+1||99)-(order.indexOf(b.value)+1||99)||a.label.localeCompare(b.label))
    :all.sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
}
// Which of a list's titles the collection keeps: the filters, then the sort, then the collection size, on every run.
// The titles below follow them as they change.
function ListChoice({source,type,rows=[],change,details}:{source:Source;type:'movie'|'tv';rows?:Candidate[];change:(source:Source)=>void;details?:boolean}) {
  const f=source.filter??{};
  const filter=(patch:Partial<ListFilter>)=>{
    const next=Object.fromEntries(Object.entries({...f,...patch}).filter(([,v])=>v!==undefined&&!(Array.isArray(v)&&!v.length))) as ListFilter;
    change({...source,filter:Object.keys(next).length?next:undefined});
  };
  const known=rows.flatMap(r=>r.details?[r.details]:[]),years=known.flatMap(d=>d.year?[d.year]:[]),thisYear=new Date().getFullYear();
  const first=Math.min(f.year_from??thisYear,...years,thisYear-50),last=Math.max(thisYear,...years);
  const genres=options(known.map(d=>d.genres),f.exclude_genres??[],undefined,tmdbGenres[type]);
  const ratings=options(known.map(d=>[d.certification]),f.exclude_certifications??[],undefined,usRatings[type]);
  const languages=options(known.map(d=>[d.language??'']).filter(([l])=>l),[...(f.languages??[]),'en'],languageName);
  const active=Object.keys(f).length,summary=[source.sort?sortNames.find(([v])=>v===source.sort)?.[1]:undefined,active?plural(active,'filter'):undefined].filter(Boolean).join(' · ');
  return <details className="list-choice">
    <summary><Icon name="next" size={16}/>Sort and filter{summary&&<span className="muted small">{summary}</span>}</summary>
    <div className="list-choice-body">
      <div className="list-choice-grid">
        <label>Sort by<select value={source.sort??'list'} onChange={e=>change({...source,sort:e.target.value==='list'?undefined:e.target.value as ListSort})}>{sortNames.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <Range label="Released" min={first} max={last} step={1} value={[f.year_from??first,f.year_to??last]} any="Any year"
          change={([from,to])=>filter({year_from:from>first?from:undefined,year_to:to<last?to:undefined})}/>
        <Range label="TMDb rating" min={0} max={10} step={0.5} value={[f.min_rating??0,f.max_rating??10]} any="Any rating"
          change={([low,high])=>filter({min_rating:low>0?low:undefined,max_rating:high<10?high:undefined})}/>
        <Checklist label="Genres" noun="genres" options={genres} off={f.exclude_genres??[]} change={off=>filter({exclude_genres:off})}/>
        <Checklist label="Content ratings" noun="ratings" options={ratings} off={f.exclude_certifications??[]} change={off=>filter({exclude_certifications:off})}/>
        <Checklist label="Language" noun="languages" options={languages} off={f.languages?languages.filter(o=>!f.languages!.includes(o.value)).map(o=>o.value):[]}
          change={off=>filter({languages:off.length?languages.filter(o=>!off.includes(o.value)).map(o=>o.value):undefined})}/>
      </div>
      <p className="muted small">Filters go first, then the sort, then the collection size. Titles you already have count toward it; the ones left out are greyed at the end.</p>
      {details===false&&(active>0||!!source.sort)&&<p className="danger small">Sorting and filtering need a TMDb key (Artwork › Settings).</p>}
    </div>
  </details>;
}
// A two-ended slider; the ends at the limits mean no limit.
function Range({label,min,max,step,value:[low,high],any,change}:{label:string;min:number;max:number;step:number;value:[number,number];any:string;change:(value:[number,number])=>void}) {
  const at=(v:number)=>max>min?(v-min)/(max-min)*100:0,full=low<=min&&high>=max;
  return <div className="range-field">
    <span className="range-head">{label}<span className="muted">{full?any:`${low} – ${high}`}</span></span>
    <div className="range-slider" style={{'--low':`${at(low)}%`,'--high':`${at(high)}%`} as React.CSSProperties}>
      <input type="range" aria-label={`${label} from`} min={min} max={max} step={step} value={low} onChange={e=>change([Math.min(Number(e.target.value),high),high])}/>
      <input type="range" aria-label={`${label} to`} min={min} max={max} step={step} value={high} onChange={e=>change([low,Math.max(Number(e.target.value),low)])}/>
    </div>
  </div>;
}
// Everything ticked until you untick some; `off` is what's unticked.
function Checklist({label,noun,options,off,change}:{label:string;noun:string;options:Option[];off:string[];change:(off:string[])=>void}) {
  const popup=useRef<HTMLDetailsElement>(null),out=new Set(off);
  useEffect(()=>{
    const outside=(e:PointerEvent)=>{if(popup.current&&!popup.current.contains(e.target as Node))popup.current.open=false;};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[]);
  const on=options.filter(o=>!out.has(o.value)),names=options.filter(o=>out.has(o.value)).map(o=>o.label);
  const shown=!off.length?`All ${noun}`:!on.length?`No ${noun}`:on.length<=2?`Only ${on.map(o=>o.label).join(', ')}`:names.length<=2?`All but ${names.join(', ')}`:`${on.length} of ${options.length} ${noun}`;
  return <div className="range-field"><span className="range-head">{label}</span>
    <details ref={popup} className="checklist" onKeyDown={e=>{if(e.key==='Escape'&&popup.current?.open){e.stopPropagation();popup.current.open=false;}}}>
      <summary><span>{shown}</span><Icon name="next" size={14}/></summary>
      <div className="checklist-menu">
        <div className="checklist-actions"><button type="button" className="link-button" disabled={!off.length} onClick={()=>change([])}>Select all</button></div>
        {options.map(o=><div key={o.value} className="checklist-row"><label><input type="checkbox" checked={!out.has(o.value)} onChange={e=>change(e.target.checked?off.filter(v=>v!==o.value):[...off,o.value])}/>
          <span className="grow">{o.label}</span><span className="muted small">{o.count||''}</span></label>
          <button type="button" className="link-button small" onClick={()=>change(options.filter(x=>x.value!==o.value).map(x=>x.value))}>Only</button></div>)}
      </div>
    </details>
  </div>;
}
function Removed({count,restore}:{count:number;restore:()=>void}) {
  return count>0?<p className="muted small">{count} removed · <button type="button" className="link-button" onClick={restore}>Put {count===1?'it':'them'} back</button></p>:null;
}
// A Partly owned row is a TMDb collection one library has some of: it names that library and how much of it is there.
type Row={key?:string;name:string;url:string|null;description?:string;type:'movie'|'tv';provider:string;library?:string;owned?:number;total?:number};
// When the Discover index was built (seconds; null: not yet), and how many movies in Plex it hasn't read.
type DiscoverIndex={built:number|null;unread?:number};
type Preview={name:string;url:string;type:'movie'|'tv';limit:number;provider:string;items:{title:string;year?:number;member:Member}[];candidates?:Candidate[];details?:boolean};
const providers=[['all','Every source'],['tmdb','TMDb'],['mdblist','MDBList'],['imdb','IMDb'],['letterboxd','Letterboxd'],['flixpatrol','FlixPatrol'],['plex','Plex']] as const;
function Discover({libraries,existing,onClose,add}:{libraries:Library[];existing:Definition[];onClose:()=>void;add:(entry:Definition)=>void}) {
  const [mode,setMode]=useState<'recommendations'|'universes'|'partial'|'browse'|'url'>('universes'),[type,setType]=useState<'movie'|'tv'>('movie'),[provider,setProvider]=useState('all'),[query,setQuery]=useState('');
  const [rows,setRows]=useState<Row[]>(),[url,setUrl]=useState(''),[limit,setLimit]=useState(50),mutation=useMutation(()=>{});
  const [index,setIndex]=useState<DiscoverIndex>(),[building,setBuilding]=useState(false),[found,setFound]=useState<{value:Definition;row?:Row}>();
  // Partly owned and Universes read the Discover index (built by the nightly full run, joined by newly added movies).
  const indexed=mode==='partial'||mode==='universes';
  const ask=()=>api<{results:Row[];index?:DiscoverIndex}>('/admin/artwork/collections/discover','POST',{mode,provider,query,type});
  const find=()=>void mutation.run(async()=>{const r=await ask();setRows(r.results);setIndex(r.index);});
  const build=()=>void mutation.run(async()=>{await api('/admin/artwork/collections/index','POST');setBuilding(true);});
  // While the index builds in the background, look again every 15 seconds (for up to 30 minutes) until it's newer.
  useEffect(()=>{
    if(!building||!indexed)return;
    let tries=0;const timer=setInterval(()=>void ask().then(r=>{if(r.index?.built!==index?.built){setRows(r.results);setIndex(r.index);setBuilding(false);}else if(++tries>=120)setBuilding(false);},()=>{}),15000);
    return ()=>clearInterval(timer);
  },[building,mode,type,index?.built]);
  // Reads the list, then opens the collection editor filled in from it; Add puts it with the others.
  const open=(body:object,row?:Row)=>void mutation.run(async()=>{
    const r=await api<Preview>('/admin/artwork/collections/discover','POST',{mode:'preview',...body});
    setFound({value:{name:row?.library?row.name:r.name,library:row?.library??libraries.find(l=>(l.type==='show'?'tv':'movie')===r.type)?.title??'',type:r.type,enabled:true,visibility:hidden,members:r.items.map(i=>i.member),source:{url:r.url,limit:r.limit,refresh:true}},row:row?.library?row:undefined});
  });
  const taken=(d:Definition)=>existing.some(x=>x.library===d.library&&(keyOf(x.name)===keyOf(d.name)||x.source?.url===d.source?.url))?'This name or list is already in that library. Edit that collection instead.':undefined;
  // A partly owned collection is added for its library; a universe in any library of its type is added, and isn't offered.
  const added=(r:Row)=>!!r.library&&existing.some(x=>x.library===r.library&&(x.source?.url===r.url||keyOf(x.name)===keyOf(r.name)));
  const shown=rows?.filter(r=>!r.key||!existing.some(x=>x.type===r.type&&(x.source?.url===r.url||keyOf(x.name)===keyOf(r.name))));
  useEffect(()=>{if(mode==='universes'||mode==='recommendations'||mode==='partial')find();},[mode,type]);
  if(found)return <EditDefinition value={found.value} found={found.row} libraries={libraries.filter(l=>(l.type==='show'?'tv':'movie')===found.value.type)} onClose={()=>setFound(undefined)} check={taken} save={add}/>;
  return <Modal title="Discover collections" onClose={onClose}>
    <div className="form-stack artwork-discover">
      <div className="toggle-group" role="radiogroup" aria-label="Find collections">{([['universes','Universes'],['partial','Partly owned'],['recommendations','Recommended'],['browse','Search lists'],['url','Import a list']] as const).map(([m,label])=><button key={m} type="button" role="radio" aria-checked={mode===m} onClick={()=>{setMode(m);setRows(undefined);setQuery('');}}>{label}</button>)}</div>
      {mode==='url'?<form className="setting-line" onSubmit={e=>{e.preventDefault();open({url,type,limit});}}><input className="grow" type="url" required placeholder="A public TMDb, IMDb, Letterboxd, MDBList, FlixPatrol or Plex Discover list" value={url} onChange={e=>setUrl(e.target.value)}/>
          <select aria-label="Movies or TV" value={type} onChange={e=>setType(e.target.value as 'movie'|'tv')}><option value="movie">Movies</option><option value="tv">TV</option></select><input aria-label="Collection size" type="number" min="1" max="250" value={limit} onChange={e=>setLimit(Number(e.target.value))}/><button className="primary" disabled={mutation.busy}>Set up</button></form>
        :<form className="setting-line" onSubmit={e=>{e.preventDefault();find();}}>
          {mode==='partial'?null:mode==='universes'?<select aria-label="Movies or TV" value={type} onChange={e=>setType(e.target.value as 'movie'|'tv')}><option value="movie">Movies</option><option value="tv">TV</option></select>
            :<select aria-label="Source" value={provider} onChange={e=>setProvider(e.target.value)}>{providers.filter(([p])=>mode!=='browse'||p!=='all').map(([p,label])=><option key={p} value={p}>{label}</option>)}</select>}
          <input className="grow" type="search" placeholder="Search" value={query} onChange={e=>setQuery(e.target.value)}/><button disabled={mutation.busy||(mode==='browse'&&provider==='all')}>Search</button></form>}
      {mutation.busy&&<Loading/>}{indexed&&index&&<p className="muted small">{building?'Building the index in the background. This list updates when it’s done.'
        :index.built===null?<>These counts come from an index built each night with the full collections run. It hasn’t been built yet. <button type="button" className="link-button" disabled={mutation.busy} onClick={build}>Build it now</button></>
        :<>Updated {when(index.built*1000)}{index.unread?` · ${plural(index.unread,'movie')} not read yet`:''} · <button type="button" className="link-button" disabled={mutation.busy} onClick={build}>Refresh</button></>}</p>}
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      {shown&&(shown.length?<ul className="artwork-discover-rows">{shown.map((r,i)=><li key={i}><span className="grow"><strong>{r.name}</strong><small className="muted">{r.description||'Public list'} · {r.type==='tv'?'TV':'Movies'}</small></span>
          {added(r)?<span className="muted small">In your collections</span>:r.url?<button disabled={mutation.busy} onClick={()=>open({...(r.key?{universe:r.key,limit:250}:{url:r.url,limit:r.library?250:50}),type:r.type},r)}>Set up</button>:<button onClick={()=>{setMode('browse');setProvider(r.provider);setRows(undefined);}}>Browse lists</button>}</li>)}</ul>
        :mode==='universes'&&!query&&rows?.length?<Empty title="Every universe is added">Edit them in your collections.</Empty>
        :mode==='partial'?<Empty title="Nothing partly owned">{query?'Try another search.':index?.built===null?'Build the index to see them.':'Every TMDb collection in your movie libraries is complete.'}</Empty>
        :<Empty title="No collections found">Try another search, or import a list by its address.</Empty>)}
      <p className="muted small">TMDb and MDBList need keys in Connections. IMDb lists must be public.</p>
    </div>
  </Modal>;
}
// One collection as JSON, with its settings and titles as the editor has them, to copy into Import (here or elsewhere).
function ExportBox({definition}:{definition:Definition}) {
  const text=exportCollection(definition),[copied,setCopied]=useState(false),box=useRef<HTMLTextAreaElement>(null);
  const copy=()=>{box.current?.select();void navigator.clipboard.writeText(text).then(()=>setCopied(true),()=>{});};
  return <section className="collection-editor-panel">
    <h3>Export</h3>
    <p className="muted small">This collection with its settings and titles. Paste it into Import.</p>
    <textarea ref={box} readOnly rows={10} spellCheck={false} aria-label="Exported collection" value={text} onFocus={e=>e.currentTarget.select()}/>
    <div className="button-row"><button type="button" className="primary" onClick={copy}>Copy</button>{copied&&<span className="success small" role="status">Copied</span>}</div>
  </section>;
}
// Reads JSON from Export and adds the collections you pick, each in a library here of its type (the one with the same
// name, when there is one). One named like a collection already in that library replaces it.
function ImportCollections({libraries,existing,onClose,add}:{libraries:Library[];existing:Definition[];onClose:()=>void;add:(entries:Definition[])=>void}) {
  const [found,setFound]=useState<{value:Definition;on:boolean}[]>(),[problem,setProblem]=useState(''),[text,setText]=useState('');
  const fits=(d:Definition)=>libraries.filter(l=>(l.type==='show'?'tv':'movie')===d.type);
  const read=()=>{
    try{const list=readCollections(text);setProblem('');
      setFound(list.map(d=>{const here=fits(d);return {value:{...d,library:here.some(l=>l.title===d.library)?d.library:here[0]?.title??''},on:true};}));}
    catch(e){setFound(undefined);setProblem(e instanceof Error?e.message:'This can’t be read.');}
  };
  const set=(i:number,patch:Partial<{value:Definition;on:boolean}>)=>setFound(list=>list?.map((x,j)=>j===i?{...x,...patch}:x));
  const picked=found?.filter(x=>x.on&&x.value.library)??[];
  return <Modal title="Import collections" onClose={onClose}>
    <div className="form-stack artwork-discover">
      <p className="muted small">Paste one collection or a list of them, from Export or written by an AI. Each comes with its settings and titles.</p>
      <textarea rows={found?4:12} spellCheck={false} aria-label="Collections to import" placeholder='{"name": "Halloween", "library": "Movies", "type": "movie", …}' value={text} onChange={e=>{setText(e.target.value);setFound(undefined);setProblem('');}}/>
      {!found&&<div className="button-row"><button className="primary" disabled={!text.trim()} onClick={read}>Read</button></div>}
      {problem&&<p className="danger small">{problem}</p>}
      {found&&<ul className="artwork-discover-rows">{found.map(({value:d,on},i)=>{
        const here=fits(d),replaces=existing.some(x=>idOf(x)===idOf(d)),plex=plexOnly(d),count=d.source&&d.source.refresh!==false?'From a list':plural(d.members?.length??0,d.type==='tv'?'show':'movie');
        return <li key={i}><input type="checkbox" aria-label={`Import ${d.name}`} checked={on&&!!here.length} disabled={!here.length} onChange={e=>set(i,{on:e.target.checked})}/>
          <span className="grow"><strong>{d.name}</strong>
            <small className="muted">{d.schedule?`Seasonal · ${season(d.schedule)}`:'Custom'} · {count}{d.enabled===false?' · Off':''}{d.acquire?' · Downloads missing movies':''}</small>
            {replaces&&<small className="muted">Replaces the one with this name in {d.library}.</small>}
            {plex>0&&<small className="muted">{plural(plex,'title')} only known by Plex ID, which another Plex server won’t match.</small>}
            {!here.length&&<small className="danger">No {d.type==='tv'?'TV':'movie'} library here.</small>}</span>
          {here.length>0&&<select aria-label="Plex library" value={d.library} onChange={e=>set(i,{value:{...d,library:e.target.value}})}>{here.map(l=><option key={l.key} value={l.title}>{l.title}</option>)}</select>}</li>;})}</ul>}
      {found&&<div className="button-row"><button className="primary" disabled={!picked.length} onClick={()=>add(picked.map(x=>x.value))}>Import {plural(picked.length,'collection')}</button>
        <span className="muted small">Save collections to keep them.</span></div>}
    </div>
  </Modal>;
}
