import {Fragment,useState} from 'react';
import type {ShowEpisodeView,ShowSeasonView,ShowTitleView} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {ErrorNotice,Icon} from './components.js';
import {Switch} from './settings-ui.js';
import {toast} from './toasts.js';
import {InteractiveSearchPanel} from './interactive-search.js';
import {RequestsTable,SourceLine} from './movie-source.js';
import {FilesTable,GrabsTable,TitleControls,type Mutation} from './movie-dialog.js';
import {ACTIONS,Dash,FavoriteStar,GrabPill,IconAction,Panel,Pill,Poster,RowActions,Table,Tabs,When,WhenDay,gb,type TitlePane,type Tone} from './manage-ui.js';

// A show in the library (docs/UI.md), in the same dialog as a movie (movie-dialog.tsx): its seasons with their
// switches, each season's episodes with what tk.box has, its files, grabs and requests, and Interactive search for a season
// (S02) or an episode (S02E05, `&scope=`).

const pad=(n:number)=>String(n).padStart(2,'0');
const scopeOf=(season:number,episode?:number)=>`S${pad(season)}${episode===undefined?'':`E${pad(episode)}`}`;
const parseScope=(scope?:string)=>{const m=/^S(\d+)(?:E(\d+))?$/.exec(scope??'');return m?{season:Number(m[1]),...(m[2]?{episode:Number(m[2])}:{})}:undefined;};
const modes:Record<string,string>={all:'All',future:'Future',first:'First season',last:'Last season',manual:'Chosen seasons',none:'None'};
const downloading=(e:ShowEpisodeView)=>!!e.grab&&['sending','downloading','unpacking','importing'].includes(e.grab);

function episodeStatus(e:ShowEpisodeView):{tone:Tone;label:string} {
  if(downloading(e))return {tone:'active',label:'Downloading'};
  if(!e.aired&&!e.file)return {tone:'off',label:'Not aired'};
  if(!e.monitored&&!e.file)return {tone:'off',label:'Not monitored'};
  if(e.wanted==='cutoff')return {tone:'wait',label:'Below cutoff'};
  if(e.file)return {tone:'ok',label:'Available'};
  return e.monitored?{tone:'wait',label:'Missing'}:{tone:'off',label:'Not monitored'};
}
function seasonStatus(s:ShowSeasonView):{tone:Tone;label:string} {
  if(s.episodes.some(downloading))return {tone:'active',label:'Downloading'};
  if(!s.monitored)return {tone:'off',label:'Not monitored'};
  if(s.episodes.some(e=>e.wanted==='missing'))return {tone:'wait',label:'Missing'};
  if(s.episodes.some(e=>e.wanted==='cutoff'))return {tone:'wait',label:'Below cutoff'};
  if(!s.episodes.some(e=>e.aired||e.file))return {tone:'off',label:'Not aired'};
  return {tone:'ok',label:'Available'};
}
function showStatus(t:ShowTitleView):{tone:Tone;label:string} {
  if(!t.monitored)return {tone:'off',label:'Not monitored'};
  if(t.paused)return {tone:'bad',label:'Failing'};
  if(t.seasons.some(s=>s.episodes.some(downloading)))return {tone:'active',label:'Downloading'};
  if(t.wanted.missing)return {tone:'wait',label:'Missing'};
  if(t.wanted.cutoff)return {tone:'wait',label:'Below cutoff'};
  return {tone:'ok',label:'Available'};
}
// Episodes held of those that count (aired and monitored, or with a file), and their files' size.
function counts(episodes:ShowEpisodeView[]) {
  const files=new Map<number,number>();
  for(const e of episodes)if(e.file)files.set(e.file.id,e.file.size);
  return {have:episodes.filter(e=>e.file).length,total:episodes.filter(e=>e.file||(e.aired&&e.monitored)).length,size:[...files.values()].reduce((a,b)=>a+b,0)};
}

