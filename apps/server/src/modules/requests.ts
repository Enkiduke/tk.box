import { defineModule } from './module.js';
import type { EventBus } from './bus.js';
import { requestsMigrations } from './migrations/requests.js';
import { requireThat } from '../errors.js';
import { RequestStore } from '../persistence/requests-store.js';
import type { PlexIndex } from '../services/plex-index.js';
import { Requests, removedBy, type RequestsLibrary } from '../services/requests.js';
import type { TitleRequest } from '../../../../packages/contracts/src/downloads.js';
import { requestNotices } from '../services/request-notices.js';
import { registerRequests } from '../requests-api.js';
import { every, errorDetail } from '../lib/every.js';
import { z } from 'zod';
import { viewer } from './access.js';
import type { RequestsSite } from '../services/requests-site.js';
import type { RequestReads } from '../library-api.js';
import type { RequestsSiteStatus } from '../../../../packages/contracts/src/index.js';

type Deps = {
  // tk.box's own library (docs/ARR-REPLACEMENT.md), which takes every request and says how it is getting on.
  // It reads who asked for each title from here (`readRequests`, for Admin › Manage).
  library: RequestsLibrary & { readRequests?(reads: RequestReads): void };
  // What Plex holds (the plex-index module), shared with the library.
  plexIndex: PlexIndex;
  // The Requests site's listener (app.ts), started from its saved settings and moved when they change.
  site?: RequestsSite;
};
// A grab moved on (sent, downloading, imported, failed), or the title did (added, followed or not, files, forgotten):
// its requests move on.
export function followLibrary(bus: Pick<EventBus, 'on'>, requests: Requests) {
  bus.on('library.grab.changed', ({ titleId }) => requests.grabChanged(titleId));
  bus.on('library.title.changed', ({ change, kind, tmdbId, by }) => {
    if (change === 'removed') { if (by === 'cleanup') requests.removedByCleanup([{ kind, tmdb: tmdbId }]); else requests.removedFromLibrary([{ kind, tmdb: tmdbId }]); }
    requests.titleChanged(kind, tmdbId);
  });
}
const siteInput = z.object({ expectedRevision: z.number().int().nonnegative(), port: z.number().int().nullable(), publicUrl: z.string().trim().max(300).nullable() }).strict();

// How often queued requests are tried again.
const SWEEP_MS = 60000;

// tk.box's own requests (docs/REQUESTS.md). Sends movies and shows to tk.box's library, and moves each on from what
// the library and Plex (the shared plex-index) say, as they change: `library.title.changed`, `library.grab.changed` and
// the index's rebuilds. Gives Explore its labels (`requests.labels()`). Each change is `requests.changed` on the bus.
export const requestsModule = defineModule({
  name: 'requests',
  portal: true,
  migrations: requestsMigrations,
  // TMDB (ctx.tmdb) names the title and gives a show's seasons and TVDB id.
  setup(routes, { config, db, bus, log, tmdb: titles }, { site, library, plexIndex }: Deps) {
    const store = new RequestStore(db);
    const requests = new Requests(store, library, plexIndex, titles, (message, detail) => log.info(message, detail));
    // Each change also tells the bell: the requester how it went, the admins of new and failed requests.
    requests.changed = change => {
      bus.emit('requests.changed', change);
      for (const notice of requestNotices(change, store.get(change.id))) {
        if (notice.post) bus.emit('notification.post', notice.post);
        if (notice.resolve) bus.emit('notification.resolve', notice.resolve);
      }
    };
    // Who asked for each title, and one title's requests newest first: Admin › Manage's Source column and each title's
    // Requests tab, read by the library (it mounts first, so it is handed these here).
    const reads: RequestReads = {
      requesters: kind => store.requesters(kind),
      titleHistory: (kind, tmdbId): TitleRequest[] => store.history(kind, tmdbId).map(r => ({ id: r.id, name: r.accountName, at: r.createdAt,
        status: r.status, statusAt: r.statusAt, ...(r.seasons.length ? { seasons: r.seasons.map(s => s.season) } : {}), ...(r.availableAt ? { availableAt: r.availableAt } : {}),
        ...(r.removedAt ? { removedAt: r.removedAt } : {}), ...(r.removedBy ? { removedBy: removedBy(r) } : {}), ...(r.lastError && r.status === 'failed' ? { error: r.lastError } : {}) })),
    };
    library.readRequests?.(reads);
    followLibrary(bus, requests);
    registerRequests(routes, store, requests, library);
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
    let sweep: { stop(): void } | undefined;
    return {
      api: {
        requests, ...reads,
      },
      async start() {
        // A saved site that can't start (its port taken) leaves tk.box running and says why in Admin › Requests.
        const saved = store.site();
        if (site && saved.port !== null) await site.apply(saved).catch(e => { siteError = (e as Error).message; log.warn('requests site did not start', errorDetail(e)); });
        // Rows that moved on while tk.box was off (Plex's first index moves them on too, when it comes later).
        requests.refresh();
        sweep = every(SWEEP_MS, () => requests.sweep(), e => log.warn('request sweep failed', errorDetail(e)));
      },
      stop() { sweep?.stop(); }
    };
  }
});
