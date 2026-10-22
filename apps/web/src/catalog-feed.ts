import {useCallback,useEffect,useRef,useState} from 'react';
import type {CatalogPage} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useInvalidation} from './hooks.js';
import {CATALOG_PAGE_SIZE} from './catalog-window.js';

type Feed={path?:string;abort:AbortController;pages:Map<number,CatalogPage>;pending:Set<number>;errors:Map<number,Error>;total?:number;end:number;protected:Set<number>};
const fresh=(path?:string):Feed=>({path,abort:new AbortController(),pages:new Map(),pending:new Set(),errors:new Map(),end:0,protected:new Set()});
export function useCatalogFeed(path:string|undefined) {
  const current=useRef<Feed>(fresh()),[,render]=useState(0);
  const address=(offset:number)=>`${path}${path?.includes('?')?'&':'?'}offset=${offset}&limit=${CATALOG_PAGE_SIZE}`;
  const load=useCallback((offset:number,retry=false)=>{
    const feed=current.current;
    if(!path||feed.path!==path||feed.abort.signal.aborted||feed.pages.has(offset)||feed.pending.has(offset)||feed.pending.size>=4||(!retry&&feed.errors.has(offset)))return;
    if(feed.total!==undefined&&offset>=feed.total)return;
    feed.errors.delete(offset);feed.pending.add(offset);render(n=>n+1);
    void api<CatalogPage>(address(offset),'GET',undefined,feed.abort.signal).then(page=>{
      if(current.current!==feed||feed.abort.signal.aborted)return;
      feed.pages.set(offset,page);feed.end=Math.max(feed.end,offset+page.items.length);
      if(page.total!==undefined)feed.total=page.total;
      else if(!page.hasMore)feed.total=offset+page.items.length;
      // A large library keeps only a bounded metadata window in memory.
      while(feed.pages.size>12){const old=[...feed.pages.keys()].find(key=>!feed.protected.has(key));if(old===undefined)break;feed.pages.delete(old);}
    }).catch(error=>{if(current.current===feed&&!feed.abort.signal.aborted)feed.errors.set(offset,error as Error);}).finally(()=>{
      feed.pending.delete(offset);if(current.current===feed&&!feed.abort.signal.aborted)render(n=>n+1);
    });
  },[path]);
  // When the catalog changes (an artwork job finished), the pages on hand are read again in place, so the grid keeps its
  // scroll position and changed posters swap in.
  useInvalidation([path],()=>{
    const feed=current.current;if(!path||feed.path!==path)return;
    for(const offset of feed.pages.keys())void api<CatalogPage>(address(offset),'GET',undefined,feed.abort.signal).then(page=>{
      if(current.current!==feed||feed.abort.signal.aborted||!feed.pages.has(offset))return;
      feed.pages.set(offset,page);if(page.total!==undefined)feed.total=page.total;render(n=>n+1);
    },()=>{});
  },path??'');
  useEffect(()=>{
    const feed=fresh(path);current.current.abort.abort();current.current=feed;render(n=>n+1);load(0);
    return()=>feed.abort.abort();
  },[path,load]);
  const feed=current.current.path===path?current.current:undefined;
  return {count:feed?.total??Math.max(CATALOG_PAGE_SIZE,(feed?.end??0)+CATALOG_PAGE_SIZE),total:feed?.total,
    initial:!feed?.pages.size,loading:!!feed?.pending.size,error:feed?.errors.values().next().value,
    item:(index:number)=>feed?.pages.get(Math.floor(index/CATALOG_PAGE_SIZE)*CATALOG_PAGE_SIZE)?.items[index%CATALOG_PAGE_SIZE],
    load,protect:(offsets:number[])=>{if(feed)feed.protected=new Set(offsets);},retry:()=>{for(const offset of feed?.errors.keys()??[])load(offset,true);}};
}
