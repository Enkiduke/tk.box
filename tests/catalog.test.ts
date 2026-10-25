import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PlexAdapter,type PlexGrant} from '../apps/server/src/providers/plex.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {IdentityService} from '../apps/server/src/services/identity.js';
import {buildApp} from '../apps/server/src/app.js';
import {config,fakePlex,metadata} from './fixtures.js';
import {ArtworkCache} from '../apps/server/src/providers/artwork-cache.js';
import type {CatalogItem} from '../packages/contracts/src/index.js';
import {sortIndex,promotedHubs,promotedCollectionIds,externalRatings,catalogNode,groupRecentEpisodes} from '../apps/server/src/providers/plex-catalog.js';

function catalogFixture() {
  const base=fakePlex(),requests:{path:string;query:URLSearchParams;token:string|null}[]=[],nodes:Record<string,Record<string,unknown>>={
    '42':{...metadata,summary:'A real synopsis',year:2024,thumb:'/library/metadata/42/thumb/123',art:'/library/metadata/42/art/123',viewOffset:120000,Genre:[{tag:'Drama'}],secret:'must-not-leak'},
    '100':{ratingKey:'100',type:'show',librarySectionID:'20',title:'Fixture show',leafCount:3},
    '101':{ratingKey:'101',type:'season',parentRatingKey:'100',title:'Season 1',index:1},
    '102':{...metadata,ratingKey:'102',librarySectionID:'20',type:'episode',title:'Episode 1',parentRatingKey:'101',grandparentRatingKey:'100',parentIndex:1,index:1},
    '900':{...metadata,ratingKey:'900',librarySectionID:'99'}
  };
  let overridePage:unknown,artType='image/png',artBytes=Buffer.from([137,80,78,71]);
  const transport=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input));requests.push({path:url.pathname,query:url.searchParams,token:new Headers(init?.headers).get('X-Plex-Token')});
    if(url.pathname==='/library/sections/10/genre')return Response.json({MediaContainer:{Directory:[{key:'7',title:'Drama',secret:'must-not-leak'},{key:12,title:'Science Fiction'}]}});
    if(url.pathname==='/library/sections/10/firstCharacter')return Response.json({MediaContainer:{Directory:[{title:'#',size:2,key:'must-not-leak'},{title:'A',size:5},{title:'B',size:25}]}});
    if(['/:/scrobble','/:/unscrobble','/actions/removeFromContinueWatching'].includes(url.pathname))return new Response('',{status:200});
    if(url.pathname==='/photo/:/transcode')return new Response(artBytes,{headers:{'content-type':artType,'x-secret':'must-not-leak'}});
    const detail=/^\/library\/metadata\/(\d+)$/.exec(url.pathname);
    if(detail)return Response.json({MediaContainer:{Metadata:nodes[detail[1]!]?[nodes[detail[1]!]!]:[]}});
    const children=/^\/library\/metadata\/(\d+)\/children$/.exec(url.pathname);
    if(children)return Response.json({MediaContainer:{Metadata:[nodes[children[1]==='100'?'101':'102']],totalSize:1}});
    if(/^\/library\/sections\/\d+\/(all|onDeck|recentlyAdded|unwatched)$/.test(url.pathname))return Response.json(overridePage??{MediaContainer:{Metadata:[nodes[url.pathname.includes('/10/')?'42':'100']],offset:Number(url.searchParams.get('X-Plex-Container-Start')??0),totalSize:32}});
    return base.transport(input,init);
  }) as typeof fetch;
  return {base,requests,nodes,transport,setPage:(value:unknown)=>{overridePage=value;},setArt:(type:string,bytes=artBytes)=>{artType=type;artBytes=bytes;}};
}
test('catalog uses viewer grants, bounded scoped queries and safe DTOs with no source paths or tokens',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture-account-token');
  const page=await plex.catalogPage(grant,'10',{limit:24,offset:0,q:'title & 4K',sort:'year'});assert.equal(page.total,32);assert.equal(page.hasMore,true);assert.equal(page.items[0]!.posterUrl,'/api/v1/catalog/items/42/artwork?kind=poster&v=123');
  const request=f.requests.find(r=>r.path==='/library/sections/10/all')!;assert.equal(request.query.get('title'),'title & 4K');assert.equal(request.query.get('sort'),'year:desc');assert.equal(request.query.get('X-Plex-Container-Size'),'24');assert.equal(request.token,'fixture-viewer-server-token');
  const raw=JSON.stringify(page);for(const forbidden of ['must-not-leak','server-token','Media','/library/parts/','/thumb/123'])assert.ok(!raw.includes(forbidden));
  const before=f.requests.length;await assert.rejects(plex.catalogPage(grant,'99',{}),{code:'PLEX_ACCESS_DENIED'});assert.equal(f.requests.length,before);
  await assert.rejects(plex.catalogItem(grant,'900'),{code:'PLEX_ACCESS_DENIED'});
  f.setPage({MediaContainer:{Metadata:[f.nodes['900']]}});await assert.rejects(plex.catalogPage(grant,'10',{}),{code:'PLEX_ACCESS_DENIED'});
});

