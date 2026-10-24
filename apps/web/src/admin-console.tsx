import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {date,useMutation} from './settings-ui.js';

// The Admin console: one drawer, docked at the bottom of every Admin section, that follows whatever the artwork engine,
// Collections and Clean Up run, manual or scheduled. Starting a run opens it on that run; otherwise it follows the newest.
// Artwork and Collections share one queue (and one job list), so a job may wait for the other's; Clean Up has its own.
export type JobStatus='queued'|'running'|'succeeded'|'failed'|'canceled';
export type Job={id:number;label:string;args:string[];script:'artwork'|'collections'|'cleanup';actor:string;status:JobStatus;createdAt:number;startedAt:number|null;finishedAt:number|null;exitCode:number|null};
type JobView=Job&{lines:string[];next:number};
const basePath=(script:Job['script'])=>script==='cleanup'?'/admin/cleanup/jobs':'/admin/artwork/jobs';
const keyOf=(job:Pick<Job,'script'|'id'>)=>`${basePath(job.script)}/${job.id}`;
const statusLabels:Record<JobStatus,[string,string]>={queued:['Waiting',''],running:['Running','warning'],succeeded:['Done','ok'],failed:['Failed','danger'],canceled:['Canceled','']};
const sources:Record<Job['script'],string>={artwork:'Artwork',collections:'Collections',cleanup:'Clean Up'};
const active=(job:Job)=>job.status==='running'||job.status==='queued';

// Sections call this right after starting a run. Outside Admin (Edit artwork from a title) there is no console to open.
let show:((job?:Pick<Job,'script'|'id'>)=>void)|undefined;
export const openConsole=(job?:Pick<Job,'script'|'id'>)=>show?.(job);

export function AdminConsole() {
  const artwork=useApi<{jobs:Job[]}>('/admin/artwork/jobs'),cleanup=useApi<{jobs:Job[]}>('/admin/cleanup/jobs');
  const [open,setOpen]=useState(false),[pinned,setPinned]=useState<string>(),[seen,setSeen]=useState<string>();
  const reload=()=>{artwork.reload();cleanup.reload();};
  const list=[...artwork.data?.jobs??[],...cleanup.data?.jobs??[]].sort((a,b)=>b.createdAt-a.createdAt).slice(0,40);
  const latest=list[0],busy=list.some(active),shown=list.find(j=>keyOf(j)===pinned)??latest;
  useEffect(()=>{show=job=>{setPinned(job?keyOf(job):undefined);setOpen(true);reload();};return()=>{show=undefined;};},[]);
  // Quick while something runs; otherwise only often enough to notice a scheduled run starting.
  useEffect(()=>{const timer=window.setInterval(reload,busy?3000:open?10000:30000);return()=>window.clearInterval(timer);},[busy,open]);
  useEffect(()=>{document.documentElement.classList.toggle('admin-console-open',open);if(open&&latest)setSeen(keyOf(latest));},[open,latest&&keyOf(latest)]);
  useEffect(()=>()=>document.documentElement.classList.remove('admin-console-open'),[]);
  // A failure nobody has looked at yet marks the tab.
  const failed=latest?.status==='failed'&&seen!==keyOf(latest);
  if(!open)return <button className="admin-console-tab" aria-expanded="false" onClick={()=>setOpen(true)}>
    {busy?<span className="status-dot ok pulse" aria-hidden="true"/>:failed&&<span className="status-dot danger" aria-hidden="true"/>}Console{busy?<span className="sr-only"> (a run is in progress)</span>:failed?<span className="sr-only"> (the last run failed)</span>:null}</button>;
  const error=artwork.error??cleanup.error;
  return <section className="admin-console" aria-label="Console">
    <div className="admin-console-bar">
      <strong>Console</strong>
      {list.length>0&&<select aria-label="Run to show" value={shown?keyOf(shown):''} onChange={e=>setPinned(e.target.value===keyOf(latest!)?undefined:e.target.value)}>
        {list.map(j=><option key={keyOf(j)} value={keyOf(j)}>{sources[j.script]} · {j.label} · {date(j.startedAt??j.createdAt)} · {statusLabels[j.status][0]}</option>)}</select>}
      {pinned&&<button className="link-button small" onClick={()=>setPinned(undefined)}>Follow the newest</button>}
      <span className="grow"/>
      <button className="icon-button" aria-label="Close the console" onClick={()=>setOpen(false)}><Icon name="close" size={18}/></button>
    </div>
    {error&&!list.length?<div className="admin-console-body"><ErrorNotice message={error.message} retry={reload}/></div>
      :!shown?<pre className="admin-console-output">{artwork.loading||cleanup.loading?'Loading…':'Nothing has run yet. Runs from Artwork, Collections and Clean Up, manual or scheduled, show here.'}</pre>
      :<JobOutput key={keyOf(shown)} job={shown} changed={reload}/>}
  </section>;
}

// Follows a running job's output; a finished job shows what was kept of it.
function JobOutput({job:listed,changed}:{job:Job;changed:()=>void}) {
  const base=basePath(listed.script),id=listed.id;
  const [job,setJob]=useState<JobView>(),[lines,setLines]=useState<string[]>([]),[error,setError]=useState(''),next=useRef(0),output=useRef<HTMLPreElement>(null),mutation=useMutation(changed);
  useEffect(()=>{
    let live=true,timer=0;next.current=0;setLines([]);
    const poll=async()=>{
      try {
        const view=await api<JobView>(`${base}/${id}?since=${next.current}`);if(!live)return;
        // A job that finished between polls is read again from the start, from what was saved.
        if(view.next<next.current){next.current=0;setLines([]);timer=window.setTimeout(()=>void poll(),0);return;}
        next.current=view.next;setJob(view);if(view.lines.length)setLines(l=>[...l,...view.lines].slice(-5000));setError('');
        if(view.status==='running'||view.status==='queued')timer=window.setTimeout(()=>void poll(),1500);else changed();
      } catch(e) {if(live){setError((e as Error).message);timer=window.setTimeout(()=>void poll(),5000);}}
    };
    void poll();return()=>{live=false;window.clearTimeout(timer);};
  },[id]);
  // Stays at the bottom while new lines arrive, unless the reader scrolled up.
  useEffect(()=>{const el=output.current;if(el&&el.scrollHeight-el.scrollTop-el.clientHeight<80)el.scrollTop=el.scrollHeight;},[lines.length]);
  if(!job)return error?<div className="admin-console-body"><ErrorNotice message={error}/></div>:<div className="admin-console-body"><Loading/></div>;
  const running=active(job),[label,tone]=statusLabels[job.status];
  return <>
    <div className="admin-console-status">
      <span className={`badge ${tone}`}>{label}</span>
      <small className="muted">{job.finishedAt?`Finished ${date(job.finishedAt)}`:job.startedAt?`Started ${date(job.startedAt)}`:'Waiting for the job before it'}{job.exitCode!==null&&job.exitCode!==0?` · exit code ${job.exitCode}`:''}</small>
      {running&&<button className="small" disabled={mutation.busy} onClick={()=>void mutation.run(()=>api(`${base}/${id}/cancel`,'POST',{}))}>Cancel run</button>}
      {error&&<span className="danger small">{error}</span>}{mutation.error&&<span className="danger small">{mutation.error}</span>}
    </div>
    <pre ref={output} className="admin-console-output" aria-live="off">{lines.length?lines.join('\n'):running?'Starting…':'No output.'}</pre>
  </>;
}
