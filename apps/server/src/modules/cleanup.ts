import { resolve } from 'node:path';
import type { CleanupUsersView } from '../../../../packages/contracts/src/index.js';
import { defineModule } from './module.js';
import { viewer } from './access.js';
import { requireThat } from '../errors.js';
import { cleanupMigrations } from './migrations/cleanup.js';
import { CleanupStore } from '../persistence/cleanup-store.js';
import { CleanupEngine, cleanupCollections, type CleanupServices } from '../services/cleanup-engine.js';
import { registerCleanup } from '../cleanup-api.js';
import type { ArtworkStore } from '../persistence/artwork-store.js';
import type { ArtworkEngine } from '../services/artwork-engine.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { Requests } from '../services/requests.js';
import type { CleanupWatch } from '../persistence/cleanup-store.js';
import type { IdentityService } from '../services/identity.js';

type Deps = {
  // The collections artwork keeps are never purged.
  artwork: { store: ArtworkStore; engine: ArtworkEngine };
  // Sonarr, for shows.
  arr: { connection: (name: 'sonarr') => ArrService };
  // tk.box's requests: the titles a run looks at, and those to mark removed once it deleted them.
  requests: Pick<Requests, 'forCleanup' | 'removedByCleanup' | 'keepTag'>;
  // Watch history: each account's latest watch of each title on a Plex server.
  watches: (serverId: string) => CleanupWatch[];
  identity: Pick<IdentityService, 'accountToken'>;
  // tk.box's library: a movie a run deleted is forgotten there (library.title.removed, which requests hear), instead of
  // being marked removed here. Movies are kept by library_titles.keep.
  library: {
    store: { titleByTmdb(kind: 'movie' | 'show', tmdbId: number): { id: number } | undefined; keptMovies(): Set<number> };
    forget(titleId: number, by: 'cleanup' | 'admin'): void; keep(titleId: number, keep: boolean): void };
};

// Admin › Server › Clean Up: the purge script runs as a separate Python process too. `services` are the connections a
// run needs.
export const cleanupModule = defineModule({
  name: 'cleanup',
  migrations: cleanupMigrations,
  access: 'admin',
  setup(routes, { config, db, vault, bus, background, jobs, log, plex, serviceKeys }, { artwork, requests, arr, watches, identity, library }: Deps) {
    const store = new CleanupStore(db, vault);
    const services = (): CleanupServices => {
      return { sonarr: arr.connection('sonarr') };
    };
    const engine = new CleanupEngine(store, { python: config.PYTHON_PATH, script: resolve('apps/cleanup/purge_requests.py'), poster: resolve('apps/cleanup/leaving-soon.png'),
      dataDir: config.DATA_DIR, get plexUrl() { return config.PLEX_URL; } }, services, () => background.grant(), (message, detail) => log.info(message, detail));
    registerCleanup(routes, store, engine, services);
    routes.get('/api/v1/admin/cleanup/users', async (req): Promise<CleanupUsersView> => {
      const { hash, grant } = viewer(req);
      const isOwner = grant.accountId === config.PLEX_OWNER_ACCOUNT_ID;
      const token = isOwner ? identity.accountToken(hash) : serviceKeys.get('plex');
      const owner = isOwner ? grant : await background.grant();
      requireThat(token && owner && (isOwner || token === serviceKeys.get('plex')), 'PLEX_ADMIN_TOKEN_REQUIRED',
        'Connect a working Plex admin token in Admin › Connections to load Plex users.', 503);

      const { users, directoryIncomplete } = await plex.plexUsers(token);
      const options = new Map<number, CleanupUsersView['users'][number]>();
      for (const user of users.values()) {
        if (user.accountId !== owner.accountId && !user.home && !user.access.some(share => !share.pending)) continue;
        const accountId = Number(user.accountId);
        if (Number.isSafeInteger(accountId) && accountId > 0) options.set(accountId, { accountId, name: user.name, username: user.username });
      }
      const ownerId = Number(owner.accountId);
      if (Number.isSafeInteger(ownerId) && ownerId > 0) options.set(ownerId, {
        accountId: ownerId, name: owner.name || options.get(ownerId)?.name || 'Plex server owner', username: options.get(ownerId)?.username,
      });
      return { users: [...options.values()], directoryIncomplete };
    });
    engine.finished = () => bus.emit('library.edited', { by: 'cleanup' });
    engine.requests = () => requests.forCleanup();
    engine.serverId = () => config.PLEX_MACHINE_ID;
    engine.watches = serverId => [...store.watchSnapshotRows(serverId), ...watches(serverId)];
    engine.deleted = titles => {
      const ours = titles.filter(t => t.kind === 'movie' && library.store.titleByTmdb(t.kind, t.tmdb));
      for (const t of ours) library.forget(library.store.titleByTmdb(t.kind, t.tmdb)!.id, 'cleanup');
      requests.removedByCleanup(titles.filter(t => !ours.includes(t)));
    };
    requests.keepTag = () => store.settings().exemptArrTags[0];
    engine.movies = () => ({ kept: library.store.keptMovies(),
      keep: tmdbId => { const t = library.store.titleByTmdb('movie', tmdbId); if (t) library.keep(t.id, true); return !!t; } });
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
