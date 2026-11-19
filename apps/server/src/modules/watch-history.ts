import { defineModule } from './module.js';
import { watchHistoryMigrations } from './migrations/watch-history.js';
import { HistoryStore } from '../persistence/history-store.js';
import { PlaybackHistory } from '../services/playback-history.js';
import { PlexPlaybackMonitor } from '../services/plex-playback-monitor.js';
import { registerHistory } from '../history-api.js';
import { HistoryReports } from '../persistence/history-reports.js';
import type { PlexIndex } from '../services/plex-index.js';
import type { HistoryEnd, HistoryMedia } from '../persistence/history-store.js';
import type { SessionEnd } from '../services/playback-sessions.js';
import { errorDetail } from '../lib/every.js';
import type { EventBus } from './bus.js';

type Deps = {
  // The title identity: each movie's and episode's TMDB/TVDB ids are saved with it.
  plexIndex: Pick<PlexIndex, 'resolve' | 'onChange'>;
};

// How a playback session's end is recorded. A server-side end (channel removed, relay failed, shutting down) may
// still reattach when the viewer's player starts again.
export const historyEnd = (reason: SessionEnd): HistoryEnd => reason === 'removed' || reason === 'closing' ? 'interrupted' : reason;

// tk.box's own streams, from the playback session registry: recorded from their start, ended however they end.
// Observations (the player's evidence of watching) still come straight from the progress routes.
export function recordSessions(bus: Pick<EventBus, 'on'>, history: Pick<PlaybackHistory, 'open' | 'end'>) {
  bus.on('session.started', ({ history: h }) => { if (h) history.open(h.entry, h.previousId, Date.now(), h.sameStation); });
  bus.on('session.ended', ({ id, reason }) => history.end(id, historyEnd(reason)));
}

// A movie's or episode's TMDB/TVDB ids (an episode's: its show's) from the title identity. Only this server's media:
// the index is of this server.
export const historyTitleIds = (server: () => string | undefined, titles: Pick<PlexIndex, 'resolve'>) => (media: HistoryMedia) => {
  const serverId = server();
  if (!serverId || media.serverId !== serverId) return undefined;
  const kind = media.type === 'movie' ? 'movie' : 'show';
  const found = [media.type === 'episode' ? media.showId : undefined, media.ratingKey].flatMap(key => {
    const ids = key ? titles.resolve({ ratingKey: key }) : undefined;
    return ids?.kind === kind ? [ids] : [];
  })[0];
  return found && { tmdb: found.tmdb, ...(found.tvdb ? { tvdb: found.tvdb } : {}) };
};
// Fills the ids of rows recorded before their title could be identified; returns how many it filled.
export function fillTitleIds(store: Pick<HistoryStore, 'unidentified' | 'identify'>, serverId: string | undefined) {
  if (!serverId) return { filled: 0, left: 0 };
  const rows = store.unidentified(serverId), filled = rows.length ? store.identify(rows) : 0;
  return { filled, left: rows.length - filled };
}

// The saved watch dates' movies and shows the title identity now knows get their ids; returns how many titles.
export function fillImportedIds(store: Pick<HistoryStore, 'unidentifiedImports' | 'identifyImports'>, serverId: string | undefined, titles: Pick<PlexIndex, 'resolve'>) {
  if (!serverId) return { filled: 0, left: 0 };
  const rows = store.unidentifiedImports(serverId);
  const found = rows.flatMap(r => {
    const ids = titles.resolve({ ratingKey: r.ratingKey });
    return ids && ids.kind === r.scope && ids.season === undefined ? [{ ...r, tmdb: ids.tmdb, ...(ids.tvdb ? { tvdb: ids.tvdb } : {}) }] : [];
  });
  if (found.length) store.identifyImports(serverId, found);
  return { filled: found.length, left: rows.length - found.length };
}

// Who watched what on one Plex server: tk.box's own history (its players and Plex's apps) and the saved watch dates.
// `scope` is movie, show or season; account '' (saved dates only) is anyone.
export type Watch = { scope: 'movie' | 'show' | 'season'; ratingKey: string; account: string; at: number; tmdb?: number; tvdb?: number;
  plays?: number; title?: string; year?: number };
// Without `account`: each title's and season's latest watch by each account (Clean Up's rules). With it: that account's
// movies and shows, newest first with plays, title and year, then its saved dates (Explore's suggestions).
// `seasons: false` leaves out season rows.
export function serverWatches(store: Pick<HistoryStore, 'latestWatches' | 'accountWatches' | 'importedWatches'>, serverId: string,
  { account, seasons = true }: { account?: string; seasons?: boolean } = {}): Watch[] {
  const own: Watch[] = account === undefined ? store.latestWatches(serverId)
    : store.accountWatches(serverId, account).map(({ kind, ratingKey, tmdb, title, year, at, plays }) => ({ scope: kind, ratingKey, account, at, plays,
      ...(tmdb ? { tmdb } : {}), ...(title ? { title } : {}), ...(year ? { year } : {}) }));
  const saved = store.importedWatches(serverId).flatMap(({ tmdb, tvdb, ...w }): Watch[] => account !== undefined && w.account !== account ? []
    : [{ ...w, ...(tmdb ? { tmdb } : {}), ...(tvdb ? { tvdb } : {}) }]);
  return [...own, ...saved].filter(w => seasons || w.scope !== 'season');
}

// Watch history: what each account watched, in tk.box (the playback session registry's streams) and in Plex's own apps (read
// by the Plex playback monitor), and Admin › History, which reports on it. Each movie and episode is saved with its
// TMDB/TVDB ids (an episode's: its show's), so other modules can join history to titles without asking Plex.
export const watchHistoryModule = defineModule({
  name: 'watch-history',
  migrations: watchHistoryMigrations,
  setup(routes, { config, db, plex, bus, plexOwner, log }, { plexIndex }: Deps) {
    const store = new HistoryStore(db, historyTitleIds(() => config.PLEX_MACHINE_ID, plexIndex));
    // Rows recorded before their title could be identified are filled after each index rebuild.
    plexIndex.onChange(() => {
      try {
        const done = fillTitleIds(store, config.PLEX_MACHINE_ID);
        if (done.filled) log.info('watch history: title ids filled', done);
        const saved = fillImportedIds(store, config.PLEX_MACHINE_ID, plexIndex);
        if (saved.filled) log.info('watch history: saved watch dates’ title ids filled', saved);
      } catch (e) { log.warn('watch history: title ids could not be filled', errorDetail(e)); }
    });
    const history = new PlaybackHistory(store, message => log.warn(message));
    // Plex's own apps. The Plex notifications module feeds it playback states (bus); Admin › Activity and the artwork
    // schedule read its sessions.
    const monitor = new PlexPlaybackMonitor(plex, history, () => plexOwner.grant(), () => config.PLEX_MACHINE_ID, message => log.warn(message));
    recordSessions(bus, history);
    bus.on('plex.playback.states', ({ states }) => monitor.states(states));
    bus.on('plex.playback.connection', ({ connected }) => monitor.connection(connected));
    // The registry has ended this browser's open streams by now (it mounts first); this ends the ones that may still reattach.
    bus.on('session.signed-out', ({ hash }) => history.endOwner(hash));
    registerHistory(routes, new HistoryReports(db));
    return {
      // `watches`: who watched what on this server (tk.box's history and the saved dates), for Clean Up and Explore.
      api: { history, monitor, watches: (serverId: string, options?: { account?: string; seasons?: boolean }) => serverWatches(store, serverId, options) },
      start() { history.start(); monitor.start(); },
      stop() { monitor.close(); history.close(); store.close(); }
    };
  }
});
