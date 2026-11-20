import type {ExploreSources} from '../../../packages/contracts/src/index.js';
import type {ExploreRows} from '../../../packages/contracts/src/explore-rows.js';
import {useApi} from './hooks.js';
import {ErrorNotice,Loading} from './components.js';
import {Card,SectionHead,Switch} from './settings-ui.js';
import {rowHidden,setExplorePrefs,showExploreRows,useExplorePrefs,setStreamingProviders,setStreamingRegion} from './explore-prefs.js';
import {useStreamingCatalog} from './explore-streaming.js';
import './explore.css';

const tmdbLogoUrl=new URL('./assets/ratings/tmdb.svg',import.meta.url).href;

// Settings › Explore: the rows the administrator offers, each on until the viewer switches it off, and streaming services.
export function ExploreSettings({admin}:{admin:boolean}) {
  const sources=useApi<ExploreSources>('/explore/sources');
  return <><SectionHead title="Explore"/>
    {sources.loading&&!sources.data?<Loading/>:sources.error?<ErrorNotice message={sources.error.message} retry={sources.reload}/>:sources.data&&<>
      <ExploreRowPrefs/>
      <StreamingSettings configured={sources.data.tmdb.configured} admin={admin}/>
      <Card title="Credits">
        <a className="explore-tmdb-credit" href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
          <img src={tmdbLogoUrl} alt="TMDB" referrerPolicy="no-referrer"/>
        </a>
        <p className="muted small">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p className="muted small">Streaming availability data from <a href="https://www.justwatch.com/" target="_blank" rel="noreferrer">JustWatch</a>.</p>
      </Card>
    </>}
  </>;
}
function StreamingSettings({configured,admin}:{configured:boolean;admin:boolean}) {
  const catalog=useStreamingCatalog(configured);
  const selected=catalog.services.map(p=>p.id);
  const toggle=(id:number)=>setStreamingProviders(selected.includes(id)?selected.filter(p=>p!==id):[...selected,id]);
  return <Card title="Streaming services">
    {!configured?<p className="muted small">{admin?<>Add a TMDB key in <a href="#admin?section=connections&category=metadata">Admin › Connections › Metadata &amp; artwork</a>.</>:'Ask the server administrator to set up TMDB.'}</p>
      :catalog.error?<ErrorNotice message={catalog.error.message} retry={catalog.reload}/>
      :!catalog.data?<Loading/>:<div className="form-stack narrow">
        <label>Streaming region<select value={catalog.region} onChange={e=>setStreamingRegion(e.target.value)}>
          {catalog.data.regions.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(region=><option key={region.code} value={region.code}>{region.name}</option>)}
        </select></label>
        <label>Add a service<select value="" disabled={selected.length>=12} onChange={e=>{if(e.target.value)toggle(Number(e.target.value));}}>
          <option value="">Choose a service</option>
          {catalog.data.providers.filter(provider=>!selected.includes(provider.id)).map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select></label>
        <div className="explore-service-list">{catalog.services.map(service=><button type="button" key={service.id} onClick={()=>toggle(service.id)} aria-label={`Remove ${service.name}`}>
          {service.logoUrl&&<img src={service.logoUrl} alt=""/>}{service.name} <span aria-hidden="true">×</span>
        </button>)}</div>
        <div className="button-row"><button type="button" onClick={()=>setStreamingProviders(undefined)}>Use default services</button></div>
      </div>}
  </Card>;
}
// The rows on offer, in Explore's order, each with its switch.
function ExploreRowPrefs() {
  const prefs=useExplorePrefs(),rows=useApi<ExploreRows>('/explore/rows'),list=rows.data?.rows??[],keys=list.map(r=>r.key);
  return <Card title="Rows" actions={<button type="button" disabled={!prefs.hiddenRows.length} onClick={()=>setExplorePrefs({...prefs,hiddenRows:[]})}>Show everything</button>}>
    {rows.error?<ErrorNotice message={rows.error.message} retry={rows.reload}/>:!rows.data?<Loading/>
      :list.length?<div className="explore-pref-rows">{list.map(r=><Switch key={r.key} label={r.title} description={r.source==='plex'?'Plex':r.personal?'Your own':undefined}
        checked={!rowHidden(prefs,r.key)} onChange={on=>showExploreRows([r.key],on,keys)}/>)}</div>
      :<p className="muted small">Explore has no rows right now.</p>}
  </Card>;
}
