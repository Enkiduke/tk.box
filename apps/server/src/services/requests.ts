import type { ExploreSeason, RequestArtwork, RequestItem, RequestLabel, RequestTiming } from '../../../../packages/contracts/src/index.js';
import { AppError, readOnly, requireThat, requireWritable } from '../errors.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import { tmdbImage } from '../providers/explore-images.js';
import { openStatuses, type RequestKind, type RequestRow, type RequestStatus, type RequestStore } from '../persistence/requests-store.js';
import type { PlexIndex } from './plex-index.js';
import type { Library, TitleState } from './library.js';

// Requests (docs/REQUESTS.md): every allowed viewer may request, and every request is approved as it is made. A request
// is saved first, then handed to tk.box's library; one that couldn't be stays queued and the sweep tries again
// (1 minute, 5, 30, then 2 hours), and after the fifth failure, or one refused outright, it has failed. Once the
// library has it, its status follows the library and Plex (advance): available or partial from Plex, downloading from
// the library's grabs, removed when the library forgets the title or stops following what it asked for. Nothing polls:
// the library's bus events and Plex index changes move rows on (modules/requests.ts).
const BACKOFF = [60000, 5 * 60000, 30 * 60000, 2 * 3600000];
const MAX_ATTEMPTS = BACKOFF.length + 1;
// What requests ask of the library (the library module's API).
export type RequestsLibrary = Pick<Library, 'add' | 'addShow' | 'unmonitor' | 'unmonitorSeasons' | 'state' | 'states' | 'progress' | 'profiles'>;
export type Requester = { accountId: string; name: string };
export type RequestInput = { kind: RequestKind; tmdb: number; seasons?: number[] };
export type Override = { profileId?: number; rootFolder?: string; tags?: number[]; keep?: boolean; earlyCopies?: boolean };
// `made`: the request was just made (not retried or moved on).
export type RequestChange = { id: number; kind: RequestKind; tmdb: number; accountId?: string; status: RequestStatus; made?: true };
export type CleanupRequest = { id: number; kind: 'movie' | 'tv'; tmdb: number; tvdb: number | null; title: string; year: number | null;
  requester_plex_id: number | null; available_at: string | null; seasons: number[] };
type TmdbTitle = { title?: string; name?: string; release_date?: string; first_air_date?: string; poster_path?: string | null; backdrop_path?: string | null;
  external_ids?: { tvdb_id?: number | null };
  seasons?: { season_number?: number; name?: string; episode_count?: number; air_date?: string | null }[] };
// A season of the library's show it is after: followed and not yet on Plex.
const seasonWanted = (state: TitleState | undefined, n: number) => !!state?.seasons?.some(s => s.season === n && s.monitored);

export class Requests {
  private labelCache?: Map<string, RequestLabel>;
  // Told after every change to a row: made, sent, moved on, cancelled.
  changed?: (change: RequestChange) => void;
  constructor(private store: RequestStore, private library: RequestsLibrary, private plexIndex: PlexIndex, private tmdb: Pick<TmdbTitles, 'get'>,
    private log: (message: string, detail: object) => void = () => {}, private now = Date.now) {
    plexIndex.onChange(() => this.refresh());
  }
  // Requests can always be made: tk.box's library takes both kinds (Explore asks per kind).
  connected(_kind: RequestKind) { return true; }
  private emit(row: Pick<RequestRow, 'id' | 'kind' | 'tmdbId' | 'accountId'>, status: RequestStatus, made = false) {
    this.labelCache = undefined;
    this.changed?.({ id: row.id, kind: row.kind, tmdb: row.tmdbId, ...(row.accountId ? { accountId: row.accountId } : {}), status, ...(made ? { made: true as const } : {}) });
  }
  private held(row: Pick<RequestRow, 'kind' | 'tmdbId' | 'tvdbId'>) { return row.kind === 'movie' ? this.plexIndex.movie(row.tmdbId) : this.plexIndex.show(row.tmdbId, row.tvdbId); }

