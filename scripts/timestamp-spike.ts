import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {runProcess, LocalMediaWorker} from '../apps/server/src/streaming/ffmpeg.js';
import {EncoderBudget} from '../apps/server/src/streaming/policy.js';
const root=resolve('.local/timestamp-spike');await mkdir(root,{recursive:true});
const ffmpeg=process.env.FFMPEG_PATH??'ffmpeg',ffprobe=process.env.FFPROBE_PATH??'ffprobe';
const indexed=join(root,'indexed-a.mp4');
await runProcess(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-i',resolve('.local/media-spike/source-a.ts'),'-map','0:v:0','-map','0:a:0','-c','copy',indexed]);
const worker=new LocalMediaWorker(new EncoderBudget(()=>2),ffmpeg,ffprobe);
const results=[];
for(const [name,input,format] of [['ts-to-ts',resolve('.local/media-spike/source-a.ts'),'mpegts'],['ts-to-fmp4',resolve('.local/media-spike/source-a.ts'),'fmp4'],['indexed-to-fmp4',indexed,'fmp4']] as const){
  const dir=join(root,name);await worker.hls(input,dir,{kind:'remux',audioEncode:false},2000,6000,{format});
  const result=await runProcess(ffprobe,['-v','error','-show_entries','stream=codec_name,start_time,duration','-of','json',join(dir,'index.m3u8').replaceAll('\\','/')]);
  results.push({name,...JSON.parse(result.stdout)});
}
await writeFile(join(root,'report.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
