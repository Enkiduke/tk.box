import { dirname, win32 } from 'node:path';
import type { ClientItem, DownloaderLive, InteractiveCurrentRelease, MovieSource } from '../../../../packages/contracts/src/downloads.js';
import * as fs from 'node:fs/promises';
import { AppError, readOnly, requireThat, requireWritable } from '../errors.js';
import { scoreFormats } from '../lib/formats.js';
import { DEFAULT_RUNTIME, allows2160p, isPreferred, preferredText, sizeLimits, tierOf, type QualityProfile } from '../lib/profiles.js';
import { builtInProfile } from '../lib/builtin-profiles.js';
import { seedingDecision, seedingRule } from '../lib/seeding.js';
import { compareDecisions, pick, type Decision, type LibraryFile, type PickContext } from '../lib/pick-rules.js';
import { EARLY_COPIES, rank } from '../lib/quality.js';
import { imdbNumber, normaliseTitle, parseRelease, type ParsedRelease } from '../lib/release-name.js';
import { done, fail, retry, type Outcome, type QueueApi, type QueueItem, type HandlerContext } from './queue.js';
import { airedAt, firstSearchAt, followEpisodes, isOut, movieWanted, nextSearchAt, showEnded, type EpisodeFact, type Wanted } from './wanted.js';
import { findVideos, type MovieImporter } from './library-import.js';
import { rarSets, unpack, unpackFolder } from './unpack.js';
import type { FeedListener, MovieQuery, NzbFile, Release, SearchOptions, SearchResult } from './indexers.js';
import type { Download, DownloaderName, GrabRef, RemoveOptions, Sent } from './downloaders.js';
import type { DownloadStatus } from '../providers/download-status.js';
import { stallClock } from '../providers/qbittorrent.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { Grab, LibraryFileRow, LibraryStore, LibraryTitle, Released } from '../persistence/library-store.js';
import type { BusEvents } from '../modules/bus.js';

// The library for movies (docs/ARR-REPLACEMENT.md, phases 1 and 3): adding a title, wanted, searching (on add, the
// 30-minute sweep with its backoff, RSS), grabbing, following SABnzbd and qBittorrent, unpacking, importing, seeding,
// and the failure rules. Usenet comes first: IPTorrents is searched when NZBGeek has nothing, or nothing at the
// cutoff. Every step that talks to something outside runs on the queue: search, send, unpack, import, refresh-title
// and plex-scan.

export type IndexersApi = {
  search(query: MovieQuery, signal?: AbortSignal, options?: SearchOptions): Promise<SearchResult>;
  feeds(listener: FeedListener): () => void;
  download(release: Pick<Release, 'indexer' | 'link' | 'name'>, signal?: AbortSignal): Promise<NzbFile>;
};
export type DownloadersApi = { send(download: Download): Promise<Sent>; status(name?: DownloaderName): Promise<DownloadStatus[]>; remove(grab: GrabRef, options?: RemoveOptions): Promise<void>;
  // Admin's live queue (every item, any category); optional so tests can leave it out.
  live?(): Promise<{ clients: DownloaderLive[]; items: ClientItem[] }> };
// Unpacking a torrent's RARs (services/unpack.ts); tests swap it.
export type Unpacker = { sets(root: string): Promise<string[]>; hasVideo(root: string): Promise<boolean>; unpack(archives: string[], dest: string, signal?: AbortSignal): Promise<void>;
  clear(dest: string): Promise<void> };
export const defaultUnpacker: Unpacker = {
  sets: root => rarSets(root),
  hasVideo: async root => (await findVideos(root)).videos.length > 0,
  unpack: (archives, dest, signal) => unpack(archives, dest, signal),
  clear: dest => fs.rm(dest, { recursive: true, force: true }),
};
// What Plex holds, by TMDB id (the owner's grant). `ready` reads it when it hasn't been yet; false when it can't.
export type PlexHolds = { has(tmdbId: number): boolean; ready(): Promise<boolean> };
export type AddMovie = { tmdbId: number; by: string; profileId?: number; keep?: boolean; search: boolean };
type Emit = <K extends keyof BusEvents>(event: K, payload: BusEvents[K]) => void;
type TmdbMovie = { title?: string; original_title?: string; release_date?: string; runtime?: number | null; imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null };
  alternative_titles?: { titles?: { title?: string }[] };
  release_dates?: { results?: { iso_3166_1?: string; release_dates?: { type?: number; release_date?: string }[] }[] } };
type TmdbShow = { name?: string; original_name?: string; first_air_date?: string; status?: string; episode_run_time?: number[];
  seasons?: { season_number?: number }[];
  external_ids?: { tvdb_id?: number | null; imdb_id?: string | null };
  alternative_titles?: { results?: { title?: string }[] } };