test('genre discovery and unwatched browsing use scoped viewer grants and preserve filtering before paging',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  assert.deepEqual(await plex.catalogGenres(grant,'10'),{genres:[{id:'7',title:'Drama'},{id:'12',title:'Science Fiction'}]});
  const before=f.requests.length;await assert.rejects(plex.catalogGenres(grant,'99'),{code:'PLEX_ACCESS_DENIED'});assert.equal(f.requests.length,before);
  await plex.catalogPage(grant,'10',{shelf:'unwatched',genre:'7',offset:30,limit:30,sort:'rating'});
  const request=f.requests.find(r=>r.path==='/library/sections/10/all')!;
  assert.equal(request.query.get('genre'),'7');assert.equal(request.query.get('sort'),'rating:desc');assert.equal(request.query.get('X-Plex-Container-Start'),'30');assert.equal(request.token,'fixture-viewer-server-token');
  assert.equal(request.query.get('unwatched'),'1');
  await assert.rejects(plex.catalogPage(grant,'10',{genre:'../../secret'}));
});
test('season ancestry and natural child order are verified; unrelated children and invalid paging fail closed',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  assert.equal((await plex.catalogItem(grant,'101')).libraryId,'20');const episodes=await plex.catalogChildren(grant,'101',{});assert.equal(episodes.items[0]!.episodeNumber,1);assert.equal(episodes.items[0]!.seasonNumber,1);assert.equal(f.requests.find(r=>r.path.endsWith('/101/children'))!.query.get('sort'),'index:asc');
  const restricted:PlexGrant={...grant,libraries:grant.libraries.filter(l=>l.key==='10')};await assert.rejects(plex.catalogItem(restricted,'101'),{code:'PLEX_ACCESS_DENIED'});
  f.nodes['102']!.parentRatingKey='777';await assert.rejects(plex.catalogChildren(grant,'101',{}),{code:'PLEX_ACCESS_DENIED'});
  f.setPage({MediaContainer:{Metadata:[f.nodes['42'],f.nodes['42']],totalSize:2}});await assert.rejects(plex.catalogPage(grant,'10',{limit:1}),{code:'PLEX_PAGINATION_INVALID'});
  f.setPage({MediaContainer:{Metadata:[f.nodes['42']],offset:50}});await assert.rejects(plex.catalogPage(grant,'10',{offset:0}),{code:'PLEX_PAGINATION_INVALID'});
});
test('artwork derives a constrained Plex path, rejects external/SVG/oversized responses and never proxies upstream headers',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  const image=await plex.artwork(grant,'42','poster');assert.equal(image.type,'image/png');assert.equal(image.bytes.length,4);
  const request=f.requests.find(r=>r.path==='/photo/:/transcode')!;assert.equal(request.query.get('url'),'/library/metadata/42/thumb/123');assert.equal(request.query.get('width'),'360');assert.equal(request.token,'fixture-viewer-server-token');
  f.nodes['42']!.thumb='https://attacker.invalid/image?token=secret';plex.forgetMetadata();const count=f.requests.filter(r=>r.path==='/photo/:/transcode').length;
  await assert.rejects(plex.artwork(grant,'42','poster'),{code:'ARTWORK_NOT_FOUND'});assert.equal(f.requests.filter(r=>r.path==='/photo/:/transcode').length,count);
  f.nodes['42']!.thumb='/library/metadata/42/thumb/124';plex.forgetMetadata();f.setArt('image/svg+xml');await assert.rejects(plex.artwork(grant,'42','poster'),{code:'ARTWORK_NOT_FOUND'});
  f.nodes['42']!.thumb='/library/metadata/42/thumb/125';plex.forgetMetadata();f.setArt('image/png',Buffer.alloc(6*1024*1024+1));await assert.rejects(plex.artwork(grant,'42','poster'),{code:'ARTWORK_LIMIT'});
});

