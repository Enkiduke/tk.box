import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {PlexGrant} from './providers/plex.js';
import {CleanupStore,cleanupConnectionsInput,cleanupSettings} from './persistence/cleanup-store.js';
import type {CleanupEngine,CleanupServices} from './services/cleanup-engine.js';

// Admin › Server › Clean Up: the purge script's settings, its Tautulli and Sonarr connections (shown in Admin ›
// Connections) and its jobs. Administrators only. A job runs with the Plex token of the administrator who started it.
type Admin=(request:FastifyRequest)=>Promise<{grant:PlexGrant}>;
const revision=z.number().int().nonnegative();

export function registerCleanup(app:FastifyInstance,store:CleanupStore,engine:CleanupEngine,services:()=>CleanupServices,admin:Admin) {
  app.get('/api/v1/admin/cleanup',async request=>{
    const {grant}=await admin(request),query=z.object({recheck:z.enum(['1']).optional()}).strict().parse(request.query),s=services();
    const set=(c:{url:string;key?:string})=>!!(c.url&&c.key);
    return {settings:store.settings(),libraries:grant.libraries.filter(l=>['movie','show'].includes(l.type)),engine:await engine.status(!!query.recheck),missing:engine.missing(),
      connected:{seerr:!!(s.seerr?.url&&s.seerr.apiKey),tautulli:set(s.tautulli),radarr:set(s.radarr),sonarr:set(s.sonarr)},schedule:engine.scheduleState(),busy:engine.pending()};
  });
  app.put('/api/v1/admin/cleanup/settings',async request=>{
    const {grant}=await admin(request),{expectedRevision,...value}=cleanupSettings.extend({expectedRevision:revision}).strict().parse(request.body);
    return store.update(grant.accountId,expectedRevision,value);
  });
  app.get('/api/v1/admin/cleanup/connections',async request=>{await admin(request);return store.connectionsView();});
  app.put('/api/v1/admin/cleanup/connections',async request=>{
    const {grant}=await admin(request),{expectedRevision,...value}=cleanupConnectionsInput.extend({expectedRevision:revision}).strict().parse(request.body);
    return store.updateConnections(grant.accountId,expectedRevision,value);
  });
  app.get('/api/v1/admin/cleanup/titles',async request=>{await admin(request);return engine.titles();});
  app.get('/api/v1/admin/cleanup/jobs',async request=>{await admin(request);return {jobs:store.jobs(30)};});
  app.post('/api/v1/admin/cleanup/jobs',{config:{rateLimit:{max:10,timeWindow:60000}}},async request=>{
    const {grant}=await admin(request),{preview}=z.object({preview:z.boolean()}).strict().parse(request.body);
    return engine.enqueue(grant.accountId,preview,grant.serverToken);
  });
  app.get<{Params:{id:string}}>('/api/v1/admin/cleanup/jobs/:id',async request=>{
    await admin(request);const id=z.coerce.number().int().positive().parse(request.params.id),{since}=z.object({since:z.coerce.number().int().nonnegative().default(0)}).strict().parse(request.query);
    return engine.job(id,since);
  });
  app.post<{Params:{id:string}}>('/api/v1/admin/cleanup/jobs/:id/cancel',async request=>{
    await admin(request);z.object({}).strict().parse(request.body);engine.cancel(z.coerce.number().int().positive().parse(request.params.id));return {status:'canceling'};
  });
}
