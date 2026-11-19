import {useEffect,useSyncExternalStore} from 'react';
import {RATINGS_BATCH,type ExternalRating} from '../../../packages/contracts/src/explore.js';
import type {ExploreItem} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {onInvalidate} from './hooks.js';

// The scores an Explore card's row left out. Cards that come into view together share one /explore/ratings/batch
// request instead of one each; answers are kept until Explore is refreshed or the account changes.
const known=new Map<string,ExternalRating[]>(),asked=new Set<string>(),queued=new Set<string>(),listeners=new Set<()=>void>();
let generation=0,timer:ReturnType<typeof setTimeout>|undefined;
const notify=()=>{for(const listener of listeners)listener();};
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
onInvalidate(prefix=>{
  if(!'/explore/ratings'.startsWith(prefix))return;
  generation++;known.clear();asked.clear();queued.clear();clearTimeout(timer);timer=undefined;notify();
});

// `kind:plex:tmdb`, as the server reads it; a title it would refuse gets no key, so it never fails a whole batch.
export function ratingKey(item:Pick<ExploreItem,'kind'|'ids'>):string|undefined {
  const plex=item.ids.plex??'',tmdb=item.ids.tmdb?String(item.ids.tmdb):'';
  if(plex&&!/^[\w-]{1,64}$/.test(plex))return undefined;
  if(tmdb&&!/^[1-9]\d{0,9}$/.test(tmdb))return undefined;
  return plex||tmdb?`${item.kind}:${plex}:${tmdb}`:undefined;
}
// Groups the keys asked for in one moment into requests of at most RATINGS_BATCH titles.
export function ratingBatches(keys:string[]):string[] {
  const paths:string[]=[];
  for(let i=0;i<keys.length;i+=RATINGS_BATCH){const query=new URLSearchParams();for(const key of keys.slice(i,i+RATINGS_BATCH))query.append('t',key);paths.push(`/explore/ratings/batch?${query}`);}
  return paths;
}
function flush() {
  timer=undefined;
  const keys=[...queued],started=generation;queued.clear();
  ratingBatches(keys).forEach((path,i)=>{
    const part=keys.slice(i*RATINGS_BATCH,(i+1)*RATINGS_BATCH);
    void api<{ratings:Record<string,ExternalRating[]>}>(path).then(({ratings})=>{
      if(started!==generation)return;
      for(const key of part)known.set(key,ratings[key]??[]);
      notify();
    },()=>{if(started===generation)for(const key of part)asked.delete(key);});
  });
}
// `wanted`: the card is on screen and its row didn't already carry every score.
export function useCardRatings(item:Pick<ExploreItem,'kind'|'ids'>,wanted:boolean):ExternalRating[]|undefined {
  const key=ratingKey(item),current=useSyncExternalStore(subscribe,()=>generation);
  useEffect(()=>{
    if(!wanted||!key||asked.has(key))return;
    asked.add(key);queued.add(key);timer??=setTimeout(flush,50);
  },[wanted,key,current]);
  return useSyncExternalStore(subscribe,()=>key?known.get(key):undefined);
}
