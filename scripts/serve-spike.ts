import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
// This local-only server serves generated test patterns. It is never mounted by the app.
const root = resolve('.local/media-spike'), files = new Map<string, {path: string; type: string}>();
for (const file of ['joined.m3u8', 'delayed.m3u8']) files.set('/' + file, {path: join(root, file), type: 'application/vnd.apple.mpegurl'});
for (const dir of ['a','b']) for (const file of await readdir(join(root,dir))) if (/^segment-\d+\.ts$/.test(file)) files.set(`/${dir}/${file}`, {path: join(root,dir,file), type: 'video/mp2t'});
files.set('/hls.js', {path: resolve('node_modules/hls.js/dist/hls.min.js'), type: 'text/javascript'});
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>tk.box generated-media experiment</title><h1>Generated-media HLS boundary experiment</h1><p>These are real retained FFmpeg segments from two synthetic sources. This finite experiment is not a live Plex/IPTV station. Test Pause/Resume across the pattern/audio change; the second player can remain playing independently.</p><button id="start">Load both HLS players</button><div id="players"></div><p id="status" role="status"></p><script src="/hls.js"></script><script>
let controllers=[];document.querySelector('#start').onclick=()=>{for(const h of controllers)h.destroy();controllers=[];document.querySelector('#players').replaceChildren();for(const [i,path] of ['joined.m3u8','delayed.m3u8'].entries()){const section=document.createElement('section'),v=document.createElement('video'),play=document.createElement('button'),pause=document.createElement('button');v.controls=true;v.width=480;play.textContent='Play viewer '+(i+1);pause.textContent='Pause viewer '+(i+1);play.onclick=()=>v.play().catch(()=>{document.querySelector('#status').textContent='Playback could not start.';});pause.onclick=()=>v.pause();section.append(play,pause,document.createElement('br'),v);document.querySelector('#players').append(section);if(v.canPlayType('application/vnd.apple.mpegurl'))v.src='/'+path;else if(Hls.isSupported()){const h=new Hls();controllers.push(h);h.loadSource('/'+path);h.attachMedia(v);h.on(Hls.Events.ERROR,(_,e)=>{document.querySelector('#status').textContent=e.type+': '+e.details;});}else document.querySelector('#status').textContent='HLS is unavailable in this browser.';}};
</script></html>`;
const port = Number(process.env.SPIKE_PORT ?? 8766);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid SPIKE_PORT');
createServer(async (req,res) => {
  if (req.method !== 'GET') {res.writeHead(405).end();return;}
  if (req.url === '/') {res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html);return;}
  const file = files.get(req.url ?? ''); if (!file) {res.writeHead(404).end();return;}
  try {res.writeHead(200, {'Content-Type':file.type,'Cache-Control':'no-store'}).end(await readFile(file.path));} catch {res.writeHead(404).end();}
}).listen(port,'127.0.0.1',()=>console.log(`Generated-media browser experiment: http://127.0.0.1:${port}`));
