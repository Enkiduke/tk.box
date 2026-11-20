import { registerShowMatch } from '../show-match-api.js';
import { Tvdb } from '../providers/tvdb.js';
import { defineModule } from './module.js';
import { libraryMigrations } from './migrations/library.js';
import { AppError, preview } from '../errors.js';
import { every, errorDetail } from '../lib/every.js';
import { TtlCache } from '../lib/ttl-cache.js';
import { LibraryStore } from '../persistence/library-store.js';
import { Library, SWEEP_EVERY, type LibraryFiles, type DownloadersApi, type IndexersApi, type PlexHolds } from '../services/library.js';
import { LibraryImporter, ffprobe } from '../services/library-import.js';
import type { PlexIndex } from '../services/plex-index.js';
import { registerLibraryAdmin, type LibrarySources, type RequestReads } from '../library-api.js';
import type { QueueApi } from '../services/queue.js';
import { Tvmaze } from '../providers/tvmaze.js';
import { showAirings, type ShowAirings } from '../services/wanted.js';

const SWEEP_MINUTES = SWEEP_EVERY / 60000, CHECK_MS = 30000, SEEDING_MINUTES = 60, LIVE_SHARED_MS = 4000;

type Deps = { queue: QueueApi; indexers: IndexersApi & { feedEvery?: (minutes: () => number) => void }; downloaders: DownloadersApi;
  // Which collections downloaded each movie (Admin › Manage's Source column).
  artwork?: { collectionMovies(): Map<number, string[]>;
    // The status banners read the shows' air days from here, so they agree with when the library grabs.
    useAirings?(read: () => Record<string, ShowAirings>): void };
  // What Plex holds (the plex-index module), shared with requests.
  plexIndex: PlexIndex };

