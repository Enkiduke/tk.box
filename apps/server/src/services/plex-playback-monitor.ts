import { randomUUID } from 'node:crypto';
import type { HistorySession } from '../persistence/history-store.js';
import type { PlexAdapter, PlexGrant, PlexSession } from '../providers/plex.js';
import type { PlaybackHistory } from './playback-history.js';
import type { PlexPlaybackState } from './plex-notifications.js';
import { digest } from '../security/vault.js';

const OWNER = 'plex-monitor';
const ACTIVE_MS = 30000, IDLE_MS = 180000, SNAPSHOT_MS = 4000;
const MAX_SESSIONS = 512;
type Track = {
  id: string; ratingKey: string; accountId: string; stream: HistorySession['stream']; sequence: number;
  last: number; lastEvent?: number; snapshotId?: string; player?: string; epoch: number; position?: number; state?: string;
};
type PendingEvent = { state: PlexPlaybackState; at: number };
type Snapshot = { rows: PlexSession[]; local: { sessionKey: string; ratingKey: string }[]; at: number };
type Cached = { token: string; snapshot?: Snapshot; pending?: Promise<Snapshot> };

function streamDetails(row: PlexSession): HistorySession['stream'] {
  const t = row.TranscodeSession, media = row.Media?.[0], decision = media?.Part?.[0]?.decision;
  const video = t?.videoDecision;
  return { delivery: video === 'transcode' || decision === 'transcode' ? 'transcode' : t || decision === 'copy' ? 'remux' : 'direct',
    video, audio: t?.audioDecision, sourceHeight: media?.height, sourceWidth: media?.width, outputHeight: t?.height };
}

export class PlexPlaybackMonitor {
  private tracks = new Map<string, Track>();
  private local = new Map<string, string>();
  private queued = new Map<string, { events: PendingEvent[]; expires: number }>();
  private ownerCache?: Cached;
  private viewerCache?: Cached;
  private lastApplied?: Snapshot;
  private token?: string;
  private namespace?: string;
  private timer?: NodeJS.Timeout;
  private closed = true;
  private connected = false;
  private lastPlaybackEvent = 0;
  private refreshAfter = 0;
  private scheduledAt = 0;
  private refreshing = false;
  private failures = 0;
  private epoch = 0;

  constructor(private plex: Pick<PlexAdapter, 'sessionSnapshot'>, private history: PlaybackHistory,
    private ownerGrant: () => Promise<PlexGrant | undefined>,
    private serverId: () => string | undefined, private log = (_message: string) => {}, private now = Date.now) {}

