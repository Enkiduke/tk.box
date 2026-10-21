import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {Empty,ErrorNotice,Loading} from './components.js';
import {date,useMutation} from './settings-ui.js';

// The Jobs tabs of Artwork and Collections, and Clean Up's runs: one engine's recent jobs, and the chosen one's output.
// Artwork and Collections share one queue, so a job may wait for the other's; Clean Up has its own.
export type JobStatus='queued'|'running'|'succeeded'|'failed'|'canceled';
export type Job={id:number;label:string;args:string[];script:'artwork'|'collections'|'cleanup';actor:string;status:JobStatus;createdAt:number;startedAt:number|null;finishedAt:number|null;exitCode:number|null};
type JobView=Job&{lines:string[];next:number};
const jobsPath=(script:Job['script'])=>script==='cleanup'?'/admin/cleanup/jobs':'/admin/artwork/jobs';
const statusLabels:Record<JobStatus,[string,string]>={queued:['Waiting',''],running:['Running','warning'],succeeded:['Done','ok'],failed:['Failed','danger'],canceled:['Canceled','']};

export function JobHistory({script,selected,select}:{script:Job['script'];selected?:number;select:(id:number)=>void}) {
  const jobs=useApi<{jobs:Job[]}>(script==='cleanup'?jobsPath(script):`${jobsPath(script)}?script=${script}`),list=jobs.data?.jobs??[],active=list.some(j=>j.status==='running'||j.status==='queued');
  const shown=selected??list[0]?.id;
  useEffect(()=>{if(!active)return;const timer=window.setInterval(jobs.reload,3000);return()=>window.clearInterval(timer);},[active]);
  if(jobs.loading&&!jobs.data)return <Loading/>;
  if(jobs.error)return <ErrorNotice message={jobs.error.message} retry={jobs.reload}/>;
  if(!list.length)return <Empty title="No jobs yet">Run one above. Its output appears here.</Empty>;
  return <div className="artwork-jobs">
    <ul className="artwork-job-list" aria-label="Jobs">{list.map(j=>{const [label,tone]=statusLabels[j.status];return <li key={j.id}><button aria-current={j.id===shown} onClick={()=>select(j.id)}>
      <span>{j.label}<small>{date(j.startedAt??j.createdAt)}</small></span><span className={`badge ${tone}`}>{label}</span></button></li>;})}</ul>
    {shown!==undefined&&<JobConsole key={shown} id={shown} base={jobsPath(script)} changed={jobs.reload}/>}
  </div>;
}
// Follows a running job's output; a finished job shows what was kept of it.
function JobConsole({id,base,changed}:{id:number;base:string;changed:()=>void}) {
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
  if(!job)return error?<ErrorNotice message={error}/>:<Loading/>;
  const running=job.status==='running'||job.status==='queued';
  return <div className="form-stack">
    <div className="setting-line"><span className="grow"><strong>{job.label}</strong><small className="muted">{job.finishedAt?`Finished ${date(job.finishedAt)}`:job.startedAt?`Started ${date(job.startedAt)}`:'Waiting for the job before it'}{job.exitCode!==null&&job.exitCode!==0?` · exit code ${job.exitCode}`:''}</small></span>
      {running&&<button disabled={mutation.busy} onClick={()=>void mutation.run(()=>api(`${base}/${id}/cancel`,'POST',{}))}>Cancel</button>}</div>
    {error&&<ErrorNotice message={error}/>}{mutation.error&&<ErrorNotice message={mutation.error}/>}
    <pre ref={output} className="artwork-console" aria-live="off">{lines.length?lines.join('\n'):running?'Starting…':'No output.'}</pre>
  </div>;
}
