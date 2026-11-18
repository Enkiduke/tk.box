import { defineModule } from './module.js';
import { ClientEvents, registerEvents, type ClientEvent } from '../events-api.js';
import type { IdentityService } from '../services/identity.js';

// Plex reports a scan as a burst of changes, and an import of a season as one per episode: pages hear the burst once.
const LIBRARY_GROUP_MS = 3000, DOWNLOADS_GROUP_MS = 1000;

// Open pages reload what they show when the library changes: an artwork or cleanup job finished (at once), a file was
// imported, a title added, switched, removed or its files deleted, or Plex's own library changed (grouped). A
// viewer's pages hear when one of their requests changes; their bell when their notifications (for admins, also the shared ones) change; admins' pages when a
// download moves on.
export const clientEventsModule = defineModule({
  name: 'client-events',
  portal: true,
  // `identity.isAdmin`: owners and the accounts made admins hear the admins' events.
  setup(routes, { bus }, { identity }: { identity: Pick<IdentityService, 'isAdmin'> }) {
    const events = new ClientEvents(), timers = new Set<NodeJS.Timeout>(), waiting = new Set<string>();
    const grouped = (event: ClientEvent, ms: number, to?: string) => () => {
      const key = `${event}:${to ?? ''}`;
      if (waiting.has(key)) return;
      waiting.add(key);
      const timer = setTimeout(() => { timers.delete(timer); waiting.delete(key); events.publish(event, to); }, ms);
      timer.unref(); timers.add(timer);
    };
    const libraryChanged = grouped('library', LIBRARY_GROUP_MS);
    bus.on('library.edited', () => events.publish('library'));
    bus.on('library.file.imported', libraryChanged);
    bus.on('library.title.changed', libraryChanged);
    bus.on('plex.library.changed', libraryChanged);
    bus.on('requests.changed', ({ accountId }) => { if (accountId) events.publish('requests', accountId); });
    bus.on('notifications.changed', ({ to }) => events.publish('notifications', to));
    bus.on('library.grab.changed', grouped('downloads', DOWNLOADS_GROUP_MS, 'admins'));
    const close = registerEvents(routes, events, grant => identity.isAdmin(grant));
    return { api: {}, stop() { for (const t of timers) clearTimeout(t); timers.clear(); close(); } };
  }
});