test('alphabet offsets and advanced filtering share the exact catalog query and authorized scope',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  const input={genre:'7',shelf:'unwatched' as const,q:'Space',year:2024,contentRating:'PG-13',sort:'title' as const,direction:'desc' as const};
  const index=await plex.catalogIndex(grant,'10',input);assert.deepEqual(index,{entries:[{label:'#',count:2,offset:0},{label:'A',count:5,offset:2},{label:'B',count:25,offset:7}],total:32});
  await plex.catalogPage(grant,'10',input);
  const a=f.requests.find(r=>r.path.endsWith('/firstCharacter'))!,b=f.requests.find(r=>r.path.endsWith('/all'))!;
  for(const [key,value] of Object.entries({genre:'7',unwatched:'1',title:'Space',year:'2024',contentRating:'PG-13',sort:'titleSort:desc',type:'1'})){assert.equal(a.query.get(key),value);assert.equal(b.query.get(key),value);}
  assert.ok(!JSON.stringify(index).includes('must-not-leak'));
  const before=f.requests.length;await assert.rejects(plex.catalogIndex(grant,'99',{}),{code:'PLEX_ACCESS_DENIED'});assert.equal(f.requests.length,before);
  f.setPage({MediaContainer:{Metadata:[{year:2024},{year:2024},{year:2021},{}],totalSize:4}});
  assert.deepEqual(await plex.catalogIndex(grant,'10',{sort:'year',direction:'desc'}),{entries:[{label:'2024',offset:0,count:2},{label:'2021',offset:2,count:1},{label:'–',offset:3,count:1}],total:4});
  const y=f.requests.at(-1)!;assert.equal(y.query.get('sort'),'year:desc');assert.equal(y.query.get('includeFields'),'year');f.setPage(undefined);
  await assert.rejects(plex.catalogIndex(grant,'10',{shelf:'recent'}),{code:'INVALID_INDEX'});
});

test('artwork reuse shares transcoded bytes across viewers, remembers metadata briefly and still checks viewer scope',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  const transcodes=()=>f.requests.filter(r=>r.path==='/photo/:/transcode').length,reads=()=>f.requests.filter(r=>r.path==='/library/metadata/42').length;
  await plex.artwork(grant,'42','poster');await plex.artwork(grant,'42','poster');
  assert.equal(transcodes(),1);assert.equal(reads(),1);
  await assert.rejects(plex.artwork({...grant,libraries:[]},'42','poster'),{code:'PLEX_ACCESS_DENIED'});
  // Another viewer reads the metadata with their own token, then gets the same bytes.
  await plex.artwork({...grant,accountId:'another',serverToken:'another-token'},'42','poster');
  assert.equal(reads(),2);assert.equal(transcodes(),1);
  // Remembered metadata hides new art until the page asks for its version, or the library is forgotten.
  f.nodes['42']!.thumb='/library/metadata/42/thumb/999';await plex.artwork(grant,'42','poster');assert.equal(transcodes(),1);
  await plex.artwork(grant,'42','poster','999');assert.equal(reads(),3);assert.equal(transcodes(),2);
  f.nodes['42']!.thumb='/library/metadata/42/thumb/1000';plex.forgetMetadata();await plex.artwork(grant,'42','poster');assert.equal(transcodes(),3);
});