  // Explore's label for every title that has one: Plex's titles, then what the library is after (whoever added it),
  // then open requests.
  labels() {
    if (this.labelCache) return this.labelCache;
    const labels = new Map<string, RequestLabel>(), rank: Record<RequestLabel, number> = { requested: 1, downloading: 2, partial: 3, available: 4 };
    const put = (key: string, label: RequestLabel) => { const current = labels.get(key); if (!current || rank[label] > rank[current]) labels.set(key, label); };
    for (const [kind, id] of this.plexIndex.titles()) labels.set(`${kind}:tmdb:${id}`, 'available');
    for (const state of this.library.states()) {
      const key = `${state.kind}:tmdb:${state.tmdbId}`;
      if (this.held(state)) {
        // On Plex, with a followed season still short of episodes that have aired (had: a tk.box file or on Plex).
        if (state.kind === 'show' && state.seasons?.some(s => s.monitored && s.have < s.total)) labels.set(key, 'partial');
        continue;
      }
      if (state.monitored) put(key, state.downloading ? 'downloading' : 'requested');
    }
    for (const row of this.store.live()) {
      const key = `${row.kind}:tmdb:${row.tmdbId}`, held = this.held(row);
      if (held) {
        if (row.kind === 'show' && openStatuses.includes(row.status) && row.seasons.some(s => !held.seasons.has(s.season))) labels.set(key, 'partial');
        continue;
      }
      if (openStatuses.includes(row.status)) put(key, row.status === 'downloading' ? 'downloading' : 'requested');
    }
    return this.labelCache = labels;
  }

  // Clean Up's titles, in the purge script's shape: the requested titles Plex holds now (a movie, or a show with any of
  // the seasons asked for), one record per request not failed or removed, so every requester counts. Read from the
  // Plex index when asked, not from statuses saved earlier: a title Plex has lost drops out. Only requested titles
  // (Admin- and Collections-added ones are not candidates, a choice made with the user). A requester is named by their
  // Plex account id; one imported without a Plex account has none. The date is the row's, else Plex's added date.
  async forCleanup(): Promise<CleanupRequest[]> {
    if (!this.plexIndex.ready()) await this.plexIndex.rebuild();
    return this.store.live().flatMap(r => {
      const held = this.held(r);
      if (!held || (r.kind === 'show' && !r.seasons.some(s => held.seasons.has(s.season)))) return [];
      const at = r.availableAt ?? held.addedAt;
      return [{ id: r.id, kind: r.kind === 'movie' ? 'movie' as const : 'tv' as const, tmdb: r.tmdbId, tvdb: r.tvdbId ?? null, title: r.title, year: r.year ?? null,
        requester_plex_id: r.accountId && /^\d{1,15}$/.test(r.accountId) ? Number(r.accountId) : null,
        available_at: at ? new Date(at).toISOString() : null, seasons: r.seasons.map(s => s.season) }];
    });
  }
  // Clean Up deleted these whole titles: their requests are removed (seasons it deleted leave the show's requests).
  removedByCleanup(titles: { kind: RequestKind; tmdb: number }[]) {
    for (const { kind, tmdb } of titles) for (const row of this.store.forTitle(kind, tmdb)) {
      this.store.setStatus(row.id, 'removed', { removedBy: 'cleanup', seen: true });
      this.emit(row, 'removed');
    }
  }

  // The library forgot the title (an admin deleted it, or a collection let it go): its requests are marked removed,
  // and requesters hear of it.
  removedFromLibrary(titles: { kind: RequestKind; tmdb: number }[]) {
    for (const { kind, tmdb } of titles) for (const row of this.store.forTitle(kind, tmdb)) this.remove(row);
  }
  private remove(row: RequestRow) {
    if (row.status === 'removed') return;
    this.store.setStatus(row.id, 'removed', { removedBy: 'library', seen: false });
    this.emit(row, 'removed');
  }

  private tmdbTitle(kind: RequestKind, tmdbId: number) {
    return this.tmdb.get(`/${kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}`, { append_to_response: 'external_ids' }) as Promise<TmdbTitle | undefined>;
  }

