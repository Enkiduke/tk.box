import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {exploreGenres,mergeRatings,RATINGS_BATCH,type ExploreDetails,type ExploreGenre,type ExploreItem,type ExploreStatus,ExplorePage,ExploreSearchResult,ExploreSources,ExternalRating} from '../../../packages/contracts/src/index.js';
import {builtInRows,isBuiltInRow,num,rowIcon,sameRowDef,setSignal,signalActive,signalUse,type ExploreParamValue,type ExploreSignalId,type ExploreAdminRow,type ExploreAdminRows,type ExploreRowDef,type ExploreRowView,type ExploreRows} from '../../../packages/contracts/src/explore-rows.js';
import {viewerCopies,type PlexAdapter,type PlexGrant} from './providers/plex.js';
import {PlexDiscover,discoverIds,discoverItem,type DiscoverMetadata} from './providers/plex-discover.js';
import {externalRatings} from './providers/plex-catalog.js';
import type {Requests} from './services/requests.js';
import type {PlexIndex} from './services/plex-index.js';
import {ExploreImages} from './providers/explore-images.js';
import {ExploreStore,exploreRowDefInput} from './persistence/explore-store.js';
import {requireThat} from './errors.js';
import {viewer as caller} from './modules/access.js';
import {TmdbExplore,sliceExplore} from './providers/tmdb-explore.js';
import type {TmdbTitles} from './providers/tmdb-titles.js';
import {TmdbTitleDiscovery} from './providers/tmdb-title-discovery.js';
import {TmdbPeople} from './providers/tmdb-people.js';
import {ExploreRecommendations,personalRows,type PersonalDefs,type PersonalRow,type WatchedTitle} from './explore-recommendations.js';
import { TtlCache } from './lib/ttl-cache.js';

const kind=z.enum(['movie','show']);
// Explore's filters, sent with every row page and search: original languages, genres, a release year range, a minimum
// score and request labels to leave out.
const filterQuery={kind:kind.optional(),lang:z.string().max(200).optional(),from:z.coerce.number().int().min(1870).max(2100).optional(),to:z.coerce.number().int().min(1870).max(2100).optional(),
  min:z.coerce.number().min(0).max(10).optional(),hide:z.string().max(40).optional(),genre:z.string().max(300).optional()};
const page=z.object({page:z.coerce.number().int().min(1).max(500).default(1),...filterQuery}).strict();
const regionCode=z.string().regex(/^[A-Z]{2}$/);
const providerId=z.string().regex(/^[1-9]\d{0,9}$/).transform(Number);
const tmdbPage=page.extend({region:regionCode.optional(),provider:z.union([z.literal('all'),providerId]).optional(),
  providers:z.string().max(131).regex(/^(?:[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,11})?$/).transform(value=>value?value.split(',').map(Number):[]).optional()});
const streamingQuery=tmdbPage.pick({region:true,provider:true,providers:true});
// One title in a batch of card ratings (see /explore/ratings/batch).
const ratingTitle=z.string().regex(/^(?:movie|show):(?:[\w-]{1,64}:(?:[1-9]\d{0,9})?|:[1-9]\d{0,9})$/);
const ids=z.object({tmdb:z.coerce.number().int().positive().optional(),imdb:z.string().regex(/^tt\d{1,12}$/).optional(),tvdb:z.coerce.number().int().positive().optional(),
  plex:z.string().regex(/^[\w-]{1,64}$/).optional()});

// Explore reads from Plex Discover and TMDB, kept briefly per viewer so moving around Explore doesn't wait on
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

// A TMDB row as Explore lists it.
export const rowView=(key:string,def:ExploreRowDef):ExploreRowView=>({key,source:'tmdb',id:key.slice(5),title:def.title,icon:rowIcon(def.source),
  ...(def.source.type==='recommendations'&&{personal:true}),...(def.source.type==='tmdb-discover'&&def.source.streaming&&{streaming:true})});
export const plexRowTtl=(row:string)=>row==='watchlist'?PAGE_MS:PUBLIC_MS;

