import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Seerr,matchPerson,seerrFacts,seerrItem,seerrRatings,seerrSeasons,seerrStatus,statusIndex} from '../apps/server/src/providers/seerr.js';
import {discoverIds,discoverItem} from '../apps/server/src/providers/plex-discover.js';
import {imagePath} from '../apps/server/src/providers/explore-images.js';
import {ExploreStore,exploreLayout} from '../apps/server/src/persistence/explore-store.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {ExploreCache,SHARED,exploreFilter,interleave,lacking,passes,rowKeep,rowShown,shownSources} from '../apps/server/src/explore-api.js';

test('Seerr status shows availability, and downloads and open requests as Requested, per quality',()=>{
  assert.equal(seerrStatus(undefined),undefined);
  assert.equal(seerrStatus({status:5}),'available');
  assert.equal(seerrStatus({status:4}),'partial');
  assert.equal(seerrStatus({status:3}),'requested');
  assert.equal(seerrStatus({status:2}),'requested');
  // A request waiting for approval counts; a declined (3) or completed (5) one does not.
  assert.equal(seerrStatus({status:1,requests:[{status:1}]}),'requested');
  assert.equal(seerrStatus({status:1,requests:[{status:3},{status:5}]}),undefined);
  // A 4K request says nothing about the standard copy, and the other way round.
  assert.equal(seerrStatus({status:1,requests:[{status:1,is4k:true}]}),undefined);
  assert.equal(seerrStatus({status:5,status4k:1,requests:[{status:2,is4k:true}]},true),'requested');
  // Overseerr's deleted and Jellyseerr's blocklisted codes get no badge.
  assert.equal(seerrStatus({status:6}),undefined);
});
test('Seerr seasons leave out specials and mark seasons on the server or requested',()=>{
  const seasons=seerrSeasons({id:1,seasons:[{seasonNumber:0,name:'Specials'},{seasonNumber:1,name:'Season 1',episodeCount:8},{seasonNumber:2,name:'Season 2'},{seasonNumber:3,name:''}],
    mediaInfo:{status:4,seasons:[{seasonNumber:1,status:5}],requests:[{status:2,seasons:[{seasonNumber:2}]},{status:3,seasons:[{seasonNumber:3}]},{status:1,is4k:true,seasons:[{seasonNumber:3}]}]}});
  assert.deepEqual(seasons,[{number:1,name:'Season 1',episodeCount:8,status:'available'},{number:2,name:'Season 2',status:'requested'},{number:3,name:'Season 3'}]);
});
test('Seerr titles map TMDB fields for movies and shows and skip people',()=>{
  const movie=seerrItem({id:603,mediaType:'movie',title:'The Matrix',releaseDate:'1999-03-31',posterPath:'/p.jpg',voteAverage:8.2,mediaInfo:{status:5}});
  assert.equal(movie?.key,'movie:tmdb:603');assert.equal(movie?.year,1999);assert.equal(movie?.status,'available');
  assert.equal(movie?.posterUrl,`/api/v1/explore/image?u=${encodeURIComponent('https://image.tmdb.org/t/p/w342/p.jpg')}`);
  // Single-type discover rows omit mediaType; TMDB sends empty strings for missing translations.
  const show=seerrItem({id:1399,title:'',name:'Game of Thrones',firstAirDate:'2011-04-17'},'tv');
  assert.equal(show?.kind,'show');assert.equal(show?.title,'Game of Thrones');
  assert.equal(seerrItem({id:1,mediaType:'person',name:'Someone'}),undefined);
});
test('Seerr renews an expired session with the Plex token and retries once',async()=>{
  const calls:string[]=[];let session=0;
  const transport=(async(url:URL,init?:RequestInit)=>{
    const path=new URL(url).pathname,cookie=new Headers(init?.headers).get('cookie');calls.push(`${init?.method??'GET'} ${path} ${cookie??''}`);
    if(path==='/api/v1/auth/plex'){session++;return new Response('{}',{headers:{'set-cookie':`connect.sid=s${session}; Path=/; HttpOnly`}});}
    if(path==='/api/v1/auth/me')return Response.json({id:7,displayName:'Viewer',permissions:32});
    // The first session expires before the row is read.
    if(cookie==='connect.sid=s1')return Response.json({message:'Unauthorized'},{status:401});
    return Response.json({results:[{id:1,mediaType:'movie',title:'A'}],totalPages:3,totalResults:60});
  }) as typeof fetch;
  const seerr=new Seerr(()=>({url:'http://seerr.test'}),transport);
  const page=await seerr.row('1','plex-token','trending',1);
  assert.equal(page.items.length,1);assert.equal(page.hasMore,true);assert.equal(page.total,60);
  assert.equal(session,2);assert.equal(calls.filter(c=>c.includes('/discover/trending')).length,2);
  // A second refusal is a permission problem, not another sign-in.
  const denied=new Seerr(()=>({url:'http://seerr.test'}),(async(url:URL)=>{const path=new URL(url).pathname;
    if(path==='/api/v1/auth/plex')return new Response('{}',{headers:{'set-cookie':'connect.sid=x; Path=/'}});
    if(path==='/api/v1/auth/me')return Response.json({id:7,permissions:0});
    return Response.json({message:'You do not have permission to make 4K requests.'},{status:403});}) as typeof fetch);
  await assert.rejects(denied.request('1','plex-token','movie',603,undefined,true),{code:'SEERR_FORBIDDEN',message:'You do not have permission to make 4K requests.'});
});
test('Plex Discover titles carry their external ids and only proxy catalog hosts',()=>{
  const m={ratingKey:'5d77',guid:'plex://movie/5d77',type:'movie',title:'Emma.',year:2020,thumb:'https://metadata-static.plex.tv/a.jpg',Guid:[{id:'imdb://tt9214832'},{id:'tmdb://556678'},{id:'tvdb://x'}]};
  assert.deepEqual(discoverIds(m),{plex:'5d77',plexGuid:'plex://movie/5d77',imdb:'tt9214832',tmdb:556678});
  assert.equal(discoverItem(m)?.key,'movie:tmdb:556678');
  assert.equal(discoverItem({...m,type:'episode'}),undefined);
  assert.equal(imagePath('https://evil.example/a.jpg'),undefined);
  assert.equal(imagePath('http://image.tmdb.org/a.jpg'),undefined);
  assert.ok(imagePath('https://images.plex.tv/photo?url=x'));
});
test('Explore settings keep the Seerr key sealed and drop the Trakt connection saved before Trakt was removed',()=>{
  const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32));new ExploreStore(db,vault);
  db.prepare('INSERT INTO explore_settings VALUES(1,1,?)').run(JSON.stringify({seerrUrl:'https://seerr.test',traktClientId:'abc',traktSecret:'sealed'}));
  db.exec('CREATE TABLE explore_trakt_links(account_id TEXT PRIMARY KEY)');
  const store=new ExploreStore(db,vault);
  assert.deepEqual(JSON.parse((db.prepare('SELECT value FROM explore_settings').get() as {value:string}).value),{seerrUrl:'https://seerr.test'});
  assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name='explore_trakt_links'`).get(),undefined);
  let view=store.update('1',1,{seerrUrl:'https://seerr.test/',seerrApiKey:'shh'});
  assert.deepEqual(view,{revision:2,seerrUrl:'https://seerr.test',seerrKeySet:true});
  assert.ok(!JSON.stringify(db.prepare('SELECT value FROM explore_settings').get()).includes('shh'));
  // Saving without a key keeps it.
  view=store.update('1',2,{seerrUrl:'https://seerr.test'});
  assert.equal(store.seerrKey(),'shh');
  assert.throws(()=>store.update('1',2,{seerrUrl:''}),{code:'REVISION_CONFLICT'});
  assert.throws(()=>store.update('1',3,{seerrUrl:'https://user:pw@seerr.test'}));
});
test('With the API key, browsing reads Seerr without signing anyone in and lists statuses by title',async()=>{
  const calls:string[]=[];
  const transport=(async(url:URL,init?:RequestInit)=>{
    const u=new URL(url);calls.push(`${u.pathname}?${u.searchParams.get('skip')??''} ${new Headers(init?.headers).get('x-api-key')??''}`);
    if(u.pathname==='/api/v1/media'){const skip=Number(u.searchParams.get('skip'));
      return Response.json({pageInfo:{pages:2},results:skip?[{mediaType:'tv',tmdbId:1399,status:4}]:[{mediaType:'movie',tmdbId:603,status:3},{mediaType:'movie',tmdbId:604,status:1,status4k:5},{mediaType:'movie',tmdbId:605,status:1}]});}
    return Response.json({results:[{id:1,mediaType:'movie',title:'A',mediaInfo:{status:5}}],totalPages:1});
  }) as typeof fetch;
  const seerr=new Seerr(()=>({url:'http://seerr.test',apiKey:'k'}),transport);
  assert.equal((await seerr.row('1','plex-token','trending',1)).items[0]?.status,'available');
  const index=await seerr.statuses();
  assert.deepEqual([...index!],[['movie:tmdb:603','requested'],['movie:tmdb:604','available'],['show:tmdb:1399','partial']]);
  await seerr.statuses();
  assert.ok(!calls.some(c=>c.startsWith('/api/v1/auth')));assert.ok(calls.every(c=>c.endsWith(' k')));
  // Kept for a few minutes: both pages were read once.
  assert.equal(calls.filter(c=>c.startsWith('/api/v1/media')).length,2);
  assert.equal(await new Seerr(()=>({url:'http://seerr.test'}),transport).statuses(),undefined);
  assert.equal(statusIndex([{mediaType:'person',tmdbId:1,status:5}]).size,0);
});
test('Cast and crew resolve to IMDb people through the title credits first, then an exact-name search',async()=>{
  assert.equal(matchPerson('Penélope Cruz',[{id:1,name:'Penelope Cruz Jr'},{id:2,name:'penelope cruz'}]),2);
  assert.equal(matchPerson('',[{id:1,name:''}]),undefined);
  const paths:string[]=[];
  const transport=(async(url:URL)=>{
    const u=new URL(url);paths.push(u.pathname);
    if(u.pathname==='/api/v1/movie/603')return Response.json({id:603,credits:{cast:[{id:6384,name:'Keanu Reeves'}],crew:[{id:9339,name:'Lilly Wachowski'}]}});
    if(u.pathname==='/api/v1/search')return Response.json({results:[{id:5,mediaType:'movie',title:'Michael Smith'},{id:77,mediaType:'person',name:'Michael Smith'}]});
    if(u.pathname.startsWith('/api/v1/person/'))return Response.json({imdbId:{'/api/v1/person/6384':'nm0000206','/api/v1/person/9339':'nm0905152','/api/v1/person/77':'nm1234567'}[u.pathname]??null});
    return Response.json({},{status:404});
  }) as typeof fetch;
  const seerr=new Seerr(()=>({url:'http://seerr.test',apiKey:'k'}),transport);
  assert.equal(await seerr.imdbPerson('1','t','Lilly Wachowski',{kind:'movie',tmdb:603}),'nm0905152');
  assert.ok(!paths.includes('/api/v1/search'));
  // Not in the credits (or no title): TMDB's first person with that name.
  assert.equal(await seerr.imdbPerson('1','t','Michael Smith',{kind:'movie',tmdb:603}),'nm1234567');
  assert.equal(await seerr.imdbPerson('1','t','Michael Smith'),'nm1234567');
  assert.equal(await seerr.imdbPerson('1','t','Nobody'),undefined);
});
test('Seerr facts and Rotten Tomatoes scores read like the library: flags, streaming services for the region, 0–10 scores',()=>{
  const facts=seerrFacts({id:1,status:'Ended',firstAirDate:'2015-09-08',originalLanguage:'en',productionCountries:[{iso_3166_1:'US',name:'United States of America'}],
    watchProviders:[{iso_3166_1:'GB',flatrate:[{name:'BBC iPlayer',logoPath:'/b.jpg'}]},{iso_3166_1:'US',flatrate:[{name:'Paramount Plus',logoPath:'/p.jpg'},{name:'Paramount Plus Apple TV Channel',logoPath:'/c.jpg'},{name:'No logo'}]}]},'show','US');
  assert.equal(facts.status,'Ended');assert.equal(facts.released,'2015-09-08');assert.equal(facts.language,'en');
  assert.deepEqual(facts.countries,[{code:'US',name:'United States of America',flagUrl:imagePath('https://flagcdn.com/w40/us.png')}]);
  assert.deepEqual(facts.providers?.map(p=>[p.name,!!p.logoUrl]),[['Paramount Plus',true],['No logo',false]]);
  assert.deepEqual(seerrRatings({criticsScore:51,criticsRating:'Rotten',audienceScore:80,audienceRating:'Upright',url:'https://www.rottentomatoes.com/tv/x'},'show'),
    {ratings:[{source:'tomatometer',score:5.1,fresh:false},{source:'popcornmeter',score:8,fresh:true}],url:'https://www.rottentomatoes.com/tv/x'});
  const movie=seerrRatings({imdb:{criticsScore:7.4},rt:{criticsScore:0,url:'https://evil.example/'}},'movie');
  assert.deepEqual(movie,{ratings:[{source:'imdb',score:7.4}]});
  assert.deepEqual(seerrRatings(undefined,'movie'),{ratings:[]});
});

test('Explore reads are kept per viewer until they expire or are forgotten, and failed reads are not kept',async()=>{
  const cache=new ExploreCache();let reads=0;const read=async()=>++reads;
  assert.equal(await cache.get('a','row',1000,read,0),1);assert.equal(await cache.get('a','row',1000,read,500),1);
  assert.equal(await cache.get('b','row',1000,read,500),2);assert.equal(await cache.get('a','row',1000,read,1000),3);
  cache.forget('a');assert.equal(await cache.get('a','row',1000,read,1100),4);assert.equal(await cache.get('b','row',1000,read,1100),2);
  cache.forget();assert.equal(await cache.get('b','row',1000,read,1100),5);
  await assert.rejects(cache.get('a','bad',1000,async()=>{throw new Error('down');},1200));
  assert.equal(await cache.get('a','bad',1000,read,1300),6);
});
test('Public Explore rows are kept 12 hours, Seerr ones for every viewer, and the watchlist stays short',()=>{
  const day=12*3600000,short=10*60000;
  assert.deepEqual(rowKeep('seerr','trending','a'),{account:SHARED,ttl:day});
  assert.deepEqual(rowKeep('plex','hub.abc','a'),{account:'a',ttl:day});
  assert.deepEqual(rowKeep('plex','watchlist','a'),{account:'a',ttl:short});
});
test('Explore filters read languages, a year range and a minimum score, and leave out titles that lack what a filter needs',()=>{
  const f=exploreFilter({lang:'en, JA,xx1,en',from:1990,to:2005,min:7});
  assert.deepEqual(f,{languages:['en','ja'],from:1990,to:2005,min:7});
  assert.deepEqual(exploreFilter({min:0}),{languages:[]});
  const item={key:'movie:tmdb:1',source:'plex' as const,kind:'movie' as const,title:'A',ids:{tmdb:1}};
  assert.equal(passes({...item,language:'ja',year:1999,rating:7},f),true);
  assert.equal(passes({...item,language:'fr',year:1999,rating:7},f),false);
  assert.equal(passes({...item,language:'en',year:2006,rating:9},f),false);
  assert.equal(passes({...item,language:'en',year:1990,rating:6.9},f),false);
  // Unknown language, year or score: looked up first, then left out.
  assert.equal(lacking({...item,year:1999,rating:7},f),true);
  assert.equal(passes({...item,year:1999,rating:7},f),false);
  assert.equal(passes(item,exploreFilter({from:2000})),false);
  assert.equal(passes(item,exploreFilter({})),true);
});
test('Explore search interleaves sources best first and lists a title once with what each source adds',()=>{
  const t=(key:string,source:'plex'|'seerr',extra={})=>({key,source,kind:'movie' as const,title:key,ids:{},...extra});
  const merged=interleave([
    [t('a','plex',{ids:{plex:'p1'},posterUrl:undefined}),t('b','plex')],
    [t('c','seerr'),t('a','seerr',{ids:{tmdb:1},posterUrl:'/x.jpg',status:'available',language:'en'}),t('d','seerr')]]);
  assert.deepEqual(merged.map(i=>i.key),['a','c','b','d']);
  const a=merged[0]!;
  assert.equal(a.source,'plex');assert.equal(a.posterUrl,'/x.jpg');assert.equal(a.status,'available');assert.equal(a.language,'en');
  assert.deepEqual(a.ids,{tmdb:1,plex:'p1'});
});
test('Explore layout keeps the administrator order, lists missing sources last and hides sources and single rows',()=>{
  assert.deepEqual(exploreLayout(undefined),{order:['plex','seerr'],hidden:[],hiddenRows:[]});
  assert.deepEqual(exploreLayout({order:['seerr']}).order,['seerr','plex']);
  // Trakt, saved before it was removed, is dropped and the rest kept.
  assert.deepEqual(exploreLayout({order:['trakt','seerr','plex'],hidden:['trakt','plex'],hiddenRows:['trakt:watchlist','seerr:trending']} as never),{order:['seerr','plex'],hidden:['plex'],hiddenRows:['seerr:trending']});
  // A damaged saved value falls back to the default.
  assert.deepEqual(exploreLayout({order:['plex','plex'] as never}).order,['plex','seerr']);
  const db=openDatabase(':memory:'),store=new ExploreStore(db,new Vault(randomBytes(32)));
  const saved=store.updateLayout('1',0,{order:['seerr','plex'],hidden:['plex'],hiddenRows:['seerr:upcoming-shows']});
  assert.equal(saved.revision,1);
  assert.deepEqual(shownSources(saved),['seerr']);
  assert.equal(rowShown(saved,'seerr','upcoming-shows'),false);assert.equal(rowShown(saved,'seerr','trending'),true);assert.equal(rowShown(saved,'plex','watchlist'),false);
  assert.throws(()=>store.updateLayout('1',0,{order:['plex','seerr'],hidden:[],hiddenRows:[]}),/Settings changed/);
});
