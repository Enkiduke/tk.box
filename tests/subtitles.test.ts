import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {customAudioMap,mediaMarkers,mediaTracks,type PlexAdapter,type PlexGrant,type PlexMetadata} from '../apps/server/src/providers/plex.js';
import {SubtitleService} from '../apps/server/src/services/subtitles.js';
import {matroskaTextTrack} from '../apps/server/src/services/matroska-subtitles.js';

const item={ratingKey:'7',librarySectionID:'1',title:'Film',duration:60000,type:'movie',Media:[{container:'mkv',videoCodec:'h264',Part:[{key:'/library/parts/7/1/file.mkv',Stream:[
  {id:'1',streamType:1,codec:'h264'},
  {id:'2',streamType:2,codec:'ac3',languageCode:'eng',extendedDisplayTitle:'English (AC3 5.1)',selected:true},
  {id:'3',streamType:3,codec:'srt',languageCode:'eng',displayTitle:'English (SRT External)',key:'/library/streams/3'},
  {id:'4',streamType:3,codec:'pgs',languageCode:'fra',displayTitle:'Français (PGS)',index:4,forced:true},
]}]}]} as PlexMetadata;
const grant={accountId:'1',role:'admin',serverToken:'secret',libraries:[]} as PlexGrant;
const srt='1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<i>Second line</i>\r\n';

test('custom channels map English audio, else the file default, else the first track',()=>{
  const withAudio=(...audio:object[])=>({...item,Media:[{...item.Media[0]!,Part:[{key:'/p',Stream:[{id:'1',streamType:1},...audio]}]}]}) as PlexMetadata;
  assert.equal(customAudioMap(withAudio({id:'2',streamType:2,languageCode:'fra',index:1,default:true},{id:'3',streamType:2,languageCode:'eng',index:2})),'0:2');
  assert.equal(customAudioMap(withAudio({id:'2',streamType:2,languageCode:'eng',index:1},{id:'3',streamType:2,languageCode:'eng',index:2,default:true})),'0:2');
  assert.equal(customAudioMap(withAudio({id:'2',streamType:2,languageCode:'fra',index:1},{id:'3',streamType:2,languageCode:'deu',index:2,default:true})),'0:2');
  assert.equal(customAudioMap(withAudio({id:'2',streamType:2,languageCode:'eng'})),'0:a:0?');
});

test('media tracks describe audio and subtitle choices, marking image subtitles unsupported',()=>{
  const tracks=mediaTracks(item);
  assert.deepEqual(tracks.audio,[{id:'2',label:'English (AC3 5.1)',language:'eng',selected:true}]);
  assert.deepEqual(tracks.subtitles.map(t=>[t.id,t.label,t.supported,t.forced]),[['3','English (SRT External)',true,false],['4','Français (PGS)',false,true]]);
});

test('media markers keep intros and credits in order, clamped to the title, and drop commercials',()=>{
  const marked={...item,Marker:[{type:'credits',startTimeOffset:50000,endTimeOffset:61000,final:true},{type:'commercial',startTimeOffset:20000,endTimeOffset:30000},{type:'intro',startTimeOffset:5000,endTimeOffset:5000},{type:'intro',startTimeOffset:1000,endTimeOffset:9000}]} as PlexMetadata;
  assert.deepEqual(mediaMarkers(marked),[{type:'intro',startMs:1000,endMs:9000,final:false},{type:'credits',startMs:50000,endMs:60000,final:true}]);
  assert.deepEqual(mediaMarkers(item),[]);
});

test('sidecar subtitles convert to cached WebVTT and image subtitles are refused',{skip:spawnSync('ffmpeg',['-version']).status!==0&&'ffmpeg unavailable'},async()=>{
  const cache=await mkdtemp(join(tmpdir(),'tk.box-subs-'));let fetches=0;
  const plex={subtitleSource:async(_g:PlexGrant,_i:PlexMetadata,key?:string)=>{fetches++;assert.equal(key,'/library/streams/3');return new Response(srt);}} as unknown as PlexAdapter;
  try {
    const service=new SubtitleService(plex,'ffmpeg',cache);
    const [first,shared]=await Promise.all([service.webvtt(grant,item,'3'),service.webvtt(grant,item,'3')]);
    assert.match(first,/^WEBVTT/);assert.match(first,/(00:)?00:01\.000 --> (00:)?00:02\.500/);assert.match(first,/Hello there/);
    assert.equal(shared,first);assert.equal(fetches,1);
    assert.equal(await service.webvtt(grant,item,'3'),first);assert.equal(fetches,1,'cached result is reused');
    await assert.rejects(service.webvtt(grant,item,'4'),{code:'SUBTITLE_UNSUPPORTED'});
    await assert.rejects(service.webvtt(grant,item,'2'),{code:'SUBTITLE_NOT_FOUND'});
  } finally {await rm(cache,{recursive:true,force:true});}
});

