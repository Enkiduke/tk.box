import { monitorEventLoopDelay } from 'node:perf_hooks';

// Where server time goes, since start: event-loop stalls, the slowest API routes, and Plex reads. In memory only;
// Admin reads it at /api/v1/admin/metrics. Routes are keyed by their pattern, never the requested URL.
type Timing = { count: number; errors: number; totalMs: number; maxMs: number };
const empty = (): Timing => ({ count: 0, errors: 0, totalMs: 0, maxMs: 0 });
const add = (t: Timing, ms: number, ok: boolean) => { t.count++; if (!ok) t.errors++; t.totalMs += ms; t.maxMs = Math.max(t.maxMs, ms); };
const view = (t: Timing) => ({ count: t.count, errors: t.errors, avgMs: t.count ? Math.round(t.totalMs / t.count * 10) / 10 : 0, maxMs: Math.round(t.maxMs * 10) / 10 });

export class ServerMetrics {
  private loop = monitorEventLoopDelay({ resolution: 20 });
  private routes = new Map<string, Timing>();
  private plexReads = empty();
  private readonly since = Date.now();
  start() { this.loop.enable(); }
  stop() { this.loop.disable(); }
  route(key: string, ms: number, ok: boolean) {
    let t = this.routes.get(key);
    if (!t) { if (this.routes.size >= 500) return; t = empty(); this.routes.set(key, t); }
    add(t, ms, ok);
  }
  plex(ms: number, ok: boolean) { add(this.plexReads, ms, ok); }
  snapshot() {
    const ms = (ns: number) => Math.round(ns / 1e5) / 10;
    return {
      since: this.since,
      eventLoop: { meanMs: ms(this.loop.mean || 0), p99Ms: ms(this.loop.percentile(99)), maxMs: ms(this.loop.max) },
      plex: view(this.plexReads),
      routes: [...this.routes].map(([route, t]) => ({ route, ...view(t) })).sort((a, b) => b.maxMs - a.maxMs).slice(0, 50)
    };
  }
}
