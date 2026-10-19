import {z} from 'zod';
import type {CatalogItem} from '../../../../packages/contracts/src/index.js';

const identifier=z.union([z.string().regex(/^\d+$/),z.number().int().nonnegative()]).transform(String);
export const catalogNode=z.object({
  ratingKey:identifier,type:z.enum(['movie','show','season','episode']),title:z.string(),librarySectionID:identifier.optional(),
  summary:z.string().optional(),year:z.number().int().optional(),duration:z.number().nonnegative().optional(),viewOffset:z.number().nonnegative().optional(),viewCount:z.number().nonnegative().optional(),
  thumb:z.string().optional(),art:z.string().optional(),parentThumb:z.string().optional(),grandparentThumb:z.string().optional(),
  parentRatingKey:identifier.optional(),grandparentRatingKey:identifier.optional(),parentTitle:z.string().optional(),grandparentTitle:z.string().optional(),
  index:z.number().int().nonnegative().optional(),parentIndex:z.number().int().nonnegative().optional(),
  leafCount:z.number().int().nonnegative().optional(),viewedLeafCount:z.number().int().nonnegative().optional(),
  contentRating:z.string().optional(),rating:z.number().optional(),addedAt:z.number().optional(),Genre:z.array(z.object({tag:z.string()})).optional(),
  Image:z.array(z.object({type:z.string().max(40),url:z.string().max(500)})).max(20).optional()
});
export const catalogContainer=z.object({MediaContainer:z.object({Metadata:z.array(catalogNode).default([]),librarySectionID:identifier.optional(),offset:z.coerce.number().int().nonnegative().optional(),totalSize:z.coerce.number().int().nonnegative().optional()})});
export type CatalogNode=z.infer<typeof catalogNode>;
export const artworkPath=(value:string|undefined)=>value&&/^\/library\/metadata\/\d+\/(?:thumb|art)\/\d+$/.test(value)?value:undefined;
// A title's transparent wordmark ("clearLogo"), when its metadata agent supplied one.
export const logoPath=(node:CatalogNode)=>{const value=node.Image?.find(i=>i.type==='clearLogo')?.url;return value&&/^\/library\/metadata\/\d+\/clearLogo\/\d+$/.test(value)?value:undefined;};
export type ArtworkKind='poster'|'backdrop'|'logo';
// A Plex collection in the library's Collections view. Without a custom poster Plex builds a composite of its titles.
export const collectionNode=z.object({ratingKey:identifier,type:z.string(),title:z.string().max(500),subtype:z.string().max(20).optional(),librarySectionID:identifier.optional(),
  childCount:z.coerce.number().int().nonnegative().optional(),thumb:z.string().optional(),composite:z.string().optional(),summary:z.string().optional()});
export const collectionsContainer=z.object({MediaContainer:z.object({librarySectionID:identifier.optional(),Metadata:z.array(collectionNode).max(2000).default([])})});
export type CollectionNode=z.infer<typeof collectionNode>;
export const collectionArtwork=(node:CollectionNode)=>artworkPath(node.thumb)??[node.thumb,node.composite].find(v=>v&&/^\/library\/(?:metadata|collections)\/\d+\/composite\/\d+$/.test(v));
export const collectionDto=(node:CollectionNode)=>({id:node.ratingKey,title:node.title,summary:node.summary??'',count:node.childCount,kind:node.subtype==='show'?'show' as const:'movie' as const,
  posterUrl:collectionArtwork(node)?`/api/v1/catalog/collections/${node.ratingKey}/artwork`:undefined});