  start() {
    this.closed = false;
    this.schedule(0);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const track of this.tracks.values()) this.history.end(track.id, 'interrupted');
    this.tracks.clear();
    this.local.clear();
    this.queued.clear();
    this.lastApplied = undefined;
    this.ownerCache = undefined;
    this.viewerCache = undefined;
    this.token = undefined;
  }

  connection(connected: boolean) {
    if (this.closed) return;
    this.connected = connected;
    this.epoch++;
    this.ownerCache = undefined;
    this.viewerCache = undefined;
    this.lastApplied = undefined;
    this.queued.clear();
    this.local.clear();
    for (const track of this.tracks.values()) {
      track.epoch++;
      track.position = undefined;
      track.state = undefined;
      track.lastEvent = undefined;
      this.history.suspend(track.id, OWNER);
    }
    this.schedule(0);
  }

  // Reuse only results obtained with the same Plex credential. A delegated admin without
  // the saved owner grant gets their own Plex view and cannot receive a cached owner response.
  async sessions(grant: PlexGrant) {
    return (await this.snapshot(grant)).rows;
  }

  private snapshot(grant: PlexGrant) {
    const token = grant.serverToken;
    const slot = token === this.token ? 'ownerCache' : 'viewerCache';
    const alternate = slot === 'ownerCache' ? this.viewerCache : undefined;
    const current = this[slot] ?? (alternate?.token === token ? this[slot] = alternate : undefined);
    const cache = current?.token === token ? current : this[slot] = { token };
    if (cache.pending) return cache.pending;
    if (cache.snapshot && this.now() - cache.snapshot.at < SNAPSHOT_MS) return Promise.resolve(cache.snapshot);
    cache.pending = this.plex.sessionSnapshot(grant).then(snapshot => cache.snapshot = { ...snapshot, at: this.now() }).finally(() => { cache.pending = undefined; });
    return cache.pending;
  }

  states(events: PlexPlaybackState[]) {
    if (this.closed) return;
    const now = this.now();
    this.lastPlaybackEvent = now;
    for (const state of events) {
      if (this.local.get(state.sessionKey) === state.ratingKey) {
        if (state.state === 'stopped' || state.state === 'error') this.local.delete(state.sessionKey);
        continue;
      }
      const track = this.tracks.get(state.sessionKey);
      if (track?.ratingKey === state.ratingKey) {
        track.lastEvent = now;
        this.sample(track, state.state, state.viewOffset, now);
        if (state.state === 'stopped' || state.state === 'error') {
          this.history.end(track.id, state.state === 'stopped' ? 'stopped' : 'interrupted', now);
          this.tracks.delete(state.sessionKey);
          this.enqueue(state, now);
        }
        continue;
      }
      if (track && state.state === 'playing') {
        this.history.end(track.id, 'interrupted', now);
        this.tracks.delete(state.sessionKey);
      }
      // Events carry no account or client identity until matched to an authoritative snapshot.
      if (state.state !== 'error') this.enqueue(state, now);
    }
  }

  private enqueue(state: PlexPlaybackState, at: number) {
    const pending = this.queued.get(state.sessionKey);
    if (!pending && this.queued.size >= MAX_SESSIONS) return;
    const queue = pending && pending.expires > at ? pending : { events: [], expires: at + 15000 };
    if (queue.events.length >= 8) queue.events.splice(1, 1);
    queue.events.push({ state, at });
    this.queued.set(state.sessionKey, queue);
    this.schedule(Math.max(0, this.refreshAfter - at));
  }

  private sample(track: Track, state: string | undefined, offset: number | undefined, at: number) {
    if (at < track.last) return;
    if (state === 'error') { this.history.suspend(track.id, OWNER); return; }
    if (state !== 'playing' && state !== 'paused' && state !== 'buffering' && state !== 'stopped') return;
    if (offset === undefined || !Number.isSafeInteger(offset) || offset < 0) {
      track.state = undefined;
      this.history.suspend(track.id, OWNER);
      return;
    }
    // Repeated offsets in admin reads and websocket bursts are not new playback observations.
    if (state === 'playing' && track.state === state && track.position === offset) return;
    track.last = at;
    track.state = state;
    track.position = offset;
    this.history.observe(track.id, OWNER, { state, positionMs: offset, sequence: ++track.sequence, elapsedMs: at, rate: 1 },
      at, { epoch: track.epoch, stream: track.stream });
  }

  private apply(snapshot: Snapshot, server: string, ownerId: string) {
    this.local.clear();
    for (const item of snapshot.local.slice(0, MAX_SESSIONS)) {
      this.local.set(item.sessionKey, item.ratingKey);
      this.queued.delete(item.sessionKey);
    }
    const seen = new Set<string>();
    for (const row of snapshot.rows.slice(0, MAX_SESSIONS)) {
      const key = row.sessionKey ?? row.Session?.id, { ratingKey, title, type, duration, librarySectionID } = row;
      // PMS represents the local owner as account 1 in session snapshots.
      const accountId = row.User?.id === '1' ? ownerId : row.User?.id;
      if (!key || !/^[\w-]{1,100}$/.test(key) || !ratingKey || !/^\d{1,40}$/.test(ratingKey) || !title || !accountId ||
          !/^\d{1,40}$/.test(accountId) || (type !== 'movie' && type !== 'episode') || row.live || !duration || duration <= 0 ||
          (!row.Player?.product && !row.Player?.machineIdentifier)) continue;
      seen.add(key);
      let track = this.tracks.get(key);
      if (track && (track.ratingKey !== ratingKey || track.accountId !== accountId || track.snapshotId !== row.Session?.id ||
          track.player !== row.Player?.machineIdentifier)) {
        this.history.end(track.id, 'interrupted', snapshot.at);
        this.tracks.delete(key);
        track = undefined;
      }
      const stream = streamDetails(row);
      const pending = this.queued.get(key);
      const observations = pending && pending.expires >= snapshot.at ? pending.events.filter(e => e.state.ratingKey === ratingKey) : [];
      if (observations.at(-1)?.state.state === 'stopped' || observations.at(-1)?.state.state === 'error') continue;
      this.queued.delete(key);
      if (!track) {
        if (this.tracks.size >= MAX_SESSIONS) continue;
        const id = row.Session?.id ? digest(JSON.stringify([server, key, row.Session.id, ratingKey, accountId, row.Player?.machineIdentifier])) : randomUUID();
        track = { id, ratingKey, accountId, stream, sequence: 0, last: 0, epoch: 0,
          snapshotId: row.Session?.id, player: row.Player?.machineIdentifier };
        this.tracks.set(key, track);
        this.history.open({ id: track.id, owner: OWNER, accountId, accountName: row.User?.title, source: 'plex', stream,
          client: [row.Player?.product, row.Player?.platform].filter(Boolean).join(' · ') || 'Plex app',
          media: { serverId: server, ratingKey, title, type, durationMs: duration, libraryId: librarySectionID ?? '',
            year: row.year, showId: row.grandparentRatingKey, showTitle: row.grandparentTitle, seasonId: row.parentRatingKey,
            season: row.parentIndex, episode: row.index }
        }, row.Session?.id ? id : undefined, snapshot.at);
      }
      track.stream = stream;
      for (const observation of observations) {
        if (observation.state.state === 'stopped' || observation.state.state === 'error') continue;
        track.lastEvent = observation.at;
        this.sample(track, observation.state.state, observation.state.viewOffset, observation.at);
      }
      if (track.lastEvent === undefined || snapshot.at - track.lastEvent > 15000) this.sample(track, row.Player?.state, row.viewOffset, snapshot.at);
    }
    for (const [key, track] of this.tracks) {
      if (!seen.has(key) || snapshot.at - track.last > 120000) {
        this.history.end(track.id, 'interrupted', snapshot.at);
        this.tracks.delete(key);
      }
    }
    for (const [key, value] of this.queued) if (value.expires <= snapshot.at) this.queued.delete(key);
  }

  private schedule(delay: number) {
    if (this.closed || this.refreshing) return;
    const when = this.now() + delay;
    if (this.timer && this.scheduledAt <= when) return;
    clearTimeout(this.timer);
    this.scheduledAt = when;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
    this.timer.unref();
  }

  async refresh() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    const server = this.serverId();
    const epoch = this.epoch;
    let delay = IDLE_MS;
    try {
      const grant = server ? await this.ownerGrant() : undefined;
      if (this.closed || epoch !== this.epoch) { delay = 0; return; }
      if (grant && server) {
        if (this.namespace && (this.namespace !== server || this.token !== grant.serverToken)) {
          for (const track of this.tracks.values()) this.history.end(track.id, 'interrupted', this.now());
          this.tracks.clear();
          this.queued.clear();
        }
        this.namespace = server;
        this.token = grant.serverToken;
        const snapshot = await this.snapshot(grant);
        if (this.closed || epoch !== this.epoch) { delay = 0; return; }
        if (snapshot !== this.lastApplied) {
          this.apply(snapshot, server, grant.accountId);
          this.lastApplied = snapshot;
        }
        this.refreshAfter = this.now() + SNAPSHOT_MS;
        this.failures = 0;
        delay = this.queued.size ? SNAPSHOT_MS : this.tracks.size ? ACTIVE_MS :
          this.connected && this.now() - this.lastPlaybackEvent < IDLE_MS ? IDLE_MS * 2 : IDLE_MS;
      } else {
        this.queued.clear();
        this.local.clear();
        this.ownerCache = undefined;
        this.lastApplied = undefined;
        for (const track of this.tracks.values()) this.history.end(track.id, 'interrupted');
        this.tracks.clear();
        delay = 60000;
      }
    } catch {
      if (!this.failures) this.log('Plex session snapshot unavailable');
      delay = Math.min(IDLE_MS, SNAPSHOT_MS * 2 ** Math.min(++this.failures, 6));
      this.refreshAfter = this.now() + delay;
      for (const track of this.tracks.values()) {
        track.epoch++;
        this.history.suspend(track.id, OWNER);
      }
    } finally {
      this.refreshing = false;
      this.schedule(delay);
    }
  }
}