test('double-size posters transcode at twice the size and are kept apart; other kinds ignore the scale; genre art is kept',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  const transcodes=()=>f.requests.filter(r=>r.path==='/photo/:/transcode');
  await plex.artwork(grant,'42','poster');await plex.artwork(grant,'42','poster',undefined,2);
  assert.deepEqual(transcodes().map(r=>r.query.get('width')),['360','720']);assert.equal(transcodes()[1]!.query.get('height'),'1080');
  await plex.artwork(grant,'42','poster',undefined,2);assert.equal(transcodes().length,2);
  const genres=()=>f.requests.filter(r=>r.path==='/library/sections/10/genre').length;
  await plex.catalogGenreArt(grant,'10');await plex.catalogGenreArt(grant,'10');assert.equal(genres(),1);
  await assert.rejects(plex.catalogGenreArt({...grant,libraries:[]},'10'),{code:'PLEX_ACCESS_DENIED'});
  plex.forgetMetadata();await plex.catalogGenreArt(grant,'10');assert.equal(genres(),2);
});

test('artwork cache enforces byte/entry bounds, LRU eviction and expiry',()=>{
  const cache=new ArtworkCache(8,2,100),image={type:'image/png',bytes:Buffer.alloc(4)};
  cache.set('a',image,0);cache.set('b',image,0);assert.ok(cache.get('a',1));cache.set('c',image,2);
  assert.equal(cache.get('b',3),undefined);assert.ok(cache.get('a',3));assert.equal(cache.get('a',101),undefined);
  cache.set('huge',{...image,bytes:Buffer.alloc(9)},10);assert.equal(cache.get('huge',11),undefined);
});
test('watch-state actions write as the viewer, verify library scope and validate input',async()=>{
  const f=catalogFixture(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),plex=new PlexAdapter(config(),'test',f.transport),identity=new IdentityService(db,vault,plex),app=await buildApp(config(),db,vault,plex,false);
  try {
    const start=await identity.start(),signed=await identity.finish(start.binding);assert.ok(signed);const headers={cookie:`tk.box_local=${signed.cookie}`,origin:'http://127.0.0.1:3000'},post=(id:string,payload:Record<string,unknown>,h:Record<string,string>=headers)=>app.inject({method:'POST',url:`/api/v1/catalog/items/${id}/state`,headers:h,payload});
    assert.equal((await post('42',{action:'watched'},{origin:headers.origin})).statusCode,401);
    for(const payload of [{action:'delete'},{action:'watched',extra:1},{}])assert.equal((await post('42',payload)).statusCode,400);
    for(const [action,path] of [['watched','/:/scrobble'],['unwatched','/:/unscrobble'],['removeContinue','/actions/removeFromContinueWatching']] as const){
      assert.equal((await post('42',{action})).statusCode,200);const r=[...f.requests].reverse().find(x=>x.path===path)!;assert.equal(r.token,'fixture-viewer-server-token');assert.equal(r.query.get(action==='removeContinue'?'ratingKey':'key'),'42');
    }
    const writes=()=>f.requests.filter(r=>r.path.startsWith('/:/')||r.path.startsWith('/actions/')).length,before=writes();
    assert.equal((await post('900',{action:'watched'})).statusCode,403);assert.equal((await post('100',{action:'removeContinue'})).statusCode,400);assert.equal(writes(),before);
    assert.equal((await post('100',{action:'watched'})).statusCode,200);
  }finally{await app.close();db.close();}
});
test('catalog HTTP routes protect listings/details/images; VOD resume/beginning preparation never writes history',async()=>{
  const f=catalogFixture(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),plex=new PlexAdapter(config(),'test',f.transport),identity=new IdentityService(db,vault,plex),app=await buildApp(config(),db,vault,plex,false);
  try {
    const start=await identity.start(),signed=await identity.finish(start.binding);assert.ok(signed);const headers={cookie:`tk.box_local=${signed.cookie}`,origin:'http://127.0.0.1:3000'};
    for(const url of ['/api/v1/catalog/libraries/10/items','/api/v1/catalog/libraries/10/index','/api/v1/catalog/libraries/10/genres','/api/v1/catalog/items/42','/api/v1/catalog/items/42/artwork'])assert.equal((await app.inject({url})).statusCode,401);
    for(const query of ['limit=61','offset=-1','sort=unsafe','genre=unsafe','shelf=watched','url=http://arbitrary.invalid'])assert.equal((await app.inject({url:`/api/v1/catalog/libraries/10/items?${query}`,headers})).statusCode,400);
    assert.equal((await app.inject({url:'/api/v1/catalog/libraries/99/genres',headers})).statusCode,403);
    assert.equal((await app.inject({url:'/api/v1/catalog/libraries/10/genres',headers})).json().genres[0].title,'Drama');
    assert.equal((await app.inject({url:'/api/v1/catalog/libraries/99/items',headers})).statusCode,403);
    const listing=await app.inject({url:'/api/v1/catalog/libraries/10/items',headers});assert.equal(listing.statusCode,200);assert.ok(!listing.body.includes('secret'));
    const art=await app.inject({url:'/api/v1/catalog/items/42/artwork',headers});assert.equal(art.statusCode,200);assert.equal(art.headers['content-type'],'image/png');assert.equal(art.headers['x-secret'],undefined);
    assert.equal((await app.inject({url:'/api/v1/catalog/items/42/artwork',headers:{...headers,'if-none-match':art.headers.etag}})).statusCode,304);
    assert.equal(art.headers['cache-control'],'private, no-cache');
    assert.equal((await app.inject({url:'/api/v1/catalog/items/42/artwork?kind=poster&v=123&scale=2',headers})).statusCode,200);assert.equal((await app.inject({url:'/api/v1/catalog/items/42/artwork?scale=3',headers})).statusCode,400);
    const pinned=await app.inject({url:'/api/v1/catalog/items/42/artwork?kind=poster&v=123',headers});assert.equal(pinned.statusCode,200);assert.equal(pinned.headers['cache-control'],'private, max-age=31536000, immutable');
    const packed=await app.inject({url:'/api/v1/catalog/libraries/10/genres',headers:{...headers,'accept-encoding':'br, gzip'}});assert.equal(packed.headers['content-encoding'],undefined);
    f.setPage({MediaContainer:{Metadata:Array.from({length:40},(_,i)=>({...f.nodes['42'],ratingKey:String(1000+i)})),offset:0,totalSize:40}});
    const big=await app.inject({url:'/api/v1/catalog/libraries/10/items?limit=60',headers:{...headers,'accept-encoding':'br, gzip'}});f.setPage(undefined);
    assert.equal(big.headers['content-encoding'],'br');assert.ok(big.rawPayload.length<JSON.stringify(listing.json()).length*40/4);
    assert.equal((await app.inject({url:'/api/v1/catalog/items/42/artwork?kind=poster&v=123',headers:{...headers,'accept-encoding':'br, gzip'}})).headers['content-encoding'],undefined);assert.equal((await app.inject({url:'/api/v1/catalog/items/42/artwork?v=x',headers})).statusCode,400);
    assert.equal((await app.inject({url:'/api/v1/catalog/items/42/artwork?url=http://arbitrary.invalid',headers})).statusCode,400);
    const payload={mode:'plex_vod',ratingKey:'42',capabilities:{videoCodecs:['h264:8'],audioCodecs:['aac'],containers:['mp4']}};
    const resume=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload});assert.equal(resume.statusCode,200);assert.equal(resume.json().startOffsetMs,120000);
    const beginning=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{...payload,startFrom:'beginning'}});assert.equal(beginning.statusCode,200);assert.equal(beginning.json().startOffsetMs,0);
    assert.ok(!f.requests.some(r=>r.path==='/:/timeline'));
    f.base.options.authorized=false;assert.equal((await app.inject({url:'/api/v1/catalog/items/42/artwork',headers:{...headers,'if-none-match':art.headers.etag}})).statusCode,403);
  }finally{await app.close();db.close();}
});
test('overlapping authentication checks coalesce without a grant TTL and recheck local revocation before returning',async()=>{
  const f=fakePlex(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32));let held=false,release:()=>void=()=>{},requests=0;
  const transport=(async(input:string|URL|Request,init?:RequestInit)=>{if(new URL(String(input)).pathname==='/api/v2/user'){requests++;if(held)await new Promise<void>(resolve=>{release=resolve;});}return f.transport(input,init);}) as typeof fetch;
  const identity=new IdentityService(db,vault,new PlexAdapter(config(),'test',transport));
  try {
    const link=await identity.start(),session=await identity.finish(link.binding);assert.ok(session);const baseline=requests;
    await Promise.all(Array.from({length:10},()=>identity.authenticate(session.cookie)));assert.equal(requests,baseline+1);
    await identity.authenticate(session.cookie);assert.equal(requests,baseline+2);
    held=true;const attempts=Array.from({length:4},()=>identity.authenticate(session.cookie)),settled=Promise.allSettled(attempts);identity.logout(session.cookie);release();
    assert.ok((await settled).every(r=>r.status==='rejected'&&(r.reason as {code:string}).code==='UNAUTHENTICATED'));
  }finally{db.close();}
});

