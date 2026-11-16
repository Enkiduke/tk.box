import type {LibraryTitleView,TitleView} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Switch,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {InteractiveSearchPanel} from './interactive-search.js';
import {SourceLine,SourcePanel} from './movie-source.js';
import {ShowDialogBody} from './show-dialog.js';
import {Dash,Field,GrabPill,Panel,Pill,Poster,Table,Tabs,Tag,When,WhenDay,changed,gb,qualityRank,useRefresh,useSorted,type TitlePane,type Tone} from './manage-ui.js';

// A movie or show in the library (docs/UI.md), as a dialog over whichever Admin page opened it (`&title=<id>`, and
// `&pane=search` for its Interactive search tab): what it has and needs, its settings, files and grabs, and the search.
// A show's dialog is show-dialog.tsx, sharing the tables here.

export type MoviePane=TitlePane;

export function MovieDialog({id,pane,scope,setPane,onClose}:{id:number;pane:TitlePane;scope?:string;setPane:(pane:TitlePane,scope?:string)=>void;onClose:()=>void}) {
  const path=`/admin/library/titles/${id}`,view=useApi<TitleView>(path),mutation=useMutation(changed);useRefresh(view.reload);
  const t=view.data;
  return <Modal title={t?.title??'Title'} variant="wide" onClose={onClose} scrollKey={`${id}`}>
    {view.error&&!t?<ErrorNotice message={view.error.message} retry={view.reload}/>:!t?<Loading/>
    :t.kind==='show'?<ShowDialogBody t={t} path={path} pane={pane} scope={scope} setPane={setPane} mutation={mutation}/>:<div className="ui-movie-dialog">
      <Head t={t} path={path} mutation={mutation}/>
      {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
      <Tabs label={t.title} value={pane==='search'?'search':'overview'} onChange={p=>setPane(p)} tabs={[{id:'overview',label:'Overview'},{id:'search',label:'Interactive search'}]}/>
      {pane==='search'?<InteractiveSearchPanel titleId={t.id}/>:<Overview t={t} path={path} mutation={mutation}/>}
    </div>}
  </Modal>;
}

export type Mutation=ReturnType<typeof useMutation>;
function statusOf(t:LibraryTitleView):{tone:Tone;label:string} {
  return t.paused?{tone:'off',label:'Paused'}:!t.monitored?{tone:'off',label:'Not monitored'}
    :t.wanted.wanted?{tone:'wait',label:t.wanted.why==='missing'?'Missing':'Below cutoff'}:{tone:'ok',label:'Available'};
}

// Poster, title, status, the facts that matter, and the two actions that don't need the tabs.
function Head({t,path,mutation}:{t:LibraryTitleView;path:string;mutation:Mutation}) {
  const now=Date.now(),s=statusOf(t),have=t.files[0];
  const search=()=>void mutation.run(async()=>{await api(`${path}/search`,'POST');toast.info(`Searching for ${t.title}`);});
  const pause=()=>void mutation.run(()=>api(`${path}/pause`,'POST',{paused:!t.paused}));
  return <header className="ui-movie">
    <Poster id={t.id} className="ui-movie-poster"/>
    <div className="ui-movie-main">
      <div>
        <h2 className="ui-movie-title">{t.title}{t.year?<span> {t.year}</span>:null}</h2>
        <div className="ui-movie-line"><Pill tone={s.tone}>{s.label}</Pill>{have&&<span>{have.quality} · {gb(have.size)}</span>}{t.keep&&<span className="ui-tag">Kept</span>}
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
      <div className="button-row">
        <button disabled={mutation.busy||t.paused||!t.monitored} title="Search now and grab the best match" onClick={search}><Icon name="search" size={16}/>Automatic search</button>
        <button disabled={mutation.busy} onClick={pause}><Icon name={t.paused?'play':'pause'} size={16}/>{t.paused?'Unpause':'Pause'}</button>
      </div>
    </div>
  </header>;
}

function Overview({t,path,mutation}:{t:LibraryTitleView;path:string;mutation:Mutation}) {
  const now=Date.now();
  const update=(body:{profileId?:number;keep?:boolean})=>void mutation.run(()=>api(path,'PUT',body));
  return <>
    <Panel flush title="Settings">
      <Field label="Profile"><select value={t.profileId} disabled={mutation.busy} onChange={e=>update({profileId:Number(e.target.value)})}>{t.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Keep" hint="Clean Up never removes it"><Switch label="" ariaLabel="Keep" checked={t.keep} disabled={mutation.busy} onChange={keep=>update({keep})}/></Field>
    </Panel>
    <SourcePanel source={t.source}/>
    <Panel flush title="Files"><FilesTable files={t.files} now={now}/></Panel>
    <Panel flush title="Grabs"><GrabsTable grabs={t.grabs} now={now}/></Panel>
  </>;
}

// A show's files and grabs say which episodes each holds (S02E05, S02 for a pack).
export function FilesTable({files,now}:{files:LibraryTitleView['files'];now:number}) {
  const episodes=files.some(f=>f.episodes);
  const {rows,sort,onSort}=useSorted(files,{file:f=>f.path.split('/').pop(),episodes:f=>f.episodes,quality:f=>qualityRank(f.quality),size:f=>f.size,imported:f=>f.importedAt});
  return <Table sort={sort} onSort={onSort} empty={files.length?undefined:'No file'} columns={[{label:'File',sort:'file'},...(episodes?[{label:'Episodes',width:130,sort:'episodes'}]:[]),
    {label:'Quality',width:130,sort:'quality',desc:true},{label:'Size',width:90,num:true,sort:'size',desc:true},{label:'Imported',width:110,sort:'imported',desc:true}]}>
    {rows.map(f=><tr key={f.id}><td><span className="ui-mono" title={f.path}>{f.path.split('/').pop()}</span><small title={f.path}>{f.path}</small></td>
      {episodes&&<td>{f.episodes??<Dash/>}</td>}
      <td>{f.quality}{f.proper&&<small>Proper</small>}</td><td className="num">{gb(f.size)}</td><td><When at={f.importedAt} now={now}/></td></tr>)}
  </Table>;
}
export function GrabsTable({grabs,now}:{grabs:LibraryTitleView['grabs'];now:number}) {
  const {rows,sort,onSort}=useSorted(grabs,{release:g=>g.releaseName,quality:g=>qualityRank(g.quality),size:g=>g.size,state:g=>g.state,when:g=>g.importedAt??g.finishedAt??g.sentAt});
  return <Table sort={sort} onSort={onSort} empty={grabs.length?undefined:'Nothing grabbed yet'} columns={[{label:'Release',sort:'release'},{label:'Quality',width:130,sort:'quality',desc:true},
    {label:'Size',width:90,num:true,sort:'size',desc:true},{label:'Status',width:130,sort:'state'},{label:'When',width:110,sort:'when',desc:true}]}>
    {rows.map(g=><tr key={g.id}><td><span title={g.releaseName}>{g.episodes&&<Tag>{g.episodes}</Tag>} {g.releaseName}</span><small className={g.error?'bad':undefined}>{g.error??`${g.protocol==='usenet'?'Usenet':'Torrent'} · ${g.indexer}`}</small></td>
      <td>{g.quality}</td><td className="num">{gb(g.size)??<Dash/>}</td><td><GrabPill state={g.state}/></td><td><When at={g.importedAt??g.finishedAt??g.sentAt} now={now}/></td></tr>)}
  </Table>;
}
