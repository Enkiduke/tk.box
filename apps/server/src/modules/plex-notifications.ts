import { defineModule } from './module.js';
import { PlexNotifications } from '../services/plex-notifications.js';

// Plex's notification feed, opened with the owner's saved Plex admin token: finished titles become
// `plex.library.changed`, playback in Plex's own apps `plex.playback.states`. A new Plex admin token reconnects it.
export const plexNotificationsModule = defineModule({
  name: 'plex-notifications',
  setup(_routes, { plex, bus, background, log }) {
    const notifications = new PlexNotifications(async () => {
      const grant = await background.grant();
      if (!grant) return;
      bus.emit('plex.notifications.connecting', { grant });
      return plex.notificationSocket(grant);
    }, sections => bus.emit('plex.library.changed', { sections }), (message, detail) => log.warn(message, detail),
    { states: states => bus.emit('plex.playback.states', { states }), connected: connected => bus.emit('plex.playback.connection', { connected }) });
    bus.on('service-keys.changed', ({ plex: token }) => { if (token) notifications.reconnect(); });
    return { api: {}, start() { notifications.start(); }, stop() { notifications.close(); } };
  }
});
