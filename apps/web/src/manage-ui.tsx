import {useEffect,useState,type ReactNode} from 'react';
import type {GrabState} from '../../../packages/contracts/src/downloads.js';
import {ApiClientError} from './api.js';
import {ErrorNotice,Loading} from './components.js';
import {invalidate,link} from './hooks.js';
import {Card} from './settings-ui.js';

// Admin › Manage (docs/PHASE-3.5.md): the pieces every Manage page shares, so the pages look and behave alike. One
// table style, one way to show a time, one state badge, one empty line, one loading state and one save pattern.

const MINUTE=60000,HOUR=3600000,DAY=86400000,GB=1024**3;
export const changed=()=>invalidate('/admin/library');
export const titleHref=(id:number)=>link('admin',{section:'movies',title:id});
export const gb=(bytes?:number)=>bytes===undefined?'—':bytes>=GB?`${(bytes/GB).toFixed(1)} GB`:`${Math.round(bytes/1024**2)} MB`;

// "in 3 h" / "2 d ago"; "just now" within 45 s.
export function relative(at:number,now=Date.now()) {
  const ms=at-now,abs=Math.abs(ms);
  if(abs<45000)return ms<0?'just now':'now';
  const [n,unit]=abs<HOUR?[Math.max(1,Math.round(abs/MINUTE)),'min']:abs<2*DAY?[Math.round(abs/HOUR),'h']:[Math.round(abs/DAY),'d'];
  return ms<0?`${n} ${unit} ago`:`in ${n} ${unit}`;
}
const exact=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
// A time as "in 3 h" / "2 d ago", with the exact date on hover. `due` replaces a time already past (a search due now).
export function When({at,now,due,empty='—'}:{at?:number;now?:number;due?:string;empty?:string}) {
  if(!at)return <span className="muted">{empty}</span>;
  const n=now??Date.now();
  return <time dateTime={new Date(at).toISOString()} title={exact.format(at)}>{due&&at<=n?due:relative(at,n)}</time>;
}
// A day (YYYY-MM-DD) the same way, counted from midnight UTC.
export const WhenDay=({day,now}:{day?:string;now?:number})=><When at={day?Date.parse(`${day}T00:00:00Z`)||undefined:undefined} now={now}/>;

// One badge per grab state, the same everywhere.
export const stateNames:Record<GrabState,string>={sending:'Sending',downloading:'Downloading',unpacking:'Unpacking',importing:'Importing',imported:'Imported',seeding:'Seeding',done:'Done',failed:'Failed',cancelled:'Cancelled'};
const stateTone:Partial<Record<GrabState,string>>={imported:'ok',done:'ok',seeding:'ok',failed:'danger',downloading:'warning',unpacking:'warning',importing:'warning',sending:'warning'};
export const GrabBadge=({state}:{state:GrabState})=><span className={`badge ${stateTone[state]??''}`}>{stateNames[state]}</span>;
export const Badge=({tone,children}:{tone?:'ok'|'warning'|'danger';children:ReactNode})=><span className={`badge ${tone??''}`}>{children}</span>;

// A movie's poster, small and lazy, from the server's cached TMDB details; a blank frame when there is none.
export function Poster({id}:{id:number}) {
  const [failed,setFailed]=useState(false);
  return <span className="manage-poster" aria-hidden="true">{!failed&&<img src={`/api/v1/admin/library/titles/${id}/poster`} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>}</span>;
}
// A movie in a table: poster, title (opening its page) and year, and a line under it.
export function TitleCell({id,title,year,sub,poster=true}:{id:number;title:string;year?:number;sub?:ReactNode;poster?:boolean}) {
  return <div className="manage-title">{poster&&<Poster id={id}/>}<div><a className="jobs-name" href={titleHref(id)}>{title}</a>{year?<span className="muted"> {year}</span>:null}{sub&&<small>{sub}</small>}</div></div>;
}