type TmdbSeason = { episodes?: { season_number?: number; episode_number?: number; name?: string; air_date?: string | null; runtime?: number | null }[] };
// TMDB's other names for a title (its original one and alternative titles), for matching release names.
const aliasesOf = (main: string, others: (string | undefined)[]) => [...new Set(others.filter((t): t is string => !!t && t !== main))].slice(0, 50);
const yearOf = (day: string | undefined) => day && /^\d{4}/.test(day) ? Number(day.slice(0, 4)) : undefined;
// `extra`: torrents an RSS feed found, weighed with what the Usenet search finds (Usenet first).
type SearchPayload = { titleId: number; extra?: Release[] };
type SendPayload = { grabId: number; link: string };
// `from`: the unpack folder to import from, instead of the download's.
type GrabPayload = { grabId: number; from?: string };
type FilePayload = { fileId: number };

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// SABnzbd's history holds 500 jobs; a grab it no longer lists for this many checks (30 s apart) is taken as gone.
const MISSING_CHECKS = 6;
// TMDB's facts are read again daily for a movie that isn't out (a show still airing), weekly for one that is (ended).
const REFRESH_UNRELEASED = DAY, REFRESH_RELEASED = 7 * DAY;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const downloaderLabel = (name: string) => name === 'qbittorrent' ? 'qBittorrent' : 'SABnzbd';
// The alert key while a downloader can't be reached or take downloads (SABnzbd kept phase 1's).
const downloaderKey = (name: string) => name === 'qbittorrent' ? 'library.downloader.qbittorrent' : 'library.downloader';
const asDownloader = (name: string): DownloaderName => name === 'qbittorrent' ? 'qbittorrent' : 'sabnzbd';
const matchesLibraryFile = (release: Release, file: LibraryFileRow, grab: Grab | undefined) =>
  (grab?.guid === release.guid && grab.indexer === release.indexer) || file.releaseName?.toLowerCase() === release.name.toLowerCase();

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

// What Interactive search shows was read from a release's name.
export const parsedFacts = (p: ParsedRelease) => ({
  ...(p.resolution ? { resolution: `${p.resolution}p` } : {}), ...(p.source ? { source: p.source } : {}), remux: p.remux,
  ...(p.codec || p.encoder ? { codec: p.encoder ?? p.codec } : {}), hdr: [...p.hdr],
  ...(p.audio.codec ? { audio: [p.audio.codec, p.audio.atmos ? 'Atmos' : '', p.audio.channels ?? ''].filter(Boolean).join(' ') } : {}),
  ...(p.service ? { service: p.service } : {}),
  ...(p.group ? { group: p.group } : {}), editions: [...p.editions], languages: [...p.languages], proper: p.proper, repack: p.repack, hardcodedSubs: p.hardcodedSubs,
});

export class Library {
  private missing = new Map<number, number>();
  private stopFeed?: () => void;
  constructor(private deps: {
    store: LibraryStore; queue: QueueApi; indexers: IndexersApi; downloaders: DownloadersApi; titles: Pick<TmdbTitles, 'get'>;
    plex: PlexHolds; importer: MovieImporter; scan: (folder: string) => Promise<boolean>; emit: Emit;
    log: (message: string, detail?: Record<string, unknown>) => void; now?: () => number; unpacker?: Unpacker;
  }) {}
  private get unpacker() { return this.deps.unpacker ?? defaultUnpacker; }
  private get store() { return this.deps.store; }
  private now() { return (this.deps.now ?? Date.now)(); }

  // The queue's kinds and the RSS listener.
  register() {
    const { queue } = this.deps;
    queue.handle<SearchPayload>('search', { label: 'Search for releases', area: 'Library', handler: (item, ctx) => this.search(item, ctx) });
    queue.handle<SendPayload>('send', { label: 'Send to the downloader', area: 'Library', handler: (item, ctx) => this.send(item, ctx),
      onFailed: (item, error) => this.sendGaveUp(item, error) });
    queue.handle<GrabPayload>('import', { label: 'Import downloads', area: 'Library', handler: (item, ctx) => this.import(item, ctx),
      onFailed: (item, error) => this.alert(`library.import.${item.payload.grabId}`, 'An import gave up', error) });
    queue.handle<GrabPayload>('unpack', { label: 'Unpack torrents', area: 'Library', handler: (item, ctx) => this.unpackGrab(item, ctx),
      onFailed: (item, error) => this.alert(`library.import.${item.payload.grabId}`, 'An unpack gave up', error) });
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
    const year = yearOf(movie.release_date);
    const imdbId = movie.imdb_id || movie.external_ids?.imdb_id || undefined;
    const aliases = aliasesOf(movie.title, [movie.original_title, ...(movie.alternative_titles?.titles ?? []).map(t => t.title)]);
    return { title: movie.title, ...(year ? { year } : {}), ...(imdbId ? { imdbId } : {}), aliases, released: releasedFrom(movie),
      ...(movie.runtime ? { runtime: movie.runtime } : {}) };
  }

