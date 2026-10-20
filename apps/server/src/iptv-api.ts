import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IptvStore, sourceCreate, sourceOrder, sourcePolicy, channelEdit, listingEdit, groupEdit, bulkListing, identityResolution } from './persistence/iptv-store.js';
import { SourceRefresh } from './services/source-refresh.js';
import { sourceEndpoint } from './providers/source-fetch.js';
import { AppError } from './errors.js';
import { ChannelLogos } from './providers/channel-logos.js';
import { LogoLibrary } from './providers/logo-library.js';
import { sportIcon } from './providers/sport-icons.js';
import type { CustomChannelStore } from './persistence/custom-channels.js';

type Access=(req:FastifyRequest)=>Promise<{grant:{accountId:string}}>;
type Image={type:string;bytes:Buffer};
// A Plex title's artwork, read with the viewer's own grant so it never shows a library they can't see.
type PlexArtwork=(req:FastifyRequest,id:string,kind:'logo'|'poster')=>Promise<Image>;
export function registerIptv(app:FastifyInstance,store:IptvStore,refresh:SourceRefresh,auth:Access,admin:Access,logos=new ChannelLogos(),library=new LogoLibrary(),custom?:CustomChannelStore,plexArtwork?:PlexArtwork) {
  const id=z.string().uuid(), revision=z.number().int().nonnegative();
  const sourceParams=(p:unknown)=>z.object({id}).parse(p).id;
  const channelParams=(p:unknown)=>z.object({id}).parse(p).id;
  app.get('/api/v1/admin/iptv/sources',async req=>{await admin(req);return {sources:store.list().map(s=>({...s,running:refresh.active(s.id)}))};});
  app.post('/api/v1/admin/iptv/sources',async req=>{const {grant}=await admin(req);return store.create(grant.accountId,sourceCreate.parse(req.body));});
  app.put('/api/v1/admin/iptv/sources/order',async req=>{const {grant}=await admin(req);return {sources:store.reorder(grant.accountId,sourceOrder.parse(req.body)).map(s=>({...s,running:refresh.active(s.id)}))};});
  app.delete('/api/v1/admin/iptv/sources/:id',async req=>{
    const {grant}=await admin(req),input=z.object({expectedRevision:revision}).strict().parse(req.body);
    return refresh.remove(grant.accountId,sourceParams(req.params),input.expectedRevision);
  });
  app.patch('/api/v1/admin/iptv/sources/:id',async req=>{const {grant}=await admin(req);return store.policy(grant.accountId,sourceParams(req.params),sourcePolicy.parse(req.body));});
  app.put('/api/v1/admin/iptv/sources/:id/endpoint',async req=>{const {grant}=await admin(req),input=z.object({expectedRevision:revision,endpoint:sourceEndpoint}).strict().parse(req.body);return store.replaceEndpoint(grant.accountId,sourceParams(req.params),input.expectedRevision,input.endpoint);});
  app.post('/api/v1/admin/iptv/sources/:id/refresh',async req=>{const {grant}=await admin(req);z.object({}).strict().parse(req.body);return refresh.refresh(grant.accountId,sourceParams(req.params));});
  app.post('/api/v1/admin/iptv/sources/:id/upload',{bodyLimit:17*1024*1024},async req=>{
    const {grant}=await admin(req),input=z.object({expectedRevision:revision,text:z.string().max(16*1024*1024)}).strict().parse(req.body);
    const id=sourceParams(req.params),result=store.ingest(grant.accountId,id,input.expectedRevision,Buffer.from(input.text));refresh.published(id);return result;
  });
  app.get('/api/v1/admin/iptv/sources/:id/candidate',async req=>{await admin(req);return store.candidateReview(sourceParams(req.params));});
  app.post('/api/v1/admin/iptv/sources/:id/candidate/accept',async req=>{
    const {grant}=await admin(req),input=z.object({expectedRevision:revision,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
    const id=sourceParams(req.params),result=store.acceptCandidate(grant.accountId,id,input.expectedRevision,input.digest);refresh.published(id);return result;
  });
  app.get('/api/v1/admin/iptv/sources/:id/channels',async req=>{await admin(req);const source=sourceParams(req.params);return {channels:store.adminChannels(source),summary:store.listingSummary(source)};});
  app.post('/api/v1/admin/iptv/sources/:id/channels/listing',async req=>{const {grant}=await admin(req);return store.setListing(grant.accountId,sourceParams(req.params),bulkListing.parse(req.body));});
  // Listing rules: which of this source's channels list themselves (there is no approval step).
  app.get('/api/v1/admin/iptv/sources/:id/listing',async req=>{await admin(req);const source=sourceParams(req.params);return {policy:store.listingPolicy(source),summary:store.listingSummary(source),groups:store.groups(source)};});
  app.put('/api/v1/admin/iptv/sources/:id/listing',async req=>{const {grant}=await admin(req),source=sourceParams(req.params);store.setListingPolicy(grant.accountId,source,listingEdit.parse(req.body));return {policy:store.listingPolicy(source),summary:store.listingSummary(source),groups:store.groups(source),source:store.status(source)};});
  app.put('/api/v1/admin/iptv/sources/:id/groups',async req=>{const {grant}=await admin(req),source=sourceParams(req.params);store.setGroup(grant.accountId,source,groupEdit.parse(req.body));return {policy:store.listingPolicy(source),summary:store.listingSummary(source),groups:store.groups(source),source:store.status(source)};});
  app.patch('/api/v1/admin/iptv/channels/:id',async req=>{const {grant}=await admin(req);return store.editChannel(grant.accountId,channelParams(req.params),channelEdit.parse(req.body));});
  app.get('/api/v1/admin/iptv/channels/:id/identity',async req=>{await admin(req);return store.identityReview(channelParams(req.params));});
  app.post('/api/v1/admin/iptv/channels/:id/identity',async req=>{const {grant}=await admin(req);return store.resolveIdentity(grant.accountId,channelParams(req.params),identityResolution.parse(req.body));});
  app.post('/api/v1/admin/iptv/sources/:id/feed',async req=>{
    const {grant}=await admin(req),input=z.object({expectedRevision:revision,feedId:id}).strict().parse(req.body);
    return store.bindFeed(grant.accountId,sourceParams(req.params),input.feedId,input.expectedRevision);
  });
  app.put('/api/v1/admin/iptv/sources/:id/guide',async req=>{
    const {grant}=await admin(req),input=z.object({expectedRevision:revision,endpoint:sourceEndpoint.optional(),intervalHours:z.number().int().min(1).max(168)}).strict().parse(req.body);
    const result=store.saveGuide(grant.accountId,sourceParams(req.params),input.expectedRevision,input);
    return {...result,guide:{...result.guide,running:refresh.active(result.guide.id)}};
  });
  app.delete('/api/v1/admin/iptv/sources/:id/guide',async req=>{
    const {grant}=await admin(req),input=z.object({expectedRevision:revision}).strict().parse(req.body);
    return refresh.removeGuide(grant.accountId,sourceParams(req.params),input.expectedRevision);
  });
  app.get('/api/v1/admin/iptv/channels/:id/mapping',async req=>{
    await admin(req);const input=z.object({feedId:id}).strict().parse(req.query);return store.mappingReview(channelParams(req.params),input.feedId);
  });
  app.post('/api/v1/admin/iptv/channels/:id/mapping',async req=>{
    const {grant}=await admin(req),input=z.object({feedId:id,xmlId:z.string().min(1).max(1024),expectedRevision:revision}).strict().parse(req.body);
    return store.map(grant.accountId,channelParams(req.params),input.feedId,input.xmlId,input.expectedRevision);
  });
  app.get('/api/v1/iptv/channels',async req=>{const {grant}=await auth(req);return {channels:store.stacks(),favorites:store.favorites(grant.accountId).map(c=>c.id)};});
  app.get('/api/v1/guide',async req=>{
    const {grant}=await auth(req),input=z.object({start:z.coerce.number().int(),end:z.coerce.number().int(),filter:z.union([z.enum(['all','custom','favorites']),z.string().uuid()]).default('all'),q:z.string().trim().max(120).default(''),channel:z.string().uuid().optional(),offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(60).default(30)}).strict().refine(v=>v.end>v.start&&v.end-v.start<=48*3600000).parse(req.query);
    return store.guidePage(grant.accountId,input.filter,input.start,input.end,input.offset,input.limit,input.q,input.channel,custom);
  });
  // Guide routes are shared by every channel kind; custom channel IDs are answered by the custom store.
  app.get('/api/v1/iptv/channels/:id/logo',async(req,reply)=>{
    await auth(req);
    if(custom?.exists(channelParams(req.params))){
      // The logo address, else the Plex title's logo, else its poster.
      const key=z.object({v:z.string().regex(/^\d{1,20}$/).optional()}).parse(req.query).v;
      const {url,plexId,keyed}=custom.logo(channelParams(req.params),Date.now(),key);
      let image:Image|undefined=url?await logos.get(url).catch(()=>undefined):undefined;
      if(!image&&plexId&&plexArtwork)image=await plexArtwork(req,plexId,'logo').catch(()=>plexArtwork(req,plexId,'poster')).catch(()=>undefined);
      if(!image)throw new AppError('LOGO_UNAVAILABLE','Logo unavailable.',404);
      // A keyed address always means the same title; otherwise shorter for Plex logos, as the main show can change.
      return reply.type(image.type).header('Cache-Control',`private, max-age=${url||keyed?3600:600}`).send(image.bytes);
    }
    const hints=store.logo(channelParams(req.params));
    // Standardized library logo first, then the playlist logo, then the guide's channel icon.
    const urls=[await library.match(hints.name,hints.tvgId).catch(()=>undefined),...hints.urls].filter((u):u is string=>!!u);
    let image:{type:string;bytes:Buffer}|undefined;
    for(const url of urls){image=await logos.get(url).catch(()=>undefined);if(image)break;}
    // An event channel with no logo of its own shows its game's league, else its sport. Short-lived: the slot's next event may be another league.
    const league=image?undefined:store.leagueLogo(channelParams(req.params));
    if(league)return reply.type(league.type).header('Cache-Control','private, max-age=600').send(league.bytes);
    const sport=image?undefined:store.sportFor(channelParams(req.params));
    if(sport)return reply.type('image/svg+xml').header('Cache-Control','private, max-age=600').send(sportIcon(sport));
    if(!image)throw new AppError('LOGO_UNAVAILABLE','Logo unavailable.',404);
    return reply.type(image.type).header('Cache-Control','private, max-age=86400').send(image.bytes);
  });
  app.put('/api/v1/iptv/channels/:id/favorite',async req=>{
    const {grant}=await auth(req),input=z.object({favorite:z.boolean()}).strict().parse(req.body),channel=channelParams(req.params);
    if(custom?.exists(channel))custom.favorite(grant.accountId,channel,input.favorite);else store.favorite(grant.accountId,channel,input.favorite);
    return {status:'saved'};
  });
  app.get('/api/v1/iptv/channels/:id/guide',async req=>{
    await auth(req);const channel=channelParams(req.params),input=z.object({start:z.coerce.number().int(),end:z.coerce.number().int()}).strict().refine(v=>v.end>v.start&&v.end-v.start<=48*3600000).parse(req.query);
    // Validate visibility even if this source has no feed yet.
    const visible=store.isVisible(channel);
    if(!visible)throw new AppError('CHANNEL_NOT_FOUND','Channel not found.',404);
    return {rows:store.guide(channel,store.feedFor(channel),input.start,input.end)};
  });
  const timer=setInterval(()=>{void refresh.tick().catch(()=>{});},15000);timer.unref();
  app.addHook('onReady',async()=>{store.relistAll();await refresh.tick();});
  app.addHook('preClose',async()=>{clearInterval(timer);await refresh.close();});
}
