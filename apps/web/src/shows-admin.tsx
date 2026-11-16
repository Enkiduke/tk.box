import {useState} from 'react';
import type {ShowList,ShowRow} from '../../../packages/contracts/src/downloads.js';
import {useApi} from './hooks.js';
import {SectionHead} from './settings-ui.js';
import {SourceCell,sourceLabel} from './movie-source.js';
import {Dash,Loaded,Panel,Pill,Segmented,Table,TitleCell,Toolbar,When,WhenDay,gb,matches,usePaged,useRefresh,useSorted,type Tone} from './manage-ui.js';

// Admin › Manage › Shows (docs/PHASE-2.md, docs/UI.md): every show in the library, like Movies. A show opens as a
// dialog (show-dialog.tsx). Shows come in through requests once fulfil.show is tkbox, or the Sonarr import.

const filters=[['all','All'],['missing','Missing'],['cutoff','Below cutoff'],['airing','Airing'],['kept','Kept'],['paused','Paused']] as const;
type Filter=typeof filters[number][0];
const sources=[['all','Any source'],['request','Requests'],['sonarr','Sonarr']] as const;
type SourceFilter=typeof sources[number][0];
const ended=(s:ShowRow)=>s.status==='Ended'||s.status==='Canceled';
const shown=(s:ShowRow,f:Filter)=>f==='all'||(f==='missing'?s.missing>0:f==='cutoff'?s.cutoff>0:f==='airing'?!ended(s):f==='kept'?s.keep:s.paused);
// One status per show: what it needs, or what is happening to it.
function status(s:ShowRow):{tone:Tone;label:string} {
  if(s.paused)return {tone:'off',label:'Paused'};
  if(!s.monitored)return {tone:'off',label:'Not monitored'};
  if(s.grabbing)return {tone:'active',label:'Downloading'};
  if(s.missing)return {tone:'wait',label:'Missing'};
  if(s.cutoff)return {tone:'wait',label:'Below cutoff'};
  return {tone:'ok',label:'Available'};
}
const showSorts={title:(s:ShowRow)=>s.title,have:(s:ShowRow)=>s.total?s.have/s.total:undefined,size:(s:ShowRow)=>s.size||undefined,profile:(s:ShowRow)=>s.profile,
  source:(s:ShowRow)=>sourceLabel(s.source),status:(s:ShowRow)=>status(s).label,next:(s:ShowRow)=>s.nextAir,added:(s:ShowRow)=>s.addedAt};

export function ShowsPage() {
  const view=useApi<ShowList>('/admin/library/shows');useRefresh(view.reload,30000);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<Filter>('all'),[from,setFrom]=useState<SourceFilter>('all');
  const items=(view.data?.items??[]).filter(s=>matches(query,s.title,s.year,s.profile,s.status,...(s.source.kind==='request'?s.source.requests.map(r=>r.name):[]))
    &&shown(s,filter)&&(from==='all'||s.source.kind===from))
    .sort((a,b)=>a.title.localeCompare(b.title));
  const {rows:sorted,sort,onSort}=useSorted(items,showSorts);
  const {rows,more}=usePaged(sorted,`${query}|${filter}|${from}|${sort?.key}|${sort?.dir}`);
  return <><SectionHead title="Shows"/>
    <Toolbar query={query} setQuery={setQuery} placeholder="Search shows or requesters" count={view.data?`${items.length} of ${view.data.items.length}`:undefined}>
      <Segmented label="Show" value={filter} options={filters} onChange={setFilter}/>
      <Segmented label="Source" value={from} options={sources} onChange={setFrom}/>
    </Toolbar>
    <Loaded view={view}>{({items:all})=>{const now=Date.now();return <Panel flush>
      <Table posters more={more} sort={sort} onSort={onSort} empty={!all.length?'No shows in the library':!items.length?'No show matches':undefined}
        columns={[{label:'Title',sort:'title'},{label:'Episodes',width:110,num:true,sort:'have',desc:true},{label:'Size',width:90,num:true,sort:'size',desc:true},{label:'Profile',width:110,sort:'profile'},
          {label:'Source',width:170,sort:'source'},{label:'Status',width:140,sort:'status'},{label:'Next airing',width:110,sort:'next'},{label:'Added',width:110,sort:'added',desc:true}]}>
        {rows.map(s=>{const st=status(s),wanted=s.missing+s.cutoff;return <tr key={s.id} className={s.paused||!s.monitored?'is-off':undefined}>
          <td><TitleCell id={s.id} title={s.title} year={s.year} tags={s.keep&&<span className="ui-tag" title="Clean Up never removes it">Kept</span>}
            sub={[s.status,`${s.seasons} season${s.seasons===1?'':'s'}`].filter(Boolean).join(' · ')}/></td>
          <td className="num">{s.total||s.have?<span title={wanted?`${s.missing} missing, ${s.cutoff} below cutoff`:undefined}>{s.have} / {s.total}</span>:<Dash/>}</td>
          <td className="num">{s.size?gb(s.size):<Dash/>}</td><td>{s.profile}</td><td><SourceCell source={s.source}/></td>
          <td><Pill tone={st.tone}>{st.label}</Pill>{wanted?<small>{s.missing?`${s.missing} missing`:`${s.cutoff} below cutoff`}</small>:null}</td>
          <td><WhenDay day={s.nextAir} now={now}/></td><td><When at={s.addedAt} now={now}/></td>
        </tr>;})}
      </Table></Panel>;}}</Loaded>
  </>;
}
