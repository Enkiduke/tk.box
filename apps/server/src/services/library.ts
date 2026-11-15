import { dirname } from 'node:path';
import { AppError, readOnly, requireThat } from '../errors.js';
import { allows2160p, defaultProfile, type Profile } from '../lib/quality.js';
import { pick, type Decision, type LibraryFile, type PickContext } from '../lib/pick-rules.js';
import { imdbNumber, normaliseTitle, parseRelease } from '../lib/release-name.js';
import { done, fail, retry, type Outcome, type QueueApi, type QueueItem, type HandlerContext } from './queue.js';
import { firstSearchAt, isOut, movieWanted, nextSearchAt, type Wanted } from './wanted.js';
import type { MovieImporter } from './library-import.js';
import type { FeedListener, MovieQuery, NzbFile, Release, SearchResult } from './indexers.js';
import type { Download, GrabRef, Sent } from './downloaders.js';
import type { DownloadStatus } from '../providers/sabnzbd.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { Grab, LibraryStore, LibraryTitle, Released } from '../persistence/library-store.js';
import type { BusEvents } from '../modules/bus.js';

// The library for movies (docs/ARR-REPLACEMENT.md, phase 1): adding a title, wanted, searching (on add, the 30-minute
// sweep with its backoff, RSS), grabbing, following SABnzbd, importing, and the failure rules. Every step that talks
// to something outside runs on the queue: search, send, import, refresh-title and plex-scan.

export type IndexersApi = {
  search(query: MovieQuery, signal?: AbortSignal): Promise<SearchResult>;
  feeds(listener: FeedListener): () => void;
  download(release: Pick<Release, 'indexer' | 'link' | 'name'>, signal?: AbortSignal): Promise<NzbFile>;
};
export type DownloadersApi = { send(download: Download): Promise<Sent>; status(): Promise<DownloadStatus[]>; remove(grab: GrabRef): Promise<void> };
// What Plex holds, by TMDB id (the owner's grant). `ready` reads it when it hasn't been yet; false when it can't.
export type PlexHolds = { has(tmdbId: number): boolean; ready(): Promise<boolean> };
export type AddMovie = { tmdbId: number; by: string; profileId?: number; keep?: boolean; search: boolean };
type Emit = <K extends keyof BusEvents>(event: K, payload: BusEvents[K]) => void;
type TmdbMovie = { title?: string; original_title?: string; release_date?: string; runtime?: number | null; imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null };
  alternative_titles?: { titles?: { title?: string }[] };
  release_dates?: { results?: { iso_3166_1?: string; release_dates?: { type?: number; release_date?: string }[] }[] } };
type SearchPayload = { titleId: number };
type SendPayload = { grabId: number; link: string };
type GrabPayload = { grabId: number };
type FilePayload = { fileId: number };

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// SABnzbd's history holds 500 jobs; a grab it no longer lists for this many checks (30 s apart) is taken as gone.
const MISSING_CHECKS = 6;
// TMDB's facts are read again daily for a movie that isn't out, weekly for one that is.
const REFRESH_UNRELEASED = DAY, REFRESH_RELEASED = 7 * DAY;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

// TMDB's days for a movie: release_dates types 3 (theatrical; 2, limited, when there's no 3), 4 (digital), 5 (physical).
// The US dates when TMDB has them, else the earliest anywhere.
export function releasedFrom(movie: TmdbMovie): Released {
  const results = movie.release_dates?.results ?? [];
  const pickDay = (types: number[]) => {
    const days = (list: typeof results) => list.flatMap(r => (r.release_dates ?? []).filter(d => types.includes(d.type ?? 0) && d.release_date).map(d => d.release_date!.slice(0, 10))).sort();
    return days(results.filter(r => r.iso_3166_1 === 'US'))[0] ?? days(results)[0];
  };
  const theatrical = pickDay([3]) ?? pickDay([2]) ?? (movie.release_date ? movie.release_date.slice(0, 10) : undefined);
  const digital = pickDay([4]), physical = pickDay([5]);
  return { ...(theatrical ? { theatrical } : {}), ...(digital ? { digital } : {}), ...(physical ? { physical } : {}) };
}

