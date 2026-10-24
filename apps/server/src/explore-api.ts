import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {ExploreDetails,ExploreItem,ExploreSources,ExternalRating} from '../../../packages/contracts/src/index.js';
import type {PlexAdapter,PlexGrant} from './providers/plex.js';
import {PlexDiscover,discoverIds,discoverItem,type DiscoverMetadata} from './providers/plex-discover.js';
import {externalRatings} from './providers/plex-catalog.js';
import {Seerr,seerrFacts,seerrCertificate,seerrItem,seerrRows,seerrSeasons,seerrStatus,type SeerrDetails} from './providers/seerr.js';
import {Trakt} from './providers/trakt.js';
import {ExploreImages} from './providers/explore-images.js';
import {ExploreStore,exploreSettingsInput} from './persistence/explore-store.js';
import {requireThat} from './errors.js';

type Viewer={hash:string;grant:PlexGrant};
const source=z.enum(['plex','seerr','trakt']);
const kind=z.enum(['movie','show']);
const page=z.object({page:z.coerce.number().int().min(1).max(500).default(1)}).strict();
const ids=z.object({tmdb:z.coerce.number().int().positive().optional(),imdb:z.string().regex(/^tt\d{1,12}$/).optional(),tvdb:z.coerce.number().int().positive().optional(),
  plex:z.string().regex(/^[\w-]{1,64}$/).optional()});

