import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {exploreGenres,exploreBrowseSources,tmdbExploreRows,type ExploreBrowseSource,type ExploreDetails,type ExploreGenre,type ExploreItem,type ExploreStatus,ExploreLayout,ExplorePage,ExploreSearchResult,ExploreSources,ExternalRating} from '../../../packages/contracts/src/index.js';
import type {PlexAdapter,PlexGrant} from './providers/plex.js';
import {PlexDiscover,discoverIds,discoverItem,type DiscoverMetadata} from './providers/plex-discover.js';
import {externalRatings} from './providers/plex-catalog.js';
import {Seerr,seerrSeasons,seerrStatus,type SeerrDetails} from './providers/seerr.js';
import {ExploreImages} from './providers/explore-images.js';
import {ExploreStore,exploreLayoutInput,exploreSettingsInput,tmdbRowOrder} from './persistence/explore-store.js';
import {requireThat} from './errors.js';
import {viewer as caller} from './modules/access.js';
import {TmdbExplore,sliceExplore,tmdbRows} from './providers/tmdb-explore.js';
import type {TmdbTitles} from './providers/tmdb-titles.js';
import {TmdbTitleDiscovery} from './providers/tmdb-title-discovery.js';
import {ExploreRecommendations} from './explore-recommendations.js';
import { TtlCache } from './lib/ttl-cache.js';

const source=z.enum(exploreBrowseSources);
const tmdbRow=z.enum(tmdbExploreRows);
const kind=z.enum(['movie','show']);
// Explore's filters, sent with every row page and search: original languages, genres, a release year range, a minimum
// score and Seerr labels to leave out.
const filterQuery={kind:kind.optional(),lang:z.string().max(200).optional(),from:z.coerce.number().int().min(1870).max(2100).optional(),to:z.coerce.number().int().min(1870).max(2100).optional(),
  min:z.coerce.number().min(0).max(10).optional(),hide:z.string().max(40).optional(),genre:z.string().max(300).optional()};
const page=z.object({page:z.coerce.number().int().min(1).max(500).default(1),...filterQuery}).strict();
const regionCode=z.string().regex(/^[A-Z]{2}$/);
const providerId=z.string().regex(/^[1-9]\d{0,9}$/).transform(Number);
const tmdbPage=page.extend({region:regionCode.optional(),provider:z.union([z.literal('all'),providerId]).optional(),
  providers:z.string().max(131).regex(/^(?:[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,11})?$/).transform(value=>value?value.split(',').map(Number):[]).optional()});
const ids=z.object({tmdb:z.coerce.number().int().positive().optional(),imdb:z.string().regex(/^tt\d{1,12}$/).optional(),tvdb:z.coerce.number().int().positive().optional(),
  plex:z.string().regex(/^[\w-]{1,64}$/).optional()});

// Explore reads from Plex Discover and Seerr, kept briefly per viewer so moving around Explore doesn't wait on
// outside services again. A viewer's own change (watchlist, request, Refresh) drops their copies,
// and a settings change drops everyone's. Failed reads are not kept.
// Plex shelves change about daily. The watchlist can change outside tk.box, so it stays short.
const ROWS_MS=12*3600000,PUBLIC_MS=12*3600000,PAGE_MS=10*60000,DETAILS_MS=10*60000,SEARCH_MS=5*60000;
export class ExploreCache {
  private entries=new TtlCache<Promise<unknown>>(2000);
  get<T>(account:string,key:string,ttl:number,read:()=>Promise<T>,now=Date.now()):Promise<T> {return this.entries.remember(`${account}
${key}`,ttl,read,now);}
  forget(account?:string) {if(account===undefined)this.entries.clear();else this.entries.deleteWhere(id=>id.startsWith(`${account}
`));}
}

export const plexRowTtl=(row:string)=>row==='watchlist'?PAGE_MS:PUBLIC_MS;