const ffmpeg=(args:string[])=>assert.equal(spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args]).status,0);
// An MKV with SRT (stream 1) and ASS (stream 2) tracks; the Plex fake serves byte ranges of it.
async function embedded(){
  const dir=await mkdtemp(join(tmpdir(),'tk.box-mkv-'));
  await writeFile(join(dir,'a.srt'),srt+'\r\n3\r\n00:00:07,250 --> 00:00:09,000\r\nThird, with comma\r\n');
  ffmpeg(['-i',join(dir,'a.srt'),join(dir,'a.ass')]);
  ffmpeg(['-f','lavfi','-i','color=c=black:s=64x64:r=10:d=10','-i',join(dir,'a.srt'),'-i',join(dir,'a.ass'),'-map','0','-map','1','-map','2','-c:v','mpeg4','-c:s','copy',join(dir,'t.mkv')]);
  const file=await readFile(join(dir,'t.mkv'));
  const media={...item,Media:[{container:'mkv',videoCodec:'mpeg4',Part:[{key:'/library/parts/8/1/file.mkv',Stream:[
    {id:'11',streamType:1,codec:'mpeg4',index:0},{id:'12',streamType:3,codec:'srt',index:1},{id:'13',streamType:3,codec:'ass',index:2}]}]}]} as PlexMetadata;
  return {dir,file,media};
}
const read=(file:Buffer)=>async(s:number,e:number)=>file.subarray(s,e);
const ranged=(file:Buffer,ranges:string[],honour=true)=>async(_g:PlexGrant,_i:PlexMetadata,range?:string)=>{
  const m=range?.match(/^bytes=(\d+)-(\d+)$/);assert.ok(m);ranges.push(range!);
  return honour?new Response(new Uint8Array(file.subarray(Number(m[1]),Number(m[2])+1)),{status:206}):new Response(new Uint8Array(file),{status:200});
};

test('embedded Matroska text tracks are read through the cue index without reading the whole part',{skip:spawnSync('ffmpeg',['-version']).status!==0&&'ffmpeg unavailable'},async()=>{
  const {dir,file,media}=await embedded();
  try {
    assert.deepEqual(await matroskaTextTrack(read(file),1),{format:'srt',cues:3,text:'1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>Second line</i>\n\n3\n00:00:07,250 --> 00:00:09,000\nThird, with comma\n'});
    const ass=await matroskaTextTrack(read(file),2);
    assert.equal(ass?.format,'ass');assert.match(ass!.text,/^\[Script Info\]/);assert.match(ass!.text,/\nDialogue: 0,0:00:07\.25,0:00:09\.00,Default,,0,0,0,,Third, with comma\n$/);
    assert.equal(await matroskaTextTrack(read(file),0),undefined,'a video track is refused');
    assert.equal(await matroskaTextTrack(read(Buffer.from('not matroska')),1),undefined);
    const ranges:string[]=[];
    const plex={directPart:ranged(file,ranges),subtitleSource:async()=>assert.fail('whole part must not be read')} as unknown as PlexAdapter;
    const service=new SubtitleService(plex,'ffmpeg',dir);
    for(const id of ['12','13']){
      const vtt=await service.webvtt(grant,media,id);
      assert.match(vtt,/^WEBVTT/);assert.match(vtt,/(00:)?00:01\.000 --> (00:)?00:02\.500/);assert.match(vtt,/(00:)?00:07\.250 --> (00:)?00:09\.000/);assert.match(vtt,/Third, with comma/);
    }
    assert.ok(ranges.every(r=>{const [a,b]=r.slice(6).split('-').map(Number);return b!-a!<64*1024;}),'only small ranges are read');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('embedded subtitles fall back to the whole part when Plex ignores byte ranges',{skip:spawnSync('ffmpeg',['-version']).status!==0&&'ffmpeg unavailable'},async()=>{
  const {dir,file,media}=await embedded();let whole=0;
  try {
    const plex={directPart:ranged(file,[],false),subtitleSource:async(_g:PlexGrant,_i:PlexMetadata,key?:string)=>{whole++;assert.equal(key,undefined);return new Response(new Uint8Array(file));}} as unknown as PlexAdapter;
    const vtt=await new SubtitleService(plex,'ffmpeg',dir).webvtt(grant,media,'12');
    assert.equal(whole,1);assert.match(vtt,/(00:)?00:03\.000 --> (00:)?00:04\.000/);assert.match(vtt,/Third, with comma/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
