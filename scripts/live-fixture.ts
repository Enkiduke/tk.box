// Loopback-only test channels for live playback checks: an endless generated MPEG-TS per request,
// like a raw IPTV stream. /mpeg2.ts (MPEG-2 + AC-3) exercises Transcode; /h264.ts (H.264 + MP2) Direct Stream.
// /slate.ts is a frozen, silent "channel unavailable" card like providers send for dead channels.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
const ffmpeg=process.env.FFMPEG_PATH??'ffmpeg',port=Number(process.argv[2]??8899);
const h264=['-c:v','libx264','-preset','ultrafast','-g','50','-pix_fmt','yuv420p','-c:a','mp2'];
const profiles:Record<string,string[]>={'/mpeg2.ts':['-c:v','mpeg2video','-b:v','3M','-c:a','ac3','-b:a','192k'],'/h264.ts':h264,'/slate.ts':h264};
const programme=['-f','lavfi','-i','testsrc2=size=1280x720:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000'];
const inputs:Record<string,string[]>={'/slate.ts':['-f','lavfi','-i','color=c=navy:size=1280x720:rate=25,drawbox=x=440:y=320:w=400:h=80:color=white:t=fill','-f','lavfi','-i','anullsrc=r=48000:cl=stereo']};
createServer((req,res)=>{
  const args=profiles[req.url??''];if(!args){res.writeHead(404).end();return;}
  res.writeHead(200,{'content-type':'video/mp2t'});
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-re',...(inputs[req.url!]??programme),...args,'-f','mpegts','pipe:1'],{stdio:['ignore','pipe','inherit'],windowsHide:true});
  child.stdout.pipe(res);res.on('close',()=>child.kill('SIGKILL'));
}).listen(port,'127.0.0.1',()=>console.log(`Live test channels: http://127.0.0.1:${port}/mpeg2.ts, /h264.ts and /slate.ts`));
