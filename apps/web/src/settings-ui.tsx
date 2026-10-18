import {useRef,useState,type ReactNode} from 'react';

// Small building blocks shared by every settings section.
export const date=(value:number|null)=>value===null?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'short'}).format(value);
export const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
export const code=(value:string)=>value.replaceAll('_',' ').toLowerCase();
export const move=<T,>(list:T[],i:number,by:number)=>{const j=i+by;if(j<0||j>=list.length)return list;const next=[...list];[next[i],next[j]]=[next[j]!,next[i]!];return next;};
export function useMutation(changed:()=>void) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  return {busy,error,setError,run:async(action:()=>Promise<unknown>)=>{if(lock.current)return false;lock.current=true;setBusy(true);setError('');try{await action();changed();return true;}catch(e){setError((e as Error).message);changed();return false;}finally{lock.current=false;setBusy(false);}}};
}
// Remembered per browser: which settings section and tab were open last.
export const remembered=(key:string,fallback:string)=>{try{return localStorage.getItem(`tk.settings.${key}`)??fallback;}catch{return fallback;}};
export const remember=(key:string,value:string)=>{try{localStorage.setItem(`tk.settings.${key}`,value);}catch{/* private window */}};
export function Switch({label,description,checked,disabled,onChange}:{label:string;description?:ReactNode;checked:boolean;disabled?:boolean;onChange:(value:boolean)=>void}) {
  return <label className="switch-row"><span className="switch-text"><strong>{label}</strong>{description&&<small>{description}</small>}</span><input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/></label>;
}
export function Stat({label,value,tone,hint}:{label:string;value:ReactNode;tone?:'ok'|'warning'|'danger';hint?:string}) {
  return <div className={`stat ${tone??''}`}><span>{label}</span><strong>{value}</strong>{hint&&<small>{hint}</small>}</div>;
}
export function SectionHead({title,description,children}:{title:string;description?:ReactNode;children?:ReactNode}) {
  return <div className="settings-head"><div><h2>{title}</h2>{description&&<p className="muted">{description}</p>}</div>{children&&<div className="button-row">{children}</div>}</div>;
}
export function Card({title,description,actions,children,className}:{title?:string;description?:ReactNode;actions?:ReactNode;children?:ReactNode;className?:string}) {
  return <section className={`settings-card ${className??''}`}>{(title||actions)&&<div className="settings-card-head"><div>{title&&<h3>{title}</h3>}{description&&<p className="muted small">{description}</p>}</div>{actions&&<div className="button-row">{actions}</div>}</div>}{children}</section>;
}
