import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {PlexGrant} from './providers/plex.js';
import {ExploreImages} from './providers/explore-images.js';
import {ArtworkStore,artworkCollectionsInput,artworkSettingsInput,layoutName,layoutValue} from './persistence/artwork-store.js';
import type {ArtworkEngine,ArtworkRun} from './services/artwork-engine.js';
import type {ArtworkWorker} from './services/artwork-worker.js';
import type {ArtworkSchedule} from './services/artwork-schedule.js';
import {requireThat} from './errors.js';
import {remoteJson} from './providers/remote-json.js';
import {TmdbTitles} from './providers/tmdb-titles.js';

// Admin › Artwork: the engine's settings, layouts, titles, collections, schedules and jobs. Every route is
// administrator-only. Jobs and the worker run as the administrator who asked, with their Plex token, which the engine
// needs to read libraries and upload posters. Images reach the page only through these routes (it may load images from
// tk.box alone): the worker's own files and previews, Plex's copies, and the artwork providers' pictures, proxied.
type Admin=(request:FastifyRequest)=>Promise<{grant:PlexGrant}>;
const jobInput=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('changed')}).strict(),
  z.object({kind:z.literal('all')}).strict(),
  z.object({kind:z.literal('refresh')}).strict(),
  z.object({kind:z.literal('item'),ratingKey:z.string().regex(/^\d{1,10}$/),seasons:z.boolean().default(false),episodes:z.boolean().default(false),remake:z.boolean().default(false)}).strict()
]);
// Arguments are built here from a fixed set of choices; nothing from the request reaches the command line as text.
function jobArgs(input:z.infer<typeof jobInput>):{label:string;args:string[]} {
  switch(input.kind){
    case 'changed':return {label:'Update changed titles',args:['--changed-only']};
    // A run without selectors or --changed-only remakes everything configured.
    case 'all':return {label:'Rebuild every title',args:[]};
    case 'refresh':return {label:'Send saved results to Plex again',args:['--refresh']};
    case 'item':return {label:`Title ${input.ratingKey}${input.seasons?' with seasons':''}${input.episodes?' and episodes':''}`,
      args:['--item',input.ratingKey,...(input.seasons?['--with-seasons']:[]),...(input.episodes?['--with-episodes']:[]),...(input.remake?['--remake']:['--changed-only'])]};
  }
}
// An asset folder (movies/<title>, tv/<title>[/Season NN]) or a file in one; the worker checks the folder itself.
const rel=z.string().min(3).max(400).refine(v=>!v.split('/').some(p=>p===''||p==='.'||p==='..'),'Invalid path');
const kind=z.enum(['poster','logo']);
const fileName=z.string().regex(/^[\w .()-]{1,120}$/);
// A title's artwork in Plex: its current one (/thumb/123) or one of the posters its agents offered (/file?url=metadata%3A…),
// or a collection's own collage of its titles (/library/collections/123/composite/456?width=400&height=600).
const plexPath=z.string().max(500).regex(/^\/library\/(?:metadata\/\d+\/(?:[\w/]+|file\?url=[\w%.-]+)|collections\/\d+\/composite\/\d+(?:\?width=\d{1,4}&height=\d{1,4})?)$/);
const link=z.string().url().max(2000);
const width=z.coerce.number().int().min(64).max(2000).optional();
const crop=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),w:z.number().positive().max(1),h:z.number().positive().max(1)}).strict();
const templateMode=z.enum(['poster','season','episode']);
const templateValues=z.record(z.string().regex(/^[a-z_]{1,60}$/),z.unknown()).refine(v=>JSON.stringify(v).length<=40000,'Too many settings');
// Plex's own candidates also link to its metadata CDN (Gracenote stills) and IMDb's image host.
const providerHosts=(host:string)=>['image.tmdb.org','assets.fanart.tv','artworks.thetvdb.com','metadata-static.plex.tv','m.media-amazon.com'].includes(host);
const images={config:{rateLimit:{max:1200,timeWindow:60000}}};
const libraries=(grant:PlexGrant)=>grant.libraries.filter(l=>['movie','show'].includes(l.type));
const runOf=(grant:PlexGrant):ArtworkRun=>({token:grant.serverToken,libraries:grant.libraries});

