import { z } from 'zod';
import { defineModule } from './module.js';
import { viewer } from './access.js';
import { AppError } from '../errors.js';
import { playbackSettings } from '../../../../packages/contracts/src/index.js';
import { serviceKeysInput } from '../persistence/service-keys.js';
import { plexAccountId, type AdminStore } from '../persistence/admin-store.js';
import type { SettingsStore } from '../persistence/database.js';
import type { ServerMetrics } from '../services/metrics.js';
import type { IdentityService } from '../services/identity.js';

type Deps = {
  admins: AdminStore; settings: SettingsStore; metrics: ServerMetrics;
  identity: Pick<IdentityService, 'accountToken'>;
  // Custom channels' segment buffer use, shown with the playback settings.
  customBuffer: () => unknown;
};

// Server-wide admin settings no feature owns: Admin › Connections keys, Admin › Admins (owner only), playback settings
// and server metrics. Every route is admin unless it declares owner.
export const adminModule = defineModule({
  name: 'admin',
  access: 'admin',
  setup(routes, { plex, bus, budget, serviceKeys, background }, { admins, settings, metrics, identity, customBuffer }: Deps) {
    // Admin › metrics: event-loop delay, route timings and Plex reads since the server started.
    routes.get('/api/v1/admin/metrics', async () => metrics.snapshot());
    // Admin › Connections: keys no feature's own settings hold. A new TheSportsDB key is used from the next download on,
    // a new Plex admin token from the next background task (and the Plex notification feed reconnects).
    routes.get('/api/v1/admin/keys', async () => serviceKeys.view());
    // A Plex admin token is saved only once Plex vouches for it as the server owner's.
    routes.put('/api/v1/admin/keys', async req => {
      const { grant } = viewer(req), input = serviceKeysInput.parse(req.body);
      if (input.plex) await background.check(input.plex).catch((e: AppError) => { throw e.code === 'PLEX_TOKEN_NOT_OWNER' || e.code === 'PLEX_UNAVAILABLE' ? e : new AppError('PLEX_TOKEN_REJECTED', 'Plex didn’t accept that token.', 400); });
      const saved = serviceKeys.update(grant.accountId, input); background.invalidate(); bus.emit('service-keys.changed', { plex: input.plex !== undefined });
      return saved;
    });
    // Admin › Admins: the owner picks other admins from their Plex friends and Plex Home.
    const asOwner = { config: { access: 'owner' as const } };
    routes.get('/api/v1/admin/admins', asOwner, async req => {
      const { hash, grant } = viewer(req);
      return { admins: admins.list(), users: await plex.plexUsers(identity.accountToken(hash)), ownerTokenSaved: !!(await background.grant()), ownerId: grant.accountId };
    });
    routes.post('/api/v1/admin/admins', asOwner, async req => {
      const { grant } = viewer(req), body = z.object({ accountId: plexAccountId, name: z.string().max(200), admin: z.boolean() }).strict().parse(req.body);
      return { admins: body.admin ? admins.add(grant.accountId, body.accountId, body.name, grant.accountId) : admins.remove(grant.accountId, body.accountId) };
    });
    routes.get('/api/v1/admin/settings/playback', async () => ({ ...settings.get(), activeVideoEncoders: budget.count, customBuffer: customBuffer() }));
    routes.patch('/api/v1/admin/settings/playback', async req => {
      const { grant } = viewer(req), input = playbackSettings.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(req.body);
      const { expectedRevision, ...value } = input; return settings.update(grant.accountId, expectedRevision, value);
    });
    return { api: {} };
  }
});
