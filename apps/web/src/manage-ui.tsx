import {useEffect,useState,type ReactNode} from 'react';
import type {GrabState} from '../../../packages/contracts/src/downloads.js';
import {ApiClientError} from './api.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {invalidate} from './hooks.js';
import './ui.css';

// The Admin pieces (docs/UI.md): every Manage page is built from these, so pages look and behave alike. A panel, one
// bar (tabs or a toolbar), one table, one status pill, settings fields and one save pattern.

const MINUTE=60000,HOUR=3600000,DAY=86400000,GB=1024**3;
export const changed=()=>invalidate('/admin/library');
// A movie opens as a dialog over the page you're on: the same address with `title` (and `pane`) added.
export function movieHref(id:number,pane?:'search') {
  const query=new URLSearchParams(window.location.hash.split('?')[1]??'');
  query.set('title',String(id));
  if(pane)query.set('pane',pane);else query.delete('pane');
  return `#admin?${query}`;
}
export const openMovie=(id:number,pane?:'search')=>{window.location.hash=movieHref(id,pane).slice(1);};
export const titleHref=(id:number)=>movieHref(id);
export const gb=(bytes?:number)=>bytes===undefined?undefined:bytes>=GB?`${(bytes/GB).toFixed(1)} GB`:`${Math.round(bytes/1024**2)} MB`;
export const Dash=()=><span className="ui-dash">—</span>;

// ---- Time ----

// "in 3 h" / "2 d ago"; "just now" within 45 s; the date itself beyond 45 days, where a count of days says little.
const farDate=new Intl.DateTimeFormat(undefined,{dateStyle:'medium'});
export function relative(at:number,now=Date.now()) {
  const ms=at-now,abs=Math.abs(ms);
  if(abs<45000)return ms<0?'just now':'now';
  if(abs>45*DAY)return farDate.format(at);
  const [n,unit]=abs<HOUR?[Math.max(1,Math.round(abs/MINUTE)),'min']:abs<2*DAY?[Math.round(abs/HOUR),'h']:[Math.round(abs/DAY),'d'];
  return ms<0?`${n} ${unit} ago`:`in ${n} ${unit}`;
}
const exact=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
// A time as "in 3 h" / "2 d ago", the exact date on hover. `due` stands in for a time already past.
export function When({at,now,due,empty}:{at?:number;now?:number;due?:string;empty?:string}) {
  if(!at)return empty?<span className="ui-dash">{empty}</span>:<Dash/>;
  const n=now??Date.now();
  return <time dateTime={new Date(at).toISOString()} title={exact.format(at)}>{due&&at<=n?due:relative(at,n)}</time>;
}
export const WhenDay=({day,now}:{day?:string;now?:number})=><When at={day?Date.parse(`${day}T00:00:00Z`)||undefined:undefined} now={now}/>;

// ---- Status ----

export type Tone='ok'|'active'|'wait'|'bad'|'off';
export const Pill=({tone='off',children,title}:{tone?:Tone;children:ReactNode;title?:string})=><span className={`ui-pill ${tone}`} title={title}>{children}</span>;
export const Tag=({children}:{children:ReactNode})=><span className="ui-tag">{children}</span>;
export const grabNames:Record<GrabState,string>={sending:'Sending',downloading:'Downloading',unpacking:'Unpacking',importing:'Importing',imported:'Imported',seeding:'Seeding',done:'Done',failed:'Failed',cancelled:'Cancelled'};
export const grabTones:Record<GrabState,Tone>={sending:'active',downloading:'active',unpacking:'active',importing:'active',seeding:'active',imported:'ok',done:'ok',failed:'bad',cancelled:'off'};
export const GrabPill=({state}:{state:GrabState})=><Pill tone={grabTones[state]}>{grabNames[state]}</Pill>;

// ---- Titles ----

// A movie's poster, small and lazy, from the server's cached TMDB details; a blank frame when there is none.
export function Poster({id,className='ui-poster'}:{id:number;className?:string}) {
  const [failed,setFailed]=useState(false);
  return <span className={className} aria-hidden="true">{!failed&&<img src={`/api/v1/admin/library/titles/${id}/poster`} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>}</span>;
}
// A movie in a table: poster, title (opening its page), year and tags, and a line under it.
export function TitleCell({id,title,year,sub,tags,poster=true}:{id:number;title:string;year?:number;sub?:ReactNode;tags?:ReactNode;poster?:boolean}) {
  return <div className="ui-title">{poster&&<Poster id={id}/>}<div>
    <a className="ui-title-name" href={titleHref(id)} title={title}>{title}</a>{year?<span className="ui-title-year">{year}</span>:null}{tags&&<span className="ui-title-tags">{tags}</span>}
    {sub&&<small title={typeof sub==='string'?sub:undefined}>{sub}</small>}</div></div>;
}

