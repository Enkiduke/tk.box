import { defineModule } from './module.js';
import { exploreMigrations } from './migrations/explore.js';
import { registerExplore } from '../explore-api.js';
import { ExploreStore } from '../persistence/explore-store.js';
import type { Requests } from '../services/requests.js';
import type { ServerWatch } from '../explore-api.js';
import type { PlexIndex } from '../services/plex-index.js';
import type { IdentityService } from '../services/identity.js';
import type { Watch } from './watch-history.js';

type Deps = {
  // The viewer's own Plex account token, for their watchlist and Discover rows.
  identity: Pick<IdentityService, 'accountToken'>;
  // Labels and what can still be requested.
  requests: Pick<Requests, 'labels' | 'connected' | 'titleState'>;
  // The title identity: the server's copy of a title, and the TMDB id of a watch saved without one.
  plexTitles: Pick<PlexIndex, 'resolve'>;
  // Watch history: one account's watches on this server (tk.box's history and the saved dates), for the suggestions.
  watchHistory: { watches(serverId: string, options: { account: string; seasons: false }): Watch[] };
  transports: { images?: typeof fetch };
};

// Explore: Plex Discover and TMDB rows, title details with request labels, and the watchlist, and Admin › Explore's layout.
export const exploreModule = defineModule({
  name: 'explore',
  portal: true,
  migrations: exploreMigrations,
  setup(routes, { config, db, plex, bus, tmdb }, { identity, requests, plexTitles, watchHistory, transports }: Deps) {
    const accountToken = (hash: string) => identity.accountToken(hash);
    const watches = (account: string): ServerWatch[] => {
      const server = config.PLEX_MACHINE_ID;
      return server ? watchHistory.watches(server, { account, seasons: false }).flatMap(({ scope, account: _, ...w }) => scope === 'season' ? [] : [{ kind: scope, ...w }]) : [];
    };
    const store = new ExploreStore(db);
    const { forget } = registerExplore(routes, plex, store, accountToken, tmdb, requests, transports, watches, plexTitles);
    bus.on('requests.changed', forget);
    return { api: { store } };
  }
});
