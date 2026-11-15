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
import type { CleanupWatch } from '../persistence/cleanup-store.js';

type Deps = {
  // The collections artwork keeps are never purged.
  artwork: { store: ArtworkStore; engine: ArtworkEngine };
  // Radarr and Sonarr.
  arr: { connection: (name: 'radarr' | 'sonarr') => ArrService };
  // tk.box's requests: the titles a run looks at, and those to mark removed once it deleted them.
  requests: Pick<Requests, 'forCleanup' | 'removedByCleanup'>;
  // Watch history: each account's latest watch of each title on a Plex server.
  watches: (serverId: string) => CleanupWatch[];
};

// Admin › Server › Clean Up: the purge script runs as a separate Python process too. `services` are the connections a
// run needs.
export const cleanupModule = defineModule({
  name: 'cleanup',
  migrations: cleanupMigrations,
  access: 'admin',
  setup(routes, { config, db, vault, bus, background, jobs, log }, { artwork, requests, arr, watches }: Deps) {
    const store = new CleanupStore(db, vault);
    const services = (): CleanupServices => {
      return { radarr: arr.connection('radarr'), sonarr: arr.connection('sonarr') };
    };
    const engine = new CleanupEngine(store, { python: config.PYTHON_PATH, script: resolve('apps/cleanup/purge_requests.py'), poster: resolve('apps/cleanup/leaving-soon.png'),
      dataDir: config.DATA_DIR, get plexUrl() { return config.PLEX_URL; } }, services, () => background.grant(), (message, detail) => log.info(message, detail));
    registerCleanup(routes, store, engine, services);
    engine.finished = () => bus.emit('library.edited', { by: 'cleanup' });
    engine.requests = () => requests.forCleanup();
    engine.serverId = () => config.PLEX_MACHINE_ID;
    engine.watches = serverId => [...store.watchSnapshotRows(serverId), ...watches(serverId)];
    engine.deleted = titles => requests.removedByCleanup(titles);
    engine.collections = () => cleanupCollections(artwork.engine.keptCollections().collections, artwork.store.collections().definitions);
    jobs.add({ id: 'cleanup.run', label: 'Clean up', area: 'Clean Up', section: 'cleanup', schedule: () => store.settings().schedule,
      status: () => { const { lastRun, note } = engine.scheduleState(); return { lastRun, note, running: engine.pending(), waiting: note?.startsWith('Waiting'), failed: note?.startsWith('Skipped') }; },
      run: by => engine.runNow(by.actor, by.grant.serverToken) });
    return {
      // The saved watch history, for Explore's suggestions.
      api: { services, watchSnapshot: (serverId: string) => store.watchSnapshotRows(serverId) },
      start() { engine.start(); },
      stop() { engine.close(); }
    };
  }
});