// Explore reads from Plex Discover, Seerr and Trakt, kept briefly per viewer so moving around Explore doesn't wait on
// three outside services again. A viewer's own change (watchlist, request, Trakt link, Refresh) drops their copies,
// and a settings change drops everyone's. Failed reads are not kept.
const ROWS_MS=15*60000,PAGE_MS=10*60000,DETAILS_MS=10*60000,SEARCH_MS=5*60000,PERSON_MS=24*3600000;
export class ExploreCache {
  private entries=new Map<string,{until:number;value:Promise<unknown>}>();
  get<T>(account:string,key:string,ttl:number,read:()=>Promise<T>,now=Date.now()):Promise<T> {
    const id=`${account}
${key}`,hit=this.entries.get(id);if(hit&&hit.until>now)return hit.value as Promise<T>;
    const value=read();this.entries.delete(id);this.entries.set(id,{until:now+ttl,value});
    value.catch(()=>{if(this.entries.get(id)?.value===value)this.entries.delete(id);});
    while(this.entries.size>2000)this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  forget(account?:string) {if(account===undefined){this.entries.clear();return;}for(const id of [...this.entries.keys()])if(id.startsWith(`${account}
`))this.entries.delete(id);}
}

// Explore: rows, search and details from Plex Discover, Seerr and Trakt, plus Seerr requests and the Plex watchlist.
export function registerExplore(app:FastifyInstance,plex:PlexAdapter,store:ExploreStore,auth:(request:FastifyRequest)=>Promise<Viewer>,admin:(request:FastifyRequest)=>Promise<Viewer>,accountToken:(hash:string)=>string) {
  const discover=new PlexDiscover(plex),seerr=new Seerr(()=>store.seerr()),trakt=new Trakt(store),images=new ExploreImages(),cache=new ExploreCache();
  const viewer=async(request:FastifyRequest)=>{const {hash,grant}=await auth(request);return {grant,account:grant.accountId,token:accountToken(hash)};};
  app.get('/api/v1/explore/sources',async request=>{
    // Nobody is signed in to Seerr here; that waits until they request something.
    const {account}=await viewer(request);
    const result:ExploreSources={plex:true,seerr:{configured:seerr.configured(),statuses:seerr.hasKey()},trakt:{configured:trakt.configured(),linked:false}};
    const traktUser=trakt.linked(account);if(traktUser)result.trakt={configured:true,linked:true,user:traktUser};
    return result;
  });
  app.get('/api/v1/explore/:source/rows',async request=>{
    const {source:from}=z.object({source}).parse(request.params),{account,token}=await viewer(request);
    if(from==='plex')return {rows:await cache.get(account,'plex:rows',ROWS_MS,()=>discover.rows(token))};
    if(from==='seerr'){requireThat(seerr.configured(),'SEERR_NOT_CONFIGURED','Seerr is not set up.',409);return {rows:seerrRows.map(({id,title,icon})=>({id,title,icon}))};}
    requireThat(trakt.configured(),'TRAKT_NOT_CONFIGURED','Trakt is not set up.',409);
    return {rows:trakt.rows(account).map(({id,title,icon,...rest})=>({id,title,icon,...('personal' in rest?{personal:true}:{})}))};
  });
  app.get('/api/v1/explore/:source/rows/:row',async request=>{
    const params=z.object({source,row:z.string().max(800)}).parse(request.params),{page:at}=page.parse(request.query),{account,token}=await viewer(request);
    // Seerr's labels are applied after the cache, so they follow requests as they are made.
    const key=`row:${params.source}:${params.row}:${at}`;
    return params.source==='plex'?labelled(await cache.get(account,key,PAGE_MS,()=>discover.row(token,params.row,at))):params.source==='seerr'?cache.get(account,key,PAGE_MS,()=>seerr.row(account,token,params.row,at)):labelled(await cache.get(account,key,PAGE_MS,()=>trakt.row(account,params.row,at)));
  });
  app.get('/api/v1/explore/:source/search',{config:{rateLimit:{max:60,timeWindow:60000}}},async request=>{
    const {source:from}=z.object({source}).parse(request.params),{q}=z.object({q:z.string().trim().min(1).max(120)}).strict().parse(request.query),{account,token}=await viewer(request);
    const key=`search:${from}:${q.toLowerCase()}`;
    return {items:from==='plex'?(await labelled({items:await cache.get(account,key,SEARCH_MS,()=>discover.search(token,q))})).items:from==='seerr'?await cache.get(account,key,SEARCH_MS,()=>seerr.search(account,token,q)):(await labelled({items:await cache.get(account,key,SEARCH_MS,()=>trakt.search(q))})).items};
  });
  // Signs the viewer in to Seerr (with their Plex account) when they go to request, and says what they may request.
  app.get('/api/v1/explore/seerr/account',async request=>{const {account,token}=await viewer(request);return seerr.account(account,token);});
  app.get('/api/v1/explore/seerr/options',async request=>{
    const input=z.object({kind,is4k:z.enum(['true','false']).default('false'),server:z.coerce.number().int().nonnegative().optional()}).strict().parse(request.query),{account,token}=await viewer(request);
    return seerr.options(account,token,input.kind,input.is4k==='true',input.server);
  });
  app.get('/api/v1/explore/seerr/users',async request=>{const {account,token}=await viewer(request);return {users:await seerr.users(account,token)};});
  app.get('/api/v1/explore/details',async request=>{
    const input=ids.extend({kind,title:z.string().max(300).default(''),year:z.coerce.number().int().optional()}).strict().parse(request.query),{grant,account,token}=await viewer(request);
    return cache.get(account,`details:${JSON.stringify(input)}`,DETAILS_MS,()=>details(input,grant,account,token));
  });
  app.post('/api/v1/explore/request',{config:{rateLimit:{max:20,timeWindow:60000}}},async request=>{
    const input=z.object({kind,tmdb:z.number().int().positive(),seasons:z.array(z.number().int().positive()).max(100).optional(),is4k:z.boolean().default(false),
      serverId:z.number().int().nonnegative().optional(),profileId:z.number().int().nonnegative().optional(),rootFolder:z.string().min(1).max(500).optional(),
      languageProfileId:z.number().int().nonnegative().optional(),tags:z.array(z.number().int().nonnegative()).max(50).optional(),userId:z.number().int().positive().optional()}).strict().parse(request.body),{account,token}=await viewer(request);
    const {kind:media,tmdb,seasons,is4k,...extras}=input;
    await seerr.request(account,token,media,tmdb,seasons,is4k,extras);cache.forget();return {status:'requested'};
  });
  app.put('/api/v1/explore/watchlist',{config:{rateLimit:{max:60,timeWindow:60000}}},async request=>{
    const input=z.object({plex:z.string().regex(/^[\w-]{1,64}$/),add:z.boolean()}).strict().parse(request.body),{account,token}=await viewer(request);
    await discover.setWatchlisted(token,input.plex,input.add);cache.forget(account);return {watchlisted:input.add};
  });
  app.get('/api/v1/explore/image',{config:{rateLimit:{max:1200,timeWindow:60000}}},async(request,reply)=>{
    const {u}=z.object({u:z.string().max(2000)}).strict().parse(request.query);await auth(request);
    const image=await images.get(u);
    return reply.type(image.type).header('Cache-Control','private, max-age=86400').send(image.bytes);
  });
  // A cast or crew name in a details view opens here and is sent on to the person's IMDb page, or to IMDb's search
  // for the name when Seerr is not set up or does not know them. People don't change, so lookups are shared and kept a day.
  app.get('/api/v1/explore/person',{config:{rateLimit:{max:60,timeWindow:60000}}},async(request,reply)=>{
    const input=z.object({name:z.string().trim().min(1).max(200),kind:kind.optional(),tmdb:z.coerce.number().int().positive().optional()}).strict().parse(request.query),{account,token}=await viewer(request);
    const title=input.kind&&input.tmdb?{kind:input.kind,tmdb:input.tmdb}:undefined;
    const imdb=seerr.configured()?await cache.get('',`person:${input.name.toLowerCase()}:${title?`${title.kind}:${title.tmdb}`:''}`,PERSON_MS,()=>seerr.imdbPerson(account,token,input.name,title)).catch(()=>undefined):undefined;
    return reply.header('Cache-Control',imdb?'private, max-age=86400':'no-store').redirect(imdb?`https://www.imdb.com/name/${imdb}/`:`https://www.imdb.com/find/?q=${encodeURIComponent(input.name)}&s=nm&exact=true`);
  });
  // A library title's Rotten Tomatoes score opens here and is sent on to its page, which only Seerr knows, or to
  // Rotten Tomatoes' search for the title.
  app.get('/api/v1/explore/rottentomatoes',{config:{rateLimit:{max:60,timeWindow:60000}}},async(request,reply)=>{
    const input=z.object({title:z.string().trim().min(1).max(300),kind:kind.optional(),tmdb:z.coerce.number().int().positive().optional()}).strict().parse(request.query),{account,token}=await viewer(request);
    const url=seerr.configured()&&input.kind&&input.tmdb?(await cache.get('',`rt:${input.kind}:${input.tmdb}`,PERSON_MS,()=>seerr.ratings(account,token,input.kind!,input.tmdb!)).catch(()=>undefined))?.url:undefined;
    return reply.header('Cache-Control',url?'private, max-age=86400':'no-store').redirect(url??`https://www.rottentomatoes.com/search?search=${encodeURIComponent(input.title)}`);
  });
  app.post('/api/v1/explore/trakt/link',{config:{rateLimit:{max:10,timeWindow:60000}}},async request=>{const {account}=await viewer(request);return trakt.startLink(account);});
  app.post('/api/v1/explore/trakt/link/poll',async request=>{const {account}=await viewer(request);const result=await trakt.pollLink(account);cache.forget(account);return result;});
  app.delete('/api/v1/explore/trakt/link',async request=>{const {account}=await viewer(request);await trakt.unlink(account);cache.forget(account);return {status:'unlinked'};});
  // Explore's Refresh button: the viewer's next reads go back to the services.
  app.post('/api/v1/explore/refresh',{config:{rateLimit:{max:30,timeWindow:60000}}},async request=>{const {account}=await viewer(request);cache.forget(account);return {status:'refreshed'};});
  app.get('/api/v1/admin/explore/settings',async request=>{await admin(request);return store.view();});
  app.put('/api/v1/admin/explore/settings',async request=>{
    const {grant}=await admin(request),{expectedRevision,...value}=exploreSettingsInput.extend({expectedRevision:z.number().int().nonnegative()}).strict().parse(request.body);
    // A Seerr address is checked before it is saved, so viewers never get a dead Explore source.
    if(value.seerrUrl){
      await seerr.publicSettings(value.seerrUrl,true);
      const key=value.seerrApiKey??store.seerrKey();if(key)await seerr.checkKey(value.seerrUrl,key);
    }
    const saved=store.update(grant.accountId,expectedRevision,value);cache.forget();return saved;
  });

  // Seerr's labels on Plex and Trakt titles, when the API key lets the server read Seerr's media list.
  async function labelled<T extends {items:ExploreItem[]}>(page:T):Promise<T> {
    const index=await seerr.statuses().catch(()=>undefined);if(!index)return page;
    return {...page,items:page.items.map(item=>{const status=item.ids.tmdb?index.get(`${item.kind}:tmdb:${item.ids.tmdb}`):undefined;return status?{...item,status}:item;})};
  }
  // One title's details from every source that knows it, its copy on this server, its watchlist state and what can be requested.
  async function details(input:z.infer<typeof ids>&{kind:'movie'|'show';title:string;year?:number},grant:PlexGrant,account:string,token:string):Promise<ExploreDetails> {
    const known:ExploreItem['ids']={...(input.tmdb?{tmdb:input.tmdb}:{}),...(input.imdb?{imdb:input.imdb}:{}),...(input.tvdb?{tvdb:input.tvdb}:{}),...(input.plex?{plex:input.plex}:{})};
    // Seerr's reads and the watchlist state start as soon as their IDs are known: at once when the page sent them,
    // otherwise once Plex Discover has matched the title.
    const fromSeerr=(tmdb:number|undefined)=>seerr.configured()&&tmdb?[seerr.details(account,token,input.kind,tmdb).catch(()=>undefined),seerr.publicSettings().catch(()=>undefined),seerr.ratings(account,token,input.kind,tmdb)] as const:undefined;
    const fromWatchlist=(plexId:string|undefined)=>plexId?discover.watchlisted(token,plexId).catch(()=>undefined):undefined;
    const early=fromSeerr(known.tmdb),earlyWatchlist=fromWatchlist(known.plex);
    const meta:DiscoverMetadata|undefined=await (input.plex?discover.metadata(token,input.plex):discover.match(token,input.kind,known)).catch(()=>undefined);
    const merged={...(meta?discoverIds(meta):{}),...known};
    const seerrReads=early??fromSeerr(merged.tmdb);
    const [info,watchlisted,publicSettings,rt]=await Promise.all([seerrReads?.[0],earlyWatchlist??fromWatchlist(merged.plex),seerrReads?.[1],seerrReads?.[2]]);
    const allowed=publicSettings&&{movie:!!publicSettings.movie4kEnabled,show:!!publicSettings.series4kEnabled};
    if(info?.externalIds?.imdbId&&!merged.imdb)merged.imdb=info.externalIds.imdbId;
    if(info?.imdbId&&!merged.imdb)merged.imdb=info.imdbId;
    if(info?.externalIds?.tvdbId&&!merged.tvdb)merged.tvdb=info.externalIds.tvdbId;
    const base=(info&&seerrItem(info,input.kind==='show'?'tv':'movie'))??(meta&&discoverItem(meta));
    const item:ExploreItem={...(base??{key:`${input.kind}:${merged.tmdb?`tmdb:${merged.tmdb}`:'unknown'}`,source:'plex',kind:input.kind,title:input.title,...(input.year?{year:input.year}:{})}),ids:merged};
    const guids=[merged.plexGuid,merged.imdb&&`imdb://${merged.imdb}`,merged.tmdb&&`tmdb://${merged.tmdb}`,merged.tvdb&&`tvdb://${merged.tvdb}`].filter((g):g is string=>!!g);
    let libraryId=await plex.libraryMatch(grant,input.kind,item.title,guids).catch(()=>undefined);
    // Seerr knows the server's rating key even when the title is named differently on the server.
    const ratingKey=info?.mediaInfo?.ratingKey;
    if(!libraryId&&ratingKey&&/^\d+$/.test(ratingKey))libraryId=await plex.catalogItem(grant,ratingKey).then(found=>found.id,()=>undefined);
    const genres=info?.genres?.map(g=>g.name)??meta?.Genre?.flatMap(g=>g.tag?[g.tag]:[])??[];
    const cast=(info?.credits?.cast?.flatMap(c=>c.name?[c.name]:[])??meta?.Role?.flatMap(r=>r.tag?[r.tag]:[])??[]).slice(0,8);
    const runtime=info?.runtime??info?.episodeRunTime?.[0];
    if(runtime&&!item.durationMs)item.durationMs=runtime*60000;
    if(info?.numberOfEpisodes&&!item.episodeCount)item.episodeCount=info.numberOfEpisodes;
    const contentRating=info?seerrCertificate(info,input.kind):meta?.contentRating,tagline=info?.tagline||meta?.tagline,network=info?.networks?.[0]?.name??meta?.studio;
    // Plex's scores first, as in the library; Seerr fills in sources Plex did not send.
    const scores=new Map<ExternalRating['source'],ExternalRating>();
    for(const rating of [...(meta?externalRatings(meta as Parameters<typeof externalRatings>[0])??[]:[]),...(rt?.ratings??[]),...(info?.voteAverage?[{source:'tmdb' as const,score:info.voteAverage}]:[])])if(!scores.has(rating.source))scores.set(rating.source,rating);
    const ratings=(['imdb','tomatometer','popcornmeter','tmdb'] as const).flatMap(source=>scores.get(source)??[]);
    const type=input.kind==='movie'?'movie':'tv';
    const links:ExploreDetails['links']=[
      ...(merged.tmdb?[{site:'tmdb' as const,url:`https://www.themoviedb.org/${type}/${merged.tmdb}`}]:[]),
      ...(merged.tvdb&&input.kind==='show'?[{site:'tvdb' as const,url:`https://www.thetvdb.com/dereferrer/series/${merged.tvdb}`}]:[]),
      ...(merged.imdb?[{site:'imdb' as const,url:`https://www.imdb.com/title/${merged.imdb}/`}]:[]),
      ...(rt?.url?[{site:'rottentomatoes' as const,url:rt.url}]:[]),
      ...(merged.tmdb?[{site:'trakt' as const,url:`https://trakt.tv/search/tmdb/${merged.tmdb}?id_type=${input.kind}`}]:[])];
    const facts=info?seerrFacts(info,input.kind,publicSettings?.region||'US'):{...(meta?.originallyAvailableAt&&/^\d{4}-\d{2}-\d{2}$/.test(meta.originallyAvailableAt)?{released:meta.originallyAvailableAt}:{})};
    return {item,genres,cast,countries:[],studios:[],providers:[],...facts,ratings,links,...(tagline?{tagline}:{}),...(network?{network}:{}),...(contentRating?{contentRating}:{}),...(libraryId?{libraryId}:{}),
      ...(watchlisted!==undefined?{watchlisted}:{}),...(info&&merged.tmdb?{seerr:requestState(info,input.kind,allowed)}:{})};
  }
}
// What the viewer may still request: the whole movie, or any season that is neither on the server nor requested.
function requestState(info:SeerrDetails,kind:'movie'|'show',fourK?:{movie:boolean;show:boolean}) {
  const seasons=kind==='show'?seerrSeasons(info):[],seasons4k=kind==='show'?seerrSeasons(info,true):[],status4k=seerrStatus(info.mediaInfo,true);
  const open=(list:typeof seasons,status:ReturnType<typeof seerrStatus>)=>kind==='movie'?!status:list.some(s=>!s.status);
  return {requestable:open(seasons,seerrStatus(info.mediaInfo)),requestable4k:!!fourK?.[kind]&&open(seasons4k,status4k),seasons,seasons4k,...(status4k?{status4k}:{})};
}