  // A show's facts and its episodes (no specials), one TMDB call per season. Episodes' runtimes are their own; the
  // title's is the show's usual one, for an episode TMDB gives none.
  private async tmdbShow(tmdbId: number) {
    const show = await this.deps.titles.get(`/tv/${tmdbId}`, { append_to_response: 'external_ids,alternative_titles' }, HOUR) as TmdbShow | undefined;
    requireThat(show?.name, 'NOT_FOUND', `TMDB doesn't know show ${tmdbId}.`, 404);
    const seasons = [...new Set((show.seasons ?? []).map(s => s.season_number).filter((n): n is number => typeof n === 'number' && n > 0))].sort((a, b) => a - b);
    const listed = await Promise.all(seasons.map(n => this.deps.titles.get(`/tv/${tmdbId}/season/${n}`, {}, HOUR) as Promise<TmdbSeason | undefined>));
    const episodes: EpisodeFact[] = listed.flatMap((season, i) => (season?.episodes ?? []).flatMap(e => {
      if (typeof e.episode_number !== 'number') return [];
      const airDate = e.air_date || undefined, airAt = airedAt(airDate);
      return [{ season: seasons[i]!, episode: e.episode_number, ...(e.name ? { name: e.name } : {}), ...(airDate ? { airDate } : {}),
        ...(airAt !== undefined ? { airAt } : {}), ...(e.runtime ? { runtime: e.runtime } : {}) }];
    }));
    const year = yearOf(show.first_air_date), tvdbId = show.external_ids?.tvdb_id || undefined, imdbId = show.external_ids?.imdb_id || undefined;
    const runtime = show.episode_run_time?.find(m => m > 0) ?? episodes.find(e => e.runtime)?.runtime;
    return {
      facts: { title: show.name, ...(year ? { year } : {}), ...(tvdbId ? { tvdbId } : {}), ...(imdbId ? { imdbId } : {}),
        aliases: aliasesOf(show.name, [show.original_name, ...(show.alternative_titles?.results ?? []).map(t => t.title)]),
        released: show.status ? { status: show.status } : {}, ...(runtime ? { runtime } : {}) },
      seasons, episodes,
    };
  }