export function registerArtwork(app:FastifyInstance,store:ArtworkStore,engine:ArtworkEngine,worker:ArtworkWorker,schedule:ArtworkSchedule,admin:Admin) {
  const remote=new ExploreImages(fetch,providerHosts,15*1024*1024),titles=new TmdbTitles(()=>store.keys().tmdb);
  const ask=async<T,>(request:FastifyRequest,method:string,params:Record<string,unknown>={})=>{const {grant}=await admin(request);return worker.request<T>(runOf(grant),method,params);};
  const send=(reply:FastifyReply,image:{bytes:Buffer;type:string;note?:string},cache='no-store')=>{
    reply.header('Cache-Control',cache);if(image.note)reply.header('X-Artwork-Note',image.note);
    return reply.type(image.type).send(image.bytes);
  };
  // After settings, layouts or collections change, the worker's config is written again.
  const changed=(grant:PlexGrant)=>worker.refresh(runOf(grant));

  app.get('/api/v1/admin/artwork',async request=>{
    const {grant}=await admin(request),query=z.object({recheck:z.enum(['1']).optional()}).strict().parse(request.query);
    return {settings:store.view(),layouts:store.layoutNames(),libraries:libraries(grant),engine:await engine.status(!!query.recheck),queue:engine.busy(),schedules:schedule.states()};
  });
  app.put('/api/v1/admin/artwork/settings',async request=>{
    const {grant}=await admin(request),{expectedRevision,...value}=artworkSettingsInput.extend({expectedRevision:z.number().int().nonnegative()}).strict().parse(request.body);
    const saved=await store.update(grant.accountId,expectedRevision,value,settings=>engine.check({settings},grant.libraries));changed(grant);return saved;
  });
  app.get<{Params:{name:string}}>('/api/v1/admin/artwork/layouts/:name',async request=>{await admin(request);return store.layout(layoutName.parse(request.params.name));});
  app.put<{Params:{name:string}}>('/api/v1/admin/artwork/layouts/:name',async request=>{
    const {grant}=await admin(request),name=layoutName.parse(request.params.name),input=z.object({expectedRevision:z.number().int().nonnegative(),value:layoutValue}).strict().parse(request.body);
    const saved=await store.saveLayout(grant.accountId,name,input.expectedRevision,input.value,layouts=>engine.check({layouts},grant.libraries));changed(grant);return saved;
  });
  app.delete<{Params:{name:string}}>('/api/v1/admin/artwork/layouts/:name',async request=>{const {grant}=await admin(request);store.removeLayout(grant.accountId,layoutName.parse(request.params.name));changed(grant);return {status:'removed'};});

  // Jobs
  app.get('/api/v1/admin/artwork/jobs',async request=>{
    await admin(request);const {script}=z.object({script:z.enum(['artwork','collections']).optional()}).strict().parse(request.query);
    return {jobs:store.jobs(30,script),queue:engine.busy()};
  });
  app.post('/api/v1/admin/artwork/jobs',{config:{rateLimit:{max:30,timeWindow:60000}}},async request=>{
    const {grant}=await admin(request),{label,args}=jobArgs(jobInput.parse(request.body));
    return engine.enqueue(grant.accountId,label,args,runOf(grant));
  });
  app.get<{Params:{id:string}}>('/api/v1/admin/artwork/jobs/:id',async request=>{
    await admin(request);const id=z.coerce.number().int().positive().parse(request.params.id),{since}=z.object({since:z.coerce.number().int().nonnegative().default(0)}).strict().parse(request.query);
    return engine.job(id,since);
  });
  app.post<{Params:{id:string}}>('/api/v1/admin/artwork/jobs/:id/cancel',async request=>{
    await admin(request);z.object({}).strict().parse(request.body);engine.cancel(z.coerce.number().int().positive().parse(request.params.id));return {status:'canceling'};
  });

  // Titles: each title's asset folder, its candidates and what the providers offer.
  app.get('/api/v1/admin/artwork/titles',async request=>{z.object({}).strict().parse(request.query);return ask(request,'titles');});
  app.get('/api/v1/admin/artwork/titles/find',async request=>{const {ratingKey}=z.object({ratingKey:z.string().regex(/^\d{1,10}$/)}).strict().parse(request.query);return ask(request,'find',{rating_key:ratingKey});});
  app.get('/api/v1/admin/artwork/title',async request=>{const {id}=z.object({id:rel}).strict().parse(request.query);return ask(request,'detail',{id});});
  app.get('/api/v1/admin/artwork/title/live',async request=>{const {id}=z.object({id:rel}).strict().parse(request.query);return ask(request,'live',{id});});
  app.get('/api/v1/admin/artwork/title/remote',async request=>{const q=z.object({id:rel,kind:z.enum(['poster','logo','backdrop'])}).strict().parse(request.query);return ask(request,'remote',q);});
  app.get('/api/v1/admin/artwork/state',async request=>ask(request,'state'));
  app.get('/api/v1/admin/artwork/preview',images,async(request,reply)=>{
    const q=z.object({id:rel,poster:fileName.optional(),logo:fileName.optional(),w:width,kind:kind.optional(),url:link.optional(),plex:plexPath.optional(),v:z.string().max(40).optional()}).strict().parse(request.query);
    const {grant}=await admin(request);return send(reply,await worker.image(runOf(grant),'preview',q));
  });
  app.get('/api/v1/admin/artwork/file',images,async(request,reply)=>{
    const q=z.object({p:rel,w:width,v:z.string().max(40).optional()}).strict().parse(request.query),{grant}=await admin(request);
    // The address changes with the file (v), so the browser may keep it.
    return send(reply,await worker.image(runOf(grant),'file',{p:q.p,w:q.w}),'private, max-age=86400');
  });
  app.get('/api/v1/admin/artwork/plex-image',images,async(request,reply)=>{
    const {p}=z.object({p:plexPath}).strict().parse(request.query),{grant}=await admin(request);
    return send(reply,await worker.image(runOf(grant),'plex_image',{p}),'private, max-age=3600');
  });
  app.get('/api/v1/admin/artwork/image',images,async(request,reply)=>{
    const {u}=z.object({u:link}).strict().parse(request.query);await admin(request);
    return send(reply,await remote.get(u),'private, max-age=3600');
  });
  app.post('/api/v1/admin/artwork/title/select',async request=>ask(request,'select',z.object({id:rel,kind,name:fileName}).strict().parse(request.body)));
  app.post('/api/v1/admin/artwork/title/no-logo',async request=>ask(request,'no_logo',z.object({id:rel,on:z.boolean()}).strict().parse(request.body)));
  // A collection's generated background: use it as the poster, or draw it again in another colour (null: its default).
  app.post('/api/v1/admin/artwork/title/generated',async request=>ask(request,'generated',z.object({id:rel}).strict().parse(request.body)));
  app.post('/api/v1/admin/artwork/title/background-color',async request=>ask(request,'background_color',z.object({id:rel,color:z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable()}).strict().parse(request.body)));
  app.post('/api/v1/admin/artwork/title/import',async request=>{
    const input=z.object({id:rel,kind,url:link.optional(),plex:plexPath.optional(),use:z.boolean(),crop:crop.optional()}).strict().parse(request.body);
    requireThat(!!input.url!==!!input.plex,'VALIDATION_FAILED','Give a picture’s address or its Plex path.');
    return ask(request,'import',input);
  });
  // An image from the administrator's computer, sent as base64 inside JSON like every other request (up to 25 MB).
  app.post('/api/v1/admin/artwork/title/upload',{bodyLimit:36*1024*1024},async request=>
    ask(request,'upload',z.object({id:rel,kind,data:z.string().max(35*1024*1024).regex(/^[A-Za-z0-9+/]*={0,2}$/),use:z.boolean()}).strict().parse(request.body)));
  app.post('/api/v1/admin/artwork/title/discard',async request=>ask(request,'discard',z.object({id:rel}).strict().parse(request.body)));
  app.post('/api/v1/admin/artwork/title/remove',async request=>ask(request,'remove',z.object({id:rel,kind,name:fileName}).strict().parse(request.body)));
  app.post('/api/v1/admin/artwork/title/clear',async request=>{z.object({}).strict().parse(request.body);return ask(request,'clear');});
  // A push makes the chosen titles' artwork again (and sends it to Plex when uploads are on), one job per title.
  app.post('/api/v1/admin/artwork/push',{config:{rateLimit:{max:30,timeWindow:60000}}},async request=>{
    const {ids}=z.object({ids:z.array(rel).min(1).max(200).optional()}).strict().parse(request.body),{grant}=await admin(request),run=runOf(grant);
    const {jobs}=await worker.request<{jobs:{id:string;title:string;args:string[]}[]}>(run,'push',ids?{ids}:{});
    const verb=store.settings().upload?'Push':'Render';
    return {jobs:jobs.map(job=>engine.enqueue(grant.accountId,`${verb}: ${job.title}`,job.args,run,{done:()=>{void worker.request(run,'pushed',{id:job.id}).catch(()=>{});}}))};
  });

  // The layout editor: every layout's settings as it edits them, live previews of unsaved changes, and saving them.
  app.get('/api/v1/admin/artwork/template',async request=>ask(request,'template'));
  app.post('/api/v1/admin/artwork/template/preview',{config:{rateLimit:{max:600,timeWindow:60000}}},async(request,reply)=>{
    const input=z.object({layout:layoutName,mode:templateMode,values:templateValues,id:rel,w:z.number().int().min(160).max(720),banner:z.string().max(40).default('')}).strict().parse(request.body);
    const {grant}=await admin(request);return send(reply,await worker.image(runOf(grant),'template_preview',input));
  });
  app.post('/api/v1/admin/artwork/template/save',async request=>{
    const input=z.object({layout:layoutName,mode:templateMode,values:templateValues}).strict().parse(request.body),{grant}=await admin(request),run=runOf(grant);
    const {layout}=await worker.request<{layout:Record<string,unknown>}>(run,'template_merge',input);
    await store.saveLayout(grant.accountId,input.layout,store.layout(input.layout).revision,layoutValue.parse(layout),layouts=>engine.check({layouts},grant.libraries));
    changed(grant);return worker.request(run,'template');
  });

  // Collections
  app.get('/api/v1/admin/artwork/collections',async request=>{
    const {grant}=await admin(request),saved=store.collections();
    // Until definitions are first saved, the engine's seasonal presets (all off) are what it would use.
    const defaults=await engine.collections<{collections:unknown[]}>(runOf(grant),'defaults').then(d=>d.collections,()=>[]);
    return {...saved,defaults,kept:engine.keptCollections(),scheduleStates:schedule.collectionStates(),libraries:libraries(grant),upload:store.settings().upload};
  });
  app.put('/api/v1/admin/artwork/collections',{bodyLimit:512*1024},async request=>{
    const {grant}=await admin(request);
    const saved=await store.updateCollections(grant.accountId,artworkCollectionsInput.parse(request.body),({radarrKey:_,...collections})=>engine.check({collections},grant.libraries));
    changed(grant);return saved;
  });
  // The saved Radarr's quality profiles, so downloads can name one (the engine is given its ID).
  app.get('/api/v1/admin/artwork/collections/radarr-profiles',async request=>{
    await admin(request);const {radarr,radarrKey}=store.collectionsConfig();
    if(!radarr.url||!radarrKey)return {connected:false,profiles:[]};
    const response=await remoteJson(new URL(`${radarr.url}/api/v3/qualityprofile`),{headers:{'X-Api-Key':radarrKey}},'Radarr',fetch,8000);
    requireThat(response.status<400,'CATALOG_UNAVAILABLE',response.status===401?'Radarr refused the API key.':`Radarr answered ${response.status}.`,502);
    const profiles=z.array(z.object({id:z.number().int(),name:z.string()}).passthrough()).catch([]).parse(response.data);
    return {connected:true,profiles:profiles.map(({id,name})=>({id,name}))};
  });
  // Picking a collection's titles: a TMDb search, and posters for the members it already has.
  app.get('/api/v1/admin/artwork/collections/titles/search',{config:{rateLimit:{max:120,timeWindow:60000}}},async request=>{
    const q=z.object({q:z.string().trim().min(1).max(200),type:z.enum(['movie','tv'])}).strict().parse(request.query);await admin(request);
    return {results:await titles.search(q.type,q.q)};
  });
  app.post('/api/v1/admin/artwork/collections/titles/lookup',async request=>{
    const member=z.object({rating_key:z.string().max(20).optional(),tmdb_id:z.number().int().positive().optional(),imdb_id:z.string().regex(/^tt\d{1,12}$/).optional(),title:z.string().max(300).optional(),year:z.number().int().optional()}).strict();
    const input=z.object({type:z.enum(['movie','tv']),members:z.array(member).max(500)}).strict().parse(request.body);await admin(request);
    return {configured:titles.configured(),items:titles.configured()?await titles.lookup(input.type,input.members):input.members.map(()=>null)};
  });
  app.post('/api/v1/admin/artwork/collections/discover',async request=>{
    const input=z.object({mode:z.enum(['recommendations','browse','universes','preview']),provider:z.enum(['all','tmdb','trakt','mdblist','imdb','letterboxd','flixpatrol']).optional(),
      query:z.string().max(200).optional(),type:z.enum(['movie','tv']).optional(),universe:z.string().max(60).optional(),url:link.optional(),limit:z.number().int().min(1).max(250).optional()}).strict().parse(request.body);
    const {grant}=await admin(request);return engine.collections(runOf(grant),'discover',input);
  });
  app.post('/api/v1/admin/artwork/collections/run',{config:{rateLimit:{max:30,timeWindow:60000}}},async request=>{
    const input=z.object({kind:z.enum(['custom','all','added']),mode:z.enum(['plan','apply']),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),ratingKey:z.string().regex(/^\d{1,10}$/).optional()}).strict().parse(request.body),{grant}=await admin(request);
    requireThat(input.mode==='plan'||store.settings().upload,'ARTWORK_UPLOAD_OFF','Applying collections changes Plex. Turn on Send results to Plex in Artwork settings first.',409);
    requireThat(!input.date||(input.kind==='custom'&&input.mode==='plan'),'VALIDATION_FAILED','A simulated date is only for previewing custom collections.');
    // One title joins the custom collections it matches; the engine applies this when results go to Plex, else plans it.
    requireThat(input.kind!=='added'||(!!input.ratingKey&&input.mode===(store.settings().upload?'apply':'plan')),'VALIDATION_FAILED','Give the title’s Plex ID.');
    if(input.kind==='added')return engine.enqueue(grant.accountId,`Collections for title ${input.ratingKey}: ${input.mode==='plan'?'preview the plan':'apply'}`,['added',input.ratingKey!],runOf(grant),{script:'collections'});
    const args=input.kind==='custom'?['custom',input.mode,...(input.date?['--date',input.date]:[])]:['all',input.mode];
    const label=`${input.kind==='custom'?'Custom and seasonal collections':'Every collection'}: ${input.mode==='plan'?'preview the plan':'apply'}${input.date?` as of ${input.date}`:''}`;
    return engine.enqueue(grant.accountId,label,args,runOf(grant),{script:'collections'});
  });
}
