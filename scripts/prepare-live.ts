import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runProcess,LocalMediaWorker} from '../apps/server/src/streaming/ffmpeg.js';
import {EncoderBudget} from '../apps/server/src/streaming/policy.js';
import {readGeneratedHls} from '../apps/server/src/streaming/hls-files.js';
import {renderManifest} from '../apps/server/src/streaming/buffer.js';
import assert from 'node:assert/strict';
import {TsContinuity} from '../apps/server/src/streaming/ts-continuity.js';
const root=resolve('.local/live-spike');await mkdir(root,{recursive:true});
const ffmpeg=process.env.FFMPEG_PATH??'ffmpeg',ffprobe=process.env.FFPROBE_PATH??'ffprobe';
for(const id of ['a','b']){
  const args=['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i',`testsrc2=size=320x180:rate=25`,'-f','lavfi','-i',`sine=frequency=${id==='a'?440:880}:sample_rate=48000`,'-t','8','-threads','2'];
  args.push(...(id==='a'?['-c:v','libx264','-preset','veryfast','-bf','0','-g','50','-sc_threshold','0','-pix_fmt','yuv420p','-c:a','aac']:['-c:v','mpeg4','-q:v','4','-c:a','pcm_s16le']));
  args.push(join(root,`source-${id}.${id==='a'?'mp4':'avi'}`));await runProcess(ffmpeg,args);
}
const worker=new LocalMediaWorker(new EncoderBudget(()=>2),ffmpeg,ffprobe);const segments=[],continuity=new TsContinuity();let payloadHashesPreserved=true;
const payloadHash=async(dir:string)=>(await runProcess(ffmpeg,['-hide_banner','-loglevel','error','-i',join(dir,'index.m3u8').replaceAll('\\','/'),'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
for(const [id,index] of [['a',0],['b',1]] as const){
  const dir=join(root,`prepared-${id}`);await worker.hls(join(root,`source-${id}.${id==='a'?'mp4':'avi'}`),dir,{kind:id==='a'?'remux':'cpu',audioEncode:id!=='a'},0,8000);
  const before=await payloadHash(dir);
  for(const {segment,mediaPath} of await readGeneratedHls(dir,{start:index*8000,programId:`fixture-${id}`,revision:1,sequence:index*4,discontinuitySequence:index})){
    await writeFile(mediaPath,continuity.rewrite(await readFile(mediaPath)));
    segments.push({...segment,uri:`prepared-${id}/${segment.uri.replace(/^s-\d+/,`segment-${String(segment.sequence-index*4).padStart(4,'0')}`)}`});
  }
  payloadHashesPreserved&&=before===await payloadHash(dir);
}
assert.ok(payloadHashesPreserved,'Transport counter changes must preserve compressed video payloads.');
const manifest=join(root,'prepared-joined.m3u8');await writeFile(manifest,renderManifest(segments,true));
const decoded=await runProcess(ffmpeg,['-hide_banner','-loglevel','warning','-i',manifest.replaceAll('\\','/'),'-progress','pipe:1','-f','null','-']);
const frames=Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);assert.equal(frames,400);assert.equal(decoded.packetCorruptionWarnings,0);
const probe=await runProcess(ffprobe,['-v','error','-show_entries','stream=codec_name,start_time,duration','-of','json',manifest.replaceAll('\\','/')]);
await writeFile(join(root,'preparation-report.json'),JSON.stringify({generatedAt:new Date().toISOString(),decodedVideoFrames:frames,packetCorruptionWarnings:decoded.packetCorruptionWarnings,compressedVideoPayloadHashesPreserved:payloadHashesPreserved,streams:JSON.parse(probe.stdout).streams,limitation:'Generated fixed 320x180 indexed/no-B-frame source profile, not general Plex compatibility.'},null,2));
console.log('Generated live-spike fixtures; continuous TS counters decoded 400 frames without packet-corruption warnings.');
