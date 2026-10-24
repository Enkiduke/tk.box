import {useMemo,useSyncExternalStore} from 'react';
import type {CatalogItem} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {invalidate} from './hooks.js';

export type WatchAction='watched'|'unwatched'|'removeContinue';
type Override=Partial<Pick<CatalogItem,'watched'|'viewOffsetMs'|'watchedEpisodeCount'>>&{continueHidden?:boolean};
type Notice={id:number;text:string;error?:boolean};

// Optimistic watch-state patches, so every card showing a title updates at once. They last
// until the next catalog refresh after playback, when Plex's own state is current again.
let overrides=new Map<string,Override>(),notice:Notice|undefined,noticeTimer=0,noticeId=0;
const listeners=new Set<()=>void>(),emit=()=>{for(const listener of listeners)listener();};
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const patch=(id:string,value:Override|undefined)=>{const next=new Map(overrides);if(value)next.set(id,value);else next.delete(id);overrides=next;emit();};
export const useOverrides=()=>useSyncExternalStore(subscribe,()=>overrides);
export function useWithOverride<T extends CatalogItem|undefined>(item:T):T {
  const value=useSyncExternalStore(subscribe,()=>item&&overrides.get(item.id));
  return useMemo(()=>item&&value?{...item,...value}:item,[item,value]);
}
export const useNotice=()=>useSyncExternalStore(subscribe,()=>notice);
export function announce(text:string,error=false) {
  clearTimeout(noticeTimer);notice={id:++noticeId,text,error};emit();
  noticeTimer=window.setTimeout(()=>{notice=undefined;emit();},error?6000:3500);
}
export function refreshCatalog() {overrides=new Map();emit();invalidate('/catalog');}

const grouped=(item:CatalogItem)=>item.type==='show'||item.type==='season';
export const fullyWatched=(item:CatalogItem)=>grouped(item)&&item.episodeCount!==undefined?(item.watchedEpisodeCount??0)>=item.episodeCount:item.watched;
export const partlyWatched=(item:CatalogItem)=>item.viewOffsetMs>0||(grouped(item)&&item.episodeCount!==undefined?(item.watchedEpisodeCount??0)>0:item.watched);
const label=(item:CatalogItem)=>item.type==='episode'?`${item.showTitle??item.title} S${item.seasonNumber??'?'}:E${item.episodeNumber??'?'}`:item.type==='season'&&item.showTitle?`${item.showTitle} ${item.title}`:item.title;
function optimistic(item:CatalogItem,action:WatchAction):Override {
  if(action==='removeContinue')return {continueHidden:true};
  const counts=item.episodeCount!==undefined?{watchedEpisodeCount:action==='watched'?item.episodeCount:0}:{};
  // A watched title leaves Continue Watching; Plex may then offer the next episode instead.
  return action==='watched'?{watched:true,viewOffsetMs:0,continueHidden:true,...counts}:{watched:false,viewOffsetMs:0,...counts};
}
const done={watched:'Marked as watched',unwatched:'Marked as unwatched',removeContinue:'Removed from Home'};
export async function updateWatchState(item:CatalogItem,action:WatchAction) {
  const before=overrides.get(item.id),value={...before,...optimistic(item,action)};
  patch(item.id,value);
  try {await api(`/catalog/items/${item.id}/state`,'POST',{action});}
  catch(error) {patch(item.id,before);announce(`${label(item)}: ${(error as Error).message}`,true);return;}
  // Refetch every visible list (counts, next episodes); the patch now matches Plex.
  invalidate('/catalog');
  announce(`${done[action]}: ${label(item)}`);
}
