import type { ExploreSeason, RequestItem, RequestLabel } from '../../../../packages/contracts/src/index.js';
import { readOnly, requireThat, requireWritable } from '../errors.js';
import { FulfilError, type Fulfiller, type QueueState } from '../providers/arr-fulfiller.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import { openStatuses, type RequestKind, type RequestRow, type RequestStatus, type RequestStore } from '../persistence/requests-store.js';
import type { RequestAvailability } from './request-availability.js';

// Requests (docs/REQUESTS.md): every allowed viewer may request, and every request is approved as it is made. A request
// is saved first, then sent to Radarr or Sonarr; one that couldn't be sent stays queued and the sweep tries again
// (1 minute, 5, 30, then 2 hours), and after the fifth failure, or one Radarr or Sonarr refused outright, it has failed.
// Statuses come from Plex (available, partial) and Radarr/Sonarr's queue (downloading).
const BACKOFF = [60000, 5 * 60000, 30 * 60000, 2 * 3600000];
const MAX_ATTEMPTS = BACKOFF.length + 1;
// How often each sent title is checked for having been deleted from Radarr or Sonarr.
const EXISTS_MS = 3600000;
export type Requester = { accountId: string; name: string };
export type RequestInput = { kind: RequestKind; tmdb: number; seasons?: number[] };
export type Override = { profileId?: number; rootFolder?: string; tags?: number[] };
export type RequestChange = { id: number; kind: RequestKind; tmdb: number; accountId?: string; status: RequestStatus };
export type CleanupRequest = { id: number; kind: 'movie' | 'tv'; tmdb: number; tvdb: number | null; title: string; year: number | null;
  requester_plex_id: number | null; available_at: string | null; seasons: number[] };
type TmdbTitle = { title?: string; name?: string; release_date?: string; first_air_date?: string; external_ids?: { tvdb_id?: number | null };
  seasons?: { season_number?: number; name?: string; episode_count?: number; air_date?: string | null }[] };

export class Requests {
  private labelCache?: Map<string, RequestLabel>;
  private checked = new Map<number, number>();
  // Told after every change to a row: made, sent, moved on, cancelled.
  changed?: (change: RequestChange) => void;
  constructor(private store: RequestStore, private fulfiller: Fulfiller, private availability: RequestAvailability, private tmdb: Pick<TmdbTitles, 'get'>,
    private connection: (name: 'radarr' | 'sonarr') => ArrService, private log: (message: string, detail: object) => void = () => {}, private now = Date.now) {
    availability.changed = () => { this.labelCache = undefined; };
  }
  connected(kind: RequestKind) { const c = this.connection(kind === 'movie' ? 'radarr' : 'sonarr'); return !!(c.url && c.key); }
  private emit(row: Pick<RequestRow, 'id' | 'kind' | 'tmdbId' | 'accountId'>, status: RequestStatus) {
    this.labelCache = undefined;
    this.changed?.({ id: row.id, kind: row.kind, tmdb: row.tmdbId, ...(row.accountId ? { accountId: row.accountId } : {}), status });
  }
  private held(row: Pick<RequestRow, 'kind' | 'tmdbId' | 'tvdbId'>) { return row.kind === 'movie' ? this.availability.movie(row.tmdbId) : this.availability.show(row.tmdbId, row.tvdbId); }

  // Explore's label for every title that has one: Plex's titles, then open requests for the rest.
  labels() {
    if (this.labelCache) return this.labelCache;
    const labels = new Map<string, RequestLabel>(), live = this.store.live(), rank: Record<RequestLabel, number> = { requested: 1, downloading: 2, partial: 3, available: 4 };
    for (const [kind, id] of this.availability.titles()) labels.set(`${kind}:tmdb:${id}`, 'available');
    for (const row of live) {
      const key = `${row.kind}:tmdb:${row.tmdbId}`, held = this.held(row), current = labels.get(key);
      if (held) {
        if (row.kind === 'show' && openStatuses.includes(row.status) && row.seasons.some(s => !held.seasons.has(s.season))) labels.set(key, 'partial');
        continue;
      }
      if (!openStatuses.includes(row.status)) continue;
      const label: RequestLabel = row.status === 'downloading' ? 'downloading' : 'requested';
      if (!current || rank[label] > rank[current]) labels.set(key, label);
    }
    return this.labelCache = labels;
  }