test('a passed Plex check is reused for the recheck window, while sign-out and Plex refusals apply at once',async()=>{
  const f=fakePlex(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32));let requests=0;
  const transport=(async(input:string|URL|Request,init?:RequestInit)=>{if(new URL(String(input)).pathname==='/api/v2/user')requests++;return f.transport(input,init);}) as typeof fetch;
  const identity=new IdentityService(db,vault,new PlexAdapter(config(),'test',transport),60000,[0,0]);
  try {
    const link=await identity.start(1000),session=await identity.finish(link.binding,4000);assert.ok(session);
    await identity.authenticate(session.cookie,5000);const baseline=requests;
    await identity.authenticate(session.cookie,30000);assert.equal(requests,baseline);
    f.options.authorized=false;await identity.authenticate(session.cookie,64000);assert.equal(requests,baseline);
    await assert.rejects(identity.authenticate(session.cookie,65001),{code:'PLEX_ACCESS_DENIED'});assert.equal(requests,baseline+3);
    f.options.authorized=true;await identity.authenticate(session.cookie,70000);const again=requests;
    identity.forget(session.cookie);await identity.authenticate(session.cookie,71000);assert.equal(requests,again+1);
    identity.logout(session.cookie);await assert.rejects(identity.authenticate(session.cookie,72000),{code:'UNAUTHENTICATED'});
  }finally{db.close();}
});

