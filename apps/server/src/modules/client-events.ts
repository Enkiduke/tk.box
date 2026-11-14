import { defineModule } from './module.js';
import { ClientEvents, registerEvents } from '../events-api.js';

// Open pages hear when artwork or cleanup jobs change the library, and a viewer's pages when one of their requests
// changes, and reload what they show.
export const clientEventsModule = defineModule({
  name: 'client-events',
  setup(routes, { bus }) {
    const events = new ClientEvents();
    bus.on('library.edited', () => events.publish('library'));
    bus.on('requests.changed', ({ accountId }) => { if (accountId) events.publish('requests', accountId); });
    const close = registerEvents(routes, events);
    return { api: {}, stop: close };
  }
});
