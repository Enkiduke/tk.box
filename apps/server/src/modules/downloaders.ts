import { defineModule } from './module.js';
import { downloadersMigrations } from './migrations/downloaders.js';
import { z } from 'zod';
import { connectionActor } from './access.js';
import { Downloaders, downloaderInput, downloaderNames, type Download, type DownloaderName, type GrabRef, type RemoveOptions } from '../services/downloaders.js';

// The downloaders (docs/ARR-REPLACEMENT.md, "Modules"): SABnzbd in phase 1, qBittorrent in phase 3. Admin › Connections ›
// Indexers & downloaders reads, saves and tests them through /api/v1/admin/downloaders. The library checks status every 30 s
// while grabs are open.
export const downloadersModule = defineModule({
  name: 'downloaders',
  access: 'connectionAdmin',
  migrations: downloadersMigrations,
  setup(routes, { db, vault }, deps: { transport?: typeof fetch } | undefined) {
    const downloaders = new Downloaders(db, vault, deps?.transport);
    const name = z.object({ name: z.enum(downloaderNames) }).strict();
    routes.get('/api/v1/admin/downloaders', async () => downloaders.view());
    routes.put('/api/v1/admin/downloaders/:name', async request => downloaders.configure(connectionActor(request), name.parse(request.params).name, request.body as z.input<typeof downloaderInput>));
    routes.post('/api/v1/admin/downloaders/:name/test', { config: { access: 'connectionAdmin', rateLimit: { max: 10, timeWindow: 60000 } } },
      async request => downloaders.test(name.parse(request.params).name));
    return {
      api: {
        send: (download: Download) => downloaders.send(download),
        status: (name?: DownloaderName) => downloaders.status(name),
        live: () => downloaders.live(),
        // Connection health, once shows are tk.box's (services/connection-health.ts).
        view: () => downloaders.view(),
        test: (name: DownloaderName) => downloaders.test(name),
        remove: (grab: GrabRef, options?: RemoveOptions) => downloaders.remove(grab, options),
      }
    };
  }
});