// `genres`: a title passes with any of them. `hide`: titles with these Seerr labels.
export type ExploreFilter={kind?:ExploreItem['kind'];languages:string[];genres?:ExploreGenre[];from?:number;to?:number;min?:number;hide?:ExploreStatus[]};
export function exploreFilter(input:{kind?:ExploreItem['kind'];lang?:string;genre?:string;from?:number;to?:number;min?:number;hide?:string}):ExploreFilter {
  const languages=[...new Set((input.lang??'').split(',').map(l=>l.trim().toLowerCase()).filter(l=>/^[a-z]{2,3}$/.test(l)))].slice(0,30);
  const hide=(['requested','partial','available'] as const).filter(s=>(input.hide??'').split(',').includes(s));
  const genres=exploreGenres.filter(g=>(input.genre??'').split(',').includes(g));
  return {languages,...(input.kind&&{kind:input.kind}),...(genres.length?{genres}:{}),...(input.from!==undefined?{from:input.from}:{}),...(input.to!==undefined?{to:input.to}:{}),...(input.min?{min:input.min}:{}),...(hide.length?{hide}:{})};
}
export const filtering=(f:ExploreFilter)=>!!f.kind||f.languages.length>0||f.from!==undefined||f.to!==undefined||f.min!==undefined||!!f.hide||!!f.genres;
// What a filter needs that the title does not say. Such titles are looked up; still unknown, they are left out.
export const lacking=(item:ExploreItem,f:ExploreFilter)=>(f.languages.length>0&&!item.language)||(!!f.genres&&!item.genres?.length)||((f.from!==undefined||f.to!==undefined)&&!item.year)||(f.min!==undefined&&item.rating===undefined);
export function passes(item:ExploreItem,f:ExploreFilter) {
  if(f.kind&&item.kind!==f.kind)return false;
  if(item.status&&f.hide?.includes(item.status))return false;
  if(f.genres&&!item.genres?.some(g=>f.genres!.includes(g)))return false;
  if(f.languages.length&&(!item.language||!f.languages.includes(item.language)))return false;
  if(f.from!==undefined||f.to!==undefined){if(!item.year||f.from!==undefined&&item.year<f.from||f.to!==undefined&&item.year>f.to)return false;}
  return f.min===undefined||item.rating!==undefined&&item.rating>=f.min;
}
// One list from several sources' lists, each source's best first: their first titles, then their second, and so on.
// A title several sources know is listed once, where it first appears, with what the others add.
export function interleave(lists:ExploreItem[][]) {
  const merged=new Map<string,ExploreItem>();
  for(let i=0;lists.some(list=>i<list.length);i++)for(const list of lists){
    const item=list[i];if(!item)continue;
    const found=merged.get(item.key);if(!found){merged.set(item.key,item);continue;}
    const next:Record<string,unknown>={...found};
    for(const [key,value] of Object.entries(item))if(next[key]===undefined&&value!==undefined)next[key]=value;
    merged.set(item.key,{...next,ids:{...item.ids,...found.ids}} as ExploreItem);
  }
  return [...merged.values()];
}
// A filtered row page reads this many of the source's pages, so filters that leave few titles still fill a row.
const FILTER_SPAN=3;
// The sources Explore shows, in the administrator's order, and whether one of a source's rows is hidden.
export const shownSources=(layout:ExploreLayout)=>layout.order.filter(s=>!layout.hidden.includes(s));
export const rowShown=(layout:ExploreLayout,from:ExploreBrowseSource,row:string)=>!layout.hidden.includes(from)&&!layout.hiddenRows.includes(`${from}:${row}`);

