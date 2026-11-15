import {useState} from 'react';
import type {InteractiveRelease,InteractiveSearch,LibraryTitleView,MovieList,MovieRow} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {link,useApi} from './hooks.js';
import {ErrorNotice,Icon} from './components.js';
import {Card,SectionHead,Switch,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {Badge,EmptyLine,GrabBadge,ListSection,Loaded,Poster,Segmented,Table,TitleCell,Toolbar,When,WhenDay,changed,gb,matches,relative,useRefresh} from './manage-ui.js';

// Admin › Manage › Movies (docs/PHASE-3.5.md): every movie in the library, and each one's page (?title=<id>).

const filters=[['all','All'],['file','Has file'],['nofile','No file'],['cutoff','Below cutoff'],['kept','Kept'],['paused','Paused']] as const;
const sorts=[['title','Title'],['added','Added'],['size','Size']] as const;
type Filter=typeof filters[number][0];type Sort=typeof sorts[number][0];
const shown=(m:MovieRow,f:Filter)=>f==='all'||(f==='file'?!!m.quality:f==='nofile'?!m.quality:f==='cutoff'?m.belowCutoff:f==='kept'?m.keep:m.paused);

export function MoviesPage({params}:{params:URLSearchParams}) {
  const titleId=Number(params.get('title'))||undefined;
  if(titleId)return <TitlePage id={titleId}/>;
  return <MovieListPage/>;
}

function MovieListPage() {
  const view=useApi<MovieList>('/admin/library/movies');useRefresh(view.reload,30000);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState<Filter>('all'),[sort,setSort]=useState<Sort>('title');
  return <><SectionHead title="Movies"/>
    <Loaded view={view}>{({items:all})=>{
      const now=Date.now();
      const items=all.filter(m=>matches(query,m.title,m.year,m.quality,m.profile)&&shown(m,filter))
        .sort((a,b)=>sort==='added'?b.addedAt-a.addedAt:sort==='size'?(b.size??-1)-(a.size??-1):a.title.localeCompare(b.title));
      return <>
        <Toolbar query={query} setQuery={setQuery} placeholder="Search movies">
          <Segmented label="Show" value={filter} options={filters} onChange={setFilter}/>
          <label className="manage-sort">Sort<select value={sort} onChange={e=>setSort(e.target.value as Sort)}>{sorts.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          <span className="muted small">{items.length} of {all.length}</span>
        </Toolbar>
        {!all.length?<EmptyLine>No movies in the library</EmptyLine>:!items.length?<EmptyLine>No movie matches</EmptyLine>:
        <Table columns={[{label:'Title'},{label:'Quality'},{label:'Size',num:true},{label:'Profile'},{label:'Keep'},{label:'Last grab'},{label:'Added'}]}>
          {items.map(m=><tr key={m.id} className={m.paused||!m.monitored?'is-off':undefined}>
            <td><TitleCell id={m.id} title={m.title} year={m.year}/></td>
            <td>{m.quality??<span className="muted">No file</span>}{m.belowCutoff&&<small className="warning-text">Below cutoff</small>}</td>
            <td className="num">{gb(m.size)}</td><td>{m.profile}</td>
            <td>{m.keep?<Badge tone="ok">Kept</Badge>:<span className="muted">—</span>}</td>
            <td>{m.paused?<Badge tone="danger">Paused</Badge>:!m.monitored?<Badge>Not monitored</Badge>:m.grab?<GrabBadge state={m.grab}/>:<span className="muted">—</span>}</td>
            <td><When at={m.addedAt} now={now}/></td>
          </tr>)}
        </Table>}
      </>;}}</Loaded>
  </>;
}

// ---- A movie's page ----

function TitlePage({id}:{id:number}) {
  const path=`/admin/library/titles/${id}`,view=useApi<LibraryTitleView>(path),mutation=useMutation(changed);useRefresh(view.reload);
  const back=<a className="link-button" href={link('admin',{section:'movies'})}><Icon name="back" size={16}/>Movies</a>;
  return <Loaded view={view}>{t=>{
    const now=Date.now();
    const update=(body:{profileId?:number;keep?:boolean})=>void mutation.run(()=>api(path,'PUT',body));
    const search=()=>void mutation.run(async()=>{await api(`${path}/search`,'POST');toast.info(`Searching for ${t.title}`);});
    const pause=()=>void mutation.run(()=>api(`${path}/pause`,'POST',{paused:!t.paused}));
    const status=t.paused?<Badge tone="danger">Paused</Badge>:!t.monitored?<Badge>Not monitored</Badge>:t.wanted.wanted?<Badge tone="warning">{t.wanted.why==='missing'?'Missing':'Below cutoff'}</Badge>:<Badge tone="ok">Have</Badge>;
    return <>
      <SectionHead title={`${t.title}${t.year?` (${t.year})`:''}`}>{back}</SectionHead>
      {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
      <Card className="manage-movie" actions={status}>
        <div className="manage-movie-body"><Poster id={t.id}/>
          <div className="manage-movie-main">
            <div className="downloads-facts">
              <span><small>Next search</small>{t.paused||!t.monitored?'—':<When at={t.nextAt} now={now} due="Due" empty="Not yet"/>}</span>
              <span><small>Last search</small><When at={t.lastAt} now={now} empty="Never"/></span>
              <span><small>Misses</small>{t.misses}</span>
              <span><small>Digital</small>{t.released.digital?<WhenDay day={t.released.digital} now={now}/>:'—'}</span>
              <span><small>Physical</small>{t.released.physical?<WhenDay day={t.released.physical} now={now}/>:'—'}</span>
            </div>
            <div className="manage-movie-controls">
              <label>Profile<select value={t.profileId} disabled={mutation.busy} onChange={e=>update({profileId:Number(e.target.value)})}>{t.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <Switch label="Keep" checked={t.keep} disabled={mutation.busy} onChange={keep=>update({keep})}/>
            </div>
            {t.pausedReason&&<p className="danger-text small">{t.pausedReason}</p>}
            <div className="button-row"><button className="primary" disabled={mutation.busy||t.paused||!t.monitored} onClick={search}><Icon name="search" size={16}/>Search</button>
              <button disabled={mutation.busy} onClick={pause}>{t.paused?'Unpause':'Pause'}</button></div>
          </div>
        </div>
      </Card>
      <ListSection title="Files" count={t.files.length} empty="No file">
        <Table columns={[{label:'File'},{label:'Quality'},{label:'Size',num:true},{label:'Imported'}]}>
          {t.files.map(f=><tr key={f.id}><td className="downloads-path">{f.path}{f.releaseName&&<small>{f.releaseName}</small>}</td>
            <td>{f.quality}{f.proper&&<small>Proper</small>}</td><td className="num">{gb(f.size)}</td><td><When at={f.importedAt} now={now}/></td></tr>)}
        </Table>
      </ListSection>
      <ListSection title="Grabs" count={t.grabs.length} empty="Nothing grabbed yet">
        <Table columns={[{label:'Release'},{label:'Quality'},{label:'Size',num:true},{label:'State'},{label:'When'}]}>
          {t.grabs.map(g=><tr key={g.id}><td>{g.releaseName}<small>{g.indexer} · {g.protocol==='usenet'?'Usenet':'Torrent'}</small></td>
            <td>{g.quality}{g.upgrade&&<small>Upgrade</small>}</td><td className="num">{gb(g.size)}</td>
            <td><GrabBadge state={g.state}/>{g.error&&<small>{g.error}</small>}</td><td><When at={g.importedAt??g.finishedAt??g.sentAt} now={now}/></td></tr>)}
        </Table>
      </ListSection>
      <InteractiveSearchCard path={path} title={t.title}/>
    </>;
  }}</Loaded>;
}

// Why a release isn't taken: its first rejection, as the pick rules gave it.
const whyNot=(r:InteractiveRelease)=>r.reasons.find(x=>x.startsWith('rejected'))?.replace(/^rejected:?\s*/,'')??r.reasons[0]??'Not accepted';
const sortReleases=(a:InteractiveRelease,b:InteractiveRelease)=>Number(b.accepted)-Number(a.accepted)||b.score-a.score;

function InteractiveSearchCard({path,title}:{path:string;title:string}) {
  const [result,setResult]=useState<InteractiveSearch>(),[acceptedOnly,setAcceptedOnly]=useState(true),[grabbed,setGrabbed]=useState('');
  const search=useMutation(()=>{}),grab=useMutation(changed);
  const run=()=>void search.run(async()=>{setGrabbed('');setResult(await api<InteractiveSearch>(`${path}/interactive`,'POST'));});
  const take=(r:InteractiveRelease)=>void grab.run(async()=>{await api(`${path}/grab`,'POST',{guid:r.guid});setGrabbed(r.guid);toast.success(`Grabbed ${r.name}`);});
  const accepted=result?.releases.filter(r=>r.accepted).length??0;
  const rows=(result?.releases.filter(r=>r.accepted||!acceptedOnly)??[]).sort(sortReleases);
  const now=Date.now();
  return <Card title="Interactive search" actions={<>{result&&<Switch label={`Accepted only (${accepted} of ${result.releases.length})`} checked={acceptedOnly} onChange={setAcceptedOnly}/>}
    <button className="primary" disabled={search.busy} onClick={run}><Icon name="search" size={16}/>{search.busy?'Searching…':result?'Search again':'Search'}</button></>}>
    {search.error&&<ErrorNotice message={search.error}/>}
    {grab.error&&<ErrorNotice message={grab.error} dismiss={()=>grab.setError('')}/>}
    {result?.indexers.filter(i=>i.error).map(i=><div key={i.indexer} className="notice"><span>{i.indexer}: {i.error}</span></div>)}
    {result&&(!rows.length?<EmptyLine>{result.releases.length?'Nothing accepted':'Nothing found'}</EmptyLine>:
      <Table className="downloads-releases" columns={[{label:'Release'},{label:'Quality'},{label:'Protocol'},{label:'Size',num:true},{label:'Seeders / grabs',num:true},{label:'Score',num:true},{label:'Age',num:true},{label:'Verdict'},{label:<span className="sr-only">Grab</span>}]}>
        {rows.map(r=><tr key={`${r.indexer}:${r.guid}`} className={r.accepted?undefined:'is-off'}>
          <td>{r.name}<small>{r.indexer}{r.freeleech?' · Freeleech':''}</small></td>
          <td>{r.quality??<span className="muted">Unknown</span>}{r.upgrade&&<small>Upgrade</small>}</td>
          <td>{r.protocol==='usenet'?'Usenet':'Torrent'}</td>
          <td className="num">{gb(r.size)}</td>
          <td className="num">{r.protocol==='torrent'?(r.seeders??'—'):(r.grabs??'—')}</td>
          <td className="num">{r.score>0?`+${r.score}`:r.score}</td>
          <td className="num" title={r.publishedAt?new Date(r.publishedAt).toLocaleString():undefined}>{r.publishedAt?relative(r.publishedAt,now).replace(' ago',''):'—'}</td>
          <td>{r.accepted?<Badge tone="ok">Accepted</Badge>:<span className="danger-text small">{whyNot(r)}</span>}
            {r.reasons.filter(x=>!x.startsWith('rejected')).map(x=><small key={x}>{x}</small>)}</td>
          <td>{grabbed===r.guid?<span className="success small">Grabbed</span>:<button className={r.accepted?'primary':undefined} disabled={grab.busy||!r.quality||!!grabbed}
            title={r.accepted?undefined:'Grab it anyway'} aria-label={`Grab ${r.name} for ${title}`} onClick={()=>take(r)}>Grab</button>}</td>
        </tr>)}
      </Table>)}
  </Card>;
}
