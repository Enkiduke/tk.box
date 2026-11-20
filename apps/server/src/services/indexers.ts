import { z } from 'zod';
import type { Db } from '../persistence/database.js';
import type { Vault } from '../security/vault.js';
import { prepared } from '../persistence/statements.js';
import { AppError, requireLive } from '../errors.js';
import { IndexerError, NzbGeek, type NewznabItem } from '../providers/newznab.js';
import { IPT_COOKIE_FORMAT_ERROR, IPT_DEFAULT_CATEGORIES, IPTorrents, isIptCookieHeader, NEWZNAB_CATEGORIES, PASSKEY, type IptItem, type IptSecret } from '../providers/iptorrents.js';
import type { Candidate } from '../lib/pick-rules.js';
import { imdbNumber } from '../lib/release-name.js';
import type { IndexerStats } from '../../../../packages/contracts/src/downloads.js';

// The indexers (docs/ARR-REPLACEMENT.md, "Clients"): their settings and sealed secrets, the hourly and daily search
// caps, pausing after a 429 or a refused key, the new-release feed with rss_seen, and fetching the NZB or .torrent.
// NZBGeek (phase 1) and IPTorrents (phase 3): its RSS feed on the passkey, its search page with the cookie, and a
// "cookie expired" admin alert when that page shows the signed-out form.

export const indexerNames = ['nzbgeek', 'iptorrents'] as const;
export type IndexerName = typeof indexerNames[number];

const categories = z.array(z.number().int().positive()).max(20);
export const indexerSettings = z.object({
  categories: z.object({ movies: categories.default([2000, 2040]), tv: categories.default([5000, 5040]) }).strict().default({ movies: [2000, 2040], tv: [5000, 5040] }),
  hourlyCap: z.number().int().min(1).max(10000).default(100),
  dailyCap: z.number().int().min(1).max(100000).default(2000),
  // IPTorrents only: search freeleech torrents only (free=on).
  freeleechOnly: z.boolean().default(false),
}).strict();
export type IndexerSettings = z.infer<typeof indexerSettings>;
// Each indexer's defaults: NZBGeek by its plan, IPTorrents 20 searches an hour and 200 a day.
const DEFAULTS: Record<IndexerName, z.input<typeof indexerSettings>> = {
  nzbgeek: {},
  iptorrents: { categories: IPT_DEFAULT_CATEGORIES, hourlyCap: 20, dailyCap: 200 },
};
const iptUrl = z.string().trim().max(500).refine(value => {
  if (!value) return true;
  try { const u = new URL(value), h = u.hostname.toLowerCase(); return u.protocol === 'https:' && (h === 'iptorrents.com' || h.endsWith('.iptorrents.com')); } catch { return false; }
}, 'Use your IPTorrents RSS address (https://iptorrents.com/t.rss?…)');
const headerText = (max: number) => z.string().trim().max(max).regex(/^[^\r\n]*$/, 'One line only');
// Omitted keeps a saved key (or RSS address, cookie, user agent); an empty string removes it.
export const indexerInput = z.object({
  enabled: z.boolean().optional(),
  key: z.string().trim().max(200).regex(/^[\w-]*$/).optional(),
  rssUrl: iptUrl.optional(),
  cookie: headerText(4000).optional(),
  userAgent: headerText(500).optional(),
  settings: indexerSettings.partial().optional(),
}).strict();
// Admin alerts (the bell), by key.
export type IndexerNotify = { post(key: string, title: string, detail: string): void; resolve(key: string): void };
export const COOKIE_ALERT = 'indexer.iptorrents.cookie';

