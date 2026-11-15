import {useEffect,useState} from 'react';
import {tmdbExploreRows,type ExploreItem,type ExploreLayout,type ExploreRowInfo,type ExploreBrowseSource,type ExploreSources,type TmdbExploreRow} from '../../../packages/contracts/src/index.js';
import {exploreRankingDefaults,exploreRankingFields,exploreRankingFor,type ExploreRanking,type ExploreRankingField,type ExploreRowRanking} from '../../../packages/contracts/src/explore-ranking.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Loading} from './components.js';
import {Card,MoveButtons,SectionHead,moveTo,useDragOrder,useMutation} from './settings-ui.js';
import {rowKey,setExplorePrefs,showExploreRows,showExploreSource,useExplorePrefs,setStreamingProviders,setStreamingRegion} from './explore-prefs.js';
import {useStreamingCatalog} from './explore-streaming.js';
import './explore.css';
import {toast} from './toasts.js';

type LayoutView={layout:ExploreLayout&{revision:number};sources:{source:ExploreBrowseSource;configured:boolean;rows:ExploreRowInfo[];error?:string}[]};
const sourceNames:Record<ExploreBrowseSource,string>={plex:'Plex',tmdb:'TMDB'};
const tmdbLogoUrl=new URL('./assets/ratings/tmdb.svg',import.meta.url).href;

