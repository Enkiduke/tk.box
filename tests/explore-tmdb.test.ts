import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {ZodError} from 'zod';
import {AppError} from '../apps/server/src/errors.js';
import {registerExplore} from '../apps/server/src/explore-api.js';
import {ExploreRecommendations,rankCandidates,selectSeeds} from '../apps/server/src/explore-recommendations.js';
import {ExploreStore,tmdbRowOrder} from '../apps/server/src/persistence/explore-store.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {PlexAdapter,type PlexGrant} from '../apps/server/src/providers/plex.js';
import {TmdbExplore,tmdbCandidate} from '../apps/server/src/providers/tmdb-explore.js';
import {TmdbTitles} from '../apps/server/src/providers/tmdb-titles.js';
import {parseExplorePrefs} from '../apps/web/src/explore-prefs.js';
import {config} from './fixtures.js';

const now = Date.parse('2026-11-13T00:00:00Z');
const grant: PlexGrant = {accountId:'1', role:'admin', serverToken:'server', libraries:[{key:'10',title:'Movies',type:'movie'},{key:'20',title:'Shows',type:'show'}]};
const movie = (id:number,title=`Movie ${id}`) => ({id,title,release_date:'2026-10-01',genre_ids:[18],vote_average:8,vote_count:100,popularity:10,original_language:'en'});

test('TMDB routes validate auth and regional providers, combine media types, apply filters and retry failed pages',async t=>{
  const calls:URL[]=[];
  let key:string|undefined='fixture-key', failed=false;
  const client=new TmdbTitles(()=>key,(async input=>{
    const url=new URL(String(input));calls.push(url);
    if(url.searchParams.get('api_key')==='invalid')return Response.json({}, {status:401});
    if(url.pathname.endsWith('/regions'))return Response.json({results:[{iso_3166_1:'US',english_name:'United States'}]});
    if(url.pathname.includes('/watch/providers/'))return Response.json({results:[
      {provider_id:8,provider_name:'Netflix'},{provider_id:9,provider_name:'Amazon Prime Video'},
      {provider_id:10,provider_name:'Disney Plus'},{provider_id:11,provider_name:'Peacock Premium Plus'},
      {provider_id:12,provider_name:'Paramount Plus Premium'},{provider_id:13,provider_name:'Paramount Plus Amazon Channel'},
      {provider_id:14,provider_name:'MGM Plus'},{provider_id:15,provider_name:'Discovery +'},
      {provider_id:16,provider_name:'Peacock Premium'}
    ]});
    if(url.pathname==='/3/discover/tv')return Response.json({total_pages:1,results:[{id:1,name:'A show',first_air_date:'2026-10-15',original_language:'fr'}]});
    const page=Number(url.searchParams.get('page')??1);
    if(page===2&&!failed){failed=true;return Response.json({}, {status:503});}
    return Response.json({total_pages:2,results:[movie(page),movie(page)]});
  }) as typeof fetch);
  const db=openDatabase(':memory:'), app=Fastify();
  t.after(async()=>{await app.close();db.close();});
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof AppError?error.status:error instanceof ZodError?400:500).send({message:(error as Error).message}));
  const auth=async (request:{headers:{authorization?:string}})=>{
    if(!request.headers.authorization)throw new AppError('AUTH_REQUIRED','Sign in first.',401);
    return {hash:'viewer',grant};
  };
  registerExplore(app,new PlexAdapter(config(),'explore-test',(async()=>Response.json({MediaContainer:{}})) as typeof fetch),
    new ExploreStore(db,new Vault(randomBytes(32))),auth,auth,()=> 'account-token',client);
  const get=(path:string)=>app.inject({url:`/api/v1/explore/${path}`,headers:{authorization:'fixture'}});
  assert.equal((await app.inject('/api/v1/explore/tmdb/providers')).statusCode,401);
  assert.deepEqual((await get('tmdb/providers')).json().defaults,[8,9,10,16,12,14,15]);
  assert.equal((await get('tmdb/providers?region=ZZ')).statusCode,400);
  const path='tmdb/rows/popular-streaming';
  assert.equal((await get(`${path}?provider=99`)).statusCode,400);
  assert.equal((await get(`${path}?provider=8&providers=9`)).statusCode,400);
  assert.equal((await get('tmdb/rows/trending?provider=8')).statusCode,400);
  const first=(await get(`${path}?provider=all&providers=9,8`)).json();
  assert.deepEqual(first.items.map((item:{key:string})=>item.key),['movie:tmdb:1','show:tmdb:1']);
  assert.equal(first.hasMore,true);
  const discovery=calls.filter(url=>url.pathname.includes('/discover/'));
  assert.equal(discovery.length,2);
  for(const url of discovery) {
    assert.equal(url.searchParams.get('with_watch_providers'),'8|9');
    assert.equal(url.searchParams.get('with_watch_monetization_types'),'flatrate');
    assert.equal(url.searchParams.get('watch_region'),'US');
  }
  assert.equal((await get(`${path}?page=2&providers=8,9`)).statusCode,502);
  assert.deepEqual((await get(`${path}?page=2&providers=8,9`)).json().items.map((item:{key:string})=>item.key),['movie:tmdb:2']);
  assert.deepEqual((await get(`${path}?lang=fr&providers=8,9`)).json().items.map((item:{key:string})=>item.key),['show:tmdb:1']);
  assert.equal(calls.filter(url=>url.pathname==='/3/discover/tv').length,1);
  const shows=(await get(`${path}?kind=show&providers=8,9`)).json();
  assert.deepEqual(shows.items.map((item:{key:string})=>item.key),['show:tmdb:1']);
  assert.equal(shows.hasMore,false);
  const movies=(await get(`${path}?kind=movie&providers=8,9`)).json();
  assert.deepEqual(movies.items.map((item:{key:string})=>item.key),['movie:tmdb:1']);
  assert.equal(movies.hasMore,true);
  assert.deepEqual((await get(`${path}?kind=movie&lang=fr&providers=8,9`)).json().items,[]);
  assert.deepEqual((await get('tmdb/rows/popular-shows?kind=movie')).json().items,[]);
  assert.equal((await get(`${path}?kind=episode`)).statusCode,400);
  key='invalid';
  assert.equal((await get(path)).statusCode,502);
  key=undefined;
  assert.equal((await get('sources')).json().tmdb.configured,false);
  assert.equal((await get('plex/rows')).statusCode,200);
  assert.equal((await get(path)).statusCode,409);
});

