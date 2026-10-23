import { isIP } from 'node:net';

// Admin › Activity: every stream being watched right now, on-demand, IPTV and custom channels alike.
// Kept in memory only. The routes that deliver media report each session's start, requests, progress and stop.
// A closed browser sends no stop, so a session that stops checking in is dropped: a playing title reports every
// 10 seconds and a paused one every minute; live players fetch segments every few seconds, or poll while paused.
export type StreamKind = 'vod' | 'live' | 'custom';
export type StreamDelivery = 'direct' | 'remux' | 'transcode';
export type StreamSource = { videoCodec?: string; audioCodec?: string; width?: number; height?: number; container?: string; bitrateKbps?: number };
export type StreamOpen = {
  id: string; kind: StreamKind; hash: string; accountId: string; user?: string; delivery: StreamDelivery; ip: string; userAgent?: string;
  mediaId?: string; channelId?: string; channel?: { name: string; number: number }; positionMs?: number; durationMs?: number; quality?: string; target?: { maxHeight?: number; maxBitrateKbps?: number }; source?: StreamSource;
};
type Stream = StreamOpen & { started: number; seen: number; state: 'playing' | 'paused'; positionAt: number; sent: { at: number; bytes: number }[] };
const RATE_WINDOW_MS = 30000;

export class Activity {
  private streams = new Map<string, Stream>();
  constructor(private idleMs = { playing: 35000, paused: 150000, live: 30000 }) {}
  open(s: StreamOpen, now = Date.now()) {
    this.streams.set(s.id, { ...s, started: now, seen: now, state: 'playing', positionAt: now, sent: [] });
    if (this.streams.size > 500) this.prune(now);
  }
  // A media or playlist request: the session is alive, and `bytes` went out to it.
  touch(id: string, bytes = 0, now = Date.now()) {
    const s = this.streams.get(id); if (!s) return;
    s.seen = now;
    if (bytes > 0) s.sent.push({ at: now, bytes });
    while (s.sent.length && s.sent[0]!.at < now - RATE_WINDOW_MS) s.sent.shift();
  }
  progress(id: string, hash: string, timeMs: number, state: 'playing' | 'paused' | 'stopped', now = Date.now()) {
    const s = this.streams.get(id); if (!s || s.hash !== hash) return;
    if (state === 'stopped') { this.streams.delete(id); return; }
    Object.assign(s, { seen: now, state, positionMs: timeMs, positionAt: now });
  }
  get(id: string) { return this.streams.get(id); }
  close(id: string) { this.streams.delete(id); }
  closeWhere(matches: (s: Stream) => boolean) { for (const s of [...this.streams.values()]) if (matches(s)) this.streams.delete(s.id); }
  // `alive` lets the delivering service veto a session it has already ended (reaped, channel removed).
  list(alive: (s: Stream) => boolean = () => true, now = Date.now()) {
    this.prune(now);
    for (const s of [...this.streams.values()]) if (!alive(s)) this.streams.delete(s.id);
    return [...this.streams.values()].sort((a, b) => a.started - b.started).map(s => ({ ...s, positionMs: this.position(s, now), rateKbps: this.rate(s, now) }));
  }
  private prune(now: number) {
    for (const s of [...this.streams.values()]) if (now - s.seen > (s.kind !== 'vod' ? this.idleMs.live : s.state === 'paused' ? this.idleMs.paused : this.idleMs.playing)) this.streams.delete(s.id);
  }
  // The last reported position, carried forward while playing (the player reports every 10 seconds).
  private position(s: Stream, now: number) {
    if (s.positionMs === undefined) return undefined;
    const at = s.state === 'playing' ? s.positionMs + (now - s.positionAt) : s.positionMs;
    return Math.round(s.durationMs ? Math.min(at, s.durationMs) : at);
  }
  // Measured over the last 30 seconds. Direct play hands the browser the file itself, so it is estimated from the file's bitrate.
  private rate(s: Stream, now: number) {
    if (s.delivery === 'direct') return s.state === 'playing' ? s.source?.bitrateKbps : 0;
    const recent = s.sent.filter(x => x.at >= now - RATE_WINDOW_MS), bytes = recent.reduce((n, x) => n + x.bytes, 0);
    if (!recent.length) return 0;
    const span = Math.max(10000, Math.min(RATE_WINDOW_MS, now - s.started));
    return Math.round(bytes * 8 / span);
  }
}

// "Chrome · Windows" from a user agent; enough to tell a viewer's devices apart.
export function describeClient(userAgent = '') {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : undefined;
  const os = /iPhone|iPad|iPod/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /CrOS/.test(userAgent) ? 'ChromeOS'
    : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : undefined;
  return [browser, os].filter(Boolean).join(' · ') || 'Unknown device';
}

// Loopback and private ranges are the home network; anything else came over the internet.
export function isLocalAddress(ip: string) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// Plex keeps a session listed for a while after its app goes away (a closed browser tab), still marked playing.
// A playing session's position advances with every report from its app, so one that stays put has been abandoned.
export class PlexFreshness {
  private seen = new Map<string, { offset?: number; since: number }>();
  constructor(private staleMs = 45000) {}
  // Call with every session in one listing; sessions no longer listed are forgotten.
  filter<T extends { id: string; state: string; positionMs?: number; live?: boolean }>(rows: T[], now = Date.now()) {
    const current = new Map<string, { offset?: number; since: number }>();
    const kept = rows.filter(r => {
      const last = this.seen.get(r.id), moved = !last || last.offset !== r.positionMs || r.state !== 'playing';
      const entry = moved ? { offset: r.positionMs, since: now } : last;
      current.set(r.id, entry);
      return r.live || r.positionMs === undefined || now - entry.since < this.staleMs;
    });
    this.seen = current;
    return kept;
  }
}
