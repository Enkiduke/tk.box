import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join} from 'node:path';
import {loadConfig} from '../apps/server/src/config.js';
import {LocalMedia,byteRange} from '../apps/server/src/providers/local-media.js';
import {PlexAdapter,type PlexGrant,type PlexMetadata} from '../apps/server/src/providers/plex.js';
import {SubtitleService} from '../apps/server/src/services/subtitles.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {buildApp} from '../apps/server/src/app.js';
import {fakePlex} from './fixtures.js';

const base={PLEX_MACHINE_ID:'machine',PLEX_OWNER_ACCOUNT_ID:'1',PLEX_REQUIRED_LIBRARY_IDS:'10,20'};
const grant={accountId:'1',role:'admin',serverToken:'secret',libraries:[{key:'1',title:'Movies',type:'movie'}]} as PlexGrant;
const item=(file:string|undefined,container='mp4',Stream:unknown[]=[])=>({ratingKey:'7',librarySectionID:'1',title:'Film',duration:60000,type:'movie',
  Media:[{container,videoCodec:'h264',Part:[{key:'/library/parts/7/1/file.mp4',...(file?{file}:{}),Stream}]}]}) as PlexMetadata;
const noFfmpeg=spawnSync('ffmpeg',['-version']).status!==0&&'ffmpeg unavailable';
const ffmpeg=(args:string[])=>assert.equal(spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args]).status,0);
const srt='1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:00:07,250 --> 00:00:09,000\r\nThird, with comma\r\n';
// A Plex fake that fails the test if any media is read over HTTP.
const httpForbidden={directPart:async()=>assert.fail('Plex HTTP must not be used'),subtitleSource:async()=>assert.fail('Plex HTTP must not be used')} as unknown as PlexAdapter;

async function tree(){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'tk.box-local-'))),root=join(dir,'media'),outside=join(dir,'outside');
  await mkdir(join(root,'movies'),{recursive:true});await mkdir(outside);
  await writeFile(join(root,'movies','film.mp4'),'0123456789');await writeFile(join(outside,'secret.mp4'),'secret');
  return {dir,root,outside};
}

test('same-host configuration is opt-in and validated',()=>{
  assert.equal(loadConfig(base).localMedia,undefined);
  assert.equal(loadConfig({...base,MEDIA_ROOTS:' '}).localMedia,undefined);
  const root=join(tmpdir(),'tk.box-roots'),other=join(tmpdir(),'tk.box-other');
  assert.deepEqual(loadConfig({...base,MEDIA_ROOTS:[root,other].join(delimiter),PLEX_PATH_MAP:`/movies=${root}`}).localMedia,{roots:[root,other],pathMap:[{from:'/movies',to:root}]});
  assert.throws(()=>loadConfig({...base,MEDIA_ROOTS:'relative/media'}),/absolute/);
  assert.throws(()=>loadConfig({...base,PLEX_PATH_MAP:`/movies=${root}`}),/requires MEDIA_ROOTS/);
  assert.throws(()=>loadConfig({...base,MEDIA_ROOTS:root,PLEX_PATH_MAP:'/movies=relative'}),/PLEX_PATH_MAP/);
  assert.throws(()=>loadConfig({...base,MEDIA_ROOTS:root,PLEX_PATH_MAP:root}),/PLEX_PATH_MAP/);
});

