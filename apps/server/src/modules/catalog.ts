import { defineModule } from './module.js';
import { registerCatalog } from '../catalog-api.js';

// The library pages: libraries, titles, collections, their artwork and watch-state actions, read as the viewer.
// Artwork's `hiddenFromRecent`: the collection downloads kept off Recently added.
export const catalogModule = defineModule({
  name: 'catalog',
  setup(routes, { plex }, { artwork }: { artwork: { hiddenFromRecent(): Set<number> } }) {
    registerCatalog(routes, plex, () => artwork.hiddenFromRecent());
    return { api: {} };
  }
});
