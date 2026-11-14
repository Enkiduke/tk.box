import { z } from 'zod';
import { defineModule } from './module.js';
import { arrMigrations } from './migrations/arr.js';
import { viewer } from './access.js';
import { ArrStore, arrConnectionInput, arrNames, type ArrName } from '../persistence/arr-store.js';

// The Radarr and Sonarr connections (Admin › Connections). Mounted before everything that reads them: artwork
// (Collections' seasonal downloads), Clean Up, the calendar and requests.
export const arrModule = defineModule({
  name: 'arr',
  migrations: arrMigrations,
  access: 'admin',
  setup(routes, { db, vault }) {
    const store = new ArrStore(db, vault);
    routes.get('/api/v1/admin/arr', async () => store.view());
    routes.put('/api/v1/admin/arr/:name', async request => {
      const { name } = z.object({ name: z.enum(arrNames) }).strict().parse(request.params);
      const { expectedRevision, ...value } = arrConnectionInput.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(request.body);
      return store.update(viewer(request).grant.accountId, name, expectedRevision, value);
    });
    return { api: { connection: (name: ArrName) => store.connection(name) } };
  }
});