test('local parts are confined to the media roots and refuse escapes',async()=>{
  const {dir,root,outside}=await tree();
  try {
    const local=new LocalMedia({roots:[root],pathMap:[]}),film=join(root,'movies','film.mp4');
    const part=await local.open(grant,item(film));
    assert.ok(part);assert.equal(part.size,10);assert.equal(part.type,'video/mp4');assert.equal(part.demuxer,'mov');
    const {buffer}=await part.handle.read(Buffer.alloc(4),0,4,3);assert.equal(buffer.toString(),'3456');
    await assert.rejects(part.handle.write('x'),'opened read-only');
    await part.handle.close();
    await assert.rejects(local.open({...grant,libraries:[]},item(film)),{code:'PLEX_ACCESS_DENIED'});
    for(const file of [join(outside,'secret.mp4'),`${root}${'/'}..${'/'}outside${'/'}secret.mp4`,join(root,'movies','..','..','outside','secret.mp4'),
      'movies/film.mp4',root,join(root,'movies'),join(root,'missing.mp4'),`${film}\0.mp4`,undefined])
      assert.equal(await local.open(grant,item(file)),undefined,`refused: ${file}`);
    assert.equal(await local.open(grant,item(film,'iso')),undefined,'unknown containers are not read locally');
    // A directory link inside the root that points outside (a junction works without privileges on Windows).
    await symlink(outside,join(root,'escape'),'junction');
    assert.equal(await local.open(grant,item(join(root,'escape','secret.mp4'))),undefined,'directory link escape');
    try {await symlink(join(outside,'secret.mp4'),join(root,'link.mp4'),'file');} catch {/* file symlinks need privileges on Windows */}
    assert.equal(await local.open(grant,item(join(root,'link.mp4'))),undefined,'file symlink escape');
    assert.equal(await new LocalMedia().open(grant,item(film)),undefined,'unset configuration never reads disk');
    assert.equal(new LocalMedia().enabled,false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Plex paths are translated through the path map without escaping it',async()=>{
  const {dir,root}=await tree();
  try {
    const local=new LocalMedia({roots:[root],pathMap:[{from:'/data/',to:root},{from:'/data/movies',to:join(root,'movies')}]});
    assert.equal(local.localPath('/data/movies/film.mp4'),join(root,'movies','film.mp4'));
    assert.equal(local.localPath('/data/other/x.mkv'),join(root,'other','x.mkv'));
    assert.equal(local.localPath('/data/movies/../../etc/passwd'),undefined);
    const part=await local.open(grant,item('/data/movies/film.mp4'));assert.ok(part);await part.handle.close();
    assert.equal(await local.open(grant,item('/datamovies/film.mp4')),undefined,'prefixes match whole segments only');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('byte ranges follow RFC 9110 single-range rules',()=>{
  assert.deepEqual(byteRange('bytes=2-5',10),{start:2,end:5});
  assert.deepEqual(byteRange('bytes=4-',10),{start:4,end:9});
  assert.deepEqual(byteRange('bytes=8-100',10),{start:8,end:9});
  assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});
  assert.deepEqual(byteRange('bytes=-30',10),{start:0,end:9});
  assert.equal(byteRange(undefined,10),undefined);assert.equal(byteRange('bytes=-',10),undefined);
  for(const r of ['bytes=10-','bytes=5-2','bytes=-0']) assert.equal(byteRange(r,10),'unsatisfiable',r);
});

test('embedded MP4 and Matroska subtitles convert from the local file without Plex HTTP',{skip:noFfmpeg},async()=>{
  const {dir,root}=await tree();
  try {
    await writeFile(join(dir,'a.srt'),srt);
    // mov_text in an MP4 whose index sits at the end: unreadable from a pipe, fine from disk.
    ffmpeg(['-f','lavfi','-i','color=c=black:s=64x64:r=10:d=10','-i',join(dir,'a.srt'),'-map','0','-map','1','-c:v','mpeg4','-c:s','mov_text',join(root,'movies','t.mp4')]);
    ffmpeg(['-f','lavfi','-i','color=c=black:s=64x64:r=10:d=10','-i',join(dir,'a.srt'),'-map','0','-map','1','-c:v','mpeg4','-c:s','copy',join(root,'movies','t.mkv')]);
    const service=new SubtitleService(httpForbidden,'ffmpeg',join(dir,'cache'),new LocalMedia({roots:[root],pathMap:[]}));
    for(const [name,container,codec] of [['t.mp4','mp4','mov_text'],['t.mkv','mkv','srt']] as const){
      const vtt=await service.webvtt(grant,item(join(root,'movies',name),container,[{id:'2',streamType:3,codec,index:1}]),'2');
      assert.match(vtt,/^WEBVTT/);assert.match(vtt,/(00:)?00:01\.000 --> (00:)?00:02\.500/);assert.match(vtt,/Third, with comma/);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('subtitles outside the media roots use the Plex HTTP path',{skip:noFfmpeg},async()=>{
  const {dir,root,outside}=await tree();let whole=0;
  try {
    await writeFile(join(dir,'a.srt'),srt);
    ffmpeg(['-f','lavfi','-i','color=c=black:s=64x64:r=10:d=10','-i',join(dir,'a.srt'),'-map','0','-map','1','-c:v','mpeg4','-c:s','mov_text','-movflags','+faststart',join(outside,'t.mp4')]);
    const {readFile}=await import('node:fs/promises'),bytes=await readFile(join(outside,'t.mp4'));
    const plex={subtitleSource:async()=>{whole++;return new Response(new Uint8Array(bytes));}} as unknown as PlexAdapter;
    const vtt=await new SubtitleService(plex,'ffmpeg',join(dir,'cache'),new LocalMedia({roots:[root],pathMap:[]})).webvtt(grant,item(join(outside,'t.mp4'),'mp4',[{id:'2',streamType:3,codec:'mov_text',index:1}]),'2');
    assert.equal(whole,1);assert.match(vtt,/Hello there/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

async function signedIn(env:Record<string,string>,file:string){
  const f=fakePlex({file}),config=loadConfig({...base,...env}),db=openDatabase(':memory:');
  const app=await buildApp(config,db,new Vault(randomBytes(32)),new PlexAdapter(config,'local-test',f.transport),false),origin='http://127.0.0.1:3000';
  const start=await app.inject({method:'POST',url:'/api/v1/auth/plex/start',payload:{},headers:{origin}}),binding=start.cookies[0]!;
  const finish=await app.inject({method:'POST',url:'/api/v1/auth/plex/status',payload:{},headers:{origin,cookie:`${binding.name}=${binding.value}`}});
  const headers={origin,cookie:`tk.box_local=${finish.cookies.find(c=>c.name==='tk.box_local')!.value}`};
  const vod=await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{mode:'plex_vod',ratingKey:'42',capabilities:{videoCodecs:['h264:8'],audioCodecs:['aac'],containers:['mp4']}}});
  assert.equal(vod.statusCode,200);
  return {app,db,f,headers,url:vod.json().streamUrl as string,close:async()=>{await app.close();db.close();}};
}

test('direct play serves the authorized local part with byte ranges',async()=>{
  const {dir,root}=await tree(),film=join(root,'movies','film.mp4');
  const s=await signedIn({MEDIA_ROOTS:root},film);
  try {
    const partCalls=()=>s.f.calls.filter(c=>c.path.startsWith('/library/parts/')).length;
    const whole=await s.app.inject({url:s.url,headers:s.headers});
    assert.equal(whole.statusCode,200);assert.equal(whole.body,'0123456789');assert.equal(whole.headers['content-type'],'video/mp4');assert.equal(whole.headers['accept-ranges'],'bytes');
    const part=await s.app.inject({url:s.url,headers:{...s.headers,range:'bytes=2-4'}});
    assert.equal(part.statusCode,206);assert.equal(part.body,'234');assert.equal(part.headers['content-range'],'bytes 2-4/10');assert.equal(part.headers['content-length'],'3');
    const tail=await s.app.inject({url:s.url,headers:{...s.headers,range:'bytes=-2'}});assert.equal(tail.body,'89');
    const beyond=await s.app.inject({url:s.url,headers:{...s.headers,range:'bytes=10-'}});
    assert.equal(beyond.statusCode,416);assert.equal(beyond.headers['content-range'],'bytes */10');
    assert.equal(partCalls(),0,'Plex HTTP was not used');
    assert.equal((await s.app.inject({url:s.url})).statusCode,401,'still requires a session');
  } finally {await s.close();await rm(dir,{recursive:true,force:true});}
});

test('direct play uses Plex HTTP when same-host mode is unset or the path escapes the roots',async()=>{
  const {dir,root,outside}=await tree();
  try {
    for(const [env,file] of [[{},join(root,'movies','film.mp4')],[{MEDIA_ROOTS:root},join(outside,'secret.mp4')]] as const){
      const s=await signedIn(env,file);
      try {
        const res=await s.app.inject({url:s.url,headers:{...s.headers,range:'bytes=0-2'}});
        assert.equal(res.statusCode,206);assert.equal(res.headers['content-range'],'bytes 0-2/3');assert.equal(res.rawPayload.length,3);
        assert.equal(s.f.calls.filter(c=>c.path.startsWith('/library/parts/')).length,1);
      } finally {await s.close();}
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
