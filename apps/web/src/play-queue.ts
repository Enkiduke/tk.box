import type {CatalogItem,CatalogPage} from '../../../packages/contracts/src/index.js';

// A play queue, like Plex's: everything that plays in order after (and before) the current title.
export type PlayQueue={title:string;items:CatalogItem[]};
export type FetchPage=(path:string)=>Promise<CatalogPage>;

export async function allPages(fetch:FetchPage,path:string) {
  const items:CatalogItem[]=[];
  for(;;) {
    const page=await fetch(`${path}${path.includes('?')?'&':'?'}offset=${items.length}&limit=60`);
    items.push(...page.items);if(!page.hasMore||!page.items.length)return items;
  }
}
export const isSpecials=(season:CatalogItem)=>season.seasonNumber===0||season.title==='Specials';
// Numbered order, stable for titles Plex gives no number.
const byNumber=(number:(item:CatalogItem)=>number|undefined)=>(list:CatalogItem[])=>list.map((item,i)=>({item,i})).sort((a,b)=>(number(a.item)??Infinity)-(number(b.item)??Infinity)||a.i-b.i).map(e=>e.item);
export const seasonOrder=byNumber(s=>s.seasonNumber),episodeOrder=byNumber(e=>e.episodeNumber);

// Every episode of a show, season after season. Specials stay out of a show's queue, unless playback
// started on one: then the queue is the Specials season.
export async function showEpisodes(fetch:FetchPage,showId:string,start?:CatalogItem) {
  const children=await allPages(fetch,`/catalog/items/${showId}/children`);
  const episodes=children.filter(c=>c.type==='episode'),seasons=children.filter(c=>c.type==='season');
  const startSeason=start&&seasons.find(s=>s.id===start.parentId),special=startSeason&&isSpecials(startSeason);
  const picked=special?[startSeason]:seasonOrder(seasons.filter(s=>!isSpecials(s)));
  const lists=await Promise.all(picked.map(s=>allPages(fetch,`/catalog/items/${s.id}/children`)));
  return [...episodeOrder(episodes),...lists.flatMap(list=>episodeOrder(list.filter(e=>e.type==='episode')))];
}
// A collection's titles in page order; shows and seasons in it play all their episodes.
export async function collectionItems(fetch:FetchPage,path:string) {
  const lists=await Promise.all((await allPages(fetch,path)).map(item=>
    item.type==='show'?showEpisodes(fetch,item.id)
    :item.type==='season'?allPages(fetch,`/catalog/items/${item.id}/children`).then(list=>episodeOrder(list.filter(e=>e.type==='episode')))
    :Promise.resolve([item])));
  return lists.flat();
}