  // Clean Up's titles: every request now on the server, in full or in part, in the purge script's shape. A requester
  // is named by their Plex account id; one imported without a Plex account has none.
  forCleanup(): CleanupRequest[] {
    return this.store.live().filter(r => r.status === 'available' || r.status === 'partial').map(r => ({
      id: r.id, kind: r.kind === 'movie' ? 'movie' : 'tv', tmdb: r.tmdbId, tvdb: r.tvdbId ?? null, title: r.title, year: r.year ?? null,
      requester_plex_id: r.accountId && /^\d{1,15}$/.test(r.accountId) ? Number(r.accountId) : null,
      available_at: r.availableAt ? new Date(r.availableAt).toISOString() : null, seasons: r.seasons.map(s => s.season) }));
  }
  // Clean Up deleted these whole titles: their requests are removed (seasons it deleted leave the show's requests).
  removedByCleanup(titles: { kind: RequestKind; tmdb: number }[]) {
    for (const { kind, tmdb } of titles) for (const row of this.store.forTitle(kind, tmdb)) {
      this.store.setStatus(row.id, 'removed', { removedBy: 'cleanup', seen: true });
      this.emit(row, 'removed');
    }
  }

  // This server's rating key for the title, when Plex has it.
  plexKey(kind: RequestKind, tmdbId: number, tvdbId?: number) { return this.held({ kind, tmdbId, ...(tvdbId ? { tvdbId } : {}) })?.ratingKey; }

  // Explore's details dialog: what can still be requested, and each regular season's state (TMDB's seasons).
  async titleState(kind: RequestKind, tmdbId: number, tvdbId?: number): Promise<{ requestable: boolean; seasons: ExploreSeason[] }> {
    const held = this.held({ kind, tmdbId, ...(tvdbId ? { tvdbId } : {}) }), live = this.store.forTitle(kind, tmdbId);
    if (kind === 'movie') return { requestable: !held && !live.length, seasons: [] };
    const raw = await this.tmdb.get(`/tv/${tmdbId}`, { append_to_response: 'external_ids' }) as TmdbTitle | undefined;
    const seasons = (raw?.seasons ?? []).filter(s => Number.isInteger(s.season_number) && s.season_number! > 0).sort((a, b) => a.season_number! - b.season_number!).map(s => {
      const n = s.season_number!, rows = live.filter(r => r.seasons.some(rs => rs.season === n));
      const status: RequestLabel | undefined = held?.seasons.has(n) ? 'available' : rows.some(r => r.status === 'downloading') ? 'downloading'
        : rows.some(r => openStatuses.includes(r.status)) ? 'requested' : undefined;
      return { number: n, name: s.name || `Season ${n}`, ...(s.episode_count ? { episodeCount: s.episode_count } : {}), ...(s.air_date ? { airDate: s.air_date } : {}), ...(status ? { status } : {}) };
    });
    return { requestable: seasons.some(s => !s.status), seasons };
  }

