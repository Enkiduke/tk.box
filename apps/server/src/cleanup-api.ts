import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {CleanupStore,cleanupConnectionsInput,cleanupSettings,holdKey} from './persistence/cleanup-store.js';
import type {CleanupEngine,CleanupServices} from './services/cleanup-engine.js';
import {viewer} from './modules/access.js';

// Admin › Server › Clean Up: the purge script's settings, its Tautulli connection (shown in Admin ›
// Connections) and its jobs. Administrators only (the cleanup module's default access). A job runs with the Plex token of the administrator
// who started it.
const revision=z.number().int().nonnegative();

export function registerCleanup(app:FastifyInstance,store:CleanupStore,engine:CleanupEngine,services:()=>CleanupServices) {
  app.get('/api/v1/admin/cleanup',async request=>{
    const {grant}=viewer(request),query=z.object({recheck:z.enum(['1']).optional()}).strict().parse(request.query),s=services();
    const set=(c:{url:string;key?:string})=>!!(c.url&&c.key);
    return {settings:store.settings(),libraries:grant.libraries.filter(l=>['movie','show'].includes(l.type)),engine:await engine.status(!!query.recheck),missing:engine.missing(),
      connected:{seerr:!!(s.seerr?.url&&s.seerr.apiKey),tautulli:set(s.tautulli),radarr:set(s.radarr),sonarr:set(s.sonarr)},schedule:engine.scheduleState(),busy:engine.pending()};
  });
  app.put('/api/v1/admin/cleanup/settings',async request=>{
    const {grant}=viewer(request),{expectedRevision,...value}=cleanupSettings.extend({expectedRevision:revision}).strict().parse(request.body);
    return store.update(grant.accountId,expectedRevision,value);
  });
  app.get('/api/v1/admin/cleanup/connections',async request=>{return store.connectionsView();});
  app.put('/api/v1/admin/cleanup/connections',async request=>{
    const {grant}=viewer(request),{expectedRevision,...value}=cleanupConnectionsInput.extend({expectedRevision:revision}).strict().parse(request.body);
    return store.updateConnections(grant.accountId,expectedRevision,value);
  });
  app.get('/api/v1/admin/cleanup/titles',async request=>{return engine.titles();});
  // Start a title's rule over from today, or drop that hold.
  app.post('/api/v1/admin/cleanup/holds',async request=>{
    const {grant}=viewer(request),body=z.discriminatedUnion('action',[
      z.object({key:holdKey,action:z.literal('reset')}).strict(),
      z.object({key:holdKey,action:z.literal('clear')}).strict()]).parse(request.body);
    return engine.hold(grant.accountId,body.key,body);
  });
  // Keep: tag the title in Radarr or Sonarr with the first protected tag, so no run deletes it.
  app.post('/api/v1/admin/cleanup/keep',async request=>{
    const {grant}=viewer(request),{key}=z.object({key:holdKey}).strict().parse(request.body);
    return engine.keep(grant.accountId,key);
  });
  app.get('/api/v1/admin/cleanup/jobs',async request=>{return {jobs:store.jobs(30)};});
  app.post('/api/v1/admin/cleanup/jobs',{config:{rateLimit:{max:10,timeWindow:60000}}},async request=>{
    const {grant}=viewer(request),{preview}=z.object({preview:z.boolean()}).strict().parse(request.body);
    return engine.enqueue(grant.accountId,preview,grant.serverToken);
  });
  app.get<{Params:{id:string}}>('/api/v1/admin/cleanup/jobs/:id',async request=>{
    const id=z.coerce.number().int().positive().parse(request.params.id),{since}=z.object({since:z.coerce.number().int().nonnegative().default(0)}).strict().parse(request.query);
    return engine.job(id,since);
  });
  app.post<{Params:{id:string}}>('/api/v1/admin/cleanup/jobs/:id/cancel',async request=>{
    z.object({}).strict().parse(request.body);engine.cancel(z.coerce.number().int().positive().parse(request.params.id));return {status:'canceling'};
  });
}
