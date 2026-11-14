import { defineModule } from './module.js';
import { registerCatalog } from '../catalog-api.js';

// The library pages: libraries, titles, collections, their artwork and watch-state actions, read as the viewer.
// `hiddenRecent` is artwork's list of collection downloads kept off Recently added.
export const catalogModule = defineModule({
  name: 'catalog',
  setup(routes, { plex }, { hiddenRecent }: { hiddenRecent: () => Set<number> }) {
    registerCatalog(routes, plex, hiddenRecent);
    return { api: {} };
  }
});
