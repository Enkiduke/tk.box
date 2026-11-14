import type { IptvStore } from '../persistence/iptv-store.js';
import type { HealthStore } from '../persistence/channel-health-store.js';
import { allowed, type SportsStore } from '../persistence/sports-store.js';
import { SourceFetchError } from '../providers/source-fetch.js';
import { espnEvents, espnDay, espnUrl, espnLeagueLogo, tsdbEvents, tsdbUrls, tsdbDayUrl, tsdbLeagueUrl, tsdbLeagueLogo, fetchJson } from '../providers/sports-feeds.js';
import { ChannelLogos } from '../providers/channel-logos.js';
import { channelWindow, learnZones, type SportsEvent, type Window } from './sports-match.js';
import { every, errorDetail, type Repeating } from '../lib/every.js';

export type SportsOptions = { espn: string[]; tsdb: string[]; tsdbKey: () => string; zone: string; nameHours: number; tickMs: number };
// A job may also name its league's logo, read from the same response.
type Provider = 'espn' | 'tsdb';
type Job = { url: string; provider: Provider; every: number; parse?: (body: unknown) => SportsEvent[]; logo?: { key: string; read: (body: unknown) => string | undefined } };
type FeedHealth = { lastSuccess: number | null; lastChecked: number | null; failures: Set<string> };
const feedHealth = (): FeedHealth => ({ lastSuccess: null, lastChecked: null, failures: new Set() });
type Image = { type: string; bytes: Buffer };
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// TheSportsDB allows 30 requests a minute on the free key; ESPN publishes no limit, so stay gentle.
const SPACING = { espn: 500, tsdb: 2500 };
const logos = new ChannelLogos();

