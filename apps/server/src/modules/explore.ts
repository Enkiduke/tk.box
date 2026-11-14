import { defineModule } from './module.js';
import { exploreMigrations } from './migrations/explore.js';
import { registerExplore } from '../explore-api.js';
import { ExploreStore } from '../persistence/explore-store.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';

type Deps = {
  // The viewer's own Plex account token, for their watchlist and Discover rows.
  accountToken: (hash: string) => string;
  titles: TmdbTitles;
  transports: { seerr?: typeof fetch; images?: typeof fetch };
};

// Explore: Plex Discover, TMDB and Seerr rows, title details, requests and the watchlist, and Admin › Explore's layout
// and settings. Its Seerr connection also serves Clean Up (`store.seerr`).
export const exploreModule = defineModule({
  name: 'explore',
  migrations: exploreMigrations,
  setup(routes, { db, vault, plex }, { accountToken, titles, transports }: Deps) {
    const store = new ExploreStore(db, vault);
    registerExplore(routes, plex, store, accountToken, titles, transports);
    return { api: { store } };
  }
});