// Explore's catalog sources: the administrator orders them and picks the rows on offer in Admin › Explore; each viewer
// switches off what they don't want from those here.
export function ExploreSettings({admin}:{admin:boolean}) {
  const sources=useApi<ExploreSources>('/explore/sources');
  return <><SectionHead title="Explore"/>
    {sources.loading&&!sources.data?<Loading/>:sources.error?<ErrorNotice message={sources.error.message} retry={sources.reload}/>:sources.data&&<>
      <ExploreRowPrefs sources={sources.data}/>
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
  return <Card title="Streaming services" description="Choose which services appear in the streaming rows on Explore.">
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
// The sources and rows the administrator offers, each on until the viewer switches it off.
function ExploreRowPrefs({sources}:{sources:ExploreSources}) {
  const prefs=useExplorePrefs(),offered=sources.order.filter(s=>s==='plex'?sources.plex:sources[s].configured);
  return <Card title="Sources and rows"
    actions={<button type="button" disabled={!prefs.hidden.length&&!prefs.hiddenRows.length} onClick={()=>setExplorePrefs({...prefs,hidden:[],hiddenRows:[]})}>Show everything</button>}>
    {offered.length?<ol className="sports-order">{offered.map(s=><SourcePrefs key={s} source={s}/>)}</ol>:<p className="muted small">Explore has no sources right now.</p>}
  </Card>;
}
function SourcePrefs({source}:{source:ExploreBrowseSource}) {
  const prefs=useExplorePrefs(),rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`),[open,setOpen]=useState(false);
  const list=rows.data?.rows??[],on=!prefs.hidden.includes(source),expanded=open&&list.length>0;
  const shown=list.filter(r=>!prefs.hiddenRows.includes(rowKey(source,r.id))).length;
  return <li className="sports-sport">
    <div className="sports-row sports-sport-head">
      <button type="button" className="sports-expand" aria-expanded={expanded} disabled={!list.length} onClick={()=>setOpen(o=>!o)}><strong>{sourceNames[source]}</strong>
        <small className="muted">{rows.error?rows.error.message:!rows.data?'Loading rows…':on?`${shown} of ${list.length} rows shown`:'Off'}</small></button>
      <input type="checkbox" role="switch" className="switch" aria-label={`Show ${sourceNames[source]} on Explore`} checked={on} onChange={e=>showExploreSource(source,e.target.checked)}/>
    </div>
    {expanded&&<ol className="sports-leagues">
      <li className="sports-row sports-bulk"><button type="button" disabled={!on||shown===list.length} onClick={()=>showExploreRows(list.map(r=>rowKey(source,r.id)),true)}>Show all</button><button type="button" disabled={!on||!shown} onClick={()=>showExploreRows(list.map(r=>rowKey(source,r.id)),false)}>Hide all</button></li>
      {list.map(r=>{const key=rowKey(source,r.id);return <li key={key} className="sports-row">
        <label className="checkbox-label grow"><input type="checkbox" disabled={!on} checked={!prefs.hiddenRows.includes(key)} onChange={e=>showExploreRows([key],e.target.checked)}/>{r.title}</label>
      </li>;})}
    </ol>}
  </li>;
}
// Admin › Explore: what Explore shows and in what order.
export function ExploreAdmin() {
  return <><SectionHead title="Explore" description="Choose which rows viewers see and how titles rank within them."/><ExploreLayoutSettings/></>;
}
// The order sources are listed in on Explore, sources switched off, and single rows hidden.
function ExploreLayoutSettings() {
  const view=useApi<LayoutView>('/admin/explore/layout'),[draft,setDraft]=useState<ExploreLayout>(),[open,setOpen]=useState<ExploreBrowseSource[]>([]);
  const mutation=useMutation(view.reload),drag=useDragOrder();
  useEffect(()=>{if(view.data){const {revision:_,...value}=view.data.layout;setDraft(value);}},[view.data?.layout.revision]);
  if(view.loading&&!view.data)return <Loading/>;
  if(view.error)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data||!draft)return null;
  const data=view.data,tmdb=data.sources.find(source=>source.source==='tmdb');
  const set=(patch:Partial<ExploreLayout>)=>{setDraft(d=>d&&{...d,...patch});};
  const move=(from:number,to:number)=>set({order:moveTo(draft.order,from,to)});
  const showSource=(s:ExploreBrowseSource,on:boolean)=>set({hidden:on?draft.hidden.filter(h=>h!==s):[...draft.hidden,s]});
  const showRow=(key:string,on:boolean)=>set({hiddenRows:on?draft.hiddenRows.filter(r=>r!==key):[...draft.hiddenRows,key]});
  const toggle=(s:ExploreBrowseSource)=>setOpen(o=>o.includes(s)?o.filter(x=>x!==s):[...o,s]);
  return <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api('/admin/explore/layout','PUT',{expectedRevision:data.layout.revision,...draft});invalidate('/explore/');toast.success('Explore settings saved');});}}>
    <Card title="Order and rows" description="Move sources to change their order on Explore. Open a source to hide individual rows.">
      <ol className="sports-order">{draft.order.map((s,i)=>{
        const info=data.sources.find(x=>x.source===s),on=!draft.hidden.includes(s);
        const order=draft.tmdbOrder??[...tmdbExploreRows];
        const rows=s==='tmdb'?order.flatMap(id=>info?.rows.find(r=>r.id===id)??[]):info?.rows??[];
        const expanded=open.includes(s)&&rows.length>0;
        const shown=rows.filter(r=>!draft.hiddenRows.includes(`${s}:${r.id}`)).length;
        return <li key={s} className="sports-sport" {...drag('explore',i,move)}>
          <div className="sports-row sports-sport-head"><span className="sports-rank">{i+1}</span>
            <button type="button" className="sports-expand" aria-expanded={expanded} disabled={!rows.length} onClick={()=>toggle(s)}><strong>{sourceNames[s]}</strong>
              <small className="muted">{!info?.configured?'Not set up':info.error??(on?`${shown} of ${rows.length} rows shown`:'Off')}</small></button>
            <input type="checkbox" role="switch" className="switch" aria-label={`Show ${sourceNames[s]} on Explore`} checked={on} onChange={e=>showSource(s,e.target.checked)}/>
            <MoveButtons name={sourceNames[s]} index={i} count={draft.order.length} onMove={to=>move(i,to)}/></div>
          {expanded&&<ol className="sports-leagues">
            {rows.map((r,index)=>{const key=`${s}:${r.id}`;return <li key={key} className="sports-row">
            <label className="checkbox-label grow"><input type="checkbox" disabled={!on} checked={!draft.hiddenRows.includes(key)} onChange={e=>showRow(key,e.target.checked)}/>{r.title}</label>
            {r.personal&&<small className="muted">Each viewer’s own</small>}
            {s==='tmdb'&&<MoveButtons name={r.title} index={index} count={rows.length} onMove={to=>set({tmdbOrder:moveTo(order,index,to)})}/>}
          </li>;})}</ol>}
        </li>;})}</ol>
      {data.sources.some(x=>x.source==='plex'&&x.rows.length)&&<p className="muted small">Plex supplies the Discover shelves and their order. Streaming-service rows come from TMDB.</p>}
    </Card>
    {tmdb&&<ExploreRankingSettings rows={tmdb.rows} configured={tmdb.configured} revision={data.layout.revision}
      ranking={draft.ranking} onChange={ranking=>set({ranking})}/>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="button-row"><button className="primary" disabled={mutation.busy}>Save Explore settings</button></div>
  </form>;
}

const rankingLabels:Record<ExploreRankingField,{label:string;help:string}> = {
  releaseBoost:{label:'Recent release boost (%)',help:'Maximum popularity boost on the release or premiere date. It fades over the freshness window.'},
  releaseDays:{label:'Release window (days)',help:'Measure from the primary movie release or series premiere.'},
  seasonBoost:{label:'New season boost (%)',help:'Maximum popularity boost at the premiere of season 2 or later.'},
  seasonDays:{label:'New season window (days)',help:'The boost fades over this many days after the season premiere.'},
  audienceRating:{label:'Audience rating influence (%)',help:'Adjust scores up or down by TMDB audience rating, with fewer votes carrying less influence.'},
  minimumRating:{label:'Minimum TMDB rating',help:'Titles below this audience rating are excluded.'},
  minimumVotes:{label:'Minimum TMDB votes',help:'Titles with fewer votes are excluded.'},
  nearPopularity:{label:'Popularity multiplier at 0–44 days (%)',help:'100% uses the original TMDB popularity score.'},
  midPopularity:{label:'Popularity multiplier at 45–89 days (%)',help:'Titles 90 or more days away use 100% of their popularity score.'},
  futureDays:{label:'Upcoming window (days)',help:'Titles with a release or premiere further out are excluded.'},
  trendingDays:{label:'Trending window',help:'Use TMDB’s daily or weekly chart.'},
  freshness:{label:'Title freshness boost (%)',help:'The full boost applies for six months after release and fades by year three.'},
  genreAffinity:{label:'Genre affinity boost (%)',help:'Favor genres the viewer watches more often.'},
  eraAffinity:{label:'Release-era influence (%)',help:'Favor release years within five years of titles the viewer watches.'},
  ratingPriorVotes:{label:'Vote confidence',help:'Treat the starting rating of 6.5 as this many votes. Higher values give low-vote ratings less influence.'},
  shuffle:{label:'Daily shuffle (%)',help:'Maximum score adjustment from the repeatable daily shuffle.'},
  recommendationDecay:{label:'Recommendation rank half-weight',help:'The number of positions below the first TMDB recommendation where its influence is halved.'},
  watchRankRetention:{label:'Watch order retention (%)',help:'The influence each watched title retains per position lower in the watch-history list.'},
  watchHalfLife:{label:'Watch recency half-life (days)',help:'Days until an older watch’s recency contribution halves, down to a 25% floor.'},
  watchFrequency:{label:'Watch frequency boost (%)',help:'Maximum extra influence for titles played more often.'},
  variety:{label:'Genre and franchise variety',help:'Space out titles from the same franchise or genre when alternatives are available.'},
  seedDiversity:{label:'Spread picks across watched titles',help:'Avoid letting recommendations from one watched title dominate the row.'}
};

const rankingSummary:Record<TmdbExploreRow,string> = {
  'popular-movies':'TMDB popularity is the baseline for released movies. Release freshness and vote-adjusted ratings can change the order.',
  'popular-shows':'TMDB popularity is the baseline for shows that have premiered. Series premieres and returning seasons have separate boosts.',
  'popular-streaming':'Titles alternate between movies and shows in TMDB popularity order within the viewer’s region and selected subscription services.',
  'recent-streaming':'Movies and shows alternate, newest releases first within each group. Availability is checked against the viewer’s selected subscription services.',
  trending:'Movies and shows alternate in their TMDB chart order.',
  acclaimed:'Movies and shows alternate in TMDB audience-rating order.',
  'upcoming-movies':'TMDB popularity is multiplied by the title’s release-date band.',
  'upcoming-shows':'TMDB popularity is multiplied by the series premiere’s date band.',
  'top-movies':'Recommendations backed by several watched movies gain influence.',
  'top-shows':'Recommendations backed by several watched shows gain influence.',
  'because-movie':'Rank recommendations from one of the viewer’s recently watched movies.',
  'because-show':'Rank recommendations from one of the viewer’s recently watched shows.'
};

function RankingInput({field,value,popular,onChange}:{field:ExploreRankingField;value:number;popular:boolean;onChange:(value:number)=>void}) {
  const [text,setText]=useState(String(value));
  useEffect(()=>{setText(String(value));},[value]);
  const {label,help}=rankingLabels[field];
  const options=field==='trendingDays'?[[1,'Daily'],[7,'Weekly']]:field==='variety'||field==='seedDiversity'?[[0,'Off'],[1,'On']]:undefined;
  return <label>{label}
    {options?<select value={value} onChange={e=>onChange(Number(e.target.value))}>
      {options.map(([id,name])=><option key={id} value={id}>{name}</option>)}
    </select>:<input type="number" required {...exploreRankingFields[field]} value={text} onChange={e=>{
      const input=e.currentTarget;
      setText(input.value);
      if(input.validity.valid)onChange(input.valueAsNumber);
    }} onBlur={()=>setText(String(value))}/>}
    <small className="muted">{field==='releaseDays'&&popular?'The boost fades over this many days. Older titles can still appear.':help}</small>
  </label>;
}

function ExploreRankingSettings({rows,configured,revision,ranking,onChange}:{rows:ExploreRowInfo[];configured:boolean;revision:number;
  ranking?:ExploreRanking;onChange:(ranking:ExploreRanking)=>void}) {
  const [row,setRow]=useState<TmdbExploreRow>('popular-movies');
  const [preview,setPreview]=useState<{key:string;saved:ExploreItem[];preview:ExploreItem[]}>();
  const mutation=useMutation(()=>{});
  const settings=exploreRankingFor(row,ranking) as ExploreRowRanking;
  const fields=Object.keys(exploreRankingDefaults[row]) as ExploreRankingField[];
  const key=JSON.stringify([revision,row,settings]);
  const popular=row==='popular-movies'||row==='popular-shows';
  const reset=()=>{
    const next={...ranking};
    delete next[row];
    onChange(next);
  };
  return <Card title="Row ranking" description="Tune how titles are ordered within a TMDB row for all viewers.">
    <div className="form-stack">
      <label className="narrow">TMDB row<select value={row} onChange={e=>setRow(e.target.value as TmdbExploreRow)}>
        {rows.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}
      </select></label>
      <p className="muted small">{rankingSummary[row]}</p>
      {fields.length>0&&<div className="explore-ranking-fields">
        {fields.map(field=><RankingInput key={`${row}:${field}`} field={field} value={settings[field]!} popular={popular} onChange={value=>{
          onChange({...ranking,[row]:{...ranking?.[row],[field]:value}});
        }}/>)}</div>}
      <div className="button-row">
        {fields.length>0&&<button type="button" disabled={!ranking?.[row]} onClick={reset}>Reset row to defaults</button>}
        {popular&&<button type="button" disabled={!configured||mutation.busy} onClick={()=>void mutation.run(async()=>{
          const result=await api<{saved:ExploreItem[];preview:ExploreItem[]}>('/admin/explore/ranking/preview','POST',{row,settings});
          setPreview({key,...result});
        })}>{mutation.busy?'Loading preview…':'Preview ranking'}</button>}
      </div>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      {preview?.key===key&&<div className="explore-ranking-fields explore-ranking-preview">
        {([['Saved order',preview.saved],['Draft order',preview.preview]] as const).map(([title,items])=><section key={title}>
          <h3>{title}</h3>
          {items.length?<ol>{items.slice(0,8).map(item=><li key={item.key}>{item.title}{item.year&&<small className="muted"> ({item.year})</small>}</li>)}</ol>:<p className="muted small">No titles found.</p>}
        </section>)}
      </div>}
    </div>
  </Card>;
}
