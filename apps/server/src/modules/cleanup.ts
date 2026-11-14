import { resolve } from 'node:path';
import { defineModule } from './module.js';
import { CleanupStore } from '../persistence/cleanup-store.js';
import { CleanupEngine, cleanupCollections, type CleanupServices } from '../services/cleanup-engine.js';
import { registerCleanup } from '../cleanup-api.js';
import type { ArtworkStore } from '../persistence/artwork-store.js';
import type { ArtworkEngine } from '../services/artwork-engine.js';

type Deps = {
  // Radarr is Collections' connection; the collections artwork keeps are never purged.
  artwork: { store: ArtworkStore; engine: ArtworkEngine };
  // Seerr is Explore's connection.
  seerr: () => CleanupServices['seerr'];
};

// Admin › Server › Clean Up: the purge script runs as a separate Python process too. Its connections (`services`) also
// feed the calendar.
export const cleanupModule = defineModule({
  name: 'cleanup',
  access: 'admin',
  setup(routes, { config, db, vault, bus, background, log }, { artwork, seerr }: Deps) {
    const store = new CleanupStore(db, vault);
    const services = (): CleanupServices => {
      const { radarr, radarrKey } = artwork.store.collectionsConfig(), own = store.connections();
      return { seerr: seerr(), radarr: { url: radarr.url, key: radarrKey }, tautulli: { url: own.tautulliUrl, key: own.tautulliKey }, sonarr: { url: own.sonarrUrl, key: own.sonarrKey } };
    };
    const engine = new CleanupEngine(store, { python: config.PYTHON_PATH, script: resolve('apps/cleanup/purge_requests.py'), poster: resolve('apps/cleanup/leaving-soon.png'),
      dataDir: config.DATA_DIR, get plexUrl() { return config.PLEX_URL; } }, services, () => background.grant(), (message, detail) => log.info(message, detail));
    registerCleanup(routes, store, engine, services);
    engine.finished = () => bus.emit('library.edited', { by: 'cleanup' });
    engine.collections = () => cleanupCollections(artwork.engine.keptCollections().collections, artwork.store.collections().definitions);
    return {
      api: { services },
      start() { engine.start(); },
      stop() { engine.close(); }
    };
  }
});