// `genres`: a title passes with any of them. `hide`: titles with these request labels.
export type ExploreFilter={kind?:ExploreItem['kind'];languages:string[];genres?:ExploreGenre[];from?:number;to?:number;min?:number;hide?:ExploreStatus[]};
export function exploreFilter(input:{kind?:ExploreItem['kind'];lang?:string;genre?:string;from?:number;to?:number;min?:number;hide?:string}):ExploreFilter {
  const languages=[...new Set((input.lang??'').split(',').map(l=>l.trim().toLowerCase()).filter(l=>/^[a-z]{2,3}$/.test(l)))].slice(0,30);
  const hide=(['requested','downloading','partial','available'] as const).filter(s=>(input.hide??'').split(',').includes(s));
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
// A viewer's filters added to a TMDB row's own, so TMDB's query carries them and a filtered row still fills. Where the
// row has its own: year ranges meet and the higher minimum rating holds; the row's own genres and languages stay in the
// query and the viewer's are checked on what comes back (passes), so both hold.
export function withViewerFilters(def:ExploreRowDef,f:ExploreFilter):ExploreRowDef {
  let next=def;
  const set=(id:ExploreSignalId,params:Record<string,ExploreParamValue>)=>{next=setSignal(next,{id,on:true,params:{...signalUse(next,id).params,...params}});};
  if(f.genres&&!signalActive(def,'genres'))set('genres',{genres:f.genres});
  if(f.languages.length&&!signalActive(def,'languages'))set('languages',{languages:f.languages});
  if(f.from!==undefined||f.to!==undefined){
    const own=signalActive(def,'years')?signalUse(def,'years').params:undefined;
    set('years',{from:Math.max(f.from??1870,own?num(own,'from'):1870),to:Math.min(f.to??2100,own?num(own,'to'):2100)});
  }
  if(f.min!==undefined)set('minRating',{rating:Math.max(f.min,signalActive(def,'minRating')?num(signalUse(def,'minRating').params,'rating'):0)});
  return next;
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
    merged.set(item.key,{...next,ratings:mergeRatings(found.ratings,item.ratings),ids:{...item.ids,...found.ids}} as ExploreItem);
  }
  return [...merged.values()];
}
// A filtered row page reads this many of the source's pages, so filters that leave few titles still fill a row.
const FILTER_SPAN=3;