// A release as an indexer found it: what the pick rules read, plus the NZB or .torrent link (without the key or
// passkey) and its categories.
export type Release = Candidate & { indexer: IndexerName; link: string; categories: number[] };
export type MovieQuery = { kind: 'movie'; title: string; year?: number; imdbId?: string; uhd?: boolean };
// A season (its pack and episodes), or one episode of it. `series`: the show is filed under another TVDB series (a show
// match, lib/season-map.ts), whose `tvdbId` it then is, with the season in that series' numbers.
export type ShowQuery = { kind: 'show'; title: string; tvdbId?: number; season: number; episode?: number; series?: { title: string; season: number } };
export type TitleQuery = MovieQuery | ShowQuery;
const episodeCode = (q: ShowQuery) => `S${String(q.season).padStart(2, '0')}${q.episode === undefined ? '' : `E${String(q.episode).padStart(2, '0')}`}`;
// Which protocols' indexers a search asks (the library asks Usenet first, then torrents); all when omitted.
// `manual`: an admin asked (Interactive search), which the preview allows; automatic searches it doesn't.
export type SearchOptions = { protocols?: readonly ('usenet' | 'torrent')[]; manual?: boolean };
// What each indexer did for a search: the calls it made, or why it made none (paused, over a cap) and until when.
export type IndexerReport = { indexer: IndexerName; searched: string[]; error?: string; waitUntil?: number };
export type SearchResult = { releases: Release[]; indexers: IndexerReport[] };
export type FeedListener = (releases: Release[]) => void | Promise<void>;
// The release's file: an NZB, or a .torrent with its info hash.
export type NzbFile = { name: string; bytes: Buffer; infoHash?: string };

type Row = { name: IndexerName; enabled: number; sealed_secret: string | null; settings: string; last_ok_at: number | null; last_error: string | null; paused_until: number | null };
const HOUR = 3600000, DAY = 24 * HOUR, SEEN_DAYS = 14, QUERY_DAYS = 90;
// NZBGeek's feed is read a page of 100 at a time, back to the newest release seen before, at most this many pages a
// poll: a busy quarter hour costs a few more calls instead of losing releases.
const FEED_PAGE = 100, FEED_PAGES = 5;
const secretContext = (name: IndexerName) => `indexers:${name}-secret`;
export const nextHour = (now: number) => Math.floor(now / HOUR) * HOUR + HOUR;
const nextDay = (now: number) => Math.floor(now / DAY) * DAY + DAY;
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const protocolOf = (name: IndexerName) => name === 'iptorrents' ? 'torrent' as const : 'usenet' as const;
const fileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '').slice(0, 200);

export class Indexers {
  private listeners = new Set<FeedListener>();
  // Searches this clock hour, per indexer. Kept in memory: a restart forgets the hour's count, never the day's.
  private hour = new Map<IndexerName, { hour: number; count: number }>();
  private now: () => number;
  private transport: typeof fetch;
  private log: (message: string, detail: Record<string, unknown>) => void;
  private notify: IndexerNotify;

  constructor(private db: Db, private vault: Vault, options: { transport?: typeof fetch; now?: () => number; log?: (message: string, detail: Record<string, unknown>) => void;
    notify?: IndexerNotify } = {}) {
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? fetch;
    this.log = options.log ?? (() => {});
    this.notify = options.notify ?? { post: () => {}, resolve: () => {} };
  }

  private row(name: IndexerName) { return prepared(this.db, 'SELECT * FROM indexers WHERE name = ?').get(name) as Row | undefined; }
  private settingsOf(row: Row | undefined, name: IndexerName = row?.name ?? 'nzbgeek'): IndexerSettings {
    return indexerSettings.parse({ ...DEFAULTS[name], ...(row ? JSON.parse(row.settings) as object : {}) });
  }
  private iptSecret(row: Row | undefined): IptSecret {
    if (!row?.sealed_secret || row.name !== 'iptorrents') return {};
    try { return JSON.parse(this.vault.open(row.sealed_secret, secretContext('iptorrents'))) as IptSecret; } catch { return {}; }
  }
  private client(row: Row) {
    if (!row.sealed_secret) throw new AppError('INDEXER_KEY_MISSING', 'NZBGeek has no API key.', 409);
    return new NzbGeek(this.vault.open(row.sealed_secret, secretContext(row.name)), this.transport);
  }
  private ipt(row: Row) { return new IPTorrents(this.iptSecret(row), this.transport); }
  private rows() { return prepared(this.db, 'SELECT * FROM indexers WHERE enabled = 1 AND sealed_secret IS NOT NULL ORDER BY name').all() as Row[]; }
  // Enabled and able to search: NZBGeek with a key, IPTorrents with a cookie.
  private enabledRows(protocols?: SearchOptions['protocols']) {
    return this.rows().filter(r => r.name === 'nzbgeek' || !!this.iptSecret(r).cookie).filter(r => !protocols || protocols.includes(protocolOf(r.name)));
  }
  // Enabled with a feed: NZBGeek's API, IPTorrents' RSS address.
  private feedRows() { return this.rows().filter(r => r.name === 'nzbgeek' || !!this.iptSecret(r).rssUrl); }
  anyEnabled() { return this.feedRows().length > 0 || this.enabledRows().length > 0; }
  // Whether any enabled indexer searches this protocol.
  searches(protocol: 'usenet' | 'torrent') { return this.enabledRows([protocol]).length > 0; }

