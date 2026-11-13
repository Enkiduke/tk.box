import type {ExploreWatchProvider,ExploreWatchProviders,StreamingRow} from '../../../packages/contracts/src/index.js';
import {ErrorNotice} from './components.js';
import {useApi} from './hooks.js';
import {selectStreamingService,useExplorePrefs} from './explore-prefs.js';

export function useStreamingCatalog(enabled:boolean) {
  const {region,providers}=useExplorePrefs();
  const catalog=useApi<ExploreWatchProviders>(enabled?`/explore/tmdb/providers?region=${region}`:undefined);
  const preferred=providers??catalog.data?.defaults??[];
  return {...catalog,region,services:preferred.flatMap(id=>catalog.data?.providers.find(p=>p.id===id)??[])};
}

export function useStreamingSelection(row:StreamingRow|undefined,requested?:string|null) {
  const prefs=useExplorePrefs(),catalog=useStreamingCatalog(!!row);
  const saved=row?prefs.selections[row]:undefined;
  const wanted=requested==='all'?'all':requested&&/^\d+$/.test(requested)?Number(requested):saved;
  const selected:number|'all'=catalog.services.some(p=>p.id===wanted)?Number(wanted):'all';
  const select=(provider:number|'all')=>{if(row)selectStreamingService(row,provider);};
  const query=row&&catalog.data&&catalog.services.length
    ?`&region=${catalog.region}&provider=${selected}&providers=${catalog.services.map(p=>p.id).sort((a,b)=>a-b).join(',')}`:'';
  return {...catalog,selected,select,query};
}

export function StreamingSelector({title,services,selected,onSelect}:{title:string;services:ExploreWatchProvider[];selected:number|'all';onSelect:(provider:number|'all')=>void}) {
  return <div className="explore-streaming">
    <div className="explore-service-list" role="group" aria-label={`Streaming services for ${title}`}>
      <button type="button" aria-pressed={selected==='all'} onClick={()=>onSelect('all')}>All</button>
      {services.map(service=><button type="button" key={service.id} aria-pressed={selected===service.id} onClick={()=>onSelect(service.id)}>
        {service.logoUrl&&<img src={service.logoUrl} alt="" loading="lazy"/>}{service.name}
      </button>)}
    </div>
  </div>;
}

export function StreamingStatus({catalog}:{catalog:ReturnType<typeof useStreamingSelection>}) {
  if(catalog.error)return <ErrorNotice message={catalog.error.message} retry={catalog.reload}/>;
  if(catalog.data&&!catalog.services.length)return <div className="explore-row-status"><p className="muted small">Choose services in <a href="#settings?section=explore">Explore settings</a>.</p></div>;
  return null;
}
