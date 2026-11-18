import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MyRequests, RequestOptions, RequestPage, RequestSettings } from '../../../packages/contracts/src/index.js';
import { authorize, viewer } from './modules/access.js';
import { requireThat } from './errors.js';
import { requestSettings, requestStatuses, type RequestStore } from './persistence/requests-store.js';
import { requestItem, type Requests, type RequestsLibrary } from './services/requests.js';

const kind = z.enum(['movie', 'show']);
const id = z.object({ id: z.coerce.number().int().positive() }).strict();
// `keep` marks the title Favorite in the library, so no Clean Up run deletes it; `earlyCopies` turns on a movie's Early copies.
const override = { profileId: z.number().int().positive().optional(), rootFolder: z.string().trim().min(1).max(300).optional(), tags: z.array(z.number().int().nonnegative()).max(50).optional(),
  keep: z.boolean().optional(), earlyCopies: z.boolean().optional() };

// Requests: any viewer may request, see everyone's (not removed ones) and cancel their own; Admin › Requests lists, removes and retries every one,
// and sets their defaults. Only administrators may pick a profile (4K is a profile), folder or tags.
export function registerRequests(app: FastifyInstance, store: RequestStore, requests: Requests, library: Pick<RequestsLibrary, 'profiles'>) {
  app.post('/api/v1/requests', { config: { access: 'viewer', rateLimit: { max: 20, timeWindow: 60000 } } }, async request => {
    const input = z.object({ kind, tmdb: z.number().int().positive(), seasons: z.array(z.number().int().positive()).min(1).max(100).optional(), ...override }).strict().parse(request.body);
    const { kind: media, tmdb, seasons, profileId, rootFolder, tags, keep } = input, earlyCopies = media === 'movie' && !!input.earlyCopies;
    const extras = profileId !== undefined || rootFolder !== undefined || tags !== undefined || !!keep || earlyCopies;
    const { grant } = extras ? await authorize(request, 'admin') : viewer(request);
    const row = await requests.create({ accountId: grant.accountId, name: grant.name ?? 'Plex user' }, { kind: media, tmdb, ...(seasons ? { seasons } : {}) },
      extras ? { ...(profileId !== undefined ? { profileId } : {}), ...(rootFolder !== undefined ? { rootFolder } : {}), ...(tags !== undefined ? { tags } : {}),
        ...(keep ? { keep: true } : {}), ...(earlyCopies ? { earlyCopies: true } : {}) } : undefined);
    return requestItem(row);
  });
  app.get('/api/v1/requests/mine', { config: { access: 'viewer' } }, async request => {
    const { grant } = viewer(request);
    return { items: store.mine(grant.accountId).map(requestItem), unseen: store.unseen(grant.accountId) } satisfies MyRequests;
  });
  // The Requests page: everyone's requests but removed ones, newest first, each with who asked.
  app.get('/api/v1/requests', { config: { access: 'viewer' } }, async request => {
    const { grant } = viewer(request);
    const q = z.object({ status: z.enum(requestStatuses).optional(), kind: kind.optional(), q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).default(1) }).strict().parse(request.query);
    const { items, ...page } = store.list({ ...q, active: true, size: 30 });
    return { ...page, items: items.map(row => ({ ...requestItem(row), ...(row.accountId === grant.accountId ? { mine: true } : {}) })) } satisfies RequestPage;
  });
  app.get('/api/v1/requests/:id/artwork', { config: { access: 'viewer', rateLimit: { max: 180, timeWindow: 60000 } } },
    async request => requests.artwork(id.parse(request.params).id));
  app.get('/api/v1/requests/:id/timing', { config: { access: 'viewer', rateLimit: { max: 180, timeWindow: 60000 } } },
    async request => requests.timing(id.parse(request.params).id));
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
  app.get('/api/v1/admin/requests/:id/artwork', { config: { access: 'admin', rateLimit: { max: 180, timeWindow: 60000 } } },
    async request => requests.artwork(id.parse(request.params).id));
  app.delete('/api/v1/admin/requests/:id', { config: { access: 'admin' } }, async request => {
    const { id: rowId } = id.parse(request.params);
    return requestItem(await requests.cancel(rowId, { accountId: viewer(request).grant.accountId, admin: true }));
  });
  app.post('/api/v1/admin/requests/:id/retry', { config: { access: 'admin' } }, async request => requestItem(await requests.retry(id.parse(request.params).id)));
  // Also on the Requests site, for its administrators' Request with options….
  app.get('/api/v1/admin/requests/options', { config: { access: 'admin', portal: 'admin' } }, async request => {
    const { kind: media } = z.object({ kind }).strict().parse(request.query), { profileId } = store.settings()[media];
    // The library's own profiles, the default first; its root is its own and Favorite its own flag, so no folders or tags to pick.
    const options = { connected: true, tkbox: true, profiles: library.profiles(), rootFolders: [], tags: [] };
    // A profile saved that the library doesn't have means nothing: its default profile (listed first) stands in.
    const defaults = { profileId: options.profiles.some(p => p.id === profileId) ? profileId : options.profiles[0]?.id ?? 0, rootFolder: '', tags: [] };
    return { ...options, defaults, keepTag: 'Keep' } satisfies RequestOptions;
  });
  app.get('/api/v1/admin/requests/settings', { config: { access: 'admin' } }, async () => store.settings() satisfies RequestSettings);
  app.put('/api/v1/admin/requests/settings', { config: { access: 'admin' } }, async request => {
    const { expectedRevision, ...value } = requestSettings.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(request.body);
    return store.updateSettings(viewer(request).grant.accountId, expectedRevision, value) satisfies RequestSettings;
  });
}
