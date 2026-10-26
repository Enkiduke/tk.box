import {useSyncExternalStore} from 'react';
import type {ExploreSource} from '../../../packages/contracts/src/index.js';

// Which of the rows the administrator allows this viewer leaves out of Explore. Per browser, like the Home settings;
// only what is switched off is kept, so a source or row the administrator adds later shows until it is switched off.
export type ExplorePrefs={hidden:ExploreSource[];hiddenRows:string[]};
export const defaultExplorePrefs:ExplorePrefs={hidden:[],hiddenRows:[]};

export function parseExplorePrefs(raw:string|null):ExplorePrefs {
  let value:Partial<Record<keyof ExplorePrefs,unknown>>={};
  try{const parsed=raw?JSON.parse(raw):{};if(parsed&&typeof parsed==='object')value=parsed;}catch{/* fall back to defaults */}
  const hidden=Array.isArray(value.hidden)?value.hidden.filter((s):s is ExploreSource=>s==='plex'||s==='seerr'):[];
  const hiddenRows=Array.isArray(value.hiddenRows)?value.hiddenRows.filter((r):r is string=>typeof r==='string'&&/^(plex|seerr):\S+$/.test(r)&&r.length<=820).slice(0,300):[];
  return {hidden:[...new Set(hidden)],hiddenRows:[...new Set(hiddenRows)]};
}
export const rowKey=(source:ExploreSource,row:string)=>`${source}:${row}`;

const key='tk.box.explore.prefs',listeners=new Set<()=>void>();
let current:ExplorePrefs|undefined;
const load=()=>{try{return parseExplorePrefs(localStorage.getItem(key));}catch{return defaultExplorePrefs;}};
export const getExplorePrefs=()=>current??=load();
export function setExplorePrefs(next:ExplorePrefs) {
  current=next;
  try{localStorage.setItem(key,JSON.stringify(next));}catch{/* storage unavailable; applies until reload */}
  for(const listener of listeners)listener();
}
export function showExploreSource(source:ExploreSource,on:boolean) {
  const p=getExplorePrefs();setExplorePrefs({...p,hidden:on?p.hidden.filter(s=>s!==source):[...p.hidden.filter(s=>s!==source),source]});
}
export function showExploreRows(keys:string[],on:boolean) {
  const p=getExplorePrefs(),rest=p.hiddenRows.filter(r=>!keys.includes(r));setExplorePrefs({...p,hiddenRows:on?rest:[...rest,...keys]});
}
function subscribe(listener:()=>void) {
  const onStorage=(e:StorageEvent)=>{if(e.key===key){current=undefined;listener();}};
  listeners.add(listener);window.addEventListener('storage',onStorage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',onStorage);};
}
export const useExplorePrefs=()=>useSyncExternalStore(subscribe,getExplorePrefs);
