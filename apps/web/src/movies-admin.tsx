import {useMemo,useState} from 'react';
import {QuickEdit} from './quick-edit.js';
import type {MovieList,MovieRow} from '../../../packages/contracts/src/downloads.js';
import {useApi} from './hooks.js';
import {SectionHead} from './settings-ui.js';
import {SourceCell,sourceLabel} from './movie-source.js';
import {ACTIONS,Dash,FavoriteStar,IconAction,Loaded,MediaStatusPill,Panel,RowActions,SelectCell,Segmented,Table,TitleCell,Toolbar,WhenDay,gb,matches,openMovie,qualityRank,usePaged,useRefresh,
  selectColumn,useSelection,useSorted,type Tone} from './manage-ui.js';

// Admin › Manage › Movies (docs/PHASE-3.5.md, docs/UI.md): every movie in the library. A movie opens as a dialog
// (movie-dialog.tsx).

const filters=[['all','All'],['file','Has file'],['nofile','No file'],['cutoff','Below cutoff'],['kept','Favorites'],['paused','Failing'],['unmonitored','Unmonitored']] as const;
type Filter=typeof filters[number][0];
const sources=[['all','Any source'],['request','Requests'],['collection','Collections'],['imported','Imported']] as const;
type SourceFilter=typeof sources[number][0];
const movieSorts={title:(m:MovieRow)=>m.title,quality:(m:MovieRow)=>qualityRank(m.quality),size:(m:MovieRow)=>m.size,profile:(m:MovieRow)=>m.profile,
  status:(m:MovieRow)=>status(m).label,release:(m:MovieRow)=>m.release?.day,source:(m:MovieRow)=>sourceLabel(m.source)};
const releaseNames={theatrical:'In cinemas',digital:'Digital',physical:'Physical'};
const shown=(m:MovieRow,f:Filter)=>f==='all'||(f==='file'?!!m.quality:f==='nofile'?!m.quality:f==='cutoff'?m.belowCutoff:f==='kept'?m.keep:f==='paused'?m.paused:!m.monitored);
// One status per movie: what it needs, or what is happening to it.
function status(m:MovieRow):{tone:Tone;label:string} {
  if(!m.monitored)return {tone:'off',label:'Not monitored'};
  if(m.paused)return {tone:'bad',label:'Failing'};
  if(m.grab&&['sending','downloading','unpacking','importing'].includes(m.grab))return {tone:'active',label:'Downloading'};
  if(!m.quality)return {tone:'wait',label:'Missing'};
  if(m.belowCutoff)return {tone:'wait',label:'Below cutoff'};
  return {tone:'ok',label:'Available'};
}

export function MoviesPage() {
  const view=useApi<MovieList>('/admin/library/movies');useRefresh(view.reload,30000);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<Filter>('all'),[from,setFrom]=useState<SourceFilter>('all');
  const items=(view.data?.items??[]).filter(m=>matches(query,m.title,m.year,m.quality,m.profile,...(m.source.kind==='request'?m.source.requests.map(r=>r.name):m.source.kind==='collection'?m.source.collections:[]))
    &&shown(m,filter)&&(from==='all'||m.source.kind===from))
    .sort((a,b)=>a.title.localeCompare(b.title));
  const {rows:sorted,sort,onSort}=useSorted(items,movieSorts);
  const present=useMemo(()=>(view.data?.items??[]).map(m=>m.id),[view.data]),sel=useSelection(sorted.map(m=>m.id),present);
  const picked=useMemo(()=>(view.data?.items??[]).filter(m=>sel.has(m.id)),[view.data,sel]);
  const {rows,more}=usePaged(sorted,`${query}|${filter}|${from}|${sort?.key}|${sort?.dir}`,{auto:true});
  return <><SectionHead title="Movies"/>
    <Toolbar query={query} setQuery={setQuery} placeholder="Search titles or requesters" count={view.data?`${items.length} of ${view.data.items.length}`:undefined}>
      <Segmented label="Show" value={filter} options={filters} onChange={setFilter}/>
      <Segmented label="Source" value={from} options={sources} onChange={setFrom}/>
    </Toolbar>
    <Loaded view={view}>{({items:all})=>{const now=Date.now();return <Panel flush>
      <Table posters more={more} sort={sort} onSort={onSort} empty={!all.length?'No movies in the library':!items.length?'No movie matches':undefined}
        columns={[selectColumn(sel),{label:'Title',sort:'title'},{label:'Quality',width:130,sort:'quality',desc:true},{label:'Size',width:90,num:true,sort:'size',desc:true},{label:'Profile',width:110,sort:'profile'},{label:'Source',width:170,sort:'source'},
          {label:'Status',width:140,sort:'status'},{label:'Release',width:110,sort:'release'},ACTIONS]}>
        {rows.map(m=>{const s=status(m);return <tr key={m.id} className={[!m.monitored?'is-off':'',sel.has(m.id)?'is-picked':''].join(' ').trim()||undefined}>
          <SelectCell sel={sel} id={m.id} label={m.title}/><td><TitleCell id={m.id} title={m.title} year={m.year} tags={m.keep&&<FavoriteStar/>}/></td>
          <td>{m.quality??<Dash/>}</td><td className="num">{gb(m.size)??<Dash/>}</td><td>{m.profile}</td><td><SourceCell source={m.source}/></td>
          <td><MediaStatusPill tone={s.tone}>{s.label}</MediaStatusPill></td><td>{m.release?<><WhenDay day={m.release.day} now={now}/><small>{releaseNames[m.release.kind]}</small></>:<Dash/>}</td>
          <td><RowActions><IconAction icon="list" label={`Interactive search for ${m.title}`} onClick={()=>openMovie(m.id,'search')}/></RowActions></td>
        </tr>;})}
      </Table></Panel>;}}</Loaded>
    <QuickEdit sel={sel} noun={['movie','movies']} picked={picked}/>
  </>;
}