// Keeps a rolling schedule (yesterday through the day after tomorrow) and turns it into per-channel
// air windows for event-driven sources. Fetching only happens while some source uses sports events.
export class SportsSchedule {
  private due = { espn: new Map<string, number>(), tsdb: new Map<string, number>() };
  private backoff = { espn: 0, tsdb: 0 };
  private timer: Repeating;
  private running = false;
  private closed = false;
  private lastMatch = 0;
  private stale = true;
  private feeds = { espn: feedHealth(), tsdb: feedHealth() };
  private lastTsdbKey?: string;
  lastSync: number | null = null;
  lastError: string | null = null;
  constructor(private iptv: IptvStore, private store: SportsStore, private health: HealthStore | undefined, private pump: () => void,
    private options: SportsOptions, private log: (message: string, detail: Record<string, unknown>) => void = () => {},
    private get: (url: string) => Promise<unknown> = fetchJson(), private image: (url: string) => Promise<Image> = url => logos.get(url)) {
    this.timer = every(options.tickMs, () => this.tick(), e => this.log('sports schedule failed', errorDetail(e)));
  }
  private tsdbKey() {
    const key = this.options.tsdbKey();
    if (key !== this.lastTsdbKey) {
      this.lastTsdbKey = key;
      this.feeds.tsdb = feedHealth();
      this.due.tsdb = new Map();
    }
    return key;
  }
  feedStatus(now = Date.now()) {
    this.tsdbKey();
    const active = this.store.sources().length > 0;
    const status = (provider: Provider) => {
      const { lastSuccess, lastChecked, failures } = this.feeds[provider];
      const state = !active ? 'idle' : failures.size && this.backoff[provider] > now ? 'backoff'
        : failures.size ? 'warning' : lastSuccess === null ? 'waiting' : 'working';
      return { state, lastSuccess, lastChecked, failedRequests: failures.size, retryAt: state === 'backoff' ? this.backoff[provider] : null };
    };
    return { espn: status('espn'), tsdb: status('tsdb') };
  }
  private jobs(now: number, key: string): Job[] {
    const days = [-1, 0, 1, 2].map(d => espnDay(now + d * DAY)), today = espnDay(now);
    const espn = this.options.espn.flatMap(path => days.map(day => ({ url: espnUrl(path, day), provider: 'espn' as const, every: day === today ? 10 * MINUTE : HOUR, parse: (b: unknown) => espnEvents(path, b),
      logo: { key: path, read: espnLeagueLogo } })));
    const iso = [0, 1, 2].map(d => new Date(now + d * DAY).toISOString().slice(0, 10));
    const tsdb = [...this.options.tsdb.flatMap(id => tsdbUrls(key, id)), ...iso.map(day => tsdbDayUrl(key, day, 'Fighting'))]
      .map(url => ({ url, provider: 'tsdb' as const, every: 6 * HOUR, parse: tsdbEvents }));
    // TheSportsDB badges: the configured leagues and any league a fight card turned up, looked up weekly.
    const ids = new Set([...this.options.tsdb, ...this.store.leagues(0).flatMap(l => /^tsdb:\d+$/.test(l.key) ? [l.key.slice(5)] : [])]);
    const badges = [...ids].map(id => ({ url: tsdbLeagueUrl(key, id), provider: 'tsdb' as const, every: 7 * DAY, logo: { key: `tsdb:${id}`, read: tsdbLeagueLogo } }));
    return [...espn, ...tsdb, ...badges];
  }
  // Rematching decrypts every channel and its listings, so it runs after new data or every five minutes.
  invalidate() { this.stale = true; void this.tick(); }
  async tick(now = Date.now()) {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      const sources = this.store.sources();
      if (!sources.length) return;
      let fetched = 0;
      const jobs = this.jobs(now, this.tsdbKey()), feeds = { ...this.feeds }, dues = { ...this.due };
      const urls = new Set(jobs.map(job => job.url));
      for (const due of Object.values(dues)) for (const url of due.keys()) if (!urls.has(url)) due.delete(url);
      for (const feed of Object.values(feeds)) for (const url of feed.failures.keys()) if (!urls.has(url)) feed.failures.delete(url);
      for (const job of jobs) {
        if (this.closed) return;
        if (job.provider === 'tsdb' && feeds.tsdb !== this.feeds.tsdb) continue;
        const feed = feeds[job.provider], due = dues[job.provider];
        if ((due.get(job.url) ?? 0) > Date.now() || this.backoff[job.provider] > Date.now()) continue;
        try {
          const body = await this.get(job.url), logo = job.logo?.read(body);
          if (job.parse) {
            const events = (body as { events?: unknown } | null)?.events;
            if (!Array.isArray(events) && !(job.provider === 'tsdb' && events === null)) throw new Error('Invalid schedule response');
            this.store.upsert(job.parse(body));
            feed.lastChecked = feed.lastSuccess = Date.now();
            feed.failures.delete(job.url);
          }
          due.set(job.url, Date.now() + job.every); fetched++;
          if (job.logo && logo) this.store.setLogoUrl(job.logo.key, logo);
        } catch (error) {
          // Rate limited: the whole provider waits. Anything else: this request alone retries later.
          if (error instanceof SourceFetchError && error.retryAt) this.backoff[job.provider] = error.retryAt;
          else due.set(job.url, Date.now() + 15 * MINUTE);
          if (job.parse) {
            feed.lastChecked = Date.now();
            feed.failures.add(job.url);
          }
          this.lastError = (error as { code?: string }).code ?? 'SPORTS_FETCH_FAILED';
          this.log('sports schedule request failed', { provider: job.provider, code: this.lastError });
        }
        await new Promise(r => setTimeout(r, SPACING[job.provider]));
      }
      if (fetched) { this.lastSync = Date.now(); this.stale = true; this.store.prune(); }
      // A logo that fails is retried on a later tick, once ChannelLogos stops refusing it.
      for (const { key, url } of this.store.logosMissing()) {
        if (this.closed) return;
        try { this.store.saveLogo(key, url, await this.image(url)); } catch { this.log('league logo unavailable', { league: key }); }
      }
      if (this.stale || Date.now() - this.lastMatch >= 5 * MINUTE) this.match();
      // Every minute: number what just went live or is starting soon, release what ended, check what appeared.
      for (const source of sources) {
        const synced = this.iptv.syncNumbers(source.id);
        if (synced.numbered || synced.released) this.log('sports channels updated', { sourceId: source.id, ...synced });
        this.health?.queueEvents(source.id);
      }
      this.pump();
    } catch (error) {
      this.log('sports schedule failed', { code: (error as { code?: string }).code });
    } finally { this.running = false; }
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
      this.store.replaceWindows(source.id, source.lead_minutes, windows, now);
      this.iptv.syncNumbers(source.id, now);
      this.log('sports channels matched', { sourceId: source.id, events: events.length, windows: windows.size, zones: Object.fromEntries(zones) });
    }
    this.lastMatch = now; this.stale = false;
  }
  close() { this.closed = true; this.timer.stop(); }
}
