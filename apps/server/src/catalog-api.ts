import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {PlexAdapter,PlexGrant} from './providers/plex.js';
import {catalogAction,catalogQuery} from './providers/plex-catalog.js';

// `hiddenRecent` gives the TMDb IDs of movies kept off Recently added (collection downloads).
export function registerCatalog(app:FastifyInstance,plex:PlexAdapter,auth:(request:FastifyRequest)=>Promise<{grant:PlexGrant}>,hiddenRecent:()=>Set<number>=()=>new Set()) {
  const id=(params:unknown)=>z.object({id:z.string().regex(/^\d+$/)}).parse(params).id;
  // `v` only gives changed art a new address (see `versioned`); the image served is always the current one.
  // `scale=2` asks for a double-size poster, for high-density screens.
  const version=z.object({v:z.string().regex(/^\d{1,20}$/).optional(),scale:z.literal('2').transform(()=>2 as const).optional()}).strict();
  app.get('/api/v1/catalog/libraries/:id/genres',async request=>{const {grant}=await auth(request);return plex.catalogGenres(grant,id(request.params));});
  app.get('/api/v1/catalog/libraries/:id/genres/art',async request=>{const {grant}=await auth(request);return plex.catalogGenreArt(grant,id(request.params));});
  app.get('/api/v1/catalog/libraries/:id/index',async request=>{const {grant}=await auth(request);return plex.catalogIndex(grant,id(request.params),catalogQuery.parse(request.query));});
  app.get('/api/v1/catalog/libraries/:id/items',async request=>{const {grant}=await auth(request);return plex.catalogPage(grant,id(request.params),catalogQuery.parse(request.query),hiddenRecent);});
  app.get('/api/v1/catalog/items/:id',async request=>{const {grant}=await auth(request);return plex.catalogItem(grant,id(request.params));});
  // Mark watched/unwatched or remove from Continue Watching, as the signed-in viewer.
  app.post('/api/v1/catalog/items/:id/state',{config:{rateLimit:{max:60,timeWindow:60000}}},async request=>{
    const {grant}=await auth(request),input=catalogAction.parse(request.body);
    await plex.catalogWatchState(grant,id(request.params),input.action);return {status:'updated'};
  });
  app.get('/api/v1/catalog/libraries/:id/collections',async request=>{const {grant}=await auth(request);return plex.catalogCollections(grant,id(request.params));});
  app.get('/api/v1/catalog/home/collections',async request=>{const {grant}=await auth(request);return plex.homeCollections(grant);});
  app.get('/api/v1/catalog/collections/:id',async request=>{const {grant}=await auth(request);return plex.catalogCollection(grant,id(request.params));});
  app.get('/api/v1/catalog/collections/:id/items',async request=>{const {grant}=await auth(request);return plex.catalogCollectionItems(grant,id(request.params),catalogQuery.parse(request.query));});
  app.get('/api/v1/catalog/collections/:id/artwork',{config:{rateLimit:{max:1200,timeWindow:60000}}},async(request,reply)=>{
    const {grant}=await auth(request),{v,scale}=version.parse(request.query);const image=await plex.collectionArtwork(grant,id(request.params),v,scale);
    return sendImage(request,reply,image,!!v);
  });
  app.get('/api/v1/catalog/items/:id/children',async request=>{const {grant}=await auth(request);return plex.catalogChildren(grant,id(request.params),catalogQuery.parse(request.query));});
  app.get('/api/v1/catalog/items/:id/artwork',{config:{rateLimit:{max:1200,timeWindow:60000}}},async(request,reply)=>{
    const {grant}=await auth(request),query=z.object({kind:z.enum(['poster','backdrop','logo','tile']).default('poster')}).merge(version).parse(request.query);
    return sendImage(request,reply,await plex.artwork(grant,id(request.params),query.kind,query.v,query.scale),!!query.v);
  });
}
// A versioned address (`v`) only ever names one picture, so the browser keeps it and stops asking. Other
// addresses revalidate the session and current item before every 304 as well as 200.
function sendImage(request:FastifyRequest,reply:FastifyReply,image:{bytes:Buffer;type:string},versioned=false) {
  const etag=`"${createHash('sha256').update(image.bytes).digest('hex')}"`;
  reply.header('Cache-Control',versioned?'private, max-age=31536000, immutable':'private, no-cache').header('ETag',etag);
  if(request.headers['if-none-match']===etag)return reply.code(304).send();
  return reply.type(image.type).send(image.bytes);
}
