import {Fragment,useState} from 'react';
import type {ClientState,DownloadItem,DownloadsActivity,DownloadsHistory,DownloadsHistoryGrab,DownloadsJob,DownloadsStep,GrabEventKind,GrabOutcome,DownloadsLive,WantedItem,
  WantedList} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {replaceRoute,link,useApi} from './hooks.js';
import {ErrorNotice,Icon} from './components.js';
import {SectionHead,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {ACTIONS,Dash,GrabPill,IconAction,Loaded,MediaStatusPill,Panel,Pill,RowActions,Segmented,Table,Tag,TitleCell,Toolbar,When,changed,grabNames,matches,openMovie,qualityRank,relative,usePaged,useRefresh,
  useSorted,type Tone} from './manage-ui.js';

// Admin › Downloads › Queue and Wanted (docs/PHASE-3.5.md, docs/UI.md). A show's grab names its episodes (S02,
// S02E05); Wanted lists a show's searches, a season pack or an episode each.

// ---- Queue: everything SABnzbd and qBittorrent hold, any category, in one table ----

const protocol=(p:'usenet'|'torrent')=>p==='usenet'?'Usenet':'Torrent';
const clientNames={sabnzbd:'SABnzbd',qbittorrent:'qBittorrent'} as const;
const stateWords:Record<ClientState,[string,Tone]>={queued:['Queued','wait'],paused:['Paused','off'],downloading:['Downloading','active'],stalled:['Stalled','wait'],
  checking:['Checking','active'],moving:['Moving','active'],unpacking:['Unpacking','active'],importing:['Importing','active'],seeding:['Seeding','active'],
  completed:['Done','ok'],failed:['Failed','bad']};
// The status filter: each client state falls in exactly one group.
type Status='all'|'waiting'|'progress'|'problems'|'done';
const statusOf:Record<ClientState,Exclude<Status,'all'>>={queued:'waiting',paused:'waiting',downloading:'progress',stalled:'progress',checking:'progress',moving:'progress',
  unpacking:'progress',importing:'progress',failed:'problems',seeding:'done',completed:'done'};
const statusNames:Record<Status,string>={all:'All',waiting:'Waiting',progress:'In progress',problems:'Problems',done:'Done'};
// Old Queue tabs still in links and bookmarks.
const oldViews:Record<string,Status>={active:'progress',finished:'done',recent:'done'};
type Kind='all'|'usenet'|'torrent';
const kinds=[['all','All'],['usenet','Usenet'],['torrent','Torrent']] as const;
type From='all'|'tkbox'|'outside';
const froms=[['all','Anyone'],['tkbox','tk.box'],['outside','Outside']] as const;
const fromTkbox=(i:DownloadItem)=>!!i.grab||i.mine;

// The table starts with what is moving, then what waits by its place in line, then what is finished.
const stateRank:Record<ClientState,number>={failed:0,downloading:1,importing:2,unpacking:3,checking:4,moving:5,stalled:6,queued:7,paused:8,seeding:9,completed:10};
const itemSorts={title:(i:DownloadItem)=>i.grab?.title??i.name,size:(i:DownloadItem)=>i.size,progress:(i:DownloadItem)=>i.progress,eta:(i:DownloadItem)=>i.eta,
  speed:(i:DownloadItem)=>(i.down??0)+(i.up??0)||undefined,peers:(i:DownloadItem)=>i.seeds,
  state:(i:DownloadItem)=>stateRank[i.state],by:(i:DownloadItem)=>i.requestedBy??(fromTkbox(i)?'tk.box':undefined)};
const byRank=(a:DownloadItem,b:DownloadItem)=>stateRank[a.state]-stateRank[b.state]||(a.position??1e9)-(b.position??1e9)||(b.finishedAt??b.addedAt??0)-(a.finishedAt??a.addedAt??0);

const UNITS=['B','KB','MB','GB','TB'];
function bytes(n?:number) {
  if(n===undefined)return undefined;
  let v=n,u=0;while(v>=1024&&u<UNITS.length-1){v/=1024;u++;}
  return `${v>=100||u===0?Math.round(v):v.toFixed(1)} ${UNITS[u]}`;
}
const rate=(n?:number)=>n?`${bytes(n)}/s`:undefined;
// "45 s", "12 min", "3 h 20 min", "2 d 4 h".
function duration(sec?:number) {
  if(!sec||sec<=0)return undefined;
  if(sec<60)return `${Math.round(sec)} s`;
  const m=Math.round(sec/60);if(m<60)return `${m} min`;
  const h=Math.floor(m/60);if(h<48)return m%60?`${h} h ${m%60} min`:`${h} h`;
  const d=Math.floor(h/24);return h%24?`${d} d ${h%24} h`:`${d} d`;
}

// A matched item opens its movie; anything else shows its own name, with where it came from under it.
function ItemTitle({item}:{item:DownloadItem}) {
  const where=[clientNames[item.downloader],item.category,item.tracker].filter(Boolean).join(' · ');
  const error=item.error?<span className="danger-text" title={item.error}>{item.error}</span>:undefined;
  if(item.grab)return <TitleCell id={item.grab.titleId} title={item.grab.title} year={item.grab.year} tags={item.grab.upgrade&&<Tag>Upgrade</Tag>}
    sub={error??`${item.grab.episodes?`${item.grab.episodes} · `:''}${item.name} · ${item.grab.quality} · ${item.grab.indexer}`}/>;
  return <div className="ui-title"><span className="ui-poster dl-initials" aria-hidden="true">{protocol(item.protocol)[0]}</span><div>
    <span className="ui-title-name" title={item.name}>{item.name}</span><small title={where}>{error??where}</small></div></div>;
}
// The state, and under it: for a finished torrent its ratio, how long it seeded and when the seeding rule removes it;
// otherwise the client's own word or the place in line.
function ItemStatus({item,now}:{item:DownloadItem;now:number}) {
  const [word,tone]=stateWords[item.state];
  const seeded=statusOf[item.state]==='done'&&item.protocol==='torrent'
    ?[item.ratio!==undefined&&`Ratio ${item.ratio.toFixed(2)}`,duration(item.seedingSeconds)].filter(Boolean).join(' · '):'';
  const line=seeded?<span title={item.grab?.removeAt?`Removed ${relative(item.grab.removeAt,now)}`:undefined}>{seeded}</span>
    :item.detail??(item.position?`#${item.position} in line`:undefined);
  return <><MediaStatusPill tone={tone}>{word}</MediaStatusPill>{line&&<small>{line}</small>}</>;
}
// Download health (docs/STALLS.md): Only source, or Slow while it has strikes, in place of the client's word; and
// under it the strikes, when the next look for a faster release is, or that it was just swapped in.
function grabHealth(item:DownloadItem,now:number):{pill?:[string,Tone];line?:string}|undefined {
  const g=item.grab;if(!g)return undefined;
  if(g.onlySource)return {pill:['Only source','off'],line:g.nextCheckAt?`Checking again ${g.nextCheckAt<=now?'now':relative(g.nextCheckAt,now)}`:undefined};
  if(g.strikes)return {pill:['Slow','wait'],line:`${g.strikes} strike${g.strikes>1?'s':''}`};
  if(g.swapped)return {line:'Swapped for a faster release'};
  return undefined;
}
function HealthStatus({item,now}:{item:DownloadItem;now:number}) {
  const health=grabHealth(item,now);
  if(!health)return <ItemStatus item={item} now={now}/>;
  const [word,tone]=health.pill??stateWords[item.state];
  return <><MediaStatusPill tone={tone}>{word}</MediaStatusPill>{health.line&&<small>{health.line}</small>}</>;
}
const Requested=({item}:{item:DownloadItem})=>item.requestedBy?<span title={item.requestedBy}>{item.requestedBy}</span>:fromTkbox(item)?<span>tk.box</span>:<span className="ui-dash">Outside</span>;
const Swarm=({item}:{item:DownloadItem})=>item.protocol!=='torrent'||item.seeds===undefined?<Dash/>
  :<span title={`${item.seeds} of ${item.seedsTotal??'?'} seeds, ${item.peers??0} of ${item.peersTotal??'?'} peers`}>{item.seeds}<span className="ui-dash"> ({item.seedsTotal??0})</span> / {item.peers??0}</span>;
function Progress({item}:{item:DownloadItem}) {
  const pct=Math.floor(item.progress*1000)/10;
  return <><div className="ui-progress"><div className="ui-progress-bar"><span style={{width:`${pct}%`}}/></div><span>{pct<10?pct.toFixed(1):Math.floor(pct)}%</span></div>
    {item.left?<small>{bytes((item.size??0)-item.left)} of {bytes(item.size)}</small>:null}</>;
}

// Speeds and free space for each downloader, beside the page name; one that didn't answer says so.
function ClientStats({clients}:{clients:DownloadsLive['clients']}) {
  if(!clients.length)return null;
  const down=clients.reduce((n,c)=>n+c.down,0),up=clients.reduce((n,c)=>n+c.up,0);
  return <div className="dl-stats">
    {clients.filter(c=>c.error||c.paused).map(c=><Pill key={c.name} tone={c.error?'bad':'off'} title={c.error}>{clientNames[c.name]} {c.error?'not answering':'paused'}</Pill>)}
    <span title="Download speed"><span className="dl-stats-label">Down</span> ↓ {rate(down)??'0 B/s'}</span>
    <span title="Upload speed"><span className="dl-stats-label">Up</span> ↑ {rate(up)??'0 B/s'}</span>
    {clients.filter(c=>c.free!==undefined).map(c=><span key={c.name} title={`Free where ${clientNames[c.name]} saves`}>{bytes(c.free)} <span className="dl-stats-label">free{clients.length>1?` · ${clientNames[c.name]}`:''}</span></span>)}
  </div>;
}

export function DownloadsPage({params}:{params:URLSearchParams}) {
  const live=useApi<DownloadsLive>('/admin/library/downloads'),mutation=useMutation(changed);
  useRefresh(live.reload,5000);
  const [query,setQuery]=useState(''),[kind,setKind]=useState<Kind>('all'),[from,setFrom]=useState<From>('all');
  const asked=params.get('view')??'all',status:Status=asked in statusNames?asked as Status:oldViews[asked]??'all';
  const retry=(id:number,title:string)=>void mutation.run(async()=>{await api(`/admin/library/grabs/${id}/retry`,'POST');toast.info(`Retrying ${title}`);live.reload();});
  // Only what a downloader holds (or a tk.box grab on its way in or out of one). Failed grabs tk.box already removed
  // from their downloader belong to History, not here.
  const all=live.data?.items??[];
  // Search and the protocol and source filters narrow every status; the status counts follow them.
  const narrowed=all.filter(i=>(kind==='all'||i.protocol===kind)&&(from==='all'||(from==='tkbox')===fromTkbox(i))
    &&matches(query,i.name,i.grab?.title,i.grab?.year,i.category,i.tracker,i.requestedBy,clientNames[i.downloader]));
  const counts={all:narrowed.length,waiting:0,progress:0,problems:0,done:0} as Record<Status,number>;
  for(const i of narrowed)counts[statusOf[i.state]]++;
  const shown=status==='all'?narrowed:narrowed.filter(i=>statusOf[i.state]===status);
  const {rows:sorted,sort,onSort}=useSorted([...shown].sort(byRank),itemSorts);
  const {rows,more}=usePaged(sorted,`${query}|${kind}|${from}|${status}|${sort?.key}|${sort?.dir}`);
  const setStatus=(v:Status)=>replaceRoute(link('admin',{section:'queue',...(v==='all'?{}:{view:v})}));
  const statuses=(Object.keys(statusNames) as Status[]).map(s=>[s,`${statusNames[s]} ${counts[s]}`] as const);
  const now=Date.now();
  return <><SectionHead title="Queue">{live.data&&<ClientStats clients={live.data.clients}/>}</SectionHead>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    {live.error&&live.data&&<ErrorNotice message={live.error.message} retry={live.reload}/>}
    <Toolbar query={query} setQuery={setQuery} placeholder="Search downloads" count={live.data?`${shown.length} of ${all.length}`:undefined}>
      <Segmented label="Status" value={status} options={statuses} onChange={setStatus}/>
      <Segmented label="Protocol" value={kind} options={kinds} onChange={setKind}/>
      <Segmented label="Requested by" value={from} options={froms} onChange={setFrom}/>
    </Toolbar>
    <Loaded view={live}>{()=><Panel flush>
      <Table posters more={more} sort={sort} onSort={onSort}
        empty={!all.length?'Nothing in the downloaders':!shown.length?(status==='problems'&&!query?'No problems':'Nothing matches'):undefined}
        columns={[{label:'Title',sort:'title'},{label:'Progress',width:150,sort:'progress',desc:true},{label:'Size',width:90,num:true,sort:'size',desc:true},
          {label:'Speed',width:100,num:true,sort:'speed',desc:true},{label:'Time left',width:90,num:true,sort:'eta'},{label:'Peers',width:110,num:true,sort:'peers',desc:true},
          {label:'Status',width:150,sort:'state'},{label:'Requested by',width:110,sort:'by'},{...ACTIONS,width:52}]}>
        {rows.map(i=><tr key={i.key} className={i.state==='paused'?'is-off':undefined}>
          <td><ItemTitle item={i}/></td>
          <td><Progress item={i}/></td>
          <td className="num">{bytes(i.size)??<Dash/>}</td>
          <td className="num">{rate(i.down)??(i.up?null:<Dash/>)}{i.up?<small>↑ {rate(i.up)}</small>:null}</td>
          <td className="num">{statusOf[i.state]==='done'?<Dash/>:duration(i.eta)??<Dash/>}</td>
          <td className="num"><Swarm item={i}/></td>
          <td><HealthStatus item={i} now={now}/></td>
          <td><Requested item={i}/></td>
          <td>{i.state==='failed'&&i.grab?.state==='failed'&&<RowActions>
            <IconAction icon="restart" label={`Retry ${i.grab.title}`} disabled={mutation.busy} onClick={()=>retry(i.grab!.id,i.grab!.title)}/></RowActions>}</td>
        </tr>)}
      </Table></Panel>}</Loaded>
  </>;
}

// tk.box's own download work (sending, checking, importing), waiting or failed; Admin › Schedule shows it.
export function DownloadJobs() {
  const view=useApi<DownloadsActivity>('/admin/library/activity'),mutation=useMutation(changed);useRefresh(view.reload);
  const retry=(j:DownloadsJob)=>void mutation.run(async()=>{await api(`/admin/library/jobs/${j.id}/retry`,'POST');toast.info(`Retrying ${j.label.toLowerCase()}`);view.reload();});
  const jobs=view.data?.jobs??[],now=Date.now();
  const {rows,sort,onSort}=useSorted(jobs,{job:j=>j.label,title:j=>j.subject,tries:j=>j.attempts,runs:j=>j.state==='queued'?j.runAt:undefined,state:j=>j.state});
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Panel flush title="Download work"><Table sort={sort} onSort={onSort} empty={view.data&&!jobs.length?'Nothing queued':undefined}
      columns={[{label:'Job',sort:'job'},{label:'Title',width:320,sort:'title'},{label:'Tries',width:80,num:true,sort:'tries',desc:true},{label:'Runs',width:110,sort:'runs'},
        {label:'Status',width:130,sort:'state'},ACTIONS]}>
      {rows.map(j=><tr key={j.id}><td>{j.label}{j.lastError&&<small className={j.state==='failed'?'bad':undefined} title={j.lastError}>{j.lastError}</small>}</td>
        <td>{j.titleId?<TitleCell id={j.titleId} title={j.subject??''} poster={false}/>:<Dash/>}</td>
        <td className="num">{j.attempts}/{j.maxAttempts}</td><td>{j.state==='queued'?<When at={j.runAt} now={now} due="Now"/>:<Dash/>}</td>
        <td><Pill tone={j.state==='failed'?'bad':j.state==='running'?'active':'wait'}>{j.state==='failed'?'Failed':j.state==='running'?'Running':'Queued'}</Pill></td>
        <td>{j.state==='failed'&&<RowActions><IconAction icon="restart" label={`Retry ${j.label}`} disabled={mutation.busy} onClick={()=>retry(j)}/></RowActions>}</td></tr>)}
    </Table></Panel>
  </>;
}

// ---- History: one row per tk.box grab, opening to its steps ----

const stepWords:Record<GrabEventKind,[string,Tone]>={grabbed:['Grabbed','active'],retried:['Retried','wait'],sending:['Sending','active'],downloading:['Sent','active'],
  unpacking:['Unpacking','active'],importing:['Importing','active'],imported:['Imported','ok'],seeding:['Imported','ok'],done:['Removed','off'],failed:['Failed','bad'],
  cancelled:['Cancelled','off'],'only-source':['Only source','off']};
const outcomeWords:Record<Exclude<GrabOutcome,'active'>,[string,Tone]>={imported:['Imported','ok'],failed:['Failed','bad'],replaced:['Replaced','off'],cancelled:['Cancelled','off']};
const outcomeWord=(g:DownloadsHistoryGrab):[string,Tone]=>g.outcome==='active'?[grabNames[g.state],'active']:outcomeWords[g.outcome];
const outcomes=['all','active','imported','failed','replaced','cancelled'] as const;
type OutcomeFilter=typeof outcomes[number];
const outcomeNames:Record<OutcomeFilter,string>={all:'All',active:'In progress',imported:'Imported',failed:'Failed',replaced:'Replaced',cancelled:'Cancelled'};
const fileName=(path:string)=>path.split(/[\\/]/).pop()||path;
const exactTime=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
const lastStep=(g:DownloadsHistoryGrab,is:(s:DownloadsStep)=>boolean)=>[...g.steps].reverse().find(is);
const stepNote=(s:DownloadsStep)=>s.note&&(s.kind==='imported'||s.kind==='seeding'?fileName(s.note):s.note);

// The line under a grab's status: how far it got, where it went, or why it stopped.
function OutcomeLine({g}:{g:DownloadsHistoryGrab}) {
  if(g.outcome==='active')return g.progress!==undefined&&g.state==='downloading'?<small>{Math.floor(g.progress*100)}%</small>:null;
  if(g.outcome==='replaced')return <small title={g.replacedBy?.releaseName}>By {g.replacedBy?.releaseName}</small>;
  if(g.outcome==='imported'){
    const removed=g.state==='done'?lastStep(g,s=>s.kind==='done')?.note:undefined,imported=lastStep(g,s=>s.kind==='imported'||s.kind==='seeding');
    const text=g.state==='seeding'?'Seeding':removed??(imported&&stepNote(imported));
    return text?<small title={text}>{text}</small>:null;
  }
  const why=g.error??lastStep(g,s=>s.kind===g.state)?.note;
  return why?<small className={g.outcome==='failed'?'danger-text':undefined} title={why}>{why}</small>:null;
}
function Steps({g}:{g:DownloadsHistoryGrab}) {
  return <ol className="ui-steps">{g.steps.map(s=>{const [word,tone]=stepWords[s.kind],note=stepNote(s);return <li key={s.id}>
    <time dateTime={new Date(s.at).toISOString()}>{exactTime.format(s.at)}</time><MediaStatusPill tone={tone}>{word}</MediaStatusPill>
    {note?<span className={s.kind==='failed'?'danger-text':undefined} title={s.note}>{note}</span>:<span/>}</li>;})}</ol>;
}

export function DownloadHistoryPage() {
  const view=useApi<DownloadsHistory>('/admin/library/history'),mutation=useMutation(changed);useRefresh(view.reload);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<OutcomeFilter>('all'),[open,setOpen]=useState<ReadonlySet<number>>(()=>new Set());
  const toggle=(id:number)=>setOpen(o=>{const next=new Set(o);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const grabs=view.data?.grabs??[];
  const narrowed=grabs.filter(g=>matches(query,g.title,g.year,g.episodes,g.releaseName,g.indexer,...g.steps.map(s=>s.note)));
  const counts=Object.fromEntries(outcomes.map(o=>[o,o==='all'?narrowed.length:narrowed.filter(g=>g.outcome===o).length])) as Record<OutcomeFilter,number>;
  const shown=filter==='all'?narrowed:narrowed.filter(g=>g.outcome===filter);
  const {rows:sorted,sort,onSort}=useSorted(shown,{title:g=>g.title,status:g=>outcomeWord(g)[0],quality:g=>qualityRank(g.quality),size:g=>g.size,
    started:g=>g.startedAt,finished:g=>g.endedAt});
  const {rows,more}=usePaged(sorted,`${query}|${filter}|${sort?.key}|${sort?.dir}`);
  const retry=(g:DownloadsHistoryGrab)=>void mutation.run(async()=>{await api(`/admin/library/grabs/${g.id}/retry`,'POST');toast.info(`Retrying ${g.title}`);view.reload();});
  const now=Date.now();
  return <><SectionHead title="History"/>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Toolbar query={query} setQuery={setQuery} placeholder="Search history" count={view.data?`${shown.length} of ${grabs.length}`:undefined}>
      <Segmented label="Status" value={filter} options={outcomes.map(o=>[o,`${outcomeNames[o]} ${counts[o]}`] as const)} onChange={setFilter}/>
    </Toolbar>
    <Loaded view={view}>{()=><Panel flush>
      <Table posters more={more} sort={sort} onSort={onSort} empty={!grabs.length?'Nothing downloaded yet':!shown.length?'Nothing matches':undefined}
        columns={[{label:'Title',sort:'title'},{label:'Status',width:220,sort:'status'},{label:'Quality',width:130,sort:'quality',desc:true},
          {label:'Size',width:90,num:true,sort:'size',desc:true},{label:'Started',width:110,sort:'started',desc:true},{label:'Finished',width:110,sort:'finished',desc:true},{...ACTIONS,width:52}]}>
        {rows.map(g=>{const [word,tone]=outcomeWord(g),expanded=open.has(g.id),took=g.endedAt!==undefined?duration((g.endedAt-g.startedAt)/1000):undefined;
          return <Fragment key={g.id}>
            <tr className={`ui-release ${expanded?'is-open':''}`} onClick={e=>{if(!(e.target as HTMLElement).closest('a,button'))toggle(g.id);}}>
              <td><div className="ui-release-name">
                <button type="button" className="ui-expand" aria-expanded={expanded} aria-label={`${expanded?'Hide':'Show'} the steps of ${g.title}`} onClick={()=>toggle(g.id)}>
                  <Icon name={expanded?'down':'next'} size={14}/></button>
                <TitleCell id={g.titleId} title={g.title} year={g.year} tags={<>{g.episodes&&<Tag>{g.episodes}</Tag>}{g.upgrade&&<Tag>Upgrade</Tag>}</>}
                  sub={`${g.swappedFrom?'Swapped in · ':''}${g.releaseName} · ${protocol(g.protocol)} · ${g.indexer}`}/></div></td>
              <td><MediaStatusPill tone={tone}>{word}</MediaStatusPill><OutcomeLine g={g}/></td>
              <td>{g.quality}</td><td className="num">{bytes(g.size)??<Dash/>}</td>
              <td><When at={g.startedAt} now={now}/></td>
              <td>{g.endedAt!==undefined?<><When at={g.endedAt} now={now}/>{took&&<small>Took {took}</small>}</>:<Dash/>}</td>
              <td>{g.outcome==='failed'&&g.state==='failed'&&<RowActions>
                <IconAction icon="restart" label={`Retry ${g.title}`} disabled={mutation.busy} onClick={()=>retry(g)}/></RowActions>}</td>
            </tr>
            {expanded&&<tr className="ui-release-detail"><td colSpan={7}><Steps g={g}/></td></tr>}
          </Fragment>;})}
      </Table></Panel>}</Loaded>
  </>;
}

// ---- Wanted ----

const wantedFilters=[['all','All'],['missing','Missing'],['cutoff','Below cutoff'],['paused','Failing']] as const;
type WantedFilter=typeof wantedFilters[number][0];
const wantedKinds=[['all','All'],['movie','Movies'],['show','Shows']] as const;
type WantedKind=typeof wantedKinds[number][0];
// A show's row is one search: a season pack (S02, its wanted episodes) or one episode (S02E05 and its name).
const wantedKey=(w:WantedItem)=>`${w.id}:${w.scope??'movie'}`;
const scopeWords=(w:WantedItem)=>!w.scope?'':/E\d+$/.test(w.scope)?(w.episodeName??''):`Season pack · ${w.episodes} episode${w.episodes===1?'':'s'}`;
const wantedStatus=(w:WantedItem)=>w.paused?'Failing':w.grab?grabNames[w.grab]:w.why==='missing'?'Missing':'Below cutoff';
const wantedSorts={title:(w:WantedItem)=>`${w.title} ${w.scope??''}`,next:(w:WantedItem)=>w.paused||w.grab?undefined:w.nextAt??0,misses:(w:WantedItem)=>w.misses,status:wantedStatus};

export function WantedPage() {
  const view=useApi<WantedList>('/admin/library/wanted'),mutation=useMutation(changed);useRefresh(view.reload);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<WantedFilter>('all'),[kind,setKind]=useState<WantedKind>('all');
  const search=(w:WantedItem)=>void mutation.run(async()=>{await api(`/admin/library/titles/${w.id}/search`,'POST',w.scope?{scope:w.scope}:{});toast.info(`Searching for ${w.title}${w.scope?` ${w.scope}`:''}`);});
  const resume=(w:WantedItem)=>void mutation.run(()=>api(`/admin/library/titles/${w.id}/pause`,'POST',{paused:false}));
  const items=(view.data?.items??[]).filter(w=>matches(query,w.title,w.year,w.scope,w.episodeName)&&(kind==='all'||w.kind===kind)
    &&(filter==='all'?true:filter==='paused'?w.paused:!w.paused&&w.why===filter))
    .sort((a,b)=>a.title.localeCompare(b.title)||(a.scope??'').localeCompare(b.scope??''));
  const {rows:sorted,sort,onSort}=useSorted(items,wantedSorts,{key:'next',dir:1});
  const {rows,more}=usePaged(sorted,`${query}|${filter}|${kind}|${sort?.key}|${sort?.dir}`);
  return <><SectionHead title="Wanted"/>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Toolbar query={query} setQuery={setQuery} placeholder="Search wanted titles" count={view.data?`${items.length} of ${view.data.items.length}`:undefined}>
      <Segmented label="Show" value={filter} options={wantedFilters} onChange={setFilter}/>
      <Segmented label="Kind" value={kind} options={wantedKinds} onChange={setKind}/>
    </Toolbar>
    <Loaded view={view}>{({items:all})=>{const now=Date.now();return <Panel flush>
      <Table posters more={more} sort={sort} onSort={onSort} empty={!all.length?'Nothing wanted':!items.length?'Nothing wanted matches':undefined}
        columns={[{label:'Title',sort:'title'},{label:'Next search',width:130,sort:'next'},{label:'Misses',width:80,num:true,sort:'misses',desc:true},{label:'Status',width:140,sort:'status'},{...ACTIONS,width:124}]}>
        {rows.map(w=><tr key={wantedKey(w)}>
          <td><TitleCell id={w.id} title={w.title} year={w.year} tags={w.scope&&<Tag>{w.scope}</Tag>} sub={w.paused&&w.pausedReason?<>{scopeWords(w)?`${scopeWords(w)} · `:''}<span className="danger-text">{w.pausedReason}</span></>
            :<>{scopeWords(w)?`${scopeWords(w)} · `:''}{w.quality?`Have ${w.quality} · `:''}{w.lastAt?<>Searched <When at={w.lastAt} now={now}/></>:'Not searched yet'}</>}/></td>
          <td>{w.paused||w.grab?<Dash/>:<When at={w.nextAt} now={now} due="Due" empty="Not yet"/>}</td>
          <td className="num">{w.misses}</td>
          <td>{w.paused?<MediaStatusPill tone="bad">Failing</MediaStatusPill>:w.grab?<GrabPill state={w.grab}/>:<MediaStatusPill tone="wait">{w.why==='missing'?'Missing':'Below cutoff'}</MediaStatusPill>}</td>
          <td><RowActions>
            {!w.paused&&<IconAction icon="search" label={`Automatic search for ${w.title}${w.scope?` ${w.scope}`:''}`} disabled={mutation.busy||!!w.grab} onClick={()=>search(w)}/>}
            <IconAction icon="list" label={`Interactive search for ${w.title}${w.scope?` ${w.scope}`:''}`} onClick={()=>openMovie(w.id,'search',w.scope)}/>
            {w.paused&&<IconAction icon="play" label={`Resume ${w.title}: clear the failures and search again`} disabled={mutation.busy} onClick={()=>resume(w)}/>}
          </RowActions></td>
        </tr>)}
      </Table></Panel>;}}</Loaded>
  </>;
}
