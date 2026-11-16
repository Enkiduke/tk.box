import {useState} from 'react';
import type {CutoverProblem,CutoverProblemKind,CutoverRun,CutoverView} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {ErrorNotice} from './components.js';
import {useApi} from './hooks.js';
import {SectionHead,plural,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {Dash,Field,Loaded,Panel,Pill,Segmented,Table,When,changed,useRefresh,usePaged,useSorted} from './manage-ui.js';

// Admin › Downloads › Sonarr import (docs/PHASE-2.md, step 6): a dry run, the import, then Switch (and Switch back
// until Sonarr is cut off in step 7). A dry run or import runs on the server; the page polls while it does.

const PATH='/admin/library/cutover';
type Filter='all'|'naming'|'folders'|'files'|'left-out';
const filters:readonly (readonly [Filter,string])[]=[['all','All'],['naming','Naming'],['folders','Folders'],['files','Files'],['left-out','Left out']];
const groupOf:Record<CutoverProblemKind,Exclude<Filter,'all'>>={naming:'naming','folder-name':'folders','file-name':'files',episode:'left-out',quality:'left-out',
  'outside-root':'left-out','no-tmdb':'left-out',duplicate:'left-out',profile:'naming'};
const kindNames:Record<CutoverProblemKind,string>={naming:'Naming','folder-name':'Folder name','file-name':'File names',episode:'Episodes',quality:'Quality',
  'outside-root':'Outside root','no-tmdb':'No TMDB match',duplicate:'Duplicate',profile:'Profile'};

export function SonarrImportPage() {
  const view=useApi<CutoverView>(PATH);
  const running=!!view.data?.run&&view.data.run.finishedAt===undefined;
  return <Loaded view={view}>{v=><Page v={v} running={running} reload={view.reload}/>}</Loaded>;
}

function Page({v,running,reload}:{v:CutoverView;running:boolean;reload:()=>void}) {
  const mutation=useMutation(()=>{reload();changed();});
  const onTkbox=v.fulfil==='tkbox',run=v.run,plan=run?.plan;
  const start=(kind:'dry-run'|'import')=>{
    if(kind==='import'&&!window.confirm(v.importedAt?'Import from Sonarr again? What Sonarr changed since is brought in.':'Import the shows from Sonarr?'))return;
    void mutation.run(()=>api<CutoverView>(`${PATH}/${kind}`,'POST'));
  };
  const switchTo=(back:boolean)=>{
    if(!window.confirm(back?'Switch shows back to Sonarr?':'Switch shows to tk.box? Requests move to the library and its searches start over the next day.'))return;
    void mutation.run(async()=>{const r=await api<CutoverView>(`${PATH}/${back?'switch-back':'switch'}`,'POST');
      toast.success(`${back?'Shows on Sonarr':'Shows on tk.box'} · ${plural(r.requests?.moved??0,'request')} moved${r.requests?.resent?`, ${r.requests.resent} resent`:''}`);});
  };
  return <>
    <SectionHead title="Sonarr import">
      <button disabled={mutation.busy||running||onTkbox} onClick={()=>start('dry-run')}>Dry run</button>
      <button disabled={mutation.busy||running||onTkbox||!(run?.kind==='dry-run'&&plan?.namingOk)} onClick={()=>start('import')}>Import</button>
    </SectionHead>
    {running&&<Poll reload={reload}/>}
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Panel title="Shows" actions={onTkbox?<button className="danger" disabled={mutation.busy} onClick={()=>switchTo(true)}>Switch back</button>
      :<button className="primary" disabled={mutation.busy||running||!v.importedAt} onClick={()=>switchTo(false)}>Switch to tk.box</button>}>
      <Field label="Fulfilled by">{onTkbox?<Pill tone="ok">tk.box</Pill>:<Pill tone="wait">Sonarr</Pill>}</Field>
      <Field label="Imported">{v.importedAt?<>{plural(v.imported,'show')} · <When at={v.importedAt}/></>:<Dash/>}</Field>
      <Field label="Switched">{v.switchedAt?<When at={v.switchedAt}/>:<Dash/>}</Field>
      {v.switchedBackAt&&<Field label="Switched back"><When at={v.switchedBackAt}/></Field>}
    </Panel>
    {run&&<RunPanel run={run}/>}
    {plan&&plan.problems.length>0&&<Problems problems={plan.problems}/>}
  </>;
}

// Re-reads the view every 2 s while a run is under way.
function Poll({reload}:{reload:()=>void}) { useRefresh(reload,2000); return null; }

function RunPanel({run}:{run:CutoverRun}) {
  const s=run.plan?.summary,title=run.kind==='import'?'Import':'Dry run';
  const status=run.finishedAt===undefined?<Pill tone="active">Running</Pill>:run.error?<Pill tone="bad">Failed</Pill>
    :run.plan?.namingOk?<Pill tone="ok">Naming matches</Pill>:<Pill tone="bad">Naming differs</Pill>;
  return <Panel title={title} actions={status}>
    <Field label="Started"><When at={run.startedAt}/></Field>
    {run.error&&<Field label="Error"><span className="danger-text">{run.error}</span></Field>}
    {s&&<>
      <Field label="Series">{s.importable} of {s.series} to import{s.added!==undefined&&<> · {s.added} added, {s.updated} updated</>}</Field>
      <Field label="Monitored">{s.monitored}</Field>
      <Field label="Episodes">{s.episodes}</Field>
      <Field label="Files">{s.files}{s.specials>0&&<span className="muted"> · {plural(s.specials,'special')} left out</span>}</Field>
      <Field label="Keep">{s.keep}</Field>
      <Field label="Profiles">{Object.entries(s.profiles).map(([name,n])=>`${name} ${n}`).join(' · ')||<Dash/>}</Field>
      {s.sameRoots.length>0&&<Field label="Same folder as root"><code className="ui-code">{s.sameRoots.join(', ')}</code></Field>}
    </>}
  </Panel>;
}

const columns=[{label:'Series',width:280,sort:'title'},{label:'Problem',width:130,sort:'kind'},{label:'Detail'}];
function Problems({problems}:{problems:CutoverProblem[]}) {
  const [filter,setFilter]=useState<Filter>('all');
  const items=problems.filter(p=>filter==='all'||groupOf[p.kind]===filter);
  const {rows:sorted,sort,onSort}=useSorted(items,{title:p=>p.title,kind:p=>kindNames[p.kind]});
  const {rows,more}=usePaged(sorted,`${filter}|${sort?.key}|${sort?.dir}`);
  return <Panel flush title={`Problems · ${problems.length}`} actions={<Segmented label="Problems" value={filter} options={filters} onChange={setFilter}/>}>
    <Table columns={columns} sort={sort} onSort={onSort} more={more} empty={!items.length?'None of this kind':undefined}>
      {rows.map((p,i)=><tr key={i}><td>{p.title??<Dash/>}</td><td>{kindNames[p.kind]}</td><td className={p.blocking?'danger-text':undefined} title={p.detail}>{p.detail}</td></tr>)}
    </Table>
  </Panel>;
}
