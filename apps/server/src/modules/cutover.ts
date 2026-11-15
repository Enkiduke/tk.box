import { defineModule } from './module.js';
import { viewer } from './access.js';
import { MovieCutover } from '../services/cutover.js';
import type { LibraryStore } from '../persistence/library-store.js';
import type { RequestStore } from '../persistence/requests-store.js';
import type { ArrService } from '../providers/arr-tags.js';

type Deps = {
  library: { store: LibraryStore };
  // Requests' arr_id moves between Radarr's ids and the library's on Switch and Switch back.
  requests: { store: Pick<RequestStore, 'moveArrIds'> };
  arr: { connection: (name: 'radarr' | 'sonarr') => ArrService };
  // Clean Up's protected tags: a movie with one is imported with Keep.
  cleanup: { keepTags: () => readonly string[] };
};

// Admin › Downloads › Cutover (docs/ARR-REPLACEMENT.md, Phase 1 › Cutover): movies from Radarr into tk.box's library,
// then Switch and Switch back. Its tables are the library's (library_cutover); it mounts after requests and Clean Up,
// whose requests it moves and whose protected tag it reads. Radarr is only read.
export const cutoverModule = defineModule({
  name: 'cutover',
  access: 'admin',
  setup(routes, _ctx, { library, requests, arr, cleanup }: Deps) {
    const cutover = new MovieCutover({ library: library.store, requests: requests.store, radarr: () => arr.connection('radarr'), keepTags: cleanup.keepTags });
    const actor = (request: Parameters<typeof viewer>[0]) => viewer(request).grant.accountId;
    const slow = { config: { access: 'admin' as const, rateLimit: { max: 10, timeWindow: 60000 } } };
    routes.get('/api/v1/admin/library/cutover', async () => cutover.view());
    routes.post('/api/v1/admin/library/cutover/dry-run', slow, async () => cutover.dryRun());
    routes.post('/api/v1/admin/library/cutover/import', slow, async request => cutover.import(actor(request)));
    routes.post('/api/v1/admin/library/cutover/switch', async request => cutover.switch(actor(request)));
    routes.post('/api/v1/admin/library/cutover/switch-back', async request => cutover.switchBack(actor(request)));
    return { api: { cutover } };
  }
});
