import { z } from 'zod';
import { defineModule } from './module.js';
import { viewer } from './access.js';
import { AppError, readOnly, requireThat, requireWritable } from '../errors.js';
import type { FastifyRequest } from 'fastify';
import { playbackSettings, type PlexUsersView } from '../../../../packages/contracts/src/index.js';
import { serviceKeysInput } from '../persistence/service-keys.js';
import { plexAccountId, type AdminStore } from '../persistence/admin-store.js';
import type { SettingsStore } from '../persistence/database.js';
import type { ServerMetrics } from '../services/metrics.js';
import type { IdentityService } from '../services/identity.js';
import type { connectionHealth } from '../services/connection-health.js';
import { canManageTkBox } from '../providers/plex-users.js';

type Deps = {
  admins: AdminStore; settings: SettingsStore; metrics: ServerMetrics;
  identity: Pick<IdentityService, 'accountToken'>;
  checkConnections: ReturnType<typeof connectionHealth>;
  // Custom channels' segment buffer use, shown with the playback settings.
  customBuffer: () => unknown;
};

// Server-wide admin settings no feature owns: Admin › Connections keys, Admin › Users (owner only), playback settings
// and server metrics. Every route is admin unless it declares owner.
export const adminModule = defineModule({
  name: 'admin',
  access: 'admin',
  setup(routes, { plex, bus, budget, serviceKeys, background }, { admins, settings, metrics, identity, customBuffer, checkConnections }: Deps) {
    // Admin › metrics: event-loop delay, route timings and Plex reads since the server started.
    routes.get('/api/v1/admin/metrics', async () => metrics.snapshot());
    // Admin › Connections: keys no feature's own settings hold. A new TheSportsDB key is used from the next download on,
    // a new Plex admin token from the next background task (and the Plex notification feed reconnects).
    routes.get('/api/v1/admin/keys', async () => serviceKeys.view());
    routes.get('/api/v1/admin/connections/services', async () => checkConnections());
    routes.get('/api/v1/admin/connections/plex', async req => {
      const { hash, grant } = viewer(req);
      const accountToken = identity.accountToken(hash), adminToken = serviceKeys.get('plex');
      const accountCheck = plex.accountAccess(accountToken);
      const serverCheck = plex.serverAccess(grant.serverToken);
      const tokenCheck = !adminToken ? undefined : (adminToken === accountToken ? accountCheck : plex.accountAccess(adminToken))
        .then(async account => {
          if (!account.isOwner) return false;
          await (account.serverToken === grant.serverToken ? serverCheck : plex.serverAccess(account.serverToken));
          return true;
        });
      const [account, server, token] = await Promise.allSettled([accountCheck, serverCheck, tokenCheck]);
      const admin = !adminToken ? 'missing' : token.status === 'fulfilled' ? (token.value ? 'working' : 'failed')
        : account.status === 'rejected' || server.status === 'rejected' ? 'unverified' : 'failed';
      return { account: account.status === 'fulfilled', server: server.status === 'fulfilled', admin, checkedAt: Date.now() };
    });
    // A Plex admin token is saved only once Plex vouches for it as the server owner's.
    routes.put('/api/v1/admin/keys', async req => {
      const { grant } = viewer(req), input = serviceKeysInput.parse(req.body);
      if (input.plex) await background.check(input.plex).catch((e: AppError) => { throw e.code === 'PLEX_TOKEN_NOT_OWNER' || e.code === 'PLEX_UNAVAILABLE' ? e : new AppError('PLEX_TOKEN_REJECTED', 'Plex didn’t accept that token.', 400); });
      const saved = serviceKeys.update(grant.accountId, input); background.invalidate(); bus.emit('service-keys.changed', { plex: input.plex !== undefined });
      return saved;
    });
    const asOwner = { config: { access: 'owner' as const } };
    const editing = new Set<string>();
    async function editUser<T>(key: string, action: () => Promise<T>) {
      requireThat(!editing.has(key), 'USER_CHANGE_IN_PROGRESS', 'A change for this Plex user is already in progress.', 409);
      editing.add(key);
      try { return await action(); }
      finally { editing.delete(key); }
    }
    async function listUsers(req: FastifyRequest): Promise<PlexUsersView> {
      const { hash, grant } = viewer(req);
      const { users, directoryIncomplete } = await plex.plexUsers(identity.accountToken(hash));
      return {
        admins: admins.list(), ownerTokenSaved: serviceKeys.view().plex, ownerId: grant.accountId, ownerName: grant.name,
        directoryIncomplete, canRevoke: !readOnly(),
        users: [...users.values()].map(person => {
          const { access, ...user } = person;
          return { ...user, access: user.accountId === grant.accountId || access.some(share => !share.pending) ? 'granted' : access.length ? 'pending' : 'none',
            canAdmin: user.accountId !== grant.accountId && canManageTkBox(person) };
        }),
      };
    }
    async function setAdmin(req: FastifyRequest) {
      const { hash, grant } = viewer(req);
      const { accountId, admin } = z.object({ accountId: plexAccountId, name: z.string().max(200).optional(), admin: z.boolean() }).strict().parse(req.body);
      requireThat(accountId !== grant.accountId, 'VALIDATION_FAILED', 'The server owner is always an admin.');
      return editUser(accountId, async () => {
        if (!admin) return { admins: admins.remove(grant.accountId, accountId) };
        const { users } = await plex.plexUsers(identity.accountToken(hash));
        const user = users.get(accountId);
        requireThat(user && canManageTkBox(user),
          'PLEX_SHARE_REQUIRED', 'Grant Plex library access before making this user an admin.', 409);
        return { admins: admins.add(grant.accountId, accountId, user.name, grant.accountId) };
      });
    }
    for (const path of ['/api/v1/admin/users', '/api/v1/admin/admins']) {
      routes.get(path, asOwner, listUsers);
      routes.post(path, asOwner, setAdmin);
    }
    routes.delete('/api/v1/admin/users/:key/plex-access', asOwner, async req => {
      requireWritable();
      const { hash, grant } = viewer(req);
      const { key } = z.object({ key: z.string().regex(/^(?:(?:share|items)-)?\d{1,20}$/) }).parse(req.params);
      requireThat(key !== grant.accountId, 'VALIDATION_FAILED', 'The server owner’s access cannot be removed.');
      return editUser(key, async () => {
        const token = identity.accountToken(hash);
        const { users } = await plex.plexUsers(token);
        const user = users.get(key);
        requireThat(user?.access.length, 'PLEX_SHARE_NOT_FOUND', 'This user no longer has a share on this Plex server.', 404);
        const changes = await Promise.allSettled([...new Set(user.access.map(share => share.path))].map(path => plex.revokePlexShare(token, path)));
        const failure = changes.find(change => change.status === 'rejected');
        if (failure) throw failure.reason;
        admins.revokePlexAccess(grant.accountId, key, user.accountId);
        return { revoked: true };
      });
    });
    routes.get('/api/v1/admin/settings/playback', async () => ({ ...settings.get(), activeVideoEncoders: budget.count, customBuffer: customBuffer() }));
    routes.patch('/api/v1/admin/settings/playback', async req => {
      const { grant } = viewer(req), input = playbackSettings.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(req.body);
      const { expectedRevision, ...value } = input; return settings.update(grant.accountId, expectedRevision, value);
    });
    return { api: {} };
  }
});
