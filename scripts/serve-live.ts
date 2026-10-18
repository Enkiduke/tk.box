import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {openDatabase,SettingsStore} from '../apps/server/src/persistence/database.js';
import {DiskSegments} from '../apps/server/src/streaming/disk-segments.js';
import {LiveViewers} from '../apps/server/src/streaming/live-viewers.js';
import {LocalMediaWorker} from '../apps/server/src/streaming/ffmpeg.js';
import {EncoderBudget} from '../apps/server/src/streaming/policy.js';
import {opaque,digest} from '../apps/server/src/security/vault.js';
import {AppError,requireThat} from '../apps/server/src/errors.js';
import {FixtureBroadcast} from './lib/fixture-broadcast.js';

const port=z.coerce.number().int().min(1024).max(65535).parse(process.env.LIVE_SPIKE_PORT??8767);
const root=resolve('.local/live-spike'),run=join(root,'runs',randomUUID());await mkdir(run,{recursive:true,mode:0o700});
const db=openDatabase(join(root,'schedule.sqlite')),settings=new SettingsStore(db),budget=new EncoderBudget(()=>settings.get().maxConcurrentCpuVideoTranscodes);
const store=new DiskSegments(join(run,'segments'),2*1024*1024,()=>30000);await store.initialize();
const owners=new Set<string>();
const viewers=new LiveViewers(store,()=>30000,async(owner,program)=>requireThat(owners.has(owner)&&['fixture-a','fixture-b'].includes(program),'FIXTURE_ACCESS_DENIED','Fixture access was revoked.',403));
const broadcast=new FixtureBroadcast(db,join(run,'work'),store,new LocalMediaWorker(budget,process.env.FFMPEG_PATH??'ffmpeg',process.env.FFPROBE_PATH??'ffprobe'),{a:join(root,'source-a.mp4'),b:join(root,'source-b.avi')});
const app=Fastify({logger:false,bodyLimit:4096});await app.register(cookie);
const allowedOrigins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
app.addHook('onRequest',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
  requireThat(allowedOrigins.has(`http://${req.headers.host}`),'FIXTURE_HOST_DENIED','Use the loopback fixture origin.',403);
  if(!['GET','HEAD'].includes(req.method))requireThat(allowedOrigins.has(String(req.headers.origin))&&req.headers['content-type']?.startsWith('application/json'),'CSRF_REJECTED','Local JSON origin required.',403);
});
app.setErrorHandler((e,_req,reply)=>{const error=e instanceof AppError?e:new AppError('FIXTURE_REQUEST_FAILED','Fixture request failed.',400);reply.code(error.status).send({code:error.code,message:error.message});});
const owner=(req:{cookies:Record<string,string|undefined>})=>{const value=req.cookies['tk.box_fixture'];requireThat(value&&owners.has(digest(value)),'FIXTURE_SIGN_IN','Create a local fixture viewer first.',401);return digest(value);};
const ensureOwner=(req:{cookies:Record<string,string|undefined>},reply:import('fastify').FastifyReply)=>{
  let value=req.cookies['tk.box_fixture'];
  if(!value||!owners.has(digest(value))){requireThat(owners.size<100,'FIXTURE_LIMIT','Local identity limit reached.',429);value=opaque();owners.add(digest(value));reply.setCookie('tk.box_fixture',value,{httpOnly:true,sameSite:'strict',path:'/',maxAge:3600});}
  return digest(value);
};
app.get('/',async(req,reply)=>{ensureOwner(req,reply);return reply.type('text/html').send(await readFile(resolve('scripts/live-spike.html'),'utf8'));});
app.get('/hls.js',async(_req,reply)=>reply.type('text/javascript').send(await readFile(resolve('node_modules/hls.js/dist/hls.min.js'))));
app.post('/lab/viewers',async(req,reply)=>{
  const who=ensureOwner(req,reply),id=viewers.create(who,Date.now());await broadcast.tick();return {id};
});
app.get<{Params:{id:string}}>('/lab/viewers/:id/state',async req=>({...viewers.state(req.params.id,owner(req),Date.now()),failure:broadcast.failure??null,sharedWorkerStarts:broadcast.workerStarts,encoderCount:budget.count,currentProgram:broadcast.scheduler.current('fixture-live',Date.now()).entry.title,maxPublishLagMs:broadcast.maxPublishLagMs}));
app.post<{Params:{id:string;action:string}}>('/lab/viewers/:id/:action',async req=>{
  const who=owner(req),now=Date.now(),id=req.params.id;
  if(req.params.action==='pause'){const body=z.object({displayedUtc:z.number().finite()}).strict().parse(req.body);return viewers.pause(id,who,body.displayedUtc,now);}
  if(req.params.action==='resume')return viewers.resume(id,who,now);
  if(req.params.action==='go-live')return viewers.goLive(id,who,now);
  if(req.params.action==='stop'){viewers.stop(id,who,now);if(!viewers.activeCount(now))await broadcast.stop();return {stopped:true};}
  if(req.params.action==='retry'){viewers.state(id,who,now);await broadcast.retry();return {retryRequested:true};}
  throw new AppError('NOT_FOUND','Unknown fixture action.',404);
});
app.get<{Params:{id:string}}>('/lab/viewers/:id/manifest.m3u8',async(req,reply)=>reply.type('application/vnd.apple.mpegurl').send(await viewers.manifest(req.params.id,owner(req),Date.now())));
app.get<{Params:{id:string;file:string}}>('/lab/viewers/:id/:file',async(req,reply)=>{const file=await viewers.segment(req.params.id,owner(req),req.params.file,Date.now());return reply.type(file.type).send(file.bytes);});
let timerBusy=false;
const timer=setInterval(()=>{if(timerBusy)return;timerBusy=true;viewers.reap(Date.now());void (viewers.activeCount(Date.now())?broadcast.tick():broadcast.stop()).catch(()=>{broadcast.failure='FIXTURE_CACHE_FAILED';}).finally(()=>{timerBusy=false;});},200);
app.addHook('preClose',async()=>{clearInterval(timer);await broadcast.stop();});app.addHook('onClose',async()=>{db.close();});
for(const s of ['SIGINT','SIGTERM'] as const)process.once(s,()=>{void app.close();});
await app.listen({host:'127.0.0.1',port});console.log(`Generated live clock experiment: http://localhost:${port} (fixture cookies only; no Plex/provider media)`);