// tk.box's own library (docs/ARR-REPLACEMENT.md, phases 1b and 2): movies and shows, from adding one to importing it. Its work runs on
// the queue (search, send, unpack, import, refresh-title, plex-scan). The wanted sweep runs every 30 minutes, the
// download check (SABnzbd and qBittorrent) every 30 s while grabs are under way, and the seeding check hourly, all in
// Admin › Schedule with Run now. Admin › Downloads reads and changes it
// through /api/v1/admin/library/* (library-api.ts). Requests add, follow and let go of titles through its API.
export const libraryModule = defineModule({
  name: 'library',
  access: 'admin',
  migrations: libraryMigrations,
  setup(routes, { config, db, bus, plexOwner, serviceKeys, tmdb: titles, jobs, log }, { queue, indexers, downloaders, artwork, plexIndex }: Deps) {
    const store = new LibraryStore(db);
    const holds: PlexHolds = {
      has: tmdbId => plexIndex.movie(tmdbId) !== undefined,
      showSeasons: (tmdbId, tvdbId) => plexIndex.show(tmdbId, tvdbId)?.seasons,
      showEpisodes: (tmdbId, tvdbId) => plexIndex.show(tmdbId, tvdbId)?.episodes,
      ready: async () => { if (!plexIndex.ready()) await plexIndex.rebuild(); return plexIndex.ready(); },
    };
    const warn = (message: string, detail?: Record<string, unknown>) => log.warn(message, detail);
    const importer = new LibraryImporter(store, ffprobe(config.FFPROBE_PATH), undefined, warn);
    // Episodes' exact air times (Admin › Connections › TVmaze); the preview, frozen, keeps what it has.
    const tvmaze = preview() ? undefined : new Tvmaze();
    const library = new Library({
      store, queue, indexers, downloaders, titles, plex: holds, importer, ...(tvmaze ? { airings: tvmaze.airings.bind(tvmaze) } : {}),
      scan: folder => plexOwner.scanFolder(folder),
      // An upgrade Plex has: the movie's copy holding the new file (moved up Recently Added when `resurface`), or every
      // copy of a show. Artwork checks their posters (library.title.upgraded).
      upgraded: async (title, fileName, resurface) => {
        const held = title.kind === 'movie' ? plexIndex.movie(title.tmdbId) : plexIndex.show(title.tmdbId, title.tvdbId);
        if (!held) return 'waiting';
        const copies = held.copies ?? [{ ratingKey: held.ratingKey, ...(held.section ? { section: held.section } : {}) }];
        const upgraded = (copy: (typeof copies)[number]) => bus.emit('library.title.upgraded', { kind: title.kind, tmdbId: title.tmdbId, title: title.title,
          ratingKey: copy.ratingKey, ...(copy.section ? { section: copy.section } : {}), resurfaced: resurface });
        if (title.kind === 'show') { copies.forEach(upgraded); return 'done'; }
        for (const copy of copies) if (await plexOwner.upgradedMovie(copy.ratingKey, fileName, resurface) === 'done') { upgraded(copy); return 'done'; }
        return 'waiting';
      },
      emit: (event, payload) => bus.emit(event, payload),
      log: (message, detail) => log.info(message, detail),
    });
    library.register();
    // The Plex index reads the episodes of the shows the library follows, and a show's again when it is added or its
    // seasons are switched.
    plexIndex.follow(() => store.monitoredShows());
    // The title identity (plexIndex.resolve) learns library title ids and file paths from here.
    plexIndex.library({ title: id => store.title(id), titleId: (kind, tmdbId) => store.titleByTmdb(kind, tmdbId)?.id,
      pathTitle: path => store.fileByPath(path)?.titleId, showMatch: tmdbId => store.showMatch(tmdbId) });
    bus.on('library.title.changed', ({ titleId, kind, change }) => {
      if (kind !== 'show' || (change !== 'added' && change !== 'monitor')) return;
      const title = store.title(titleId);
      if (title && title.monitor !== 'none') void plexIndex.refreshShow(title).catch(e => log.warn('plex index: a show’s episodes could not be read', errorDetail(e)));
    });
    indexers.feedEvery?.(() => store.settings().rssMinutes);
    // Admin › Downloads reads the downloaders live (speeds, free space, everything they hold). Every open page and admin
    // shares one read for a few seconds; a grab moving on or any change made here reads them again.
    const liveReads = new TtlCache<ReturnType<NonNullable<DownloadersApi['live']>>>(1), readLive = downloaders.live?.bind(downloaders);
    const shared = readLive ? { live: () => liveReads.remember('live', LIVE_SHARED_MS, readLive) } : {};
    bus.on('library.grab.changed', () => liveReads.clear());
    routes.addHook('onResponse', async request => { if (request.method !== 'GET' && request.method !== 'HEAD') liveReads.clear(); });
    // Who asked for each title is the requests module's: it mounts after the library (it sends titles here) and hands
    // its reads over as it does (`readRequests`), before any route serves.
    let requestReads: RequestReads | undefined;
    artwork?.useAirings?.(() => {
      const byShow = new Map<number, ReturnType<LibraryStore['airedEpisodes']>>(), now = Date.now();
      for (const e of store.airedEpisodes()) { const list = byShow.get(e.tmdbId) ?? []; list.push(e); byShow.set(e.tmdbId, list); }
      return Object.fromEntries([...byShow].map(([tmdbId, episodes]) => [String(tmdbId), showAirings(episodes, now)]));
    });
    const sources: LibrarySources ={ requests: () => requestReads, ...(artwork ? { collections: () => artwork.collectionMovies() } : {}) };
    // Match: filing a show under a TVDB series (lib/season-map.ts), with the TVDB key from Admin › Connections.
    registerShowMatch(routes, library, new Tvdb(() => serviceKeys.providers().tvdb));
    registerLibraryAdmin(routes, { store, library, queue, titles, downloaders: shared, plexTitles: plexIndex, plexServer: () => config.PLEX_MACHINE_ID, sources });
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
      { id: 'library.wanted', label: 'Search for wanted titles', area: 'Library', section: 'wanted',
        schedule: () => ({ enabled: true, schedule: { kind: 'every', minutes: SWEEP_MINUTES } }), status: () => jobs.tracked('library.wanted'), run: sweepNow },
      { id: 'library.downloads', label: 'Check downloads', area: 'Library', section: 'queue',
        schedule: () => ({ enabled: store.hasOpenGrabs(), schedule: { kind: 'every', minutes: CHECK_MS / 60000 } }), status: () => jobs.tracked('library.downloads'), run: checkNow },
      { id: 'library.seeding', label: 'Remove seeded torrents', area: 'Library', section: 'queue',
        schedule: () => ({ enabled: true, schedule: { kind: 'every', minutes: SEEDING_MINUTES } }), status: () => jobs.tracked('library.seeding'), run: seedNow });

    let timers: { stop(): void }[] = [];
    return {
      // Other modules ask through these; none gets the store.
      api: {
        state: library.state.bind(library), states: library.states.bind(library), calendar: library.calendar.bind(library),
        titleId: (kind: 'movie' | 'show', tmdbId: number) => store.titleByTmdb(kind, tmdbId)?.id,
        // Titles Clean Up must keep, by TMDB id.
        kept: (kind: 'movie' | 'show') => kind === 'movie' ? store.keptMovies() : store.keptShows(),
        // The library's files, for subtitles.
        files: { fileByPath: store.fileByPath.bind(store), filePaths: store.filePaths.bind(store), hasFile: store.hasFile.bind(store), files: store.files.bind(store),
          fileEpisodes: store.fileEpisodes.bind(store), title: store.title.bind(store), episodes: store.episodes.bind(store) } satisfies LibraryFiles,
        forgetSeason: library.forgetSeason.bind(library),
        // Requests and Collections' seasonal downloads add through here; a cancelled request lets go of what nobody else needs.
        add: library.add.bind(library), addShow: library.addShow.bind(library),
        unmonitor: library.unmonitor.bind(library), unmonitorSeasons: library.unmonitorSeasons.bind(library),
        // A request's timing, and its Advanced profiles.
        progress: library.progress.bind(library), profiles: library.profiles.bind(library),
        keep: library.keep.bind(library),
        forget: library.forget.bind(library),
        // The requests module's reads, for Admin › Manage's Source column and each title's Requests tab.
        readRequests: (reads: RequestReads) => { requestReads = reads; },
      },
      start() {
        if (preview()) return;
        void importer.cleanLeftovers().catch(e => log.warn('library leftover cleanup failed', errorDetail(e)));
        timers = [
          every(SWEEP_MINUTES * 60000, sweepNow, e => log.warn('library sweep failed', errorDetail(e))),
          every(CHECK_MS, () => store.hasOpenGrabs() ? checkNow() : undefined, e => log.warn('library download check failed', errorDetail(e))),
          every(SEEDING_MINUTES * 60000, seedNow, e => log.warn('library seeding check failed', errorDetail(e))),
        ];
      },
      stop() { for (const t of timers) t.stop(); library.close(); }
    };
  }
});
