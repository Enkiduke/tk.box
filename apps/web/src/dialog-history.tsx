import {createContext,useCallback,useContext,useEffect,useMemo,useState} from 'react';
import type {ExploreItem} from '../../../packages/contracts/src/index.js';
import {Icon} from './components.js';

// The title and person dialogs share one history: a title opens a person, the person another title, and Back in the
// dialog's header returns to the one before. Opening something from a page starts a new history.
export type PersonRef={id?:number;name:string;kind?:'movie'|'show';tmdb?:number;portraitUrl?:string};
export type DialogEntry=
  |{type:'title';item:ExploreItem;label?:string}
  |{type:'library';id:string;label?:string}
  |{type:'person';person:PersonRef;label?:string};
const MAX_ENTRIES=30;
export const entryKey=(entry:DialogEntry)=>entry.type==='title'?`title:${entry.item.key}`:entry.type==='library'?`library:${entry.id}`:`person:${entry.person.id??entry.person.name}`;
const entryLabel=(entry:DialogEntry)=>entry.label??(entry.type==='title'?entry.item.title:entry.type==='person'?entry.person.name:undefined);

export function useDialogHistory() {
  const [entries,setEntries]=useState<DialogEntry[]>([]);
  const start=useCallback((entry:DialogEntry)=>setEntries([entry]),[]);
  // Opening the dialog already on top does nothing.
  const push=useCallback((entry:DialogEntry)=>setEntries(s=>{
    const top=s.at(-1);
    return top&&entryKey(top)===entryKey(entry)?s:[...s,entry].slice(-MAX_ENTRIES);
  }),[]);
  // A library title moving to its season or episode stays one step.
  const openLibrary=useCallback((id:string)=>setEntries(s=>{
    const top=s.at(-1);
    if(top?.type==='library')return top.id===id?s:[...s.slice(0,-1),{type:'library',id}];
    return [...s,{type:'library' as const,id}].slice(-MAX_ENTRIES);
  }),[]);
  const back=useCallback(()=>setEntries(s=>s.length>1?s.slice(0,-1):s),[]);
  const close=useCallback(()=>setEntries([]),[]);
  const setLabel=useCallback((label:string)=>setEntries(s=>{
    const top=s.at(-1);
    return !top||top.label===label?s:[...s.slice(0,-1),{...top,label}];
  }),[]);
  const current=entries.at(-1),previous=entries.at(-2);
  const nav=useMemo<DialogNav>(()=>({
    back:previous?back:undefined,previous:previous&&entryLabel(previous),setLabel,openPerson:person=>push({type:'person',person})
  }),[previous,back,setLabel,push]);
  return {current,start,push,openLibrary,close,nav};
}

type DialogNav={back?:()=>void;previous?:string;setLabel:(label:string)=>void;openPerson:(person:PersonRef)=>void};
export const DialogNavContext=createContext<DialogNav|undefined>(undefined);
export const useDialogNav=()=>useContext(DialogNavContext);

// Back and where it goes, over the top of a dialog. Hidden until there is somewhere to go back to.
export function DialogNavBar({title}:{title?:string}) {
  const nav=useDialogNav();
  useEffect(()=>{if(title)nav?.setLabel(title);},[title,nav?.setLabel]);
  if(!nav?.back)return null;
  return <nav className="dialog-nav" aria-label="Dialog history">
    <button type="button" className="icon-button" aria-label={nav.previous?`Back to ${nav.previous}`:'Back'} onClick={nav.back}><Icon name="back" size={16}/></button>
    {nav.previous&&<button type="button" className="dialog-nav-crumb" onClick={nav.back}>{nav.previous}</button>}
    {title&&<><Icon name="next" size={12}/><span className="dialog-nav-current">{title}</span></>}
  </nav>;
}
