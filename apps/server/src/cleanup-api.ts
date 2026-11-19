import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {CleanupStore,cleanupSettings,holdKey} from './persistence/cleanup-store.js';
import type {CleanupEngine} from './services/cleanup-engine.js';
import {viewer} from './modules/access.js';

// Admin › Server › Clean Up: its settings and its jobs. Administrators only (the cleanup module's default access). A job runs with the Plex token of the administrator
// who started it.
const revision=z.number().int().nonnegative();

export function registerCleanup(app:FastifyInstance,store:CleanupStore,engine:CleanupEngine) {
  app.get('/api/v1/admin/cleanup',async request=>{
    const {grant}=viewer(request);
    z.object({recheck:z.enum(['1']).optional()}).strict().parse(request.query);
    return {settings:store.settings(),libraries:grant.libraries.filter(l=>['movie','show'].includes(l.type)),engine:await engine.status(),missing:engine.missing(),
      schedule:engine.scheduleState(),busy:engine.pending()};
  });
  app.put('/api/v1/admin/cleanup/settings',async request=>{
    const {grant}=viewer(request),{expectedRevision,...value}=cleanupSettings.extend({expectedRevision:revision}).strict().parse(request.body);
    return store.update(grant.accountId,expectedRevision,value);
  });
  app.get('/api/v1/admin/cleanup/titles',async request=>{return engine.titles();});
  // Start a title's rule over from today, or drop that hold.
  app.post('/api/v1/admin/cleanup/holds',async request=>{
    const {grant}=viewer(request),body=z.discriminatedUnion('action',[
      z.object({key:holdKey,action:z.literal('reset')}).strict(),
      z.object({key:holdKey,action:z.literal('clear')}).strict()]).parse(request.body);
    return engine.hold(grant.accountId,body.key,body);
  });
  // Keep: a movie or show by the library's Keep, so no run deletes it.
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
