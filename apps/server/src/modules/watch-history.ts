import { defineModule } from './module.js';
import { HistoryStore } from '../persistence/history-store.js';
import { PlaybackHistory } from '../services/playback-history.js';
import { PlexPlaybackMonitor } from '../services/plex-playback-monitor.js';
import { registerHistory } from '../history-api.js';

// Watch history: what each account watched, in tk.box (reported by the playback modules) and in Plex's own apps (read
// by the Plex playback monitor), and Admin › History, which reports on it.
export const watchHistoryModule = defineModule({
  name: 'watch-history',
  setup(routes, { config, db, plex, bus, background, log }) {
    const store = new HistoryStore(db);
    const history = new PlaybackHistory(store, message => log.warn(message));
    // Plex's own apps. The Plex notifications module feeds it playback states (bus); Admin › Activity and the artwork
    // schedule read its sessions.
    const monitor = new PlexPlaybackMonitor(plex, history, () => background.grant(), () => config.PLEX_MACHINE_ID, message => log.warn(message));
    // A live or custom channel viewer the server ended (reaped, channel removed) may still reattach.
    bus.on('live.viewer.ended', ({ sessionId }) => history.end(sessionId, 'interrupted'));
    bus.on('plex.playback.states', ({ states }) => monitor.states(states));
    bus.on('plex.playback.connection', ({ connected }) => monitor.connection(connected));
    bus.on('session.signed-out', ({ hash }) => history.endOwner(hash));
    registerHistory(routes, db);
    return {
      api: { history, monitor },
      start() { history.start(); monitor.start(); },
      stop() { monitor.close(); history.close(); store.close(); }
    };
  }
});
