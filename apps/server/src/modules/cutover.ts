import { defineModule } from './module.js';
import { viewer } from './access.js';
import { ShowCutover, type CutoverLibrary } from '../services/show-cutover.js';
import type { LibraryStore } from '../persistence/library-store.js';
import type { RequestStore } from '../persistence/requests-store.js';
import type { ArrService } from '../providers/arr-tags.js';

type Deps = {
  library: { store: LibraryStore; cutover: CutoverLibrary };
  // Requests' arr_id moves between Sonarr's ids and the library's on Switch and Switch back.
  requests: { store: Pick<RequestStore, 'moveArrIds'> };
  arr: { connection: (name: 'sonarr') => ArrService };
  // Clean Up's protected tags: a series with one is imported with Keep.
  cleanup: { keepTags: () => readonly string[] };
};

// Admin › Downloads › Sonarr import (docs/PHASE-2.md, step 6): shows from Sonarr into tk.box's library, then Switch and
// Switch back. Its tables are the library's (show_cutover); it mounts after requests and Clean Up, whose requests it
// moves and whose protected tags it reads. Sonarr is only read. Step 7 removes it.
export const cutoverModule = defineModule({
  name: 'cutover',
  access: 'admin',
  setup(routes, _ctx, { library, requests, arr, cleanup }: Deps) {
    const cutover = new ShowCutover({ store: library.store, library: library.cutover, requests: requests.store, sonarr: () => arr.connection('sonarr'), keepTags: cleanup.keepTags });
    const actor = (request: Parameters<typeof viewer>[0]) => viewer(request).grant.accountId;
    const slow = { config: { access: 'admin' as const, rateLimit: { max: 10, timeWindow: 60000 } } };
    routes.get('/api/v1/admin/library/cutover', async () => cutover.view());
    routes.post('/api/v1/admin/library/cutover/dry-run', slow, async request => cutover.start('dry-run', actor(request)).view);
    routes.post('/api/v1/admin/library/cutover/import', slow, async request => cutover.start('import', actor(request)).view);
    routes.post('/api/v1/admin/library/cutover/switch', async request => cutover.switch(actor(request)));
    routes.post('/api/v1/admin/library/cutover/switch-back', async request => cutover.switchBack(actor(request)));
    return { api: { cutover } };
  }
});