test('recent TV uses series posters and gives a season one card however its episodes arrived',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  const episode=(key:string,show:string,season:string,index:number,addedAt:number)=>({ratingKey:key,librarySectionID:'20',type:'episode',title:`Episode ${index}`,parentRatingKey:season,parentTitle:'Season 1',parentIndex:1,index,grandparentRatingKey:show,grandparentTitle:`Show ${show}`,thumb:`/library/metadata/${key}/thumb/1`,grandparentThumb:`/library/metadata/${show}/thumb/1`,addedAt});
  const day=86400;
  f.setPage({MediaContainer:{Metadata:[episode('501','100','101',3,10*day),episode('502','100','101',2,10*day-60),episode('601','200','201',1,8*day),episode('504','100','101',1,2*day)],totalSize:4}});
  const page=await plex.catalogPage(grant,'20',{shelf:'recent',limit:20});
  assert.equal(f.requests.find(r=>r.path==='/library/sections/20/recentlyAdded')!.query.get('X-Plex-Container-Size'),'60');
  assert.deepEqual(page.items.map(i=>[i.type,i.id]),[['season','101'],['episode','601']]);
  const season=page.items[0]!;assert.equal(season.episodeCount,3);assert.equal(season.showTitle,'Show 100');assert.equal(season.posterUrl,'/api/v1/catalog/items/100/artwork?kind=poster&v=1');
  assert.equal(page.items[1]!.showPosterUrl,'/api/v1/catalog/items/200/artwork?kind=poster&v=1');assert.equal(page.items[1]!.posterUrl,'/api/v1/catalog/items/601/artwork?kind=poster&v=1');
  assert.equal(page.hasMore,false);
});

