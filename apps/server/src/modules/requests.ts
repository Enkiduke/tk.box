import { defineModule } from './module.js';
import { requestsMigrations } from './migrations/requests.js';
import { requireThat } from '../errors.js';
import { RequestStore } from '../persistence/requests-store.js';
import type { Fulfiller } from '../providers/fulfiller.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import { RequestAvailability } from '../services/request-availability.js';
import { Requests } from '../services/requests.js';
import { requestNotices } from '../services/request-notices.js';
import { registerRequests } from '../requests-api.js';
import { every, errorDetail } from '../lib/every.js';
import { z } from 'zod';
import { viewer } from './access.js';
import type { RequestsSite } from '../services/requests-site.js';
import type { RequestsSiteStatus } from '../../../../packages/contracts/src/index.js';

type Deps = {
  // TMDB names the title and gives a show's seasons and TVDB id.
  titles: Pick<TmdbTitles, 'get'>;
  // tk.box's own library (docs/ARR-REPLACEMENT.md), which takes every request.
  library: { fulfiller: Fulfiller };
  // The Requests site's listener (app.ts), started from its saved settings and moved when they change.
  site?: RequestsSite;
};
const siteInput = z.object({ expectedRevision: z.number().int().nonnegative(), port: z.number().int().nullable(), publicUrl: z.string().trim().max(300).nullable() }).strict();

const SWEEP_MS = 60000, REBUILD_MS = 6 * 3600000;

// tk.box's own requests (docs/REQUESTS.md). Sends movies and shows to tk.box's library, follows them on Plex and the
// library's grabs, and gives Explore its labels (`requests.labels()`). Each change is `requests.changed` on
// the bus. Plex is read with the owner's grant.
export const requestsModule = defineModule({
  name: 'requests',
  portal: true,
  migrations: requestsMigrations,
  setup(routes, { config, db, plex, bus, background, jobs, log }, { titles, site, library }: Deps) {
    const store = new RequestStore(db), fulfiller = library.fulfiller;
    const availability = new RequestAvailability(async () => {
      const grant = await background.grant();
      if (!grant) throw new Error('No Plex admin token in Admin › Connections');
      return plex.availability(grant);
    }, (message, detail) => log.warn(message, detail));
    const requests = new Requests(store, fulfiller, availability, titles, (message, detail) => log.info(message, detail));
    // Each change also tells the bell: the requester how it went, the admins of new and failed requests.
    requests.changed = change => {
      bus.emit('requests.changed', change);
      for (const notice of requestNotices(change, store.get(change.id))) {
        if (notice.post) bus.emit('notification.post', notice.post);
        if (notice.resolve) bus.emit('notification.resolve', notice.resolve);
      }
    };
    bus.on('plex.library.changed', () => availability.soon());
    // tk.box's library imported a file (Plex has been told to scan), or Clean Up removed one of its movies.
    // A grab moved on (sent, downloading, imported, failed): the next sweep reads it at once, not up to a minute later.
    let grabSweep: NodeJS.Timeout | undefined;
    bus.on('library.grab.changed', () => {
      if (grabSweep) return;
      grabSweep = setTimeout(() => { grabSweep = undefined; void requests.sweep().catch(e => log.warn('request sweep failed', errorDetail(e))); }, 2000);
      grabSweep.unref();
    });
    bus.on('library.file.imported', () => availability.soon(10000));
    bus.on('library.title.removed', ({ kind, tmdbId, by }) => { if (by === 'cleanup') requests.removedByCleanup([{ kind, tmdb: tmdbId }]); });
    bus.on('library.edited', ({ by }) => { if (by === 'cleanup') availability.soon(5000); });
    registerRequests(routes, store, requests, fulfiller);
    // Admin › Requests › Requests site. A change applies at once; a port that's taken is refused and nothing is saved.
    let siteError: string | undefined;
    const siteStatus = (): RequestsSiteStatus => ({ ...store.site(), publicAddress: !!config.PUBLIC_BASE_URL, appPort: config.APP_PORT,
      running: site?.port ?? null, ...(siteError ? { error: siteError } : {}) });
    routes.get('/api/v1/admin/requests/site', { config: { access: 'admin' } }, async () => siteStatus());
    routes.put('/api/v1/admin/requests/site', { config: { access: 'admin' } }, async request => {
      requireThat(site, 'SITE_UNAVAILABLE', 'The Requests site isn’t available here.', 409);
      const { expectedRevision, port, publicUrl } = siteInput.parse(request.body), value = { port, publicUrl: publicUrl || null };
      requireThat(store.site().revision === expectedRevision, 'REVISION_CONFLICT', 'Requests site settings changed. Reload and retry.', 409);
      await site.apply(value); siteError = undefined;
      store.updateSite(viewer(request).grant.accountId, expectedRevision, value);
      log.info('requests site changed', { port: site.port ?? null });
      return siteStatus();
    });
    const rebuildNow = () => jobs.track('requests.availability', () => availability.rebuild());
    jobs.add({ id: 'requests.availability', label: 'Check Plex for requested titles', area: 'Requests', section: 'requests',
      schedule: () => ({ enabled: true, schedule: { kind: 'every', minutes: REBUILD_MS / 60000 } }), status: () => jobs.tracked('requests.availability'), run: rebuildNow });
    let sweep: { stop(): void } | undefined, rebuild: { stop(): void } | undefined;
    return {
      api: { requests, store },
      async start() {
        // A saved site that can't start (its port taken) leaves tk.box running and says why in Admin › Requests.
        const saved = store.site();
        if (site && saved.port !== null) await site.apply(saved).catch(e => { siteError = (e as Error).message; log.warn('requests site did not start', errorDetail(e)); });
        void rebuildNow().catch(e => log.warn('request availability failed', errorDetail(e)));
        sweep = every(SWEEP_MS, () => requests.sweep(), e => log.warn('request sweep failed', errorDetail(e)));
        rebuild = every(REBUILD_MS, rebuildNow, e => log.warn('request availability failed', errorDetail(e)));
      },
      stop() { sweep?.stop(); rebuild?.stop(); clearTimeout(grabSweep); availability.close(); }
    };
  }
});
