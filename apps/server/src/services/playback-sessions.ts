import { AppError, requireThat } from '../errors.js';
import type { PlaybackEntry } from './playback-history.js';

// Every stream tk.box delivers, on-demand, IPTV and custom channels alike: the one registry of playback sessions
// (docs/ARCHITECTURE-AUDIT.md, Phase J). The delivering services open, touch and end their sessions here; it owns
// the idle rule and the per-viewer limit, and announces each start and end (modules/playback-sessions.ts puts them on
// the bus for watch history). Admin › Activity reads its rows from here. Kept in memory only.
//
// A closed browser sends no stop, so a session that stops checking in is ended: a playing title reports every
// 10 seconds and a paused one every minute; live players fetch segments every few seconds, or poll while paused.
export type StreamKind = 'vod' | 'live' | 'custom';
export type StreamDelivery = 'direct' | 'remux' | 'transcode';
export type StreamSource = { videoCodec?: string; audioCodec?: string; width?: number; height?: number; container?: string; bitrateKbps?: number };
// Why a session ended: the viewer stopped it (or switched to another stream: `replacing`), it went idle, Admin ›
// Activity's Stop, the browser signed out (`revoked`), the delivering service ended it (`removed`: channel removed or
// disabled, the relay failed, access lost), or the server is closing.
export type SessionEnd = 'stopped' | 'replacing' | 'idle' | 'admin' | 'revoked' | 'removed' | 'closing';
// What watch history records when the session starts (modules/watch-history.ts): its entry, the stream it continues,
// and for IPTV whether two channels are the same station.
export type SessionHistory = { entry: PlaybackEntry; previousId?: string; sameStation?: (from: string, to: string) => boolean };
export type SessionOpen = {
  id: string; kind: StreamKind; hash: string; accountId: string; user?: string; delivery: StreamDelivery; ip: string; userAgent?: string;
  mediaId?: string; channelId?: string; channel?: { name: string; number: number }; positionMs?: number; durationMs?: number; quality?: string;
  target?: { maxHeight?: number; maxBitrateKbps?: number }; source?: StreamSource; history?: SessionHistory;
};
export type Session = SessionOpen & { started: number; seen: number; state: 'playing' | 'paused'; positionAt: number; sent: { at: number; bytes: number }[] };
// The delivering service's own end of a session: stops its delivery (`stop` may find it already gone).
export type SessionKind = { stop: (s: { id: string; hash: string }) => void };
// A place held for a stream that is still starting (a channel tuning, a transcode being set up), so it counts against
// the limit before it opens.
export type SessionTicket = { readonly kind: StreamKind; readonly hash: string; cancelled?: boolean };
// `total`: streams one sign-in may hold at once, any kind; `perKind`: a lower cap for a kind (IPTV's 4).
export type SessionLimits = { total: number; perKind: Partial<Record<StreamKind, number>> };
// `playing` / `paused`: on-demand; `live`: IPTV and custom channels.
export type SessionIdle = { playing: number; paused: number; live: number };
export const SESSION_LIMITS: SessionLimits = { total: 6, perKind: { live: 4 } };
export const SESSION_IDLE: SessionIdle = { playing: 60000, paused: 150000, live: 45000 };
const RATE_WINDOW_MS = 30000;