export type CatalogCollection=ReturnType<typeof collectionDto>;
// Episodes and seasons carry their series poster so portrait cards never fall back to episode stills.
function showPoster(node:CatalogNode) {
  const [id,thumb]=node.type==='episode'?[node.grandparentRatingKey,node.grandparentThumb]:node.type==='season'?[node.parentRatingKey,node.parentThumb]:[];
  return id&&artworkPath(thumb)?`/api/v1/catalog/items/${id}/artwork?kind=poster`:undefined;
}
export function catalogDto(node:CatalogNode,libraryId:string):CatalogItem {
  return {id:node.ratingKey,libraryId,type:node.type,title:node.title,summary:node.summary??'',year:node.year,durationMs:node.duration,
    viewOffsetMs:node.viewOffset??0,watched:(node.viewCount??0)>0,posterUrl:artworkPath(node.thumb??node.parentThumb??node.grandparentThumb)?`/api/v1/catalog/items/${node.ratingKey}/artwork?kind=poster`:undefined,
    backdropUrl:artworkPath(node.art)?`/api/v1/catalog/items/${node.ratingKey}/artwork?kind=backdrop`:undefined,showPosterUrl:showPoster(node),
    parentId:node.parentRatingKey,parentTitle:node.parentTitle,showId:node.type==='episode'?node.grandparentRatingKey:node.type==='season'?node.parentRatingKey:undefined,
    showTitle:node.grandparentTitle,seasonNumber:node.type==='season'?node.index:node.parentIndex,episodeNumber:node.type==='episode'?node.index:undefined,
    episodeCount:node.leafCount,watchedEpisodeCount:node.viewedLeafCount,contentRating:node.contentRating,rating:node.rating,genres:node.Genre?.map(g=>g.tag)??[],addedAt:node.addedAt};
}
// Plex lists recently added TV one episode at a time. Like Plex's own home hub, episodes of a
// season that arrived together (each within a day of the next) collapse into one season card.
// Only a season's newest batch is grouped; older stragglers stay as episodes so ids remain unique.
const batchWindowSeconds=24*60*60;
export function groupRecentEpisodes(items:CatalogItem[]):CatalogItem[] {
  const open=new Map<string,CatalogItem[]>(),closed=new Set<string>(),out:CatalogItem[][]=[];
  for(const item of items) {
    const season=item.type==='episode'?item.parentId:undefined,batch=season?open.get(season):undefined;
    if(season&&batch&&Math.abs((batch.at(-1)!.addedAt??0)-(item.addedAt??0))<=batchWindowSeconds){batch.push(item);continue;}
    if(season&&batch){open.delete(season);closed.add(season);}
    const entry=[item];out.push(entry);if(season&&!closed.has(season))open.set(season,entry);
  }
  return out.map(([first,...rest])=>!rest.length||!first!.parentId?first!:{
    id:first!.parentId,libraryId:first!.libraryId,type:'season',title:first!.parentTitle??`Season ${first!.seasonNumber??''}`.trim(),summary:'',
    viewOffsetMs:0,watched:[first!,...rest].every(e=>e.watched),posterUrl:first!.showPosterUrl??first!.posterUrl,showPosterUrl:first!.showPosterUrl,backdropUrl:first!.backdropUrl,
    parentId:first!.showId,parentTitle:first!.showTitle,showId:first!.showId,showTitle:first!.showTitle,seasonNumber:first!.seasonNumber,
    episodeCount:rest.length+1,contentRating:first!.contentRating,genres:first!.genres,addedAt:first!.addedAt});
}
export const catalogQuery=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(60).default(24),q:z.string().trim().max(120).default(''),sort:z.enum(['title','newest','year','rating','duration']).default('title'),direction:z.enum(['asc','desc']).optional(),shelf:z.enum(['all','continue','recent','unwatched']).default('all'),genre:z.string().regex(/^\d*$/).max(20).default(''),year:z.coerce.number().int().min(1880).max(2100).optional(),contentRating:z.string().trim().max(30).default('')}).strict();
export type CatalogQuery=z.infer<typeof catalogQuery>;
export const catalogAction=z.object({action:z.enum(['watched','unwatched','removeContinue'])}).strict();
export type CatalogAction=z.infer<typeof catalogAction>['action'];
export function applyCatalogFilters(url:URL,query:CatalogQuery,type:string) {
  url.searchParams.set('type',type==='movie'?'1':'2');
  const field={title:'titleSort',newest:'addedAt',year:'year',rating:'rating',duration:'duration'}[query.sort];
  url.searchParams.set('sort',`${field}:${query.direction??(query.sort==='title'?'asc':'desc')}`);
  if(query.genre)url.searchParams.set('genre',query.genre);
  if(query.q)url.searchParams.set('title',query.q);
  if(query.year!==undefined)url.searchParams.set('year',String(query.year));
  if(query.contentRating)url.searchParams.set('contentRating',query.contentRating);
  if(query.shelf==='unwatched')url.searchParams.set('unwatched','1');
}
// Jump-rail buckets for non-title sorts. Values arrive in the library's sort order, so each
// bucket is a run of consecutive items; a label that recurs folds into its first run.
export type IndexEntry={label:string;offset:number;count:number};
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function sortIndex(sort:Exclude<CatalogQuery['sort'],'title'>,values:(number|undefined)[]):IndexEntry[] {
  const known=values.filter((v):v is number=>v!==undefined&&Number.isFinite(v));
  let label:(v:number)=>string;
  if(sort==='year')label=new Set(known).size<=28?String:v=>`${Math.floor(v/10)*10}s`;
  else if(sort==='rating')label=v=>String(Math.min(10,Math.max(0,Math.floor(v))));
  else if(sort==='duration'){
    const short=known.every(v=>v<90*60000);
    label=short?v=>{const m=Math.floor(v/600000)*10;return m?`${m}m`:'<10m';}:v=>{const half=Math.floor(v/1800000);return half>=6?'3h+':['<30m','30m','1h','1½h','2h','2½h'][half]!;};
  } else {
    const years=new Set(known.map(v=>new Date(v*1000).getUTCFullYear()));
    label=years.size>1?v=>String(new Date(v*1000).getUTCFullYear()):v=>months[new Date(v*1000).getUTCMonth()]!;
  }
  const entries:IndexEntry[]=[],seen=new Map<string,IndexEntry>();let last:IndexEntry|undefined;
  values.forEach((v,offset)=>{
    const name=v===undefined||!Number.isFinite(v)?'–':label(v);
    if(last?.label===name){last.count++;return;}
    const prior=seen.get(name);if(prior){prior.count++;last=prior;return;}
    last={label:name,offset,count:1};seen.set(name,last);entries.push(last);
  });
  return entries;
}