  async artwork(id: number): Promise<RequestArtwork> {
    const row = this.store.get(id);
    requireThat(row, 'NOT_FOUND', 'Request not found.', 404);
    // Resolve separately from the request list so TMDB outages and cache misses do not delay its controls.
    const title = await this.tmdbTitle(row.kind, row.tmdbId).catch(() => undefined);
    const posterUrl = typeof title?.poster_path === 'string' ? tmdbImage(title.poster_path, 'w342') : undefined;
    const backdropUrl = typeof title?.backdrop_path === 'string' ? tmdbImage(title.backdrop_path, 'w1280') : undefined;
    return { ...(posterUrl ? { posterUrl } : {}), ...(backdropUrl ? { backdropUrl } : {}) };
  }

  async timing(id: number): Promise<RequestTiming> {
    const row = this.store.get(id);
    requireThat(row && row.status !== 'removed', 'NOT_FOUND', 'Request not found.', 404);
    if (row.status === 'available') {
      if (!this.plexIndex.ready()) await this.plexIndex.rebuild();
      const held = this.held(row);
      if (row.kind === 'movie') return { kind: 'added', at: held?.addedAt };
      const dates = row.seasons.map(({ season }) => held?.seasons.get(season));
      if (dates.length && dates.every(date => date !== undefined)) return { kind: 'added', at: Math.max(...dates) };
      return { kind: 'added' };
    }
    const seasons = row.seasons.filter(s => s.availableAt === undefined).map(s => s.season);
    try {
      const titleId = row.status === 'queued' ? undefined : row.titleId ?? this.library.state(row.kind, row.tmdbId)?.titleId;
      return { kind: 'searched', ...(titleId === undefined ? {} : this.library.progress(titleId, seasons)) };
    } catch {
      return { kind: 'searched', unavailable: true };
    }
  }

  // Explore's details dialog: what can still be requested, and each regular season's state (TMDB's seasons). What the
  // library already follows counts as requested, whoever added it.
  async titleState(kind: RequestKind, tmdbId: number, tvdbId?: number): Promise<{ requestable: boolean; seasons: ExploreSeason[] }> {
    const held = this.held({ kind, tmdbId, ...(tvdbId ? { tvdbId } : {}) }), live = this.store.forTitle(kind, tmdbId), state = this.library.state(kind, tmdbId);
    if (kind === 'movie') return { requestable: !held && !live.length && !state?.monitored, seasons: [] };
    const raw = await this.tmdbTitle(kind, tmdbId);
    const seasons = (raw?.seasons ?? []).filter(s => Number.isInteger(s.season_number) && s.season_number! > 0).sort((a, b) => a.season_number! - b.season_number!).map(s => {
      const n = s.season_number!, rows = live.filter(r => r.seasons.some(rs => rs.season === n)), library = state?.seasons?.find(x => x.season === n);
      const status: RequestLabel | undefined = held?.seasons.has(n) ? 'available'
        : rows.some(r => r.status === 'downloading') || (library?.downloading ?? false) ? 'downloading'
        : rows.some(r => openStatuses.includes(r.status)) || seasonWanted(state, n) ? 'requested' : undefined;
      return { number: n, name: s.name || `Season ${n}`, ...(s.episode_count ? { episodeCount: s.episode_count } : {}), ...(s.air_date ? { airDate: s.air_date } : {}), ...(status ? { status } : {}) };
    });
    return { requestable: seasons.some(s => !s.status), seasons };
  }

