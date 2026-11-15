import { defineModule } from './module.js';
import { libraryMigrations } from './migrations/library.js';
import { AppError } from '../errors.js';
import { every, errorDetail } from '../lib/every.js';
import { LibraryStore } from '../persistence/library-store.js';
import { Library, type DownloadersApi, type IndexersApi, type PlexHolds } from '../services/library.js';
import { MovieImporter, ffprobe } from '../services/library-import.js';
import { RequestAvailability } from '../services/request-availability.js';
import { LibraryFulfiller } from '../providers/library-fulfiller.js';
import { registerLibraryAdmin } from '../library-api.js';
import type { QueueApi } from '../services/queue.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';

const SWEEP_MINUTES = 30, CHECK_MS = 30000, SEEDING_MINUTES = 60;

type Deps = { queue: QueueApi; indexers: IndexersApi; downloaders: DownloadersApi; titles: Pick<TmdbTitles, 'get'> };

// tk.box's own library (docs/ARR-REPLACEMENT.md, phase 1b): movies, from adding one to importing it. Its work runs on
// the queue (search, send, unpack, import, refresh-title, plex-scan). The wanted sweep runs every 30 minutes, the
// download check (SABnzbd and qBittorrent) every 30 s while grabs are under way, and the seeding check hourly, all in
// Admin › Schedule with Run now. Admin › Downloads reads and changes it
// through /api/v1/admin/library/* (library-api.ts). Requests use LibraryFulfiller for movies.
export const libraryModule = defineModule({
  name: 'library',
  access: 'admin',
  migrations: libraryMigrations,
  setup(routes, { config, db, plex, bus, background, jobs, log }, { queue, indexers, downloaders, titles }: Deps) {
    const store = new LibraryStore(db);
    // What Plex holds, read with the owner's grant, as requests read it.
    const availability = new RequestAvailability(async () => {
      const grant = await background.grant();
      if (!grant) throw new Error('No Plex admin token in Admin › Connections');
      return plex.availability(grant);
    }, (message, detail) => log.warn(message, detail));
    const holds: PlexHolds = {
      has: tmdbId => availability.movie(tmdbId) !== undefined,
      ready: async () => { if (!availability.ready()) await availability.rebuild(); return availability.ready(); },
    };
    const warn = (message: string, detail?: Record<string, unknown>) => log.warn(message, detail);
    const importer = new MovieImporter(store, ffprobe(config.FFPROBE_PATH), undefined, warn);
    const library = new Library({
      store, queue, indexers, downloaders, titles, plex: holds, importer,
      scan: async folder => {
        const grant = await background.grant();
        if (!grant) throw new AppError('NO_PLEX_TOKEN', 'No Plex admin token in Admin › Connections.', 409);
        return plex.scanFolder(grant.serverToken, folder);
      },
      emit: (event, payload) => bus.emit(event, payload),
      log: (message, detail) => log.info(message, detail),
    });
    library.register();
    registerLibraryAdmin(routes, { store, library, queue });
    bus.on('plex.library.changed', () => availability.soon());
    // Collections' seasonal downloads (docs/ARR-REPLACEMENT.md, phase 1): added as a request would be, unless the
    // library already has the movie; and those the collections let go deleted with their files, if the library
    // added them for collections and nobody has requested or kept them since.
    bus.on('collections.acquire', ({ tmdbIds, removeIds }) => {
      void (async () => {
        for (const tmdbId of removeIds) {
          const title = store.titleByTmdb('movie', tmdbId);
          if (title) await library.removeForCollections(title.id).catch(e => log.warn('library: a collection’s movie could not be removed', { tmdbId, ...errorDetail(e) }));
        }
        for (const tmdbId of tmdbIds) {
          if (store.titleByTmdb('movie', tmdbId)) continue;
          await library.add({ tmdbId, by: 'collections', search: true }).catch(e => log.warn('library: a collection’s movie could not be added', { tmdbId, ...errorDetail(e) }));
        }
      })();
    });

    const sweepNow = () => jobs.track('library.wanted', () => library.sweep());
    const checkNow = () => jobs.track('library.downloads', () => library.checkDownloads());
    const seedNow = () => jobs.track('library.seeding', () => library.seedingCheck());
    jobs.add(
      { id: 'library.wanted', label: 'Search for wanted movies', area: 'Library', section: 'downloads',
        schedule: () => ({ enabled: true, schedule: { kind: 'every', minutes: SWEEP_MINUTES } }), status: () => jobs.tracked('library.wanted'), run: sweepNow },
      { id: 'library.downloads', label: 'Check downloads', area: 'Library', section: 'downloads',
        schedule: () => ({ enabled: store.hasOpenGrabs(), schedule: { kind: 'every', minutes: CHECK_MS / 60000 } }), status: () => jobs.tracked('library.downloads'), run: checkNow },
      { id: 'library.seeding', label: 'Remove seeded torrents', area: 'Library', section: 'downloads',
        schedule: () => ({ enabled: true, schedule: { kind: 'every', minutes: SEEDING_MINUTES } }), status: () => jobs.tracked('library.seeding'), run: seedNow });

    const fulfiller = new LibraryFulfiller(library, store);
    let timers: { stop(): void }[] = [];
    return {
      api: {
        fulfiller, store,
        // Collections' seasonal downloads add through here, as requests do.
        add: library.add.bind(library),
        keep: library.keep.bind(library),
        forget: library.forget.bind(library),
      },
      start() {
        void availability.rebuild();
        void importer.cleanLeftovers().catch(e => log.warn('library leftover cleanup failed', errorDetail(e)));
        timers = [
          every(SWEEP_MINUTES * 60000, sweepNow, e => log.warn('library sweep failed', errorDetail(e))),
          every(CHECK_MS, () => store.hasOpenGrabs() ? checkNow() : undefined, e => log.warn('library download check failed', errorDetail(e))),
          every(SEEDING_MINUTES * 60000, seedNow, e => log.warn('library seeding check failed', errorDetail(e))),
        ];
      },
      stop() { for (const t of timers) t.stop(); library.close(); availability.close(); }
    };
  }
});