  // What Admin shows: never the secret itself (IPTorrents' user agent isn't secret, so it is shown).
  view() {
    const now = this.now(), day = dayOf(now);
    return indexerNames.map(name => {
      const row = this.row(name);
      const usage = prepared(this.db, 'SELECT searches, grabs FROM indexer_usage WHERE indexer = ? AND day = ?').get(name, day) as { searches: number; grabs: number } | undefined;
      const hour = this.hour.get(name);
      const ipt = name === 'iptorrents' ? this.iptSecret(row) : undefined;
      return {
        name, enabled: !!row?.enabled, secretSet: !!row?.sealed_secret, settings: this.settingsOf(row, name),
        ...(ipt ? { iptorrents: { rssSet: !!ipt.rssUrl, cookieSet: !!ipt.cookie, userAgent: ipt.userAgent ?? '' } } : {}),
        lastOkAt: row?.last_ok_at ?? null, lastError: row?.last_error ?? null,
        pausedUntil: row?.paused_until && row.paused_until > now ? row.paused_until : null,
        today: { searches: usage?.searches ?? 0, grabs: usage?.grabs ?? 0 },
        thisHour: hour && hour.hour === Math.floor(now / HOUR) ? hour.count : 0,
      };
    });
  }

  // Saves an indexer's settings and key. A new key clears a pause and the last error. IPTorrents' secret is
  // {rssUrl, cookie, userAgent}, each kept, replaced or removed on its own; a new cookie or user agent clears the pause
  // and the expired-cookie alert.
  configure(actor: string, name: IndexerName, input: z.input<typeof indexerInput>) {
    const { enabled, key, rssUrl, cookie, userAgent, settings: parsed } = indexerInput.parse(input);
    // Only the fields sent: the partial schema would fill the others with NZBGeek's defaults.
    const sent = new Set(Object.keys(input.settings ?? {}));
    const settings = parsed && Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as typeof parsed;
    if (name === 'nzbgeek' && (rssUrl !== undefined || cookie !== undefined || userAgent !== undefined)) throw new AppError('INDEXER_INVALID', 'NZBGeek takes an API key only.', 400);
    if (name === 'iptorrents' && key !== undefined) throw new AppError('INDEXER_INVALID', 'IPTorrents takes an RSS address, cookie and user agent.', 400);
    if (cookie && !isIptCookieHeader(cookie)) throw new AppError('INDEXER_INVALID', IPT_COOKIE_FORMAT_ERROR);
    if (name === 'iptorrents' && settings?.categories) {
      const unknown = [...settings.categories.movies ?? [], ...settings.categories.tv ?? []].find(c => !NEWZNAB_CATEGORIES.has(c));
      if (unknown !== undefined) throw new AppError('INDEXER_INVALID', `IPTorrents has no category ${unknown}.`, 400);
    }
    let keyChanged = false;
    this.db.transaction(() => {
      const row = this.row(name);
      const merged = indexerSettings.parse({ ...this.settingsOf(row, name), ...settings });
      let sealed: string | null;
      if (name === 'iptorrents') {
        const next: IptSecret = { ...this.iptSecret(row) };
        for (const [field, value] of [['rssUrl', rssUrl], ['cookie', cookie], ['userAgent', userAgent]] as const) {
          if (value === undefined) continue;
          if (value) next[field] = value; else delete next[field];
        }
        sealed = Object.keys(next).length ? this.vault.seal(JSON.stringify(next), secretContext(name)) : null;
        keyChanged = cookie !== undefined || userAgent !== undefined;
      } else {
        sealed = key === undefined ? row?.sealed_secret ?? null : key ? this.vault.seal(key, secretContext(name)) : null;
        keyChanged = key !== undefined;
      }
      prepared(this.db, `INSERT INTO indexers(name, enabled, sealed_secret, settings, last_ok_at, last_error, paused_until) VALUES(?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, sealed_secret = excluded.sealed_secret, settings = excluded.settings,
          last_error = CASE WHEN ? THEN NULL ELSE indexers.last_error END, paused_until = CASE WHEN ? THEN NULL ELSE indexers.paused_until END`)
        .run(name, (enabled ?? !!row?.enabled) ? 1 : 0, sealed, JSON.stringify(merged), keyChanged ? 1 : 0, keyChanged ? 1 : 0);
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)')
        .run(actor, 'indexer_changed', this.now(), JSON.stringify({ name, enabled: enabled ?? !!row?.enabled, secretSet: !!sealed, settings: merged }));
    })();
    if (name === 'iptorrents' && keyChanged) this.notify.resolve(COOKIE_ALERT);
    return this.view().find(v => v.name === name)!;
  }

  // Admin's Test. NZBGeek: a caps call with the saved key. IPTorrents: the search page with the saved cookie must link
  // to lout.php (signed in), and the RSS address, when saved, must answer with a feed. A failure is recorded as the last
  // error (without pausing); a signed-out page also raises the expired-cookie alert.
  async test(name: IndexerName) {
    const row = this.row(name);
    if (!row?.sealed_secret) throw new AppError('INDEXER_KEY_MISSING', name === 'iptorrents' ? 'Save a cookie first.' : 'Save an API key first.', 409);
    let detail = 'NZBGeek accepted the key.';
    try {
      if (name === 'iptorrents') {
        const secret = this.iptSecret(row), client = this.ipt(row);
        if (!secret.cookie) throw new AppError('INDEXER_KEY_MISSING', 'Save a cookie first.', 409);
        await client.check();
        const items = secret.rssUrl ? await client.rss() : undefined;
        detail = `Signed in to IPTorrents${items ? `; the RSS feed lists ${items.length}` : ''}.`;
        this.notify.resolve(COOKIE_ALERT);
      } else await this.client(row).call({ t: 'caps' });
    } catch (e) {
      if (e instanceof AppError) throw e;
      prepared(this.db, 'UPDATE indexers SET last_error = ? WHERE name = ?').run(errorText(e), name);
      if (e instanceof IndexerError && e.kind === 'cookie') this.cookieExpired(errorText(e));
      throw new AppError('INDEXER_TEST_FAILED', errorText(e), 502);
    }
    this.ok(name, this.now());
    return { ok: true as const, detail };
  }

  private cookieExpired(detail: string) {
    this.notify.post(COOKIE_ALERT, 'IPTorrents cookie expired', `${detail} Paste a new cookie in Admin › Connections. RSS keeps running.`);
  }

  // Whether a search may go out now, and if not, until when.
  private gate(row: Row, now: number): { ok: true } | { ok: false; until: number; reason: string } {
    if (row.paused_until && row.paused_until > now) return { ok: false, until: row.paused_until, reason: `paused: ${row.last_error ?? 'after an error'}` };
    const settings = this.settingsOf(row), hour = this.hour.get(row.name);
    if (hour && hour.hour === Math.floor(now / HOUR) && hour.count >= settings.hourlyCap) return { ok: false, until: nextHour(now), reason: `over the hourly cap of ${settings.hourlyCap}` };
    const today = prepared(this.db, 'SELECT searches FROM indexer_usage WHERE indexer = ? AND day = ?').get(row.name, dayOf(now)) as { searches: number } | undefined;
    if ((today?.searches ?? 0) >= settings.dailyCap) return { ok: false, until: nextDay(now), reason: `over the daily cap of ${settings.dailyCap}` };
    return { ok: true };
  }

  private count(name: IndexerName, what: 'searches' | 'grabs', now: number) {
    prepared(this.db, `INSERT INTO indexer_usage(indexer, day, ${what}) VALUES(?, ?, 1) ON CONFLICT(indexer, day) DO UPDATE SET ${what} = ${what} + 1`).run(name, dayOf(now));
    if (what !== 'searches') return;
    const slot = Math.floor(now / HOUR), hour = this.hour.get(name);
    this.hour.set(name, hour && hour.hour === slot ? { hour: slot, count: hour.count + 1 } : { hour: slot, count: 1 });
  }

  // A 429 or a Newznab limit pauses the indexer until the next hour; a refused key (or an expired IPTorrents cookie)
  // pauses it for a day, or until a new key or cookie is saved. An expired cookie also alerts the admins.
  private failed(name: IndexerName, error: unknown, now: number) {
    const message = errorText(error);
    const kind = error instanceof IndexerError ? error.kind : undefined;
    const until = kind === 'rate' ? nextHour(now) : kind === 'auth' || kind === 'cookie' ? now + DAY : null;
    prepared(this.db, 'UPDATE indexers SET last_error = ?, paused_until = COALESCE(?, paused_until) WHERE name = ?').run(message, until, name);
    this.log('indexer call failed', { indexer: name, error: message, ...(until ? { pausedUntil: until } : {}) });
    if (kind === 'cookie') this.cookieExpired(message);
    return { message, ...(until ? { until } : {}) };
  }
  // One search sent, for Downloads › History › Stats; rows over 90 days old go as new ones come.
  private logQuery(name: IndexerName, started: number, ok: boolean, results?: number) {
    const now = this.now();
    prepared(this.db, 'INSERT INTO indexer_queries(indexer, at, ms, ok, results) VALUES(?, ?, ?, ?, ?)').run(name, started, Math.max(0, now - started), ok ? 1 : 0, results ?? null);
    prepared(this.db, 'DELETE FROM indexer_queries WHERE at < ?').run(now - QUERY_DAYS * DAY);
  }

  // Downloads › History › Stats: each indexer's searches and grabs a day (UTC days, as the caps count them) since
  // `from`, and how its searches went. Query figures start when the log began (`loggedSince`).
  stats(from: number): IndexerStats {
    const day = dayOf(from);
    const usage = prepared(this.db, 'SELECT indexer, day, searches, grabs FROM indexer_usage WHERE day >= ? ORDER BY day').all(day) as
      { indexer: string; day: string; searches: number; grabs: number }[];
    const queries = prepared(this.db, `SELECT indexer, COUNT(*) AS queries, SUM(ok = 0) AS failed, AVG(ms) AS ms, AVG(results) AS results
      FROM indexer_queries WHERE at >= ? GROUP BY indexer`).all(from) as { indexer: string; queries: number; failed: number; ms: number | null; results: number | null }[];
    const first = prepared(this.db, 'SELECT MIN(at) AS at FROM indexer_queries').get() as { at: number | null };
    const indexers = indexerNames.filter(name => this.row(name) || usage.some(u => u.indexer === name)).map(name => {
      const days = usage.filter(u => u.indexer === name).map(({ day, searches, grabs }) => ({ day, searches, grabs }));
      const q = queries.find(r => r.indexer === name);
      return { name, searches: days.reduce((n, d) => n + d.searches, 0), grabs: days.reduce((n, d) => n + d.grabs, 0), queries: q?.queries ?? 0, failed: q?.failed ?? 0,
        ...(q?.ms != null ? { avgMs: Math.round(q.ms) } : {}), ...(q?.results != null ? { avgResults: Math.round(q.results) } : {}), days };
    });
    return { indexers, ...(first.at != null ? { loggedSince: first.at } : {}) };
  }

  private ok(name: IndexerName, now: number) { prepared(this.db, 'UPDATE indexers SET last_ok_at = ?, last_error = NULL WHERE name = ?').run(now, name); }

  private release(name: IndexerName, item: NewznabItem): Release {
    const publishedAt = item.publishedAt ?? item.usenetDate;
    return {
      indexer: name, protocol: 'usenet', guid: item.guid, name: item.title, link: item.link, categories: item.categories,
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(item.grabs !== undefined ? { grabs: item.grabs } : {}),
      ids: { ...(item.imdb ? { imdb: item.imdb } : {}), ...(item.tvdbid ? { tvdbid: item.tvdbid } : {}) },
    };
  }
  // The guid is the site's torrent id, so the same torrent from the feed and the search page is one release.
  private torrentRelease(item: IptItem): Release {
    return {
      indexer: 'iptorrents', protocol: 'torrent', guid: `iptorrents:${item.id}`, name: item.name, link: item.link, categories: item.categories,
      freeleech: item.freeleech, ...(item.size !== undefined ? { size: item.size } : {}), ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
      ...(item.seeders !== undefined ? { seeders: item.seeders } : {}), ...(item.snatched !== undefined ? { grabs: item.snatched } : {}),
    };
  }

  // One counted API call, or the reason it didn't go out.
  private call(row: Row, params: Record<string, string>, report: IndexerReport, signal?: AbortSignal): Promise<NewznabItem[] | undefined> {
    return this.counted(row, Object.entries(params).filter(([k]) => k !== 'cat' && k !== 'limit').map(([k, v]) => `${k}=${v}`).join('&'), report,
      () => this.client(row).call(params, signal), signal);
  }
  private async counted<T>(row: Row, what: string, report: IndexerReport, run: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    const now = this.now(), gate = this.gate(row, now);
    if (!gate.ok) { report.error = gate.reason; report.waitUntil = gate.until; return undefined; }
    this.count(row.name, 'searches', now);
    report.searched.push(what);
    try {
      const items = await run();
      this.logQuery(row.name, now, true, Array.isArray(items) ? items.length : undefined);
      this.ok(row.name, this.now());
      if (row.name === 'iptorrents') this.notify.resolve(COOKIE_ALERT);
      delete report.error;
      return items;
    } catch (e) {
      if (signal?.aborted) throw e;
      this.logQuery(row.name, now, false);
      const failure = this.failed(row.name, e, this.now());
      report.error = failure.message;
      if (failure.until) report.waitUntil = failure.until;
      return undefined;
    }
  }

  // A movie: t=movie by IMDb id, and t=search by "Title Year" when that finds nothing (or there is no id). IPTorrents
  // the same way on its search page: q=+(tt…)&qf=all, then q=+(Title Year).
  // A show: t=tvsearch by TVDB id with season (and ep), and by title when that finds nothing (or there is no id); the
  // TV categories. IPTorrents' search page: q=+(Title S02E05), or q=+(Title S02) for a season.
  async search(query: TitleQuery, signal?: AbortSignal, options: SearchOptions = {}): Promise<SearchResult> {
    if (!options.manual) requireLive('Searching indexers');
    const releases: Release[] = [], indexers: IndexerReport[] = [];
    for (const row of this.enabledRows(options.protocols)) {
      const settings = this.settingsOf(row), report: IndexerReport = { indexer: row.name, searched: [] };
      indexers.push(report);
      if (query.kind === 'show') {
        for (const item of await this.searchShow(row, settings, query, report, signal)) releases.push(item);
        continue;
      }
      if (row.name === 'iptorrents') {
        const client = this.ipt(row), cats = settings.categories.movies.filter(c => c !== 2045 || query.uhd);
        const imdb = imdbNumber(query.imdbId), imdbId = imdb !== undefined ? `tt${String(imdb).padStart(7, '0')}` : undefined;
        const page = (input: { imdbId?: string; term?: string }) => this.counted(row, input.imdbId ? `q=+(${input.imdbId})&qf=all` : `q=+(${input.term})`, report,
          () => client.search({ categories: cats, ...input, freeleechOnly: settings.freeleechOnly }, signal, this.now()), signal);
        let items = imdbId ? await page({ imdbId }) : undefined;
        if (items?.length === 0 || (!imdbId && !report.error)) items = await page({ term: [query.title, query.year].filter(Boolean).join(' ') });
        for (const item of items ?? []) releases.push(this.torrentRelease(item));
        continue;
      }
      const cat = [...new Set([...settings.categories.movies, ...(query.uhd ? [2045] : [])])].join(',');
      const imdb = imdbNumber(query.imdbId);
      let items: NewznabItem[] | undefined;
      if (imdb !== undefined) items = await this.call(row, { t: 'movie', imdbid: String(imdb).padStart(7, '0'), cat, limit: '100' }, report, signal);
      if (items?.length === 0 || (imdb === undefined && !report.error)) {
        const q = [query.title, query.year].filter(Boolean).join(' ');
        items = await this.call(row, { t: 'search', q, cat, limit: '100' }, report, signal);
      }
      for (const item of items ?? []) releases.push(this.release(row.name, item));
    }
    return { releases, indexers };
  }

  // A show filed under another series is searched twice: by its own name in its own numbers, and as the series' season
  // (by TVDB id, or the series' name when that finds nothing); the pick rules sort out which is which.
  private async searchShow(row: Row, settings: IndexerSettings, query: ShowQuery, report: IndexerReport, signal?: AbortSignal): Promise<Release[]> {
    if (query.series) {
      const { series, tvdbId, ...own } = query, seen = new Set<string>();
      const asSeries: ShowQuery = { ...own, title: series.title, season: series.season, ...(tvdbId ? { tvdbId } : {}) };
      const found = [...await this.searchShow(row, settings, own, report, signal), ...await this.searchShow(row, settings, asSeries, report, signal)];
      return found.filter(r => !seen.has(r.guid) && !!seen.add(r.guid));
    }
    const term = `${query.title} ${episodeCode(query)}`;
    if (row.name === 'iptorrents') {
      const client = this.ipt(row);
      const items = await this.counted(row, `q=+(${term})`, report,
        () => client.search({ categories: settings.categories.tv, term, freeleechOnly: settings.freeleechOnly }, signal, this.now()), signal);
      return (items ?? []).map(item => this.torrentRelease(item));
    }
    const cat = settings.categories.tv.join(','), numbers = { season: String(query.season), ...(query.episode !== undefined ? { ep: String(query.episode) } : {}) };
    let items: NewznabItem[] | undefined;
    if (query.tvdbId) items = await this.call(row, { t: 'tvsearch', tvdbid: String(query.tvdbId), ...numbers, cat, limit: '100' }, report, signal);
    if (items?.length === 0 || (!query.tvdbId && !report.error)) items = await this.call(row, { t: 'tvsearch', q: query.title, ...numbers, cat, limit: '100' }, report, signal);
    return (items ?? []).map(item => this.release(row.name, item));
  }

  // Listens to the new-release feed: each poll hands every listener the releases not seen before.
  feeds(listener: FeedListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // The new-release feed of each enabled indexer: NZBGeek's t=search&cat=2000,5000 (newest first), paged back to a
  // release seen before, and IPTorrents' personal RSS address (one page). Items already in rss_seen are skipped; the
  // new ones go to the listeners, then are recorded as seen. Seen rows older than 14 days go first. `gap`: the poll
  // didn't reach back to what the last one saw, so releases in between may have been missed (a search finds them).
  async poll(signal?: AbortSignal) {
    requireLive('The RSS feed');
    const results: { indexer: IndexerName; fresh: number; error?: string; pages?: number; gap?: true }[] = [];
    this.pruneSeen();
    for (const row of this.feedRows()) {
      const settings = this.settingsOf(row), report: IndexerReport = { indexer: row.name, searched: [] };
      if (row.name === 'iptorrents') {
        // The personal feed needs only the passkey: it isn't a search, so it isn't capped, and it keeps going while
        // the search page is paused (an expired cookie).
        let items: IptItem[];
        try { items = await this.ipt(row).rss(signal); }
        catch (e) {
          if (signal?.aborted) throw e;
          const message = errorText(e);
          prepared(this.db, 'UPDATE indexers SET last_error = ? WHERE name = ?').run(message, row.name);
          this.log('indexer feed failed', { indexer: row.name, error: message });
          results.push({ indexer: row.name, fresh: 0, error: message });
          continue;
        }
        const releases = items.map(item => this.torrentRelease(item));
        const gap = releases.length > 0 && this.hasSeen(row.name) && !releases.some(r => this.seen(row.name, r.guid));
        await this.hand(row.name, releases, results, gap ? { gap } : {});
        continue;
      }
      const cat = [...new Set([...settings.categories.movies, ...settings.categories.tv].map(c => Math.floor(c / 1000) * 1000))].join(',');
      // A first poll (nothing seen yet) takes one page: there is nothing to reach back to.
      const first = !this.hasSeen(row.name), releases: Release[] = [];
      let pages = 0, reached = first, failed = false;
      while (pages < FEED_PAGES) {
        const items = await this.call(row, { t: 'search', cat, offset: String(pages * FEED_PAGE), limit: String(FEED_PAGE) }, report, signal);
        if (!items) { failed = true; break; }
        pages++;
        const page = items.map(item => this.release(row.name, item));
        releases.push(...page);
        if (first || page.length < FEED_PAGE || page.some(r => this.seen(row.name, r.guid))) { reached = true; break; }
      }
      if (failed && !releases.length) { results.push({ indexer: row.name, fresh: 0, ...(report.error ? { error: report.error } : {}) }); continue; }
      const gap = !reached && !failed;
      if (gap) this.log('indexer feed gap', { indexer: row.name, pages, detail: `${pages * FEED_PAGE} new releases since the last poll; older ones may have been missed. Searches still find them.` });
      await this.hand(row.name, releases, results, { pages, ...(gap ? { gap } : {}) });
    }
    return results;
  }
  private seen(name: IndexerName, guid: string) { return !!prepared(this.db, 'SELECT 1 FROM rss_seen WHERE indexer = ? AND guid = ?').get(name, guid); }
  private hasSeen(name: IndexerName) { return !!prepared(this.db, 'SELECT 1 FROM rss_seen WHERE indexer = ? LIMIT 1').get(name); }

  // The releases not seen before go to the listeners, then are recorded as seen.
  private async hand(name: IndexerName, releases: Release[], results: { indexer: IndexerName; fresh: number; pages?: number; gap?: true }[], extra: { pages?: number; gap?: true } = {}) {
    const seen = prepared(this.db, 'SELECT 1 FROM rss_seen WHERE indexer = ? AND guid = ?');
    const fresh = releases.filter((r, i) => !seen.get(name, r.guid) && releases.findIndex(o => o.guid === r.guid) === i);
    for (const listener of [...this.listeners]) {
      try { await listener(fresh); } catch (e) { this.log('feed listener failed', { indexer: name, error: errorText(e) }); }
    }
    const now = this.now();
    this.db.transaction(() => {
      for (const release of fresh) prepared(this.db, 'INSERT OR IGNORE INTO rss_seen(indexer, guid, at) VALUES(?, ?, ?)').run(name, release.guid, now);
    })();
    results.push({ indexer: name, fresh: fresh.length, ...extra });
  }

  pruneSeen() { return prepared(this.db, 'DELETE FROM rss_seen WHERE at < ?').run(this.now() - SEEN_DAYS * DAY).changes; }

  // The release's NZB or .torrent, fetched by tk.box (a failed fetch is tk.box's error, and neither the key nor the
  // cookie lands in the downloader). A .torrent comes with its info hash. A feed's link needs only the passkey, so a
  // paused IPTorrents (an expired cookie) still fetches it.
  async download(release: Pick<Release, 'indexer' | 'link' | 'name'>, signal?: AbortSignal): Promise<NzbFile> {
    requireLive('Fetching from indexers');
    const row = this.row(release.indexer);
    if (!row?.enabled) throw new AppError('INDEXER_DISABLED', `${release.indexer} isn't enabled.`, 409);
    const now = this.now();
    const keyed = release.indexer === 'iptorrents' && release.link.includes(PASSKEY);
    if (!keyed && row.paused_until && row.paused_until > now) throw new AppError('INDEXER_PAUSED', `${release.indexer} is paused until ${new Date(row.paused_until).toISOString()}: ${row.last_error ?? 'after an error'}.`, 503, true);
    try {
      if (row.name === 'iptorrents') {
        const torrent = await this.ipt(row).torrent(release.link, signal);
        this.count(row.name, 'grabs', now);
        return { name: `${fileName(release.name)}.torrent`, bytes: torrent.bytes, infoHash: torrent.infoHash };
      }
      const bytes = await this.client(row).nzb(release.link, signal);
      this.count(row.name, 'grabs', now);
      this.ok(row.name, this.now());
      return { name: `${fileName(release.name)}.nzb`, bytes };
    } catch (e) {
      if (signal?.aborted || e instanceof AppError) throw e;
      const failure = this.failed(row.name, e, this.now());
      throw new AppError('INDEXER_FAILED', failure.message, 502, true);
    }
  }
}