test('recent TV stops taking in episodes where the row ends, so a card never reaches past it',()=>{
  const ep=(show:string,season:string,id:string)=>({id,libraryId:'20',type:'episode',title:id,summary:'',viewOffsetMs:0,watched:false,genres:[],parentId:season,showId:show,showTitle:show}) as CatalogItem;
  const cards=groupRecentEpisodes([ep('a','a1','1'),ep('b','b1','2'),ep('a','a1','3'),ep('c','c1','4'),ep('b','b1','5'),ep('a','a2','6')],2);
  assert.deepEqual(cards.map(c=>[c.type,c.id,c.episodeCount]),[['season','a1',2],['episode','2',undefined]]);
  assert.deepEqual(groupRecentEpisodes([ep('a','a1','1'),ep('b','b1','2'),ep('a','a2','3')]).map(c=>[c.type,c.id,c.seasonCount]),[['show','a',2],['episode','2',undefined]]);
});

test('recent TV merges every season of one show into a show card, around other shows',async()=>{
  const f=catalogFixture(),plex=new PlexAdapter(config(),'test',f.transport),grant=await plex.authorize('fixture');
  const episode=(key:string,show:string,season:string,index:number,addedAt:number)=>({ratingKey:key,librarySectionID:'20',type:'episode',title:`Episode ${index}`,parentRatingKey:season,parentTitle:`Season ${season}`,parentIndex:1,index,grandparentRatingKey:show,grandparentTitle:`Show ${show}`,thumb:`/library/metadata/${key}/thumb/1`,grandparentThumb:`/library/metadata/${show}/thumb/1`,addedAt});
  const day=86400;
  f.setPage({MediaContainer:{Metadata:[
    episode('11','100','102',2,10*day),episode('12','100','102',1,10*day-60),
    episode('21','200','201',2,10*day-90),episode('22','200','201',1,10*day-100),
    episode('13','100','101',2,10*day-120),episode('14','100','101',1,10*day-180),
    // An earlier batch of the same show joins its card.
    episode('15','100','103',2,5*day),episode('16','100','103',1,5*day-60)],totalSize:8}});
  const page=await plex.catalogPage(grant,'20',{shelf:'recent',limit:20});
  assert.deepEqual(page.items.map(i=>[i.type,i.id]),[['show','100'],['season','201']]);
  const show=page.items[0]!;assert.equal(show.title,'Show 100');assert.equal(show.seasonCount,3);assert.equal(show.episodeCount,6);assert.equal(show.posterUrl,'/api/v1/catalog/items/100/artwork?kind=poster&v=1');
});

test('non-title jump buckets follow the sorted order and pick a readable granularity',()=>{
  const decades=Array.from({length:40},(_,i)=>2020-i);
  assert.deepEqual(sortIndex('year',decades).map(e=>[e.label,e.offset,e.count]),[['2020s',0,1],['2010s',1,10],['2000s',11,10],['1990s',21,10],['1980s',31,9]]);
  assert.deepEqual(sortIndex('rating',[9.4,9,8.7,undefined]).map(e=>[e.label,e.count]),[['9',2],['8',1],['–',1]]);
  assert.deepEqual(sortIndex('duration',[22*60000,25*60000,44*60000]).map(e=>e.label),['20m','40m']);
  assert.deepEqual(sortIndex('duration',[95*60000,130*60000,200*60000]).map(e=>e.label),['1½h','2h','3h+']);
  const day=(s:string)=>Date.parse(s)/1000;
  assert.deepEqual(sortIndex('newest',[day('2026-10-01'),day('2026-03-02')]).map(e=>e.label),['Oct','Mar']);
  assert.deepEqual(sortIndex('newest',[day('2026-10-01'),day('2025-03-02')]).map(e=>e.label),['2026','2025']);
  // A label that recurs out of order folds into its first bucket.
  assert.deepEqual(sortIndex('rating',[8,7,8]),[{label:'8',offset:0,count:2},{label:'7',offset:1,count:1}]);
});

