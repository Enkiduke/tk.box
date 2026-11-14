import { z } from 'zod';
import type { Db } from './database.js';
import { AppError } from '../errors.js';
import { prepared } from './statements.js';

// The requests module's rows (docs/REQUESTS.md). SQL for requests lives here only.
export const requestStatuses = ['queued', 'requested', 'downloading', 'partial', 'available', 'failed', 'removed'] as const;
export type RequestStatus = typeof requestStatuses[number];
export type RequestKind = 'movie' | 'show';
// Rows the sweep still follows: not yet in Plex in full, not failed, not removed.
export const openStatuses: readonly RequestStatus[] = ['queued', 'requested', 'downloading', 'partial'];
export type RequestSeason = { season: number; availableAt?: number };
export type RequestRow = {
  id: number; kind: RequestKind; tmdbId: number; tvdbId?: number; title: string; year?: number;
  accountId?: string; accountName: string; createdAt: number; status: RequestStatus; statusAt: number; seen: boolean;
  profileId?: number; rootFolder?: string; tags: number[]; monitorFuture: boolean; arrId?: number;
  attempts: number; nextAttemptAt?: number; lastError?: string; availableAt?: number; removedAt?: number; removedBy?: string; seerrId?: number;
  seasons: RequestSeason[];
};
export type NewRequest = Pick<RequestRow, 'kind' | 'tmdbId' | 'title' | 'accountName'> & Partial<Pick<RequestRow, 'tvdbId' | 'year' | 'accountId' | 'profileId' | 'rootFolder' | 'monitorFuture' | 'seerrId' | 'availableAt'>>
  & { tags?: number[]; seasons?: RequestSeason[]; status?: RequestStatus; createdAt?: number };

const defaults = (kind: RequestKind) => ({ profileId: 0, rootFolder: '', tags: [] as number[], ...(kind === 'show' ? { seasonFolders: true } : {}) });
// 0 and '' mean "Radarr's or Sonarr's first".
const destination = z.object({ profileId: z.number().int().min(0).max(100000), rootFolder: z.string().trim().max(300), tags: z.array(z.number().int().nonnegative()).max(50) }).strict();
export const requestSettings = z.object({ movie: destination, show: destination.extend({ seasonFolders: z.boolean() }).strict(), searchOnAdd: z.boolean() }).strict();
export type RequestSettings = z.infer<typeof requestSettings>;
const settingDefaults: RequestSettings = { movie: defaults('movie'), show: { ...defaults('show'), seasonFolders: true }, searchOnAdd: true };

type Raw = Record<string, unknown>;
const opt = <T>(value: unknown) => (value === null || value === undefined ? undefined : value as T);
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

