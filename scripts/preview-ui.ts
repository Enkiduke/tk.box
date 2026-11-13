// Loopback-only UI fixture. Uses isolated in-memory data and never reads .env or real Plex.
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {buildApp} from '../apps/server/src/app.js';
import {loadConfig} from '../apps/server/src/config.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {IptvStore} from '../apps/server/src/persistence/iptv-store.js';
import {ArtworkStore} from '../apps/server/src/persistence/artwork-store.js';
import {ExploreStore} from '../apps/server/src/persistence/explore-store.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {PlexAdapter} from '../apps/server/src/providers/plex.js';
import {IdentityService} from '../apps/server/src/services/identity.js';
import {fakePlex} from '../tests/fixtures.js';

// Small original abstract PNGs keep the preview self-contained.
function artwork(seed:number) {
  const width=640,height=400,raw=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const p=y*(width*3+1)+1+x*3,glow=Math.max(0,1-Math.hypot((x-430)/500,(y-130)/400));
    const ridge=y>240+Math.sin(x/95+seed)*50?0.3:1;
    raw[p]=Math.round((22+glow*(90+seed*9))*ridge);raw[p+1]=Math.round((35+glow*(110-seed*5))*ridge);raw[p+2]=Math.round((38+glow*(80+seed*6))*ridge);
  }
  function chunk(type:string,data:Buffer) {
    const bytes=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
    for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([head,bytes,tail]);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// --port=<n> runs a second harness beside another; its own cookie namespace keeps both sign-ins.
const port=Number(process.argv.find(arg=>arg.startsWith('--port='))?.slice(7)??3011),namespace=port===3011?'tk.box_ui_preview':`tk.box_ui_preview_${port}`;
const config=loadConfig({APP_PORT:String(port),PLEX_MACHINE_ID:'machine',PLEX_OWNER_ACCOUNT_ID:'1',PLEX_REQUIRED_LIBRARY_IDS:'10,20'}),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),base=fakePlex({accountId:1});
const titles=['The Quiet Frontier','After the Rain','A Place Between Stars','The Long Way Home','Wild at Heart','Beyond the Blue','Midnight in Motion','A Different Light','Into the Valley','The Last Summer','Northern Skies','Small Hours'];
const nodes=titles.map((title,i)=>({ratingKey:String(42+i),librarySectionID:'10',type:'movie',title,summary:'A journey through unfamiliar places becomes a story about the people and moments that make us feel at home. An independent film from your personal collection.',year:2020+i%6,duration:6600000+i*60000,viewOffset:i<3?(i+1)*600000:0,viewCount:i===5?1:0,thumb:`/library/metadata/${42+i}/thumb/1`,art:`/library/metadata/${42+i}/art/1`,rating:7+i%3*.7,contentRating:'PG-13',Genre:[{tag:i%2?'Drama':'Adventure'}],Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',width:1920,height:1080,Part:[{key:'/library/parts/7/123/file.mp4'}]}]}));
const shows=titles.slice(0,6).map((title,i)=>({...nodes[i]!,ratingKey:String(100+i),librarySectionID:'20',type:'show',title:`${title}: The Series`,leafCount:8,viewOffset:0}));
const seasons=shows.map((show,i)=>({...show,ratingKey:String(200+i),type:'season',parentRatingKey:show.ratingKey,title:'Season 1',index:1}));
const episodes=shows.flatMap((show,k)=>titles.slice(0,8).map((title,i)=>({...nodes[i]!,ratingKey:String(300+k*10+i),type:'episode',librarySectionID:'20',title,parentRatingKey:String(200+k),parentTitle:'Season 1',grandparentRatingKey:show.ratingKey,grandparentTitle:show.title,parentIndex:1,index:i+1,duration:2700000,grandparentThumb:show.thumb,parentThumb:show.thumb,addedAt:1760000000-k*172800-i*60})));
// Recently added TV: the first show's whole season arrived at once, the others one episode each.
const recentEpisodes=episodes.filter(e=>e.grandparentRatingKey===shows[0]!.ratingKey||e.index===1);
const all=[...nodes,...shows,...seasons,...episodes],removed=new Set<string>(),images=Array.from({length:6},(_,i)=>artwork(i));
for(const [index,node] of [...nodes,...shows].entries()) Object.assign(node,{Guid:[{id:`tmdb://${node.ratingKey}`}],addedAt:1760000000-index*86400});
const viewedAt=Math.floor(Date.now()/1000);
Object.assign(nodes[5]!,{lastViewedAt:viewedAt-60});
Object.assign(episodes[0]!,{viewCount:1,lastViewedAt:viewedAt-120});
const watchlist=new Set<string>();
const transport=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input));
  if(url.hostname==='discover.provider.plex.tv'){
    if(url.pathname==='/hubs/sections/home')return Response.json({MediaContainer:{Hub:[
      {key:'/hubs/preview/picks',title:'Plex Picks',type:'movie'},
      {key:'/hubs/preview/netflix',title:'Trending on Netflix',type:'movie'}
    ]}});
    if(url.pathname.startsWith('/hubs/preview/'))return Response.json({MediaContainer:{Metadata:nodes}});
    if(url.pathname.startsWith('/actions/')){
      const id=url.searchParams.get('ratingKey')??'';
      if(url.pathname.endsWith('/addToWatchlist'))watchlist.add(id);else watchlist.delete(id);
      return Response.json({MediaContainer:{}});
    }
    const state=/^\/library\/metadata\/(\d+)\/userState$/.exec(url.pathname);
    if(state)return Response.json({MediaContainer:{UserState:{watchlistedAt:watchlist.has(state[1]!)?1:undefined}}});
    const match=url.searchParams.get('guid')?.match(/^tmdb:\/\/(\d+)$/);
    const metadata=url.pathname.endsWith('/matches')?all.filter(node=>node.ratingKey===match?.[1])
      :url.pathname.includes('/watchlist/')?all.filter(node=>watchlist.has(node.ratingKey)):[];
    return Response.json({MediaContainer:{Metadata:metadata}});
  }
  if(url.pathname==='/photo/:/transcode')return new Response(images[Number(url.searchParams.get('url')?.split('/')[3]??0)%6],{headers:{'content-type':'image/png'}});
  if(url.pathname.endsWith('/genre'))return Response.json({MediaContainer:{Directory:[{key:'1',title:'Adventure'},{key:'2',title:'Drama'}]}});
  // Watch-state writes mutate the fixture so the UI can be exercised end to end.
  if(['/:/scrobble','/:/unscrobble','/actions/removeFromContinueWatching'].includes(url.pathname)){
    const id=url.searchParams.get('key')??url.searchParams.get('ratingKey')??'';
    if(url.pathname==='/actions/removeFromContinueWatching')removed.add(id);
    else {
      const watched=url.pathname==='/:/scrobble';
      for(const n of all)if(n.ratingKey===id||(n as {parentRatingKey?:string}).parentRatingKey===id||(n as {grandparentRatingKey?:string}).grandparentRatingKey===id)Object.assign(n,{viewCount:watched?1:0,viewOffset:0});
      for(const n of [...shows,...seasons]){const leaves=episodes.filter(e=>e.parentRatingKey===n.ratingKey||e.grandparentRatingKey===n.ratingKey);Object.assign(n,{viewedLeafCount:leaves.filter(e=>e.viewCount).length});}
    }
    return new Response('',{status:200});
  }
  const detail=/^\/library\/metadata\/(\d+)$/.exec(url.pathname);
  if(detail)return Response.json({MediaContainer:{Metadata:all.filter(n=>n.ratingKey===detail[1])}});
  const children=/^\/library\/metadata\/(\d+)\/children$/.exec(url.pathname);
  if(children){const items=[...seasons,...episodes].filter(n=>n.parentRatingKey===children[1]);return Response.json({MediaContainer:{Metadata:items,totalSize:items.length}});}
  if(url.pathname.startsWith('/library/sections/')) {
    let items=url.pathname.includes('/20/')?url.searchParams.get('type')==='4'?episodes:shows:nodes;
    if(url.pathname.endsWith('/onDeck'))items=(url.pathname.includes('/20/')?episodes:nodes).filter(n=>n.viewOffset>0&&!n.viewCount&&!removed.has(n.ratingKey)).slice(0,url.pathname.includes('/20/')?2:3);
    if(url.pathname==='/library/sections/20/recentlyAdded')items=recentEpisodes;
    if(url.pathname.endsWith('/unwatched')||url.searchParams.get('unwatched')==='1')items=items.filter(n=>!n.viewCount);
    if(url.searchParams.get('unwatched')==='0')items=items.filter(n=>n.viewCount);
    const q=url.searchParams.get('title')?.toLowerCase();if(q)items=items.filter(n=>n.title.toLowerCase().includes(q));
    const genre=url.searchParams.get('genre');if(genre)items=items.filter(n=>n.Genre[0]!.tag===(genre==='1'?'Adventure':'Drama'));
    const year=url.searchParams.get('year'),rating=url.searchParams.get('contentRating');if(year)items=items.filter(n=>n.year===Number(year));if(rating)items=items.filter(n=>n.contentRating===rating);
    const sort=url.searchParams.get('sort')??(url.pathname.endsWith('/recentlyAdded')?'none':'titleSort:asc'),field=sort.split(':')[0];if(field!=='none')items=[...items].sort((a,b)=>field==='year'?a.year-b.year:field==='rating'?a.rating-b.rating:field==='duration'?a.duration-b.duration:a.title.localeCompare(b.title));if(sort.endsWith(':desc'))items.reverse();
    if(url.pathname.endsWith('/firstCharacter')){const counts=new Map<string,number>();for(const item of items){const label=/^[A-Z]/i.test(item.title)?item.title[0]!.toUpperCase():'#';counts.set(label,(counts.get(label)??0)+1);}return Response.json({MediaContainer:{Directory:[...counts].map(([title,size])=>({title,size}))}});}
    const offset=Number(url.searchParams.get('X-Plex-Container-Start')??0),limit=Number(url.searchParams.get('X-Plex-Container-Size')??24);
    return Response.json({MediaContainer:{Metadata:items.slice(offset,offset+limit),offset,totalSize:items.length}});
  }
  return base.transport(input,init);
}) as typeof fetch;
const plex=new PlexAdapter(config,'ui-fixture',transport),identity=new IdentityService(db,vault,plex),link=await identity.start(),session=await identity.finish(link.binding);
if(!session)throw Error('Fixture sign-in failed');
const store=new IptvStore(db,vault),source=store.create('1',{kind:'m3u',name:'Preview channels'}),names=['World News','Cinema Club','Nature & Beyond','The Music Room','History Daily','Travel Stories'];
// Optional --stream=<url> arguments give the first channels real streams for live playback checks.
const streams=process.argv.slice(2).filter(arg=>arg.startsWith('--stream=')).map(arg=>arg.slice(9));
// Extra feeds without provider IDs stack under World News; the FHD feed becomes its default.
const feeds=['World News FHD','World News SD (Backup)'],groups=['News','Movies','Documentary','Music','Documentary','Lifestyle'];
store.ingest('1',source.id,0,Buffer.from('#EXTM3U\n'+names.map((name,i)=>`#EXTINF:-1 tvg-id="ch${i}" group-title="${groups[i]}",${name}\n${streams[i]??`https://fixture.invalid/${i}`}`).join('\n')+'\n'+feeds.map((name,i)=>`#EXTINF:-1 group-title="News",${name}\n${streams[i+1]??`https://fixture.invalid/feed${i}`}`).join('\n')));
// The preview never plays its fixture streams, so its channels list without waiting for a first check.
store.setListingPolicy('1',source.id,{...store.listingPolicy(source.id),requireCheck:false,expectedRevision:store.status(source.id).revision});
for(const c of store.adminChannels(source.id)){const i=names.indexOf(c.name);store.editChannel('1',c.id,{expectedRevision:store.status(source.id).revision,number:i<0?201+feeds.indexOf(c.name):101+i,position:i<0?100:i});}
const feed=store.create('1',{kind:'xmltv',name:'Preview guide'}),start=Math.floor(Date.now()/1800000)*1800000-3600000;
const xmlTime=(t:number)=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const xml='<tv>'+names.map((name,i)=>`<channel id="ch${i}"><display-name>${name.replaceAll('&','&amp;')}</display-name></channel>`).join('')+names.map((_,i)=>Array.from({length:12},(_,j)=>`<programme channel="ch${i}" start="${xmlTime(start+j*1800000)}" stop="${xmlTime(start+(j+1)*1800000)}"><title>${titles[(i+j)%titles.length]}</title></programme>`).join('')).join('')+'</tv>';
store.ingest('1',feed.id,0,Buffer.from(xml));store.bindFeed('1',source.id,feed.id,store.status(source.id).revision);
for(const c of store.visible().slice(0,3))store.favorite('1',c.id,true);
// Waits for channel checks: nothing here is listed until a channel plays.
const pending=store.create('1',{kind:'m3u',name:'Awaiting checks preview'});
store.ingest('1',pending.id,0,Buffer.from('#EXTM3U\n'+['Culture One','Culture Two','Arts Daily 24/7','Encore'].map((name,i)=>`#EXTINF:-1 tvg-id="pending${i}" group-title="${i<2?'Culture':'Arts'}",${name}\nhttps://fixture.invalid/pending${i}`).join('\n')));
const artworkStore=new ArtworkStore(db,vault,'apps/artwork/defaults.json');
const {revision:artworkRevision,...artworkSettings}=artworkStore.settings();
await artworkStore.update('1',artworkRevision,{...artworkSettings,tmdbKey:'fixture-tmdb-key'},async()=>{});
new ExploreStore(db,vault).update('1',0,{seerrUrl:'https://seerr.fixture.invalid',seerrApiKey:'fixture-seerr-key'});
const requested=new Set<number>();
const seerr=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input)),path=url.pathname.replace('/api/v1','');
  if(path==='/settings/public')return Response.json({initialized:true,region:'US'});
  if(path==='/auth/plex')return Response.json({}, {headers:{'set-cookie':'connect.sid=preview; Path=/'}});
  if(path==='/auth/me')return Response.json({id:1,displayName:'Preview viewer',permissions:1});
  if(path==='/media')return Response.json({results:[...requested].map(tmdbId=>({mediaType:'movie',tmdbId,status:2})),pageInfo:{pages:1}});
  if(path==='/request'&&init?.method==='POST') {
    const {mediaId}=JSON.parse(String(init.body)) as {mediaId:number};
    requested.add(mediaId);return Response.json({id:mediaId});
  }
  if(path==='/service/radarr'||path==='/service/sonarr')return Response.json([]);
  const match=/^\/(movie|tv)\/(\d+)$/.exec(path);
  if(match){
    const id=Number(match[2]),node=all.find(n=>Number(n.ratingKey)===id);
    return Response.json({id,[match[1]==='tv'?'name':'title']:node?.title??'Fixture title',
      mediaInfo:id===42?{status:5,ratingKey:'42'}:requested.has(id)?{status:2}:undefined});
  }
  if(/\/\d+\/ratingscombined$/.test(path))return Response.json({});
  return Response.json({results:[],totalPages:1});
}) as typeof fetch;
let failedPage=false;
const streamingServices=['Netflix','Amazon Prime Video','Disney Plus','Hulu','HBO Max','Apple TV','Paramount Plus Essential','Peacock Premium','MGM Plus','Discovery Plus'];
const tmdb=(async(input:string|URL|Request)=>{
  const url=new URL(String(input)),path=url.pathname;
  if(path.endsWith('/providers/regions'))return Response.json({results:[{iso_3166_1:'US',english_name:'United States'},{iso_3166_1:'GB',english_name:'United Kingdom'}]});
  if(path.startsWith('/3/watch/providers/'))return Response.json({results:streamingServices.map((name,index)=>({provider_id:index+1,provider_name:name,logo_path:`/${index}.png`}))});
  const page=Number(url.searchParams.get('page')??1),providers=url.searchParams.get('with_watch_providers');
  const selection=providers&&!providers.includes('|')?Number(providers):0;
  const show=path.includes('/tv'),label=streamingServices[selection-1]??'Explore';
  const today=new Date().toISOString().slice(0,10);
  const start=url.searchParams.get(`${show?'first_air_date':'primary_release_date'}.gte`);
  const upcoming=start&&start>=today;
  const dateGroup=upcoming?Math.floor((Date.parse(start)-Date.parse(today))/86400000):0;
  const release=upcoming?start:today;
  if(selection===2)await new Promise(resolve=>setTimeout(resolve,450));
  if(selection===2&&page===2&&!show&&!failedPage){failedPage=true;return Response.json({}, {status:503});}
  const results=Array.from({length:16},(_,i)=>{
    const id=path.includes('/discover/')&&page===1&&i===0&&!show&&!upcoming?42:1000+selection*1000+page*100+i+dateGroup*100;
    const title=id===42?titles[0]:`${label} · ${titles[i%titles.length]} ${show?'TV':'Film'} ${page}`;
    return {id,[show?'name':'title']:title,[show?'first_air_date':'release_date']:release,
      overview:'A fixture title for the Explore preview.',poster_path:`/${i}.png`,original_language:'en',genre_ids:[i%2?18:35],vote_average:7.5,vote_count:90,popularity:20-i};
  });
  return Response.json({results,total_pages:3});
}) as typeof fetch;
const exploreImages=(async(input:string|URL|Request)=>{
  const index=Number(/\/(\d+)\.png$/.exec(String(input))?.[1]??0)%images.length;
  return new Response(images[index],{headers:{'content-type':'image/png'}});
}) as typeof fetch;
const app=await buildApp(config,db,vault,plex,false,namespace,{tmdb,seerr,images:exploreImages});
app.get('/__preview',async(_req,reply)=>reply.setCookie(`${namespace}_local`,session.cookie,{httpOnly:true,sameSite:'lax',path:'/'}).redirect('/#home'));
if(process.argv.includes('--check-explore')){
  try{
    const cookie=(await app.inject('/__preview')).cookies[0];
    assert.ok(cookie);
    const api=(url:string,method:'GET'|'POST'|'PUT'='GET',payload?:object)=>app.inject({
      url:`/api/v1/explore/${url}`,method,payload,headers:{origin:config.browserOrigin},cookies:{[cookie.name]:cookie.value}
    });
    const popular='tmdb/rows/popular-streaming';
    const allServices=(await api(`${popular}?provider=all`)).json();
    const netflix=(await api(`${popular}?provider=1`)).json();
    const prime=(await api(`${popular}?provider=2`)).json();
    assert.match(netflix.items[1].title,/Netflix/);
    assert.match(prime.items[1].title,/Prime Video/);
    assert.notEqual(allServices.items[1].key,netflix.items[1].key);
    const later=`${popular}?provider=2&page=2`;
    assert.equal((await api(later)).statusCode,502);
    assert.equal((await api(later)).statusCode,200);
    const {items}= (await api('tmdb/rows/top-picks')).json();
    assert.ok(items.length);
    assert.ok(!items.some((item:{key:string})=>item.key==='movie:tmdb:42'));
    assert.equal((await api('tmdb/rows/because-1')).json().title,`Because You Watched ${nodes[5]!.title}`);
    assert.equal((await api('tmdb/rows/because-2')).json().title,`Because You Watched ${shows[0]!.title}`);
    const details='details?kind=movie&tmdb=42&title=The%20Quiet%20Frontier';
    const owned=(await api(details)).json();
    assert.equal(owned.libraryId,'42');
    const playback=await app.inject({url:'/api/v1/playback/sessions',method:'POST',headers:{origin:config.browserOrigin},
      cookies:{[cookie.name]:cookie.value},payload:{mode:'plex_vod',ratingKey:owned.libraryId,
        capabilities:{videoCodecs:['h264:8'],audioCodecs:['aac'],containers:['mp4']}}});
    assert.equal(playback.statusCode,200,playback.body);
    assert.equal(playback.json().delivery,'direct');
    assert.equal(owned.watchlisted,false);
    assert.equal((await api('watchlist','PUT',{plex:owned.item.ids.plex,add:true})).statusCode,200);
    assert.equal((await api(details)).json().watchlisted,true);
    const candidate=netflix.items.find((item:{kind:string;ids:{tmdb:number}})=>item.kind==='movie'&&item.ids.tmdb!==42);
    const unowned=(await api(`details?kind=movie&tmdb=${candidate.ids.tmdb}&title=${encodeURIComponent(candidate.title)}`)).json();
    assert.equal(unowned.seerr.requestable,true);
    assert.equal((await api('request','POST',{kind:'movie',tmdb:candidate.ids.tmdb})).statusCode,200);
    assert.equal((await api(`${popular}?provider=1`)).json().items.find((item:{key:string})=>item.key===candidate.key).status,'requested');
    console.log('Explore fixture passed provider changes, page retry, recommendations, Plex playback preparation and watchlist, and Seerr requests.');
  }finally{await app.close();db.close();}
}else{
  await app.listen({host:'127.0.0.1',port});
  console.log(`Isolated UI fixture: http://127.0.0.1:${port}/__preview`+' (synthetic media'+(streams.length?`; ${streams.length} live test channel(s)`:'; no real playback')+').');
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>{db.close();process.exit();});});
}
