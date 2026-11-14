import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MyRequests, RequestOptions, RequestPage, RequestSettings } from '../../../packages/contracts/src/index.js';
import { authorize, viewer } from './modules/access.js';
import { requestSettings, requestStatuses, type RequestStore } from './persistence/requests-store.js';
import { requestItem, type Requests } from './services/requests.js';
import type { Fulfiller } from './providers/arr-fulfiller.js';
import type { TmdbTitles } from './providers/tmdb-titles.js';
import { importSeerr } from './services/seerr-import.js';

const kind = z.enum(['movie', 'show']);
const id = z.object({ id: z.coerce.number().int().positive() }).strict();
const override = { profileId: z.number().int().positive().optional(), rootFolder: z.string().trim().min(1).max(300).optional(), tags: z.array(z.number().int().nonnegative()).max(50).optional() };

// Requests: any viewer may request and see and cancel their own; Admin › Requests lists, removes and retries every one,
// and sets where requests go in Radarr and Sonarr. Only administrators may pick a profile (4K is a profile), folder or tags.
const origin = z.string().trim().max(300).url().refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, 'Use an http(s) address');

export function registerRequests(app: FastifyInstance, store: RequestStore, requests: Requests, fulfiller: Fulfiller, tmdb: Pick<TmdbTitles, 'get'>, seerrTransport?: typeof fetch) {
  app.post('/api/v1/requests', { config: { access: 'viewer', rateLimit: { max: 20, timeWindow: 60000 } } }, async request => {
    const input = z.object({ kind, tmdb: z.number().int().positive(), seasons: z.array(z.number().int().positive()).min(1).max(100).optional(), ...override }).strict().parse(request.body);
    const { kind: media, tmdb, seasons, profileId, rootFolder, tags } = input, extras = profileId !== undefined || rootFolder !== undefined || tags !== undefined;
    const { grant } = extras ? await authorize(request, 'admin') : viewer(request);
    const row = await requests.create({ accountId: grant.accountId, name: grant.name ?? 'Plex user' }, { kind: media, tmdb, ...(seasons ? { seasons } : {}) },
      extras ? { ...(profileId !== undefined ? { profileId } : {}), ...(rootFolder !== undefined ? { rootFolder } : {}), ...(tags !== undefined ? { tags } : {}) } : undefined);
    return requestItem(row);
  });
  app.get('/api/v1/requests/mine', { config: { access: 'viewer' } }, async request => {
    const { grant } = viewer(request);
    return { items: store.mine(grant.accountId).map(requestItem), unseen: store.unseen(grant.accountId) } satisfies MyRequests;
  });
  app.post('/api/v1/requests/mine/seen', { config: { access: 'viewer' } }, async request => {
    store.markSeen(viewer(request).grant.accountId); return { unseen: 0 };
  });
  app.delete('/api/v1/requests/:id', { config: { access: 'viewer' } }, async request => {
    const { id: rowId } = id.parse(request.params);
    return requestItem(await requests.cancel(rowId, { accountId: viewer(request).grant.accountId, admin: false }));
  });

  app.get('/api/v1/admin/requests', { config: { access: 'admin' } }, async request => {
    const q = z.object({ status: z.enum(requestStatuses).optional(), kind: kind.optional(), account: z.string().max(64).optional(), q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).default(1) }).strict().parse(request.query);
    const { items, ...page } = store.list({ ...q, size: 50 });
    return { ...page, items: items.map(requestItem) } satisfies RequestPage;
  });
  app.delete('/api/v1/admin/requests/:id', { config: { access: 'admin' } }, async request => {
    const { id: rowId } = id.parse(request.params);
    return requestItem(await requests.cancel(rowId, { accountId: viewer(request).grant.accountId, admin: true }));
  });
  app.post('/api/v1/admin/requests/:id/retry', { config: { access: 'admin' } }, async request => requestItem(await requests.retry(id.parse(request.params).id)));
  app.get('/api/v1/admin/requests/options', { config: { access: 'admin' } }, async request => {
    const { kind: media } = z.object({ kind }).strict().parse(request.query), { profileId, rootFolder, tags } = store.settings()[media];
    return { ...await fulfiller.options(media), defaults: { profileId, rootFolder, tags } } satisfies RequestOptions;
  });
  // Seerr's requests, copied once before Seerr goes. The address and key are not saved.
  app.post('/api/v1/admin/requests/import-seerr', { config: { access: 'admin', rateLimit: { max: 5, timeWindow: 60000 } } }, async request => {
    const { url, apiKey } = z.object({ url: origin, apiKey: z.string().trim().min(1).max(200).regex(/^[\w=+/-]+$/) }).strict().parse(request.body);
    const result = await importSeerr(store, tmdb, url, apiKey, seerrTransport);
    requests.imported();
    return result;
  });
  app.get('/api/v1/admin/requests/settings', { config: { access: 'admin' } }, async () => store.settings() satisfies RequestSettings);
  app.put('/api/v1/admin/requests/settings', { config: { access: 'admin' } }, async request => {
    const { expectedRevision, ...value } = requestSettings.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(request.body);
    return store.updateSettings(viewer(request).grant.accountId, expectedRevision, value) satisfies RequestSettings;
  });
}