// ---- Panel, bar, tabs ----

export function Panel({title,actions,children,footer,flush}:{title?:ReactNode;actions?:ReactNode;children:ReactNode;footer?:ReactNode;flush?:boolean}) {
  return <section className="ui-panel">
    {(title||actions)&&<div className="ui-panel-head">{title?<h3>{title}</h3>:<span/>}{actions&&<div className="ui-panel-actions">{actions}</div>}</div>}
    {flush?children:<div className="ui-panel-body">{children}</div>}
    {footer}
  </section>;
}
export type TabItem<T extends string>={id:T;label:string;count?:number;tone?:'bad'|'active'};
export function Tabs<T extends string>({tabs,value,onChange,label}:{tabs:TabItem<T>[];value:T;onChange:(id:T)=>void;label:string}) {
  return <div className="ui-tabs" role="tablist" aria-label={label}>{tabs.map(t=><button key={t.id} role="tab" aria-selected={value===t.id} onClick={()=>onChange(t.id)}>
    {t.label}{t.count!==undefined&&<span className={`ui-tab-count ${t.count?t.tone??'':'zero'}`}>{t.count}</span>}</button>)}</div>;
}
export function Toolbar({query,setQuery,placeholder,count,children}:{query:string;setQuery:(q:string)=>void;placeholder:string;count?:ReactNode;children?:ReactNode}) {
  return <div className="ui-bar">
    <label className="ui-search"><Icon name="search" size={15}/><input type="search" placeholder={placeholder} aria-label={placeholder} value={query} onChange={e=>setQuery(e.target.value)}/></label>
    {children}{count!==undefined&&<span className="ui-count">{count}</span>}
  </div>;
}
export function Segmented<T extends string>({label,value,options,onChange}:{label:string;value:T;options:readonly (readonly [T,string])[];onChange:(v:T)=>void}) {
  return <div className="toggle-group" role="radiogroup" aria-label={label}>{options.map(([v,text])=><button key={v} type="button" role="radio" aria-checked={value===v} onClick={()=>onChange(v)}>{text}</button>)}</div>;
}

// ---- Table ----

// Columns have fixed widths (docs/UI.md); the one without a width takes the rest. A column with `sort` sorts the
// table when its header is clicked (`desc`: biggest or newest first on the first click), through `useSorted`.
export type Column={label:ReactNode;width?:number;num?:boolean;sort?:string;desc?:boolean};
export type SortState={key:string;dir:1|-1};
export function Table({columns,children,posters,empty,more,sort,onSort}:{columns:Column[];children:ReactNode;posters?:boolean;empty?:ReactNode;more?:ReactNode;
  sort?:SortState;onSort?:(key:string,first:1|-1)=>void}) {
  const head=(c:Column)=>{
    if(!c.sort||!onSort)return c.label;
    const on=sort?.key===c.sort;
    return <button type="button" className={`ui-sort ${on?'on':''}`} onClick={()=>onSort(c.sort!,c.desc?-1:1)}>
      {c.label}<Icon name={on&&sort!.dir===-1?'down':'up'} size={12}/></button>;
  };
  return <><div className="ui-table-wrap"><table className={`ui-table ${posters?'with-posters':''}`}>
    <colgroup>{columns.map((c,i)=><col key={i} style={c.width?{width:c.width}:undefined}/>)}</colgroup>
    <thead><tr>{columns.map((c,i)=><th key={i} className={c.num?'num':undefined}
      aria-sort={c.sort&&sort?.key===c.sort?sort.dir===1?'ascending':'descending':undefined}>{head(c)}</th>)}</tr></thead>
    <tbody>{children}</tbody></table></div>
    {empty&&<div className="ui-empty">{empty}</div>}{more}</>;
}
// Quality sorts by the ladder (lib/quality.ts), not by name.
const LADDER=['Unknown','CAM','TELESYNC','TELECINE','SCREENER','SDTV','DVD','WEBRip-480p','WEBDL-480p','Bluray-480p','Bluray-576p','HDTV-720p','WEBRip-720p','WEBDL-720p','Bluray-720p','HDTV-1080p','WEBRip-1080p','WEBDL-1080p',
  'Bluray-1080p','Remux-1080p','HDTV-2160p','WEBRip-2160p','WEBDL-2160p','Bluray-2160p','Remux-2160p'];
