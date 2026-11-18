import { resolve } from 'node:path';
import { preview } from '../errors.js';
import { defineModule } from './module.js';
import { artworkMigrations } from './migrations/artwork.js';
import { ArtworkStore } from '../persistence/artwork-store.js';
import { ArtworkEngine } from '../services/artwork-engine.js';
import { ArtworkWorker } from '../services/artwork-worker.js';
import { ArtworkSchedule, type ScheduleState, type Task } from '../services/artwork-schedule.js';
import type { Job } from '../services/jobs.js';
import { registerArtwork } from '../artwork-api.js';
import type { PlexGrant } from '../providers/plex.js';

type Deps = {
  // How many streams are playing, in tk.box or any Plex app: anyone streaming holds back the nightly full collections run.
  streaming: (grant: PlexGrant) => Promise<number>;
};

// Admin › Artwork: posters, logos and collections made by the artwork engine, which runs as a separate Python process,
// apart from every playback path. TMDB is the shared client (ctx.tmdb); every provider key (TMDB, TVDB, Fanart.tv, MDBList)
// is a service key in Admin › Connections.
export const artworkModule = defineModule({
  name: 'artwork',
  migrations: artworkMigrations,
  access: 'admin',
  setup(routes, { config, db, vault, plex, bus, plexOwner, serviceKeys, tmdb, jobs, log }, { streaming }: Deps) {
    const store = new ArtworkStore(db, vault, resolve('apps/artwork/defaults.json'));
    const engine = new ArtworkEngine(store, { python: config.PYTHON_PATH, script: resolve('apps/artwork/artwork_engine.py'), collectionsScript: resolve('apps/artwork/plex_collections.py'),
      dataDir: config.DATA_DIR, cacheDir: config.CACHE_DIR, get plexUrl() { return config.PLEX_URL; } }, (message, detail) => log.info(message, detail), () => serviceKeys.providers());
    const worker = new ArtworkWorker(engine, (message, detail) => log.warn(message, detail));
    engine.useWorker(worker);
    const schedule = new ArtworkSchedule(store, engine, plex, () => plexOwner.grant(), (message, detail) => log.warn(message, detail), streaming);
    bus.on('plex.library.changed', ({ sections }) => schedule.finished(sections));
    bus.on('plex.notifications.connecting', ({ grant }) => schedule.notificationLibraries(grant));
    engine.finished = () => {
      bus.emit('library.edited', { by: 'artwork' });
      const { add, remove } = engine.takeAcquisitions();
      // Seasonal downloads: tk.box's library adds and removes them.
      if (add.length || remove.length) bus.emit('collections.acquire', { tmdbIds: add, removeIds: remove });
    };
    registerArtwork(routes, store, engine, worker, schedule, tmdb, () => serviceKeys.providers());
    // Admin › Schedule. A note starting "Waiting" is a run held back (no Plex admin token, streams playing).
    const status = ({ lastRun, note }: ScheduleState) => ({ lastRun, note, waiting: note?.startsWith('Waiting') });
    const job = (id: Task | 'added' | 'collections-added', label: string, section: 'artwork' | 'collections', scheduled: Job['schedule'], state: () => ScheduleState): Job =>
      ({ id: `artwork.${id}`, label, area: section === 'artwork' ? 'Artwork' : 'Collections', section, schedule: scheduled, status: () => status(state()),
        run: by => id === 'added' || id === 'collections-added' ? schedule.tick(new Date(), id) : schedule.runNow(id, by.actor, by.grant) });
    jobs.add(
      job('scrub', 'Update changed titles', 'artwork', () => store.settings().schedules.scrub, () => schedule.states().scrub),
      job('added', 'Artwork for newly added', 'artwork', () => store.settings().schedules.added, () => schedule.states().added),
      job('collections-custom', 'Custom and seasonal collections', 'collections', () => store.collections().schedules.custom, () => schedule.collectionStates().custom),
      job('collections-all', 'Update every collection', 'collections', () => store.collections().schedules.all, () => schedule.collectionStates().all),
      job('collections-added', 'Collections for newly added', 'collections', () => store.collections().schedules.added, () => schedule.collectionStates().added));
    return {
      api: { store, engine,
        // Which collections downloaded each movie (Admin › Manage's Source column), and the downloads kept off Recently added.
        collectionMovies: () => engine.collectionMovies(), hiddenFromRecent: () => engine.hiddenFromRecent() },
      start() { if (!preview()) schedule.start(); },
      stop() { schedule.close(); worker.close(); engine.close(); }
    };
  }
});