export class RequestStore {
  constructor(private db: Db, private now = Date.now) {}
  private seasons(ids: number[]) {
    const bySeason = new Map<number, RequestSeason[]>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      // The list varies by length; prepared() caps its cache, so the uncached prepare is used here.
      const rows = this.db.prepare(`SELECT request_id,season,available_at FROM request_seasons WHERE request_id IN (${placeholders(chunk.length)}) ORDER BY season`).all(...chunk) as Raw[];
      for (const r of rows) {
        const list = bySeason.get(r.request_id as number) ?? [];
        list.push({ season: r.season as number, ...(r.available_at != null ? { availableAt: r.available_at as number } : {}) });
        bySeason.set(r.request_id as number, list);
      }
    }
    return bySeason;
  }
  private rows(raw: Raw[]): RequestRow[] {
    const seasons = this.seasons(raw.map(r => r.id as number));
    return raw.map(r => {
      const row: RequestRow = { id: r.id as number, kind: r.kind as RequestKind, tmdbId: r.tmdb_id as number, title: r.title as string, accountName: r.account_name as string,
        createdAt: r.created_at as number, status: r.status as RequestStatus, statusAt: r.status_at as number, seen: r.seen === 1, tags: JSON.parse(r.tags as string) as number[],
        monitorFuture: r.monitor_future === 1, attempts: r.attempts as number, seasons: seasons.get(r.id as number) ?? [] };
      const extra: Partial<RequestRow> = { tvdbId: opt(r.tvdb_id), year: opt(r.year), accountId: opt(r.account_id), profileId: opt(r.profile_id), rootFolder: opt(r.root_folder),
        arrId: opt(r.arr_id), nextAttemptAt: opt(r.next_attempt_at), lastError: opt(r.last_error), availableAt: opt(r.available_at), removedAt: opt(r.removed_at),
        removedBy: opt(r.removed_by), seerrId: opt(r.seerr_id) };
      for (const [key, value] of Object.entries(extra)) if (value !== undefined) (row as Record<string, unknown>)[key] = value;
      return row;
    });
  }
  importedSeerrIds() { return new Set((prepared(this.db, 'SELECT seerr_id FROM requests WHERE seerr_id IS NOT NULL').all() as { seerr_id: number }[]).map(r => r.seerr_id)); }
  get(id: number) { return this.rows(prepared(this.db, 'SELECT * FROM requests WHERE id=?').all(id) as Raw[])[0]; }
  insert(input: NewRequest) {
    const now = this.now(), status = input.status ?? 'queued', created = input.createdAt ?? now;
    return this.db.transaction(() => {
      const { lastInsertRowid } = prepared(this.db, `INSERT INTO requests(kind,tmdb_id,tvdb_id,title,year,account_id,account_name,created_at,status,status_at,seen,profile_id,root_folder,tags,
        monitor_future,next_attempt_at,available_at,seerr_id) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`)
        .run(input.kind, input.tmdbId, input.tvdbId ?? null, input.title, input.year ?? null, input.accountId ?? null, input.accountName, created, status, now,
          input.profileId ?? null, input.rootFolder ?? null, JSON.stringify(input.tags ?? []), input.monitorFuture ? 1 : 0, status === 'queued' ? now : null, input.availableAt ?? null, input.seerrId ?? null);
      const id = Number(lastInsertRowid), season = prepared(this.db, 'INSERT INTO request_seasons VALUES(?,?,?)');
      for (const s of input.seasons ?? []) season.run(id, s.season, s.availableAt ?? null);
      return this.get(id)!;
    })();
  }
  // Open rows, oldest first.
  open() { return this.rows(prepared(this.db, `SELECT * FROM requests WHERE status IN ('queued','requested','downloading','partial') ORDER BY id`).all() as Raw[]); }
  // Every row that still names the title as requested or on the server: neither failed nor removed.
  live() { return this.rows(prepared(this.db, `SELECT * FROM requests WHERE status NOT IN ('failed','removed') ORDER BY id`).all() as Raw[]); }
  forTitle(kind: RequestKind, tmdbId: number) {
    return this.rows(prepared(this.db, `SELECT * FROM requests WHERE kind=? AND tmdb_id=? AND status NOT IN ('failed','removed') ORDER BY id`).all(kind, tmdbId) as Raw[]);
  }
  mine(accountId: string, limit = 200) {
    return this.rows(prepared(this.db, 'SELECT * FROM requests WHERE account_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(accountId, limit) as Raw[]);
  }
  unseen(accountId: string) { return (prepared(this.db, 'SELECT COUNT(*) AS n FROM requests WHERE account_id=? AND seen=0').get(accountId) as { n: number }).n; }
  markSeen(accountId: string) { prepared(this.db, 'UPDATE requests SET seen=1 WHERE account_id=? AND seen=0').run(accountId); }
  list(filter: { status?: RequestStatus; kind?: RequestKind; account?: string; q?: string; page: number; size: number }) {
    const where: string[] = [], params: unknown[] = [];
    if (filter.status) { where.push('status=?'); params.push(filter.status); }
    if (filter.kind) { where.push('kind=?'); params.push(filter.kind); }
    if (filter.account) { where.push('account_id=?'); params.push(filter.account); }
    if (filter.q) { where.push("(title LIKE ? ESCAPE '\\' OR account_name LIKE ? ESCAPE '\\')"); const like = `%${filter.q.replace(/[\\%_]/g, c => `\\${c}`)}%`; params.push(like, like); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // The clause is built from fixed fragments, one per filter, so the SQL text has few variants.
    const total = (prepared(this.db, `SELECT COUNT(*) AS n FROM requests ${clause}`).get(...params) as { n: number }).n;
    const items = this.rows(prepared(this.db, `SELECT * FROM requests ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, filter.size, (filter.page - 1) * filter.size) as Raw[]);
    return { items, total, page: filter.page, hasMore: filter.page * filter.size < total };
  }
  // `seen: false` marks a change the requester should be told about; left out, the flag stays as it was.
  setStatus(id: number, status: RequestStatus, extra: { availableAt?: number; removedBy?: string; lastError?: string | null; seen?: boolean } = {}) {
    const now = this.now();
    prepared(this.db, `UPDATE requests SET status=?, status_at=?, seen=COALESCE(?,seen), available_at=COALESCE(available_at,?), removed_at=?, removed_by=?, last_error=CASE WHEN ? THEN ? ELSE last_error END,
      next_attempt_at=CASE WHEN ?='queued' THEN ? ELSE NULL END, attempts=CASE WHEN ?='queued' THEN 0 ELSE attempts END WHERE id=?`)
      .run(status, now, extra.seen === undefined ? null : extra.seen ? 1 : 0, extra.availableAt ?? null, status === 'removed' ? now : null, status === 'removed' ? extra.removedBy ?? null : null,
        extra.lastError !== undefined ? 1 : 0, extra.lastError ?? null, status, now, status, id);
  }
  // Radarr or Sonarr took it.
  sent(id: number, arrId: number) { prepared(this.db, 'UPDATE requests SET arr_id=?, last_error=NULL, next_attempt_at=NULL WHERE id=?').run(arrId, id); }
  setArrId(id: number, arrId: number) { prepared(this.db, 'UPDATE requests SET arr_id=? WHERE id=?').run(arrId, id); }
  attemptFailed(id: number, error: string, nextAt: number) { prepared(this.db, 'UPDATE requests SET attempts=attempts+1, last_error=?, next_attempt_at=? WHERE id=?').run(error.slice(0, 500), nextAt, id); }
  seasonAvailable(id: number, season: number, at: number) { prepared(this.db, 'UPDATE request_seasons SET available_at=COALESCE(available_at,?) WHERE request_id=? AND season=?').run(at, id, season); }
  settings(): RequestSettings & { revision: number } {
    const row = prepared(this.db, 'SELECT revision,value FROM requests_settings WHERE id=1').get() as { revision: number; value: string } | undefined;
    return { ...settingDefaults, ...(row ? JSON.parse(row.value) as Partial<RequestSettings> : {}), revision: row?.revision ?? 0 };
  }
  updateSettings(actor: string, expectedRevision: number, input: RequestSettings) {
    const value = requestSettings.parse(input), now = this.now();
    return this.db.transaction(() => {
      const revision = this.settings().revision;
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Request settings changed. Reload and retry.', 409);
      prepared(this.db, 'INSERT INTO requests_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify(value));
      prepared(this.db, 'INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'request_settings_changed', now, JSON.stringify(value));
      return this.settings();
    })();
  }
}
