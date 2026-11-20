import type {CSSProperties} from 'react';
import type {DownloadStats,DownloadStatsCount,IndexerStats} from '../../../packages/contracts/src/downloads.js';
import {useApi} from './hooks.js';
import {Dash,Loaded,Panel,Table} from './manage-ui.js';
import {Stat} from './settings-ui.js';
import './history-admin.css';
import './download-stats.css';

// Downloads › History › Stats: the period's grabs (by day, indexer, downloader and quality) and how the indexers'
// searches went. Days are UTC, as the indexers' daily caps count them.

export const statsPeriods=[['7','7 d'],['30','30 d'],['90','90 d'],['365','1 y'],['all','All']] as const;
export type StatsPeriod=typeof statsPeriods[number][0];
const DAY=86400000;
const names:Record<string,string>={nzbgeek:'NZBGeek',iptorrents:'IPTorrents',sabnzbd:'SABnzbd',qbittorrent:'qBittorrent'};
const nameOf=(n:string)=>names[n]??n;
const shortDay=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',timeZone:'UTC'});
const dayLabel=(day:string)=>shortDay.format(Date.parse(`${day}T12:00:00Z`));
const utcDay=(at:number)=>new Date(at).toISOString().slice(0,10);
const size=(b:number)=>b>=1024**4?`${(b/1024**4).toFixed(2)} TB`:b>=1024**3?`${(b/1024**3).toFixed(1)} GB`:`${Math.round(b/1024**2)} MB`;
const took=(ms?:number)=>{if(ms===undefined)return undefined;const m=Math.round(ms/60000);return m<60?`${Math.max(1,m)} min`:`${Math.floor(m/60)} h ${m%60} min`;};
const speed=(bps?:number)=>bps===undefined?undefined:`${(bps/1024**2).toFixed(1)} MB/s`;
const share=(n:number,of:number)=>of?`${Math.round(n/of*100)}%`:'—';
const num=(n:number)=>n.toLocaleString();

// Every day of the period, a day with nothing as an empty slot, so gaps show as gaps.
function series<T extends {day:string}>(days:T[],period:StatsPeriod,empty:(day:string)=>T):T[] {
  const today=Date.now(),first=days[0]?.day;
  const count=period==='all'?Math.min(366,first?Math.round((Date.parse(`${utcDay(today)}T00:00:00Z`)-Date.parse(`${first}T00:00:00Z`))/DAY)+1:1):Number(period);
  const byDay=new Map(days.map(d=>[d.day,d]));
  return Array.from({length:count},(_,i)=>{const day=utcDay(today-(count-1-i)*DAY);return byDay.get(day)??empty(day);});
}

type Part={key:string;label:string;value:number};
// Stacked day bars: each day's parts, biggest total on top of the axis.
function DayBars({days,unit}:{days:{day:string;parts:Part[]}[];unit:string}) {
  const total=(d:typeof days[number])=>d.parts.reduce((n,p)=>n+p.value,0),top=Math.max(1,...days.map(total));
  return <div className="history-chart">
    <span className="history-axis-top">{num(top)}</span>
    <div className="history-days" style={{gap:days.length>90?1:2} as CSSProperties}>{days.map(d=>{
      const t=total(d),label=`${dayLabel(d.day)} · ${num(t)} ${unit}${t?` (${d.parts.filter(p=>p.value).map(p=>`${p.label} ${p.value}`).join(', ')})`:''}`;
      return <div key={d.day} className="history-col" title={label} aria-label={label}>
        <div className="history-stack" style={{height:`${t/top*100}%`}}>{[...d.parts].reverse().filter(p=>p.value).map(p=><span key={p.key} data-mode={p.key} style={{flexGrow:p.value}}/>)}</div></div>;
    })}</div>
    <div className="history-axis">{[days[0],days[Math.floor(days.length/2)],days.at(-1)].map((d,i)=>d&&<span key={i}>{dayLabel(d.day)}</span>)}</div>
  </div>;
}
const Legend=({items}:{items:[string,string][]})=><ul className="history-legend">{items.map(([k,l])=><li key={k}><i data-mode={k}/>{l}</li>)}</ul>;
const Meter=({value,top}:{value:number;top:number})=><><span className="history-meter"><span style={{width:`${value/top*100}%`}}/></span><b className="history-meter-n">{num(value)}</b></>;
const Rate=({n,of}:{n:number;of:number})=>of?<>{share(n,of)}</>:<Dash/>;
const or=(text?:string)=>text??<Dash/>;

