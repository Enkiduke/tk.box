import {useEffect,useState} from 'react';
import type {ShowMatchView,TvdbSeriesHit,TvdbSeriesView} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {invalidate,useApi} from './hooks.js';
import {ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Dash,Panel,Table,changed} from './manage-ui.js';
import {useMutation} from './settings-ui.js';
import {toast} from './toasts.js';

// Match: files a show under a TVDB series (server lib/season-map.ts), for a show TMDB gives no TVDB id or the wrong
// one. Pick the series, then which of its seasons each TMDB season is (suggested from air dates). From Admin ›
// Requests, saving also retries the failed request (`after`).
// TVDB puts the year in some names already (Monster (2022)).
const named=(name:string,year?:number)=>year&&!name.endsWith(`(${year})`)?`${name} (${year})`:name;

export function ShowMatchDialog({tmdbId,title,onClose,after,saveLabel='Save'}:{tmdbId:number;title:string;onClose:()=>void;after?:()=>Promise<void>;saveLabel?:string}) {
  const view=useApi<ShowMatchView>(`/admin/library/matches/${tmdbId}`);
  const [query,setQuery]=useState(title),[searched,setSearched]=useState<string>(),[picked,setPicked]=useState<number>();
  const hits=useApi<{items:TvdbSeriesHit[]}>(searched?`/admin/library/tvdb/search?${new URLSearchParams({q:searched})}`:undefined);
  const series=useApi<TvdbSeriesView>(picked?`/admin/library/tvdb/series/${picked}?tmdb=${tmdbId}`:undefined);
  const [seasons,setSeasons]=useState<Record<string,number>>({}),save=useMutation(()=>{changed();invalidate('/admin/requests?');});
  // The current match is the starting point; a series picked after starts from its suggestions.
  useEffect(()=>{const m=view.data?.match;if(m&&picked===undefined){setPicked(m.tvdbId);}},[view.data?.match?.tvdbId]);
  useEffect(()=>{if(!series.data)return;const m=view.data?.match;
    setSeasons(m&&m.tvdbId===series.data.series.tvdbId?{...Object.fromEntries(view.data!.seasons.map(s=>[String(s.season),s.season])),...m.seasons}:series.data.suggested);},[series.data?.series.tvdbId]);
  useEffect(()=>{if(view.data?.tvdbKey&&!view.data.match&&!searched)setSearched(title);},[view.data?.tvdbKey]);
  const busy=save.busy,d=view.data,tvdbSeasons=series.data?.seasons??[];
  const missing=d?.seasons.filter(s=>!seasons[String(s.season)])??[];
  const run=()=>void save.run(async()=>{
    await api(`/admin/library/matches/${tmdbId}`,'PUT',{tvdbId:picked,seasons});
    toast.success(`Matched ${title} to ${series.data!.series.name}`);
    if(after)await after();
    onClose();
  });
  return <Modal title={`Match ${title}`} variant="wide" onClose={()=>{if(!busy)onClose();}}>
    <h2>Match {title}</h2>
    {view.error&&!d?<ErrorNotice message={view.error.message} retry={view.reload}/>:!d?<Loading/>:!d.tvdbKey?<ErrorNotice message="Add a TVDB key in Admin › Connections."/>:<div className="ui-match">
      {d.match&&<p className="muted">Matched to {named(d.match.series.title,d.match.series.year)} · TVDB {d.match.tvdbId}</p>}
      <Panel flush title="TVDB series" actions={<form className="ui-match-search" onSubmit={e=>{e.preventDefault();if(query.trim())setSearched(query.trim());}}>
        <label className="ui-search"><Icon name="search" size={15}/><input type="search" aria-label="Search TVDB" placeholder="Search TVDB" value={query} maxLength={120} onChange={e=>setQuery(e.target.value)}/></label>
        <button disabled={!query.trim()}>Search</button></form>}>
        {hits.error?<ErrorNotice message={hits.error.message} retry={hits.reload}/>:searched&&!hits.data?<Loading/>:
          <Table posters empty={hits.data&&!hits.data.items.length?'No series found':undefined} columns={[{label:'Series'},{label:'Network',width:160},{label:'TVDB',width:110,num:true},{label:<span className="sr-only">Pick</span>,width:96}]}>
            {(hits.data?.items??[]).map(h=><tr key={h.tvdbId} className={picked===h.tvdbId?'selected':undefined}>
              <td><div className="ui-title"><span className="ui-poster" aria-hidden="true">{h.image&&<img src={h.image} alt="" loading="lazy" decoding="async"/>}</span><div>
                <span className="ui-title-name">{h.name}</span>{h.year&&!h.name.endsWith(`(${h.year})`)?<span className="ui-title-year">{h.year}</span>:null}</div></div></td>
              <td>{h.network??<Dash/>}</td><td className="num">{h.tvdbId}</td>
              <td><button className={picked===h.tvdbId?'primary':undefined} disabled={busy} onClick={()=>setPicked(h.tvdbId)}>{picked===h.tvdbId?'Picked':'Pick'}</button></td></tr>)}
          </Table>}
      </Panel>
      {picked!==undefined&&<Panel flush title={series.data?`Seasons · ${named(series.data.series.name,series.data.series.year)}`:'Seasons'}>
        {series.error?<ErrorNotice message={series.error.message} retry={series.reload}/>:!series.data?<Loading/>:
          <Table columns={[{label:'TMDB season'},{label:'Episodes',width:90,num:true},{label:'First aired',width:120},{label:'TVDB season',width:300}]}>
            {d.seasons.map(s=>{const value=seasons[String(s.season)];
              return <tr key={s.season}><td>Season {s.season}</td><td className="num">{s.episodes}</td><td>{s.firstAired??<Dash/>}</td>
                <td><select aria-label={`TVDB season for season ${s.season}`} value={value??''} disabled={busy} onChange={e=>setSeasons(m=>({...m,[String(s.season)]:Number(e.target.value)}))}>
                  {value===undefined&&<option value="">Pick a season</option>}
                  {tvdbSeasons.map(t=><option key={t.season} value={t.season}>Season {t.season} · {t.episodes} ep{t.firstAired?` · ${t.firstAired}`:''}</option>)}
                </select></td></tr>;})}
          </Table>}
      </Panel>}
      {save.error&&<ErrorNotice message={save.error}/>}
      <div className="button-row"><button className="primary" disabled={busy||!series.data||missing.length>0} onClick={run}>{saveLabel}</button><button disabled={busy} onClick={onClose}>Cancel</button></div>
    </div>}
  </Modal>;
}
