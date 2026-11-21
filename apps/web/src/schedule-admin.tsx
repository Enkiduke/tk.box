import {useEffect,useState} from 'react';
import type {JobList,JobState,JobView} from '../../../packages/contracts/src/schedule.js';
import {api} from './api.js';
import {clock,invalidate,useApi} from './hooks.js';
import {Empty,ErrorNotice,Loading} from './components.js';
import {Card,SectionHead,plural,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {DownloadJobs} from './downloads-admin.js';

// Admin › Schedule: every background job tk.box runs, when each ran and runs next, and running one now.
const stateNames:Record<JobState,string>={running:'Running',ok:'OK',failed:'Failed',waiting:'Waiting',off:'Off',never:'Not run yet'};
const REFRESH_MS=15000,HOUR=3600000,DAY_HOURS=24;
const hourLabel=new Intl.DateTimeFormat(undefined,{hour:'numeric'});
// The zones the time zone picker offers: the browser's list, with the one in use if the list lacks it (UTC).
const zones=(current:string)=>{const all=(Intl as {supportedValuesOf?:(key:string)=>string[]}).supportedValuesOf?.('timeZone')??[];return all.includes(current)?all:[current,...all];};

// "3 min ago", "in 2 h", "just now".
function when(at:number,now:number) {
  const ms=at-now,abs=Math.abs(ms);
  if(abs<45000)return ms<0?'just now':'now';
  const [n,unit]=abs<HOUR?[Math.round(abs/60000),'min']:abs<DAY_HOURS*HOUR*2?[Math.round(abs/HOUR),'h']:[Math.round(abs/(DAY_HOURS*HOUR)),'d'];
  return ms<0?`${n} ${unit} ago`:`in ${n} ${unit}`;
}
// Needs a look first, then by when it next runs; jobs that are off last.
const rank=(job:JobView)=>job.state==='failed'?0:job.state==='running'?1:job.state==='waiting'?2:job.state==='off'?4:3;
const ordered=(jobs:JobView[])=>[...jobs].sort((a,b)=>rank(a)-rank(b)||(a.nextRun??Infinity)-(b.nextRun??Infinity)||a.label.localeCompare(b.label));

function StatePill({job}:{job:JobView}) {
  return <span className={`jobs-pill ${job.state}`} title={job.note}>{stateNames[job.state]}</span>;
}

export function ScheduleAdmin() {
  const list=useApi<JobList>('/admin/jobs'),[now,setNow]=useState(Date.now());
  const [starting,setStarting]=useState('');
  const mutation=useMutation(()=>invalidate('/admin/jobs'));
  useEffect(()=>{const t=setInterval(()=>{setNow(Date.now());if(!document.hidden)list.reload();},REFRESH_MS);return()=>clearInterval(t);},[]);
  const run=(job:JobView)=>{setStarting(job.id);void mutation.run(()=>api(`/admin/jobs/${encodeURIComponent(job.id)}/run`,'POST')).then(ok=>{if(ok)toast.info(`${job.label} started`);}).finally(()=>setStarting(''));};
  const data=list.data,attention=data?.jobs.filter(j=>j.state==='failed'||j.state==='waiting').length??0;
  const setZone=(timeZone:string)=>void mutation.run(()=>api('/admin/jobs/time-zone','PUT',{timeZone})).then(ok=>{if(ok)toast.info(`Schedules now run on ${timeZone} time`);});
  return <><SectionHead title="Schedule" description={data&&(attention?`${plural(attention,'job')} need${attention===1?'s':''} attention`:'Everything is on schedule')}>
      {data&&<select aria-label="Time zone" title="The time zone every schedule runs in" value={data.zone} disabled={mutation.busy} onChange={e=>setZone(e.target.value)}>{zones(data.zone).map(z=><option key={z} value={z}>{z.replaceAll('_',' ')}</option>)}</select>}
    </SectionHead>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    {list.error&&!data?<ErrorNotice message={list.error.message} retry={list.reload}/>:!data?<Loading/>:!data.jobs.length?<Empty title="No jobs"/>:<>
      <Timeline data={data} now={now}/>
      <Card title="All jobs" className="jobs-card">
        <div className="table-scroll"><table className="jobs-table"><thead><tr><th>Job</th><th>Schedule</th><th>State</th><th>Last run</th><th>Next run</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{ordered(data.jobs).map(job=><tr key={job.id} className={job.state==='off'?'is-off':undefined}>
            <td><a className="jobs-name" href={`#admin?section=${job.section}`}>{job.label}</a><span className="jobs-area">{job.area}</span>
              {job.note&&(job.state==='failed'||job.state==='waiting')&&<small className={`jobs-note ${job.state}`}>{job.note}</small>}</td>
            <td className="jobs-dim">{job.schedule}</td>
            <td><StatePill job={job}/></td>
            <td title={job.lastRun?new Date(job.lastRun).toLocaleString():undefined}>{job.lastRun?when(job.lastRun,now):<span className="jobs-dim">—</span>}</td>
            <td title={job.nextRun?new Date(job.nextRun).toLocaleString():undefined}>{job.nextRun?when(job.nextRun,now):<span className="jobs-dim">—</span>}</td>
            <td>{job.canRun&&<button className="link-button" disabled={mutation.busy||job.state==='running'} onClick={()=>run(job)}>{starting===job.id?'Starting…':'Run now'}</button>}</td>
          </tr>)}</tbody></table></div>
      </Card>
    </>}
    <DownloadJobs/>
  </>;
}

// Left, what ran lately and what runs next on one line through Now; right, the next day hour by hour.
function Timeline({data,now}:{data:JobList;now:number}) {
  const recent=data.jobs.filter(j=>j.lastRun&&j.state!=='off').sort((a,b)=>a.lastRun!-b.lastRun!).slice(-6);
  // Each job's next run once; the day view shows how often.
  const coming=data.jobs.flatMap(j=>j.nextRun!==undefined&&j.upcoming.length?[{job:j,at:j.nextRun}]:[]).sort((a,b)=>a.at-b.at);
  const runs=data.jobs.reduce((n,j)=>n+j.upcoming.length,0);
  const ran=data.jobs.filter(j=>j.lastRun&&now-j.lastRun<DAY_HOURS*HOUR).length;
  return <Card title="Timeline" className="jobs-card" actions={<span className="jobs-count">{ran} ran · {runs} coming</span>}>
    <div className="jobs-timeline">
      <ol className="jobs-rail">
        {recent.map(job=><li key={`r${job.id}`} className={`past ${job.state}`}><span className="jobs-when">{when(job.lastRun!,now)}</span><i/><span className="jobs-label">{job.label}</span><StatePill job={job}/></li>)}
        <li className="now"><span className="jobs-when">Now</span><i/><span className="jobs-line"/></li>
        {coming.slice(0,8).map(({job,at})=><li key={`c${job.id}${at}`}><span className="jobs-when">{when(at,now)}</span><i/><span className="jobs-label">{job.label}</span></li>)}
        {!coming.length&&<li className="empty"><span/><i/><span className="jobs-label">Nothing scheduled</span></li>}
      </ol>
      <DayView data={data} now={now}/>
    </div>
  </Card>;
}

// One row an hour from this hour on; each job that runs in an hour shows once, with how many runs and the first's time.
// Three or more quiet hours in a row fold into one line.
type Hour={from:number;to:number;runs:{job:JobView;first:number;count:number}[]};
function DayView({data,now}:{data:JobList;now:number}) {
  const start=new Date(now);start.setMinutes(0,0,0);
  const hours:Hour[]=Array.from({length:DAY_HOURS},(_,i)=>{
    const from=start.getTime()+i*HOUR,to=from+HOUR;
    const runs=data.jobs.flatMap(job=>{const at=job.upcoming.filter(t=>t>=from&&t<to);return at.length?[{job,first:at[0]!,count:at.length}]:[];}).sort((a,b)=>a.first-b.first);
    return {from,to,runs};
  });
  const rows:Hour[]=[];
  for(let i=0;i<hours.length;) {
    let j=i;while(j<hours.length&&!hours[j]!.runs.length)j++;
    if(j-i>=3){rows.push({from:hours[i]!.from,to:hours[j-1]!.to,runs:[]});i=j;}
    else{rows.push(hours[i]!);i++;}
  }
  return <div className="jobs-day">
    <div className="jobs-day-head"><span>Next 24 hours</span></div>
    <div className="jobs-hours">
      <div className="jobs-hour now"><span className="jobs-hour-label">{clock(now)}</span><div className="jobs-hour-runs"><span className="jobs-now-line"/></div></div>
      {rows.map(({from,to,runs})=>{const folded=to-from>HOUR;return <div key={from} className={`jobs-hour${runs.length?'':' quiet'}${folded?' folded':''}`}>
        <span className="jobs-hour-label">{hourLabel.format(from)}</span>
        <div className="jobs-hour-runs">
          {folded&&<span className="jobs-quiet">Nothing until {hourLabel.format(to)}</span>}
          {runs.map(({job,first,count})=><span key={job.id} className={`jobs-chip ${job.state}`} title={`${job.label} · ${job.schedule}`}>
            <span className="jobs-label">{job.label}</span>{count>1&&<span className="jobs-times">×{count}</span>}<span className="jobs-at">{clock(first)}</span></span>)}
        </div>
      </div>;})}
    </div>
  </div>;
}
