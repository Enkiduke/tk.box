import {useEffect,useRef,useState} from 'react';
import {api,ApiClientError} from './api.js';

// Small stale-while-revalidate cache for GET responses. Revisiting a page renders
// instantly from memory, identical concurrent requests share one fetch, and
// mutations invalidate the prefixes they affect.
// Catalog reads stay fresh longer: the server's library events and every watch-state change invalidate them anyway.
const FRESH_MS=30000,CATALOG_FRESH_MS=180000,MAX_ENTRIES=150;
const freshFor=(path:string)=>path.startsWith('/catalog/')?CATALOG_FRESH_MS:FRESH_MS;
const cache=new Map<string,{data:unknown;time:number}>(),inflight=new Map<string,Promise<unknown>>();
// The signed-in viewer and their catalog reads are kept in this browser, so a reload or a new tab draws the last
// pages at once and refreshes them in the background. Sign-out, an expired session or another account clears it.
const STORE_KEY='tk.box.api',STORE_MAX_CHARS=1500000;
const persisted=(path:string)=>path==='/me'||path==='/setup'||path==='/libraries'||path.startsWith('/catalog/');
let saveTimer:ReturnType<typeof setTimeout>|undefined;
const storedAt=new Map<string,number>();
function forgetStored() {clearTimeout(saveTimer);saveTimer=undefined;try{localStorage.removeItem(STORE_KEY);}catch{/* storage unavailable */}}
function scheduleSave() {
  if(saveTimer)return;
  saveTimer=setTimeout(()=>{
    saveTimer=undefined;if(!cache.has('/me'))return;
    // Newest first, until the size budget is spent.
    const entries:[string,unknown,number][]=[];let size=0;
    for(const [path,{data,time}] of [...cache].reverse()){if(!persisted(path))continue;const length=JSON.stringify(data).length+path.length;if(size+length>STORE_MAX_CHARS)continue;size+=length;entries.push([path,data,time||storedAt.get(path)||Date.now()]);}
    try{localStorage.setItem(STORE_KEY,JSON.stringify(entries.reverse()));}catch{/* full or unavailable */}
  },1000);
}
try {
  const stored=JSON.parse(localStorage.getItem(STORE_KEY)??'[]') as [string,unknown,number][];
  // Kept pages show at once but always count as stale, so each is read again; a week-old copy isn't worth showing.
  if(Array.isArray(stored))for(const [path,data,time] of stored)if(typeof path==='string'&&persisted(path)&&typeof time==='number'&&Date.now()-time<7*86400000){cache.set(path,{data,time:0});storedAt.set(path,time);}
} catch {forgetStored();}
const accountOf=(data:unknown)=>(data as {accountId?:string}|undefined)?.accountId;
// Mounted views reading an invalidated path refetch, keeping their current data on screen meanwhile.
const watchers=new Set<(prefix:string)=>void>();
export function invalidate(prefix='') {if(!prefix)forgetStored();for(const key of [...cache.keys()])if(key.startsWith(prefix))cache.delete(key);if(prefix)scheduleSave();for(const watcher of watchers)watcher(prefix);}
export const useInvalidation=(paths:(string|undefined)[],refresh:()=>void,key:string)=>useEffect(()=>{const watcher=(prefix:string)=>{if(paths.some(p=>p?.startsWith(prefix)))refresh();};watchers.add(watcher);return()=>{watchers.delete(watcher);};},[key]);
export function fetchCached<T>(path:string):Promise<T> {
  let pending=inflight.get(path);
  if(!pending){
    pending=api<T>(path).then(data=>{
      // Another account signed in: nothing kept for the previous one may show.
      const previous=path==='/me'?accountOf(cache.get('/me')?.data):undefined,switched=previous!==undefined&&previous!==accountOf(data);
      if(switched){forgetStored();for(const key of [...cache.keys()])if(key!=='/me')cache.delete(key);}
      cache.delete(path);cache.set(path,{data,time:Date.now()});while(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value!);
      if(persisted(path))scheduleSave();
      if(switched)for(const watcher of watchers){watcher('/catalog');watcher('/libraries');}
      return data;
    },error=>{if(error instanceof ApiClientError&&error.status===401){forgetStored();for(const key of [...cache.keys()])if(persisted(key)&&key!=='/setup')cache.delete(key);}throw error;}).finally(()=>inflight.delete(path));
    inflight.set(path,pending);
  }
  return pending as Promise<T>;
}
// A title some cached list already holds, so its details can draw at once while the full record loads.
export function cachedListItem<T extends {id:string}>(id:string):T|undefined {
  for(const {data} of cache.values()){const items=(data as {items?:unknown}|undefined)?.items;if(!Array.isArray(items))continue;const hit=items.find(item=>(item as T|undefined)?.id===id);if(hit)return hit as T;}
  return undefined;
}
type Result<T>={path?:string;data?:T;error?:ApiClientError;loading:boolean};
const cached=<T,>(path:string|undefined):Result<T>|undefined=>{const hit=path?cache.get(path):undefined;return hit&&{path,data:hit.data as T,loading:false};};