// Explore: rows, search and details from Plex Discover and Seerr, plus Seerr requests and the Plex watchlist.
export function registerExplore(app:FastifyInstance,plex:PlexAdapter,store:ExploreStore,accountToken:(hash:string)=>string,tmdbClient:TmdbTitles,transports:{seerr?:typeof fetch; images?:typeof fetch}={}) {
  const discover=new PlexDiscover(plex),seerr=new Seerr(()=>store.seerr(),transports.seerr),images=new ExploreImages(transports.images),cache=new ExploreCache();
  const tmdb=new TmdbExplore(tmdbClient),personal=new ExploreRecommendations(plex,tmdb),titleDiscovery=new TmdbTitleDiscovery(tmdbClient,tmdb);
  const viewer=async(request:FastifyRequest)=>{const {hash,grant}=caller(request);return {grant,account:grant.accountId,token:accountToken(hash)};};
  app.get('/api/v1/explore/sources',{config:{access:'viewer'}},async request=>{
    // Nobody is signed in to Seerr here; that waits until they request something.
    await viewer(request);
    return {plex:true,order:shownSources(store.layout()),seerr:{configured:seerr.configured(),statuses:seerr.hasKey()},tmdb:{configured:tmdbClient.configured()}} satisfies ExploreSources;
  });
  app.get('/api/v1/explore/tmdb/providers',{config:{access:'viewer'}},async request=>{
    await viewer(request);
    const {region}=z.object({region:regionCode.default('US')}).strict().parse(request.query);
    return tmdb.providers(region);
  });
  app.get('/api/v1/explore/:source/rows',{config:{access:'viewer'}},async request=>{
    const {source:from}=z.object({source}).parse(request.params),{account,token}=await viewer(request),layout=store.layout();
    return {rows:(await sourceRows(from,account,token)).filter(row=>rowShown(layout,from,row.id))};
  });
  app.get('/api/v1/explore/:source/rows/:row',{config:{access:'viewer'}},async request=>{
    const params=z.object({source,row:z.string().max(800)}).parse(request.params),{account,token,grant}=await viewer(request);
    if (params.source==='tmdb') {
      const parsed=tmdbRow.safeParse(params.row);
      requireThat(parsed.success&&rowShown(store.layout(),'tmdb',params.row),'EXPLORE_ROW_MISSING','This Explore row is unavailable.',404);
      const row=parsed.data,def=tmdbRows[row];
      const {page:at,provider,providers,region,...query}=tmdbPage.parse(request.query);
      requireThat(def.streaming||(provider===undefined&&providers===undefined&&region===undefined),'INVALID_REQUEST','This row has no streaming selector.',400);
      requireThat(tmdbClient.configured(),'TMDB_KEY_MISSING','Add a TMDB key in Artwork › Settings.',409);
      const filter=exploreFilter(query);
      if (def.personal) {
        const result=(await personal.get(grant,tmdbClient.credentialGeneration(),token))[row];
        if (!result) return {items:[],page:at,hasMore:false} satisfies ExplorePage;
        const {items}=await labelled({items:result.items.map(c=>c.item)});
        return sliceExplore(result.items.map((c,index)=>({...c,item:items[index]!})).filter(c=>passes(c.item,filter)),at,result.title);
      }
      let streaming:{region:string;ids:number[]}|undefined;
      if (def.streaming) {
        const country=region??'US', catalog=await tmdb.providers(country), available=new Set(catalog.providers.map(p=>p.id));
        const chosen=providers??catalog.defaults;
        requireThat(chosen.every(id=>available.has(id))&&(typeof provider!=='number'||(available.has(provider)&&(providers===undefined||chosen.includes(provider)))),
          'INVALID_PROVIDER','Choose a streaming service available in this region.',400);
        streaming={region:country,ids:typeof provider==='number'?[provider]:[...new Set(chosen)].sort((a,b)=>a-b)};
      }
      const {kind:mediaKind,...otherFilters}=filter;
      if (!filtering(otherFilters)) return labelled(await tmdb.page(row,at,streaming,mediaKind));
      const pages:ExplorePage[]=[];
      for (let i=0;i<FILTER_SPAN;i++) {
        const result=await tmdb.page(row,(at-1)*FILTER_SPAN+i+1,streaming,mediaKind);
        pages.push(result);
        if (!result.hasMore) break;
      }
      const {items}=await labelled({items:interleave([pages.flatMap(p=>p.items)])});
      return {items:items.filter(item=>passes(item,filter)),page:at,hasMore:!!pages.at(-1)?.hasMore} satisfies ExplorePage;
    }
    const {page:at,...query}=page.parse(request.query),filter=exploreFilter(query);
    const layout=store.layout(),definition=(await sourceRows('plex',account,token)).find(row=>row.id===params.row);
    requireThat(definition&&rowShown(layout,'plex',definition.id),'EXPLORE_ROW_MISSING','This Explore row is unavailable.',404);
    const read=async(n:number):Promise<ExplorePage>=>{
      const key=`row:${params.source}:${params.row}:${n}`;
      return labelled(await cache.get(account,key,plexRowTtl(params.row),()=>discover.row(token,params.row,n)));
    };
    if(!filtering(filter))return read(at);
    // Filtered page n covers the source's pages (n-1)*span+1 to n*span; the first says whether the rest exist.
    const firstPage=(at-1)*FILTER_SPAN+1,head=await read(firstPage),pages=[head];
    if(head.hasMore)for(const next of await Promise.all(Array.from({length:FILTER_SPAN-1},(_,i)=>read(firstPage+i+1).catch(()=>undefined)))){
      if(!next||!pages.at(-1)!.hasMore)break;pages.push(next);
    }
    return {items:await filtered(interleave([pages.flatMap(p=>p.items)]),filter),page:at,hasMore:pages.length===FILTER_SPAN&&pages.at(-1)!.hasMore} satisfies ExplorePage;
  });
  // One search across every source that is set up, best matches from each first. A source that fails leaves the others.
  app.get('/api/v1/explore/search',{config:{access:'viewer',rateLimit:{max:60,timeWindow:60000}}},async request=>{
    const {q,sources:only,...query}=z.object({q:z.string().trim().min(1).max(120),sources:z.string().max(40).optional(),...filterQuery}).strict().parse(request.query),{account,token}=await viewer(request),filter=exploreFilter(query);
    // `sources` narrows the search to the sources the viewer keeps on; without it every source on offer is searched.
    const wanted=only===undefined?undefined:only.split(',');
    const key=`search:${q.toLowerCase()}`,layout=store.layout();
    const from=shownSources(layout).filter(s=>(s==='plex'||tmdbClient.configured())&&(!wanted||wanted.includes(s)));
    const results=await Promise.allSettled(from.map(async s=>s==='plex'?(await labelled({items:await cache.get(account,`plex:${key}`,SEARCH_MS,()=>discover.search(token,q))})).items
      :(await labelled({items:await tmdb.search(q,filter.kind)})).items));
    const failed=from.filter((_,i)=>results[i]!.status==='rejected');
    requireThat(!from.length||failed.length<from.length,'EXPLORE_UNAVAILABLE','Search is unavailable right now. Try again in a moment.',502);
    const items=interleave(results.map(r=>r.status==='fulfilled'?r.value:[]));
    return {items:filtering(filter)?await filtered(items,filter):items,failed} satisfies ExploreSearchResult;
  });
  // Signs the viewer in to Seerr (with their Plex account) when they go to request, and says what they may request.
  app.get('/api/v1/explore/seerr/account',{config:{access:'viewer'}},async request=>{const {account,token}=await viewer(request);return seerr.account(account,token);});
  app.get('/api/v1/explore/seerr/options',{config:{access:'viewer'}},async request=>{
    const input=z.object({kind,is4k:z.enum(['true','false']).default('false'),server:z.coerce.number().int().nonnegative().optional()}).strict().parse(request.query),{account,token}=await viewer(request);
    return seerr.options(account,token,input.kind,input.is4k==='true',input.server);
  });
  app.get('/api/v1/explore/seerr/users',{config:{access:'viewer'}},async request=>{const {account,token}=await viewer(request);return {users:await seerr.users(account,token)};});
  app.get('/api/v1/explore/details',{config:{access:'viewer'}},async request=>{
    const input=ids.extend({kind,title:z.string().max(300).default(''),year:z.coerce.number().int().optional(),
      region:regionCode.default('US'),library:z.enum(['true','false']).default('false')}).strict().parse(request.query),{grant,account,token}=await viewer(request);
    return cache.get(account,`details:${tmdbClient.credentialGeneration()}:${JSON.stringify(input)}`,DETAILS_MS,()=>details(input,grant,account,token));
  });
  app.get('/api/v1/explore/title-credits',{config:{access:'viewer'}},async request=>{
    
    const {kind:media,...externalIds}=ids.pick({tmdb:true,imdb:true,tvdb:true}).extend({kind}).strict().parse(request.query);
    return titleDiscovery.credits(media==='show'?'tv':'movie',externalIds);
  });
  app.get('/api/v1/explore/title-related',{config:{access:'viewer'}},async request=>{
    
    const {kind:media,tmdb}=z.object({kind,tmdb:z.coerce.number().int().positive()}).strict().parse(request.query);
    return titleDiscovery.related(media==='show'?'tv':'movie',tmdb);
  });
  app.post('/api/v1/explore/request',{config:{access:'viewer',rateLimit:{max:20,timeWindow:60000}}},async request=>{
    const input=z.object({kind,tmdb:z.number().int().positive(),seasons:z.array(z.number().int().positive()).max(100).optional(),is4k:z.boolean().default(false),
      serverId:z.number().int().nonnegative().optional(),profileId:z.number().int().nonnegative().optional(),rootFolder:z.string().min(1).max(500).optional(),
      languageProfileId:z.number().int().nonnegative().optional(),tags:z.array(z.number().int().nonnegative()).max(50).optional(),userId:z.number().int().positive().optional()}).strict().parse(request.body),{account,token}=await viewer(request);
    const {kind:media,tmdb,seasons,is4k,...extras}=input;
    await seerr.request(account,token,media,tmdb,seasons,is4k,extras);cache.forget();return {status:'requested'};
  });
  app.put('/api/v1/explore/watchlist',{config:{access:'viewer',rateLimit:{max:60,timeWindow:60000}}},async request=>{
    const input=z.object({plex:z.string().regex(/^[\w-]{1,64}$/),add:z.boolean()}).strict().parse(request.body),{account,token}=await viewer(request);
    await discover.setWatchlisted(token,input.plex,input.add);cache.forget(account);return {watchlisted:input.add};
  });
  app.get('/api/v1/explore/image',{config:{access:'viewer',rateLimit:{max:1200,timeWindow:60000}}},async(request,reply)=>{
    const {u}=z.object({u:z.string().max(2000)}).strict().parse(request.query);
    const image=await images.get(u);
    return reply.type(image.type).header('Cache-Control','private, max-age=86400').send(image.bytes);
  });
  // Resolve IMDb person IDs through TMDB, with an IMDb name-search fallback.
  app.get('/api/v1/explore/person',{config:{access:'viewer',rateLimit:{max:60,timeWindow:60000}}},async(request,reply)=>{
    const input=z.object({name:z.string().trim().min(1).max(200),kind:kind.optional(),tmdb:z.coerce.number().int().positive().optional()}).strict().parse(request.query);
    
    const imdb=await titleDiscovery.imdbPerson(input.name,input.kind==='show'?'tv':input.kind,input.tmdb).catch(()=>undefined);
    return reply.header('Cache-Control',imdb?'private, max-age=86400':'no-store').redirect(imdb?`https://www.imdb.com/name/${imdb}/`:`https://www.imdb.com/find/?q=${encodeURIComponent(input.name)}&s=nm&exact=true`);
  });
  // TMDB does not supply Rotten Tomatoes URLs. Search by the title.
  app.get('/api/v1/explore/rottentomatoes',{config:{access:'viewer',rateLimit:{max:60,timeWindow:60000}}},async(request,reply)=>{
    const {title}=z.object({title:z.string().trim().min(1).max(300),kind:kind.optional(),tmdb:z.coerce.number().int().positive().optional()}).strict().parse(request.query);
    
    return reply.redirect(`https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`);
  });
  // Explore's Refresh button rebuilds the viewer's recommendations and Plex shelves.
  app.post('/api/v1/explore/refresh',{config:{access:'viewer',rateLimit:{max:30,timeWindow:60000}}},async request=>{const {account}=await viewer(request);cache.forget(account);personal.forget(account);return {status:'refreshed'};});
  // Admin › Explore: the source order and what is hidden, with every row each source has (Plex's as the administrator sees them).
  app.get('/api/v1/admin/explore/layout',{config:{access:'admin'}},async request=>{
    const {hash,grant}=caller(request),account=grant.accountId,token=accountToken(hash);
    const sources=await Promise.all(exploreBrowseSources.map(async from=>{
      const configured=from==='plex'||tmdbClient.configured();
      const rows=await sourceRows(from,account,token).catch(()=>undefined);
      return {source:from,configured,rows:rows??[],...(rows?{}:{error:'Plex Discover could not list its rows.'})};
    }));
    return {layout:store.layout(),sources};
  });
  app.put('/api/v1/admin/explore/layout',{config:{access:'admin'}},async request=>{
    const {grant}=caller(request),{expectedRevision,...value}=exploreLayoutInput.extend({expectedRevision:z.number().int().nonnegative()}).strict().parse(request.body);
    return store.updateLayout(grant.accountId,expectedRevision,value);
  });
  app.get('/api/v1/admin/explore/settings',{config:{access:'admin'}},async request=>{return store.view();});
  app.put('/api/v1/admin/explore/settings',{config:{access:'admin'}},async request=>{
    const {grant}=caller(request),{expectedRevision,...value}=exploreSettingsInput.extend({expectedRevision:z.number().int().nonnegative()}).strict().parse(request.body);
    // A Seerr address is checked before it is saved, so viewers never get a dead Explore source.
    if(value.seerrUrl){
      await seerr.publicSettings(value.seerrUrl,true);
      const key=value.seerrApiKey??store.seerrKey();if(key)await seerr.checkKey(value.seerrUrl,key);
    }
    const saved=store.update(grant.accountId,expectedRevision,value);cache.forget();return saved;
  });

  async function sourceRows(from:ExploreBrowseSource,account:string,token:string) {
    if(from==='plex')return cache.get(account,'plex:rows',ROWS_MS,()=>discover.rows(token));
    return tmdbRowOrder(store.layout().tmdbOrder).map(id=>tmdbRows[id]);
  }
  // Use the cached TMDB title when Plex omits a field required by the filter.
  async function filtered(items:ExploreItem[],filter:ExploreFilter) {
    const filled=await Promise.all(items.filter(item=>!filter.kind||item.kind===filter.kind).map(async item=>{
      if(!lacking(item,filter)||!item.ids.tmdb||!tmdbClient.configured())return item;
      const facts=(await titleDiscovery.details(item.kind==='show'?'tv':'movie',item.ids,'US').catch(()=>undefined))?.item;
      return facts?{...item,language:item.language??facts.language,genres:item.genres?.length?item.genres:facts.genres,year:item.year??facts.year,rating:item.rating??facts.rating}:item;
    }));
    return filled.filter(item=>passes(item,filter));
  }
  // Seerr's current labels on Plex and TMDB titles, when its API key can read the media list.
  async function labelled<T extends {items:ExploreItem[]}>(page:T):Promise<T> {
    const index=await seerr.statuses().catch(()=>undefined);if(!index)return page;
    return {...page,items:page.items.map(item=>{
      const status=item.ids.tmdb?index.get(`${item.kind}:tmdb:${item.ids.tmdb}`):undefined;
      return status?{...item,status}:item;
    })};
  }
  // One title's details from every source that knows it, its copy on this server, its watchlist state and what can be requested.
  async function details(input:z.infer<typeof ids>&{kind:'movie'|'show';title:string;year?:number;region:string;library:'true'|'false'},grant:PlexGrant,account:string,token:string):Promise<ExploreDetails> {
    const known:ExploreItem['ids']={...(input.tmdb?{tmdb:input.tmdb}:{}),...(input.imdb?{imdb:input.imdb}:{}),...(input.tvdb?{tvdb:input.tvdb}:{}),...(input.plex?{plex:input.plex}:{})};
    const type=input.kind==='movie'?'movie':'tv',library=input.library==='true';
    const tmdbDetails=(externalIds:ExploreItem['ids'])=>titleDiscovery.details(type,externalIds,input.region).catch(()=>undefined);
    const fromWatchlist=(plexId:string|undefined)=>plexId?discover.watchlisted(token,plexId).catch(()=>undefined):undefined;
    const early=known.tmdb?tmdbDetails(known):undefined,earlyWatchlist=library?undefined:fromWatchlist(known.plex);
    const meta:DiscoverMetadata|undefined=library?undefined:await (input.plex?discover.metadata(token,input.plex):discover.match(token,input.kind,known)).catch(()=>undefined);
    const plexIds={...(meta?discoverIds(meta):{}),...known};
    const tmdbInfo=await (early??tmdbDetails(plexIds));
    const merged={...tmdbInfo?.item.ids,...plexIds};
    const checkRequests=!library&&seerr.configured()&&merged.tmdb;
    const [info,watchlisted,publicSettings]=await Promise.all([
      checkRequests?seerr.details(account,token,input.kind,checkRequests).catch(()=>undefined):undefined,
      library?undefined:earlyWatchlist??fromWatchlist(merged.plex),
      checkRequests?seerr.publicSettings().catch(()=>undefined):undefined
    ]);
    const allowed=publicSettings&&{movie:!!publicSettings.movie4kEnabled,show:!!publicSettings.series4kEnabled};
    const base=tmdbInfo?.item??(meta&&discoverItem(meta));
    const item:ExploreItem={...(base??{key:`${input.kind}:${merged.tmdb?`tmdb:${merged.tmdb}`:'unknown'}`,source:'plex',kind:input.kind,title:input.title,...(input.year?{year:input.year}:{})}),ids:merged};
    const status=seerrStatus(info?.mediaInfo);
    if(status)item.status=status;
    const guids=[merged.plexGuid,merged.imdb&&`imdb://${merged.imdb}`,merged.tmdb&&`tmdb://${merged.tmdb}`,merged.tvdb&&`tvdb://${merged.tvdb}`].filter((g):g is string=>!!g);
    const matchedLibraryId=library?undefined:await plex.libraryMatch(grant,input.kind,input.title||item.title,guids).catch(()=>undefined);
    let libraryId=matchedLibraryId;
    // Seerr knows the server's rating key even when the title is named differently on the server.
    const ratingKey=info?.mediaInfo?.ratingKey;
    if(!libraryId&&ratingKey&&/^\d+$/.test(ratingKey))libraryId=await plex.catalogItem(grant,ratingKey).then(found=>found.id,()=>undefined);
    const genres=tmdbInfo?.genres.length?tmdbInfo.genres:meta?.Genre?.flatMap(g=>g.tag?[g.tag]:[])??[];
    const cast=tmdbInfo?.cast.length?tmdbInfo.cast:meta?.Role?.flatMap(r=>r.tag?[r.tag]:[]).slice(0,8)??[];
    const contentRating=tmdbInfo?.contentRating??meta?.contentRating,tagline=tmdbInfo?.tagline??meta?.tagline,network=tmdbInfo?.network??meta?.studio;
    // IMDb and Rotten Tomatoes scores are available only when Plex supplies them.
    const scores=new Map<ExternalRating['source'],ExternalRating>();
    for(const rating of [...(meta?externalRatings(meta as Parameters<typeof externalRatings>[0])??[]:[]),...(tmdbInfo?.item.rating?[{source:'tmdb' as const,score:tmdbInfo.item.rating}]:[])])if(!scores.has(rating.source))scores.set(rating.source,rating);
    const ratings=(['imdb','tomatometer','popcornmeter','tmdb'] as const).flatMap(source=>scores.get(source)??[]);
    const links:ExploreDetails['links']=[
      ...(merged.tmdb?[{site:'tmdb' as const,url:`https://www.themoviedb.org/${type}/${merged.tmdb}`}]:[]),
      ...(merged.tvdb&&input.kind==='show'?[{site:'tvdb' as const,url:`https://www.thetvdb.com/dereferrer/series/${merged.tvdb}`}]:[]),
      ...(merged.imdb?[{site:'imdb' as const,url:`https://www.imdb.com/title/${merged.imdb}/`}]:[])];
    const released=tmdbInfo?.released??(meta?.originallyAvailableAt&&/^\d{4}-\d{2}-\d{2}$/.test(meta.originallyAvailableAt)?meta.originallyAvailableAt:undefined);
    return {...tmdbInfo,item,genres,cast,released,countries:tmdbInfo?.countries??[],studios:tmdbInfo?.studios??[],providers:tmdbInfo?.providers??[],
      ratings,links,tagline,network,contentRating,...(libraryId?{libraryId}:{}),
      ...(matchedLibraryId?{matchedLibraryId}:{}),
      ...(watchlisted!==undefined?{watchlisted}:{}),...(info&&merged.tmdb?{seerr:requestState(info,input.kind,allowed)}:{})};
  }
}
// What the viewer may still request: the whole movie, or any season that is neither on the server nor requested.
function requestState(info:SeerrDetails,kind:'movie'|'show',fourK?:{movie:boolean;show:boolean}) {
  const seasons=kind==='show'?seerrSeasons(info):[],seasons4k=kind==='show'?seerrSeasons(info,true):[],status4k=seerrStatus(info.mediaInfo,true);
  const open=(list:typeof seasons,status:ReturnType<typeof seerrStatus>)=>kind==='movie'?!status:list.some(s=>!s.status);
  return {requestable:open(seasons,seerrStatus(info.mediaInfo)),requestable4k:!!fourK?.[kind]&&open(seasons4k,status4k),seasons,seasons4k,...(status4k?{status4k}:{})};
}