// Explore: rows, search and details from Plex Discover and TMDB, with tk.box's request labels, and the Plex watchlist.
// Requests themselves are the requests module's routes.
// One watch on this server (tk.box's history, the saved watch history), by its rating key, with the TMDB id history
// saved for it.
export type ServerWatch={kind:'movie'|'show';ratingKey:string;tmdb?:number;at:number;plays?:number;title?:string|null;year?:number|null};
// `plexTitles`: the title identity (the Plex index), for watches without a TMDB id and the server's copy of a title.
export function registerExplore(app:FastifyInstance,plex:PlexAdapter,store:ExploreStore,accountToken:(hash:string)=>string,tmdbClient:TmdbTitles,
  requests:Pick<Requests,'labels'|'connected'|'titleState'>,transports:{images?:typeof fetch}={},watches:(account:string)=>ServerWatch[]=()=>[],
  plexTitles:Pick<PlexIndex,'resolve'>={resolve:()=>undefined}) {
  const discover=new PlexDiscover(plex),images=new ExploreImages(transports.images),cache=new ExploreCache();
  // Suggestions leave out what is on the server or has a request label.
  const history=(account:string)=>watches(account).flatMap(({kind,ratingKey,tmdb,at,plays,title,year}):WatchedTitle[]=>{
    const found=tmdb?undefined:plexTitles.resolve({ratingKey}),tmdbId=tmdb??(found?.kind===kind&&found.season===undefined?found.tmdb:undefined);
    return tmdbId?[{kind,tmdbId,at,...(plays?{plays}:{}),...(title?{title}:{}),...(year?{year}:{})}]:[];
  });
  const tmdb=new TmdbExplore(tmdbClient),personal=new ExploreRecommendations(plex,tmdb,{history,excluded:()=>requests.labels()}),titleDiscovery=new TmdbTitleDiscovery(tmdbClient,tmdb),people=new TmdbPeople(tmdbClient);
  const viewer=async(request:FastifyRequest)=>{const {hash,grant}=caller(request);return {grant,account:grant.accountId,token:accountToken(hash)};};
  async function streamingScope({region,provider,providers}:z.infer<typeof streamingQuery>) {
    const country=region??'US', catalog=await tmdb.providers(country), available=new Set(catalog.providers.map(p=>p.id));
    const chosen=providers??catalog.defaults;
    requireThat(chosen.every(id=>available.has(id))&&(typeof provider!=='number'||(available.has(provider)&&(providers===undefined||chosen.includes(provider)))),
      'INVALID_PROVIDER','Choose a streaming service available in this region.',400);
    return {region:country,ids:typeof provider==='number'?[provider]:[...new Set(chosen)].sort((a,b)=>a-b)};
  }
  app.get('/api/v1/explore/sources',{config:{access:'viewer'}},async request=>{
    await viewer(request);
    return {plex:true,requests:{movie:requests.connected('movie'),show:requests.connected('show')},tmdb:{configured:tmdbClient.configured()}} satisfies ExploreSources;
  });
  app.get('/api/v1/explore/tmdb/providers',{config:{access:'viewer'}},async request=>{
    await viewer(request);
    const {region}=z.object({region:regionCode.default('US')}).strict().parse(request.query);
    return tmdb.providers(region);
  });
  // Explore's rows, in the administrator's order, less those switched off and sources not set up or unreachable.
  app.get('/api/v1/explore/rows',{config:{access:'viewer'}},async request=>{
    const {account,token}=await viewer(request),failed:ExploreRows['failed']=[];
    const shelves=await plexShelves(account,token).catch(()=>{failed.push('plex');return undefined;});
    const byId=new Map(shelves?.map(s=>[s.id,s]));
    const rows=store.arrange(shelves).flatMap(entry=>{
      if(!entry.shown||entry.slot||entry.missing)return [];
      if(entry.key.startsWith('plex:')){const shelf=byId.get(entry.key.slice(5));return shelf?[{key:entry.key,source:'plex' as const,...shelf}]:[];}
      return tmdbClient.configured()&&entry.definition?[rowView(entry.key,entry.definition)]:[];
    });
    return {rows,failed} satisfies ExploreRows;
  });
  app.get('/api/v1/explore/rows/:key',{config:{access:'viewer'}},async request=>{
    const {key}=z.object({key:z.string().max(820).regex(/^(plex|tmdb):\S+$/)}).parse(request.params),{account,token,grant}=await viewer(request);
    const entry=store.arrange().find(e=>e.key===key);
    if (key.startsWith('tmdb:')) {
      const def=entry?.shown?entry.definition:undefined;
      requireThat(def,'EXPLORE_ROW_MISSING','This Explore row is unavailable.',404);
      const streamingRow=def.source.type==='tmdb-discover'&&!!def.source.streaming;
      const {page:at,provider,providers,region,...query}=tmdbPage.parse(request.query);
      requireThat(streamingRow||(provider===undefined&&providers===undefined&&region===undefined),'INVALID_REQUEST','This row has no streaming selector.',400);
      requireThat(tmdbClient.configured(),'TMDB_KEY_MISSING','Add a TMDB key in Admin › Connections.',409);
      const filter=exploreFilter(query);
      if (def.source.type==='recommendations') {
        // Filtered, the viewer's filters run before each row is cut to its length, over a wider pool.
        // (Labelled titles are never in these rows, and each row is one kind, so `hide` and `kind` don't narrow them.)
        const {kind:_,hide:__,...narrowing}=filter,wide=filtering(narrowing);
        const defs=wide?Object.fromEntries(Object.entries(personalDefs()).map(([id,d])=>[id,withViewerFilters(d,filter)])) as PersonalDefs:personalDefs();
        const result=(await personal.get(grant,tmdbClient.credentialGeneration(),token,defs,false,wide))[key.slice(5) as PersonalRow];
        if (!result) return {items:[],page:at,hasMore:false} satisfies ExplorePage;
        // Labels are read again here, so a title requested since the day's suggestions were built drops out at once.
        const {items}=await labelled({items:result.items.map(c=>c.item)});
        return sliceExplore(result.items.map((c,index)=>({...c,item:items[index]!})).filter(c=>!c.item.status&&passes(c.item,filter)),at,result.title);
      }
      const streaming=streamingRow?await streamingScope({region,provider,providers}):undefined;
      const {kind:mediaKind,...otherFilters}=filter;
      if (!filtering(otherFilters)) return labelled(await tmdb.page(def,at,streaming,mediaKind));
      const narrowed=withViewerFilters(def,filter),pages:ExplorePage[]=[];
      for (let i=0;i<FILTER_SPAN;i++) {
        const result=await tmdb.page(narrowed,(at-1)*FILTER_SPAN+i+1,streaming,mediaKind);
        pages.push(result);
        if (!result.hasMore) break;
      }
      const {items}=await labelled({items:interleave([pages.flatMap(p=>p.items)])});
      return {items:items.filter(item=>passes(item,filter)),page:at,hasMore:!!pages.at(-1)?.hasMore} satisfies ExplorePage;
    }
    const {page:at,...query}=page.parse(request.query),filter=exploreFilter(query),id=key.slice(5);
    const shelf=(await plexShelves(account,token)).find(row=>row.id===id),shown=entry?entry.shown:store.arrange([{id}]).find(e=>e.key===key)?.shown;
    requireThat(shelf&&shown,'EXPLORE_ROW_MISSING','This Explore row is unavailable.',404);
    const read=async(n:number):Promise<ExplorePage>=>{
      const cacheKey=`row:plex:${id}:${n}`;
      return labelled(await cache.get(account,cacheKey,plexRowTtl(id),()=>discover.row(token,id,n)));
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
    const key=`search:${q.toLowerCase()}`;
    const from=(['plex','tmdb'] as const).filter(s=>(s==='plex'||tmdbClient.configured())&&(!wanted||wanted.includes(s)));
    const results=await Promise.allSettled(from.map(async s=>s==='plex'?(await labelled({items:await cache.get(account,`plex:${key}`,SEARCH_MS,()=>discover.search(token,q))})).items
      :(await labelled({items:await tmdb.search(q,filter.kind)})).items));
    const failed=from.filter((_,i)=>results[i]!.status==='rejected');
    requireThat(!from.length||failed.length<from.length,'EXPLORE_UNAVAILABLE','Search is unavailable right now. Try again in a moment.',502);
    const items=interleave(results.map(r=>r.status==='fulfilled'?r.value:[]));
    return {items:filtering(filter)?await filtered(items,filter):items,failed} satisfies ExploreSearchResult;
  });
  // Visible posters need only scores. Opening a title also reads its watchlist, library and request state.
  // A card's scores Plex or TMDB left out of its row: from the title's Discover metadata, and TMDB's own score.
  const ratingsOf=(account:string,token:string,input:{kind:'movie'|'show';plex?:string;tmdb?:number})=>
    cache.get(account,`ratings:${tmdbClient.credentialGeneration()}:${input.kind}:${input.plex??''}:${input.tmdb??''}`,DETAILS_MS,async()=>{
      const meta=input.plex?await discover.metadata(token,input.plex):await discover.match(token,input.kind,{tmdb:input.tmdb});
      let ratings=meta?externalRatings(meta)??[]:[];
      if(!input.plex&&meta?.ratingKey&&(!ratings.some(r=>r.source==='imdb')||!ratings.some(r=>r.source==='tomatometer'))){
        const full=await discover.metadata(token,meta.ratingKey).catch(()=>undefined);
        if(full)ratings=mergeRatings(externalRatings(full),ratings);
      }
      const tmdb=input.tmdb??(meta&&discoverIds(meta).tmdb);
      if(input.plex&&tmdb&&tmdbClient.configured()&&!ratings.some(r=>r.source==='tmdb')){
        const title=await tmdbClient.get(`/${input.kind==='show'?'tv':'movie'}/${tmdb}`).catch(()=>undefined) as {vote_average?:number}|undefined;
        const score=title?.vote_average;
        if(typeof score==='number'&&score>0&&score<=10)ratings.push({source:'tmdb',score});
      }
      return ratings;
    });
  app.get('/api/v1/explore/ratings',{config:{access:'viewer',rateLimit:{max:600,timeWindow:60000}}},async request=>{
    const input=ids.pick({plex:true,tmdb:true}).extend({kind}).strict().parse(request.query);
    requireThat(input.plex||input.tmdb,'INVALID_REQUEST','Choose a title.',400);
    const {account,token}=await viewer(request);
    return ratingsOf(account,token,input);
  });
  // The cards on screen in one request: each `t` is `kind:plex:tmdb` (either ID may be empty), answered under the same
  // string. A title whose lookup fails comes back with no scores rather than failing the rest.
  app.get('/api/v1/explore/ratings/batch',{config:{access:'viewer',rateLimit:{max:300,timeWindow:60000}}},async request=>{
    const {t}=z.object({t:z.union([ratingTitle,z.array(ratingTitle).min(1).max(RATINGS_BATCH)])}).strict().parse(request.query);
    const titles=[...new Set(Array.isArray(t)?t:[t])],{account,token}=await viewer(request),ratings:Record<string,ExternalRating[]>={};
    // All at once, as the cards' own requests were: the batch answers when its slowest title does.
    await Promise.all(titles.map(async title=>{
      const [media,plex,tmdb]=title.split(':') as ['movie'|'show',string,string];
      ratings[title]=await ratingsOf(account,token,{kind:media,...(plex?{plex}:{}),...(tmdb?{tmdb:Number(tmdb)}:{})}).catch(()=>[]);
    }));
    return {ratings};
  });
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
  app.put('/api/v1/explore/watchlist',{config:{access:'viewer',rateLimit:{max:60,timeWindow:60000}}},async request=>{
    const input=z.object({plex:z.string().regex(/^[\w-]{1,64}$/),add:z.boolean()}).strict().parse(request.body),{account,token}=await viewer(request);
    await discover.setWatchlisted(token,input.plex,input.add);cache.forget(account);return {watchlisted:input.add};
  });
  app.get('/api/v1/explore/image',{config:{access:'viewer',rateLimit:{max:1200,timeWindow:60000}}},async(request,reply)=>{
    const {u}=z.object({u:z.string().max(2000)}).strict().parse(request.query);
    const image=await images.get(u);
    return reply.type(image.type).header('Cache-Control','private, max-age=86400').send(image.bytes);
  });
  // A person's page: by TMDB ID, or by name (and the title they were listed in) for cast Plex named without one.
  app.get('/api/v1/explore/people',{config:{access:'viewer',rateLimit:{max:120,timeWindow:60000}}},async request=>{
    const input=z.object({id:z.coerce.number().int().positive().optional(),name:z.string().trim().min(1).max(200).optional(),
      kind:kind.optional(),tmdb:z.coerce.number().int().positive().optional()}).strict().parse(request.query);
    await viewer(request);
    requireThat(tmdbClient.configured(),'TMDB_KEY_MISSING','Add a TMDB key in Admin › Connections.',409);
    requireThat(input.id||input.name,'INVALID_REQUEST','Choose a person.',400);
    const id=input.id??await titleDiscovery.personId(input.name!,input.kind==='show'?'tv':input.kind,input.tmdb);
    const person=id?await people.details(id,labelItems):undefined;
    requireThat(person,'PERSON_MISSING','TMDB has no page for this person.',404);
    return person;
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
  // Admin › Explore: every row in order, shown or not, Plex's shelves as the administrator sees them.
  app.get('/api/v1/admin/explore/rows',{config:{access:'admin'}},async request=>{
    const {hash,grant}=caller(request),token=accountToken(hash);
    let plexError:string|undefined;
    const shelves=await plexShelves(grant.accountId,token).catch(()=>{plexError='Plex Discover could not list its shelves.';return undefined;});
    if (shelves) store.placeShelves(shelves);
    const byId=new Map(shelves?.map(s=>[s.id,s])),configured=tmdbClient.configured();
    const rows=store.arrange(shelves).flatMap((entry):ExploreAdminRow[]=>{
      if (entry.slot) return [];
      if (entry.key.startsWith('plex:')) {
        const shelf=byId.get(entry.key.slice(5));
        return [{key:entry.key,source:'plex',id:entry.key.slice(5),title:shelf?.title??entry.key.slice(5),icon:shelf?.icon??'trending',shown:entry.shown,builtIn:true,customized:false,
          ...(shelf?.personal&&{personal:true}),...(entry.missing&&{missing:true})}];
      }
      const def=entry.definition!,id=entry.key.slice(5),defaults=isBuiltInRow(id)?builtInRows[id]:undefined;
      return [{...rowView(entry.key,def),shown:entry.shown,builtIn:!!defaults,customized:!!defaults&&!sameRowDef(def,defaults),definition:def,
        ...(defaults&&{defaults}),revision:entry.revision,...(!configured&&{unavailable:true})}];
    });
    return {rows,tmdbConfigured:configured,...(plexError&&{plexError})} satisfies ExploreAdminRows;
  });
  const rowKey=z.object({key:z.string().max(820).regex(/^(plex|tmdb):\S+$/)});
  app.put('/api/v1/admin/explore/rows/order',{config:{access:'admin'}},async request=>{
    const {grant}=caller(request),{keys}=z.object({keys:z.array(z.string().max(820)).max(400)}).strict().parse(request.body);
    store.setOrder(grant.accountId,keys);cache.forget();
    return {status:'saved'};
  });
  app.put('/api/v1/admin/explore/rows/:key',{config:{access:'admin'}},async request=>{
    const {grant}=caller(request),{key}=rowKey.parse(request.params);
    const body=z.object({shown:z.boolean().optional(),expectedRevision:z.number().int().nonnegative().optional(),definition:z.unknown().optional()}).strict().parse(request.body);
    let revision:number|undefined;
    if (body.definition!==undefined) {
      requireThat(body.expectedRevision!==undefined,'INVALID_REQUEST','Send the revision you edited.',400);
      revision=store.setDefinition(grant.accountId,key,body.expectedRevision,body.definition);
    }
    if (body.shown!==undefined) store.setShown(grant.accountId,key,body.shown);
    cache.forget();
    return {status:'saved',...(revision!==undefined&&{revision})};
  });
  app.post('/api/v1/admin/explore/rows',{config:{access:'admin'}},async request=>{
    const {grant}=caller(request),{definition,after}=z.object({definition:z.unknown(),after:z.string().max(820).optional()}).strict().parse(request.body);
    const key=store.create(grant.accountId,definition,after);cache.forget();
    return {key};
  });
  app.delete('/api/v1/admin/explore/rows/:key',{config:{access:'admin'}},async request=>{
    const {grant}=caller(request),{key}=rowKey.parse(request.params);
    store.remove(grant.accountId,key);cache.forget();
    return {status:'deleted'};
  });
  // The top 20 of a TMDB row as saved and as drafted, for the row dialog. Personal rows use the administrator's own history.
  app.post('/api/v1/admin/explore/rows/:key/preview',{config:{access:'admin',rateLimit:{max:60,timeWindow:60000}}},async request=>{
    const {grant,token}=await viewer(request),{key}=rowKey.parse(request.params);
    const draft=exploreRowDefInput.parse(z.object({definition:z.unknown()}).strict().parse(request.body).definition);
    const query=streamingQuery.parse(request.query),saved=store.arrange().find(e=>e.key===key)?.definition;
    requireThat(tmdbClient.configured(),'TMDB_KEY_MISSING','Add a TMDB key in Admin › Connections.',409);
    const streamingOf=(def:ExploreRowDef)=>def.source.type==='tmdb-discover'&&def.source.streaming?streamingScope(query):Promise.resolve(undefined);
    const read=async (def:ExploreRowDef|undefined,isPreview:boolean)=>{
      if (!def) return [];
      if (def.source.type!=='recommendations') return (await labelled(await tmdb.page(def,1,await streamingOf(def)))).items.slice(0,20);
      const result=(await personal.get(grant,tmdbClient.credentialGeneration(),token,{...personalDefs(),[key.slice(5)]:def},isPreview))[key.slice(5) as PersonalRow];
      const {items}=await labelled({items:result?.items.map(c=>c.item)??[]});
      return items.filter(item=>!item.status).slice(0,20);
    };
    const [before,after]=await Promise.all([read(saved,false),read(draft,true)]);
    return {saved:before,draft:after};
  });

  // A request changed: details (what can still be requested) are read again.
  const forget=()=>cache.forget();

  function plexShelves(account:string,token:string) {return cache.get(account,'plex:rows',ROWS_MS,()=>discover.rows(token));}
  function personalDefs():PersonalDefs {
    return Object.fromEntries(personalRows.map(id=>[id,store.definition(`tmdb:${id}`)??builtInRows[id]])) as PersonalDefs;
  }
  // Use the cached TMDB title when Plex omits a field required by the filter.
  async function filtered(items:ExploreItem[],filter:ExploreFilter) {
    const filled=await Promise.all(items.filter(item=>!filter.kind||item.kind===filter.kind).map(async item=>{
      if(!lacking(item,filter)||!item.ids.tmdb||!tmdbClient.configured())return item;
      const facts=(await titleDiscovery.details(item.kind==='show'?'tv':'movie',item.ids,'US').catch(()=>undefined))?.item;
      return facts?{...item,language:item.language??facts.language,genres:item.genres?.length?item.genres:facts.genres,year:item.year??facts.year,rating:item.rating??facts.rating,ratings:mergeRatings(item.ratings,facts.ratings)}:item;
    }));
    return filled.filter(item=>passes(item,filter));
  }
  // tk.box's request labels on Plex and TMDB titles: on this server, partly, downloading or requested.
  async function labelled<T extends {items:ExploreItem[]}>(page:T):Promise<T> {
    return {...page,items:labelItems(page.items)};
  }
  function labelItems(items:ExploreItem[]) {
    const index=requests.labels();
    return items.map(item=>{
      const status=item.ids.tmdb?index.get(`${item.kind}:tmdb:${item.ids.tmdb}`):undefined;
      return status?{...item,status}:item;
    });
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
    const checkRequests=!library&&requests.connected(input.kind)&&merged.tmdb;
    const [state,watchlisted]=await Promise.all([
      checkRequests?requests.titleState(input.kind,checkRequests,merged.tvdb).catch(()=>undefined):undefined,
      library?undefined:earlyWatchlist??fromWatchlist(merged.plex)
    ]);
    const base=tmdbInfo?.item??(meta&&discoverItem(meta));
    const item:ExploreItem={...(base??{key:`${input.kind}:${merged.tmdb?`tmdb:${merged.tmdb}`:'unknown'}`,source:'plex',kind:input.kind,title:input.title,...(input.year?{year:input.year}:{})}),ids:merged};
    const status=merged.tmdb?requests.labels().get(`${input.kind}:tmdb:${merged.tmdb}`):undefined;
    if(status)item.status=status;
    // The server's copy, from the title identity, opened with the viewer's own grant: a library they can't see gives none.
    const resolved=library?undefined:merged.tmdb?plexTitles.resolve({kind:input.kind,tmdb:merged.tmdb,tvdb:merged.tvdb}):input.kind==='show'&&merged.tvdb?plexTitles.resolve({tvdb:merged.tvdb}):undefined;
    let libraryId:string|undefined;
    for(const ratingKey of resolved?.copies?viewerCopies(grant,resolved.copies):[]){
      libraryId=/^\d+$/.test(ratingKey)?await plex.catalogItem(grant,ratingKey).then(found=>found.id,()=>undefined):undefined;
      if(libraryId)break;
    }
    const matchedLibraryId=libraryId;
    const genres=tmdbInfo?.genres.length?tmdbInfo.genres:meta?.Genre?.flatMap(g=>g.tag?[g.tag]:[])??[];
    const cast=tmdbInfo?.cast.length?tmdbInfo.cast:meta?.Role?.flatMap(r=>r.tag?[r.tag]:[]).slice(0,8)??[];
    const contentRating=tmdbInfo?.contentRating??meta?.contentRating,tagline=tmdbInfo?.tagline??meta?.tagline,network=tmdbInfo?.network??meta?.studio;
    // IMDb and Rotten Tomatoes scores are available only when Plex supplies them.
    const scores=new Map<ExternalRating['source'],ExternalRating>();
    for(const rating of mergeRatings(meta?externalRatings(meta):undefined,tmdbInfo?.item.ratings))scores.set(rating.source,rating);
    const ratings=(['imdb','tomatometer','popcornmeter','tmdb'] as const).flatMap(source=>scores.get(source)??[]);
    const links:ExploreDetails['links']=[
      ...(merged.tmdb?[{site:'tmdb' as const,url:`https://www.themoviedb.org/${type}/${merged.tmdb}`}]:[]),
      ...(merged.tvdb&&input.kind==='show'?[{site:'tvdb' as const,url:`https://www.thetvdb.com/dereferrer/series/${merged.tvdb}`}]:[]),
      ...(merged.imdb?[{site:'imdb' as const,url:`https://www.imdb.com/title/${merged.imdb}/`}]:[])];
    const released=tmdbInfo?.released??(meta?.originallyAvailableAt&&/^\d{4}-\d{2}-\d{2}$/.test(meta.originallyAvailableAt)?meta.originallyAvailableAt:undefined);
    return {...tmdbInfo,item,genres,cast,released,countries:tmdbInfo?.countries??[],studios:tmdbInfo?.studios??[],providers:tmdbInfo?.providers??[],
      ratings,links,tagline,network,contentRating,...(libraryId?{libraryId}:{}),
      ...(matchedLibraryId?{matchedLibraryId}:{}),
      ...(watchlisted!==undefined?{watchlisted}:{}),...(state?{request:state}:{})};
  }
  return {forget};
}