  async create(by: Requester, input: RequestInput, override?: Override) {
    requireWritable();
    if (!this.plexIndex.ready()) await this.plexIndex.rebuild();
    const raw = await this.tmdbTitle(input.kind, input.tmdb);
    requireThat(raw, 'NOT_FOUND', 'TMDB does not know this title.', 404);
    const title = raw.title || raw.name || `TMDB ${input.tmdb}`, date = raw.release_date || raw.first_air_date, year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
    const tvdbId = input.kind === 'show' && raw.external_ids?.tvdb_id && raw.external_ids.tvdb_id > 0 ? raw.external_ids.tvdb_id : undefined;
    const held = this.held({ kind: input.kind, tmdbId: input.tmdb, ...(tvdbId ? { tvdbId } : {}) }), taken = this.store.forTitle(input.kind, input.tmdb);
    const state = this.library.state(input.kind, input.tmdb);
    let seasons: number[] = [], monitorFuture = false;
    if (input.kind === 'movie') requireThat(!held && !taken.length && !state?.monitored, 'REQUEST_EXISTS', held ? `${title} is already on the server.` : `${title} has already been requested.`, 409);
    else {
      const all = [...new Set((raw.seasons ?? []).map(s => s.season_number).filter((n): n is number => Number.isInteger(n) && n! > 0))].sort((a, b) => a - b);
      const gone = new Set([...held?.seasons.keys() ?? [], ...taken.flatMap(r => r.seasons.map(s => s.season)), ...all.filter(n => seasonWanted(state, n))]);
      const open = all.filter(n => !gone.has(n));
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
      tags: override?.tags ?? settings.tags, ...(override?.keep ? { keep: true } : {}), ...(override?.earlyCopies && input.kind === 'movie' ? { earlyCopies: true } : {}),
      monitorFuture, seasons: seasons.map(season => ({ season })) });
    this.log('request made', { id: row.id, kind: row.kind, tmdb: row.tmdbId, seasons });
    this.emit(row, row.status, true);
    await this.send(row);
    return this.store.get(row.id)!;
  }

  // One attempt at handing the row to the library; taken, it moves on at once (already on Plex, say).
  private async send(row: RequestRow) {
    if (readOnly() || row.status !== 'queued') return;
    const settings = this.store.settings();
    const input = { tmdbId: row.tmdbId, by: row.accountId ?? 'requests', ...(row.profileId ? { profileId: row.profileId } : {}), keep: row.keep,
      ...(row.kind === 'movie' && row.earlyCopies ? { earlyCopies: true } : {}), search: settings.searchOnAdd };
    try {
      const title = row.kind === 'movie' ? await this.library.add(input)
        : await this.library.addShow({ ...input, seasons: row.seasons.map(s => s.season), monitorFuture: row.monitorFuture });
      this.store.sent(row.id, title.id); this.store.setStatus(row.id, 'requested', { lastError: null });
      this.emit(row, 'requested');
      this.advance(this.store.get(row.id)!);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // TMDB not knowing it, or a show with no TVDB id: trying again won't help.
      const permanent = e instanceof AppError && (e.code === 'NOT_FOUND' || e.code === 'NO_TVDB_ID');
      if (permanent || row.attempts + 1 >= MAX_ATTEMPTS) {
        this.store.setStatus(row.id, 'failed', { lastError: message, seen: false });
        this.log('request failed', { id: row.id, error: message });
        this.emit(row, 'failed');
      } else this.store.attemptFailed(row.id, message, this.now() + BACKOFF[row.attempts]!);
    }
  }

  // Cancel (the requester, while nothing is downloading yet) or remove (an administrator, any time). The library
  // stops watching what no other request still needs; nothing is deleted there.
  async cancel(id: number, by: { accountId: string; admin: boolean }) {
    const row = this.store.get(id);
    requireThat(row && row.status !== 'removed' && (by.admin || row.accountId === by.accountId), 'NOT_FOUND', 'No such request.', 404);
    requireThat(by.admin || ['queued', 'requested', 'failed'].includes(row.status), 'REQUEST_IN_PROGRESS', 'This request is already downloading or on the server.', 409);
    this.store.setStatus(id, 'removed', { removedBy: by.accountId, seen: true });
    this.emit(row, 'removed');
    if (row.titleId && !readOnly()) {
      const others = this.store.forTitle(row.kind, row.tmdbId), needed = new Set(others.flatMap(r => r.seasons.map(s => s.season)));
      const free = row.seasons.map(s => s.season).filter(n => !needed.has(n));
      try {
        if (row.kind === 'movie') { if (!others.length) this.library.unmonitor(row.titleId); }
        else if (free.length) this.library.unmonitorSeasons(row.titleId, free);
      } catch (e) { this.log('request cancel: could not unmonitor', { id, error: (e as Error).message }); }
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

  // Each minute while a request waits to be sent: send what's due.
  async sweep() {
    const due = this.store.open().filter(row => row.status === 'queued' && (row.nextAttemptAt ?? 0) <= this.now());
    for (const row of due) await this.send(row);
  }
  // Every open row moved on (at start, and whenever Plex's index changes).
  refresh() {
    this.labelCache = undefined;
    if (!this.plexIndex.ready()) return;
    for (const row of this.store.open()) this.advance(row);
  }
  // A title changed in the library (added, followed or not, files, forgotten): its rows move on.
  titleChanged(kind: RequestKind, tmdbId: number) {
    this.labelCache = undefined;
    if (!this.plexIndex.ready()) return;
    for (const row of this.store.forTitle(kind, tmdbId)) this.advance(row);
  }
  // A grab moved on for the library's title: its rows may be downloading, or no longer.
  grabChanged(titleId: number) {
    this.labelCache = undefined;
    if (!this.plexIndex.ready()) return;
    for (const row of this.store.openForTitleId(titleId)) this.advance(row);
  }
  // A row's status from Plex and the library, once the library has it (queued rows wait to be sent):
  // - Plex holds the movie, or every asked season: available; some of them: partial.
  // - The library has forgotten the title, or follows none of what is still missing: removed.
  // - The library is downloading it, or an asked season: downloading; otherwise requested.
  private advance(row: RequestRow) {
    if (!openStatuses.includes(row.status) || row.status === 'queued') return;
    const now = this.now(), held = this.held(row);
    let partial = false;
    if (held) {
      if (row.kind === 'movie') return this.moveTo(row, 'available', { availableAt: held.addedAt ?? now, seen: false });
      const have = row.seasons.filter(s => held.seasons.has(s.season));
      for (const s of have) if (!s.availableAt) this.store.seasonAvailable(row.id, s.season, held.seasons.get(s.season) ?? now);
      if (have.length === row.seasons.length) return this.moveTo(row, 'available', { availableAt: held.addedAt ?? now, seen: false });
      partial = have.length > 0;
    }
    const state = this.library.state(row.kind, row.tmdbId);
    // Gone from the library. A row it never took (imported from Seerr) stays as it is.
    if (!state) return row.titleId ? this.remove(row) : undefined;
    if (row.titleId !== state.titleId) this.store.setTitleId(row.id, state.titleId);
    if (partial) return this.moveTo(row, 'partial', { seen: false });
    // Seasons still to come: not on Plex now, and not had before (a season Clean Up deleted is done). Nothing of it on
    // Plex yet and none of that followed: nothing will come, so it's removed. (Partly on Plex, it stays partial, and
    // Clean Up still sees it.)
    const missing = row.seasons.filter(s => !s.availableAt && !held?.seasons.has(s.season)).map(s => s.season);
    const followed = state.monitored && (row.kind === 'movie' || !missing.length || missing.some(n => seasonWanted(state, n)));
    if (!followed) return row.status === 'partial' ? undefined : this.remove(row);
    // Once partly on Plex it stays partial until the rest comes, even if Plex loses what it had.
    if (row.status === 'partial') return;
    const downloading = row.kind === 'movie' ? state.downloading : !!state.seasons?.some(s => s.downloading && missing.includes(s.season));
    this.moveTo(row, downloading ? 'downloading' : 'requested');
  }
  private moveTo(row: RequestRow, status: RequestStatus, extra?: { availableAt?: number; seen?: boolean }) {
    if (row.status === status) return;
    this.store.setStatus(row.id, status, extra);
    this.emit(row, status);
  }
}

// What a viewer or Admin › Requests sees of a row.
export function requestItem(row: RequestRow): RequestItem {
  return { id: row.id, kind: row.kind, tmdbId: row.tmdbId, title: row.title, ...(row.year ? { year: row.year } : {}), status: row.status, statusAt: row.statusAt, createdAt: row.createdAt,
    seen: row.seen, seasons: row.seasons.map(s => ({ season: s.season, available: !!s.availableAt })), accountName: row.accountName,
    ...(row.lastError && (row.status === 'failed' || row.status === 'queued') ? { error: row.lastError } : {}), ...(row.removedBy ? { removedBy: removedBy(row) } : {}) };
}
// Who removed it, without naming an administrator's account: the requester, an administrator, Clean Up, or the library.
export const removedBy = (row: Pick<RequestRow, 'removedBy' | 'accountId'>) => row.removedBy === 'library' || row.removedBy === 'cleanup' ? row.removedBy : row.removedBy === row.accountId ? 'requester' : 'admin';
