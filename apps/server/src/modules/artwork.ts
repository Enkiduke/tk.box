import { resolve } from 'node:path';
import { defineModule } from './module.js';
import { artworkMigrations } from './migrations/artwork.js';
import { ArtworkStore } from '../persistence/artwork-store.js';
import { ArtworkEngine } from '../services/artwork-engine.js';
import { ArtworkWorker } from '../services/artwork-worker.js';
import { ArtworkSchedule } from '../services/artwork-schedule.js';
import { registerArtwork } from '../artwork-api.js';
import { TmdbTitles } from '../providers/tmdb-titles.js';
import type { PlexGrant } from '../providers/plex.js';
import type { ArrService } from '../providers/arr-tags.js';

type Deps = {
  // How many streams are playing, in tk.box or any Plex app: anyone streaming holds back the nightly full collections run.
  streaming: (grant: PlexGrant) => Promise<number>;
  tmdbTransport?: typeof fetch;
  // The arr module's connections: Collections' seasonal downloads use Radarr.
  arr: { connection: (name: 'radarr' | 'sonarr') => ArrService };
};

// Admin › Artwork: posters, logos and collections made by the artwork engine, which runs as a separate Python process,
// apart from every playback path. Its TMDB key also serves Explore and the calendar (`titles`).
export const artworkModule = defineModule({
  name: 'artwork',
  migrations: artworkMigrations,
  access: 'admin',
  setup(routes, { config, db, vault, plex, bus, background, log }, { streaming, tmdbTransport, arr }: Deps) {
    const store = new ArtworkStore(db, vault, resolve('apps/artwork/defaults.json'));
    const titles = new TmdbTitles(() => store.keys().tmdb, tmdbTransport);
    const engine = new ArtworkEngine(store, { python: config.PYTHON_PATH, script: resolve('apps/artwork/artwork_engine.py'), collectionsScript: resolve('apps/artwork/plex_collections.py'),
      dataDir: config.DATA_DIR, cacheDir: config.CACHE_DIR, get plexUrl() { return config.PLEX_URL; } }, (message, detail) => log.info(message, detail), () => arr.connection('radarr'));
    const worker = new ArtworkWorker(engine, (message, detail) => log.warn(message, detail));
    engine.useWorker(worker);
    const schedule = new ArtworkSchedule(store, engine, plex, () => background.grant(), (message, detail) => log.warn(message, detail), streaming);
    bus.on('plex.library.changed', ({ sections }) => schedule.finished(sections));
    bus.on('plex.notifications.connecting', ({ grant }) => schedule.notificationLibraries(grant));
    engine.finished = () => bus.emit('library.edited', { by: 'artwork' });
    registerArtwork(routes, store, engine, worker, schedule, titles);
    return {
      api: { store, engine, titles },
      start() { schedule.start(); },
      stop() { schedule.close(); worker.close(); engine.close(); }
    };
  }
});
