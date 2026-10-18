import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PlexAdapter} from '../apps/server/src/providers/plex.js';
import {chooseRoute} from '../apps/server/src/streaming/policy.js';
import {openDatabase,SettingsStore} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {IdentityService} from '../apps/server/src/services/identity.js';
import {buildApp} from '../apps/server/src/app.js';
import {config,fakePlex,metadata} from './fixtures.js';

const media=(ratingKey:string,container:string,videoCodec:string,audioCodec:string)=>({...metadata,ratingKey,Media:[{...metadata.Media[0]!,container,videoCodec,audioCodec,Part:[{key:`/library/parts/${ratingKey}/1/file.${container}`,Stream:[{id:1,streamType:1,codec:videoCodec,bitDepth:8},{id:2,streamType:2,codec:audioCodec}]}]}]});
// A browser-playable MP4 with a default English track and a French alternative.
const multiAudio=(ratingKey:string)=>({...media(ratingKey,'mp4','h264','aac'),Media:[{...media(ratingKey,'mp4','h264','aac').Media[0]!,Part:[{key:`/library/parts/${ratingKey}/1/file.mp4`,Stream:[
  {id:1,streamType:1,codec:'h264',bitDepth:8},{id:2,streamType:2,codec:'aac',languageCode:'eng',displayTitle:'English (AAC Stereo)',default:true,selected:true},{id:3,streamType:2,codec:'ac3',languageCode:'fra',displayTitle:'Français (AC3 5.1)'}]}]}]});