export class PlaybackSessions {
  private sessions = new Map<string, Session>();
  private starting = new Set<SessionTicket>();
  private kinds = new Map<StreamKind, SessionKind>();
  onStarted?: (s: Session) => void;
  onEnded?: (s: Session, reason: SessionEnd) => void;
  constructor(private limits: SessionLimits = SESSION_LIMITS, private idleMs: SessionIdle = SESSION_IDLE, private log: (message: string, detail: object) => void = () => {}) {}
  // Each delivering module registers how its sessions are stopped.
  kind(kind: StreamKind, k: SessionKind) {
    if (this.kinds.has(kind)) throw new Error(`Playback session kind ${kind} is already registered.`);
    this.kinds.set(kind, k);
  }
  // Holds a place for a stream about to start, or refuses it over the limit. Pass the ticket to `open`, or `release`
  // it when the start fails.
  reserve(kind: StreamKind, hash: string): SessionTicket {
    const held = [...this.sessions.values(), ...this.starting].filter(s => s.hash === hash);
    requireThat(held.length < this.limits.total, 'PLAYBACK_SESSION_LIMIT', 'Too many streams are open. Stop one first.', 429);
    const cap = this.limits.perKind[kind];
    requireThat(cap === undefined || held.filter(s => s.kind === kind).length < cap, 'PLAYBACK_SESSION_LIMIT',
      kind === 'vod' ? 'Too many titles are playing. Stop one first.' : 'Too many live channels are open. Stop one first.', 429);
    const ticket: SessionTicket = { kind, hash };
    this.starting.add(ticket);
    return ticket;
  }
  release(ticket: SessionTicket) { this.starting.delete(ticket); }
  // Opens the session its ticket held a place for. A ticket whose sign-in signed out meanwhile stops the delivery
  // that just started and refuses it.
  open(ticket: SessionTicket, s: SessionOpen, now = Date.now()) {
    requireThat(ticket.kind === s.kind && ticket.hash === s.hash, 'INVALID_SESSION', 'Session does not match its reservation.', 500);
    this.starting.delete(ticket);
    if (ticket.cancelled) {
      try { this.kinds.get(s.kind)?.stop(s); } catch { /* already gone */ }
      throw new AppError('SESSION_NOT_FOUND', 'Playback session was stopped.', 409);
    }
    const session: Session = { ...s, started: now, seen: now, state: 'playing', positionAt: now, sent: [] };
    this.sessions.set(s.id, session);
    this.onStarted?.(session);
    return session;
  }
  // A media, playlist or state request: the session is alive, and `bytes` went out to it.
  touch(id: string, bytes = 0, now = Date.now()) {
    const s = this.sessions.get(id); if (!s) return;
    s.seen = now;
    if (bytes > 0) s.sent.push({ at: now, bytes });
    while (s.sent.length && s.sent[0]!.at < now - RATE_WINDOW_MS) s.sent.shift();
  }
  // An on-demand player's position report. `stopped` holds the position: the player's stop (its DELETE) follows and ends it.
  progress(id: string, hash: string, timeMs: number, state: 'playing' | 'paused' | 'stopped', now = Date.now()) {
    const s = this.sessions.get(id); if (!s || s.hash !== hash) return;
    Object.assign(s, { seen: now, state: state === 'stopped' ? 'paused' : state, positionMs: timeMs, positionAt: now });
  }
  get(id: string) { return this.sessions.get(id); }
  // Open sessions, oldest first.
  list() { return [...this.sessions.values()].sort((a, b) => a.started - b.started); }
  get count() { return this.sessions.size; }
  // Ends a session once: its delivery stops, then it is announced. With `hash`, only that sign-in's. False when there was
  // no such session (already ended).
  end(id: string, reason: SessionEnd, { hash }: { hash?: string } = {}) {
    const s = this.sessions.get(id);
    if (!s || (hash !== undefined && s.hash !== hash)) return false;
    // Removed first, so the delivering service telling us it ended (from its own stop) finds nothing to end again.
    this.sessions.delete(id);
    try { this.kinds.get(s.kind)?.stop(s); }
    catch (e) { this.log('playback session stop failed', { kind: s.kind, error: e instanceof Error ? e.name : 'unknown' }); }
    this.onEnded?.(s, reason);
    return true;
  }
  endWhere(matches: (s: Session) => boolean, reason: SessionEnd) { for (const s of [...this.sessions.values()]) if (matches(s)) this.end(s.id, reason); }
  // Sign-out: ends the sign-in's sessions, and refuses the ones still starting when they open.
  endOwner(hash: string, reason: SessionEnd) {
    for (const t of this.starting) if (t.hash === hash) t.cancelled = true;
    this.endWhere(s => s.hash === hash, reason);
  }
  idleAfter(s: Pick<Session, 'kind' | 'state'>) { return s.kind !== 'vod' ? this.idleMs.live : s.state === 'paused' ? this.idleMs.paused : this.idleMs.playing; }
  // The one idle rule: a session that stopped checking in is ended, and its delivery with it.
  sweep(now = Date.now()) { for (const s of [...this.sessions.values()]) if (now - s.seen > this.idleAfter(s)) this.end(s.id, 'idle'); }
}

// The last reported position, carried forward while playing (the player reports every 10 seconds).
export function sessionPosition(s: Session, now: number) {
  if (s.positionMs === undefined) return undefined;
  const at = s.state === 'playing' ? s.positionMs + (now - s.positionAt) : s.positionMs;
  return Math.round(s.durationMs ? Math.min(at, s.durationMs) : at);
}
// Measured over the last 30 seconds. Direct play hands the browser the file itself, so it is estimated from the file's bitrate.
export function sessionRate(s: Session, now: number) {
  if (s.delivery === 'direct') return s.state === 'playing' ? s.source?.bitrateKbps : 0;
  const recent = s.sent.filter(x => x.at >= now - RATE_WINDOW_MS), bytes = recent.reduce((n, x) => n + x.bytes, 0);
  if (!recent.length) return 0;
  const span = Math.max(10000, Math.min(RATE_WINDOW_MS, now - s.started));
  return Math.round(bytes * 8 / span);
}