export function ShowDialogBody({t,path,pane,scope,setPane,mutation}:{t:ShowTitleView;path:string;pane:TitlePane;scope?:string;setPane:(pane:TitlePane,scope?:string)=>void;mutation:Mutation}) {
  const search=(scope?:string)=>void mutation.run(async()=>{await api(`${path}/search`,'POST',scope?{scope}:{});toast.info(`Searching for ${t.title}${scope?` ${scope}`:''}`);});
  const interactive=(scope:string)=>setPane('search',scope);
  return <div className="ui-movie-dialog">
    <Head t={t} path={path} mutation={mutation} search={()=>search()}/>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Tabs label={t.title} value={pane} onChange={p=>setPane(p,p==='search'?scope:undefined)} tabs={[{id:'overview',label:'Seasons',count:t.seasons.length},
      {id:'files',label:'Files',count:t.files.length},{id:'grabs',label:'Grabs',count:t.grabs.length},{id:'requests',label:'Requests',count:t.requests.length},{id:'search',label:'Interactive search'}]}/>
    {pane==='search'?<ShowSearch t={t} scope={scope} setScope={s=>setPane('search',s)}/>
      :pane==='files'?<Panel flush><FilesTable files={t.files} now={Date.now()}/></Panel>
      :pane==='grabs'?<Panel flush><GrabsTable grabs={t.grabs} now={Date.now()}/></Panel>
      :pane==='requests'?<Panel flush><RequestsTable requests={t.requests} show/></Panel>
      :<Panel flush><SeasonsTable t={t} path={path} mutation={mutation} search={search} interactive={interactive}/></Panel>}
  </div>;
}

function Head({t,path,mutation,search}:{t:ShowTitleView;path:string;mutation:Mutation;search:()=>void}) {
  const now=Date.now(),s=showStatus(t),all=t.seasons.flatMap(x=>x.episodes),{have,total,size}=counts(all);
  const today=new Date(now).toISOString().slice(0,10),next=all.filter(e=>!e.aired&&e.airDate&&e.airDate>=today).map(e=>e.airDate!).sort()[0];
  return <header className="ui-movie">
    <Poster id={t.id} className="ui-movie-poster"/>
    <div className="ui-movie-main">
      <div>
        <h2 className="ui-movie-title">{t.title}{t.year?<span> {t.year}</span>:null}</h2>
        <div className="ui-movie-line"><Pill tone={s.tone}>{s.label}</Pill><span>{have} of {total} episodes{size?` · ${gb(size)}`:''}</span>{t.status&&<span>{t.status}</span>}
          {t.keep&&<FavoriteStar/>}{t.pausedReason&&<span className="danger-text">{t.pausedReason}</span>}</div>
        <div className="ui-movie-source"><SourceLine source={t.source} addedAt={t.addedAt}/></div>
      </div>
      <dl className="ui-facts">
        <div><dt>Next airing</dt><dd><WhenDay day={next} now={now}/></dd></div>
        <div><dt>Missing</dt><dd>{t.wanted.missing}</dd></div>
        <div><dt>Below cutoff</dt><dd>{t.wanted.cutoff}</dd></div>
        <div><dt>Seasons</dt><dd>{t.seasons.length}</dd></div>
        <div><dt>Follows</dt><dd>{modes[t.monitor]??t.monitor}</dd></div>
      </dl>
      <TitleControls t={t} path={path} mutation={mutation}>
        <button disabled={mutation.busy||t.paused||!t.monitored||!t.wanted.missing&&!t.wanted.cutoff} title="Search now for every wanted episode and grab the best matches" onClick={search}>
          <Icon name="search" size={16}/>Automatic search</button>
      </TitleControls>
    </div>
  </header>;
}