export class Library {
  private missing = new Map<number, number>();
  private stopFeed?: () => void;
  constructor(private deps: {
    store: LibraryStore; queue: QueueApi; indexers: IndexersApi; downloaders: DownloadersApi; titles: Pick<TmdbTitles, 'get'>;
    plex: PlexHolds; importer: MovieImporter; scan: (folder: string) => Promise<boolean>; emit: Emit;
    log: (message: string, detail?: Record<string, unknown>) => void; now?: () => number;
  }) {}
  private get store() { return this.deps.store; }
  private now() { return (this.deps.now ?? Date.now)(); }
  // The library searches and grabs on its own only once movies are switched to tk.box (the cutover): until then, and
  // after a switch back, Radarr has them, and titles the cutover imported must not be downloaded twice. Downloads
  // already under way still finish, and an admin's interactive search still works.
  private searching() { return this.store.settings().fulfil.movie === 'tkbox'; }

  // The queue's kinds and the RSS listener.
  register() {
    const { queue } = this.deps;
    queue.handle<SearchPayload>('search', { label: 'Search for releases', area: 'Library', handler: (item, ctx) => this.search(item, ctx) });
    queue.handle<SendPayload>('send', { label: 'Send to the downloader', area: 'Library', handler: (item, ctx) => this.send(item, ctx),
      onFailed: (item, error) => this.sendGaveUp(item, error) });
    queue.handle<GrabPayload>('import', { label: 'Import downloads', area: 'Library', handler: (item, ctx) => this.import(item, ctx),
      onFailed: (item, error) => this.alert(`library.import.${item.payload.grabId}`, 'An import gave up', error) });
    queue.handle<SearchPayload>('refresh-title', { label: 'Refresh titles from TMDB', area: 'Library', handler: item => this.refresh(item) });
    queue.handle<FilePayload>('plex-scan', { label: 'Tell Plex about new files', area: 'Library', handler: item => this.scan(item) });
    this.stopFeed = this.deps.indexers.feeds(async releases => { await this.onFeed(releases); });
  }
  close() { this.stopFeed?.(); }

  private alert(key: string, title: string, detail: string) {
    this.deps.emit('notification.post', { to: 'admins', kind: 'library', tone: 'error', title, detail: detail.slice(0, 500), key });
  }
  private resolve(key: string) { this.deps.emit('notification.resolve', { to: 'admins', key }); }
  private grabChanged(grab: Pick<Grab, 'id' | 'titleId'>) {
    const g = this.store.grab(grab.id);
    if (g) this.deps.emit('library.grab.changed', { grabId: g.id, titleId: g.titleId, state: g.state });
  }

  // ---- Titles ----

  private async tmdb(tmdbId: number) {
    const movie = await this.deps.titles.get(`/movie/${tmdbId}`, { append_to_response: 'alternative_titles,release_dates,external_ids' }) as TmdbMovie | undefined;
    requireThat(movie?.title, 'NOT_FOUND', `TMDB doesn't know movie ${tmdbId}.`, 404);
    const year = movie.release_date && /^\d{4}/.test(movie.release_date) ? Number(movie.release_date.slice(0, 4)) : undefined;
    const imdbId = movie.imdb_id || movie.external_ids?.imdb_id || undefined;
    const aliases = [...new Set([movie.original_title, ...(movie.alternative_titles?.titles ?? []).map(t => t.title)]
      .filter((t): t is string => !!t && t !== movie.title))].slice(0, 50);
    return { title: movie.title, ...(year ? { year } : {}), ...(imdbId ? { imdbId } : {}), aliases, released: releasedFrom(movie),
      ...(movie.runtime ? { runtime: movie.runtime } : {}) };
  }

