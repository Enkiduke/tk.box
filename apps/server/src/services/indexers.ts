import { z } from 'zod';
import type { Db } from '../persistence/database.js';
import type { Vault } from '../security/vault.js';
import { prepared } from '../persistence/statements.js';
import { AppError } from '../errors.js';
import { IndexerError, NzbGeek, type NewznabItem } from '../providers/newznab.js';
import type { Candidate } from '../lib/pick-rules.js';
import { imdbNumber } from '../lib/release-name.js';

// The indexers (docs/ARR-REPLACEMENT.md, "Clients"): their settings and sealed secrets, the hourly and daily search
// caps, pausing after a 429 or a refused key, the new-release feed with rss_seen, and fetching the NZB. Phase 1 has
// NZBGeek only; IPTorrents comes with phase 3.

export const indexerNames = ['nzbgeek', 'iptorrents'] as const;
export type IndexerName = typeof indexerNames[number];

const categories = z.array(z.number().int().positive()).max(20);
export const indexerSettings = z.object({
  categories: z.object({ movies: categories.default([2000, 2040]), tv: categories.default([5000, 5040]) }).strict().default({ movies: [2000, 2040], tv: [5000, 5040] }),
  hourlyCap: z.number().int().min(1).max(10000).default(100),
  dailyCap: z.number().int().min(1).max(100000).default(2000),
}).strict();
export type IndexerSettings = z.infer<typeof indexerSettings>;
// Omitted keeps a saved key; an empty string removes it.
export const indexerInput = z.object({
  enabled: z.boolean().optional(),
  key: z.string().trim().max(200).regex(/^[\w-]*$/).optional(),
  settings: indexerSettings.partial().optional(),
}).strict();

// A release as an indexer found it: what the pick rules read, plus the NZB link (without the key) and its categories.
export type Release = Candidate & { indexer: IndexerName; link: string; categories: number[] };
export type MovieQuery = { kind: 'movie'; title: string; year?: number; imdbId?: string; uhd?: boolean };
// What each indexer did for a search: the calls it made, or why it made none (paused, over a cap) and until when.
export type IndexerReport = { indexer: IndexerName; searched: string[]; error?: string; waitUntil?: number };
export type SearchResult = { releases: Release[]; indexers: IndexerReport[] };
export type FeedListener = (releases: Release[]) => void | Promise<void>;
export type NzbFile = { name: string; bytes: Buffer };