test('release windows and thresholds use movie releases and series premieres',async()=>{
  const calls:URL[]=[];
  const tmdb=new TmdbExplore(new TmdbTitles(()=> 'key',(async input=>{
    calls.push(new URL(String(input)));return Response.json({results:[],total_pages:1});
  }) as typeof fetch),()=>now);
  await tmdb.page('recent-streaming',1,{region:'US',ids:[8]});
  await tmdb.page('acclaimed',1);
  await tmdb.page('popular-movies',1);
  await tmdb.page('upcoming-movies',1);
  await tmdb.page('upcoming-shows',1);
  for(const [index,url] of calls.slice(0,4).entries()){
    const field=url.pathname.endsWith('/movie')?'primary_release_date':'first_air_date';
    assert.equal(url.searchParams.get(`${field}.lte`),'2026-11-13');
    assert.equal(url.searchParams.get(`${field}.gte`),index<2?'2026-05-17':'2025-11-13');
    assert.equal(url.searchParams.get('vote_count.gte'),index<2?null:'50');
    assert.equal(url.searchParams.get('vote_average.gte'),index<2?null:'7.2');
  }
  assert.equal(calls.length,11);
  assert.equal(calls[4]?.pathname,'/3/discover/movie');
  assert.equal(calls[4]?.searchParams.get('primary_release_date.lte'),'2026-11-13');
  const windows=[['2026-11-13','2026-12-27'],['2026-12-28','2027-02-10'],['2027-02-11','2028-05-13']];
  for(const [index,type,field] of [[5,'movie','primary_release_date'],[8,'tv','first_air_date']] as const){
    for(const [offset,[from,to]] of windows.entries()){
      const url=calls[index+offset]!;
      assert.equal(url.pathname,`/3/discover/${type}`);
      assert.equal(url.searchParams.get('sort_by'),'popularity.desc');
      assert.equal(url.searchParams.get(`${field}.gte`),from);
      assert.equal(url.searchParams.get(`${field}.lte`),to);
      assert.equal(url.searchParams.has('vote_count.gte'),false);
    }
  }
});