  async create(by: Requester, input: RequestInput, override?: Override) {
    requireWritable();
    requireThat(this.connected(input.kind), 'REQUESTS_NOT_CONNECTED', `Requests need ${input.kind === 'movie' ? 'Radarr' : 'Sonarr'} connected in Admin › Connections.`, 409);
    if (!this.availability.ready()) await this.availability.rebuild();
    const raw = await this.tmdb.get(`/${input.kind === 'movie' ? 'movie' : 'tv'}/${input.tmdb}`, { append_to_response: 'external_ids' }) as TmdbTitle | undefined;
    requireThat(raw, 'NOT_FOUND', 'TMDB does not know this title.', 404);
    const title = raw.title || raw.name || `TMDB ${input.tmdb}`, date = raw.release_date || raw.first_air_date, year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
    const tvdbId = input.kind === 'show' && raw.external_ids?.tvdb_id && raw.external_ids.tvdb_id > 0 ? raw.external_ids.tvdb_id : undefined;
    const held = this.held({ kind: input.kind, tmdbId: input.tmdb, ...(tvdbId ? { tvdbId } : {}) }), taken = this.store.forTitle(input.kind, input.tmdb);
    let seasons: number[] = [], monitorFuture = false;
    if (input.kind === 'movie') requireThat(!held && !taken.length, 'REQUEST_EXISTS', held ? `${title} is already on the server.` : `${title} has already been requested.`, 409);
    else {
      const all = [...new Set((raw.seasons ?? []).map(s => s.season_number).filter((n): n is number => Number.isInteger(n) && n! > 0))].sort((a, b) => a - b);
      const gone = new Set([...held?.seasons.keys() ?? [], ...taken.flatMap(r => r.seasons.map(s => s.season))]), open = all.filter(n => !gone.has(n));
      seasons = input.seasons ? [...new Set(input.seasons)].sort((a, b) => a - b) : open;
      const unknown = seasons.find(n => !all.includes(n)), already = seasons.find(n => gone.has(n));
      requireThat(unknown === undefined, 'INVALID_REQUEST', `${title} has no season ${unknown}.`, 400);
      requireThat(already === undefined, 'REQUEST_EXISTS', `Season ${already} of ${title} is already on the server or requested.`, 409);
      requireThat(seasons.length, 'REQUEST_EXISTS', `Every season of ${title} is already on the server or requested.`, 409);
      // Asking for every season left also watches for new ones.
      monitorFuture = open.every(n => seasons.includes(n));
    }
    const settings = this.store.settings()[input.kind];
    const row = this.store.insert({ kind: input.kind, tmdbId: input.tmdb, ...(tvdbId ? { tvdbId } : {}), title, ...(year ? { year } : {}), accountId: by.accountId, accountName: by.name,
      ...((override?.profileId ?? settings.profileId) ? { profileId: override?.profileId ?? settings.profileId } : {}),
      ...((override?.rootFolder ?? settings.rootFolder) ? { rootFolder: override?.rootFolder ?? settings.rootFolder } : {}),
      tags: override?.tags ?? settings.tags, monitorFuture, seasons: seasons.map(season => ({ season })) });
    this.log('request made', { id: row.id, kind: row.kind, tmdb: row.tmdbId, seasons });
    this.emit(row, row.status);
    await this.send(row);
    return this.store.get(row.id)!;
  }

