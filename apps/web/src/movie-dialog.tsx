import {useState,type ReactNode} from 'react';
import type {LibraryTitleView,PlexKey,TitleView} from '../../../packages/contracts/src/downloads.js';
import type {HistoryListRow} from '../../../packages/contracts/src/index.js';
import type {SubtitleJobState,SubtitleSource,TitleSubtitle,TitleSubtitles} from '../../../packages/contracts/src/subtitles.js';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {ErrorNotice,Icon,Loading,Modal} from './components.js';
import {useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {InteractiveSearchPanel} from './interactive-search.js';
import {RequestsTable,SourceLine} from './movie-source.js';
import {ShowDialogBody} from './show-dialog.js';
import {ACTIONS,Dash,FavoriteStar,IconAction,RowActions,GrabPill,Panel,Pill,Poster,Table,Tabs,Tag,When,WhenDay,changed,gb,qualityRank,useRefresh,useSorted,type TitlePane,type Tone} from './manage-ui.js';

// A movie or show in the library (docs/UI.md), as a dialog over whichever Admin page opened it (`&title=<id>`, and
// `&pane=` for a tab): its head holds what it has, its settings and the searches; the tabs hold its files, grabs,
// requests and Interactive search. A show's dialog is show-dialog.tsx, sharing the head's controls and the tables here.

export type MoviePane=TitlePane;

export function MovieDialog({id,pane,scope,setPane,onClose}:{id:number;pane:TitlePane;scope?:string;setPane:(pane:TitlePane,scope?:string)=>void;onClose:()=>void}) {
  const path=`/admin/library/titles/${id}`,view=useApi<TitleView>(path),mutation=useMutation(changed);useRefresh(view.reload);
  const t=view.data,tab=pane==='overview'?'files':pane;
  return <Modal title={t?.title??'Title'} variant="wide" onClose={onClose} scrollKey={`${id}`}>
    {view.error&&!t?<ErrorNotice message={view.error.message} retry={view.reload}/>:!t?<Loading/>
    :t.kind==='show'?<ShowDialogBody t={t} path={path} pane={pane} scope={scope} setPane={setPane} mutation={mutation} onDeleted={onClose}/>:<div className="ui-movie-dialog">
      <Head t={t} path={path} mutation={mutation} onDeleted={onClose}/>
      {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
      <Tabs label={t.title} value={tab} onChange={p=>setPane(p==='files'?'overview':p)} tabs={[{id:'files',label:'Files',count:t.files.length},
        {id:'grabs',label:'Grabs',count:t.grabs.length},{id:'requests',label:'Requests',count:t.requests.length},{id:'history',label:'Watch history'},{id:'search',label:'Interactive search'}]}/>
      {tab==='search'?<InteractiveSearchPanel titleId={t.id}/>
        :tab==='history'?<WatchHistoryPanel plex={t.plex}/>
        :tab==='grabs'?<Panel flush><GrabsTable grabs={t.grabs} now={Date.now()}/></Panel>
        :tab==='requests'?<Panel flush><RequestsTable requests={t.requests}/></Panel>
        :<Panel flush><FilesTable titleId={t.id} files={t.files} path={path} now={Date.now()}/></Panel>}
    </div>}
  </Modal>;
}

export type Mutation=ReturnType<typeof useMutation>;
function statusOf(t:LibraryTitleView):{tone:Tone;label:string} {
  return !t.monitored?{tone:'off',label:'Not monitored'}:t.paused?{tone:'bad',label:'Failing'}
    :t.wanted.wanted?{tone:'wait',label:t.wanted.why==='missing'?'Missing':'Below cutoff'}:{tone:'ok',label:'Available'};
}

// Poster, title, status, the facts that matter, then its settings and searches in one strip.
function Head({t,path,mutation,onDeleted}:{t:LibraryTitleView;path:string;mutation:Mutation;onDeleted:()=>void}) {
  const now=Date.now(),s=statusOf(t),have=t.files[0];
  const search=()=>void mutation.run(async()=>{await api(`${path}/search`,'POST');toast.info(`Searching for ${t.title}`);});
  return <header className="ui-movie">
    <Poster id={t.id} className="ui-movie-poster"/>
    <div className="ui-movie-main">
      <div>
        <h2 className="ui-movie-title">{t.title}{t.year?<span> {t.year}</span>:null}</h2>
        <div className="ui-movie-line"><Pill tone={s.tone}>{s.label}</Pill>{have&&<span>{have.quality} · {gb(have.size)}</span>}{t.keep&&<FavoriteStar/>}
          {t.pausedReason&&<span className="danger-text">{t.pausedReason}</span>}</div>
        <div className="ui-movie-source"><SourceLine source={t.source} addedAt={t.addedAt}/></div>
      </div>
      <dl className="ui-facts">
        <div><dt>Next search</dt><dd>{t.paused||!t.monitored?<Dash/>:<When at={t.nextAt} now={now} due="Due" empty="Not yet"/>}</dd></div>
        <div><dt>Last search</dt><dd><When at={t.lastAt} now={now} empty="Never"/></dd></div>
        <div><dt>Misses</dt><dd>{t.misses}</dd></div>
        <div><dt>Digital</dt><dd><WhenDay day={t.released.digital} now={now}/></dd></div>
        <div><dt>Physical</dt><dd><WhenDay day={t.released.physical} now={now}/></dd></div>
      </dl>
      <TitleControls t={t} path={path} mutation={mutation} onDeleted={onDeleted}>
        <button disabled={mutation.busy||t.paused||!t.monitored} title="Search now and grab the best match" onClick={search}><Icon name="search" size={16}/>Automatic search</button>
      </TitleControls>
    </div>
  </header>;
}

// A title's settings as one strip under its facts: Monitored, Profile, Favorite (and a movie's Early copies), then its
// searches on the right, Resume while it's Failing, and Delete last.
export function TitleControls({t,path,mutation,onDeleted,children}:{t:{title:string;kind:'movie'|'show';files:unknown[];monitored:boolean;keep:boolean;earlyCopies?:boolean;paused:boolean;profileId:number;profiles:{id:number;name:string}[]};path:string;mutation:Mutation;onDeleted:()=>void;children:ReactNode}) {
  const [deleting,setDeleting]=useState(false);
  const update=(body:{profileId?:number;keep?:boolean;monitored?:boolean;earlyCopies?:boolean})=>void mutation.run(()=>api(path,'PUT',body));
  const resume=()=>void mutation.run(()=>api(`${path}/pause`,'POST',{paused:false}));
  return <div className="ui-movie-controls">
    <label className="ui-movie-control" title="Off: no searches or upgrades"><span>Monitored</span>
      <input type="checkbox" role="switch" className="switch" checked={t.monitored} disabled={mutation.busy} onChange={e=>update({monitored:e.target.checked})}/></label>
    <label className="ui-movie-control"><span>Profile</span>
      <select value={t.profileId} disabled={mutation.busy} onChange={e=>update({profileId:Number(e.target.value)})}>{t.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label className="ui-movie-control" title="Clean Up never removes it"><span>Favorite</span>
      <input type="checkbox" role="switch" className="switch" checked={t.keep} disabled={mutation.busy} onChange={e=>update({keep:e.target.checked})}/></label>
    {t.earlyCopies!==undefined&&<label className="ui-movie-control" title="Take cams and telesyncs from the cinema release until a better copy is out"><span>Early copies</span>
      <input type="checkbox" role="switch" className="switch" checked={t.earlyCopies} disabled={mutation.busy} onChange={e=>update({earlyCopies:e.target.checked})}/></label>}
    <div className="ui-movie-actions">
      {t.paused&&<button disabled={mutation.busy} title="Clear the failures and start searching again" onClick={resume}><Icon name="play" size={16}/>Resume</button>}
      {children}
      <button className="danger" disabled={mutation.busy} title={`Delete the ${t.kind} and its files`} onClick={()=>setDeleting(true)}><Icon name="trash" size={16}/>Delete</button>
    </div>
    {deleting&&<DeleteTitle t={t} path={path} onCancel={()=>setDeleting(false)} onDeleted={()=>{setDeleting(false);onDeleted();}}/>}
  </div>;
}

// Confirms a delete: the library forgets the title and, unless unticked, its folder goes from disk.
function DeleteTitle({t,path,onCancel,onDeleted}:{t:{title:string;kind:'movie'|'show';files:unknown[]};path:string;onCancel:()=>void;onDeleted:()=>void}) {
  const [files,setFiles]=useState(true),remove=useMutation(changed);
  const run=()=>void remove.run(async()=>{
    const r=await api<{files:number}>(path,'DELETE',{files});
    toast.info(`Deleted ${t.title}${files?` and ${r.files===1?'1 file':`${r.files} files`}`:''}`);onDeleted();
  });
  return <Modal title={`Delete ${t.kind}`} onClose={()=>{if(!remove.busy)onCancel();}}>
    <h2>Delete {t.title}?</h2>
    <p>This can’t be undone. It stops being monitored and leaves the library{files?', with its folder on disk':''}.</p>
    {t.files.length>0&&<label className="ui-movie-control"><input type="checkbox" checked={files} disabled={remove.busy} onChange={e=>setFiles(e.target.checked)}/><span>Delete files from disk</span></label>}
    {remove.error&&<ErrorNotice message={remove.error}/>}
    <div className="button-row"><button className="danger" disabled={remove.busy} onClick={run}>Delete</button><button disabled={remove.busy} onClick={onCancel}>Cancel</button></div>
  </Modal>;
}

// A show's files and grabs say which episodes each holds (S02E05, S02 for a pack). Each file says whether it has English
// subtitles and from where (subtitle-finder's /admin/subtitles/title/:id; the column is left out if that can't load).
export function FilesTable({titleId,files,path,now}:{titleId:number;files:LibraryTitleView['files'];path:string;now:number}) {
  const [deleting,setDeleting]=useState<LibraryTitleView['files'][number]>();
  const subs=useApi<TitleSubtitles>(`/admin/subtitles/title/${titleId}`);useRefresh(subs.reload);
  const episodes=files.some(f=>f.episodes),subtitles=subs.data?.files;
  const {rows,sort,onSort}=useSorted(files,{file:f=>f.path.split('/').pop(),episodes:f=>f.episodes,quality:f=>qualityRank(f.quality),size:f=>f.size,imported:f=>f.importedAt,
    subtitles:f=>subtitleRank(subtitles?.[f.id])});
  return <Table sort={sort} onSort={onSort} empty={files.length?undefined:'No file'} columns={[{label:'File',sort:'file'},...(episodes?[{label:'Episodes',width:130,sort:'episodes'}]:[]),
    {label:'Quality',width:130,sort:'quality',desc:true},{label:'Size',width:90,num:true,sort:'size',desc:true},...(subtitles?[{label:'Subtitles',width:180,sort:'subtitles'}]:[]),
    {label:'Imported',width:110,sort:'imported',desc:true},ACTIONS]}>
    {rows.map(f=><tr key={f.id}><td><span className="ui-mono" title={f.path}>{f.path.split('/').pop()}</span><small title={f.path}>{f.path}</small></td>
      {episodes&&<td>{f.episodes??<Dash/>}</td>}
      <td>{f.quality}{f.proper&&<small>Proper</small>}</td><td className="num">{gb(f.size)}</td>
      {subtitles&&<td><SubtitleCell s={subtitles[f.id]??{state:'unchecked'}} video={f.path}/></td>}
      <td><When at={f.importedAt} now={now}/></td>
      <td><RowActions><IconAction icon="trash" label="Delete this file" onClick={()=>setDeleting(f)}/></RowActions></td></tr>)}
    {deleting&&<DeleteFile file={deleting} path={path} onDone={()=>setDeleting(undefined)}/>}
  </Table>;
}

// English (green, named by where it came from), missing or the worker's job (amber; red when failed), not checked (grey).
const sourceNames:Record<SubtitleSource,[string,string]>={sidecar:['Sidecar','An English subtitle file was beside it'],embedded:['Embedded','An English text track inside the file'],
  opensubtitles:['OpenSubtitles','Downloaded from OpenSubtitles'],whisper:['Whisper','Made by the PC worker']};
const subtitleJobs:Partial<Record<SubtitleJobState,[string,Tone]>>={queued:['Queued','wait'],claimed:['Running','active'],failed:['Failed','bad']};
const subtitleRank=(s?:TitleSubtitle)=>!s||s.state==='unchecked'?undefined:s.state==='english'?0:s.state==='missing'?1:2;
// A subtitle named after its video shows only what it adds (.en.srt); the full path is on hover.
function subtitleName(path:string,video:string) {
  const name=path.split('/').pop()??path,base=(video.split('/').pop()??video).replace(/\.[^.]+$/,'');
  return name.startsWith(`${base}.`)?name.slice(base.length):name;
}
function SubtitleCell({s,video}:{s:TitleSubtitle;video:string}) {
  if(s.state==='english'){
    const [label,hint]=sourceNames[s.source],name=s.subtitlePath&&subtitleName(s.subtitlePath,video);
    const match=s.source==='opensubtitles'&&s.hashMatch!==undefined?`, ${s.hashMatch?'matched to this exact file':'matched by name'}`:'';
    return <><Pill tone="ok" title={`${hint}${match}`}>{label}</Pill>{name&&<small className="ui-mono" title={s.subtitlePath}>{name}</small>}</>;
  }
  if(s.state==='missing'){
    const job=s.job&&subtitleJobs[s.job.state];
    return <>{job?<Pill tone={job[1]}>{job[0]}</Pill>:<Pill tone="wait">Missing</Pill>}
      {s.job?.error?<small className="bad" title={s.job.error}>{s.job.error}</small>
        :s.job?<small>For the worker</small>:null}</>;
  }
  if(s.state==='skipped')return <><Pill tone="bad">Skipped</Pill><small className="bad" title={s.reason}>{s.reason}</small></>;
  return <Pill tone="off">Not checked</Pill>;
}

// Confirms deleting one file from disk; the title stays, so a monitored one wants it again.
function DeleteFile({file,path,onDone}:{file:LibraryTitleView['files'][number];path:string;onDone:()=>void}) {
  const remove=useMutation(changed),name=file.path.split('/').pop();
  const run=()=>void remove.run(async()=>{await api(`${path}/files/${file.id}`,'DELETE');toast.info(`Deleted ${name}`);onDone();});
  return <Modal title="Delete file" onClose={()=>{if(!remove.busy)onDone();}}>
    <h2>Delete this file?</h2>
    <p className="ui-mono">{name}</p>
    <p>This can’t be undone. The title stays in the library.</p>
    {remove.error&&<ErrorNotice message={remove.error}/>}
    <div className="button-row"><button className="danger" disabled={remove.busy} onClick={run}>Delete</button><button disabled={remove.busy} onClick={onDone}>Cancel</button></div>
  </Modal>;
}
// Who watched it and when (Admin › Activity › History's sessions for its Plex rating key), 50 at a time, newest first.
const watchSources:Record<HistoryListRow['source'],string>={vod:'tk.box',plex:'Plex app',iptv:'IPTV',custom:'Custom Channel'};
const deliveryNames:Record<string,string>={direct:'Direct Play',remux:'Direct Stream',transcode:'Transcode'};
const watched=(ms:number)=>ms<60000?`${Math.floor(ms/1000)}s`:`${ms>=3600000?`${Math.floor(ms/3600000)}h `:''}${Math.floor(ms/60000)%60}m`;
const pad=(n:number)=>String(n).padStart(2,'0');
export function WatchHistoryPanel({plex,show}:{plex?:PlexKey;show?:boolean}) {
  const [cursor,setCursor]=useState<string>(),[older,setOlder]=useState<string[]>([]);
  const query=plex&&new URLSearchParams({days:'all',server:plex.server,key:plex.key,...(cursor?{cursor}:{})});
  const view=useApi<{items:HistoryListRow[];next?:string}>(query&&`/admin/history/sessions?${query}`),now=Date.now();
  if(!plex)return <Panel><div className="ui-empty">Not on Plex yet</div></Panel>;
  if(view.error&&!view.data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data)return <Loading/>;
  const {items,next}=view.data;
  const more=(older.length>0||next)&&<div className="ui-more">
    {older.length>0&&<button type="button" onClick={()=>{setCursor(older.at(-2));setOlder(o=>o.slice(0,-1));}}>Newer</button>}
    {next&&<button type="button" onClick={()=>{setOlder(o=>[...o,next]);setCursor(next);}}>Older</button>}</div>;
  return <Panel flush><Table empty={items.length?undefined:'Nobody has watched it yet'} more={more} columns={[...(show?[{label:'Episode'}]:[]),{label:'Viewer',...(show?{width:200}:{})},
    {label:'Played on',width:170},{label:'Watched',width:110,num:true},{label:'When',width:110}]}>
    {items.map(r=>{
      const pct=r.durationMs&&r.durationMs>0?Math.min(100,Math.round(r.positionMs/r.durationMs*100)):undefined;
      return <tr key={r.id}>
        {show&&<td><span title={r.title}>{r.season!=null&&r.episode!=null&&<Tag>S{pad(r.season)}E{pad(r.episode)}</Tag>} {r.title}</span></td>}
        <td>{r.accountName??`Plex user ${r.accountId}`}<small>{r.client}</small></td>
        <td>{watchSources[r.source]}<small>{deliveryNames[r.stream.delivery]??'Unknown'}</small></td>
        <td className="num">{watched(r.watchMs)}<small>{r.endedAt===null?'In progress':pct!==undefined?`Reached ${pct}%`:''}</small></td>
        <td><When at={r.startedAt} now={now}/></td></tr>;
    })}
  </Table></Panel>;
}
export function GrabsTable({grabs,now}:{grabs:LibraryTitleView['grabs'];now:number}) {
  const {rows,sort,onSort}=useSorted(grabs,{release:g=>g.releaseName,quality:g=>qualityRank(g.quality),size:g=>g.size,state:g=>g.state,when:g=>g.importedAt??g.finishedAt??g.sentAt});
  return <Table sort={sort} onSort={onSort} empty={grabs.length?undefined:'Nothing grabbed yet'} columns={[{label:'Release',sort:'release'},{label:'Quality',width:130,sort:'quality',desc:true},
    {label:'Size',width:90,num:true,sort:'size',desc:true},{label:'Status',width:130,sort:'state'},{label:'When',width:110,sort:'when',desc:true}]}>
    {rows.map(g=><tr key={g.id}><td><span title={g.releaseName}>{g.episodes&&<Tag>{g.episodes}</Tag>} {g.releaseName}</span><small className={g.error?'bad':undefined}>{g.error??`${g.protocol==='usenet'?'Usenet':'Torrent'} · ${g.indexer}`}</small></td>
      <td>{g.quality}</td><td className="num">{gb(g.size)??<Dash/>}</td><td><GrabPill state={g.state}/></td><td><When at={g.importedAt??g.finishedAt??g.sentAt} now={now}/></td></tr>)}
  </Table>;
}