test('Upcoming rows merge the three weighted date ranges before paginating',async()=>{
  const calls:URL[]=[];
  const tmdb=new TmdbExplore(new TmdbTitles(()=> 'key',(async input=>{
    const url=new URL(String(input));calls.push(url);
    const start=url.searchParams.get('primary_release_date.gte'),page=url.searchParams.get('page');
    const title=(id:number,popularity:number)=>({...movie(id),release_date:start,popularity});
    if(start==='2026-11-13')return Response.json({total_pages:2,results:page==='1'
      ?[title(1,90),...Array.from({length:19},(_,i)=>title(i+5,10))]:[title(24,9)]});
    if(start==='2026-12-28')return Response.json({total_pages:1,results:[title(2,100)]});
    return Response.json({total_pages:1,results:[title(3,200),title(4,110)]});
  }) as typeof fetch),()=>now);
  const first=await tmdb.page('upcoming-movies',1);
  assert.deepEqual(first.items.slice(0,4).map(item=>item.ids.tmdb),[3,1,2,4]);
  assert.equal(first.items.length,20);
  assert.equal(first.hasMore,true);
  const second=await tmdb.page('upcoming-movies',2);
  assert.deepEqual(second.items.map(item=>item.ids.tmdb),[21,22,23,24]);
  assert.equal(second.hasMore,false);
  assert.equal(calls.length,4);
});

test('Excluded Plex shelves are absent from browsing, admin controls and direct row requests',async t=>{
  const db=openDatabase(':memory:'),app=Fastify();
  t.after(async()=>{await app.close();db.close();});
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof AppError?error.status:error instanceof ZodError?400:500).send({message:(error as Error).message}));
  const excludedHubs=[
    {key:'/hubs/netflix',title:'Trending on Netflix',type:'movie'},
    {key:'/hubs/hulu',title:'Popular Shows on Hulu',type:'show'},
    {key:'/hubs/trending-1',title:'Trending On Your Services',type:'movie'},
    {key:'/hubs/trending-2',title:'Trending Your Service',type:'show'},
    {key:'/hubs/available',title:'Available on Your Services',type:'show'},
    {key:'/hubs/new',title:'New on Your Services',type:'movie'},
    {key:'/hubs/peacock',title:'Available on Peacock',type:'movie'},
    {key:'/hubs/localized',hubIdentifier:'discover.newOnYourServices',title:'Nouveautés',type:'movie'},
    {key:'/hubs/plex',title:'New on Plex',type:'movie'},
    {key:'/hubs/followers',title:'Follower Favorites',type:'movie'},
    {key:'/hubs/watchlisted',title:'Most Watchlisted',type:'show'},
    {key:'/hubs/week-in-history',title:'Released This Week in History',type:'movie'},
    {key:'/hubs/localized-history',hubIdentifier:'discover.releasedThisWeekInHistory',title:'Cette semaine',type:'movie'},
    {key:'/hubs/localized-followers',hubIdentifier:'discover.followerFavorites',title:'Favoris',type:'movie'},
    {key:'/hubs/localized-watchlisted',hubIdentifier:'discover.mostWatchlisted',title:'Les plus suivis',type:'show'}
  ];
  const plex=new PlexAdapter(config(),'browse-test',(async input=>{
    const url=new URL(String(input));
    return Response.json({MediaContainer:url.pathname==='/hubs/sections/home'?{Hub:[
      ...excludedHubs,
      {key:'/hubs/curated',title:'Plex Picks',type:'movie'},
      {key:'/hubs/trending',title:'Trending Movies',type:'movie'}
    ]}:{Metadata:[{type:'movie',ratingKey:'42',title:'Fixture movie'}]}});
  }) as typeof fetch);
  const store=new ExploreStore(db,new Vault(randomBytes(32)));
  store.update('1',0,{seerrUrl:'https://seerr.test',seerrApiKey:'fixture'});
  // A legacy saved opt-in cannot restore service shelves or reset other layout preferences.
  db.prepare('INSERT INTO explore_layout VALUES(1,1,?)').run(JSON.stringify({
    order:['plex','tmdb'],hidden:[],hiddenRows:['tmdb:acclaimed'],showPlexStreaming:true
  }));
  const auth=async()=>({hash:'viewer',grant});
  registerExplore(app,plex,store,auth,auth,()=> 'account-token',new TmdbTitles(()=> 'fixture-key'),{seerr:(async input=>{
    const path=new URL(String(input)).pathname;
    return Response.json({results:path.endsWith('/search')?[
      {id:99,mediaType:'movie',title:'Seerr search result'},{id:100,mediaType:'tv',name:'Seerr show result'}
    ]:[]});
  }) as typeof fetch});
  const get=(url:string)=>app.inject(`/api/v1/explore/${url}`);
  assert.deepEqual((await get('sources')).json().order,['plex','tmdb']);
  assert.equal((await get('sources')).json().seerr.configured,true);
  assert.equal((await get('seerr/rows')).statusCode,400);
  assert.equal((await get('seerr/rows/trending')).statusCode,400);
  assert.equal((await get('search?q=test&sources=seerr')).json().items[0]?.title,'Seerr search result');
  assert.deepEqual((await get('search?q=test&sources=seerr&kind=show')).json().items.map((item:{kind:string})=>item.kind),['show']);
  const expected=['Watchlist','Plex Picks','Trending Movies'];
  assert.deepEqual((await get('plex/rows')).json().rows.map((row:{title:string})=>row.title),expected);
  const admin=(await app.inject('/api/v1/admin/explore/layout')).json();
  assert.deepEqual(admin.sources.map((s:{source:string})=>s.source),['plex','tmdb']);
  const plexRows=admin.sources[0].rows;
  assert.deepEqual(plexRows.map((row:{title:string})=>row.title),expected);
  assert.deepEqual(admin.layout.hiddenRows,['tmdb:acclaimed']);
  assert.equal(admin.layout.showPlexStreaming,undefined);
  for(const {key} of excludedHubs){
    const id=`hub.${Buffer.from(key).toString('base64url')}`;
    assert.equal((await get(`plex/rows/${id}`)).statusCode,404);
  }
  assert.equal((await get(`plex/rows/${plexRows[1].id}`)).statusCode,200);
  assert.deepEqual((await get(`plex/rows/${plexRows[1].id}?kind=show`)).json().items,[]);
  assert.deepEqual((await get(`plex/rows/${plexRows[1].id}?kind=movie`)).json().items.map((item:{kind:string})=>item.kind),['movie']);
  assert.ok((await get('tmdb/rows')).json().rows.some((row:{id:string})=>row.id==='upcoming-shows'));
});

