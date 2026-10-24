import {api} from './api.js';
import {fetchCached,invalidate} from './hooks.js';
import {announce} from './media-actions.js';
import type {CatalogItem} from '../../../packages/contracts/src/index.js';
import type {MenuEntry} from './components.js';

// Admins start a Leaving Soon title's clock over from its right-click menu, anywhere it shows: the same holds as
// Clean Up › Status. The titles come from the last clean up run, found by their Plex item (or, from a run before
// Plex items were recorded, by TMDB id). TV is cleaned up season by season, so a show or episode offers its seasons.
const PATH='/admin/cleanup/titles';
type Held={key:string;title:string;kind:string;status:string;holdable?:boolean;rating_key?:string|null;show_rating_key?:string|null;held_until?:string|null;deletion_date:string|null};
export type HoldAction={action:'reset'}|{action:'clear'};
let byItem=new Map<string,Held>(),byShow=new Map<string,Held[]>(),byKey=new Map<string,Held>();

export function loadLeaving() {
  return fetchCached<{items:Held[]}>(PATH).then(view=>{
    // Leaving soon, or kept past the window by a hold that can still be removed.
    const leaving=view.items.filter(i=>i.holdable&&i.key&&(i.status==='leaving'||i.held_until));
    byItem=new Map(leaving.filter(i=>i.rating_key).map(i=>[i.rating_key!,i]));
    byKey=new Map(leaving.map(i=>[i.key,i]));
    byShow=new Map();
    for(const i of leaving)if(i.show_rating_key)byShow.set(i.show_rating_key,[...byShow.get(i.show_rating_key)??[],i]);
  },()=>{});
}
export async function holdTitle(item:{key:string;title:string},body:HoldAction) {
  try {
    const view=await api<{items:Held[]}>('/admin/cleanup/holds','POST',{key:item.key,...body}),now=view.items.find(i=>i.key===item.key),until=now?.held_until??now?.deletion_date;
    announce(body.action==='clear'?`${item.title}: back to its rule’s date`:`${item.title}: kept until ${until?new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(Date.parse(until)):'later'}`);
  } catch(error) {announce(`${item.title}: ${(error as Error).message}`,true);}
  invalidate(PATH);void loadLeaving();
}
// `prefix` names the season when the menu is a show's or an episode's.
export const holdEntries=(item:{key:string;title:string},prefix=''):MenuEntry[]=>
  [{label:prefix?`${prefix}: start the clock over`:'Start the clock over',icon:'restart',run:()=>void holdTitle(item,{action:'reset'})}];
const seasonName=(held:Held)=>held.title.split(' - ').at(-1)??held.title;
// For a catalog title's menu: entries only while the last run found it (or, for a show or episode, its season)
// leaving soon or held.
export function leavingEntries(item:CatalogItem):MenuEntry[] {
  const own=byItem.get(item.id)??(item.tmdbId&&(item.type==='movie'||item.type==='show')?byKey.get(`${item.type==='movie'?'movie':'tv'}:${item.tmdbId}`):undefined);
  if(own)return holdEntries(own);
  const season=item.type==='episode'&&item.parentId?byItem.get(item.parentId):undefined;
  if(season)return holdEntries(season,seasonName(season));
  const show=item.type==='show'?item.id:item.type==='episode'?item.showId:undefined,seasons=show?byShow.get(show)??[]:[];
  return seasons.flatMap(s=>holdEntries(s,seasonName(s)));
}