  // Reads a show from TMDB again: its facts, seasons and episodes, with the monitored flags its mode gives new ones
  // (`chosen`: Manual's seasons, the first time).
  async refreshShow(titleId: number, chosen?: readonly number[]) {
    const title = this.store.title(titleId);
    requireThat(title?.kind === 'show', 'NOT_FOUND', 'No such show.', 404);
    const { facts, ...tmdb } = await this.tmdbShow(title.tmdbId);
    const follow = { monitor: title.monitor, ...(title.monitorFrom !== undefined ? { monitorFrom: title.monitorFrom } : {}), ...(chosen ? { chosen } : {}) };
    const next = followEpisodes(follow, tmdb, { seasons: this.store.seasons(title.id), episodes: this.store.episodes(title.id) });
    this.inTransaction(() => { this.store.refreshed(title.id, facts); this.store.saveEpisodes(title.id, next.seasons, next.episodes); });
    return this.store.title(title.id)!;
  }
  private inTransaction(write: () => void) { this.store.db.transaction(write)(); }

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
        released: facts.released, addedBy: input.by, ...(facts.runtime ? { runtime: facts.runtime } : {}) });
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
      if (grab.downloadId) await this.deps.downloaders.remove({ downloader: grab.downloader, downloadId: grab.downloadId })
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

  private have(title: LibraryTitle, file: LibraryFileRow | undefined) {
    if (!file) return undefined;
    const grabbedAt = this.store.grabbedAt(file.grabId);
    // Its score under the title's profile as it is now, from the name it was grabbed by. With no release name it has no
    // score, and upgrades by tier only.
    const scored = file.releaseName ? scoreFormats({ parsed: parseRelease(file.releaseName), quality: file.quality }, this.store.formats(), this.profile(title).scores) : undefined;
    return { quality: file.quality, proper: file.proper, ...(file.releaseGroup ? { group: file.releaseGroup } : {}), ...(grabbedAt ? { grabbedAt } : {}),
      ...(scored ? { score: scored.score, scoreParts: scored.parts } : {}) } satisfies LibraryFile & { scoreParts?: InteractiveCurrentRelease['scoreParts'] };
  }
  wanted(title: LibraryTitle): Wanted {
    const profile = this.profile(title), file = this.store.files(title.id)[0];
    return movieWanted({ monitor: title.monitor, paused: title.paused, inPlex: this.deps.plex.has(title.tmdbId), ...(file ? { file } : {}) }, profile);
  }
  private profile(title: LibraryTitle): QualityProfile { return this.store.profile(title.profileId) ?? builtInProfile('standard')!.profile; }
  private context(title: LibraryTitle): PickContext {
    const s = this.store.settings();
    return { profile: this.profile(title), formats: this.store.formats(), settings: { earlyCopies: s.earlyCopies, protocol: s.protocol, properDays: s.properDays },
      blocklist: this.store.blocklist(title.id), now: this.now() };
  }
  private want(title: LibraryTitle, file = this.store.files(title.id)[0]) {
    const have = this.have(title, file);
    return { kind: 'movie' as const, title: { title: title.title, ...(title.year ? { year: title.year } : {}), aliases: title.aliases, ...(title.imdbId ? { imdbId: title.imdbId } : {}) },
      ...(have ? { have } : {}), ...(title.runtime ? { runtime: title.runtime } : {}) };
  }

  private queueSearch(titleId: number, runAt?: number, extra?: Release[]) {
    return this.deps.queue.enqueue('search', `movie:${titleId}`, { titleId, ...(extra?.length ? { extra } : {}) }, runAt === undefined ? {} : { runAt });
  }

  // ---- The wanted sweep (every 30 minutes) ----

  // Queues a search for each wanted movie whose next search is due, and a TMDB refresh for stale ones.
  async sweep() {
    if (readOnly()) return { searched: 0, refreshed: 0 };
    await this.deps.plex.ready();
    const now = this.now();
    let searched = 0, refreshed = 0;
    for (const title of this.store.dueMovies(now)) {
      if (this.store.openGrabFor(title.id) || !this.wanted(title).wanted) continue;
      if (this.queueSearch(title.id).added) searched++;
    }
    // TMDB again: daily for a movie that isn't out or a show still airing, weekly once it's out or ended.
    for (const title of [...this.store.activeMovies(), ...this.store.activeShows()]) {
      const settled = title.kind === 'movie' ? isOut(title.released, now) : showEnded(title.released), age = now - (title.refreshedAt ?? 0);
      if (age >= (settled ? REFRESH_RELEASED : REFRESH_UNRELEASED) && this.deps.queue.enqueue('refresh-title', `${title.kind}:${title.id}`, { titleId: title.id }).added) refreshed++;
    }
    return { searched, refreshed };
  }

  // ---- search ----

  private async search(item: QueueItem<SearchPayload>, { signal }: HandlerContext): Promise<Outcome> {
    if (readOnly()) return retry(this.now() + HOUR);
    const title = this.store.title(item.payload.titleId);
    if (!title || title.kind !== 'movie') return done();
    await this.deps.plex.ready();
    if (this.store.openGrabFor(title.id) || !this.wanted(title).wanted) return done();
    const result = await this.searchInOrder(title, signal, item.payload.extra ?? []);
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

  // The preferred protocol's indexers first (Usenet, by default); the other's only when the first found nothing
  // acceptable, or nothing at the profile's cutoff, so a torrent is grabbed only when Usenet has nothing or only a worse
  // quality. The pick then ranks quality before protocol, so at the same quality the preferred one still wins.
  private async searchInOrder(title: LibraryTitle, signal: AbortSignal | undefined, extra: Release[]): Promise<SearchResult> {
    const profile = this.profile(title), settings = this.store.settings();
    const query: MovieQuery = { kind: 'movie', title: title.title, ...(title.year ? { year: title.year } : {}), ...(title.imdbId ? { imdbId: title.imdbId } : {}), uhd: allows2160p(profile) };
    const first = settings.protocol === 'torrent-first' ? 'torrent' as const : 'usenet' as const, second = first === 'usenet' ? 'torrent' as const : 'usenet' as const;
    const one = await this.deps.indexers.search(query, signal, { protocols: [first] });
    const releases = [...one.releases, ...extra.filter(r => !one.releases.some(o => o.guid === r.guid))];
    const context = this.context(title), { best } = pick(releases, this.want(title), context);
    if (best && isPreferred(context.profile, best.quality!) && best.release.protocol === first) return { releases, indexers: one.indexers };
    const two = await this.deps.indexers.search(query, signal, { protocols: [second] });
    return { releases: [...releases, ...two.releases.filter(r => !releases.some(o => o.guid === r.guid))], indexers: [...one.indexers, ...two.indexers] };
  }

  // A grab for the decision's release, sent by the queue. Undefined when the title already has one under way.
  private grab(title: LibraryTitle, decision: Decision, note?: string) {
    const release = decision.release as Release;
    const grab = this.store.insertGrab({ titleId: title.id, releaseName: release.name, indexer: release.indexer, guid: release.guid, protocol: release.protocol,
      ...(release.size !== undefined ? { size: release.size } : {}), quality: decision.quality!, score: decision.score, upgrade: decision.upgrade,
      downloader: release.protocol === 'torrent' ? 'qbittorrent' : 'sabnzbd' }, note);
    if (!grab) return undefined;
    this.deps.log('library: grabbed', { title: title.id, grab: grab.id, release: release.name, reasons: decision.reasons });
    this.deps.queue.enqueue('send', `grab:${grab.id}`, { grabId: grab.id, link: release.link });
    this.grabChanged(grab);
    return grab;
  }

  // ---- RSS ----

  // New releases from the indexers' feeds, matched to wanted movies by IMDb id or title (and alias); the best for each
  // movie is grabbed as a search would. A torrent that would win while Usenet comes first isn't grabbed straight
  // away: a search asks Usenet first, with the feed's torrents weighed in.
  async onFeed(releases: Release[]) {
    if (readOnly() || !releases.length) return 0;
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
      if (!best) continue;
      const first = this.store.settings().protocol === 'torrent-first' ? 'torrent' : 'usenet';
      if (best.release.protocol !== first) { this.queueSearch(title.id, undefined, candidates.filter(c => c.protocol !== first)); continue; }
      if (this.grab(title, best)) grabbed++;
    }
    return grabbed;
  }

  // ---- send ----

  private async send(item: QueueItem<SendPayload>, { signal }: HandlerContext): Promise<Outcome> {
    if (readOnly()) return retry(this.now() + HOUR);
    const grab = this.store.grab(item.payload.grabId);
    if (!grab || grab.state !== 'sending') return done();
    let nzb: NzbFile;
    const what = grab.protocol === 'torrent' ? 'The .torrent' : 'The NZB';
    try { nzb = await this.deps.indexers.download({ indexer: grab.indexer as Release['indexer'], link: item.payload.link, name: grab.releaseName }, signal); }
    catch (e) {
      // The file itself won't come: after three tries the release counts as failed and the next one is picked.
      // (A paused or switched-off indexer isn't the release's fault: that just waits.)
      const indexerDown = e instanceof AppError && (e.code === 'INDEXER_PAUSED' || e.code === 'INDEXER_DISABLED');
      if (item.attempts >= 3 && !indexerDown) { await this.failGrab(grab, `${what} couldn't be fetched: ${errorText(e)}`, true); return done(); }
      return fail(errorText(e));
    }
    if (grab.protocol === 'torrent' && !nzb.infoHash) { await this.failGrab(grab, 'The .torrent had no info hash.', true); return done(); }
    // A torrent already blocklisted by its hash (the same torrent under another listing) isn't sent.
    if (nzb.infoHash && this.store.blocklist(grab.titleId).some(b => b.infoHash?.toLowerCase() === nzb.infoHash!.toLowerCase())) {
      await this.failGrab(grab, 'That torrent is on the blocklist.', false); return done();
    }
    const key = downloaderKey(grab.downloader), label = downloaderLabel(grab.downloader);
    try {
      const seedingMinutes = seedingRule(this.store.settings().seeding).maxDays * 24 * 60;
      const sent = await this.deps.downloaders.send({ kind: 'movie', protocol: grab.protocol, name: grab.releaseName.slice(0, 200), file: nzb.bytes,
        ...(nzb.infoHash ? { infoHash: nzb.infoHash, seedingMinutes } : {}) });
      const now = this.now();
      this.store.updateGrab(grab.id, { state: 'downloading', downloadId: sent.downloadId, sentAt: now, progress: 0, progressAt: now, error: null }, `Sent to ${label}`);
      if (sent.warning) this.deps.log('library: sent with a warning', { grab: grab.id, warning: sent.warning });
      this.resolve(key);
      this.grabChanged(grab);
      return done();
    } catch (e) {
      this.alert(key, `${label} can’t take downloads`, errorText(e));
      return fail(errorText(e));
    }
  }
  // The downloader stayed unreachable through every try: the grab is dropped (the release isn't at fault) and the sweep
  // searches the title again later.
  private sendGaveUp(item: QueueItem<SendPayload>, error: string) {
    const grab = this.store.grab(item.payload.grabId);
    if (!grab || grab.state !== 'sending') return;
    this.store.updateGrab(grab.id, { state: 'failed', error: `Not sent: ${error}`, finishedAt: this.now() });
    this.grabChanged(grab);
  }

  // ---- The download check (every 30 s while grabs are under way): SABnzbd and qBittorrent ----

  async checkDownloads() {
    if (!this.store.hasOpenGrabs()) return { checked: 0 };
    // SABnzbd's own unpacking is followed; a torrent being unpacked is tk.box's (the unpack queue).
    const grabs = this.store.activeGrabs().filter(g => g.downloadId && (g.state === 'downloading' || (g.state === 'unpacking' && g.protocol === 'usenet')));
    if (!grabs.length) return { checked: 0 };
    let failure: unknown;
    for (const name of [...new Set(grabs.map(g => asDownloader(g.downloader)))]) {
      let statuses: DownloadStatus[];
      try { statuses = await this.deps.downloaders.status(name); this.resolve(downloaderKey(name)); }
      catch (e) { this.alert(downloaderKey(name), `${downloaderLabel(name)} can’t be reached`, errorText(e)); failure ??= e; continue; }
      await this.follow(grabs.filter(g => asDownloader(g.downloader) === name), statuses);
    }
    if (failure) throw failure;
    return { checked: grabs.length };
  }

  private async follow(grabs: Grab[], statuses: DownloadStatus[]) {
    const byId = new Map(statuses.map(s => [s.downloadId.toLowerCase(), s]));
    const now = this.now(), stalledMs = this.store.settings().stalledHours * HOUR;
    for (const grab of grabs) {
      const status = byId.get(grab.downloadId!.toLowerCase()), label = downloaderLabel(grab.downloader);
      if (!status) {
        const misses = (this.missing.get(grab.id) ?? 0) + 1;
        this.missing.set(grab.id, misses);
        if (misses >= MISSING_CHECKS) { this.missing.delete(grab.id); await this.failGrab(grab, `${label} no longer has the download.`, true); }
        continue;
      }
      this.missing.delete(grab.id);
      if (status.state === 'failed') await this.failGrab(grab, status.error ?? `${label} marked the download failed.`, true);
      else if (status.state === 'downloading' && grab.protocol === 'torrent') {
        // The stalled rule: no progress for stalledHours (6) counts as failed, unless qBittorrent itself holds it.
        const clock = stallClock({ ...(grab.progress !== undefined ? { progress: grab.progress } : {}), ...(grab.progressAt ?? grab.sentAt ? { progressAt: grab.progressAt ?? grab.sentAt } : {}) }, status, now);
        if (clock.stalledMs >= stalledMs) { await this.failGrab(grab, `No progress for ${Math.round(clock.stalledMs / HOUR)} h (${status.torrentState ?? 'stalled'}).`, true); continue; }
        this.store.updateGrab(grab.id, { progress: status.progress ?? 0, progressAt: clock.progressAt });
      } else if (status.state === 'importing') {
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

  // A failed download: blocklisted (unless it wasn't the release's fault; a torrent by its info hash too), removed from
  // its downloader with its files, and searched again. The fifth failure since the title's last import (or an admin
  // unpausing it) pauses it and tells the admins.
  async failGrab(grab: Grab, reason: string, blocklist: boolean) {
    this.store.updateGrab(grab.id, { state: 'failed', error: reason.slice(0, 500), finishedAt: this.now() });
    if (blocklist) this.store.block({ titleId: grab.titleId, releaseName: grab.releaseName, indexer: grab.indexer, guid: grab.guid,
      ...(grab.protocol === 'torrent' && grab.downloadId ? { infoHash: grab.downloadId } : {}), reason: reason.slice(0, 500) });
    this.deps.log('library: download failed', { grab: grab.id, title: grab.titleId, release: grab.releaseName, reason });
    if (grab.downloadId && !readOnly()) await this.deps.downloaders.remove({ downloader: grab.downloader, downloadId: grab.downloadId }, { deleteFiles: true })
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

  // A torrent whose files are RARs goes to the unpack queue first; the unpacked copy is then imported from the unpack
  // folder (renamed in, and the folder removed). A torrent's own file is hardlinked, and the grab is then seeding.
  private async import(item: QueueItem<GrabPayload>, { signal }: HandlerContext): Promise<Outcome> {
    if (readOnly()) return retry(this.now() + HOUR);
    const grab = this.store.grab(item.payload.grabId);
    if (!grab || grab.state !== 'importing') return done();
    const title = this.store.title(grab.titleId);
    if (!title) { this.store.updateGrab(grab.id, { state: 'cancelled', error: 'The title was removed.' }); return done(); }
    const torrent = grab.protocol === 'torrent', from = item.payload.from;
    if (torrent && !from && grab.contentPath) {
      const sets = await this.unpacker.sets(grab.contentPath).catch(() => [] as string[]);
      if (sets.length && !(await this.unpacker.hasVideo(grab.contentPath).catch(() => false))) {
        this.store.updateGrab(grab.id, { state: 'unpacking' });
        this.deps.queue.enqueue('unpack', `grab:${grab.id}`, { grabId: grab.id }, { maxAttempts: 3 });
        this.grabChanged(grab);
        return done();
      }
    }
    const runtime = await this.tmdb(title.tmdbId).then(f => f.runtime, () => undefined);
    try {
      const result = await this.deps.importer.import(grab, title, runtime, signal,
        torrent ? (from ? { from, state: 'seeding' } : { link: true, state: 'seeding' }) : {});
      if (from) await this.unpacker.clear(from).catch(e => this.deps.log('library: the unpack folder stayed', { grab: grab.id, folder: from, error: errorText(e) }));
      if (!result.ok) { await this.failGrab(grab, result.reason, true); return done(); }
      this.resolve(`library.import.${grab.id}`);
      this.deps.log('library: imported', { grab: grab.id, title: title.id, path: result.path, ...(result.copied ? { copied: true } : {}),
        ...(result.replaced.length ? { replaced: result.replaced } : {}) });
      if (result.copied) this.deps.log(`library: the download was on another mount, so it was copied instead of ${torrent && !from ? 'linked' : 'moved'}`, { grab: grab.id, path: result.path });
      // SABnzbd's job and folder go; a torrent keeps seeding until the seeding check removes it.
      if (!torrent) await this.deps.downloaders.remove({ downloader: 'sabnzbd', downloadId: grab.downloadId ?? '' })
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

  // ---- unpack ----

  // unrar (or 7z) into .tk-unpack/<grab id>/ beside the download, at low priority; the RARs keep seeding. An archive
  // that fails twice counts as a failed download.
  private async unpackGrab(item: QueueItem<GrabPayload>, { signal }: HandlerContext): Promise<Outcome> {
    if (readOnly()) return retry(this.now() + HOUR);
    const grab = this.store.grab(item.payload.grabId);
    if (!grab || grab.state !== 'unpacking' || grab.protocol !== 'torrent' || !grab.contentPath) return done();
    const dest = unpackFolder(grab.contentPath, grab.id);
    try {
      const sets = await this.unpacker.sets(grab.contentPath);
      if (!sets.length) throw new Error('No RAR set was found any more.');
      await this.unpacker.unpack(sets, dest, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      await this.unpacker.clear(dest).catch(() => {});
      if (item.attempts >= 2) { await this.failGrab(grab, `Unpacking failed: ${errorText(e)}`, true); return done(); }
      return fail(errorText(e));
    }
    this.store.updateGrab(grab.id, { state: 'importing' });
    this.deps.queue.enqueue('import', `grab:${grab.id}`, { grabId: grab.id, from: dest }, { maxAttempts: 10 });
    this.grabChanged(grab);
    return done();
  }

  // ---- The seeding check (hourly) ----

  // Each seeding torrent's ratio and seeding time are recorded, and one that meets the rule (lib/seeding.ts: ratio 2
  // and 14 days, or 28 days, never under IPTorrents' 14-day / ratio-1 floor) is deleted from qBittorrent with its
  // download; the library's hardlink or copy stays, and the grab is done. A finished tk.box torrent with no grab at all
  // (its title was removed) goes by the same rule. A torrent qBittorrent no longer lists was removed there by hand.
  async seedingCheck() {
    if (readOnly()) return { checked: 0, removed: 0 };
    const seeding = this.store.seedingGrabs();
    let statuses: DownloadStatus[];
    try { statuses = await this.deps.downloaders.status('qbittorrent'); this.resolve(downloaderKey('qbittorrent')); }
    catch (e) {
      if (!seeding.length) return { checked: 0, removed: 0 };
      this.alert(downloaderKey('qbittorrent'), 'qBittorrent can’t be reached', errorText(e)); throw e;
    }
    const byHash = new Map(statuses.map(s => [s.downloadId.toLowerCase(), s]));
    const now = this.now(), settings = this.store.settings().seeding;
    let removed = 0;
    const take = async (hash: string, figures: { ratio: number; seedingSeconds: number }, grab?: Grab) => {
      const decision = seedingDecision(figures, settings, now);
      if (grab) this.store.updateGrab(grab.id, { ratio: figures.ratio, seedingSeconds: Math.round(figures.seedingSeconds), seedingCheckedAt: now });
      if (!decision.remove) return;
      try { await this.deps.downloaders.remove({ downloader: 'qbittorrent', downloadId: hash }, { deleteFiles: true }); }
      catch (e) { this.deps.log('library: a seeded torrent could not be removed', { hash, error: errorText(e) }); return; }
      removed++;
      this.deps.log('library: removed a seeded torrent; the library file stays', { hash, ...(grab ? { grab: grab.id } : { orphan: true }), reason: decision.reason });
      if (grab) { this.store.updateGrab(grab.id, { state: 'done', removedAt: now }, `Removed from qBittorrent: ${decision.reason ?? "seeding done"}`); this.grabChanged(grab); }
    };
    for (const grab of seeding) {
      const status = byHash.get((grab.downloadId ?? '').toLowerCase());
      if (!status) {
        this.store.updateGrab(grab.id, { state: 'done', removedAt: now, error: 'qBittorrent no longer had the torrent.' });
        this.grabChanged(grab);
        continue;
      }
      await take(status.downloadId, { ratio: status.ratio ?? 0, seedingSeconds: status.seedingSeconds ?? 0 }, grab);
    }
    for (const status of statuses) {
      if (status.state !== 'importing' || this.store.knowsDownload(status.downloadId)) continue;
      await take(status.downloadId, { ratio: status.ratio ?? 0, seedingSeconds: status.seedingSeconds ?? 0 });
    }
    return { checked: seeding.length, removed };
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
      return [{ id: title.id, tmdbId: title.tmdbId, title: title.title, ...(title.year ? { year: title.year } : {}), addedAt: title.addedAt, why: wanted.why, ...(file ? { quality: file.quality } : {}),
        paused: title.paused, ...(title.pausedReason ? { pausedReason: title.pausedReason } : {}),
        ...(search ? { nextAt: search.nextAt, ...(search.lastAt ? { lastAt: search.lastAt } : {}), misses: search.misses } : { misses: 0 }),
        ...(grab ? { grab: grab.state } : {}) }];
    });
  }
  // Every movie, for Admin › Manage › Movies. Below cutoff is the profile's rule on its file (paused or not).
  movieList(sourceOf: (title: LibraryTitle) => MovieSource) {
    const names = new Map(this.store.profiles().map(p => [p.id, p.name]));
    return this.store.allMovies().map(t => {
      const belowCutoff = !!t.fileQuality && movieWanted({ monitor: 'all', paused: false, inPlex: true, file: { quality: t.fileQuality } }, this.profile(t)).wanted;
      return { id: t.id, tmdbId: t.tmdbId, title: t.title, ...(t.year ? { year: t.year } : {}), ...(t.fileQuality ? { quality: t.fileQuality } : {}),
        ...(t.fileSize !== undefined ? { size: t.fileSize } : {}), profileId: t.profileId, profile: names.get(t.profileId) ?? 'Default', keep: t.keep, paused: t.paused,
        monitored: t.monitor !== 'none', belowCutoff, ...(t.grab ? { grab: t.grab } : {}), addedAt: t.addedAt, source: sourceOf(t) };
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
  private currentRelease(file: LibraryFileRow, protocol: Grab['protocol'] | undefined, want: ReturnType<Library['want']>,
    ctx: PickContext, decisions: Decision[]): InteractiveCurrentRelease {
    const name = file.releaseName || win32.basename(file.path);
    const tier = tierOf(ctx.profile, file.quality);
    const sizeTarget = tier >= 0 && !EARLY_COPIES.has(file.quality)
      ? sizeLimits(ctx.profile.tiers[tier]!, want.runtime || DEFAULT_RUNTIME.movie)?.target : undefined;
    const score = want.have?.score;
    const current = { tier, ...(sizeTarget !== undefined ? { sizeTarget } : {}), ...(score !== undefined ? { score } : {}),
      release: { size: file.size, ...(protocol ? { protocol } : {}) } };
    // Insert among the ranked candidates, leaving the rejected releases in their original order.
    const position = decisions.findIndex(d => !d.accepted || (tier < 0
      ? rank(file.quality) >= rank(d.quality!)
      : compareDecisions(current, d, ctx) <= 0));
    return { current: true, name, quality: file.quality, size: file.size, ...(score !== undefined ? { score } : {}),
      scoreParts: want.have?.scoreParts ?? [], parsed: parsedFacts(parseRelease(name)),
      position: position < 0 ? decisions.length : position };
  }

  async interactive(titleId: number, signal?: AbortSignal) {
    const title = this.movie(titleId);
    // Every enabled indexer, Usenet and torrents.
    const result = await this.deps.indexers.search({ kind: 'movie', title: title.title, ...(title.year ? { year: title.year } : {}),
      ...(title.imdbId ? { imdbId: title.imdbId } : {}), uhd: allows2160p(this.profile(title)) }, signal, { manual: true });
    const file = this.store.files(title.id)[0], fileGrab = file?.grabId === undefined ? undefined : this.store.grab(file.grabId);
    const releases = file ? result.releases.filter(r => !matchesLibraryFile(r, file, fileGrab)) : result.releases;
    const now = this.now();
    for (const [id, entry] of this.found) if (now - entry.at > 30 * MINUTE) this.found.delete(id);
    if (this.found.size >= 20) this.found.delete(this.found.keys().next().value!);
    this.found.delete(title.id);
    this.found.set(title.id, { at: now, releases });
    const want = this.want(title, file), ctx = this.context(title), { decisions, best } = pick(releases, want, ctx);
    const have = file ? this.currentRelease(file, fileGrab?.protocol, want, ctx, decisions) : undefined;
    const profileRow = this.store.profiles().find(p => p.id === title.profileId);
    return {
      profile: { name: profileRow?.name ?? 'Default', cutoff: preferredText(ctx.profile) }, ...(have ? { have } : {}),
      releases: decisions.map(d => ({ guid: d.release.guid, name: d.release.name, indexer: d.release.indexer, protocol: d.release.protocol,
        ...(d.release.size !== undefined ? { size: d.release.size } : {}), ...(d.release.publishedAt !== undefined ? { publishedAt: d.release.publishedAt } : {}),
        ...(d.release.grabs !== undefined ? { grabs: d.release.grabs } : {}), ...(d.release.seeders !== undefined ? { seeders: d.release.seeders } : {}),
        ...(d.release.freeleech ? { freeleech: true } : {}), ...(d.quality ? { quality: d.quality } : {}),
        score: d.score, accepted: d.accepted, upgrade: d.upgrade, reasons: d.reasons, scoreParts: d.scoreParts, rejections: d.rejections,
        ...(d.upgradeReason ? { upgradeReason: d.upgradeReason } : {}), ...(d === best ? { best: true } : {}), parsed: parsedFacts(d.parsed) })),
      indexers: result.indexers.map(r => ({ indexer: r.indexer, searched: r.searched, ...(r.error ? { error: r.error } : {}) })),
    };
  }

  // Grab from the last interactive search. A rejected release may be grabbed by hand, but only one whose quality is known.
  grabRelease(titleId: number, guid: string) {
    requireWritable();
    const title = this.movie(titleId);
    const release = this.found.get(title.id)?.releases.find(r => r.guid === guid);
    requireThat(release, 'SEARCH_EXPIRED', 'Search again: that result is no longer held.', 409);
    const file = this.store.files(title.id)[0], fileGrab = file?.grabId === undefined ? undefined : this.store.grab(file.grabId);
    requireThat(!file || !matchesLibraryFile(release, file, fileGrab), 'ALREADY_HAVE', 'This release is already in the library.', 409);
    const decision = pick([release], this.want(title, file), this.context(title)).decisions[0]!;
    requireThat(decision.quality, 'QUALITY_UNKNOWN', 'Its quality can’t be read from the name, so it can’t be grabbed.', 409);
    const grab = this.grab(title, decision, 'By hand');
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
    this.store.grabEvent(grab.id, 'retried');
    this.searchNow(title.id);
  }

  // ---- refresh-title ----

  private async refresh(item: QueueItem<SearchPayload>): Promise<Outcome> {
    const title = this.store.title(item.payload.titleId);
    if (!title) return done();
    try {
      if (title.kind === 'show') await this.refreshShow(title.id);
      else this.store.refreshed(title.id, await this.tmdb(title.tmdbId));
    }
    catch (e) { return fail(errorText(e), e instanceof AppError && e.code === 'NOT_FOUND'); }
    return done();
  }
}
