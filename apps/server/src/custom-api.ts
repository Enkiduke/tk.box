import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PlexAdapter, PlexGrant } from './providers/plex.js';
import { CustomChannelStore, customCreate, customEdit, customOrder, draftAdd, draftOrder, draftEntries, draftRevision } from './persistence/custom-channels.js';
import { arrangeInput } from './services/arrange.js';
import type { EpisodeSync } from './services/episode-sync.js';

type Access = (req: FastifyRequest) => Promise<{ grant: PlexGrant }>;
// Channel Manager: administrator-only. Plex is read with the administrator's own grant; nothing is written to Plex.
export function registerCustomChannels(app: FastifyInstance, store: CustomChannelStore, plex: PlexAdapter, admin: Access, sync: EpisodeSync) {
  const id = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
  const base = '/api/v1/admin/custom-channels';
  app.get(base, async req => { await admin(req); return { channels: store.list() }; });
  app.post(base, async req => { const { grant } = await admin(req); return store.create(grant.accountId, customCreate.parse(req.body)); });
  app.put(`${base}/order`, async req => { const { grant } = await admin(req); return { channels: store.reorder(grant.accountId, customOrder.parse(req.body)) }; });
  app.get(`${base}/:id`, async req => { await admin(req); return store.detail(id(req.params)); });
  app.patch(`${base}/:id`, async req => { const { grant } = await admin(req); return store.edit(grant.accountId, id(req.params), customEdit.parse(req.body)); });
  app.delete(`${base}/:id`, async req => { const { grant } = await admin(req); store.remove(grant.accountId, id(req.params), draftRevision.parse(req.body).expectedRevision); return { status: 'deleted' }; });
  app.post(`${base}/:id/draft/add`, { config: { rateLimit: { max: 30, timeWindow: 60000 } } }, async req => {
    const { grant } = await admin(req), channel = id(req.params), input = draftAdd.parse(req.body);
    // Read every selection before touching the draft; the store then rechecks the revision in one transaction.
    const selections = [];
    for (const item of [...new Set(input.ids)]) selections.push(await plex.channelMedia(grant, item));
    return store.addItems(grant.accountId, channel, input, selections);
  });
  app.put(`${base}/:id/draft/order`, async req => { const { grant } = await admin(req); return store.setOrder(grant.accountId, id(req.params), draftOrder.parse(req.body)); });
  app.post(`${base}/:id/draft/duplicate`, async req => { const { grant } = await admin(req); return store.duplicate(grant.accountId, id(req.params), draftEntries.parse(req.body)); });
  app.post(`${base}/:id/draft/arrange`, async req => {
    const { grant } = await admin(req), input = z.object({ expectedRevision: z.number().int().nonnegative(), arrange: arrangeInput }).strict().parse(req.body);
    return store.arrange(grant.accountId, id(req.params), input.expectedRevision, input.arrange);
  });
  app.post(`${base}/:id/draft/discard`, async req => { const { grant } = await admin(req); return store.discard(grant.accountId, id(req.params), draftRevision.parse(req.body)); });
  // Automatically add new episodes, per show or season selection. Turning it on checks Plex right away.
  app.put(`${base}/:id/sources/:sourceId`, async req => {
    const { grant } = await admin(req), params = z.object({ id: z.string().uuid(), sourceId: z.string().uuid() }).parse(req.params), input = z.object({ autoAdd: z.boolean() }).strict().parse(req.body);
    store.setAutoAdd(grant.accountId, params.id, params.sourceId, input.autoAdd);
    if (input.autoAdd) await sync.source({ id: params.sourceId, plexId: store.detail(params.id).sources.find(s => s.id === params.sourceId)!.plexId }, grant, grant.accountId).catch(() => {});
    return store.detail(params.id);
  });
  app.post(`${base}/:id/sync`, { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async req => {
    const { grant } = await admin(req), channel = id(req.params); z.object({}).strict().parse(req.body);
    return { ...await sync.channel(channel, grant, grant.accountId), channel: store.detail(channel) };
  });
  app.get(`${base}/:id/preview`, async req => { await admin(req); return store.preview(id(req.params)); });
  app.post(`${base}/:id/publish`, async req => {
    const { grant } = await admin(req), input = z.object({ expectedRevision: z.number().int().nonnegative(), expectedPublication: z.number().int().nonnegative() }).strict().parse(req.body);
    return store.publish(grant.accountId, id(req.params), input);
  });
}
