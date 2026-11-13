import {useSyncExternalStore} from 'react';
import {exploreBrowseSources,streamingRows,type ExploreBrowseSource,type StreamingRow} from '../../../packages/contracts/src/index.js';

// Which of the rows the administrator allows this viewer leaves out of Explore. Per browser, like the Home settings;
// only what is switched off is kept, so a source or row the administrator adds later shows until it is switched off.
export type ExplorePrefs={hidden:ExploreBrowseSource[];hiddenRows:string[];region:string;providers?:number[];selections:Partial<Record<StreamingRow,number|'all'>>};
export const defaultExplorePrefs:ExplorePrefs={hidden:[],hiddenRows:[],region:'US',selections:{}};
const validProvider=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=9999999999;

export function parseExplorePrefs(raw:string|null):ExplorePrefs {
  let value:Partial<Record<keyof ExplorePrefs,unknown>>={};
  try{const parsed=raw?JSON.parse(raw):{};if(parsed&&typeof parsed==='object')value=parsed;}catch{/* fall back to defaults */}
  const hidden=Array.isArray(value.hidden)?exploreBrowseSources.filter(s=>(value.hidden as unknown[]).includes(s)):[];
  const hiddenRows=Array.isArray(value.hiddenRows)?value.hiddenRows.filter((r):r is string=>typeof r==='string'&&/^(plex|tmdb):\S+$/.test(r)&&r.length<=820).slice(0,300):[];
  const region=typeof value.region==='string'&&/^[A-Z]{2}$/.test(value.region)?value.region:'US';
  const providers=Array.isArray(value.providers)?[...new Set(value.providers.filter(validProvider))].slice(0,12):undefined;
  const selections:ExplorePrefs['selections']={};
  if(value.selections&&typeof value.selections==='object')for(const row of streamingRows){
    const selection=(value.selections as Record<string,unknown>)[row];
    if(selection==='all'||validProvider(selection))selections[row]=selection;
  }
  return {hidden:[...new Set(hidden)],hiddenRows:[...new Set(hiddenRows)],region,providers,selections};
}
export const rowKey=(source:ExploreBrowseSource,row:string)=>`${source}:${row}`;

const key='tk.box.explore.prefs',listeners=new Set<()=>void>();
let current:ExplorePrefs|undefined;
const load=()=>{try{return parseExplorePrefs(localStorage.getItem(key));}catch{return defaultExplorePrefs;}};
export const getExplorePrefs=()=>current??=load();
export function setExplorePrefs(next:ExplorePrefs) {
  current=next;
  try{localStorage.setItem(key,JSON.stringify(next));}catch{/* storage unavailable; applies until reload */}
  for(const listener of listeners)listener();
}
export function showExploreSource(source:ExploreBrowseSource,on:boolean) {
  const p=getExplorePrefs();setExplorePrefs({...p,hidden:on?p.hidden.filter(s=>s!==source):[...p.hidden.filter(s=>s!==source),source]});
}
export function showExploreRows(keys:string[],on:boolean) {
  const p=getExplorePrefs(),rest=p.hiddenRows.filter(r=>!keys.includes(r));setExplorePrefs({...p,hiddenRows:on?rest:[...rest,...keys]});
}
export function selectStreamingService(row:StreamingRow,provider:number|'all') {
  const p=getExplorePrefs();setExplorePrefs({...p,selections:{...p.selections,[row]:provider}});
}
export function setStreamingRegion(region:string) {
  const p=getExplorePrefs();setExplorePrefs({...p,region,providers:undefined,selections:{}});
}
export function setStreamingProviders(providers:number[]|undefined) {
  const p=getExplorePrefs(),selections={...p.selections};
  for(const row of streamingRows)if(providers&&!providers.includes(Number(selections[row])))selections[row]='all';
  setExplorePrefs({...p,providers,selections});
}
function subscribe(listener:()=>void) {
  const onStorage=(e:StorageEvent)=>{if(e.key===key){current=undefined;listener();}};
  listeners.add(listener);window.addEventListener('storage',onStorage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',onStorage);};
}
export const useExplorePrefs=()=>useSyncExternalStore(subscribe,getExplorePrefs);