// The one table: sticky header, numbers aligned right (`num` columns).
export type Column={label:ReactNode;num?:boolean;hide?:boolean};
export function Table({columns,children,className}:{columns:Column[];children:ReactNode;className?:string}) {
  return <div className="table-scroll manage-scroll"><table className={`jobs-table manage-table ${className??''}`}>
    <thead><tr>{columns.filter(c=>!c.hide).map((c,i)=><th key={i} className={c.num?'num':undefined}>{c.label}</th>)}</tr></thead>
    <tbody>{children}</tbody></table></div>;
}

// A card that holds a list; empty, it folds to one line.
export function ListSection({title,count,empty,actions,children}:{title:string;count:number;empty:string;actions?:ReactNode;children:ReactNode}) {
  if(!count)return <div className="manage-empty-line"><strong>{title}</strong><span>{empty}</span></div>;
  return <Card title={title} actions={<>{actions}<span className="muted small">{count}</span></>}>{children}</Card>;
}
// One empty state for a whole page or a filtered list.
export const EmptyLine=({children}:{children:ReactNode})=><p className="manage-empty">{children}</p>;

// One loading state: a page waits on `view`; an error with nothing loaded offers Try again.
export function Loaded<T>({view,children}:{view:{data?:T;error?:Error;reload:()=>void};children:(data:T)=>ReactNode}) {
  if(view.error&&!view.data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(view.data===undefined)return <Loading/>;
  return <>{children(view.data)}</>;
}

// Re-reads a view every 10 s while the page is visible.
export function useRefresh(reload:()=>void,ms=10000) {useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)reload();},ms);return()=>clearInterval(t);},[]);}

// One save pattern: Save and Cancel appear once something changed; a save that started from an old version says so
// and offers Reload.
export function SaveBar({dirty,busy,error,onCancel,onReload,label='Save'}:{dirty:boolean;busy:boolean;error?:unknown;onCancel:()=>void;onReload?:()=>void;label?:string}) {
  const conflict=error instanceof ApiClientError&&error.code==='REVISION_CONFLICT';
  return <>
    {error?conflict?<div className="notice error" role="alert"><span>Someone saved this first.</span>{onReload&&<button type="button" onClick={onReload}>Reload</button>}</div>
      :<ErrorNotice message={(error as Error).message??String(error)}/>:null}
    {dirty&&<div className="button-row manage-save"><button className="primary" disabled={busy}>{busy?'Saving…':label}</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>}
  </>;
}
// Like useMutation, but keeps the error itself so SaveBar can tell a conflict from the rest.
export function useSave(after:()=>void) {
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
  return {busy,error,clear:()=>setError(undefined),run:async(action:()=>Promise<unknown>)=>{
    if(busy)return false;setBusy(true);setError(undefined);
    try{await action();after();return true;}catch(e){setError(e);return false;}finally{setBusy(false);}
  }};
}

// A search box and the controls beside it, above a list.
export function Toolbar({query,setQuery,placeholder,children}:{query:string;setQuery:(q:string)=>void;placeholder:string;children?:ReactNode}) {
  return <div className="manage-toolbar"><input type="search" className="manage-search" placeholder={placeholder} aria-label={placeholder} value={query} onChange={e=>setQuery(e.target.value)}/>{children}</div>;
}
export function Segmented<T extends string>({label,value,options,onChange}:{label:string;value:T;options:readonly (readonly [T,string])[];onChange:(v:T)=>void}) {
  return <div className="toggle-group" role="radiogroup" aria-label={label}>{options.map(([v,text])=><button key={v} type="button" role="radio" aria-checked={value===v} onClick={()=>onChange(v)}>{text}</button>)}</div>;
}
export const matches=(query:string,...fields:(string|number|undefined)[])=>{const q=query.trim().toLocaleLowerCase();return !q||fields.some(f=>f!==undefined&&String(f).toLocaleLowerCase().includes(q));};
