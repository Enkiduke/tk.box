import type { Finished, PlexPlaybackState } from '../services/plex-notifications.js';
import type { PlexGrant } from '../providers/plex.js';
import type { RequestChange } from '../services/requests.js';

// In-process events between modules. A module announces what changed; others react, without either holding the other.
// Listeners run synchronously in subscription order, and one listener's failure is logged without stopping the rest.
export type BusEvents = {
  // A playlist or guide snapshot was published (refresh, upload or accepted review).
  'iptv.source.published': { sourceId: string };
  // Admin › Connections saved new keys; `plex` when the Plex admin token was among them.
  'service-keys.changed': { plex: boolean };
  // Plex finished processing titles in these library sections, or 'any' after a scan or a dropped connection.
  'plex.library.changed': { sections: Finished };
  // A live or custom channel viewer's session ended without the viewer stopping it.
  'live.viewer.ended': { sessionId: string };
  // An artwork or cleanup job finished and may have changed titles, posters or collections in Plex.
  'library.edited': { by: 'artwork' | 'cleanup' };
  // The Plex notification feed is about to connect with the owner's grant (artwork reads which libraries to watch).
  'plex.notifications.connecting': { grant: PlexGrant };
  // Playback states from Plex's own apps, and whether the feed carrying them is connected.
  'plex.playback.states': { states: PlexPlaybackState[] };
  'plex.playback.connection': { connected: boolean };
  // A browser session signed out: everything it was watching stops.
  'session.signed-out': { hash: string };
  // A request was made, sent, moved on (Plex, Radarr/Sonarr), cancelled or removed. `accountId` is the requester's.
  'requests.changed': RequestChange;
};
type Listener<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class EventBus {
  private listeners = new Map<keyof BusEvents, Set<Listener<never>>>();
  constructor(private log: (message: string, detail: object) => void = () => {}) {}
  on<K extends keyof BusEvents>(event: K, listener: Listener<K>) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener as Listener<never>);
    return () => { set.delete(listener as Listener<never>); };
  }
  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]) {
    for (const listener of this.listeners.get(event) ?? []) {
      try { (listener as Listener<K>)(payload); }
      catch (e) { this.log('event listener failed', { event, error: e instanceof Error ? e.name : 'unknown' }); }
    }
  }
}