export function useApi<T>(path:string|undefined) {
  const [version,setVersion]=useState(0),forced=useRef(false);
  const [result,setResult]=useState<Result<T>>(()=>cached<T>(path)??{loading:!!path});
  useEffect(()=>{
    if(!path){setResult({loading:false});return;}
    const hit=cache.get(path),force=forced.current;forced.current=false;
    if(hit&&!force&&Date.now()-hit.time<freshFor(path)){setResult({path,data:hit.data as T,loading:false});return;}
    if(force)cache.delete(path);
    let live=true;
    setResult(previous=>({path,data:(hit?.data as T|undefined)??(previous.path===path?previous.data:undefined),loading:true}));
    fetchCached<T>(path).then(data=>{if(live)setResult({path,data,loading:false});}).catch(error=>{if(live)setResult(previous=>({path,data:previous.path===path?previous.data:undefined,error,loading:false}));});
    return()=>{live=false;};
  },[path,version]);
  useInvalidation([path],()=>setVersion(v=>v+1),path??'');
  const current=result.path===path?result:cached<T>(path)??{loading:!!path};
  return {...current,reload:()=>{forced.current=true;setVersion(v=>v+1);}};
}
// Several cached GETs at once (for rows that merge every library). Failed paths yield undefined.
export function useApiAll<T>(paths:string[]) {
  const key=paths.join('\n'),read=()=>paths.map(p=>cache.get(p)?.data as T|undefined);
  const [state,setState]=useState(()=>({key,data:read(),loading:paths.some(p=>!cache.has(p))})),[version,setVersion]=useState(0);
  useInvalidation(paths,()=>setVersion(v=>v+1),key);
  useEffect(()=>{
    const stale=paths.filter(p=>{const hit=cache.get(p);return !hit||Date.now()-hit.time>=freshFor(p);});
    if(!stale.length){setState({key,data:read(),loading:false});return;}
    let live=true;setState(previous=>({key,data:previous.key===key?paths.map((p,i)=>cache.get(p)?.data as T|undefined??previous.data[i]):read(),loading:true}));
    void Promise.allSettled(paths.map(p=>fetchCached<T>(p))).then(results=>{if(live)setState({key,data:results.map(r=>r.status==='fulfilled'?r.value:undefined),loading:false});});
    return()=>{live=false;};
  },[key,version]);
  return state.key===key?state:{key,data:read(),loading:true};
}
// An offset/limit list read as one growing list: each page is its own cached GET, and the
// next page loads when the sentinel nears the viewport. A new `key` starts over from page one.
export function useInfinitePages<T extends {hasMore:boolean}>(path:(offset:number)=>string,limit:number,key:string) {
  const [state,setState]=useState({key,count:1}),count=state.key===key?state.count:1;
  const pages=useApiAll<T>(Array.from({length:count},(_,i)=>path(i*limit)));
  const sentinel=useRef<HTMLDivElement>(null),more=!!pages.data[count-1]?.hasMore&&!pages.loading;
  useEffect(()=>{
    const element=sentinel.current;if(!element||!more||!('IntersectionObserver' in window))return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))setState({key,count:count+1});},{rootMargin:'600px'});
    observer.observe(element);return()=>observer.disconnect();
  },[more,count,key]);
  return {pages:pages.data,loading:pages.loading,more,sentinel,loadMore:()=>setState({key,count:count+1})};
}
export function useRoute() {
  const [hash,setHash]=useState(()=>window.location.hash.slice(1)||'home');
  useEffect(()=>{const changed=()=>setHash(window.location.hash.slice(1)||'home');window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  const [page,query='']=hash.split('?');return {page:page??'home',params:new URLSearchParams(query)};
}
export function link(page:string,params:Record<string,string|number|undefined>={}) {const query=new URLSearchParams();for(const [key,value] of Object.entries(params))if(value!==undefined&&value!=='')query.set(key,String(value));return `#${page}${query.size?'?'+query:''}`;}
// Updates the hash without adding a history entry (live search, filters while typing).
export function replaceRoute(hash:string) {if(window.location.hash===hash)return;history.replaceState(null,'',hash);window.dispatchEvent(new HashChangeEvent('hashchange'));}
export function useDebounced<T>(value:T,delay=300) {
  const [settled,setSettled]=useState(value);
  useEffect(()=>{const timer=setTimeout(()=>setSettled(value),delay);return()=>clearTimeout(timer);},[value,delay]);
  return settled;
}
export function useScrolled(threshold=8) {
  const [scrolled,setScrolled]=useState(()=>window.scrollY>threshold);
  useEffect(()=>{const check=()=>setScrolled(window.scrollY>threshold);window.addEventListener('scroll',check,{passive:true});check();return()=>window.removeEventListener('scroll',check);},[threshold]);
  return scrolled;
}
// Mounts expensive content (and its requests) only when it approaches the viewport.
export function useNearViewport<E extends Element>(margin='600px') {
  const ref=useRef<E>(null),[near,setNear]=useState(false);
  useEffect(()=>{
    const element=ref.current;if(!element||near)return;
    if(!('IntersectionObserver' in window)){setNear(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setNear(true);observer.disconnect();}},{rootMargin:margin});
    observer.observe(element);return()=>observer.disconnect();
  },[near,margin]);
  return [ref,near] as const;
}
export const duration=(ms:number|undefined)=>ms===undefined?'':`${Math.floor(ms/3600000)?Math.floor(ms/3600000)+'h ':''}${Math.max(1,Math.floor(ms/60000)%60)}m`;
export const clock=(ms:number)=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(ms);
export const timecode=(seconds:number)=>{if(!Number.isFinite(seconds)||seconds<0)return '0:00';const s=Math.floor(seconds),h=Math.floor(s/3600),m=Math.floor(s/60)%60,r=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${r}`:`${m}:${r}`;};
