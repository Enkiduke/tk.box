import type { Finished, PlexPlaybackState } from '../services/plex-notifications.js';
import type { PlexGrant } from '../providers/plex.js';
import type { RequestChange } from '../services/requests.js';
import type { NewNotification, NotificationTarget, Resolution } from '../persistence/notifications-store.js';
import type { GrabState } from '../persistence/library-store.js';
import type { SessionEnd, SessionHistory, StreamKind } from '../services/playback-sessions.js';

export type TitleChange = 'added' | 'monitor' | 'file' | 'removed';

// In-process events between modules. A module announces what changed; others react, without either holding the other.
// Listeners run synchronously in subscription order, and one listener's failure is logged without stopping the rest.
export type BusEvents = {
  // A playlist or guide snapshot was published (refresh, upload or accepted review).
  'iptv.source.published': { sourceId: string };
  // Admin › Connections saved new keys; `plex` when the Plex admin token was among them.
  'service-keys.changed': { plex: boolean };
  // Plex finished processing titles in these library sections, or 'any' after a scan or a dropped connection.
  'plex.library.changed': { sections: Finished };
  // An artwork or cleanup job finished and may have changed titles, posters or collections in Plex.
  'library.edited': { by: 'artwork' | 'cleanup' };
  // The Plex notification feed is about to connect with the owner's grant (artwork reads which libraries to watch).
  'plex.notifications.connecting': { grant: PlexGrant };
  // Playback states from Plex's own apps, and whether the feed carrying them is connected.
  'plex.playback.states': { states: PlexPlaybackState[] };
  'plex.playback.connection': { connected: boolean };
  // A browser session signed out: everything it was watching stops.
  'session.signed-out': { hash: string };
  // A playback session (VOD, IPTV or custom channel) started or ended, from the one session registry
  // (modules/playback-sessions.ts). `media`: the title's rating key, or the channel. `history`: what watch history records.
  'session.started': { id: string; kind: StreamKind; hash: string; accountId: string; media?: string; history?: SessionHistory };
  'session.ended': { id: string; kind: StreamKind; hash: string; accountId: string; media?: string; reason: SessionEnd };
  // A request was made, sent, moved on (Plex, the library), cancelled or removed. `accountId` is the requester's.
  'requests.changed': RequestChange;
  // Post a notification, or close an open condition (modules/notifications.ts), without depending on that module.
  'notification.post': NewNotification;
  'notification.resolve': { to: NotificationTarget; key: string; resolution?: Resolution };
  // The library (docs/ARR-REPLACEMENT.md): a grab moved on (sent, downloading, importing, imported, failed); a file was
  // imported and Plex told to scan its folder; a title changed: added (or added again), its Monitored switch or a
  // season's turned, a file deleted or replaced (`paths`: the files that went), or removed (`by` Clean Up, an admin, or
  // a collection letting it go; `paths`: its files' records that went).
  'library.grab.changed': { grabId: number; titleId: number; state: GrabState };
  'library.file.imported': { titleId: number; fileId: number; path: string; kind: 'movie' | 'show'; tmdbId: number };
  'library.title.changed': { titleId: number; kind: 'movie' | 'show'; tmdbId: number; change: TitleChange; by?: string; paths?: string[] };
  // A collections run wants these movies (seasonal downloads): the library adds those it lacks, and
  // deletes those in `removeIds` that it added for collections and nobody has requested or kept since.
  'collections.acquire': { tmdbIds: number[]; removeIds: number[] };
  // Someone's notifications changed (`to`: an account id, or 'admins' for every admin); their pages read them again.
  'notifications.changed': { to: NotificationTarget };
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