test('TMDB coalesces requests and never serves stale data across credential changes',async()=>{
  let key='one', time=0, reads=0, status=200;
  const client=new TmdbTitles(()=>key,(async()=>{reads++;return Response.json({reads},{status});}) as typeof fetch,()=>time);
  const read=()=>client.get('/discover/movie',{page:'1'},10);
  assert.deepEqual(await Promise.all([read(),read()]),[{reads:1},{reads:1}]);
  time=20;status=503;
  assert.deepEqual(await read(),{reads:1});
  key='two';status=401;
  await assert.rejects(read(),{code:'TMDB_KEY_REJECTED'});
  status=200;
  assert.deepEqual(await read(),{reads:4});
});

test('Plex recommendation input pages within the viewer grant and keeps a working section during an outage',async()=>{
  const requests:URL[]=[];
  const plex=new PlexAdapter(config(),'explore-test',(async (input,init)=>{
    const url=new URL(String(input));requests.push(url);
    assert.equal(new Headers(init?.headers).get('X-Plex-Token'),'server');
    if(url.pathname.includes('/20/'))return Response.json({}, {status:503});
    const start=Number(url.searchParams.get('X-Plex-Container-Start'));
    const entries=Array.from({length:start?1:200},(_,index)=>({ratingKey:String(start+index+1),type:'movie',title:'Owned',Guid:[{id:'tmdb://42'}]}));
    return Response.json({MediaContainer:{Metadata:entries,offset:start,totalSize:201}});
  }) as typeof fetch);
  const snapshot=await plex.exploreLibrary(grant);
  assert.equal(snapshot.complete,false);
  assert.equal(snapshot.titles.length,201);
  assert.equal(snapshot.titles[0]?.tmdbId,42);
  assert.equal(requests.length,3);
  assert.ok(requests.every(url=>url.searchParams.get('includeGuids')==='1'&&url.searchParams.get('X-Plex-Container-Size')==='200'));
});