export const qualityRank=(q?:string)=>q===undefined?undefined:LADDER.indexOf(q);
// Sorting by a header: one click sorts by that column, a second reverses it, a third goes back to the table's own
// order (`initial`, or as given). Empty values always sort last.
type SortValue=string|number|undefined|null;
const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
export function useSorted<T>(items:T[],by:Record<string,(row:T)=>SortValue>,initial?:SortState) {
  const [sort,setSort]=useState<SortState|undefined>(initial);
  const onSort=(key:string,first:1|-1)=>setSort(s=>s?.key!==key?{key,dir:first}:s.dir===first?{key,dir:first===1?-1:1}:initial);
  const get=sort?by[sort.key]:undefined;
  const rows=!sort||!get?items:[...items].sort((a,b)=>{
    const x=get(a),y=get(b),xe=x===undefined||x===null||x==='',ye=y===undefined||y===null||y==='';
    if(xe||ye)return xe&&ye?0:xe?1:-1;
    return (typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x),String(y)))*sort.dir;
  });
  return {rows,sort,onSort};
}
export const ACTIONS:Column={label:<span className="sr-only">Actions</span>,width:96};
export const RowActions=({children}:{children:ReactNode})=><div className="ui-row-actions">{children}</div>;
export const IconAction=({icon,label,onClick,disabled}:{icon:string;label:string;onClick:()=>void;disabled?:boolean})=>
  <button type="button" className="icon-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon name={icon} size={16}/></button>;
// Long lists: 100 rows, then 100 more at a time.
export function usePaged<T>(items:T[],key:string,size=100) {
  const [shown,setShown]=useState(size);
  useEffect(()=>setShown(size),[key]);
  const more=items.length>shown?<div className="ui-more"><button type="button" onClick={()=>setShown(s=>s+size)}>Show {Math.min(size,items.length-shown)} more</button></div>:undefined;
  return {rows:items.slice(0,shown),more};
}
export const matches=(query:string,...fields:(string|number|undefined)[])=>{const q=query.trim().toLocaleLowerCase();return !q||fields.some(f=>f!==undefined&&String(f).toLocaleLowerCase().includes(q));};

// ---- Loading ----

export function Loaded<T>({view,children}:{view:{data?:T;error?:Error;reload:()=>void};children:(data:T)=>ReactNode}) {
  if(view.error&&!view.data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(view.data===undefined)return <Loading/>;
  return <>{children(view.data)}</>;
}
// Re-reads a view every 10 s while the page is visible.
export function useRefresh(reload:()=>void,ms=10000) {useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)reload();},ms);return()=>clearInterval(t);},[]);}

// ---- Fields and saving ----

export function Field({label,hint,children}:{label:ReactNode;hint?:ReactNode;children:ReactNode}) {
  return <div className="ui-field"><div className="ui-field-label">{label}{hint&&<small>{hint}</small>}</div><div className="ui-field-control">{children}</div></div>;
}
export const FieldError=({children}:{children?:ReactNode})=>children?<span className="ui-field-error">{children}</span>:null;
// A panel footer with Save and Cancel, shown once something changed. A save that started from an old version says so.
export function SaveBar({dirty,busy,error,onCancel,onReload,invalid,label='Save'}:{dirty:boolean;busy:boolean;error?:unknown;onCancel:()=>void;onReload?:()=>void;invalid?:boolean;label?:string}) {
  const conflict=error instanceof ApiClientError&&error.code==='REVISION_CONFLICT';
  if(!dirty&&!error)return null;
  return <div className="ui-panel-foot">
    <span className="ui-foot-note">{conflict?<span className="danger-text">Someone saved this first.</span>:error?<span className="danger-text">{(error as Error).message}</span>:invalid?'Fix the marked fields to save.':'Unsaved changes'}</span>
    {conflict&&onReload&&<button type="button" onClick={onReload}>Reload</button>}
    {dirty&&<><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary" disabled={busy||invalid}>{busy?'Saving…':label}</button></>}
  </div>;
}
export function useSave(after:()=>void) {
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
  return {busy,error,clear:()=>setError(undefined),run:async(action:()=>Promise<unknown>)=>{
    if(busy)return false;setBusy(true);setError(undefined);
    try{await action();after();return true;}catch(e){setError(e);return false;}finally{setBusy(false);}
  }};
}
