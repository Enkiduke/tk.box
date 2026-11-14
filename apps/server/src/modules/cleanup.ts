import { resolve } from 'node:path';
import { defineModule } from './module.js';
import { cleanupMigrations } from './migrations/cleanup.js';
import { CleanupStore } from '../persistence/cleanup-store.js';
import { CleanupEngine, cleanupCollections, type CleanupServices } from '../services/cleanup-engine.js';
import { registerCleanup } from '../cleanup-api.js';
import type { ArtworkStore } from '../persistence/artwork-store.js';
import type { ArtworkEngine } from '../services/artwork-engine.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { Requests } from '../services/requests.js';

type Deps = {
  // The collections artwork keeps are never purged.
  artwork: { store: ArtworkStore; engine: ArtworkEngine };
  // Radarr and Sonarr.
  arr: { connection: (name: 'radarr' | 'sonarr') => ArrService };
  // tk.box's requests: the titles a run looks at, and those to mark removed once it deleted them.
  requests: Pick<Requests, 'forCleanup' | 'removedByCleanup'>;
};

// Admin › Server › Clean Up: the purge script runs as a separate Python process too. `services` are the connections a
// run needs.
export const cleanupModule = defineModule({
  name: 'cleanup',
  migrations: cleanupMigrations,
  access: 'admin',
  setup(routes, { config, db, vault, bus, background, log }, { artwork, requests, arr }: Deps) {
    const store = new CleanupStore(db, vault);
    const services = (): CleanupServices => {
      const own = store.connections();
      return { radarr: arr.connection('radarr'), tautulli: { url: own.tautulliUrl, key: own.tautulliKey }, sonarr: arr.connection('sonarr') };
    };
    const engine = new CleanupEngine(store, { python: config.PYTHON_PATH, script: resolve('apps/cleanup/purge_requests.py'), poster: resolve('apps/cleanup/leaving-soon.png'),
      dataDir: config.DATA_DIR, get plexUrl() { return config.PLEX_URL; } }, services, () => background.grant(), (message, detail) => log.info(message, detail));
    registerCleanup(routes, store, engine, services);
    engine.finished = () => bus.emit('library.edited', { by: 'cleanup' });
    engine.requests = () => requests.forCleanup();
    engine.deleted = titles => requests.removedByCleanup(titles);
    engine.collections = () => cleanupCollections(artwork.engine.keptCollections().collections, artwork.store.collections().definitions);
    return {
      api: { services },
      start() { engine.start(); },
      stop() { engine.close(); }
    };
  }
});
