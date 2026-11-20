import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { historySorts, historySources } from '../../../packages/contracts/src/index.js';
import type { HistoryReports } from './persistence/history-reports.js';
import { TtlCache } from './lib/ttl-cache.js';

const periods = z.enum(['7', '30', '90', '365', 'all']);
const rangeQuery = z.object({ days: periods.default('30'), source: z.enum(historySources).optional(),
  user: z.string().regex(/^\d{1,40}$/).optional() });
// `cursor` is where the next page starts, as the last page's `next` gave it.
const sessionQuery = rangeQuery.extend({ cursor: z.coerce.number().int().min(0).max(1000000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100), q: z.string().trim().max(80).optional(),
  media: z.coerce.number().int().positive().optional(), show: z.string().regex(/^\d{1,40}$/).optional(), server: z.string().max(100).optional(),
  // A Plex rating key: the movie itself, or every episode of the show (a library title's History tab).
  key: z.string().regex(/^\d{1,40}$/).optional(),
  airing: z.string().max(1800).optional(), kind: z.enum(['movie', 'episode', 'channel']).optional(), sort: z.enum(historySorts).default('started'), dir: z.enum(['asc', 'desc']).default('desc') });
const mediaQuery = rangeQuery.extend({ kind: z.enum(['all', 'movies', 'shows', 'episodes', 'channels', 'programs']).default('all') });
export type HistoryRange = z.infer<typeof rangeQuery>;
export type HistorySessionFilter = z.infer<typeof sessionQuery>;
export type HistoryMediaFilter = z.infer<typeof mediaQuery>;

// Admin › History. Every route is admin-only, checked before the cache is read.
export function registerHistory(app: FastifyInstance, reports: HistoryReports) {
  const asAdmin = { config: { access: 'admin' as const } };
  const cache = new TtlCache<unknown>(32);
  const cached = <T>(key: string, load: () => T): T => cache.remember(key, 30000, load) as T;
  app.get('/api/v1/admin/history/summary', asAdmin, async req => {
    const filter = rangeQuery.parse(req.query);
    return cached(`summary:${JSON.stringify(filter)}`, () => reports.summary(filter));
  });
  app.get('/api/v1/admin/history/users', asAdmin, async req => {
    const filter = rangeQuery.parse(req.query);
    return cached(`users:${JSON.stringify(filter)}`, () => reports.users(filter));
  });
  app.get('/api/v1/admin/history/media', asAdmin, async req => {
    const filter = mediaQuery.parse(req.query);
    return cached(`media:${JSON.stringify(filter)}`, () => reports.media(filter));
  });
  app.get('/api/v1/admin/history/users/:id', asAdmin, async req => {
    const { id } = z.object({ id: z.string().regex(/^\d{1,40}$/) }).parse(req.params), filter = rangeQuery.parse(req.query);
    return cached(`user:${id}:${JSON.stringify(filter)}`, () => reports.user(id, filter));
  });
  app.get('/api/v1/admin/history/graphs', asAdmin, async req => {
    const filter = rangeQuery.parse(req.query);
    return cached(`graphs:${JSON.stringify(filter)}`, () => reports.graphs(filter));
  });
  app.delete('/api/v1/admin/history/sessions/:id', asAdmin, async (req, reply) => {
    reports.remove(z.object({ id: z.string().uuid() }).parse(req.params).id);
    cache.clear();
    return reply.code(204).send();
  });
  app.get('/api/v1/admin/history/sessions', asAdmin, async req => reports.sessions(sessionQuery.parse(req.query)));
  app.get('/api/v1/admin/history/sessions/:id', asAdmin, async req => reports.session(z.object({ id: z.string().uuid() }).parse(req.params).id));
}