type Row = { name: IndexerName; enabled: number; sealed_secret: string | null; settings: string; last_ok_at: number | null; last_error: string | null; paused_until: number | null };
const HOUR = 3600000, DAY = 24 * HOUR, SEEN_DAYS = 14;
const secretContext = (name: IndexerName) => `indexers:${name}-secret`;
export const nextHour = (now: number) => Math.floor(now / HOUR) * HOUR + HOUR;
const nextDay = (now: number) => Math.floor(now / DAY) * DAY + DAY;
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export class Indexers {
  private listeners = new Set<FeedListener>();
  // Searches this clock hour, per indexer. Kept in memory: a restart forgets the hour's count, never the day's.
  private hour = new Map<IndexerName, { hour: number; count: number }>();
  private now: () => number;
  private transport: typeof fetch;
  private log: (message: string, detail: Record<string, unknown>) => void;

  constructor(private db: Db, private vault: Vault, options: { transport?: typeof fetch; now?: () => number; log?: (message: string, detail: Record<string, unknown>) => void } = {}) {
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? fetch;
    this.log = options.log ?? (() => {});
  }

  private row(name: IndexerName) { return prepared(this.db, 'SELECT * FROM indexers WHERE name = ?').get(name) as Row | undefined; }
  private settingsOf(row: Row | undefined): IndexerSettings { return indexerSettings.parse(row ? JSON.parse(row.settings) : {}); }
  private client(row: Row) {
    if (row.name !== 'nzbgeek') throw new AppError('INDEXER_UNSUPPORTED', 'IPTorrents comes with phase 3.', 409);
    if (!row.sealed_secret) throw new AppError('INDEXER_KEY_MISSING', 'NZBGeek has no API key.', 409);
    return new NzbGeek(this.vault.open(row.sealed_secret, secretContext(row.name)), this.transport);
  }
  private enabledRows() { return (prepared(this.db, 'SELECT * FROM indexers WHERE enabled = 1 AND sealed_secret IS NOT NULL ORDER BY name').all() as Row[]).filter(r => r.name === 'nzbgeek'); }
  anyEnabled() { return this.enabledRows().length > 0; }

  // What Admin shows (phase 1c): never the secret itself.
  view() {
    const now = this.now(), day = dayOf(now);
    return indexerNames.map(name => {
      const row = this.row(name);
      const usage = prepared(this.db, 'SELECT searches, grabs FROM indexer_usage WHERE indexer = ? AND day = ?').get(name, day) as { searches: number; grabs: number } | undefined;
      const hour = this.hour.get(name);
      return {
        name, enabled: !!row?.enabled, secretSet: !!row?.sealed_secret, settings: this.settingsOf(row),
        lastOkAt: row?.last_ok_at ?? null, lastError: row?.last_error ?? null,
        pausedUntil: row?.paused_until && row.paused_until > now ? row.paused_until : null,
        today: { searches: usage?.searches ?? 0, grabs: usage?.grabs ?? 0 },
        thisHour: hour && hour.hour === Math.floor(now / HOUR) ? hour.count : 0,
      };
    });
  }

  // Saves an indexer's settings and key. A new key clears a pause and the last error.
  configure(actor: string, name: IndexerName, input: z.input<typeof indexerInput>) {
    if (name !== 'nzbgeek') throw new AppError('INDEXER_UNSUPPORTED', 'IPTorrents comes with phase 3.', 409);
    const { enabled, key, settings } = indexerInput.parse(input);
    this.db.transaction(() => {
      const row = this.row(name);
      const merged = indexerSettings.parse({ ...this.settingsOf(row), ...settings });
      const sealed = key === undefined ? row?.sealed_secret ?? null : key ? this.vault.seal(key, secretContext(name)) : null;
      const keyChanged = key !== undefined;
      prepared(this.db, `INSERT INTO indexers(name, enabled, sealed_secret, settings, last_ok_at, last_error, paused_until) VALUES(?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, sealed_secret = excluded.sealed_secret, settings = excluded.settings,
          last_error = CASE WHEN ? THEN NULL ELSE indexers.last_error END, paused_until = CASE WHEN ? THEN NULL ELSE indexers.paused_until END`)
        .run(name, (enabled ?? !!row?.enabled) ? 1 : 0, sealed, JSON.stringify(merged), keyChanged ? 1 : 0, keyChanged ? 1 : 0);
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)')
        .run(actor, 'indexer_changed', this.now(), JSON.stringify({ name, enabled: enabled ?? !!row?.enabled, secretSet: !!sealed, settings: merged }));
    })();
    return this.view().find(v => v.name === name)!;
  }

  // Admin's Test: a caps call with the saved key. A refused key is recorded as the last error (without pausing).
  async test(name: IndexerName) {
    const row = this.row(name);
    if (!row) throw new AppError('INDEXER_KEY_MISSING', 'Save an API key first.', 409);
    try { await this.client(row).call({ t: 'caps' }); }
    catch (e) {
      if (e instanceof AppError) throw e;
      prepared(this.db, 'UPDATE indexers SET last_error = ? WHERE name = ?').run(errorText(e), name);
      throw new AppError('INDEXER_TEST_FAILED', errorText(e), 502);
    }
    this.ok(name, this.now());
    return { ok: true as const, detail: 'NZBGeek accepted the key.' };
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

  // A 429 or a Newznab limit pauses the indexer until the next hour; a refused key pauses it for a day, or until a new
  // key is saved.
  private failed(name: IndexerName, error: unknown, now: number) {
    const message = errorText(error);
    const until = error instanceof IndexerError ? error.kind === 'rate' ? nextHour(now) : error.kind === 'auth' ? now + DAY : null : null;
    prepared(this.db, 'UPDATE indexers SET last_error = ?, paused_until = COALESCE(?, paused_until) WHERE name = ?').run(message, until, name);
    this.log('indexer call failed', { indexer: name, error: message, ...(until ? { pausedUntil: until } : {}) });
    return { message, ...(until ? { until } : {}) };
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

  // One counted API call, or the reason it didn't go out.
  private async call(row: Row, params: Record<string, string>, report: IndexerReport, signal?: AbortSignal): Promise<NewznabItem[] | undefined> {
    const now = this.now(), gate = this.gate(row, now);
    if (!gate.ok) { report.error = gate.reason; report.waitUntil = gate.until; return undefined; }
    this.count(row.name, 'searches', now);
    report.searched.push(Object.entries(params).filter(([k]) => k !== 'cat' && k !== 'limit').map(([k, v]) => `${k}=${v}`).join('&'));
    try {
      const items = await this.client(row).call(params, signal);
      this.ok(row.name, this.now());
      delete report.error;
      return items;
    } catch (e) {
      if (signal?.aborted) throw e;
      const failure = this.failed(row.name, e, this.now());
      report.error = failure.message;
      if (failure.until) report.waitUntil = failure.until;
      return undefined;
    }
  }

  // A movie: t=movie by IMDb id, and t=search by "Title Year" when that finds nothing (or there is no id).
  async search(query: MovieQuery, signal?: AbortSignal): Promise<SearchResult> {
    const releases: Release[] = [], indexers: IndexerReport[] = [];
    for (const row of this.enabledRows()) {
      const settings = this.settingsOf(row), report: IndexerReport = { indexer: row.name, searched: [] };
      indexers.push(report);
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

  // Listens to the new-release feed: each poll hands every listener the releases not seen before.
  feeds(listener: FeedListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // The new-release feed of each enabled indexer (t=search&cat=2000,5000&limit=100, newest first). Items already in
  // rss_seen are skipped; the new ones go to the listeners, then are recorded as seen. Seen rows older than 14 days go
// first.
  async poll(signal?: AbortSignal) {
    const results: { indexer: IndexerName; fresh: number; error?: string }[] = [];
    this.pruneSeen();
    for (const row of this.enabledRows()) {
      const settings = this.settingsOf(row), report: IndexerReport = { indexer: row.name, searched: [] };
      const cat = [...new Set([...settings.categories.movies, ...settings.categories.tv].map(c => Math.floor(c / 1000) * 1000))].join(',');
      const items = await this.call(row, { t: 'search', cat, limit: '100' }, report, signal);
      if (!items) { results.push({ indexer: row.name, fresh: 0, ...(report.error ? { error: report.error } : {}) }); continue; }
      const seen = prepared(this.db, 'SELECT 1 FROM rss_seen WHERE indexer = ? AND guid = ?');
      const fresh = items.filter((item, i) => !seen.get(row.name, item.guid) && items.findIndex(o => o.guid === item.guid) === i).map(item => this.release(row.name, item));
      for (const listener of [...this.listeners]) {
        try { await listener(fresh); } catch (e) { this.log('feed listener failed', { indexer: row.name, error: errorText(e) }); }
      }
      const now = this.now();
      this.db.transaction(() => {
        for (const release of fresh) prepared(this.db, 'INSERT OR IGNORE INTO rss_seen(indexer, guid, at) VALUES(?, ?, ?)').run(row.name, release.guid, now);
      })();
      results.push({ indexer: row.name, fresh: fresh.length });
    }
    return results;
  }

  pruneSeen() { return prepared(this.db, 'DELETE FROM rss_seen WHERE at < ?').run(this.now() - SEEN_DAYS * DAY).changes; }

  // The release's NZB, fetched by tk.box (a failed fetch is tk.box's error, and the key never lands in SABnzbd).
  async download(release: Pick<Release, 'indexer' | 'link' | 'name'>, signal?: AbortSignal): Promise<NzbFile> {
    const row = this.row(release.indexer);
    if (!row?.enabled) throw new AppError('INDEXER_DISABLED', `${release.indexer} isn't enabled.`, 409);
    const now = this.now();
    if (row.paused_until && row.paused_until > now) throw new AppError('INDEXER_PAUSED', `${release.indexer} is paused until ${new Date(row.paused_until).toISOString()}: ${row.last_error ?? 'after an error'}.`, 503, true);
    try {
      const bytes = await this.client(row).nzb(release.link, signal);
      this.count(row.name, 'grabs', now);
      this.ok(row.name, this.now());
      return { name: `${release.name.replace(/[\\/:*?"<>|]/g, '').slice(0, 200)}.nzb`, bytes };
    } catch (e) {
      if (signal?.aborted || e instanceof AppError) throw e;
      const failure = this.failed(row.name, e, this.now());
      throw new AppError('INDEXER_FAILED', failure.message, 502, true);
    }
  }
}
