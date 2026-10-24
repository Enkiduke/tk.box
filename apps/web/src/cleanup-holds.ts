import {api} from './api.js';
import {fetchCached,invalidate} from './hooks.js';
import {announce} from './media-actions.js';
import type {MenuEntry} from './components.js';

// Admins keep a Leaving Soon title longer from its right-click menu, anywhere it shows: the same holds as
// Clean Up › Status. The titles come from the last clean up run, by their Plex item.
const PATH='/admin/cleanup/titles';
type Held={key:string;title:string;status:string;holdable?:boolean;rating_key?:string|null;held_until?:string|null;deletion_date:string|null};
export type HoldAction={action:'reset'}|{action:'extend';days:number}|{action:'clear'};
let leaving=new Map<string,Held>();

export function loadLeaving() {
  return fetchCached<{items:Held[]}>(PATH).then(view=>{leaving=new Map(view.items.filter(i=>i.status==='leaving'&&i.holdable&&i.key&&i.rating_key).map(i=>[i.rating_key!,i]));},()=>{});
}
export async function holdTitle(item:{key:string;title:string},body:HoldAction) {
  try {
    const view=await api<{items:Held[]}>('/admin/cleanup/holds','POST',{key:item.key,...body}),now=view.items.find(i=>i.key===item.key),until=now?.held_until??now?.deletion_date;
    announce(body.action==='clear'?`${item.title}: back to its rule’s date`:`${item.title}: kept until ${until?new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(Date.parse(until)):'later'}`);
  } catch(error) {announce(`${item.title}: ${(error as Error).message}`,true);}
  invalidate(PATH);void loadLeaving();
}
export const holdEntries=(item:{key:string;title:string;held_until?:string|null}):MenuEntry[]=>[
  ...[7,14,30].map(days=>({label:`Keep ${days} days longer`,icon:'clock',run:()=>void holdTitle(item,{action:'extend',days})})),
  {label:'Start the clock over',icon:'restart',run:()=>void holdTitle(item,{action:'reset'})},
  ...(item.held_until?[{label:'Remove the hold',icon:'close',run:()=>void holdTitle(item,{action:'clear'})}]:[]),
];
// For a catalog title's menu: entries only while the last run found it leaving soon.
export const leavingEntries=(ratingKey:string)=>{const item=leaving.get(ratingKey);return item?holdEntries(item):[];};
