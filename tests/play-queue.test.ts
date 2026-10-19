import test from 'node:test';
import assert from 'node:assert/strict';
import type {CatalogItem,CatalogPage} from '../packages/contracts/src/index.js';
import {showEpisodes,collectionItems} from '../apps/web/src/play-queue.js';

const item=(id:string,type:CatalogItem['type'],extra:Partial<CatalogItem>={}):CatalogItem=>({id,libraryId:'1',type,title:id,summary:'',viewOffsetMs:0,watched:false,genres:[],...extra});
const episodes=(season:string,seasonNumber:number,count:number)=>Array.from({length:count},(_,i)=>item(`${season}e${i+1}`,'episode',{parentId:season,seasonNumber,episodeNumber:i+1}));
// Serves fixed lists `limit` at a time, as the catalog API pages them.
function server(lists:Record<string,CatalogItem[]>,pageSize=60) {
  const requests:string[]=[];
  const fetch=async(path:string):Promise<CatalogPage>=>{
    requests.push(path);const url=new URL(path,'http://x'),offset=Number(url.searchParams.get('offset')),limit=Math.min(pageSize,Number(url.searchParams.get('limit')));
    const all=lists[url.pathname];if(!all)throw new Error(`unexpected ${path}`);
    return {items:all.slice(offset,offset+limit),offset,limit,hasMore:offset+limit<all.length};
  };
  return {fetch,requests};
}

test('a show queue runs every season in order, from a finale into the next premiere, without specials',async()=>{
  const {fetch}=server({
    '/catalog/items/show/children':[item('s2','season',{seasonNumber:2}),item('s0','season',{seasonNumber:0,title:'Specials'}),item('s1','season',{seasonNumber:1})],
    '/catalog/items/s1/children':[...episodes('s1',1,3)].reverse(),'/catalog/items/s2/children':episodes('s2',2,2),'/catalog/items/s0/children':episodes('s0',0,2)
  });
  const queue=await showEpisodes(fetch,'show',item('s1e1','episode',{parentId:'s1'}));
  assert.deepEqual(queue.map(e=>e.id),['s1e1','s1e2','s1e3','s2e1','s2e2']);
});

test('starting on a special queues the Specials season',async()=>{
  const {fetch}=server({
    '/catalog/items/show/children':[item('s0','season',{seasonNumber:0,title:'Specials'}),item('s1','season',{seasonNumber:1})],
    '/catalog/items/s0/children':episodes('s0',0,2),'/catalog/items/s1/children':episodes('s1',1,2)
  });
  assert.deepEqual((await showEpisodes(fetch,'show',item('s0e2','episode',{parentId:'s0'}))).map(e=>e.id),['s0e1','s0e2']);
});

test('long seasons are read page by page',async()=>{
  const {fetch,requests}=server({'/catalog/items/show/children':[item('s1','season',{seasonNumber:1})],'/catalog/items/s1/children':episodes('s1',1,130)},60);
  assert.equal((await showEpisodes(fetch,'show')).length,130);
  assert.equal(requests.filter(r=>r.startsWith('/catalog/items/s1/')).length,3);
});

test('a collection queues its titles in order, with a show in it expanded into its episodes',async()=>{
  const {fetch}=server({
    '/catalog/collections/c/items':[item('m1','movie'),item('show','show'),item('m2','movie')],
    '/catalog/items/show/children':[item('s1','season',{seasonNumber:1})],'/catalog/items/s1/children':episodes('s1',1,2)
  });
  assert.deepEqual((await collectionItems(fetch,'/catalog/collections/c/items')).map(i=>i.id),['m1','s1e1','s1e2','m2']);
});
