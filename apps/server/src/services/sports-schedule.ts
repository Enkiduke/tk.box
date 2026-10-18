import type { IptvStore } from '../persistence/iptv-store.js';
import type { HealthStore } from '../persistence/channel-health-store.js';
import { allowed, type SportsStore } from '../persistence/sports-store.js';
import { SourceFetchError } from '../providers/source-fetch.js';
import { espnEvents, espnDay, espnUrl, tsdbEvents, tsdbUrls, tsdbDayUrl, fetchJson } from '../providers/sports-feeds.js';
import { channelWindow, learnZones, looksLikeEvents, eventShare, type SportsEvent, type Window } from './sports-match.js';

export type SportsOptions = { espn: string[]; tsdb: string[]; tsdbKey: string; zone: string; nameHours: number; tickMs: number };
type Job = { url: string; provider: 'espn' | 'tsdb'; every: number; parse: (body: unknown) => SportsEvent[] };
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// TheSportsDB allows 30 requests a minute on the free key; ESPN publishes no limit, so stay gentle.
const SPACING = { espn: 500, tsdb: 2500 };

// Keeps a rolling schedule (yesterday through the day after tomorrow) and turns it into per-channel
// air windows for event-driven sources. Fetching only happens while some source uses sports events.
export class SportsSchedule {
  private due = new Map<string, number>();
  private backoff = { espn: 0, tsdb: 0 };
  private timer: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private lastMatch = 0;
  private stale = true;
  lastSync: number | null = null;
  lastError: string | null = null;
  constructor(private iptv: IptvStore, private store: SportsStore, private health: HealthStore, private pump: () => void,
    private options: SportsOptions, private log: (message: string, detail: Record<string, unknown>) => void = () => {},
    private get: (url: string) => Promise<unknown> = fetchJson()) {
    this.timer = setInterval(() => { void this.tick(); }, options.tickMs); this.timer.unref();
  }
  private jobs(now: number): Job[] {
    const days = [-1, 0, 1, 2].map(d => espnDay(now + d * DAY)), today = espnDay(now);
    const espn = this.options.espn.flatMap(path => days.map(day => ({ url: espnUrl(path, day), provider: 'espn' as const, every: day === today ? 10 * MINUTE : HOUR, parse: (b: unknown) => espnEvents(path, b) })));
    const iso = [0, 1, 2].map(d => new Date(now + d * DAY).toISOString().slice(0, 10));
    const tsdb = [...this.options.tsdb.flatMap(id => tsdbUrls(this.options.tsdbKey, id)), ...iso.map(day => tsdbDayUrl(this.options.tsdbKey, day, 'Fighting'))]
      .map(url => ({ url, provider: 'tsdb' as const, every: 6 * HOUR, parse: tsdbEvents }));
    return [...espn, ...tsdb];
  }
  // Rematching decrypts every channel and its listings, so it runs after new data or every five minutes.
  invalidate() { this.stale = true; void this.tick(); }
  async tick(now = Date.now()) {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      this.detect(now);
      const sources = this.store.sources();
      if (!sources.length) return;
      let fetched = 0;
      for (const job of this.jobs(now)) {
        if (this.closed) return;
        if ((this.due.get(job.url) ?? 0) > Date.now() || this.backoff[job.provider] > Date.now()) continue;
        try {
          const events = job.parse(await this.get(job.url));
          this.store.upsert(events); this.due.set(job.url, Date.now() + job.every); fetched++;
        } catch (error) {
          // Rate limited: the whole provider waits. Anything else: this request alone retries later.
          if (error instanceof SourceFetchError && error.retryAt) this.backoff[job.provider] = error.retryAt;
          else this.due.set(job.url, Date.now() + 15 * MINUTE);
          this.lastError = (error as { code?: string }).code ?? 'SPORTS_FETCH_FAILED';
          this.log('sports schedule request failed', { provider: job.provider, code: this.lastError });
        }
        await new Promise(r => setTimeout(r, SPACING[job.provider]));
      }
      if (fetched) { this.lastSync = Date.now(); this.stale = true; this.store.prune(); }
      if (this.stale || Date.now() - this.lastMatch >= 5 * MINUTE) this.match();
      // Every minute: approve what just went live or is starting soon, retire what ended, check what appeared.
      for (const source of sources) {
        const synced = this.iptv.syncEventApprovals(source.id);
        if (synced.approved || synced.returned) this.log('sports approvals updated', { sourceId: source.id, ...synced });
        this.health.queueEvents(source.id);
      }
      this.pump();
    } catch (error) {
      this.log('sports schedule failed', { code: (error as { code?: string }).code });
    } finally { this.running = false; }
  }
  // Playlists imported before detection existed, or by an import path that skipped it, have no choice
  // recorded. Event playlists among them become event-driven; each revision is looked at once.
  private detected = new Map<string, number>();
  private detect(now: number) {
    for (const source of this.iptv.list()) {
      if (source.kind !== 'm3u' || this.store.hasPolicy(source.id) || this.detected.get(source.id) === source.revision) continue;
      this.detected.set(source.id, source.revision);
      const names = this.iptv.adminChannels(source.id).filter(c => c.present).map(c => c.name);
      const share = Math.round(eventShare(names) * 100);
      if (!looksLikeEvents(names)) { this.log('playlist is not an event playlist', { sourceId: source.id, channels: names.length, eventLikePercent: share }); continue; }
      this.store.setPolicy('system:sports', source.id, { enabled: true, leadMinutes: 30 }, now);
      this.log('sports playlist detected', { sourceId: source.id, channels: names.length, eventLikePercent: share });
      this.stale = true;
    }
  }
  // Every configured league is downloaded, shown or not: a channel naming a game of a hidden league must match that
  // game and be dropped, rather than fall back to the time in its name or a weaker match in a shown league.
  leagues() { return [...this.options.espn, ...this.options.tsdb.map(id => `tsdb:${id}`)]; }
  match(now = Date.now()) {
    const events = this.store.events(now - 12 * HOUR, now + 3 * DAY), allow = allowed(this.store.settings());
    for (const source of this.store.sources()) {
      const windows = new Map<string, Window>(), channels = this.iptv.sportsChannels(source.id, now - 6 * HOUR, now + 2 * DAY);
      const zones = learnZones(channels, events, now, this.options.zone);
      for (const channel of channels) {
        const window = channelWindow(channel, events, now, { zone: this.options.zone, nameHours: this.options.nameHours, zones, allow });
        if (!window) continue;
        windows.set(channel.id, window);
      }
      this.store.replaceWindows(source.id, source.lead_minutes, windows);
      this.iptv.syncEventApprovals(source.id, now);
      this.log('sports channels matched', { sourceId: source.id, events: events.length, windows: windows.size, zones: Object.fromEntries(zones) });
    }
    this.lastMatch = now; this.stale = false;
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
