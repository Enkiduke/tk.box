import {useRef,useState,type DragEvent,type ReactNode} from 'react';
import {Icon} from './components.js';

// Small building blocks shared by every settings section.
export const date=(value:number|null)=>value===null?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'short'}).format(value);
export const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
export const code=(value:string)=>value.replaceAll('_',' ').toLowerCase();
export const moveTo=<T,>(list:T[],from:number,to:number)=>{if(to<0||to>=list.length||to===from)return list;const next=[...list],[item]=next.splice(from,1);next.splice(to,0,item!);return next;};
// Drag-and-drop reordering for lists that also have move buttons. One hook serves several lists
// (such as leagues within sports): each passes its own group, and drags never cross groups.
export function useDragOrder() {
  const [drag,setDrag]=useState<{group:string;from:number;over:number}>();
  return (group:string,i:number,onMove:(from:number,to:number)=>void,enabled=true)=>{
    if(!enabled)return {};
    const d=drag?.group===group?drag:undefined;
    return {draggable:true,'data-drag':d?d.from===i?'source':d.over===i?(i<d.from?'before':'after'):undefined:undefined,
      onDragStart:(e:DragEvent)=>{e.stopPropagation();e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(i));setDrag({group,from:i,over:i});},
      onDragOver:(e:DragEvent)=>{if(!d)return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';if(d.over!==i)setDrag({...d,over:i});},
      onDrop:(e:DragEvent)=>{if(!d)return;e.preventDefault();e.stopPropagation();setDrag(undefined);if(d.from!==i)onMove(d.from,i);},
      onDragEnd:()=>setDrag(undefined)};
  };
}
export function MoveButtons({name,index,count,disabled,onMove}:{name:string;index:number;count:number;disabled?:boolean;onMove:(to:number)=>void}) {
  return <span className="move-buttons"><span className="drag-grip" aria-hidden="true" title="Drag to reorder"><Icon name="grip" size={16}/></span>
    <button type="button" className="icon-button" aria-label={`Move ${name} up`} disabled={disabled||index===0} onClick={()=>onMove(index-1)}><Icon name="up" size={18}/></button>
    <button type="button" className="icon-button" aria-label={`Move ${name} down`} disabled={disabled||index===count-1} onClick={()=>onMove(index+1)}><Icon name="down" size={18}/></button></span>;
}
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