// One row per season, opening to its episodes. A season's switch turns it and its episodes on or off.
function SeasonsTable({t,path,mutation,search,interactive}:{t:ShowTitleView;path:string;mutation:Mutation;search:(scope:string)=>void;interactive:(scope:string)=>void}) {
  const [open,setOpen]=useState<Set<number>>(()=>new Set());
  const toggle=(n:number)=>setOpen(o=>{const next=new Set(o);if(next.has(n))next.delete(n);else next.add(n);return next;});
  const monitor=(n:number,monitored:boolean)=>void mutation.run(()=>api(`${path}/seasons/${n}`,'PUT',{monitored}));
  const now=Date.now(),searchable=!t.paused&&t.monitored;
  return <Table empty={t.seasons.length?undefined:'No seasons'} columns={[{label:'Season'},{label:'Have',width:130},{label:'Size',width:90,num:true},{label:'Aired',width:110},
    {label:'Status',width:140},{label:'Monitored',width:96},ACTIONS]}>
    {t.seasons.map(s=>{const expanded=open.has(s.season),c=counts(s.episodes),st=seasonStatus(s),wanted=s.episodes.some(e=>e.wanted&&!downloading(e)),scope=scopeOf(s.season);
      return <Fragment key={s.season}>
        <tr className={`ui-release ${expanded?'is-open':''} ${s.monitored?'':'is-off'}`} onClick={()=>toggle(s.season)}>
          <td><div className="ui-release-name"><Icon name={expanded?'down':'next'} size={14}/><div><span className="ui-title-name">Season {s.season}</span>
            <small>{s.episodes.length} episode{s.episodes.length===1?'':'s'}{s.lastAt?<> · searched <When at={s.lastAt} now={now}/></>:''}</small></div></div></td>
          <td>{c.total||c.have?`${c.have} of ${c.total}`:<Dash/>}</td>
          <td className="num">{c.size?gb(c.size):<Dash/>}</td>
          <td><WhenDay day={s.episodes.find(e=>e.airDate)?.airDate} now={now}/></td>
          <td><Pill tone={st.tone}>{st.label}</Pill></td>
          <td onClick={e=>e.stopPropagation()}><Switch label="" ariaLabel={`Monitor season ${s.season}`} checked={s.monitored} disabled={mutation.busy} onChange={on=>monitor(s.season,on)}/></td>
          <td onClick={e=>e.stopPropagation()}><RowActions>
            <IconAction icon="search" label={`Automatic search for season ${s.season}`} disabled={mutation.busy||!searchable||!wanted} onClick={()=>search(scope)}/>
            <IconAction icon="list" label={`Interactive search for season ${s.season}`} onClick={()=>interactive(scope)}/>
          </RowActions></td>
        </tr>
        {expanded&&s.episodes.map(e=><EpisodeRow key={e.episode} season={s.season} e={e} now={now} busy={mutation.busy} searchable={searchable} search={search} interactive={interactive}/>)}
      </Fragment>;})}
  </Table>;
}
function EpisodeRow({season,e,now,busy,searchable,search,interactive}:{season:number;e:ShowEpisodeView;now:number;busy:boolean;searchable:boolean;search:(scope:string)=>void;interactive:(scope:string)=>void}) {
  const st=episodeStatus(e),scope=scopeOf(season,e.episode);
  return <tr className={`ui-episode ${e.monitored?'':'is-off'}`}>
    <td><div className="ui-episode-name"><span className="ui-mono">E{pad(e.episode)}</span><div><span title={e.name}>{e.name??`Episode ${e.episode}`}</span>
      {e.lastAt?<small>Searched <When at={e.lastAt} now={now}/></small>:null}</div></div></td>
    <td>{e.file?.quality??<Dash/>}</td>
    <td className="num">{e.file?gb(e.file.size):<Dash/>}</td>
    <td><WhenDay day={e.airDate} now={now}/></td>
    <td>{e.grab&&downloading(e)?<GrabPill state={e.grab}/>:<Pill tone={st.tone}>{st.label}</Pill>}</td>
    <td/>
    <td><RowActions>
      <IconAction icon="search" label={`Automatic search for ${scope}`} disabled={busy||!searchable||!e.wanted||downloading(e)} onClick={()=>search(scope)}/>
      <IconAction icon="list" label={`Interactive search for ${scope}`} onClick={()=>interactive(scope)}/>
    </RowActions></td>
  </tr>;
}

// Interactive search for a season or an episode, picked in the search's own bar. With none asked for, the first
// season with wanted episodes, else the last season.
function ShowSearch({t,scope,setScope}:{t:ShowTitleView;scope?:string;setScope:(scope:string)=>void}) {
  const fallback=t.seasons.find(s=>s.episodes.some(e=>e.wanted))??t.seasons[t.seasons.length-1];
  const asked=parseScope(scope),season=t.seasons.find(s=>s.season===asked?.season)??fallback;
  if(!season)return <Panel><div className="ui-empty">No seasons to search</div></Panel>;
  const episode=season.episodes.find(e=>e.episode===asked?.episode)?.episode,current=scopeOf(season.season,episode);
  const controls=<>
    <select className="ui-scope-season" aria-label="Season" value={season.season} onChange={e=>setScope(scopeOf(Number(e.target.value)))}>
      {t.seasons.map(s=><option key={s.season} value={s.season}>Season {s.season}</option>)}</select>
    <select className="ui-scope-episode" aria-label="Episode" value={episode??''} onChange={e=>setScope(scopeOf(season.season,e.target.value?Number(e.target.value):undefined))}>
      <option value="">Whole season</option>{season.episodes.map(e=><option key={e.episode} value={e.episode}>E{pad(e.episode)}{e.name?` · ${e.name}`:''}</option>)}</select>
  </>;
  return <InteractiveSearchPanel key={current} titleId={t.id} scope={current} controls={controls}/>;
}
