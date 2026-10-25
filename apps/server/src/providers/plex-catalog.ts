import {z} from 'zod';
import type {CatalogItem,ExternalRating} from '../../../../packages/contracts/src/index.js';

const identifier=z.union([z.string().regex(/^\d+$/),z.number().int().nonnegative()]).transform(String);
export const catalogNode=z.object({
  ratingKey:identifier,type:z.enum(['movie','show','season','episode']),title:z.string(),librarySectionID:identifier.optional(),
  summary:z.string().optional(),year:z.number().int().optional(),duration:z.number().nonnegative().optional(),viewOffset:z.number().nonnegative().optional(),viewCount:z.number().nonnegative().optional(),
  thumb:z.string().optional(),art:z.string().optional(),parentThumb:z.string().optional(),grandparentThumb:z.string().optional(),
  parentRatingKey:identifier.optional(),grandparentRatingKey:identifier.optional(),parentTitle:z.string().optional(),grandparentTitle:z.string().optional(),
  index:z.number().int().nonnegative().optional(),parentIndex:z.number().int().nonnegative().optional(),
  leafCount:z.number().int().nonnegative().optional(),viewedLeafCount:z.number().int().nonnegative().optional(),
  contentRating:z.string().optional(),rating:z.number().optional(),addedAt:z.number().optional(),Genre:z.array(z.object({tag:z.string()})).optional(),
  Image:z.array(z.object({type:z.string().max(40),url:z.string().max(500)})).max(20).optional(),
  // Detail-only extras. A malformed one is dropped rather than failing the whole item.
  Rating:z.array(z.object({image:z.string().max(200),value:z.coerce.number(),type:z.string().max(20).optional()})).max(20).optional().catch(undefined),
  ratingImage:z.string().max(200).optional().catch(undefined),audienceRating:z.number().optional().catch(undefined),audienceRatingImage:z.string().max(200).optional().catch(undefined),
  tagline:z.string().max(500).optional().catch(undefined),originallyAvailableAt:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),studio:z.string().max(200).optional().catch(undefined),
  Director:z.array(z.object({tag:z.string().max(200)})).max(50).optional().catch(undefined),Role:z.array(z.object({tag:z.string().max(200)})).max(500).optional().catch(undefined),
  Guid:z.array(z.object({id:z.string().max(200)})).max(20).optional().catch(undefined),
  Collection:z.array(z.object({tag:z.string().max(500)})).max(50).optional().catch(undefined)
});
// A movie's or show's TMDB id from its agent guids (tmdb://603). An episode's or season's would be its own, not the show's.
const tmdbId=(node:CatalogNode)=>{if(node.type!=='movie'&&node.type!=='show')return undefined;const id=node.Guid?.map(g=>/^tmdb:\/\/(\d{1,10})$/.exec(g.id)?.[1]).find(Boolean);return id?Number(id):undefined;};
// The item's own IMDb title (tt…); an episode has one of its own.
const imdbId=(node:CatalogNode)=>node.Guid?.map(g=>/^imdb:\/\/(tt\d{1,12})$/.exec(g.id)?.[1]).find(Boolean);
export const catalogContainer=z.object({MediaContainer:z.object({Metadata:z.array(catalogNode).default([]),librarySectionID:identifier.optional(),offset:z.coerce.number().int().nonnegative().optional(),totalSize:z.coerce.number().int().nonnegative().optional()})});
export type CatalogNode=z.infer<typeof catalogNode>;
export const artworkPath=(value:string|undefined)=>value&&/^\/library\/metadata\/\d+\/(?:thumb|art)\/\d+$/.test(value)?value:undefined;
// Plex ends each artwork path in when that art last changed. Carrying it in tk.box's image address gives new art a new
// address, so a page that reloads its titles shows the new poster while unchanged art stays cached.
export const versioned=(url:string,path:string|undefined)=>{const version=path?.match(/\/(\d+)$/)?.[1];return version?`${url}${url.includes('?')?'&':'?'}v=${version}`:url;};
// A title's transparent wordmark ("clearLogo"), when its metadata agent supplied one.
export const logoPath=(node:CatalogNode)=>{const value=node.Image?.find(i=>i.type==='clearLogo')?.url;return value&&/^\/library\/metadata\/\d+\/clearLogo\/\d+$/.test(value)?value:undefined;};
// Plex names each score's source and Rotten Tomatoes state in an image URI, e.g. rottentomatoes://image.rating.ripe.
const ratingSources:[RegExp,ExternalRating['source'],boolean?][]=[
  [/^imdb:\/\/image\.rating$/,'imdb'],[/^themoviedb:\/\/image\.rating$/,'tmdb'],
  [/^rottentomatoes:\/\/image\.rating\.(?:ripe|certified)$/,'tomatometer',true],[/^rottentomatoes:\/\/image\.rating\.rotten$/,'tomatometer',false],
  [/^rottentomatoes:\/\/image\.rating\.upright$/,'popcornmeter',true],[/^rottentomatoes:\/\/image\.rating\.spilled$/,'popcornmeter',false]
];
const ratingOrder:ExternalRating['source'][]=['imdb','tomatometer','popcornmeter','tmdb'];
// The item's third-party scores, one per source in a fixed order. Older agents send only the top-level
// critic and audience pairs instead of the Rating list.
export function externalRatings(node:CatalogNode):ExternalRating[]|undefined {
  const entries=node.Rating??[{image:node.ratingImage,value:node.rating},{image:node.audienceRatingImage,value:node.audienceRating}];
  const found=new Map<ExternalRating['source'],ExternalRating>();
  for(const {image,value} of entries) {
    const match=image&&value!==undefined&&Number.isFinite(value)&&value>0&&value<=10?ratingSources.find(([pattern])=>pattern.test(image)):undefined;
    if(match&&!found.has(match[1]))found.set(match[1],{source:match[1],score:value!,...(match[2]===undefined?{}:{fresh:match[2]})});
  }
  return found.size?ratingOrder.flatMap(source=>found.get(source)??[]):undefined;
}
export type ArtworkKind='poster'|'backdrop'|'logo'|'tile';
// A Plex collection in the library's Collections view. Without a custom poster Plex builds a composite of its titles.
export const collectionNode=z.object({ratingKey:identifier,type:z.string(),title:z.string().max(500),subtype:z.string().max(20).optional(),librarySectionID:identifier.optional(),
  childCount:z.coerce.number().int().nonnegative().optional(),thumb:z.string().optional(),composite:z.string().optional(),summary:z.string().optional()});