test('personal pools exclude owned titles, rotate seeds and separate account and library grants',async()=>{
  let scans=0;
  const suggestionPaths:string[]=[];
  const sample=Array.from({length:12},(_,i)=>({kind:i%2?'movie':'show',title:`Seed ${i}`,year:2020,genres:['Drama'],tmdbId:10+i,addedAt:100-i} as const))
    .map(title=>({...title,genres:[...title.genres]}));
  const tmdb=new TmdbExplore(new TmdbTitles(()=> 'key',(async input=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/recommendations'))suggestionPaths.push(url.pathname);
    if(url.pathname.includes('/tv'))return Response.json({results:[{id:99,name:'A new show'}]});
    return Response.json({results:[movie(11),movie(91,'Owned without ID'),movie(42),movie(43)]});
  }) as typeof fetch));
  let time=now, watchReads=0;
  const service=new ExploreRecommendations({
    exploreLibrary:async g=>{
      scans++;
      return {complete:g.accountId!=='partial',titles:g.accountId==='1'?[...sample,{kind:'movie',title:'Owned without ID',year:2026,genres:['Drama']}]:[]};
    },
    exploreRecentlyWatched:async g=>{
      watchReads++;
      if(g.accountId!=='1')return [];
      const title=time===now?'Recently watched':'Newly watched';
      return [{kind:'movie',title,genres:['Drama'],tmdbId:11,lastViewedAt:time/1000}];
    },
    exploreAccountHistory:async (_grant,token)=>token==='cloud-token'
      ? [{kind:'show',title:'Watched on another server',genres:['Comedy'],tmdbId:801}] : []
  },tmdb,()=>time);
  const [pool,repeat]=await Promise.all([service.get(grant,1),service.get(grant,1)]);
  assert.equal(scans,1);
  assert.equal(pool,repeat);
  assert.equal(pool['because-1']?.title,'Because You Watched Recently watched');
  assert.equal(pool['because-2'],undefined);
  assert.equal(watchReads,1);
  assert.deepEqual(suggestionPaths,['/3/movie/11/recommendations']);
  time+=3600000;
  assert.equal((await service.get(grant,1))['because-1']?.title,'Because You Watched Newly watched');
  assert.equal(scans,1);
  const keys=pool['top-picks']?.items.map(c=>c.item.key);
  assert.ok(keys?.includes('movie:tmdb:42'));
  assert.ok(!keys?.includes('movie:tmdb:11')&&!keys?.includes('movie:tmdb:91'));
  const empty=await service.get({...grant,accountId:'2'},1);
  assert.equal(empty['top-picks']?.title,'Popular Picks');
  assert.equal(empty['because-1'],undefined);
  const cloud=await service.get({...grant,accountId:'2'},1,'cloud-token');
  assert.equal(cloud['top-picks']?.title,'Top Picks for You');
  assert.equal(cloud['because-1'],undefined);
  assert.ok(suggestionPaths.includes('/3/tv/801/recommendations'));
  const partial=await service.get({...grant,accountId:'partial'},1);
  assert.equal(partial['top-picks']?.title,'Popular Picks');
  await service.get({...grant,libraries:grant.libraries.slice(0,1)},1);
  service.forget('1');
  await service.get(grant,1);
  assert.equal(scans,5);
  assert.deepEqual(selectSeeds(sample,['Drama']).slice(0,2).map(seed=>seed.kind),['show','movie']);
  const a=tmdbCandidate(movie(42),'movie')!,b=tmdbCandidate(movie(43),'movie')!;
  assert.deepEqual(rankCandidates([[b,a],[a]],['Drama']).map(c=>c.item.key),[a.item.key,b.item.key]);
});

