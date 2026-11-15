import { defineModule } from './module.js';
import { exploreMigrations } from './migrations/explore.js';
import { registerExplore } from '../explore-api.js';
import { ExploreStore } from '../persistence/explore-store.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { Requests } from '../services/requests.js';
import type { ServerWatch } from '../explore-api.js';

type Deps = {
  // The viewer's own Plex account token, for their watchlist and Discover rows.
  accountToken: (hash: string) => string;
  titles: TmdbTitles;
  // Labels, what can still be requested, and the server's copy of a title.
  requests: Pick<Requests, 'labels' | 'connected' | 'titleState' | 'plexKey' | 'tmdbForKey'>;
  // One account's watches on this server, by rating key, for the suggestions.
  watches: (account: string) => ServerWatch[];
  transports: { images?: typeof fetch };
};

// Explore: Plex Discover and TMDB rows, title details with request labels, and the watchlist, and Admin › Explore's layout.
export const exploreModule = defineModule({
  name: 'explore',
  migrations: exploreMigrations,
  setup(routes, { db, plex, bus }, { accountToken, titles, requests, watches, transports }: Deps) {
    const store = new ExploreStore(db);
    const { forget } = registerExplore(routes, plex, store, accountToken, titles, requests, transports, watches);
    bus.on('requests.changed', forget);
    return { api: { store } };
  }
});
