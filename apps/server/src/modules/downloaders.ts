import { defineModule } from './module.js';
import { downloadersMigrations } from './migrations/downloaders.js';
import { z } from 'zod';
import { viewer } from './access.js';
import { Downloaders, downloaderInput, downloaderNames, type Download, type GrabRef } from '../services/downloaders.js';

// The downloaders (docs/ARR-REPLACEMENT.md, "Modules"): SABnzbd in phase 1, qBittorrent in phase 3. Admin › Downloads ›
// Downloaders reads, saves and tests them through /api/v1/admin/downloaders. The library checks status every 30 s
// while grabs are open.
export const downloadersModule = defineModule({
  name: 'downloaders',
  access: 'admin',
  migrations: downloadersMigrations,
  setup(routes, { db, vault }, deps: { transport?: typeof fetch } | undefined) {
    const downloaders = new Downloaders(db, vault, deps?.transport);
    const name = z.object({ name: z.enum(downloaderNames) }).strict();
    routes.get('/api/v1/admin/downloaders', async () => downloaders.view());
    routes.put('/api/v1/admin/downloaders/:name', async request => downloaders.configure(viewer(request).grant.accountId, name.parse(request.params).name, request.body as z.input<typeof downloaderInput>));
    routes.post('/api/v1/admin/downloaders/:name/test', { config: { access: 'admin', rateLimit: { max: 10, timeWindow: 60000 } } },
      async request => downloaders.test(name.parse(request.params).name));
    return {
      api: {
        send: (download: Download) => downloaders.send(download),
        status: () => downloaders.status(),
        remove: (grab: GrabRef) => downloaders.remove(grab),
      }
    };
  }
});
