import { defineModule } from './module.js';
import { indexersMigrations } from './migrations/indexers.js';
import { every, errorDetail } from '../lib/every.js';
import { z } from 'zod';
import { viewer } from './access.js';
import { Indexers, indexerInput, indexerNames, type FeedListener, type MovieQuery, type Release } from '../services/indexers.js';

const RSS_MINUTES = 15;

// The indexers (docs/ARR-REPLACEMENT.md, "Modules"): NZBGeek in phase 1, IPTorrents in phase 3. Admin › Downloads ›
// Indexers reads, saves and tests them through /api/v1/admin/indexers. The new-release feed is read every 15 minutes and
// shows in Admin › Schedule.
export const indexersModule = defineModule({
  name: 'indexers',
  access: 'admin',
  migrations: indexersMigrations,
  setup(routes, { db, vault, jobs, log }, deps: { transport?: typeof fetch } | undefined) {
    const indexers = new Indexers(db, vault, { ...(deps?.transport ? { transport: deps.transport } : {}), log: (message, detail) => log.warn(message, detail) });
    const pollNow = () => jobs.track('indexers.rss', () => indexers.poll());
    jobs.add({ id: 'indexers.rss', label: 'Read new releases', area: 'Indexers', section: 'downloads',
      schedule: () => ({ enabled: indexers.anyEnabled(), schedule: { kind: 'every', minutes: RSS_MINUTES } }),
      status: () => jobs.tracked('indexers.rss'), run: pollNow });
    const name = z.object({ name: z.enum(indexerNames) }).strict();
    routes.get('/api/v1/admin/indexers', async () => indexers.view());
    routes.put('/api/v1/admin/indexers/:name', async request => indexers.configure(viewer(request).grant.accountId, name.parse(request.params).name, request.body as z.input<typeof indexerInput>));
    routes.post('/api/v1/admin/indexers/:name/test', { config: { access: 'admin', rateLimit: { max: 10, timeWindow: 60000 } } },
      async request => indexers.test(name.parse(request.params).name));
    let timer: { stop(): void } | undefined;
    return {
      api: {
        search: (query: MovieQuery, signal?: AbortSignal) => indexers.search(query, signal),
        feeds: (listener: FeedListener) => indexers.feeds(listener),
        // The NZB for a release, which downloaders.send takes as a file.
        download: (release: Pick<Release, 'indexer' | 'link' | 'name'>, signal?: AbortSignal) => indexers.download(release, signal),
      },
      start() {
        timer = every(RSS_MINUTES * 60000, () => indexers.anyEnabled() ? pollNow() : undefined, e => log.warn('indexer feed failed', errorDetail(e)));
      },
      stop() { timer?.stop(); }
    };
  }
});