  // Adds a movie (or monitors it again), with TMDB's ids, aliases and release dates, and searches it as the timing
  // says: at once, or (not out, Early copies off) from its home release.
  async add(input: AddMovie) {
    const settings = this.store.settings(), facts = await this.tmdb(input.tmdbId);
    const profileId = input.profileId && this.store.profile(input.profileId) ? input.profileId : settings.defaultProfile;
    let title = this.store.titleByTmdb('movie', input.tmdbId);
    if (title) {
      this.store.setMonitor(title.id, 'all');
      // Requested now: it no longer belongs to the collection that added it, which won't delete it when it lets go.
      if (title.addedBy === 'collections' && input.by !== 'collections') this.store.setAddedBy(title.id, input.by);
      if (input.keep) this.store.setKeep(title.id, true);
      if (input.profileId && profileId !== title.profileId) this.store.setProfile(title.id, profileId);
      this.store.refreshed(title.id, facts);
    } else {
      title = this.store.insertTitle({ kind: 'movie', tmdbId: input.tmdbId, ...(facts.imdbId ? { imdbId: facts.imdbId } : {}), title: facts.title,
        ...(facts.year ? { year: facts.year } : {}), aliases: facts.aliases, monitor: 'all', profileId, root: settings.roots.movie, keep: !!input.keep,
        released: facts.released, addedBy: input.by });
      this.deps.log('library: movie added', { id: title.id, tmdb: input.tmdbId, by: input.by });
    }
    title = this.store.title(title.id)!;
    const now = this.now(), file = this.store.files(title.id)[0];
    const at = input.search ? firstSearchAt({ now, released: title.released, earlyCopies: settings.earlyCopies, ...(file ? { file } : {}) }) : now + DAY;
    const last = this.store.search(title.id, 'movie');
    this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: last?.lastAt ?? 0, misses: 0, nextAt: at });
    if (input.search && at <= now) this.queueSearch(title.id);
    return title;
  }

  // Stops watching it (a request was cancelled).
  unmonitor(titleId: number) { this.store.setMonitor(titleId, 'none'); this.deps.queue.cancel('search', `movie:${titleId}`); }
  keep(titleId: number, keep: boolean) { this.store.setKeep(titleId, keep); }
  // Clean Up or an admin removed it: the title, its files' records and its grabs go (the files are already gone).
  forget(titleId: number, by: 'cleanup' | 'admin' | 'collections') {
    const title = this.store.title(titleId);
    if (!title) return;
    this.deps.queue.cancel('search', `movie:${titleId}`);
    this.store.deleteTitle(titleId);
    this.deps.emit('library.title.removed', { titleId, kind: title.kind, tmdbId: title.tmdbId, by });
  }
  // A seasonal or rotating collection let the movie go: deleted with its files, but only one the library added for
  // collections that nobody has requested (which hands it over) or kept since. A download under way is cancelled.
  async removeForCollections(titleId: number) {
    const title = this.store.title(titleId);
    if (!title || readOnly()) return false;
    if (title.addedBy !== 'collections' || title.keep) {
      this.deps.log('library: a collection let a movie go that it doesn’t own, so it stays', { title: title.id, addedBy: title.addedBy, keep: title.keep });
      return false;
    }
    const grab = this.store.openGrabFor(title.id);
    if (grab) {
      this.store.updateGrab(grab.id, { state: 'cancelled', error: 'Its collection let it go.', finishedAt: this.now() });
      this.deps.queue.cancel('send', `grab:${grab.id}`);
      this.deps.queue.cancel('import', `grab:${grab.id}`);
      if (grab.downloadId) await this.deps.downloaders.remove({ downloader: 'sabnzbd', downloadId: grab.downloadId })
        .catch(e => this.deps.log('library: could not remove the cancelled download', { grab: grab.id, error: errorText(e) }));
      this.grabChanged(grab);
    }
    const { folder, removed } = await this.deps.importer.deleteFiles(title);
    this.forget(title.id, 'collections');
    this.deps.log('library: removed a movie its collection let go', { title: title.id, tmdb: title.tmdbId, files: removed });
    if (folder && removed.length) await this.deps.scan(folder).catch(e => this.deps.log('library: Plex wasn’t told about the removal', { folder, error: errorText(e) }));
    return true;
  }
  pause(titleId: number, reason: string | null) { this.store.setPaused(titleId, reason); if (reason === null) this.resolve(`library.paused.${titleId}`); }

  private have(title: LibraryTitle): LibraryFile | undefined {
    const file = this.store.files(title.id)[0];
    if (!file) return undefined;
    const grabbedAt = this.store.grabbedAt(file.grabId);
    return { quality: file.quality, proper: file.proper, ...(file.releaseGroup ? { group: file.releaseGroup } : {}), ...(grabbedAt ? { grabbedAt } : {}) };
  }
  wanted(title: LibraryTitle): Wanted {
    const profile = this.profile(title), file = this.store.files(title.id)[0];
    return movieWanted({ monitor: title.monitor, paused: title.paused, inPlex: this.deps.plex.has(title.tmdbId), ...(file ? { file } : {}) }, profile);
  }
  private profile(title: LibraryTitle): Profile { return this.store.profile(title.profileId) ?? defaultProfile(); }
  private context(title: LibraryTitle): PickContext {
    const s = this.store.settings();
    return { profile: this.profile(title), rules: this.store.rules(), settings: { earlyCopies: s.earlyCopies, protocol: s.protocol, properDays: s.properDays },
      blocklist: this.store.blocklist(title.id), now: this.now() };
  }
  private want(title: LibraryTitle) {
    const have = this.have(title);
    return { kind: 'movie' as const, title: { title: title.title, ...(title.year ? { year: title.year } : {}), aliases: title.aliases, ...(title.imdbId ? { imdbId: title.imdbId } : {}) },
      ...(have ? { have } : {}) };
  }

  private queueSearch(titleId: number, runAt?: number) {
    return this.deps.queue.enqueue('search', `movie:${titleId}`, { titleId }, runAt === undefined ? {} : { runAt });
  }

  // ---- The wanted sweep (every 30 minutes) ----

  // Queues a search for each wanted movie whose next search is due, and a TMDB refresh for stale ones.
  async sweep() {
    if (readOnly() || !this.searching()) return { searched: 0, refreshed: 0 };
    await this.deps.plex.ready();
    const now = this.now();
    let searched = 0, refreshed = 0;
    for (const title of this.store.dueMovies(now)) {
      if (this.store.openGrabFor(title.id) || !this.wanted(title).wanted) continue;
      if (this.queueSearch(title.id).added) searched++;
    }
    for (const title of this.store.activeMovies()) {
      const out = isOut(title.released, now), age = now - (title.refreshedAt ?? 0);
      if (age >= (out ? REFRESH_RELEASED : REFRESH_UNRELEASED) && this.deps.queue.enqueue('refresh-title', `movie:${title.id}`, { titleId: title.id }).added) refreshed++;
    }
    return { searched, refreshed };
  }

  // ---- search ----

  private async search(item: QueueItem<SearchPayload>, { signal }: HandlerContext): Promise<Outcome> {
    if (readOnly()) return retry(this.now() + HOUR);
    const title = this.store.title(item.payload.titleId);
    if (!title || title.kind !== 'movie' || !this.searching()) return done();
    await this.deps.plex.ready();
    if (this.store.openGrabFor(title.id) || !this.wanted(title).wanted) return done();
    const profile = this.profile(title);
    const result = await this.deps.indexers.search({ kind: 'movie', title: title.title, ...(title.year ? { year: title.year } : {}),
      ...(title.imdbId ? { imdbId: title.imdbId } : {}), uhd: allows2160p(profile) }, signal);
    // Every indexer over its cap or paused: wait for it, without counting a miss.
    const waits = result.indexers.map(r => r.waitUntil);
    if (!result.releases.length && waits.length && waits.every(w => w !== undefined)) return retry(Math.min(...waits as number[]));
    const now = this.now(), settings = this.store.settings(), last = this.store.search(title.id, 'movie');
    const { best } = pick(result.releases, this.want(title), this.context(title));
    if (best && this.grab(title, best)) {
      this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: now, misses: 0, nextAt: now + DAY });
      return done();
    }
    const misses = (last?.misses ?? 0) + 1, file = this.store.files(title.id)[0];
    this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: now, misses,
      nextAt: nextSearchAt({ now, misses, released: title.released, earlyCopies: settings.earlyCopies, ...(file ? { file } : {}) }) });
    return done();
  }

  // A grab for the decision's release, sent by the queue. Undefined when the title already has one under way.
  private grab(title: LibraryTitle, decision: Decision) {
    const release = decision.release as Release;
    const grab = this.store.insertGrab({ titleId: title.id, releaseName: release.name, indexer: release.indexer, guid: release.guid, protocol: release.protocol,
      ...(release.size !== undefined ? { size: release.size } : {}), quality: decision.quality!, score: decision.score, upgrade: decision.upgrade, downloader: 'sabnzbd' });
    if (!grab) return undefined;
    this.deps.log('library: grabbed', { title: title.id, grab: grab.id, release: release.name, reasons: decision.reasons });
    this.deps.queue.enqueue('send', `grab:${grab.id}`, { grabId: grab.id, link: release.link });
    this.grabChanged(grab);
    return grab;
  }

  // ---- RSS ----

  // New releases from the indexers' feeds, matched to wanted movies by IMDb id or title (and alias); the best for each
  // movie is grabbed as a search would.
  async onFeed(releases: Release[]) {
    if (readOnly() || !releases.length || !this.searching()) return 0;
    const movies = this.store.activeMovies();
    if (!movies.length) return 0;
    await this.deps.plex.ready();
    const byName = new Map<string, LibraryTitle[]>(), byImdb = new Map<number, LibraryTitle>();
    for (const m of movies) {
      for (const name of [m.title, ...m.aliases]) { const key = normaliseTitle(name), list = byName.get(key) ?? []; if (!list.includes(m)) list.push(m); byName.set(key, list); }
      const imdb = imdbNumber(m.imdbId);
      if (imdb !== undefined) byImdb.set(imdb, m);
    }
    const found = new Map<number, Release[]>();
    for (const release of releases) {
      const parsed = parseRelease(release.name, new Date(this.now()).getUTCFullYear());
      if (parsed.season !== undefined || parsed.multiSeason) continue;
      const imdb = imdbNumber(release.ids?.imdb as string | number | undefined);
      const titles = imdb !== undefined && byImdb.has(imdb) ? [byImdb.get(imdb)!] : byName.get(normaliseTitle(parsed.title)) ?? [];
      for (const t of titles) found.set(t.id, [...found.get(t.id) ?? [], release]);
    }
    let grabbed = 0;
    for (const [id, candidates] of found) {
      const title = movies.find(m => m.id === id)!;
      if (this.store.openGrabFor(id) || !this.wanted(title).wanted) continue;
      const { best } = pick(candidates, this.want(title), this.context(title));
      if (best && this.grab(title, best)) grabbed++;
    }
    return grabbed;
  }

  // ---- send ----

  private async send(item: QueueItem<SendPayload>, { signal }: HandlerContext): Promise<Outcome> {
    if (readOnly()) return retry(this.now() + HOUR);
    const grab = this.store.grab(item.payload.grabId);
    if (!grab || grab.state !== 'sending') return done();
    let nzb: NzbFile;
    try { nzb = await this.deps.indexers.download({ indexer: grab.indexer as Release['indexer'], link: item.payload.link, name: grab.releaseName }, signal); }
    catch (e) {
      // The NZB itself won't come: after three tries the release counts as failed and the next one is picked.
      // (A paused or switched-off indexer isn't the release's fault: that just waits.)
      const indexerDown = e instanceof AppError && (e.code === 'INDEXER_PAUSED' || e.code === 'INDEXER_DISABLED');
      if (item.attempts >= 3 && !indexerDown) { await this.failGrab(grab, `The NZB couldn't be fetched: ${errorText(e)}`, true); return done(); }
      return fail(errorText(e));
    }
    try {
      const sent = await this.deps.downloaders.send({ kind: 'movie', protocol: 'usenet', name: grab.releaseName.slice(0, 200), file: nzb.bytes });
      this.store.updateGrab(grab.id, { state: 'downloading', downloadId: sent.downloadId, sentAt: this.now(), progress: 0, error: null });
      this.resolve('library.downloader');
      this.grabChanged(grab);
      return done();
    } catch (e) {
      this.alert('library.downloader', 'SABnzbd can’t take downloads', errorText(e));
      return fail(errorText(e));
    }
  }
  // SABnzbd stayed unreachable through every try: the grab is dropped (the release isn't at fault) and the sweep
  // searches the title again later.
  private sendGaveUp(item: QueueItem<SendPayload>, error: string) {
    const grab = this.store.grab(item.payload.grabId);
    if (!grab || grab.state !== 'sending') return;
    this.store.updateGrab(grab.id, { state: 'failed', error: `Not sent: ${error}`, finishedAt: this.now() });
    this.grabChanged(grab);
  }

  // ---- The SABnzbd check (every 30 s while grabs are open) ----

  async checkDownloads() {
    if (!this.store.hasOpenGrabs()) return { checked: 0 };
    const grabs = this.store.openGrabs().filter(g => g.downloadId && (g.state === 'downloading' || g.state === 'unpacking'));
    if (!grabs.length) return { checked: 0 };
    let statuses: DownloadStatus[];
    try { statuses = await this.deps.downloaders.status(); this.resolve('library.downloader'); }
    catch (e) { this.alert('library.downloader', 'SABnzbd can’t be reached', errorText(e)); throw e; }
    const byId = new Map(statuses.map(s => [s.downloadId, s]));
    for (const grab of grabs) {
      const status = byId.get(grab.downloadId!);
      if (!status) {
        const misses = (this.missing.get(grab.id) ?? 0) + 1;
        this.missing.set(grab.id, misses);
        if (misses >= MISSING_CHECKS) { this.missing.delete(grab.id); await this.failGrab(grab, 'SABnzbd no longer has the download.', true); }
        continue;
      }
      this.missing.delete(grab.id);
      if (status.state === 'failed') await this.failGrab(grab, status.error ?? 'SABnzbd marked the download failed.', true);
      else if (status.state === 'importing') {
        this.store.updateGrab(grab.id, { state: 'importing', progress: 1, finishedAt: this.now(), ...(status.storage ? { contentPath: status.storage } : {}) });
        this.deps.queue.enqueue('import', `grab:${grab.id}`, { grabId: grab.id }, { maxAttempts: 10 });
        this.grabChanged(grab);
      } else {
        const changed = status.state !== grab.state;
        this.store.updateGrab(grab.id, { state: status.state, ...(status.progress !== undefined ? { progress: status.progress } : {}) });
        if (changed) this.grabChanged(grab);
      }
    }
    return { checked: grabs.length };
  }

  // ---- The failure rules ----

  // A failed download: blocklisted (unless it wasn't the release's fault), removed from SABnzbd and searched again. The
  // fifth failure since the title's last import (or an admin unpausing it) pauses it and tells the admins.
  async failGrab(grab: Grab, reason: string, blocklist: boolean) {
    this.store.updateGrab(grab.id, { state: 'failed', error: reason.slice(0, 500), finishedAt: this.now() });
    if (blocklist) this.store.block({ titleId: grab.titleId, releaseName: grab.releaseName, indexer: grab.indexer, guid: grab.guid, reason: reason.slice(0, 500) });
    this.deps.log('library: download failed', { grab: grab.id, title: grab.titleId, release: grab.releaseName, reason });
    if (grab.downloadId && !readOnly()) await this.deps.downloaders.remove({ downloader: 'sabnzbd', downloadId: grab.downloadId })
      .catch(e => this.deps.log('library: could not remove the failed download', { grab: grab.id, error: errorText(e) }));
    this.grabChanged(grab);
    const title = this.store.title(grab.titleId);
    if (!title) return;
    const since = Math.max(this.store.files(title.id)[0]?.importedAt ?? 0, this.store.resumedAt(title.id) ?? 0), failures = this.store.failuresSince(title.id, since), max = this.store.settings().maxFailures;
    if (failures >= max) {
      this.store.setPaused(title.id, `${failures} failed downloads`);
      this.alert(`library.paused.${title.id}`, `${title.title} is paused`, `${failures} downloads failed in a row; the last: ${reason}`);
      return;
    }
    this.queueSearch(title.id);
  }

  // ---- import ----

  private async import(item: QueueItem<GrabPayload>, { signal }: HandlerContext): Promise<Outcome> {
    if (readOnly()) return retry(this.now() + HOUR);
    const grab = this.store.grab(item.payload.grabId);
    if (!grab || grab.state !== 'importing') return done();
    const title = this.store.title(grab.titleId);
    if (!title) { this.store.updateGrab(grab.id, { state: 'cancelled', error: 'The title was removed.' }); return done(); }
    const runtime = await this.tmdb(title.tmdbId).then(f => f.runtime, () => undefined);
    try {
      const result = await this.deps.importer.import(grab, title, runtime, signal);
      if (!result.ok) { await this.failGrab(grab, result.reason, true); return done(); }
      this.resolve(`library.import.${grab.id}`);
      this.deps.log('library: imported', { grab: grab.id, title: title.id, path: result.path, ...(result.copied ? { copied: true } : {}),
        ...(result.replaced.length ? { replaced: result.replaced } : {}) });
      if (result.copied) this.deps.log('library: the download was on another mount, so it was copied instead of moved', { grab: grab.id, path: result.path });
      await this.deps.downloaders.remove({ downloader: 'sabnzbd', downloadId: grab.downloadId ?? '' })
        .catch(e => this.deps.log('library: SABnzbd kept the imported job', { grab: grab.id, error: errorText(e) }));
      const now = this.now(), settings = this.store.settings(), file = this.store.file(result.fileId)!;
      this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: this.store.search(title.id, 'movie')?.lastAt ?? now, misses: 0,
        nextAt: nextSearchAt({ now, misses: 1, released: title.released, earlyCopies: settings.earlyCopies, file }) });
      this.deps.queue.enqueue('plex-scan', `file:${result.fileId}`, { fileId: result.fileId });
      this.grabChanged(grab);
      return done();
    } catch (e) {
      // Disk full, permission denied and the like: the grab stays importing and the queue tries again.
      this.alert(`library.import.${grab.id}`, `${title.title} couldn’t be imported`, errorText(e));
      return fail(errorText(e));
    }
  }

  // ---- plex-scan ----

  private async scan(item: QueueItem<FilePayload>): Promise<Outcome> {
    const file = this.store.file(item.payload.fileId);
    if (!file) return done();
    const title = this.store.title(file.titleId);
    try {
      const scanned = await this.deps.scan(dirname(file.path));
      if (!scanned) this.deps.log('library: no Plex library holds the folder; Plex will find it on its own scan', { path: file.path });
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'NO_PLEX_TOKEN')) return fail(errorText(e));
      this.deps.log('library: no Plex admin token, so Plex wasn’t told', { path: file.path });
    }
    this.deps.emit('library.file.imported', { titleId: file.titleId, fileId: file.id, path: file.path, kind: title?.kind ?? 'movie', tmdbId: title?.tmdbId ?? 0 });
    return done();
  }

  // ---- Admin › Downloads ----

  // Wanted movies (missing or below the cutoff), and paused ones that would be, with their search backoff.
  async wantedList() {
    await this.deps.plex.ready();
    return this.store.monitoredMovies().flatMap(title => {
      const file = this.store.files(title.id)[0], search = this.store.search(title.id, 'movie'), grab = this.store.openGrabFor(title.id);
      const wanted = movieWanted({ monitor: title.monitor, paused: false, inPlex: this.deps.plex.has(title.tmdbId), ...(file ? { file } : {}) }, this.profile(title));
      if (!wanted.wanted) return [];
      return [{ id: title.id, title: title.title, ...(title.year ? { year: title.year } : {}), why: wanted.why, ...(file ? { quality: file.quality } : {}),
        paused: title.paused, ...(title.pausedReason ? { pausedReason: title.pausedReason } : {}),
        ...(search ? { nextAt: search.nextAt, ...(search.lastAt ? { lastAt: search.lastAt } : {}), misses: search.misses } : { misses: 0 }),
        ...(grab ? { grab: grab.state } : {}) }];
    });
  }
  async titleWanted(title: LibraryTitle) { await this.deps.plex.ready(); return this.wanted(title); }

  private movie(titleId: number) {
    const title = this.store.title(titleId);
    requireThat(title && title.kind === 'movie', 'NOT_FOUND', 'No such movie in the library.', 404);
    return title;
  }

  // Search now: queued at once, ahead of its backoff.
  searchNow(titleId: number) {
    const title = this.movie(titleId);
    requireThat(!title.paused, 'TITLE_PAUSED', `${title.title} is paused. Unpause it first.`, 409);
    requireThat(title.monitor !== 'none', 'TITLE_UNMONITORED', `${title.title} isn’t monitored.`, 409);
    requireThat(!this.store.openGrabFor(title.id), 'GRAB_OPEN', `${title.title} already has a download under way.`, 409);
    const search = this.store.search(title.id, 'movie');
    this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: search?.lastAt ?? 0, misses: search?.misses ?? 0, nextAt: this.now() });
    this.deps.queue.enqueue('search', `movie:${title.id}`, { titleId: title.id });
  }

  // Unpausing counts its failures afresh: only blocklist entries from now on pause it again.
  setPaused(titleId: number, paused: boolean) {
    const title = this.movie(titleId);
    if (!paused && title.paused) this.store.audit('library_resumed', { title: title.id });
    this.pause(title.id, paused ? 'Paused by an admin' : null);
  }

  // Interactive search: every release found, with its decision. The releases are kept 30 minutes for Grab, so a grab
  // only ever sends what an indexer itself returned.
  private found = new Map<number, { at: number; releases: Release[] }>();
  async interactive(titleId: number, signal?: AbortSignal) {
    const title = this.movie(titleId);
    const result = await this.deps.indexers.search({ kind: 'movie', title: title.title, ...(title.year ? { year: title.year } : {}),
      ...(title.imdbId ? { imdbId: title.imdbId } : {}), uhd: allows2160p(this.profile(title)) }, signal);
    const now = this.now();
    for (const [id, entry] of this.found) if (now - entry.at > 30 * MINUTE) this.found.delete(id);
    if (this.found.size >= 20) this.found.delete(this.found.keys().next().value!);
    this.found.delete(title.id);
    this.found.set(title.id, { at: now, releases: result.releases });
    const { decisions } = pick(result.releases, this.want(title), this.context(title));
    return {
      releases: decisions.map(d => ({ guid: d.release.guid, name: d.release.name, indexer: d.release.indexer, protocol: d.release.protocol,
        ...(d.release.size !== undefined ? { size: d.release.size } : {}), ...(d.release.publishedAt !== undefined ? { publishedAt: d.release.publishedAt } : {}),
        ...(d.release.grabs !== undefined ? { grabs: d.release.grabs } : {}), ...(d.quality ? { quality: d.quality } : {}),
        score: d.score, accepted: d.accepted, upgrade: d.upgrade, reasons: d.reasons })),
      indexers: result.indexers.map(r => ({ indexer: r.indexer, searched: r.searched, ...(r.error ? { error: r.error } : {}) })),
    };
  }

  // Grab from the last interactive search. A rejected release may be grabbed by hand, but only one whose quality is known.
  grabRelease(titleId: number, guid: string) {
    const title = this.movie(titleId);
    const release = this.found.get(title.id)?.releases.find(r => r.guid === guid);
    requireThat(release, 'SEARCH_EXPIRED', 'Search again: that result is no longer held.', 409);
    const decision = pick([release], this.want(title), this.context(title)).decisions[0]!;
    requireThat(decision.quality, 'QUALITY_UNKNOWN', 'Its quality can’t be read from the name, so it can’t be grabbed.', 409);
    const grab = this.grab(title, decision);
    requireThat(grab, 'GRAB_OPEN', `${title.title} already has a download under way.`, 409);
    this.store.audit('library_manual_grab', { title: title.id, grab: grab.id, release: release.name, accepted: decision.accepted });
    return grab;
  }

  // A failed download's Retry: the title is unpaused and searched again (the failed release stays blocklisted, so the
  // next best is picked; one that was never sent isn't blocklisted and may be picked again).
  retryGrab(grabId: number) {
    const grab = this.store.grab(grabId);
    requireThat(grab && grab.state === 'failed', 'NOT_FOUND', 'No such failed download.', 404);
    const title = this.movie(grab.titleId);
    if (title.paused) this.setPaused(title.id, false);
    if (title.monitor === 'none') this.store.setMonitor(title.id, 'all');
    this.searchNow(title.id);
  }

  // ---- refresh-title ----

  private async refresh(item: QueueItem<SearchPayload>): Promise<Outcome> {
    const title = this.store.title(item.payload.titleId);
    if (!title || title.kind !== 'movie') return done();
    try { this.store.refreshed(title.id, await this.tmdb(title.tmdbId)); }
    catch (e) { return fail(errorText(e), e instanceof AppError && e.code === 'NOT_FOUND'); }
    return done();
  }
}