test('recent watch seeds use each Plex viewer’s watched movies and series, excluding old, unwatched and inaccessible items',async()=>{
  const lastViewedAt=now/1000-60;
  const plex=new PlexAdapter(config(),'watched-test',(async(input,init)=>{
    const url=new URL(String(input)), token=new Headers(init?.headers).get('X-Plex-Token');
    assert.ok(token==='server'||token==='other-viewer');
    if(url.pathname==='/library/metadata/40')return Response.json({MediaContainer:{Metadata:[
      {type:'show',ratingKey:'40',title:'A watched series',librarySectionID:'20',Guid:[{id:'tmdb://140'}]}
    ]}});
    assert.equal(url.searchParams.get('sort'),'lastViewedAt:desc');
    assert.equal(url.searchParams.get('unwatched'),'0');
    const film=(ratingKey:string,title:string,viewCount:number,date=lastViewedAt)=>({ratingKey,title,viewCount,lastViewedAt:date,type:'movie',
      librarySectionID:'10',Guid:[{id:`tmdb://${ratingKey}`}]});
    const episode=(ratingKey:string)=>({ratingKey,title:'An episode',type:'episode',librarySectionID:'20',grandparentRatingKey:'40',viewCount:1,lastViewedAt});
    if(url.pathname.includes('/20/')) {
      assert.equal(url.searchParams.get('type'),'4');
      return Response.json({MediaContainer:{Metadata:token==='server'?[episode('401'),episode('402')]:[]}});
    }
    assert.equal(url.searchParams.get('type'),'1');
    return Response.json({MediaContainer:{Metadata:token==='server'?
      [film('42','A watched movie',1,lastViewedAt+10),film('43','Unwatched movie',0),film('44','Old movie',1,lastViewedAt-366*86400),
        {...film('45','Other library',1),librarySectionID:'99'}]:[film('46','Other viewer’s movie',1)]}});
  }) as typeof fetch);
  const titles=await plex.exploreRecentlyWatched(grant,now);
  assert.deepEqual(titles.map(t=>[t.title,t.tmdbId]),[['A watched movie',42],['A watched series',140]]);
  const other=await plex.exploreRecentlyWatched({...grant,accountId:'2',serverToken:'other-viewer'},now);
  assert.deepEqual(other.map(t=>t.title),['Other viewer’s movie']);
});

test('Plex account history reads only the signed-in profile and resolves titles outside its server grant',async()=>{
  let pages=0;
  const plex=new PlexAdapter(config(),'history-test',(async(input,init)=>{
    const url=new URL(String(input));
    assert.equal(new Headers(init?.headers).get('x-plex-token'),'account-token');
    if(url.hostname==='plex.tv')return Response.json({id:1,uuid:'profile-uuid'});
    if(url.hostname==='community.plex.tv'){
      assert.equal(init?.method,'POST');
      const {variables}=JSON.parse(String(init?.body));
      assert.equal(variables.uuid,'profile-uuid');
      assert.equal(variables.after,pages?'next':undefined);
      const metadataItem=pages?{id:'film',type:'MOVIE',guid:'plex://movie/film'}
        :{id:'episode',type:'EPISODE',grandparent:{id:'series',type:'SHOW',guid:'plex://show/series'}};
      return Response.json({data:{user:{watchHistory:{nodes:[{metadataItem}],pageInfo:{hasNextPage:pages++===0,endCursor:'next'}}}}});
    }
    assert.equal(url.hostname,'discover.provider.plex.tv');
    assert.equal(url.pathname,'/library/metadata/series,film');
    assert.equal(url.searchParams.get('includeGuids'),'1');
    return Response.json({MediaContainer:{Metadata:[
      {ratingKey:'film',type:'movie',title:'Outside movie',Guid:[{id:'tmdb://402'}]},
      {ratingKey:'series',type:'show',title:'Outside series',Guid:[{id:'tmdb://401'}],Genre:[{tag:'Drama'}]}
    ]}});
  }) as typeof fetch);
  assert.deepEqual((await plex.exploreAccountHistory(grant,'account-token')).map(t=>[t.tmdbId,t.kind,t.genres]),[[401,'show',['Drama']],[402,'movie',[]]]);
  assert.equal(pages,2);
  await assert.rejects(plex.exploreAccountHistory({...grant,accountId:'2'},'account-token'),{code:'PLEX_ACCESS_DENIED'});
  assert.equal(pages,2);
});

test('saved service choices and TMDB row order preserve existing visibility settings',()=>{
  const prefs=parseExplorePrefs(JSON.stringify({hidden:['plex','seerr'],hiddenRows:['seerr:popular','plex:watchlist'],region:'GB',providers:[8,9],
    selections:{'popular-streaming':8,'recent-streaming':9}}));
  assert.deepEqual(prefs.selections,{'popular-streaming':8,'recent-streaming':9});
  assert.deepEqual(prefs.hidden,['plex']);
  assert.deepEqual(prefs.hiddenRows,['plex:watchlist']);
  assert.equal(prefs.region,'GB');
  assert.deepEqual(tmdbRowOrder(['trending','top-picks']).slice(0,3),['trending','top-picks','popular-streaming']);
});
