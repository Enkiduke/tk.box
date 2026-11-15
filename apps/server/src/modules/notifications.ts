import { z } from 'zod';
import { defineModule } from './module.js';
import { viewer } from './access.js';
import { notificationsMigrations } from './migrations/notifications.js';
import { NotificationStore, type NewNotification, type NotificationTarget, type Resolution } from '../persistence/notifications-store.js';
import type { PlexGrant } from '../providers/plex.js';
import { every, errorDetail } from '../lib/every.js';
import { requireThat } from '../errors.js';

type Deps = { isAdmin: (grant: PlexGrant) => boolean };
const PRUNE_MS = 3600000;
const since = z.object({ since: z.coerce.number().int().nonnegative().optional() }).strict();
const read = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).strict()]);
const id = z.object({ id: z.coerce.number().int().positive() }).strict();

// Alerts behind the bell (docs/NOTIFICATIONS.md): stored per account, or shared by the admins. Other modules post
// through `notify`/`resolve`, or the `notification.post` / `notification.resolve` bus events. Every change is
// `notifications.changed` on the bus, which client-events passes to the pages that should read the list again.
export const notificationsModule = defineModule({
  name: 'notifications',
  portal: true,
  migrations: notificationsMigrations,
  setup(routes, { db, bus, log }, { isAdmin }: Deps) {
    const store = new NotificationStore(db);
    const changed = (to: NotificationTarget) => bus.emit('notifications.changed', { to });
    const notify = (n: NewNotification) => { const r = store.post(n); if (r.changed) changed(n.to); return r.id; };
    const resolve = (to: NotificationTarget, key: string, resolution?: Resolution) => { const done = store.resolve(to, key, resolution); if (done) changed(to); return done; };
    bus.on('notification.post', n => { notify(n); });
    bus.on('notification.resolve', ({ to, key, resolution }) => { resolve(to, key, resolution); });

    const who = (request: Parameters<typeof viewer>[0]) => { const { grant } = viewer(request); return { account: grant.accountId, admin: isAdmin(grant) }; };
    routes.get('/api/v1/notifications', { config: { access: 'viewer' } }, async request => {
      const { account, admin } = who(request);
      return store.list(account, admin, since.parse(request.query).since);
    });
    // Read and dismissed are per account; the account's other pages hear of it and update their bell.
    routes.post('/api/v1/notifications/read', { config: { access: 'viewer' } }, async request => {
      const { account, admin } = who(request), body = read.parse(request.body);
      const count = store.markRead(account, admin, 'all' in body ? 'all' : body.ids);
      if (count) changed(account);
      return { read: count };
    });
    routes.delete('/api/v1/notifications', { config: { access: 'viewer' } }, async request => {
      const { account, admin } = who(request), count = store.dismissAll(account, admin);
      if (count) changed(account);
      return { dismissed: count };
    });
    routes.delete('/api/v1/notifications/:id', { config: { access: 'viewer' } }, async request => {
      const { account, admin } = who(request);
      requireThat(store.dismiss(account, admin, id.parse(request.params).id), 'NOT_FOUND', 'That notification is gone.', 404);
      changed(account);
      return { dismissed: true };
    });

    let prune: { stop(): void } | undefined;
    const pruneNow = () => { const gone = store.prune(); if (gone) log.info('notifications pruned', { gone }); };
    return {
      api: { store, notify, resolve },
      start() {
        try { pruneNow(); } catch (e) { log.warn('notification prune failed', errorDetail(e)); }
        prune = every(PRUNE_MS, pruneNow, e => log.warn('notification prune failed', errorDetail(e)));
      },
      stop() { prune?.stop(); }
    };
  }
});
