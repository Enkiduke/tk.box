import { defineModule } from './module.js';
import { exploreMigrations } from './migrations/explore.js';
import { registerExplore } from '../explore-api.js';
import { ExploreStore } from '../persistence/explore-store.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { Requests } from '../services/requests.js';

type Deps = {
  // The viewer's own Plex account token, for their watchlist and Discover rows.
  accountToken: (hash: string) => string;
  titles: TmdbTitles;
  // Labels, what can still be requested, and the server's copy of a title.
  requests: Pick<Requests, 'labels' | 'connected' | 'titleState' | 'plexKey'>;
  transports: { seerr?: typeof fetch; images?: typeof fetch };
};

// Explore: Plex Discover and TMDB rows, title details with request labels, and the watchlist, and Admin › Explore's layout
// and settings. Its Seerr connection now serves only Clean Up (`store.seerr`).
export const exploreModule = defineModule({
  name: 'explore',
  migrations: exploreMigrations,
  setup(routes, { db, vault, plex, bus }, { accountToken, titles, requests, transports }: Deps) {
    const store = new ExploreStore(db, vault);
    const { forget } = registerExplore(routes, plex, store, accountToken, titles, requests, transports);
    bus.on('requests.changed', forget);
    return { api: { store } };
  }
});
