import { isIP } from 'node:net';

// Admin › Activity's helpers. Its rows are the playback session registry's (services/playback-sessions.ts).
export type { StreamDelivery, StreamKind, StreamSource } from './playback-sessions.js';

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
