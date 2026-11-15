import { defineModule } from './module.js';
import { ClientEvents, registerEvents } from '../events-api.js';
import type { PlexGrant } from '../providers/plex.js';

// Open pages hear when artwork or cleanup jobs change the library, and a viewer's pages when one of their requests
// changes, and reload what they show; and their bell when their notifications (for admins, also the shared ones) change.
export const clientEventsModule = defineModule({
  name: 'client-events',
  portal: true,
  setup(routes, { bus }, { isAdmin }: { isAdmin: (grant: PlexGrant) => boolean }) {
    const events = new ClientEvents();
    bus.on('library.edited', () => events.publish('library'));
    bus.on('requests.changed', ({ accountId }) => { if (accountId) events.publish('requests', accountId); });
    bus.on('notifications.changed', ({ to }) => events.publish('notifications', to));
    bus.on('library.grab.changed', () => events.publish('downloads', 'admins'));
    const close = registerEvents(routes, events, isAdmin);
    return { api: {}, stop: close };
  }
});
