import { cpus, totalmem, platform, release } from 'node:os';
import { statfs, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { loadConfig } from '../apps/server/src/config.js';
import { runProcess } from '../apps/server/src/streaming/ffmpeg.js';
const c = loadConfig(); await mkdir(c.CACHE_DIR,{recursive:true});
const version = async (exe: string) => {try {return (await runProcess(exe,['-version'])).stdout.split('\n')[0];} catch {return 'unavailable';}};
const listener = await new Promise<string>(done => {const server=createServer();server.once('error',()=>done('unavailable or already in use'));server.listen(c.APP_PORT,c.APP_HOST,()=>server.close(()=>done('available')));});
let plexConnectivity = 'unavailable';
try { const r=await fetch(new URL('/identity',c.PLEX_URL),{signal:AbortSignal.timeout(3000),redirect:'error'});plexConnectivity=r.ok?'HTTP reachable (not an account authorization test)':`HTTP ${r.status}`;await r.body?.cancel();} catch {}
const fs = await statfs(c.CACHE_DIR);
console.log(JSON.stringify({node:process.version,platform:platform(),osRelease:release(),cpuModel:cpus()[0]?.model,cpuThreads:cpus().length,memoryBytes:totalmem(),cacheFreeBytes:fs.bavail*fs.bsize,ffmpeg:await version(c.FFMPEG_PATH),ffprobe:await version(c.FFPROBE_PATH),listener,publicHttpsConfigured:!!c.PUBLIC_BASE_URL,plexConfigured:c.plexConfigured,plexConnectivity,xmltv:'Restricted metadata ingestion available; no live feed validated',externalUploadThroughput:'Not measured',proxyReachability:'Requires testing from the existing proxy',browserCodecs:'Requires real browser/media tests'},null,2));
