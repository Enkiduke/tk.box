import {useState} from 'react';
import type {DownloadsActivity,DownloadsGrab,DownloadsJob,DownloadsSeeding,WantedItem,WantedList} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {ErrorNotice} from './components.js';
import {SectionHead,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {Badge,EmptyLine,GrabBadge,ListSection,Loaded,Segmented,Table,TitleCell,Toolbar,When,changed,gb,matches,useRefresh} from './manage-ui.js';

// Admin › Manage › Downloads and Wanted (docs/PHASE-3.5.md): what is moving, then what is still wanted.

// ---- Downloads ----

export function DownloadsPage() {
  const view=useApi<DownloadsActivity>('/admin/library/activity'),mutation=useMutation(changed);useRefresh(view.reload);
  const retry=(path:string,what:string)=>void mutation.run(async()=>{await api(path,'POST');toast.info(`Retrying ${what}`);});
  return <><SectionHead title="Downloads"/>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Loaded view={view}>{({open,seeding=[],failed,history,jobs})=>{const now=Date.now();return <>
      <ListSection title="Downloading" count={open.length} empty="Nothing downloading"><Downloading grabs={open}/></ListSection>
      <ListSection title="Seeding" count={seeding.length} empty="Nothing seeding"><Seeding torrents={seeding} now={now}/></ListSection>
      <ListSection title="Failed" count={failed.length} empty="No failures"><Failed grabs={failed} now={now} busy={mutation.busy} retry={g=>retry(`/admin/library/grabs/${g.id}/retry`,g.title)}/></ListSection>
      <ListSection title="Queue" count={jobs.length} empty="Nothing queued"><Queue jobs={jobs} now={now} busy={mutation.busy} retry={j=>retry(`/admin/library/jobs/${j.id}/retry`,j.label.toLowerCase())}/></ListSection>
      <ListSection title="Recent" count={history.length} empty="Nothing finished yet"><Recent grabs={history} now={now}/></ListSection>
    </>;}}</Loaded>
  </>;
}

const protocol=(g:{protocol:'usenet'|'torrent'})=>g.protocol==='usenet'?'Usenet':'Torrent';
function Downloading({grabs}:{grabs:DownloadsGrab[]}) {
  return <Table columns={[{label:'Title'},{label:'Quality'},{label:'Protocol'},{label:'Size',num:true},{label:'Progress',num:true},{label:'State'}]}>
    {grabs.map(g=>{const pct=Math.round((g.progress??0)*100);return <tr key={g.id}>
      <td><TitleCell id={g.titleId} title={g.title} year={g.year} sub={g.releaseName}/></td>
      <td>{g.quality}{g.upgrade&&<small>Upgrade</small>}</td><td>{protocol(g)}<small>{g.indexer}</small></td><td className="num">{gb(g.size)}</td>
      <td className="num"><div className="manage-progress"><div className="downloads-progress"><span style={{width:`${pct}%`}}/></div><span>{g.progress!==undefined?`${pct}%`:'—'}</span></div></td>
      <td><GrabBadge state={g.state}/>{g.error&&<small>{g.error}</small>}</td></tr>;})}
  </Table>;
}
// Seeding torrents: ratio and days as qBittorrent last gave them, and when the seeding rule removes each.
function Seeding({torrents,now}:{torrents:DownloadsSeeding[];now:number}) {
  return <Table columns={[{label:'Title'},{label:'Size',num:true},{label:'Ratio',num:true},{label:'Days',num:true},{label:'Removed'}]}>
    {torrents.map(t=><tr key={t.id}><td><TitleCell id={t.titleId} title={t.title} year={t.year} sub={t.releaseName}/></td><td className="num">{gb(t.size)}</td>
      <td className="num">{t.ratio!==undefined?t.ratio.toFixed(2):'—'}</td><td className="num">{t.seedingDays!==undefined?t.seedingDays.toFixed(1):'—'}</td>
      <td><When at={t.removeAt} now={now} due="Next check"/></td></tr>)}
  </Table>;
}
function Failed({grabs,now,busy,retry}:{grabs:DownloadsGrab[];now:number;busy:boolean;retry:(g:DownloadsGrab)=>void}) {
  return <Table columns={[{label:'Title'},{label:'Reason'},{label:'When'},{label:<span className="sr-only">Actions</span>}]}>
    {grabs.map(g=><tr key={g.id}><td><TitleCell id={g.titleId} title={g.title} year={g.year} sub={g.releaseName}/></td>
      <td className="danger-text">{g.error??'Failed'}</td><td><When at={g.finishedAt} now={now}/></td>
      <td><button className="link-button" disabled={busy} onClick={()=>retry(g)}>Retry</button></td></tr>)}
  </Table>;
}
function Queue({jobs,now,busy,retry}:{jobs:DownloadsJob[];now:number;busy:boolean;retry:(j:DownloadsJob)=>void}) {
  return <Table columns={[{label:'Job'},{label:'Title'},{label:'State'},{label:'Tries',num:true},{label:'Runs'},{label:<span className="sr-only">Actions</span>}]}>
    {jobs.map(j=><tr key={j.id}><td>{j.label}{j.lastError&&<small className={j.state==='failed'?'danger-text':undefined}>{j.lastError}</small>}</td>
      <td>{j.titleId?<TitleCell id={j.titleId} title={j.subject??''} poster={false}/>:<span className="muted">—</span>}</td>
      <td><Badge tone={j.state==='failed'?'danger':j.state==='running'?'warning':undefined}>{j.state==='failed'?'Failed':j.state==='running'?'Running':'Queued'}</Badge></td>
      <td className="num">{j.attempts}/{j.maxAttempts}</td><td>{j.state==='queued'?<When at={j.runAt} now={now} due="Now"/>:<span className="muted">—</span>}</td>
      <td>{j.state==='failed'&&<button className="link-button" disabled={busy} onClick={()=>retry(j)}>Retry</button>}</td></tr>)}
  </Table>;
}
function Recent({grabs,now}:{grabs:DownloadsGrab[];now:number}) {
  return <Table columns={[{label:'Title'},{label:'Quality'},{label:'Size',num:true},{label:'State'},{label:'When'}]}>
    {grabs.map(g=><tr key={g.id}><td><TitleCell id={g.titleId} title={g.title} year={g.year} sub={g.releaseName}/></td>
      <td>{g.quality}{g.upgrade&&<small>Upgrade</small>}</td><td className="num">{gb(g.size)}</td><td><GrabBadge state={g.state}/></td>
      <td><When at={g.importedAt??g.finishedAt??g.sentAt} now={now}/></td></tr>)}
  </Table>;
}

// ---- Wanted ----

const wantedFilters=[['all','All'],['missing','Missing'],['cutoff','Below cutoff'],['paused','Paused']] as const;
const wantedSorts=[['next','Next search'],['title','Title'],['added','Added']] as const;
type WantedFilter=typeof wantedFilters[number][0];type WantedSort=typeof wantedSorts[number][0];

export function WantedPage() {
  const view=useApi<WantedList>('/admin/library/wanted'),mutation=useMutation(changed);useRefresh(view.reload);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<WantedFilter>('all'),[sort,setSort]=useState<WantedSort>('next');
  const search=(w:WantedItem)=>void mutation.run(async()=>{await api(`/admin/library/titles/${w.id}/search`,'POST');toast.info(`Searching for ${w.title}`);});
  const pause=(w:WantedItem)=>void mutation.run(()=>api(`/admin/library/titles/${w.id}/pause`,'POST',{paused:!w.paused}));
  return <><SectionHead title="Wanted"/>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Loaded view={view}>{({items:all})=>{
      const now=Date.now();
      const items=all.filter(w=>matches(query,w.title,w.year)&&(filter==='all'?true:filter==='paused'?w.paused:!w.paused&&w.why===filter))
        .sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):sort==='added'?b.addedAt-a.addedAt:(a.paused||a.grab?Infinity:a.nextAt??0)-(b.paused||b.grab?Infinity:b.nextAt??0)||a.title.localeCompare(b.title));
      return <>
        <Toolbar query={query} setQuery={setQuery} placeholder="Search wanted movies">
          <Segmented label="Show" value={filter} options={wantedFilters} onChange={setFilter}/>
          <label className="manage-sort">Sort<select value={sort} onChange={e=>setSort(e.target.value as WantedSort)}>{wantedSorts.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          <span className="muted small">{items.length} of {all.length}</span>
        </Toolbar>
        {!all.length?<EmptyLine>Nothing wanted</EmptyLine>:!items.length?<EmptyLine>No wanted movie matches</EmptyLine>:
        <Table columns={[{label:'Title'},{label:'Why'},{label:'Quality'},{label:'Next search'},{label:'Misses',num:true},{label:'State'},{label:<span className="sr-only">Actions</span>}]}>
          {items.map(w=><tr key={w.id} className={w.paused?'is-off':undefined}>
            <td><TitleCell id={w.id} title={w.title} year={w.year}/></td>
            <td>{w.why==='missing'?'Missing':'Below cutoff'}</td><td>{w.quality??<span className="muted">—</span>}</td>
            <td>{w.paused||w.grab?<span className="muted">—</span>:<When at={w.nextAt} now={now} due="Due" empty="Not yet"/>}{w.lastAt&&<small>Last <When at={w.lastAt} now={now}/></small>}</td>
            <td className="num">{w.misses}</td>
            <td>{w.paused?<><Badge tone="danger">Paused</Badge>{w.pausedReason&&<small>{w.pausedReason}</small>}</>:w.grab?<GrabBadge state={w.grab}/>:<Badge>Waiting</Badge>}</td>
            <td><div className="manage-actions">{!w.paused&&<button className="link-button" disabled={mutation.busy||!!w.grab} onClick={()=>search(w)}>Search now</button>}
              <button className="link-button" disabled={mutation.busy} onClick={()=>pause(w)}>{w.paused?'Unpause':'Pause'}</button></div></td>
          </tr>)}
        </Table>}
      </>;}}</Loaded>
  </>;
}