export function DownloadStatsTab({period}:{period:StatsPeriod}) {
  const grabs=useApi<DownloadStats>(`/admin/library/stats?days=${period}`),searches=useApi<IndexerStats>(`/admin/indexers/stats?days=${period}`);
  return <Loaded view={grabs}>{g=><Loaded view={searches}>{s=>{
    const t=g.totals,done=t.grabs-t.active;
    const grabDays=series(g.days,period,day=>({day,grabs:0,imported:0,failed:0,bytes:0}))
      .map(d=>({day:d.day,parts:[{key:'imported',label:'Imported',value:d.imported},{key:'failed',label:'Failed',value:d.failed},{key:'other',label:'Other',value:d.grabs-d.imported-d.failed}]}));
    const searchDay=new Map<string,Record<string,number>>();
    for(const i of s.indexers)for(const d of i.days)searchDay.set(d.day,{...searchDay.get(d.day),[i.name]:d.searches});
    const searchDays=series([...searchDay.keys()].sort().map(day=>({day})),period,day=>({day}))
      .map(d=>({day:d.day,parts:s.indexers.map(i=>({key:i.name,label:nameOf(i.name),value:searchDay.get(d.day)?.[i.name]??0}))}));
    // An indexer's searches (from its own counts) beside how its grabs went.
    const grabsBy=new Map(g.indexers.map(i=>[i.name,i]));
    const indexerRows=[...s.indexers.map(i=>({name:i.name,search:i,grab:grabsBy.get(i.name)})),
      ...g.indexers.filter(i=>!s.indexers.some(x=>x.name===i.name)).map(i=>({name:i.name,search:undefined,grab:i}))];
    const from=period==='all'?0:Date.now()-Number(period)*DAY,partial=s.loggedSince===undefined||s.loggedSince>from;
    const logNote=s.loggedSince===undefined?'Search times start with the next search':partial?`Search times since ${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(s.loggedSince)}`:undefined;
    const topQuality=Math.max(1,...g.qualities.map(q=>q.grabs));
    const counts=(c?:DownloadStatsCount)=>c?<><td className="num">{num(c.grabs)}</td><td className="num"><Rate n={c.imported} of={c.grabs}/></td>
      <td className={`num ${c.failed?'danger-text':''}`}>{c.failed?num(c.failed):<Dash/>}</td></>:<><td className="num"><Dash/></td><td className="num"><Dash/></td><td className="num"><Dash/></td></>;
    return <div className="history-graphs">
      <div className="history-stats">
        <Stat label="Grabs" value={num(t.grabs)} hint={t.active?`${num(t.active)} under way`:undefined}/>
        <Stat label="Imported" value={share(t.imported,done)} hint={`${num(t.imported)} of ${num(done)}`}/>
        <Stat label="Failed" value={share(t.failed,done)} hint={t.cancelled?`${num(t.failed)} · ${num(t.cancelled)} cancelled`:num(t.failed)}/>
        <Stat label="Downloaded" value={size(t.bytes)}/>
        <Stat label="Upgrades" value={num(t.upgrades)} hint={share(t.upgrades,t.grabs)}/>
      </div>
      <Panel title="Grabs a day" actions={<Legend items={[['imported','Imported'],['failed','Failed'],['other','Other']]}/>}>
        <DayBars days={grabDays} unit="grabs"/>
      </Panel>
      <Panel title="Searches a day" actions={<Legend items={s.indexers.map(i=>[i.name,nameOf(i.name)])}/>}>
        <DayBars days={searchDays} unit="searches"/>
      </Panel>
      <Panel flush title="Indexers" actions={logNote&&<span className="muted small">{logNote}</span>}>
        <Table empty={indexerRows.length?undefined:'No indexers yet'} columns={[{label:'Indexer'},{label:'Searches',width:90,num:true},{label:'Errors',width:80,num:true},
          {label:'Response',width:100,num:true},{label:'Results',width:80,num:true},{label:'Grabs',width:80,num:true},{label:'Imported',width:90,num:true},{label:'Failed',width:80,num:true}]}>
          {indexerRows.map(({name,search:i,grab})=><tr key={name}><td>{nameOf(name)}</td>
            <td className="num">{i?num(i.searches):<Dash/>}</td>
            <td className={`num ${i?.failed?'danger-text':''}`} title={i?.queries?`${share(i.failed,i.queries)} of ${num(i.queries)} logged`:undefined}>{i?.failed?num(i.failed):<Dash/>}</td>
            <td className="num">{or(i?.avgMs!==undefined?i.avgMs<1000?`${i.avgMs} ms`:`${(i.avgMs/1000).toFixed(1)} s`:undefined)}</td>
            <td className="num">{or(i?.avgResults!==undefined?num(i.avgResults):undefined)}</td>
            {counts(grab)}</tr>)}
        </Table>
      </Panel>
      <Panel flush title="Downloaders">
        <Table empty={g.downloaders.length?undefined:'Nothing downloaded'} columns={[{label:'Downloader'},{label:'Grabs',width:80,num:true},{label:'Imported',width:90,num:true},
          {label:'Failed',width:80,num:true},{label:'Size',width:90,num:true},{label:'Avg time',width:110,num:true},{label:'Avg speed',width:110,num:true}]}>
          {g.downloaders.map(d=><tr key={d.name}><td>{nameOf(d.name)}</td>{counts(d)}
            <td className="num">{d.bytes?size(d.bytes):<Dash/>}</td><td className="num">{or(took(d.avgMs))}</td><td className="num">{or(speed(d.avgSpeed))}</td></tr>)}
        </Table>
      </Panel>
      <Panel flush title="Qualities">
        <Table empty={g.qualities.length?undefined:'Nothing grabbed'} columns={[{label:'Quality'},{label:'Grabs',width:180},{label:'Size',width:90,num:true}]}>
          {g.qualities.map(q=><tr key={q.name}><td>{q.name}</td><td><Meter value={q.grabs} top={topQuality}/></td><td className="num">{q.bytes?size(q.bytes):<Dash/>}</td></tr>)}
        </Table>
      </Panel>
    </div>;
  }}</Loaded>}</Loaded>;
}