  // One attempt at handing the row to Radarr or Sonarr.
  private async send(row: RequestRow) {
    if (readOnly() || row.status !== 'queued') return;
    const settings = this.store.settings();
    try {
      const arrId = await this.fulfiller.add({ kind: row.kind, tmdbId: row.tmdbId, ...(row.tvdbId ? { tvdbId: row.tvdbId } : {}), title: row.title, seasons: row.seasons.map(s => s.season),
        monitorFuture: row.monitorFuture, ...(row.profileId ? { profileId: row.profileId } : {}), ...(row.rootFolder ? { rootFolder: row.rootFolder } : {}), tags: row.tags,
        search: settings.searchOnAdd, ...(row.kind === 'show' ? { seasonFolders: settings.show.seasonFolders } : {}) });
      this.store.sent(row.id, arrId); this.store.setStatus(row.id, 'requested', { lastError: null });
      this.emit(row, 'requested');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e), permanent = e instanceof FulfilError && e.permanent;
      if (permanent || row.attempts + 1 >= MAX_ATTEMPTS) {
        this.store.setStatus(row.id, 'failed', { lastError: message, seen: false });
        this.log('request failed', { id: row.id, error: message });
        this.emit(row, 'failed');
      } else this.store.attemptFailed(row.id, message, this.now() + BACKOFF[row.attempts]!);
    }
  }

  // Cancel (the requester, while nothing is downloading yet) or remove (an administrator, any time). Radarr or Sonarr
  // stops watching what no other request still needs; nothing is deleted there.
  async cancel(id: number, by: { accountId: string; admin: boolean }) {
    const row = this.store.get(id);
    requireThat(row && row.status !== 'removed' && (by.admin || row.accountId === by.accountId), 'NOT_FOUND', 'No such request.', 404);
    requireThat(by.admin || ['queued', 'requested', 'failed'].includes(row.status), 'REQUEST_IN_PROGRESS', 'This request is already downloading or on the server.', 409);
    this.store.setStatus(id, 'removed', { removedBy: by.accountId, seen: true });
    this.emit(row, 'removed');
    if (row.arrId && !readOnly()) {
      const others = this.store.forTitle(row.kind, row.tmdbId), needed = new Set(others.flatMap(r => r.seasons.map(s => s.season)));
      const free = row.seasons.map(s => s.season).filter(n => !needed.has(n));
      if (row.kind === 'movie' ? !others.length : free.length)
        await this.fulfiller.unmonitor(row.kind, row.arrId, free).catch(e => this.log('request cancel: could not unmonitor', { id, error: (e as Error).message }));
    }
    return this.store.get(id)!;
  }

  async retry(id: number) {
    requireWritable();
    const row = this.store.get(id);
    requireThat(row, 'NOT_FOUND', 'No such request.', 404);
    requireThat(row.status === 'failed', 'INVALID_REQUEST', 'Only a failed request can be tried again.', 409);
    this.store.setStatus(id, 'queued', { lastError: null, seen: true });
    this.emit(row, 'queued');
    await this.send(this.store.get(id)!);
    return this.store.get(id)!;
  }

  // Each minute while any request is open: send what's due, then move each row on from Plex and Radarr/Sonarr.
  async sweep() {
    const open = this.store.open();
    if (!open.length) return;
    if (!this.availability.ready()) await this.availability.rebuild();
    const now = this.now();
    for (const row of open) if (row.status === 'queued' && (row.nextAttemptAt ?? 0) <= now) await this.send(row);
    const queue = await this.fulfiller.queue().catch(e => { this.log('request sweep: queue unavailable', { error: (e as Error).message }); return undefined; });
    for (const row of this.store.open()) await this.advance(row, queue, now);
  }
  // Never checked, or not for an hour.
  private due(id: number, now: number) { const last = this.checked.get(id); return last === undefined || now - last >= EXISTS_MS; }
  private async advance(row: RequestRow, queue: QueueState | undefined, now: number) {
    const held = this.held(row);
    if (held) {
      if (row.kind === 'movie') { this.store.setStatus(row.id, 'available', { availableAt: held.addedAt ?? now, seen: false }); this.emit(row, 'available'); return; }
      const have = row.seasons.filter(s => held.seasons.has(s.season));
      for (const s of have) if (!s.availableAt) this.store.seasonAvailable(row.id, s.season, held.seasons.get(s.season) ?? now);
      const next: RequestStatus | undefined = have.length === row.seasons.length ? 'available' : have.length ? 'partial' : undefined;
      if (next === 'available') { this.store.setStatus(row.id, 'available', { availableAt: held.addedAt ?? now, seen: false }); this.emit(row, 'available'); return; }
      if (next === 'partial' && row.status !== 'partial') { this.store.setStatus(row.id, 'partial', { seen: false }); this.emit(row, 'partial'); return; }
      if (next === 'partial') return;
    }
    if (!row.arrId && row.seerrId && row.status !== 'queued' && this.due(row.id, now)) {
      // Imported from Seerr, so never sent by tk.box: find it in Radarr or Sonarr to follow its downloads.
      this.checked.set(row.id, now);
      const arrId = await this.fulfiller.find(row.kind, row.tmdbId, row.tvdbId).catch(() => undefined);
      if (arrId) { this.store.setArrId(row.id, arrId); row = { ...row, arrId }; }
    }
    if (!row.arrId || row.status === 'queued' || row.status === 'partial') return;
    if (queue) {
      const downloading = row.kind === 'movie' ? queue.movies.has(row.arrId)
        : [...queue.series.get(row.arrId) ?? []].some(season => season === undefined || row.seasons.some(s => s.season === season));
      const next: RequestStatus = downloading ? 'downloading' : 'requested';
      if (next !== row.status) { this.store.setStatus(row.id, next); this.emit(row, next); }
    }
    if (this.due(row.id, now)) {
      this.checked.set(row.id, now);
      const exists = await this.fulfiller.exists(row.kind, row.arrId).catch(() => true);
      if (!exists) { this.store.setStatus(row.id, 'removed', { removedBy: 'arr', seen: false }); this.emit(row, 'removed'); }
    }
  }
}

// What a viewer or Admin › Requests sees of a row.
export function requestItem(row: RequestRow): RequestItem {
  return { id: row.id, kind: row.kind, tmdbId: row.tmdbId, title: row.title, ...(row.year ? { year: row.year } : {}), status: row.status, statusAt: row.statusAt, createdAt: row.createdAt,
    seen: row.seen, seasons: row.seasons.map(s => ({ season: s.season, available: !!s.availableAt })), accountName: row.accountName,
    ...(row.lastError && (row.status === 'failed' || row.status === 'queued') ? { error: row.lastError } : {}), ...(row.removedBy ? { removedBy: removedBy(row) } : {}) };
}
// Who removed it, without naming an administrator's account: the requester, an administrator, Clean Up, or Radarr/Sonarr.
const removedBy = (row: RequestRow) => row.removedBy === 'arr' || row.removedBy === 'cleanup' ? row.removedBy : row.removedBy === row.accountId ? 'requester' : 'admin';