export const collectionsContainer=z.object({MediaContainer:z.object({librarySectionID:identifier.optional(),Metadata:z.array(collectionNode).max(2000).default([])})});
export type CollectionNode=z.infer<typeof collectionNode>;
export const collectionArtwork=(node:CollectionNode)=>artworkPath(node.thumb)??[node.thumb,node.composite].find(v=>v&&/^\/library\/(?:metadata|collections)\/\d+\/composite\/\d+$/.test(v));
export const collectionDto=(node:CollectionNode)=>{const art=collectionArtwork(node);return {id:node.ratingKey,title:node.title,summary:node.summary??'',count:node.childCount,kind:node.subtype==='show'?'show' as const:'movie' as const,
  posterUrl:art?versioned(`/api/v1/catalog/collections/${node.ratingKey}/artwork`,art):undefined};};
export type CatalogCollection=ReturnType<typeof collectionDto>;
// Episodes and seasons carry their series poster so portrait cards never fall back to episode stills.
function showPoster(node:CatalogNode) {
  const [id,thumb]=node.type==='episode'?[node.grandparentRatingKey,node.grandparentThumb]:node.type==='season'?[node.parentRatingKey,node.parentThumb]:[];
  return id&&artworkPath(thumb)?versioned(`/api/v1/catalog/items/${id}/artwork?kind=poster`,thumb):undefined;
}
export function catalogDto(node:CatalogNode,libraryId:string):CatalogItem {
  const poster=artworkPath(node.thumb??node.parentThumb??node.grandparentThumb),backdrop=artworkPath(node.art),logo=logoPath(node);
  return {id:node.ratingKey,libraryId,type:node.type,title:node.title,summary:node.summary??'',year:node.year,durationMs:node.duration,
    viewOffsetMs:node.viewOffset??0,watched:(node.viewCount??0)>0,posterUrl:poster?versioned(`/api/v1/catalog/items/${node.ratingKey}/artwork?kind=poster`,poster):undefined,
    backdropUrl:backdrop?versioned(`/api/v1/catalog/items/${node.ratingKey}/artwork?kind=backdrop`,backdrop):undefined,showPosterUrl:showPoster(node),
    parentId:node.parentRatingKey,parentTitle:node.parentTitle,showId:node.type==='episode'?node.grandparentRatingKey:node.type==='season'?node.parentRatingKey:undefined,
    showTitle:node.grandparentTitle,seasonNumber:node.type==='season'?node.index:node.parentIndex,episodeNumber:node.type==='episode'?node.index:undefined,
    episodeCount:node.leafCount,watchedEpisodeCount:node.viewedLeafCount,contentRating:node.contentRating,rating:node.rating,genres:node.Genre?.map(g=>g.tag)??[],addedAt:node.addedAt,
    ratings:externalRatings(node),logoUrl:logo?versioned(`/api/v1/catalog/items/${node.ratingKey}/artwork?kind=logo`,logo):undefined,tagline:node.tagline||undefined,airDate:node.originallyAvailableAt,
    studio:node.studio||undefined,directors:node.Director?.length?node.Director.map(d=>d.tag):undefined,cast:node.Role?.length?node.Role.slice(0,8).map(r=>r.tag):undefined,tmdbId:tmdbId(node),imdbId:imdbId(node)};
}
// Plex lists recently added TV one episode at a time, newest first. Each show gets one card holding all its episodes in
// the list, however they arrived: one episode stays itself, one season becomes a season card, several seasons a show card
// ("2 seasons · 16 episodes"). The card sits where the show's newest episode is. With `limit`, the list is read only until
// a show past the limit would start a card, so no card takes in episodes older than the row reaches.
export function groupRecentEpisodes(items:CatalogItem[],limit=Infinity):CatalogItem[] {
  const shows=new Map<string,CatalogItem[]>(),runs:CatalogItem[][]=[];
  for(const item of items) {
    const show=item.type==='episode'?item.showId:undefined,run=show?shows.get(show):undefined;
    if(run){run.push(item);continue;}
    if(runs.length>=limit)break;
    const entry=[item];runs.push(entry);if(show)shows.set(show,entry);
  }
  return runs.map(run=>{
    const seasons=new Map<string,CatalogItem[]>();
    for(const e of run){const key=e.parentId??'',season=seasons.get(key);if(season)season.push(e);else seasons.set(key,[e]);}
    return seasons.size>1?showCard([...seasons.values()]):seasonCard(run);
  });
}
function seasonCard([first,...rest]:CatalogItem[]):CatalogItem {
  return !rest.length||!first!.parentId?first!:{
    id:first!.parentId,libraryId:first!.libraryId,type:'season',title:first!.parentTitle??`Season ${first!.seasonNumber??''}`.trim(),summary:'',
    viewOffsetMs:0,watched:[first!,...rest].every(e=>e.watched),posterUrl:first!.showPosterUrl??first!.posterUrl,showPosterUrl:first!.showPosterUrl,backdropUrl:first!.backdropUrl,
    parentId:first!.showId,parentTitle:first!.showTitle,showId:first!.showId,showTitle:first!.showTitle,seasonNumber:first!.seasonNumber,
    episodeCount:rest.length+1,contentRating:first!.contentRating,genres:first!.genres,addedAt:first!.addedAt};
}
function showCard(seasons:CatalogItem[][]):CatalogItem {
  const episodes=seasons.flat(),first=episodes[0]!;
  return {id:first.showId!,libraryId:first.libraryId,type:'show',title:first.showTitle??first.title,summary:'',
    viewOffsetMs:0,watched:episodes.every(e=>e.watched),posterUrl:first.showPosterUrl??first.posterUrl,showPosterUrl:first.showPosterUrl,backdropUrl:first.backdropUrl,
    seasonCount:seasons.length,episodeCount:episodes.length,contentRating:first.contentRating,genres:first.genres,addedAt:first.addedAt};
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

// Plex's promoted hubs: what it shows on the viewer's Home, including collections set to "Visible on Home"
// (seasonal ones come and go as their visibility is switched). A collection hub links to `/library/collections/<id>/children`
// and is identified as `custom.collection.<section>.<id>`. Plex's own rows and any hub that doesn't parse are skipped, never fatal.
export const promotedHubs=z.object({MediaContainer:z.object({Hub:z.array(z.unknown()).max(200).default([])}).default({Hub:[]})});
const promotedHub=z.object({key:z.string().max(500).optional(),hubIdentifier:z.string().max(200).optional()});
export function promotedCollectionIds(hubs:z.infer<typeof promotedHubs>) {
  const ids:string[]=[];
  for(const raw of hubs.MediaContainer.Hub) {
    const hub=promotedHub.safeParse(raw);if(!hub.success)continue;
    const id=/^\/library\/collections\/(\d{1,20})\/children(?:\?|$)/.exec(hub.data.key??'')?.[1]??/^custom\.collection\.\d{1,20}\.(\d{1,20})$/.exec(hub.data.hubIdentifier??'')?.[1];
    if(id&&!ids.includes(id))ids.push(id);
  }
  return ids;
}
