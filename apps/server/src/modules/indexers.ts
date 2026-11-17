import { defineModule } from './module.js';
import { preview } from '../errors.js';
import { indexersMigrations } from './migrations/indexers.js';
import { every, errorDetail } from '../lib/every.js';
import { z } from 'zod';
import { connectionActor } from './access.js';
import { Indexers, indexerInput, indexerNames, type FeedListener, type MovieQuery, type Release, type SearchOptions } from '../services/indexers.js';

// The feed's interval until the library gives its setting (Admin › Downloads › Settings, rssMinutes).
const RSS_MINUTES = 15, TICK_MS = 60000;

// The indexers (docs/ARR-REPLACEMENT.md, "Modules"): NZBGeek in phase 1, IPTorrents in phase 3. Admin › Connections ›
// Indexers & downloaders reads, saves and tests them through /api/v1/admin/indexers. An expired IPTorrents cookie is an
// admin alert in the bell. The new-release feed is read every rssMinutes (15 by default) and shows in Admin ›
// Schedule.
export const indexersModule = defineModule({
  name: 'indexers',
  access: 'connectionAdmin',
  migrations: indexersMigrations,
  setup(routes, { db, vault, jobs, bus, log }, deps: { transport?: typeof fetch } | undefined) {
    const indexers = new Indexers(db, vault, { ...(deps?.transport ? { transport: deps.transport } : {}), log: (message, detail) => log.warn(message, detail),
      notify: {
        post: (key, title, detail) => bus.emit('notification.post', { to: 'admins', kind: 'indexers', tone: 'error', title, detail, key, link: '#admin?section=connections' }),
        resolve: key => bus.emit('notification.resolve', { to: 'admins', key }),
      } });
    let minutes = () => RSS_MINUTES, lastPoll = 0;
    const pollNow = () => { lastPoll = Date.now(); return jobs.track('indexers.rss', () => indexers.poll()); };
    jobs.add({ id: 'indexers.rss', label: 'Read new releases', area: 'Indexers', section: 'queue',
      schedule: () => ({ enabled: indexers.anyEnabled(), schedule: { kind: 'every', minutes: minutes() } }),
      status: () => jobs.tracked('indexers.rss'), run: pollNow });
    const name = z.object({ name: z.enum(indexerNames) }).strict();
    routes.get('/api/v1/admin/indexers', async () => indexers.view());
    routes.put('/api/v1/admin/indexers/:name', async request => indexers.configure(connectionActor(request), name.parse(request.params).name, request.body as z.input<typeof indexerInput>));
    routes.post('/api/v1/admin/indexers/:name/test', { config: { access: 'connectionAdmin', rateLimit: { max: 10, timeWindow: 60000 } } },
      async request => indexers.test(name.parse(request.params).name));
    let timer: { stop(): void } | undefined;
    return {
      api: {
        search: (query: MovieQuery, signal?: AbortSignal, options?: SearchOptions) => indexers.search(query, signal, options),
        searches: (protocol: 'usenet' | 'torrent') => indexers.searches(protocol),
        feeds: (listener: FeedListener) => indexers.feeds(listener),
        // The NZB or .torrent for a release, which downloaders.send takes as a file.
        download: (release: Pick<Release, 'indexer' | 'link' | 'name'>, signal?: AbortSignal) => indexers.download(release, signal),
        // The library's rssMinutes, read at each tick, so a change applies without a restart.
        feedEvery: (get: () => number) => { minutes = get; },
      },
      start() {
        if (preview()) return;
        timer = every(TICK_MS, () => indexers.anyEnabled() && Date.now() - lastPoll >= minutes() * 60000 - TICK_MS / 2 ? pollNow() : undefined,
          e => log.warn('indexer feed failed', errorDetail(e)));
      },
      stop() { timer?.stop(); }
    };
  }
});
