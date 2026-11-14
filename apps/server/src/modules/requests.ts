import { defineModule } from './module.js';
import { requestsMigrations } from './migrations/requests.js';
import { RequestStore } from '../persistence/requests-store.js';
import { ArrFulfiller } from '../providers/arr-fulfiller.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import { RequestAvailability } from '../services/request-availability.js';
import { Requests } from '../services/requests.js';
import { registerRequests } from '../requests-api.js';
import { every, errorDetail } from '../lib/every.js';

type Deps = {
  arr: { connection: (name: 'radarr' | 'sonarr') => ArrService };
  // TMDB names the title and gives a show's seasons and TVDB id.
  titles: Pick<TmdbTitles, 'get'>;
  arrTransport?: typeof fetch;
};

const SWEEP_MS = 60000, REBUILD_MS = 6 * 3600000;

// tk.box's own requests, in place of Seerr (docs/REQUESTS.md). Sends them to Radarr and Sonarr, follows them on Plex
// and Radarr/Sonarr's queue, and gives Explore its labels (`requests.labels()`). Each change is `requests.changed` on
// the bus. Plex is read with the owner's grant.
export const requestsModule = defineModule({
  name: 'requests',
  migrations: requestsMigrations,
  setup(routes, { db, plex, bus, background, log }, { arr, titles, arrTransport }: Deps) {
    const store = new RequestStore(db), fulfiller = new ArrFulfiller(arr.connection, arrTransport);
    const availability = new RequestAvailability(async () => {
      const grant = await background.grant();
      if (!grant) throw new Error('No Plex admin token in Admin › Connections');
      return plex.availability(grant);
    }, (message, detail) => log.warn(message, detail));
    const requests = new Requests(store, fulfiller, availability, titles, arr.connection, (message, detail) => log.info(message, detail));
    requests.changed = change => bus.emit('requests.changed', change);
    bus.on('plex.library.changed', () => availability.soon());
    bus.on('library.edited', ({ by }) => { if (by === 'cleanup') availability.soon(5000); });
    registerRequests(routes, store, requests, fulfiller);
    let sweep: { stop(): void } | undefined, rebuild: { stop(): void } | undefined;
    return {
      api: { requests, store },
      start() {
        void availability.rebuild();
        sweep = every(SWEEP_MS, () => requests.sweep(), e => log.warn('request sweep failed', errorDetail(e)));
        rebuild = every(REBUILD_MS, () => availability.rebuild(), e => log.warn('request availability failed', errorDetail(e)));
      },
      stop() { sweep?.stop(); rebuild?.stop(); availability.close(); }
    };
  }
});
