import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PlexAdapter, PlexGrant } from './providers/plex.js';
import { CustomChannelStore, customCreate, customEdit, customOrder, draftAdd, draftOrder, draftEntries, draftRevision } from './persistence/custom-channels.js';
import { arrangeInput } from './services/arrange.js';

type Access = (req: FastifyRequest) => Promise<{ grant: PlexGrant }>;
// Channel Manager: administrator-only. Plex is read with the administrator's own grant; nothing is written to Plex.
export function registerCustomChannels(app: FastifyInstance, store: CustomChannelStore, plex: PlexAdapter, admin: Access) {
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
  app.get(`${base}/:id/preview`, async req => { await admin(req); return store.preview(id(req.params)); });
  app.post(`${base}/:id/publish`, async req => {
    const { grant } = await admin(req), input = z.object({ expectedRevision: z.number().int().nonnegative(), expectedPublication: z.number().int().nonnegative() }).strict().parse(req.body);
    return store.publish(grant.accountId, id(req.params), input);
  });
}