test('promoted Home hubs yield each collection once, in Plex order, skipping rows that are not collections or do not parse',async()=>{
  const hubs=promotedHubs.parse({MediaContainer:{Hub:[
    {hubIdentifier:'home.continue',key:'/hubs/home/continueWatching',title:'Continue Watching'},
    {hubIdentifier:'custom.collection.2.900',key:'/library/collections/900/children',title:'Halloween - All Time Classics'},
    {hubIdentifier:'custom.collection.1.800'},
    {key:'/library/collections/700/children?excludeAllLeaves=1'},
    {hubIdentifier:'custom.collection.1.800.extra',title:'Malformed'},
    {hubIdentifier:'custom.collection.1.800',key:'/library/collections/800/children',title:'Christmas again'},
    {key:42,title:'Odd row'},'not a hub',
  ]}});
  assert.deepEqual(promotedCollectionIds(hubs),['900','800','700']);
  assert.deepEqual(promotedCollectionIds(promotedHubs.parse({MediaContainer:{size:0}})),[]);
  assert.deepEqual(promotedCollectionIds(promotedHubs.parse({})),[]);
  // Each one is read back with the viewer's grant; collections outside their libraries are left off.
  const f=catalogFixture();
  f.nodes['900']={ratingKey:'900',type:'collection',librarySectionID:'20',title:'Halloween - All Time Classics'};
  f.nodes['800']={ratingKey:'800',type:'collection',librarySectionID:'99',title:'Hidden'};
  const transport=(async(input:string|URL|Request,init?:RequestInit)=>new URL(String(input)).pathname==='/hubs/promoted'?Response.json({MediaContainer:{Hub:[{key:'/library/collections/900/children'},{key:'/library/collections/800/children'},{key:'/library/collections/555/children'}]}}):f.transport(input,init)) as typeof fetch;
  const plex=new PlexAdapter(config(),'test',transport),grant=await plex.authorize('fixture');
  assert.deepEqual(await plex.homeCollections(grant),{collections:[{id:'900',title:'Halloween - All Time Classics',libraryId:'20'}]});
});
test('external ratings map Plex rating images to sources in a fixed order, falling back to the top-level pairs',()=>{
  const node=(extra:object)=>catalogNode.parse({ratingKey:'1',type:'movie',title:'A',...extra});
  assert.deepEqual(externalRatings(node({Rating:[
    {image:'themoviedb://image.rating',value:7.8,type:'audience'},{image:'rottentomatoes://image.rating.spilled',value:4.2,type:'audience'},
    {image:'imdb://image.rating',value:7.6,type:'audience'},{image:'rottentomatoes://image.rating.ripe',value:8.1,type:'critic'},{image:'unknown://x',value:5}
  ]})),[{source:'imdb',score:7.6},{source:'tomatometer',score:8.1,fresh:true},{source:'popcornmeter',score:4.2,fresh:false},{source:'tmdb',score:7.8}]);
  assert.deepEqual(externalRatings(node({rating:6.1,ratingImage:'rottentomatoes://image.rating.rotten',audienceRating:8,audienceRatingImage:'rottentomatoes://image.rating.upright'})),
    [{source:'tomatometer',score:6.1,fresh:false},{source:'popcornmeter',score:8,fresh:true}]);
  assert.equal(externalRatings(node({rating:7})),undefined);
  // A malformed Rating list is dropped instead of failing the item.
  assert.equal(externalRatings(node({Rating:'bad'})),undefined);
});
