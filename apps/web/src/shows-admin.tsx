import {useMemo,useState} from 'react';
import {QuickEdit} from './quick-edit.js';
import type {ShowList,ShowRow} from '../../../packages/contracts/src/downloads.js';
import {useApi} from './hooks.js';
import {SectionHead} from './settings-ui.js';
import {SourceCell,sourceLabel} from './movie-source.js';
import {CountBar,Dash,FavoriteStar,Loaded,MediaStatusPill,Panel,Pill,SelectCell,Segmented,Table,TitleCell,Toolbar,WhenDay,gb,matches,usePaged,useRefresh,selectColumn,useSelection,useSorted,type Tone} from './manage-ui.js';

// Admin › Manage › Shows (docs/PHASE-2.md, docs/UI.md): every show in the library, like Movies. A show opens as a
// dialog (show-dialog.tsx). Shows come in through requests, or the one-time import.

const filters=[['all','All'],['missing','Missing'],['cutoff','Below cutoff'],['airing','Airing'],['kept','Favorites'],['paused','Failing'],['unmonitored','Unmonitored']] as const;
type Filter=typeof filters[number][0];
const sources=[['all','Any source'],['request','Requests'],['imported','Imported']] as const;
type SourceFilter=typeof sources[number][0];
const ended=(s:ShowRow)=>s.status==='Ended'||s.status==='Canceled';
const shown=(s:ShowRow,f:Filter)=>f==='all'||(f==='missing'?s.missing>0:f==='cutoff'?s.cutoff>0:f==='airing'?!ended(s):f==='kept'?s.keep:f==='paused'?s.paused:!s.monitored);
// One status per show: what it needs, or what is happening to it.
function status(s:ShowRow):{tone:Tone;label:string} {
  if(!s.monitored)return {tone:'off',label:'Not monitored'};
  if(s.paused)return {tone:'bad',label:'Failing'};
  if(s.grabbing)return {tone:'active',label:'Downloading'};
  if(s.missing)return {tone:'wait',label:'Missing'};
  if(s.cutoff)return {tone:'wait',label:'Below cutoff'};
  return {tone:'ok',label:'Available'};
}
// The Episodes bar: grey unmonitored or nothing to count (0 / 0), red with episodes missing, green complete and ended, blue complete and airing.
const barTone=(s:ShowRow):Tone=>!s.monitored||!s.total?'off':s.missing?'bad':ended(s)?'ok':'active';
// The show's own status (TMDB's), as a pill with an icon.
function airing(s:ShowRow):{tone:Tone;label:string;icon:string}|undefined {
  switch(s.status){
    case undefined:return undefined;
    case 'Returning Series':return {tone:'ok',label:'Returning',icon:'restart'};
    case 'Ended':return {tone:'off',label:'Ended',icon:'check'};
    case 'Canceled':return {tone:'bad',label:'Cancelled',icon:'close'};
    case 'In Production':return {tone:'wait',label:'In production',icon:'clock'};
    case 'Planned':return {tone:'wait',label:'Planned',icon:'calendar'};
    case 'Pilot':return {tone:'wait',label:'Pilot',icon:'play'};
    default:return {tone:'off',label:s.status,icon:'info'};
  }
}
// Which episode airs next: Series Premiere, Season 5 Premiere, Special, S1·E5.
const nextName=({season,episode}:{season:number;episode:number})=>
  season===0?'Special':episode===1?(season===1?'Series Premiere':`Season ${season} Premiere`):`S${season}·E${episode}`;
const showSorts={title:(s:ShowRow)=>s.title,have:(s:ShowRow)=>s.total?s.have/s.total:undefined,size:(s:ShowRow)=>s.size||undefined,profile:(s:ShowRow)=>s.profile,
  source:(s:ShowRow)=>sourceLabel(s.source),status:(s:ShowRow)=>status(s).label,next:(s:ShowRow)=>s.nextAir?.day,show:(s:ShowRow)=>airing(s)?.label};

export function ShowsPage() {
  const view=useApi<ShowList>('/admin/library/shows');useRefresh(view.reload,30000);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<Filter>('all'),[from,setFrom]=useState<SourceFilter>('all');
  const items=(view.data?.items??[]).filter(s=>matches(query,s.title,s.year,s.profile,s.status,...(s.source.kind==='request'?s.source.requests.map(r=>r.name):[]))
    &&shown(s,filter)&&(from==='all'||s.source.kind===from))
    .sort((a,b)=>a.title.localeCompare(b.title));
  const {rows:sorted,sort,onSort}=useSorted(items,showSorts);
  const present=useMemo(()=>(view.data?.items??[]).map(s=>s.id),[view.data]),sel=useSelection(sorted.map(s=>s.id),present);
  const picked=useMemo(()=>(view.data?.items??[]).filter(s=>sel.has(s.id)),[view.data,sel]);
  const {rows,more}=usePaged(sorted,`${query}|${filter}|${from}|${sort?.key}|${sort?.dir}`,{auto:true});
  return <><SectionHead title="Shows"/>
    <Toolbar query={query} setQuery={setQuery} placeholder="Search shows or requesters" count={view.data?`${items.length} of ${view.data.items.length}`:undefined}>
      <Segmented label="Show" value={filter} options={filters} onChange={setFilter}/>
      <Segmented label="Source" value={from} options={sources} onChange={setFrom}/>
    </Toolbar>
    <Loaded view={view}>{({items:all})=>{const now=Date.now();return <Panel flush>
      <Table posters more={more} sort={sort} onSort={onSort} empty={!all.length?'No shows in the library':!items.length?'No show matches':undefined}
        columns={[selectColumn(sel),{label:'Title',sort:'title'},{label:'Episodes',width:130,sort:'have',desc:true},{label:'Size',width:90,num:true,sort:'size',desc:true},{label:'Profile',width:110,sort:'profile'},
          {label:'Source',width:170,sort:'source'},{label:'Status',width:140,sort:'status'},{label:'Airing',width:140,sort:'next'},{label:'Show',width:140,sort:'show'}]}>
        {rows.map(s=>{const st=status(s),wanted=s.missing+s.cutoff;return <tr key={s.id} className={[!s.monitored?'is-off':'',sel.has(s.id)?'is-picked':''].join(' ').trim()||undefined}>
          <SelectCell sel={sel} id={s.id} label={s.title}/><td><TitleCell id={s.id} title={s.title} year={s.year} tags={s.keep&&<FavoriteStar/>}
            sub={`${s.seasons} season${s.seasons===1?'':'s'}`}/></td>
          <td><CountBar have={s.have} total={s.total} tone={barTone(s)} title={wanted?`${s.missing} missing, ${s.cutoff} below cutoff`:undefined}/></td>
          <td className="num">{s.size?gb(s.size):<Dash/>}</td><td>{s.profile}</td><td><SourceCell source={s.source}/></td>
          <td><MediaStatusPill tone={st.tone}>{st.label}</MediaStatusPill>{wanted?<small>{s.missing?`${s.missing} missing`:`${s.cutoff} below cutoff`}</small>:null}</td>
          <td>{s.nextAir?<><WhenDay day={s.nextAir.day} now={now}/><small>{nextName(s.nextAir)}</small></>:<Dash/>}</td><td>{(a=>a?<Pill tone={a.tone} icon={a.icon}>{a.label}</Pill>:<Dash/>)(airing(s))}</td>
        </tr>;})}
      </Table></Panel>;}}</Loaded>
    <QuickEdit sel={sel} noun={['show','shows']} picked={picked}/>
  </>;
}
