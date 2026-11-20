import {useSyncExternalStore} from 'react';
// Which of the rows the administrator allows this viewer leaves out of Explore (by row key, `tmdb:…` or `plex:…`).
// Per browser, like the Home settings; only what is switched off is kept, so a row the administrator adds later shows
// until it is switched off. `selections`: each streaming row's chosen service, by row key.
export type ExplorePrefs={hiddenRows:string[];region:string;providers?:number[];selections:Record<string,number|'all'>};
export const defaultExplorePrefs:ExplorePrefs={hiddenRows:[],region:'US',selections:{}};
const validProvider=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=9999999999;

export function parseExplorePrefs(raw:string|null):ExplorePrefs {
  let value:Partial<Record<keyof ExplorePrefs|'hidden',unknown>>={};
  try{const parsed=raw?JSON.parse(raw):{};if(parsed&&typeof parsed==='object')value=parsed;}catch{/* fall back to defaults */}
  // A source switched off before Explore had one row order: each of its rows hidden is the same choice, so it stays
  // only as rows (`plex:*` and `tmdb:*` are read by Explore as every row of that source).
  const sources=Array.isArray(value.hidden)?value.hidden.filter((s):s is string=>s==='plex'||s==='tmdb').map(s=>`${s}:*`):[];
  const hiddenRows=[...sources,...(Array.isArray(value.hiddenRows)?value.hiddenRows.filter((r):r is string=>typeof r==='string'&&/^(plex|tmdb):\S+$/.test(r)&&r.length<=820).slice(0,300):[])];
  const region=typeof value.region==='string'&&/^[A-Z]{2}$/.test(value.region)?value.region:'US';
  const providers=Array.isArray(value.providers)?[...new Set(value.providers.filter(validProvider))].slice(0,12):undefined;
  const selections:ExplorePrefs['selections']={};
  if(value.selections&&typeof value.selections==='object')for(const [row,selection] of Object.entries(value.selections as Record<string,unknown>)){
    if(/^tmdb:\S{1,60}$/.test(row)&&(selection==='all'||validProvider(selection)))selections[row]=selection;
  }
  return {hiddenRows:[...new Set(hiddenRows)],region,providers,selections};
}
// Whether the viewer switched a row off (itself, or its whole source before rows had one order).
export const rowHidden=(prefs:ExplorePrefs,key:string)=>prefs.hiddenRows.includes(key)||prefs.hiddenRows.includes(`${key.slice(0,4)}:*`);

const key='tk.box.explore.prefs',listeners=new Set<()=>void>();
let current:ExplorePrefs|undefined;
const load=()=>{try{return parseExplorePrefs(localStorage.getItem(key));}catch{return defaultExplorePrefs;}};
export const getExplorePrefs=()=>current??=load();
// Each row's chosen streaming service lasts only while Explore is open, so it is never saved.
export function setExplorePrefs(next:ExplorePrefs) {
  current=next;
  try{localStorage.setItem(key,JSON.stringify({...next,selections:{}}));}catch{/* storage unavailable; applies until reload */}
  for(const listener of listeners)listener();
}
export function clearStreamingSelections() {
  const p=getExplorePrefs();if(Object.keys(p.selections).length)setExplorePrefs({...p,selections:{}});
}
// Switching a row on also lets go of its old whole-source switch, putting that source's other rows in as hidden ones.
export function showExploreRows(keys:string[],on:boolean,all:string[]=[]) {
  const p=getExplorePrefs();
  const whole=p.hiddenRows.filter(r=>r.endsWith(':*')&&keys.some(k=>k.startsWith(r.slice(0,5))));
  const expanded=on&&whole.length?all.filter(k=>whole.some(w=>k.startsWith(w.slice(0,5)))):[];
  const rest=[...p.hiddenRows.filter(r=>!(on&&whole.includes(r))),...expanded].filter(r=>!keys.includes(r));
  setExplorePrefs({...p,hiddenRows:on?[...new Set(rest)]:[...new Set([...rest,...keys])]});
}
export function selectStreamingService(row:string,provider:number|'all') {
  const p=getExplorePrefs();setExplorePrefs({...p,selections:{...p.selections,[row]:provider}});
}
export function setStreamingRegion(region:string) {
  const p=getExplorePrefs();setExplorePrefs({...p,region,providers:undefined,selections:{}});
}
export function setStreamingProviders(providers:number[]|undefined) {
  const p=getExplorePrefs(),selections={...p.selections};
  for(const row of Object.keys(selections))if(providers&&!providers.includes(Number(selections[row])))selections[row]='all';
  setExplorePrefs({...p,providers,selections});
}
function subscribe(listener:()=>void) {
  const onStorage=(e:StorageEvent)=>{if(e.key===key){current=undefined;listener();}};
  listeners.add(listener);window.addEventListener('storage',onStorage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',onStorage);};
}
export const useExplorePrefs=()=>useSyncExternalStore(subscribe,getExplorePrefs);
