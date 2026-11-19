import { resolve } from 'node:path';
import type { CleanupUsersView } from '../../../../packages/contracts/src/index.js';
import { defineModule } from './module.js';
import { viewer } from './access.js';
import { preview, requireThat } from '../errors.js';
import { cleanupMigrations } from './migrations/cleanup.js';
import { CleanupStore } from '../persistence/cleanup-store.js';
import { CleanupEngine, cleanupCollections } from '../services/cleanup-engine.js';
import { registerCleanup } from '../cleanup-api.js';
import type { ArtworkStore } from '../persistence/artwork-store.js';
import type { ArtworkEngine } from '../services/artwork-engine.js';
import type { Requests } from '../services/requests.js';
import type { CleanupWatch } from '../services/cleanup-engine.js';
import type { IdentityService } from '../services/identity.js';
import type { PlexIndex } from '../services/plex-index.js';

type Deps = {
  // The collections artwork keeps are never purged.
  artwork: { store: ArtworkStore; engine: ArtworkEngine };
  // tk.box's requests: the titles a run looks at, and those to mark removed once it deleted them.
  requests: Pick<Requests, 'forCleanup' | 'removedByCleanup'>;
  // Watch history: each account's latest watch of each title and season on a Plex server, the saved dates included.
  watchHistory: { watches(serverId: string): CleanupWatch[] };
  identity: Pick<IdentityService, 'accountToken'>;
  // tk.box's library: a title a run deleted is forgotten there (library.title.changed, which requests hear), instead
  // of being marked removed here, and a deleted season is forgotten (`forgetSeason`, which also stops following it).
  // Titles are kept by the library's Keep.
  library: {
    titleId(kind: 'movie' | 'show', tmdbId: number): number | undefined; kept(kind: 'movie' | 'show'): Set<number>;
    forget(titleId: number, by: 'cleanup' | 'admin'): void; keep(titleId: number, keep: boolean): void;
    forgetSeason(titleId: number, season: number): Promise<void> };
  // The title identity: each request's Plex copies, their seasons and added dates (the TypeScript rules; no title search).
  plexIndex: Pick<PlexIndex, 'resolve' | 'copy'>;
};

// Admin › Server › Clean Up: decides over these deps and writes Plex with the owner's grant.
export const cleanupModule = defineModule({
  name: 'cleanup',
  migrations: cleanupMigrations,
  access: 'admin',
  setup(routes, { config, db, vault, bus, plexOwner, jobs, log, plex, serviceKeys }, { artwork, requests, watchHistory, identity, library, plexIndex }: Deps) {
    const store = new CleanupStore(db, vault);
    const engine = new CleanupEngine(store, { poster: resolve('apps/server/assets/leaving-soon.png'), dataDir: config.DATA_DIR },
      () => plexOwner.grant(), (message, detail) => log.info(message, detail));
    engine.plexIndex = plexIndex;
    engine.plex = plex;
    registerCleanup(routes, store, engine);
    routes.get('/api/v1/admin/cleanup/users', async (req): Promise<CleanupUsersView> => {
      const { hash, grant } = viewer(req);
      const isOwner = grant.accountId === config.PLEX_OWNER_ACCOUNT_ID;
      const token = isOwner ? identity.accountToken(hash) : serviceKeys.get('plex');
      const owner = isOwner ? grant : await plexOwner.grant();
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
    engine.watches = serverId => watchHistory.watches(serverId);
    engine.deleted = (titles, seasons) => {
      const ours = titles.flatMap(t => { const id = library.titleId(t.kind, t.tmdb); return id === undefined ? [] : [{ t, id }]; });
      for (const { id } of ours) library.forget(id, 'cleanup');
      requests.removedByCleanup(titles.filter(t => !ours.some(o => o.t === t)));
      for (const { tmdb, season } of seasons) {
        const show = library.titleId('show', tmdb);
        if (show !== undefined) void library.forgetSeason(show, season).catch(e => log.warn('clean up: the library could not forget a season', { tmdb, season, error: (e as Error).message }));
      }
    };
    engine.movies = () => ({ kept: library.kept('movie'), shows: { kept: library.kept('show') },
      keep: (tmdbId, kind = 'movie') => { const id = library.titleId(kind, tmdbId); if (id !== undefined) library.keep(id, true); return id !== undefined; } });
    engine.collections = () => cleanupCollections(artwork.engine.keptCollections().collections, artwork.store.collections().definitions);
    jobs.add({ id: 'cleanup.run', label: 'Clean up', area: 'Clean Up', section: 'cleanup', schedule: () => store.settings().schedule,
      status: () => { const { lastRun, note } = engine.scheduleState(); return { lastRun, note, running: engine.pending(), waiting: note?.startsWith('Waiting'), failed: note?.startsWith('Skipped') }; },
      run: by => engine.runNow(by.actor, by.grant.serverToken) });
    return {
      api: {},
      start() { if (!preview()) engine.start(); },
      stop() { engine.close(); }
    };
  }
});