function transcoderFixture() {
  const base=fakePlex(),requests:{path:string;query:URLSearchParams;token:string|null}[]=[];
  const items:Record<string,unknown>={'50':media('50','mkv','h264','ac3'),'51':media('51','avi','mpeg4','mp3'),'52':media('52','mkv','h264','dts'),'60':multiAudio('60'),'62':multiAudio('62')};
  const transport=(async(url:string|URL|Request,init?:RequestInit)=>{
    const u=new URL(String(url)),headers=new Headers(init?.headers),path=u.pathname;
    requests.push({path,query:u.searchParams,token:headers.get('X-Plex-Token')});
    const id=path.match(/^\/library\/metadata\/(\d+)$/)?.[1];
    if(id&&items[id])return Response.json({MediaContainer:{Metadata:[items[id]]}});
    if(init?.method==='PUT'&&/^\/library\/parts\/\d+$/.test(path))return new Response('',{status:200});
    const session=u.searchParams.get('session');
    if(path==='/video/:/transcode/universal/decision'){
      const key=u.searchParams.get('path')!.split('/').pop()!,copy=key!=='52'&&u.searchParams.get('X-Plex-Client-Profile-Extra')!.includes('videoCodec=h264')&&key!=='51';
      return Response.json({MediaContainer:{generalDecisionCode:1001,Metadata:[{Media:[{Part:[{Stream:[{streamType:1,decision:copy?'copy':'transcode'},{streamType:2,decision:'transcode',...(u.searchParams.has('audioStreamID')?{id:key==='62'?999:Number(u.searchParams.get('audioStreamID'))}:{})}]}]}]}]}});
    }
    if(path==='/video/:/transcode/universal/start.m3u8')return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nsession/${session}/base/index.m3u8\n`,{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
    const base_=path.match(/^\/video\/:\/transcode\/universal\/session\/([\w-]+)\/base\/(.+)$/);
    if(base_?.[2]==='index.m3u8')return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n00000.ts\n#EXTINF:2,\n/video/:/transcode/universal/session/'+base_[1]+'/base/00001.ts\n#EXT-X-ENDLIST\n',{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
    if(base_?.[2]==='00000.ts')return new Response(new Uint8Array([71,0,0]),{headers:{'Content-Type':'video/mp2t','Content-Length':'3'}});
    if(['/video/:/transcode/universal/ping','/video/:/transcode/universal/stop'].includes(path))return new Response('',{status:200});
    return base.transport(url,init);
  }) as typeof fetch;
  return {base,transport,requests};
}
const caps={videoCodecs:['h264:8'],audioCodecs:['aac'],containers:['mp4','hls']};

test('incompatible Plex VOD plays through a token-free Plex transcoder HLS proxy',async()=>{
  const f=transcoderFixture(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),plex=new PlexAdapter(config(),'test',f.transport),identity=new IdentityService(db,vault,plex),app=await buildApp(config(),db,vault,plex,false);
  try {
    const signed=await identity.finish((await identity.start()).binding);assert.ok(signed);const headers={cookie:`tk.box_local=${signed.cookie}`,origin:'http://127.0.0.1:3000'};
    // MKV + AC3: video is copied (remux), audio converted, no encoder permit.
    const created=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{mode:'plex_vod',ratingKey:'50',capabilities:caps}});
    assert.equal(created.statusCode,200);const vod=created.json();assert.equal(vod.delivery,'remux');assert.match(vod.streamUrl,/\/hls\/start\.m3u8$/);
    const decision=f.requests.find(r=>r.path.endsWith('/decision'))!;assert.equal(decision.query.get('subtitles'),'none');assert.equal(decision.query.get('directStream'),'1');assert.equal(decision.query.get('X-Plex-Token'),null);
    assert.equal((await app.inject({url:'/api/v1/admin/settings/playback',headers})).statusCode,403);
    const master=await app.inject({url:vod.streamUrl,headers});assert.equal(master.statusCode,200);assert.match(master.headers['content-type']!,/mpegurl/);
    assert.ok(!master.body.includes('fixture')&&!master.body.includes('token'));
    const variant=master.body.split('\n').find(l=>l.startsWith('/api/'))!;assert.match(variant,new RegExp(`^/api/v1/playback/sessions/${vod.id}/hls/session/[\\w-]+/base/index\\.m3u8$`));
    const index=await app.inject({url:variant,headers});const segments=index.body.split('\n').filter(l=>l.startsWith('/api/'));
    assert.equal(segments.length,2);assert.ok(segments.every(s=>s.startsWith(`/api/v1/playback/sessions/${vod.id}/hls/session/`)));
    const segment=await app.inject({url:segments[0]!,headers});assert.equal(segment.statusCode,200);assert.equal(segment.headers['content-type'],'video/mp2t');assert.equal(segment.rawPayload.length,3);
    assert.ok(f.requests.filter(r=>r.path.startsWith('/video/')).every(r=>r.token==='fixture-viewer-server-token'&&!r.query.has('X-Plex-Token')));
    // Unauthenticated, traversal and foreign-session requests are refused.
    assert.equal((await app.inject({url:segments[0]!})).statusCode,401);
    assert.equal((await app.inject({url:`/api/v1/playback/sessions/${vod.id}/hls/session/other/base/00000.ts`,headers})).statusCode,400);
    assert.equal((await app.inject({url:`/api/v1/playback/sessions/${vod.id}/hls/${segments[0]!.split('/hls/')[1]!.replace('base/00000.ts','..%2F..%2Fdecision')}`,headers})).statusCode,400);
    assert.equal((await app.inject({url:`/api/v1/playback/sessions/unknown/hls/start.m3u8`,headers})).statusCode,404);
    // Stopping ends the Plex transcode session.
    assert.equal((await app.inject({method:'DELETE',url:`/api/v1/playback/sessions/${vod.id}`,headers,payload:{}})).statusCode,200);
    assert.ok(f.requests.some(r=>r.path.endsWith('/stop')));
    assert.equal((await app.inject({url:segments[0]!,headers})).statusCode,404);
    // Plex insisting on a video encode for a copy-only route fails closed and leaves no session.
    const refused=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{mode:'plex_vod',ratingKey:'52',capabilities:caps}});
    assert.equal(refused.statusCode,422);assert.equal(refused.json().code,'PLEX_TRANSCODE_REFUSED');
  }finally{await app.close();db.close();}
});

test('Plex VOD CPU transcodes hold one shared encoder permit with immediate capacity errors',async()=>{
  const f=transcoderFixture(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),plex=new PlexAdapter(config(),'test',f.transport),identity=new IdentityService(db,vault,plex),app=await buildApp(config(),db,vault,plex,false);
  try {
    new SettingsStore(db).update('1',0,{maxConcurrentCpuVideoTranscodes:1,pauseRetentionMinutes:30});
    const signed=await identity.finish((await identity.start()).binding);assert.ok(signed);const headers={cookie:`tk.box_local=${signed.cookie}`,origin:'http://127.0.0.1:3000'};
    const payload={mode:'plex_vod',ratingKey:'51',capabilities:caps};
    const first=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload});assert.equal(first.statusCode,200);assert.equal(first.json().delivery,'transcode');
    const profile=f.requests.find(r=>r.path.endsWith('/decision'))!.query.get('X-Plex-Client-Profile-Extra')!;assert.match(profile,/videoCodec=h264&audioCodec=aac&/);
    const full=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload});assert.equal(full.statusCode,503);assert.equal(full.json().code,'TRANSCODE_CAPACITY_REACHED');assert.equal(full.json().retryable,true);
    // A remux never needs a permit, even while the budget is full.
    assert.equal((await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{...payload,ratingKey:'50'}})).statusCode,200);
    await app.inject({method:'DELETE',url:`/api/v1/playback/sessions/${first.json().id}`,headers,payload:{}});
    assert.equal((await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload})).statusCode,200);
  }finally{await app.close();db.close();}
});

test('switching audio restarts a direct-play title as Plex HLS at the requested position with that track',async()=>{
  // Browsers only play a file's default audio, so a non-default track can never be direct played.
  assert.equal(chooseRoute({codec:'h264',container:'mp4',audioCodec:'aac'},caps,'auto',false,false).kind,'remux');
  const f=transcoderFixture(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),plex=new PlexAdapter(config(),'test',f.transport),identity=new IdentityService(db,vault,plex),app=await buildApp(config(),db,vault,plex,false);
  try {
    const signed=await identity.finish((await identity.start()).binding);assert.ok(signed);const headers={cookie:`tk.box_local=${signed.cookie}`,origin:'http://127.0.0.1:3000'};
    const create=(extra:object)=>app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{mode:'plex_vod',ratingKey:'60',capabilities:caps,...extra}});
    const direct=await create({});assert.equal(direct.statusCode,200);assert.equal(direct.json().delivery,'direct');
    assert.deepEqual(direct.json().tracks.audio.map((t:{id:string;selected:boolean})=>[t.id,t.selected]),[['2',true],['3',false]]);
    // Choosing the default track keeps Direct Play and leaves Plex's stored selection alone.
    const same=await create({audioStreamId:'2',startAtMs:5000});assert.equal(same.json().delivery,'direct');assert.equal(same.json().startOffsetMs,5000);
    assert.ok(!f.requests.some(r=>r.path.startsWith('/library/parts/')));
    const switched=await create({audioStreamId:'3',startAtMs:125000});assert.equal(switched.statusCode,200);const vod=switched.json();
    assert.equal(vod.delivery,'remux');assert.equal(vod.startOffsetMs,125000);assert.match(vod.streamUrl,/\/hls\/start\.m3u8$/);assert.equal(vod.source.audioCodec,'ac3');
    assert.deepEqual(vod.tracks.audio.map((t:{id:string;selected:boolean})=>[t.id,t.selected]),[['2',false],['3',true]]);
    assert.ok(!switched.body.includes('fixture-viewer-server-token'));
    // Plex's per-account part selection is updated with the token in a header only.
    const selection=f.requests.find(r=>r.path==='/library/parts/60')!;assert.ok(selection);
    assert.equal(selection.query.get('audioStreamID'),'3');assert.equal(selection.query.get('allParts'),'1');assert.equal(selection.token,'fixture-viewer-server-token');assert.equal(selection.query.get('X-Plex-Token'),null);
    const decision=f.requests.filter(r=>r.path.endsWith('/decision')).at(-1)!;assert.equal(decision.query.get('audioStreamID'),'3');assert.equal(decision.query.get('path'),'/library/metadata/60');
    assert.match(decision.query.get('X-Plex-Client-Profile-Extra')!,/audioCodec=aac&/,'an incompatible chosen codec is converted to AAC');
    const master=await app.inject({url:vod.streamUrl,headers});assert.equal(master.statusCode,200);assert.ok(!master.body.includes('token'));
    // Tracks from other media, non-audio streams and malformed IDs are refused.
    for(const audioStreamId of ['1','999']){const bad=await create({audioStreamId});assert.equal(bad.statusCode,400);assert.equal(bad.json().code,'INVALID_AUDIO');}
    assert.equal((await create({audioStreamId:'3x'})).json().code,'VALIDATION_FAILED');
    assert.equal((await create({startAtMs:-1})).json().code,'VALIDATION_FAILED');
    // A resume point past the end is clamped to the media duration.
    assert.equal((await create({startAtMs:10_000_000})).json().startOffsetMs,600000);
  }finally{await app.close();db.close();}
});

test('a transcoder that ignores the chosen audio track fails closed and leaves no session',async()=>{
  const f=transcoderFixture(),db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),plex=new PlexAdapter(config(),'test',f.transport),identity=new IdentityService(db,vault,plex),app=await buildApp(config(),db,vault,plex,false);
  try {
    const signed=await identity.finish((await identity.start()).binding);assert.ok(signed);const headers={cookie:`tk.box_local=${signed.cookie}`,origin:'http://127.0.0.1:3000'};
    const refused=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{mode:'plex_vod',ratingKey:'62',capabilities:caps,audioStreamId:'3'}});
    assert.equal(refused.statusCode,502);assert.equal(refused.json().code,'AUDIO_SELECTION_FAILED');
    const count=(db.prepare('SELECT count(*) AS n FROM playback_sessions').get() as {n:number}).n;assert.equal(count,0);
  }finally{await app.close();db.close();}
});
