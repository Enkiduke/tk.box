import {useEffect,useState} from 'react';
import {WEEKDAYS,describeSchedule,everyText,nextRun,parseCron,shortestGap,type Schedule,type Scheduled} from '../../../packages/contracts/src/schedule.js';
import {Icon} from './components.js';
import {date as when} from './settings-ui.js';

export type ScheduleState={lastRun?:number;note?:string};
type Kind=Schedule['kind']|'off';
const UNITS=[[1,'minutes'],[60,'hours'],[1440,'days']] as const;
const unitOf=(minutes:number)=>minutes%1440===0?1440:minutes%60===0?60:1;
const clock=(at:number)=>new Intl.DateTimeFormat(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit'}).format(at);
// What's wrong with a schedule, as the server would say it, or undefined.
export function scheduleProblem(schedule:Schedule,min:number) {
  if(schedule.kind==='cron')try{parseCron(schedule.expression);}catch(e){return (e as Error).message;}
  if(schedule.kind==='times'&&!schedule.times.length)return 'Add a time.';
  const gap=shortestGap(schedule);
  return gap===undefined?'This schedule never runs.':gap<min?`Runs too often: at most ${everyText(min).toLowerCase()}.`:undefined;
}

// Picks a schedule, in server local time: every so many minutes, hours or days; at set times on chosen weekdays (none
// chosen is every day); or a cron expression. `min` is the shortest gap allowed, in minutes; `off` names a choice for
// none (null).
export function SchedulePicker({value,set,min,off,disabled}:{value:Schedule|null;set:(value:Schedule|null)=>void;min:number;off?:string;disabled?:boolean}) {
  const kind:Kind=value?.kind??'off',[unit,setUnit]=useState(value?.kind==='every'?unitOf(value.minutes):60);
  useEffect(()=>{if(value?.kind==='every'&&value.minutes%unit)setUnit(unitOf(value.minutes));},[value]);
  const choose=(next:Kind)=>{
    if(next===kind)return;
    if(next==='off')return set(null);
    if(next==='every'){const minutes=Math.max(min,60);setUnit(unitOf(minutes));return set({kind:'every',minutes});}
    if(next==='times')return set({kind:'times',times:['04:00'],days:[]});
    // A cron line for what was chosen, where there is one.
    const t=value?.kind==='times'&&value.times.length===1?value.times[0]!.split(':').map(Number):[4,0];
    set({kind:'cron',expression:`${t[1]} ${t[0]} * * ${value?.kind==='times'&&value.days.length?[...value.days].sort().join(','):'*'}`});
  };
  const kinds:[Kind,string][]=[['every','Every'],['times','At set times'],['cron','Cron'],...(off?[['off',off] as [Kind,string]]:[])];
  const problem=value&&scheduleProblem(value,min);
  const upcoming=value&&!problem&&value.kind!=='every'?(()=>{const runs:number[]=[];for(let at=Date.now(),i=0;i<3;i++){const next=nextRun(value,at);if(next===undefined)break;runs.push(next);at=next;}return runs;})():[];
  const note=problem??(value?.kind==='every'?'Counted from the last run.':value?.kind==='cron'?`minute hour day month weekday${upcoming.length?` · Next: ${upcoming.map(clock).join(', ')}`:''}`:upcoming.length?`Next: ${upcoming.map(clock).join(', ')}`:'');
  return <fieldset className="schedule-picker" disabled={disabled}>
    <div className="schedule-line">
      <div className="toggle-group" role="radiogroup" aria-label="Schedule">{kinds.map(([k,label])=><button key={k} type="button" role="radio" aria-checked={kind===k} onClick={()=>choose(k)}>{label}</button>)}</div>
      {value?.kind==='every'&&<>
        <input type="number" min={1} max={Math.floor(28*1440/unit)} required aria-label="How many" value={value.minutes/unit} onChange={e=>set({kind:'every',minutes:Math.round(Number(e.target.value)*unit)})}/>
        <select aria-label="Unit" value={unit} onChange={e=>{const next=Number(e.target.value);setUnit(next);set({kind:'every',minutes:Math.round(value.minutes/unit)*next});}}>{UNITS.map(([n,label])=><option key={n} value={n}>{label}</option>)}</select>
      </>}
      {value?.kind==='cron'&&<input type="text" className="schedule-cron" required spellCheck={false} autoComplete="off" aria-label="Cron expression" value={value.expression} onChange={e=>set({kind:'cron',expression:e.target.value})} placeholder="0 4 * * 1-5"/>}
    </div>
    {value?.kind==='times'&&<div className="schedule-line">
      {value.times.map((t,i)=><span key={i} className="schedule-time"><input type="time" required aria-label={`Time ${i+1}`} value={t} onChange={e=>set({...value,times:value.times.map((old,j)=>j===i?e.target.value:old)})}/>
        {value.times.length>1&&<button type="button" className="icon-button" aria-label={`Remove ${t}`} onClick={()=>set({...value,times:value.times.filter((_,j)=>j!==i)})}><Icon name="close" size={14}/></button>}</span>)}
      {value.times.length<24&&<button type="button" className="icon-button" aria-label="Add a time" title="Add a time" onClick={()=>set({...value,times:[...value.times,value.times.at(-1)??'12:00']})}><Icon name="plus" size={16}/></button>}
      <div className="toggle-group" role="group" aria-label="Days">{WEEKDAYS.map((d,i)=><button key={d} type="button" role="checkbox" aria-checked={value.days.includes(i)} onClick={()=>set({...value,days:value.days.includes(i)?value.days.filter(x=>x!==i):[...value.days,i].sort()})}>{d}</button>)}</div>
    </div>}
    {note&&<small className={problem?'danger':undefined}>{note}</small>}
  </fieldset>;
}

// One scheduled job: a switch, its schedule (opened to change it), and when it last ran.
export function ScheduleRow({label,hint,state,value,set,min}:{label:string;hint:string;state?:ScheduleState;value:Scheduled;set:(value:Scheduled)=>void;min:number}) {
  const [open,setOpen]=useState(false),problem=value.enabled&&scheduleProblem(value.schedule,min);
  const status=state?.lastRun||state?.note?[state.lastRun&&`Last run ${when(state.lastRun)}`,state.note].filter(Boolean).join(' · '):'';
  return <div className={`artwork-schedule${value.enabled?'':' off'}`}>
    <div className="switch-text"><strong>{label}</strong><small>{hint}</small>{status&&<small className="artwork-schedule-status">{status}</small>}</div>
    <div className="artwork-schedule-control"><button type="button" className={`schedule-summary${problem?' danger':''}`} aria-expanded={open} aria-label={`${label} schedule: ${describeSchedule(value.schedule)}`} disabled={!value.enabled} onClick={()=>setOpen(!open)}>{describeSchedule(value.schedule)}<Icon name={open?'up':'down'} size={14}/></button></div>
    <input type="checkbox" role="switch" className="switch" aria-label={label} checked={value.enabled} onChange={e=>set({...value,enabled:e.target.checked})}/>
    {open&&value.enabled&&<div className="artwork-schedule-editor"><SchedulePicker value={value.schedule} min={min} set={schedule=>schedule&&set({...value,schedule})}/></div>}
  </div>;
}
