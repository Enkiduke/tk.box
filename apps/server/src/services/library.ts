import { dirname, win32 } from 'node:path';
import type { ClientItem, DownloaderLive, InteractiveCurrentRelease, InteractiveSearch, LibraryBulkEdit, LibraryBulkResult, MovieSource, ShowRow, ShowSeasonView, WantedItem } from '../../../../packages/contracts/src/downloads.js';
import * as fs from 'node:fs/promises';
import { AppError, readOnly, requireThat, requireWritable } from '../errors.js';
import { scoreFormats } from '../lib/formats.js';
import { DEFAULT_RUNTIME, allows2160p, isPreferred, preferredText, sizeLimits, tierOf, type QualityProfile } from '../lib/profiles.js';
import { builtInProfile } from '../lib/builtin-profiles.js';
import { seedingDecision, seedingRule } from '../lib/seeding.js';
import { bettersLibrary, compareDecisions, decide, fewSeeders, pick,type Decision, type EpisodeWant, type LibraryFile, type PickContext } from '../lib/pick-rules.js';
import { EARLY_COPIES, rank } from '../lib/quality.js';
import { imdbNumber, normaliseTitle, parseRelease, type ParsedRelease } from '../lib/release-name.js';
import { done, fail, retry, type Outcome, type QueueApi, type QueueItem, type HandlerContext } from './queue.js';
import { airedAt, beforeCinemas, episodeWanted, firstEpisodeSearchAt, firstSearchAt, followEpisodes, isOut, movieWanted, nextEpisodeSearchAt, nextSearchAt, parseScope, scopeName, showEnded,
  showScopes, type EpisodeFact, type ShowScope, type Wanted } from './wanted.js';
import { findVideos, type LibraryImporter, type ShowImport } from './library-import.js';
import { rarSets, unpack, unpackFolder } from './unpack.js';
import type { FeedListener, MovieQuery, NzbFile, Release, SearchOptions, SearchResult, ShowQuery, TitleQuery } from './indexers.js';
import type { Download, DownloaderName, GrabRef, RemoveOptions, Sent } from './downloaders.js';
import type { ClientCheck, DownloadStatus } from '../providers/download-status.js';
import { stallClock } from '../providers/qbittorrent.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import { withAirTimes, type TvmazeAiring } from '../providers/tvmaze.js';
import type { EpisodeRef, Grab, LibraryFileRow, LibrarySettings, LibraryStore, LibraryTitle, OutKind, Released, RunnerUp } from '../persistence/library-store.js';
import { CEILING, DEAD_CEILING, POST_LIMIT, PRE_DOWNLOAD_LIMIT, RECHECK, SKIP_FOR, VERDICT_POLLS, WARM_UP, budgetMs, judge, likelyFaster, newWatch, noCompleteCopy, stageClock, strike,
  swapTierLimit, type Watch } from './download-health.js';
import type { BusEvents } from '../modules/bus.js';

// The library for movies (docs/ARR-REPLACEMENT.md, phases 1 and 3): adding a title, wanted, searching (on add, the
// 30-minute sweep with its backoff, RSS), grabbing, following SABnzbd and qBittorrent, unpacking, importing, seeding,
// and the failure rules. Usenet comes first: IPTorrents is searched when NZBGeek has nothing, or nothing at the
// cutoff. Every step that talks to something outside runs on the queue: search, send, unpack, import, refresh-title
// and plex-scan.

export type IndexersApi = {
  search(query: TitleQuery, signal?: AbortSignal, options?: SearchOptions): Promise<SearchResult>;
  feeds(listener: FeedListener): () => void;
  download(release: Pick<Release, 'indexer' | 'link' | 'name'>, signal?: AbortSignal): Promise<NzbFile>;
};
export type DownloadersApi = { send(download: Download): Promise<Sent>; status(name?: DownloaderName): Promise<DownloadStatus[]>; remove(grab: GrabRef, options?: RemoveOptions): Promise<void>;
  // Admin's live queue (every item, any category); optional so tests can leave it out.
  live?(): Promise<{ clients: DownloaderLive[]; items: ClientItem[] }>;
  // qBittorrent's own health and a reannounce, for the download health rules (docs/STALLS.md); optional likewise.
  checkTorrents?(): Promise<ClientCheck>; reannounce?(infoHash: string): Promise<void> };
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
// `earlyCopies`: a movie's own switch (a request's, or an admin's); shows ignore it.
export type AddMovie = { tmdbId: number; by: string; profileId?: number; keep?: boolean; earlyCopies?: boolean; search: boolean };
// A show as a request asks for it: its seasons, and whether new ones are followed too ("watch new seasons").
export type AddShow = AddMovie & { seasons: readonly number[]; monitorFuture: boolean };
export type BulkChanges = Omit<LibraryBulkEdit, 'ids'>;
// A quick-edit search that couldn't run, in a word.
const BULK_REASONS: Record<string, string> = { TITLE_PAUSED: 'Failing', TITLE_UNMONITORED: 'Not monitored', GRAB_OPEN: 'Already downloading', NOTHING_WANTED: 'Nothing wanted' };
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
// `extra`: torrents an RSS feed found, weighed with what the Usenet search finds (Usenet first). `scope`: a show's
// season (S02) or episode (S02E05).
// `swapFor`: a look for a faster release than an Only source grab's (docs/STALLS.md).
type SearchPayload = { titleId: number; extra?: Release[]; scope?: string; swapFor?: number };
// A release chosen for a show, with the episodes it covers and the next best releases for the same episodes.
type ShowPick = { decision: Decision; episodes: EpisodeRef[]; runners: Release[] };
// How many next best releases a grab keeps, for a swap without a search.
const RUNNERS = 5;
// The accepted releases after the best, best first.
const runnersOf = (decisions: readonly Decision[], best: Decision, covers?: readonly number[]) => decisions
  .filter(d => d.accepted && d !== best && (!covers || covers.every(e => d.parsed.episodes.includes(e)))).slice(0, RUNNERS).map(d => d.release as Release);
type SendPayload = { grabId: number; link: string };
// `from`: the unpack folder to import from, instead of the download's.
type GrabPayload = { grabId: number; from?: string };
// One Plex scan for a folder's new files (`fileIds`, a pack's season folder), each then announced as imported.
type FilePayload = { fileId: number; fileIds?: number[] };

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// SABnzbd's history holds 500 jobs; a grab it no longer lists for this many checks (30 s apart) is taken as gone.
const MISSING_CHECKS = 6;
// TMDB's facts are read again daily for a movie that isn't out (a show still airing), weekly for one that is (ended).
const REFRESH_UNRELEASED = DAY, REFRESH_RELEASED = 7 * DAY;
// The sweep's interval (modules/library.ts): it also queues the searches due before its next run, at their time.
export const SWEEP_EVERY = 30 * MINUTE;
// Automatic searches from adds and the sweep start at least this far apart, so a burst (a bulk add, the first sweep
// after a restart) is spread out instead of hitting the indexers' hourly caps at once.
export const SEARCH_SPACING = 30000;
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

// A season pack, by its name.
const isPack = (grab: Pick<Grab, 'releaseName'>) => parseRelease(grab.releaseName).seasonPack;

export class Library {
  private missing = new Map<number, number>();
  // Download health, in memory (docs/STALLS.md): each grab's samples toward its next verdict, and its swarm's seeds.
  private watches = new Map<number, Watch>();
  private swarms = new Map<number, number>();
  // When the last paced search was set to start (queueSearch).
  private lastSlot = 0;
  private stopFeed?: () => void;
  constructor(private deps: {
    store: LibraryStore; queue: QueueApi; indexers: IndexersApi; downloaders: DownloadersApi; titles: Pick<TmdbTitles, 'get'>;
    plex: PlexHolds; importer: LibraryImporter; scan: (folder: string) => Promise<boolean>; emit: Emit;
    log: (message: string, detail?: Record<string, unknown>) => void; now?: () => number; unpacker?: Unpacker;
    // TVmaze's exact air times (providers/tvmaze.ts); without it, or when it fails, TMDB's day decides.
    airings?: (ids: { tvdbId?: number; imdbId?: string }) => Promise<TvmazeAiring[]>;
    // How far apart paced searches start (SEARCH_SPACING by default).
    searchSpacing?: number;
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

  // A show's facts and its episodes (no specials), one TMDB call per season, with TVmaze's air times where it has them.
  // Episodes' runtimes are their own; the title's is the show's usual one, for an episode TMDB gives none.
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
    const airings = this.deps.airings && (tvdbId || imdbId) ? await this.deps.airings({ ...(tvdbId ? { tvdbId } : {}), ...(imdbId ? { imdbId } : {}) })
      .catch(e => { this.deps.log('library: TVmaze air times unavailable', { tmdb: tmdbId, error: e instanceof Error ? e.message : String(e) }); return []; }) : [];
    return {
      facts: { title: show.name, ...(year ? { year } : {}), ...(tvdbId ? { tvdbId } : {}), ...(imdbId ? { imdbId } : {}),
        aliases: aliasesOf(show.name, [show.original_name, ...(show.alternative_titles?.results ?? []).map(t => t.title)]),
        released: show.status ? { status: show.status } : {}, ...(runtime ? { runtime } : {}) },
      seasons, episodes: airings.length ? withAirTimes(episodes, airings) : episodes,
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
  // says: at once, or (not out) from its cinema release with Early copies on, else from its home release.
  async add(input: AddMovie) {
    const settings = this.store.settings(), facts = await this.tmdb(input.tmdbId);
    const profileId = input.profileId && this.store.profile(input.profileId) ? input.profileId : settings.defaultProfile;
    let title = this.store.titleByTmdb('movie', input.tmdbId);
    if (title) {
      this.store.setMonitor(title.id, 'all');
      // Requested now: it no longer belongs to the collection that added it, which won't delete it when it lets go.
      if (title.addedBy === 'collections' && input.by !== 'collections') this.store.setAddedBy(title.id, input.by);
      if (input.keep) this.store.setKeep(title.id, true);
      if (input.earlyCopies) this.store.setEarlyCopies(title.id, true);
      if (input.profileId && profileId !== title.profileId) this.store.setProfile(title.id, profileId);
      this.store.refreshed(title.id, facts);
    } else {
      title = this.store.insertTitle({ kind: 'movie', tmdbId: input.tmdbId, ...(facts.imdbId ? { imdbId: facts.imdbId } : {}), title: facts.title,
        ...(facts.year ? { year: facts.year } : {}), aliases: facts.aliases, monitor: 'all', profileId, root: settings.roots.movie, keep: !!input.keep, earlyCopies: !!input.earlyCopies,
        released: facts.released, addedBy: input.by, ...(facts.runtime ? { runtime: facts.runtime } : {}) });
      this.deps.log('library: movie added', { id: title.id, tmdb: input.tmdbId, by: input.by });
    }
    title = this.store.title(title.id)!;
    const now = this.now(), file = this.store.files(title.id)[0];
    const at = input.search ? firstSearchAt({ now, released: title.released, earlyCopies: title.earlyCopies, ...(file ? { file } : {}) }) : now + DAY;
    const last = this.store.search(title.id, 'movie');
    this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: last?.lastAt ?? 0, misses: 0, nextAt: at });
    if (input.search && at <= now) this.queueSearch(title.id, undefined, undefined, undefined, true);
    return title;
  }

  // Adds a show (or follows more of it), with its seasons and episodes from TMDB. The request's seasons are followed in
  // full; with "watch new seasons" new ones are too: All when every season is asked for, else Future from now.
  // Without it, Manual. Asked again, its seasons are switched on, and a show not taking new seasons does from now
  // when asked. With `search`, the asked seasons' searches are queued at once.
  async addShow(input: AddShow) {
    const settings = this.store.settings(), { facts, ...tmdb } = await this.tmdbShow(input.tmdbId);
    if (!facts.tvdbId) throw new AppError('NO_TVDB_ID', `TMDB has no TVDB id for ${facts.title}, which its file names need.`, 422);
    const profileId = input.profileId && this.store.profile(input.profileId) ? input.profileId : settings.defaultProfile;
    const chosen = [...new Set(input.seasons.filter(n => n > 0))], now = this.now();
    let title = this.store.titleByTmdb('show', input.tmdbId);
    if (!title) {
      const every = tmdb.seasons.length > 0 && tmdb.seasons.every(n => chosen.includes(n));
      const monitor = input.monitorFuture ? every ? 'all' as const : 'future' as const : 'manual' as const;
      const monitorFrom = monitor === 'future' ? now : undefined;
      const added = this.store.insertTitle({ kind: 'show', tmdbId: input.tmdbId, tvdbId: facts.tvdbId, ...(facts.imdbId ? { imdbId: facts.imdbId } : {}), title: facts.title,
        ...(facts.year ? { year: facts.year } : {}), aliases: facts.aliases, monitor, ...(monitorFrom !== undefined ? { monitorFrom } : {}), profileId,
        root: settings.roots.show, keep: !!input.keep, released: facts.released, addedBy: input.by, ...(facts.runtime ? { runtime: facts.runtime } : {}) });
      const next = followEpisodes({ monitor, ...(monitorFrom !== undefined ? { monitorFrom } : {}), chosen }, tmdb, { seasons: [], episodes: [] });
      this.inTransaction(() => this.store.saveEpisodes(added.id, next.seasons, next.episodes));
      this.deps.log('library: show added', { id: added.id, tmdb: input.tmdbId, by: input.by, monitor, seasons: chosen });
      title = added;
    } else {
      if (input.monitorFuture && title.monitor !== 'all' && title.monitor !== 'future') this.store.setFollow(title.id, 'future', now);
      else if (title.monitor === 'none') this.store.setMonitor(title.id, 'manual');
      if (title.addedBy === 'collections' && input.by !== 'collections') this.store.setAddedBy(title.id, input.by);
      if (input.keep) this.store.setKeep(title.id, true);
      if (input.profileId && profileId !== title.profileId) this.store.setProfile(title.id, profileId);
      await this.refreshShow(title.id);
      this.store.followSeasons(title.id, chosen, true);
    }
    title = this.store.title(title.id)!;
    if (input.search) for (const scope of this.scopesOf(title).filter(s => chosen.includes(s.season))) this.queueSearch(title.id, undefined, undefined, scope.scope, true);
    return title;
  }
  // Stops following these seasons of a show (their requests were cancelled), and their queued searches.
  unmonitorSeasons(titleId: number, seasons: readonly number[]) {
    const title = this.store.title(titleId);
    if (title?.kind !== 'show' || !seasons.length) return;
    this.store.followSeasons(titleId, seasons, false);
    this.cancelSearches(titleId, seasons);
  }
  private cancelSearches(titleId: number, seasons: readonly number[]) {
    for (const season of seasons) {
      this.deps.queue.cancel('search', `show:${titleId}:${scopeName(season)}`);
      for (const e of this.store.episodes(titleId).filter(e => e.season === season)) this.deps.queue.cancel('search', `show:${titleId}:${scopeName(season, e.episode)}`);
    }
  }
  // Clean Up deleted a season through Plex: its file records go, it's switched off (so it isn't wanted again), and its
  // searches and downloads under way are cancelled.
  async forgetSeason(titleId: number, season: number) {
    const title = this.store.title(titleId);
    if (title?.kind !== 'show') return;
    for (const grab of this.store.activeGrabs().filter(g => g.titleId === titleId && g.episodes.some(([s]) => s === season))) await this.cancelGrab(grab, 'Clean Up deleted its season.');
    const paths = this.store.forgetSeason(titleId, season);
    this.cancelSearches(titleId, [season]);
    this.deps.log('library: forgot a season Clean Up deleted', { title: titleId, season, files: paths.length });
  }
  private async cancelGrab(grab: Grab, reason: string) {
    this.store.updateGrab(grab.id, { state: 'cancelled', error: reason, finishedAt: this.now() });
    this.deps.queue.cancel('send', `grab:${grab.id}`);
    this.deps.queue.cancel('import', `grab:${grab.id}`);
    if (grab.downloadId && !readOnly()) await this.deps.downloaders.remove({ downloader: grab.downloader, downloadId: grab.downloadId })
      .catch(e => this.deps.log('library: could not remove the cancelled download', { grab: grab.id, error: errorText(e) }));
    this.grabChanged(grab);
  }

  // Stops watching it (a request was cancelled).
  unmonitor(titleId: number) { this.store.unfollow(titleId); this.deps.queue.cancel('search', `movie:${titleId}`); }
  // The Monitored switch. Off: nothing is searched for, grabbed from RSS or upgraded, and searches queued are
  // cancelled; it keeps its files. On: the follow mode it had comes back (a movie All, a show Manual if it had none),
  // with its seasons' and episodes' own switches as they were.
  setMonitored(titleId: number, on: boolean) {
    const title = this.store.title(titleId);
    requireThat(title, 'NOT_FOUND', 'No such title in the library.', 404);
    if (on === (title.monitor !== 'none')) return;
    if (on) { this.store.refollow(titleId, title.kind === 'movie' ? 'all' : 'manual'); this.searchAfresh(titleId); }
    else {
      this.store.unfollow(titleId);
      if (title.kind === 'show') this.cancelSearches(titleId, this.store.seasons(titleId).map(s => s.season));
      else this.deps.queue.cancel('search', `movie:${titleId}`);
    }
    this.store.audit('library_monitored', { title: titleId, on });
  }
  keep(titleId: number, keep: boolean) { this.store.setKeep(titleId, keep); }
  // A title's profile, and its searches started over: the new one may take what the old one didn't.
  setProfile(titleId: number, profileId: number) {
    const title = this.store.title(titleId);
    if (!title || title.profileId === profileId) return;
    this.store.setProfile(titleId, profileId);
    this.searchAfresh(titleId);
  }
  // Misses start over, and the next search is due as for a title just added (a movie still waits for its release).
  private searchAfresh(titleId: number) {
    const title = this.store.title(titleId), now = this.now();
    if (!title) return;
    if (title.kind === 'show') { this.store.resetSearches(titleId, now); return; }
    const last = this.store.search(titleId, 'movie'), file = this.store.files(titleId)[0];
    this.store.setSearch({ titleId, scope: 'movie', lastAt: last?.lastAt ?? 0, misses: 0,
      nextAt: firstSearchAt({ now, released: title.released, earlyCopies: title.earlyCopies, ...(file ? { file } : {}) }) });
  }
  // A movie's Early copies, and its next search timed again by it (Missing a cinema release away, say).
  setEarlyCopies(titleId: number, on: boolean) {
    const title = this.movie(titleId);
    if (title.earlyCopies === on) return;
    this.store.setEarlyCopies(titleId, on);
    const now = this.now(), last = this.store.search(titleId, 'movie'), file = this.store.files(titleId)[0];
    const nextAt = firstSearchAt({ now, released: title.released, earlyCopies: on, ...(file ? { file } : {}) });
    this.store.setSearch({ titleId, scope: 'movie', lastAt: last?.lastAt ?? 0, misses: last?.misses ?? 0, nextAt });
  }
  // Quick edit on Manage's tables: the same changes to many titles at once, then a search for each that wants one.
  // Titles gone since the page loaded are skipped, and so are searches a title can't take (paused, unmonitored, a
  // download under way, nothing wanted), each with its reason. Resume clears a title stopped after failed downloads.
  async bulkEdit(ids: readonly number[], changes: BulkChanges, by: string): Promise<LibraryBulkResult> {
    if (changes.profileId !== undefined) requireThat(this.store.profile(changes.profileId), 'PROFILE_NOT_FOUND', 'No such profile.', 404);
    const skipped: LibraryBulkResult['skipped'] = [];
    let changed = 0, searched = 0;
    if (changes.search) await this.deps.plex.ready();
    for (const id of new Set(ids)) {
      const title = this.store.title(id);
      if (!title) { skipped.push({ id, title: `#${id}`, reason: 'No longer in the library' }); continue; }
      if (changes.monitored !== undefined) this.setMonitored(id, changes.monitored);
      if (changes.resume && title.paused) this.setPaused(id, false);
      if (changes.profileId !== undefined) this.setProfile(id, changes.profileId);
      if (changes.keep !== undefined) this.keep(id, changes.keep);
      changed++;
      if (!changes.search) continue;
      try {
        const now = this.store.title(id)!;
        if (now.kind === 'movie' && !now.paused && now.monitor !== 'none') requireThat(this.wanted(now).wanted, 'NOTHING_WANTED', 'Nothing wanted', 409);
        this.searchNow(id); searched++;
      } catch (e) {
        const code = e instanceof AppError ? e.code : '';
        skipped.push({ id, title: title.title, reason: BULK_REASONS[code] ?? (e instanceof AppError ? e.message : errorText(e)) });
      }
    }
    const { search, ...rest } = changes;
    if (Object.keys(rest).length) this.store.audit('library_bulk_changed', { titles: [...new Set(ids)], ...rest, by });
    return { changed, searched, skipped };
  }
  // Clean Up or an admin removed it: the title, its files' records and its grabs go (the files are already gone).
  forget(titleId: number, by: 'cleanup' | 'admin' | 'collections') {
    const title = this.store.title(titleId);
    if (!title) return;
    if (title.kind === 'show') this.cancelSearches(titleId, this.store.seasons(titleId).map(s => s.season));
    else this.deps.queue.cancel('search', `movie:${titleId}`);
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
    if (grab) await this.cancelGrab(grab, 'Its collection let it go.');
    const { folder, removed } = await this.deps.importer.deleteFiles(title);
    this.forget(title.id, 'collections');
    this.deps.log('library: removed a movie its collection let go', { title: title.id, tmdb: title.tmdbId, files: removed });
    if (folder && removed.length) await this.deps.scan(folder).catch(e => this.deps.log('library: Plex wasn’t told about the removal', { folder, error: errorText(e) }));
    return true;
  }
  // An admin deleted one of its files: gone from disk and the library, and Plex scans the folder. The title stays as
  // it was otherwise, so a monitored one wants the movie or episodes again.
  async removeFile(titleId: number, fileId: number) {
    requireWritable();
    const title = this.store.title(titleId);
    requireThat(title, 'NOT_FOUND', 'No such title in the library.', 404);
    const result = await this.deps.importer.deleteOneFile(title, fileId);
    requireThat(result, 'NOT_FOUND', 'No such file for this title.', 404);
    this.store.audit('library_file_deleted', { title: title.id, file: fileId, onDisk: result.deleted });
    this.deps.log('library: an admin deleted a file', { title: title.id, file: fileId, onDisk: result.deleted });
    if (result.folder) await this.deps.scan(result.folder).catch(e => this.deps.log('library: Plex wasn’t told about the removal', { folder: result.folder, error: errorText(e) }));
    return { deleted: result.deleted };
  }
  // An admin deleted it: downloads under way are cancelled, its folder goes from disk (unless `files` is false), the
  // library forgets it, and Plex scans the folder so the title drops out.
  async remove(titleId: number, files: boolean) {
    requireWritable();
    const title = this.store.title(titleId);
    requireThat(title, 'NOT_FOUND', 'No such title in the library.', 404);
    for (const grab of this.store.activeGrabs().filter(g => g.titleId === titleId)) await this.cancelGrab(grab, 'An admin deleted the title.');
    const { folder, removed } = files ? await this.deps.importer.deleteTitleFolder(title) : { folder: undefined, removed: [] as string[] };
    this.forget(title.id, 'admin');
    this.store.audit('library_title_deleted', { title: title.id, kind: title.kind, tmdb: title.tmdbId, name: title.title, files: removed.length });
    this.deps.log('library: an admin deleted a title', { title: title.id, tmdb: title.tmdbId, files: removed.length });
    if (folder && removed.length) await this.deps.scan(folder).catch(e => this.deps.log('library: Plex wasn’t told about the removal', { folder, error: errorText(e) }));
    return { files: removed.length };
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
    return { profile: this.profile(title), formats: this.store.formats(), settings: { earlyCopies: title.kind === 'movie' && title.earlyCopies, protocol: s.protocol, properDays: s.properDays },
      blocklist: this.store.blocklist(title.id), now: this.now() };
  }
  private want(title: LibraryTitle, file = this.store.files(title.id)[0]) {
    const have = this.have(title, file);
    return { kind: 'movie' as const, title: { title: title.title, ...(title.year ? { year: title.year } : {}), aliases: title.aliases, ...(title.imdbId ? { imdbId: title.imdbId } : {}) },
      ...(have ? { have } : {}), ...(title.runtime ? { runtime: title.runtime } : {}) };
  }

  // `paced`: an automatic search from an add or the sweep, given the next free slot (SEARCH_SPACING) from `runAt`.
  private queueSearch(titleId: number, runAt?: number, extra?: Release[], scope?: string, paced = false) {
    const slot = paced ? Math.max(runAt ?? this.now(), this.lastSlot + (this.deps.searchSpacing ?? SEARCH_SPACING)) : runAt;
    const queued = this.deps.queue.enqueue('search', scope ? `show:${titleId}:${scope}` : `movie:${titleId}`, { titleId, ...(extra?.length ? { extra } : {}), ...(scope ? { scope } : {}) },
      slot === undefined ? {} : { runAt: slot });
    if (paced && queued.added) this.lastSlot = slot!;
    return queued;
  }

  // ---- Shows ----

  // A show's episodes with their files (tk.box's records), and what to search now.
  private showState(title: LibraryTitle) {
    const files = this.store.episodeFiles(title.id);
    const episodes = this.store.episodes(title.id).map(e => { const file = files.get(`${e.season}:${e.episode}`); return { ...e, ...(file ? { file } : {}) }; });
    return { seasons: this.store.seasons(title.id), episodes, files };
  }
  // `at`: as it will be then (the sweep looks ahead to its next run).
  private scopesOf(title: LibraryTitle, state = this.showState(title), at = this.now()) {
    return showScopes(title, state.seasons, state.episodes, this.profile(title), at, this.store.grabbingEpisodes(title.id));
  }
  private showQuery(title: LibraryTitle, season: number, episode?: number): ShowQuery {
    return { kind: 'show', title: title.title, ...(title.tvdbId ? { tvdbId: title.tvdbId } : {}), season, ...(episode !== undefined ? { episode } : {}) };
  }
  // What the pick rules weigh for a season: the wanted episodes, the library's file for each episode that has one, an
  // episode's runtime and how many the season has.
  private episodeWant(title: LibraryTitle, season: number, episodes: readonly number[], pack: boolean, state = this.showState(title)): EpisodeWant {
    const have = new Map<number, LibraryFile>();
    for (const [key, file] of state.files) {
      const [s, e] = key.split(':').map(Number);
      const h = s === season ? this.have(title, file) : undefined;
      if (h) have.set(e!, h);
    }
    const inSeason = state.episodes.filter(e => e.season === season);
    const runtime = inSeason.find(e => episodes.includes(e.episode) && e.runtime)?.runtime ?? title.runtime;
    return { kind: 'episode', title: { title: title.title, ...(title.year ? { year: title.year } : {}), aliases: title.aliases, ...(title.tvdbId ? { tvdbId: title.tvdbId } : {}) },
      season, episodes, pack, ...(have.size ? { have } : {}), ...(runtime ? { runtime } : {}), seasonEpisodes: inSeason.length };
  }
  // The releases to grab for a season's wanted episodes: a pack first when the scope is a season; otherwise (or with no
  // acceptable pack) the best single or multi-episode release for each wanted episode left, until none are left or
  // nothing more is acceptable.
  private showPicks(title: LibraryTitle, season: number, wanted: readonly number[], pack: boolean, releases: readonly Release[], state = this.showState(title)): ShowPick[] {
    const ctx = this.context(title);
    if (pack) {
      const want = this.episodeWant(title, season, wanted, true, state), { best, decisions } = pick(releases, want, ctx);
      if (best) {
        const covered = [...new Set([...state.episodes.filter(e => e.season === season).map(e => e.episode), ...wanted])].sort((a, b) => a - b);
        return [{ decision: best, episodes: covered.map(e => [season, e] as EpisodeRef), runners: runnersOf(decisions, best) }];
      }
    }
    const picks: ShowPick[] = [];
    let left = [...wanted].sort((a, b) => a - b);
    while (left.length) {
      const { best, decisions } = pick(releases.filter(r => !picks.some(p => p.decision.release.guid === r.guid)), this.episodeWant(title, season, left, false, state), ctx);
      if (!best) break;
      const covers = best.parsed.episodes;
      picks.push({ decision: best, episodes: covers.map(e => [season, e] as EpisodeRef), runners: runnersOf(decisions, best, covers) });
      left = left.filter(e => !covers.includes(e));
    }
    return picks;
  }
  // Whether a search's picks settle it at the first protocol: every wanted episode covered at a preferred tier.
  private settled(picks: ShowPick[], wanted: readonly number[], profile: QualityProfile, first: 'usenet' | 'torrent') {
    const covered = new Set(picks.flatMap(p => p.episodes.map(([, e]) => e)));
    return wanted.every(e => covered.has(e)) && picks.every(p => isPreferred(profile, p.decision.quality!) && p.decision.release.protocol === first && !fewSeeders(p.decision.release));
  }
  // The wanted episodes in a scope now (none with a grab under way).
  private scopeWanted(title: LibraryTitle, scope: { season: number; episode?: number }, state = this.showState(title)) {
    const busy = new Set(this.store.grabbingEpisodes(title.id).map(([s, e]) => `${s}:${e}`)), profile = this.profile(title), now = this.now();
    const on = state.seasons.find(s => s.season === scope.season)?.monitored ?? false;
    return state.episodes.filter(e => e.season === scope.season && (scope.episode === undefined || e.episode === scope.episode)
      && !busy.has(`${e.season}:${e.episode}`) && episodeWanted(title, on, e, profile, now).wanted).map(e => e.episode);
  }

  private async searchShow(title: LibraryTitle, item: QueueItem<SearchPayload>, signal?: AbortSignal): Promise<Outcome> {
    const scope = parseScope(item.payload.scope ?? '');
    if (!scope) return done();
    const state = this.showState(title), wanted = this.scopeWanted(title, scope, state);
    if (!wanted.length) return done();
    const pack = scope.episode === undefined, query = this.showQuery(title, scope.season, scope.episode);
    const result = await this.searchInOrder(title, query, signal, item.payload.extra ?? [],
      (releases, first) => this.settled(this.showPicks(title, scope.season, wanted, pack, releases, state), wanted, this.profile(title), first));
    const waits = result.indexers.map(r => r.waitUntil);
    if (!result.releases.length && waits.length && waits.every(w => w !== undefined)) return retry(Math.min(...waits as number[]));
    let grabbed = 0;
    for (const p of this.showPicks(title, scope.season, wanted, pack, result.releases, state)) if (this.grab(title, p.decision, undefined, p.episodes, { runners: p.runners })) grabbed++;
    const now = this.now(), name = scopeName(scope.season, scope.episode), last = this.store.search(title.id, name);
    const airAt = scope.episode === undefined ? undefined : state.episodes.find(e => e.season === scope.season && e.episode === scope.episode)?.airAt;
    const seasonAired = state.episodes.filter(e => e.season === scope.season).map(e => e.airAt ?? 0), lastAiredAt = seasonAired.length ? Math.max(...seasonAired) : undefined;
    if (grabbed) this.store.setSearch({ titleId: title.id, scope: name, lastAt: now, misses: 0, nextAt: now + DAY });
    else {
      const misses = (last?.misses ?? 0) + 1;
      this.store.setSearch({ titleId: title.id, scope: name, lastAt: now, misses, nextAt: nextEpisodeSearchAt({ now, misses, ...(airAt !== undefined ? { airAt } : {}),
        ...(scope.episode === undefined && lastAiredAt ? { lastAiredAt } : {}) }) });
    }
    return done();
  }

  // The show's searches due by `until`, each with when: its next search, or for a scope never searched, 15 minutes
  // after its episode airs (a season's last one, for a season), and at once for one that aired long ago.
  private dueScopes(title: LibraryTitle, now: number, until = now): (ShowScope & { at: number })[] {
    const state = this.showState(title);
    return this.scopesOf(title, state, until).flatMap(scope => {
      const row = this.store.search(title.id, scope.scope);
      const aired = state.episodes.filter(e => e.season === scope.season && scope.episodes.includes(e.episode)).map(e => e.airAt ?? 0);
      const at = row ? row.nextAt : firstEpisodeSearchAt(now, aired.length ? Math.max(...aired) : undefined);
      return at <= until ? [{ ...scope, at }] : [];
    });
  }

  // ---- The wanted sweep (every 30 minutes) ----

  // Queues a search for each wanted movie whose next search is due, each show search due before the next sweep, and a
  // TMDB refresh for stale ones.
  async sweep() {
    if (readOnly()) return { searched: 0, refreshed: 0 };
    await this.deps.plex.ready();
    const now = this.now();
    let searched = 0, refreshed = 0;
    this.store.pruneSkips();
    for (const title of this.store.dueMovies(now)) {
      if (this.store.openGrabFor(title.id) || !this.wanted(title).wanted) continue;
      // Not in cinemas yet (a search scheduled under older timing rules): move it to when it may search, not now.
      if (beforeCinemas(title.released, now) !== undefined) {
        const last = this.store.search(title.id, 'movie'), file = this.store.files(title.id)[0];
        this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: last?.lastAt ?? 0, misses: last?.misses ?? 0,
          nextAt: firstSearchAt({ now, released: title.released, earlyCopies: title.earlyCopies, ...(file ? { file } : {}) }) });
        continue;
      }
      if (this.queueSearch(title.id, undefined, undefined, undefined, true).added) searched++;
    }
    // Shows look ahead to the next sweep, so a new episode's search starts on time (15 minutes after it airs).
    for (const title of this.store.activeShows()) {
      for (const scope of this.dueScopes(title, now, now + SWEEP_EVERY))
        if (this.queueSearch(title.id, scope.at > now ? scope.at : undefined, undefined, scope.scope, true).added) searched++;
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
    if (!title) return done();
    if (item.payload.swapFor !== undefined) return this.swapSearch(title, item.payload.swapFor, signal);
    if (title.kind === 'show') return this.searchShow(title, item, signal);
    await this.deps.plex.ready();
    if (this.store.openGrabFor(title.id) || !this.wanted(title).wanted) return done();
    const result = await this.searchInOrder(title, this.movieQuery(title), signal, item.payload.extra ?? [], (releases, first) => {
      const context = this.context(title), { best } = pick(releases, this.want(title), context);
      return !!best && isPreferred(context.profile, best.quality!) && best.release.protocol === first && !fewSeeders(best.release);
    });
    // Every indexer over its cap or paused: wait for it, without counting a miss.
    const waits = result.indexers.map(r => r.waitUntil);
    if (!result.releases.length && waits.length && waits.every(w => w !== undefined)) return retry(Math.min(...waits as number[]));
    const now = this.now(), settings = this.store.settings(), last = this.store.search(title.id, 'movie');
    const { best, decisions } = pick(result.releases, this.want(title), this.context(title));
    if (best && this.grab(title, best, undefined, undefined, { runners: runnersOf(decisions, best) })) {
      this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: now, misses: 0, nextAt: now + DAY });
      return done();
    }
    const misses = (last?.misses ?? 0) + 1, file = this.store.files(title.id)[0];
    this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: now, misses,
      nextAt: nextSearchAt({ now, misses, released: title.released, earlyCopies: title.earlyCopies, ...(file ? { file } : {}) }) });
    return done();
  }

  // The preferred protocol's indexers first (Usenet, by default); the other's only when the first found nothing
  // acceptable, or nothing at the profile's cutoff, so a torrent is grabbed only when Usenet has nothing or only a worse
  // quality. The pick then ranks quality before protocol, so at the same quality the preferred one still wins.
  // `settled`: whether what the first protocol found is enough (a movie's best, a show's every wanted episode).
  private async searchInOrder(title: LibraryTitle, query: TitleQuery, signal: AbortSignal | undefined, extra: Release[],
    settled: (releases: Release[], first: 'usenet' | 'torrent') => boolean): Promise<SearchResult> {
    const settings = this.store.settings();
    const first = settings.protocol === 'torrent-first' ? 'torrent' as const : 'usenet' as const, second = first === 'usenet' ? 'torrent' as const : 'usenet' as const;
    const one = await this.deps.indexers.search(query, signal, { protocols: [first] });
    const releases = [...one.releases, ...extra.filter(r => !one.releases.some(o => o.guid === r.guid))];
    if (settled(releases, first)) return { releases, indexers: one.indexers };
    const two = await this.deps.indexers.search(query, signal, { protocols: [second] });
    return { releases: [...releases, ...two.releases.filter(r => !releases.some(o => o.guid === r.guid))], indexers: [...one.indexers, ...two.indexers] };
  }

  private movieQuery(title: LibraryTitle): MovieQuery {
    return { kind: 'movie', title: title.title, ...(title.year ? { year: title.year } : {}), ...(title.imdbId ? { imdbId: title.imdbId } : {}), uhd: allows2160p(this.profile(title)) };
  }

  // A grab for the decision's release, sent by the queue. Undefined when one under way already covers it (the movie,
  // or any of a show's `episodes`).
  // `runners`: the next best releases, kept for a swap; `swappedFrom`: the slow grab it replaces.
  private grab(title: LibraryTitle, decision: Decision, note?: string, episodes?: EpisodeRef[], extra: { runners?: readonly Release[]; swappedFrom?: number } = {}) {
    const release = decision.release as Release;
    const grab = this.store.insertGrab({ titleId: title.id, ...(episodes?.length ? { episodes } : {}), releaseName: release.name, indexer: release.indexer, guid: release.guid, protocol: release.protocol,
      ...(release.size !== undefined ? { size: release.size } : {}), quality: decision.quality!, score: decision.score, upgrade: decision.upgrade,
      downloader: release.protocol === 'torrent' ? 'qbittorrent' : 'sabnzbd', ...(extra.runners?.length ? { runners: [...extra.runners] } : {}),
      ...(extra.swappedFrom !== undefined ? { swappedFrom: extra.swappedFrom } : {}) }, note);
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
    const shows = await this.onShowFeed(releases);
    const movies = this.store.activeMovies();
    if (!movies.length) return shows;
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
      const { best, decisions } = pick(candidates, this.want(title), this.context(title));
      if (!best) continue;
      const first = this.store.settings().protocol === 'torrent-first' ? 'torrent' : 'usenet';
      if (best.release.protocol !== first) { this.queueSearch(title.id, undefined, candidates.filter(c => c.protocol !== first)); continue; }
      if (this.grab(title, best, undefined, undefined, { runners: runnersOf(decisions, best) })) grabbed++;
    }
    return grabbed + shows;
  }

  // The feed's episodes and season packs, matched to active shows by TVDB id or title (and alias), then picked as a
  // search of that season or episode would. A torrent that would win while Usenet comes first is carried into a search.
  private async onShowFeed(releases: Release[]) {
    const shows = this.store.activeShows();
    if (!shows.length) return 0;
    const byName = new Map<string, LibraryTitle[]>(), byTvdb = new Map<number, LibraryTitle>();
    for (const s of shows) {
      for (const name of [s.title, ...s.aliases]) { const key = normaliseTitle(name), list = byName.get(key) ?? []; if (!list.includes(s)) list.push(s); byName.set(key, list); }
      if (s.tvdbId) byTvdb.set(s.tvdbId, s);
    }
    const found = new Map<string, { title: LibraryTitle; season: number; releases: Release[] }>();
    for (const release of releases) {
      const parsed = parseRelease(release.name, new Date(this.now()).getUTCFullYear());
      if (parsed.season === undefined || parsed.multiSeason) continue;
      const tvdb = Number(release.ids?.tvdbid);
      const titles = Number.isInteger(tvdb) && byTvdb.has(tvdb) ? [byTvdb.get(tvdb)!] : byName.get(normaliseTitle(parsed.title)) ?? [];
      for (const t of titles) {
        const key = `${t.id}:${parsed.season}`, entry = found.get(key) ?? { title: t, season: parsed.season, releases: [] };
        entry.releases.push(release); found.set(key, entry);
      }
    }
    const first = this.store.settings().protocol === 'torrent-first' ? 'torrent' : 'usenet';
    let grabbed = 0;
    for (const { title, season, releases: candidates } of found.values()) {
      const state = this.showState(title);
      for (const scope of this.scopesOf(title, state).filter(s => s.season === season)) {
        const picks = this.showPicks(title, season, scope.episodes, scope.episode === undefined, candidates, state);
        if (picks.some(p => p.decision.release.protocol !== first)) { this.queueSearch(title.id, undefined, candidates.filter(c => c.protocol !== first), scope.scope); continue; }
        for (const p of picks) if (this.grab(title, p.decision, undefined, p.episodes, { runners: p.runners })) grabbed++;
      }
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
      const kind = this.store.title(grab.titleId)?.kind ?? 'movie';
      const sent = await this.deps.downloaders.send({ kind, protocol: grab.protocol, name: grab.releaseName.slice(0, 200), file: nzb.bytes,
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
    const now = this.now(), settings = this.store.settings();
    // Every torrent under way standing still at once points at qBittorrent or the line, not at the releases.
    const moving = grabs.flatMap(g => { const s = byId.get(g.downloadId!.toLowerCase()); return g.protocol === 'torrent' && s?.state === 'downloading' && !s.waiting && g.progress !== undefined ? [(s.progress ?? 0) > g.progress + 1e-6] : []; });
    const standingStill = moving.length >= 2 && moving.every(m => !m);
    // qBittorrent's own health, asked at most once a check and only when a torrent looks dead or slow.
    let check: Promise<ClientCheck> | undefined;
    const clientCheck = () => check ??= (this.deps.downloaders.checkTorrents?.() ?? Promise.resolve({ connected: true, throttled: false }))
      .catch(() => ({ connected: false, throttled: false }));
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
      else if (status.state === 'downloading') await this.watchDownload(grab, status, now, settings.budget, () => clientCheck().then(c => c.connected && !c.throttled && !standingStill));
      else if (status.state === 'importing') {
        this.unwatch(grab.id);
        this.store.updateGrab(grab.id, { state: 'importing', progress: 1, finishedAt: this.now(), ...(status.storage ? { contentPath: status.storage } : {}) });
        this.deps.queue.enqueue('import', `grab:${grab.id}`, { grabId: grab.id }, { maxAttempts: 10 });
        this.grabChanged(grab);
      } else {
        // SABnzbd post-processing: stuck this long is the release's fault.
        const watch = this.watches.get(grab.id) ?? newWatch(), since = watch.stage?.name === 'post' ? watch.stage.since : now;
        this.watches.set(grab.id, { ...watch, samples: [], stage: { name: 'post', since } });
        if (grab.protocol === 'usenet' && now - since >= POST_LIMIT) { await this.failGrab(grab, `SABnzbd was still repairing or unpacking it after ${Math.round(POST_LIMIT / HOUR)} h.`, true); continue; }
        const changed = status.state !== grab.state;
        this.store.updateGrab(grab.id, { state: status.state, ...(status.progress !== undefined ? { progress: status.progress } : {}) });
        if (changed) this.grabChanged(grab);
      }
    }
    return { checked: grabs.length };
  }

  // ---- Slow and stalled downloads (docs/STALLS.md) ----

  // One poll of a download: the Usenet stage clock, the Only source ceilings and hourly look, then a sample toward the
  // next verdict and, every VERDICT_POLLS polls, its strikes. Out: swapped for a faster release, or Only source.
  // `clientOk`: whether the downloader itself is fine, asked only when a verdict would strike.
  private async watchDownload(grab: Grab, status: DownloadStatus, now: number, budget: LibrarySettings['budget'], clientOk: () => Promise<boolean>) {
    const clock = stallClock({ ...(grab.progress !== undefined ? { progress: grab.progress } : {}), ...(grab.progressAt ?? grab.sentAt ? { progressAt: grab.progressAt ?? grab.sentAt } : {}) }, status, now);
    const fields: Parameters<LibraryStore['updateGrab']>[1] = { progress: status.progress ?? 0, progressAt: clock.progressAt, ...(grab.state !== 'downloading' ? { state: 'downloading' } : {}) };
    if (status.swarmSeeds !== undefined) this.swarms.set(grab.id, status.swarmSeeds);
    let watch = this.watches.get(grab.id) ?? newWatch();
    if (grab.protocol === 'usenet') {
      const stage = stageClock(watch, status.stage, now);
      watch = stage.watch;
      if (stage.stuck) { this.store.updateGrab(grab.id, fields); await this.out(grab, 'dud', `SABnzbd was still ${status.stage} after ${Math.round(PRE_DOWNLOAD_LIMIT / MINUTE)} min.`, status); return; }
    }
    if (grab.onlySource) {
      if (now - clock.progressAt >= DEAD_CEILING) { await this.failGrab(grab, `Only source, and no progress for ${Math.round(DEAD_CEILING / HOUR)} h.`, 'skip'); return; }
      if (now - (grab.sentAt ?? now) >= CEILING) { await this.failGrab(grab, `Only source, and still downloading after ${Math.round(CEILING / HOUR)} h.`, 'skip'); return; }
      this.store.updateGrab(grab.id, fields);
      this.watches.set(grab.id, watch);
      if (now - (grab.swapCheckedAt ?? 0) >= RECHECK) await this.lookForFaster(grab, status.swarmSeeds);
      return;
    }
    if (now - (grab.sentAt ?? now) < WARM_UP) { this.store.updateGrab(grab.id, fields); this.watches.set(grab.id, watch); return; }
    const left = status.left ?? (grab.size !== undefined && status.progress !== undefined ? Math.round(grab.size * (1 - status.progress)) : undefined);
    watch = { ...watch, samples: [...watch.samples, { at: now, ...(left !== undefined ? { left } : {}), waiting: !!status.waiting, metadata: !!status.metadata }] };
    if (watch.samples.length < VERDICT_POLLS) { this.store.updateGrab(grab.id, fields); this.watches.set(grab.id, watch); return; }
    const torrent = grab.protocol === 'torrent', title = this.store.title(grab.titleId);
    const kind = title?.kind !== 'show' ? 'movie' as const : isPack(grab) ? 'pack' as const : 'episode' as const;
    const judged = judge(watch.samples, budgetMs(budget, kind, grab.episodes.length)), noCopy = torrent && noCompleteCopy(status);
    // The downloader is only asked when this verdict could strike.
    const asks = noCopy || judged.verdict === 'dead' || (judged.verdict === 'slow' && torrent);
    const step = strike(watch, grab.strikes, judged.verdict, { clientOk: asks && torrent ? await clientOk() : true, slowCounts: torrent, canReannounce: torrent, noCopy });
    this.watches.set(grab.id, step.watch);
    if (step.reannounce && grab.downloadId && !readOnly()) await this.deps.downloaders.reannounce?.(grab.downloadId)
      .catch(e => this.deps.log('library: the reannounce failed', { grab: grab.id, error: errorText(e) }));
    const struck = step.strikes !== grab.strikes;
    this.store.updateGrab(grab.id, { ...fields, ...(struck ? { strikes: step.strikes } : {}) });
    if (step.out) {
      const reason = step.watch.noCopy >= 2 ? 'No complete copy in the swarm.' : step.out === 'dud' ? (torrent ? 'Nothing moved, even after a reannounce.' : 'Nothing moved for two checks.')
        : `Too slow: about ${Math.round((judged.leftMs ?? 0) / MINUTE)} min left${judged.speed ? ` at ${(judged.speed / 1024 / 1024).toFixed(1)} MB/s` : ''}.`;
      await this.out(this.store.grab(grab.id) ?? grab, step.out, reason, status);
    } else if (struck) this.grabChanged(grab);
  }

  // Out: the best faster release among the grab's runner-ups at its own tier, else Only source while a search looks
  // for one (only the search may go a tier down, once it has looked at both protocols).
  private async out(grab: Grab, kind: OutKind, reason: string, status: DownloadStatus) {
    if (readOnly()) return;
    const title = this.store.title(grab.titleId);
    if (!title) return;
    this.deps.log('library: download out', { grab: grab.id, title: title.id, release: grab.releaseName, kind, reason });
    const faster = this.fasterRelease(title, grab, 'slow', status.swarmSeeds, grab.runners);
    if (faster) { await this.swap(title, grab, faster, reason); return; }
    const now = this.now();
    this.store.updateGrab(grab.id, { onlySource: kind, onlySourceAt: now, swapCheckedAt: now, strikes: 0 });
    this.store.grabEvent(grab.id, 'only-source', reason);
    this.watches.delete(grab.id);
    this.grabChanged(grab);
    this.deps.queue.enqueue('search', `swap:${grab.id}`, { titleId: grab.titleId, swapFor: grab.id });
  }
  // Only source, an hour on: the runner-ups again (a release skipped then may be back), then a search.
  private async lookForFaster(grab: Grab, seeds: number | undefined) {
    if (readOnly()) return;
    const title = this.store.title(grab.titleId);
    if (!title) return;
    this.store.updateGrab(grab.id, { swapCheckedAt: this.now() });
    const faster = this.fasterRelease(title, grab, 'slow', seeds, grab.runners);
    if (faster) await this.swap(title, grab, faster, 'Only source: a faster release came up.');
    else this.deps.queue.enqueue('search', `swap:${grab.id}`, { titleId: grab.titleId, swapFor: grab.id });
  }
  // The search an Only source grab gets: the first protocol, then the other if that found nothing faster.
  private async swapSearch(title: LibraryTitle, grabId: number, signal?: AbortSignal): Promise<Outcome> {
    const grab = this.store.grab(grabId);
    if (!grab || grab.state !== 'downloading' || !grab.onlySource) return done();
    const seeds = this.swarms.get(grab.id), faster = (releases: readonly Release[]) => this.fasterRelease(title, grab, grab.onlySource!, seeds, releases);
    // Settled at the first protocol only by a faster release at the grab's own tier: a tier down waits for the other.
    const result = await this.searchInOrder(title, this.grabQuery(title, grab), signal, [], releases => !!this.fasterRelease(title, grab, 'slow', seeds, releases));
    const waits = result.indexers.map(r => r.waitUntil);
    if (!result.releases.length && waits.length && waits.every(w => w !== undefined)) return retry(Math.min(...waits as number[]));
    const now = this.store.grab(grab.id), better = faster(result.releases);
    if (better && now?.state === 'downloading' && now.onlySource) await this.swap(title, now, better, 'Only source: a faster release came up.');
    return done();
  }
  // What a grab's search looks for: the movie, or its season (a pack, or several episodes) or its one episode.
  private grabQuery(title: LibraryTitle, grab: Grab): TitleQuery {
    if (title.kind === 'movie') return this.movieQuery(title);
    const [season, episode] = grab.episodes[0] ?? [1, undefined];
    return this.showQuery(title, season, !isPack(grab) && grab.episodes.length === 1 ? episode : undefined);
  }
  // The best of `releases` that would do instead of the grab: acceptable now (blocklist and skips included), covering
  // its episodes, likely faster, and at its tier, or one down for a confirmed dud.
  private fasterRelease(title: LibraryTitle, grab: Grab, kind: OutKind, seeds: number | undefined, releases: readonly (Release | RunnerUp)[]): Decision | undefined {
    const candidates = releases.filter(r => r.guid !== grab.guid && r.name !== grab.releaseName);
    if (!candidates.length) return undefined;
    const ctx = this.context(title), limit = swapTierLimit(tierOf(ctx.profile, grab.quality), ctx.profile.tiers.length, kind);
    if (title.kind === 'movie') return pick(candidates, this.want(title), ctx).decisions.find(d => d.accepted && d.tier! <= limit && likelyFaster(d.release, seeds));
    const season = grab.episodes[0]?.[0];
    if (season === undefined) return undefined;
    const pack = isPack(grab), episodes = grab.episodes.filter(([s]) => s === season).map(([, e]) => e);
    return pick(candidates, this.episodeWant(title, season, episodes, pack), ctx).decisions.find(d => d.accepted && d.tier! <= limit && likelyFaster(d.release, seeds)
      && (pack || episodes.every(e => d.parsed.episodes.includes(e))));
  }
  // The slow grab goes (skipped, not blocklisted, and not counted as a failure) and the faster release is grabbed,
  // keeping the rest of the runner-ups. When it can't be grabbed after all, the title is searched as after a failure.
  private async swap(title: LibraryTitle, old: Grab, decision: Decision, reason: string) {
    const now = this.now();
    this.store.block({ titleId: old.titleId, releaseName: old.releaseName, indexer: old.indexer, guid: old.guid,
      ...(old.protocol === 'torrent' && old.downloadId ? { infoHash: old.downloadId } : {}), reason: reason.slice(0, 500), until: now + SKIP_FOR });
    this.store.updateGrab(old.id, { state: 'failed', error: `${reason} Swapped for ${decision.release.name}.`.slice(0, 500), finishedAt: now });
    this.unwatch(old.id);
    if (old.downloadId) await this.deps.downloaders.remove({ downloader: old.downloader, downloadId: old.downloadId }, { deleteFiles: true })
      .catch(e => this.deps.log('library: could not remove the slow download', { grab: old.id, error: errorText(e) }));
    this.grabChanged(old);
    const season = old.episodes[0]?.[0];
    const episodes = title.kind !== 'show' ? undefined : isPack(old) ? old.episodes : decision.parsed.episodes.map(e => [season ?? decision.parsed.season ?? 1, e] as EpisodeRef);
    const runners = old.runners.filter(r => r.guid !== decision.release.guid) as Release[];
    const fresh = this.grab(title, decision, 'Swapped in for a slow download', episodes, { runners, swappedFrom: old.id });
    this.deps.log('library: swapped a slow download', { title: title.id, from: old.id, release: decision.release.name, ...(fresh ? { grab: fresh.id } : {}) });
    if (!fresh) { if (title.kind === 'show') this.searchAgain(title, old.episodes); else this.queueSearch(title.id); }
  }
  private unwatch(grabId: number) { this.watches.delete(grabId); this.swarms.delete(grabId); }

  // ---- The failure rules ----

  // A failed download: blocklisted (unless it wasn't the release's fault; a torrent by its info hash too), removed from
  // its downloader with its files, and searched again. The fifth failure since the title's last import (or an admin
  // unpausing it) pauses it and tells the admins.
  // `blocklist: 'skip'`: skipped for SKIP_FOR instead (a slow or dead release, docs/STALLS.md), which doesn't count
  // toward pausing.
  async failGrab(grab: Grab, reason: string, blocklist: boolean | 'skip') {
    this.unwatch(grab.id);
    this.store.updateGrab(grab.id, { state: 'failed', error: reason.slice(0, 500), finishedAt: this.now() });
    if (blocklist) this.store.block({ titleId: grab.titleId, releaseName: grab.releaseName, indexer: grab.indexer, guid: grab.guid,
      ...(grab.protocol === 'torrent' && grab.downloadId ? { infoHash: grab.downloadId } : {}), reason: reason.slice(0, 500),
      ...(blocklist === 'skip' ? { until: this.now() + SKIP_FOR } : {}) });
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
    if (title.kind === 'show') this.searchAgain(title, grab.episodes);
    else this.queueSearch(title.id);
  }
  // A show's searches covering these episodes, queued now (the failed release is blocklisted, so the next best wins).
  private searchAgain(title: LibraryTitle, episodes: readonly EpisodeRef[]) {
    const failed = new Set(episodes.map(([s, e]) => `${s}:${e}`));
    for (const scope of this.scopesOf(title).filter(s => s.episodes.some(e => failed.has(`${s.season}:${e}`)))) this.queueSearch(title.id, undefined, undefined, scope.scope);
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
    const how = torrent ? (from ? { from, state: 'seeding' as const } : { link: true, state: 'seeding' as const }) : {};
    try {
      // A movie: its one file, against TMDB's runtime. A show: its files mapped to episodes, each against its episodes'.
      const result = title.kind === 'show'
        ? await this.deps.importer.importEpisodes(grab, title, this.showImport(title), signal, how)
        : await this.deps.importer.import(grab, title, await this.tmdb(title.tmdbId).then(f => f.runtime, () => undefined), signal, how);
      if (from) await this.unpacker.clear(from).catch(e => this.deps.log('library: the unpack folder stayed', { grab: grab.id, folder: from, error: errorText(e) }));
      if (!result.ok) { await this.failGrab(grab, result.reason, true); return done(); }
      const files = 'files' in result ? result.files : [{ fileId: result.fileId, path: result.path, copied: result.copied, episodes: [] as EpisodeRef[] }];
      this.resolve(`library.import.${grab.id}`);
      this.deps.log('library: imported', { grab: grab.id, title: title.id, ...(files.length === 1 ? { path: files[0]!.path } : { paths: files.map(f => f.path) }),
        ...(files.some(f => f.copied) ? { copied: true } : {}), ...(result.replaced.length ? { replaced: result.replaced } : {}),
        ...(result.skipped.length && title.kind === 'show' ? { skipped: result.skipped.map(s => `${s.path}: ${s.reason}`) } : {}) });
      if (files.some(f => f.copied)) this.deps.log(`library: the download was on another mount, so it was copied instead of ${torrent && !from ? 'linked' : 'moved'}`, { grab: grab.id, paths: files.filter(f => f.copied).map(f => f.path) });
      // SABnzbd's job and folder go; a torrent keeps seeding until the seeding check removes it.
      if (!torrent) await this.deps.downloaders.remove({ downloader: 'sabnzbd', downloadId: grab.downloadId ?? '' })
        .catch(e => this.deps.log('library: SABnzbd kept the imported job', { grab: grab.id, error: errorText(e) }));
      const now = this.now();
      if (title.kind === 'show') this.importedEpisodes(title, grab, files.flatMap(f => f.episodes));
      else {
        const settings = this.store.settings(), file = this.store.file(files[0]!.fileId)!;
        this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: this.store.search(title.id, 'movie')?.lastAt ?? now, misses: 0,
          nextAt: nextSearchAt({ now, misses: 1, released: title.released, earlyCopies: title.earlyCopies, file }) });
      }
      // One Plex scan per folder (a pack's season folder once), then each file is announced.
      const byFolder = new Map<string, number[]>();
      for (const f of files) byFolder.set(dirname(f.path), [...byFolder.get(dirname(f.path)) ?? [], f.fileId]);
      for (const ids of byFolder.values()) this.deps.queue.enqueue('plex-scan', `file:${ids[0]}`, { fileId: ids[0]!, ...(ids.length > 1 ? { fileIds: ids } : {}) });
      this.grabChanged(grab);
      return done();
    } catch (e) {
      // Disk full, permission denied and the like: the grab stays importing and the queue tries again.
      this.alert(`library.import.${grab.id}`, `${title.title} couldn’t be imported`, errorText(e));
      return fail(errorText(e));
    }
  }

  // What a show's import weighs: its episodes (names, runtimes) and, per episode, whether a file betters the library's
  // by the pick rules.
  private showImport(title: LibraryTitle): ShowImport {
    const files = this.store.episodeFiles(title.id), ctx = this.context(title);
    return { episodes: this.store.episodes(title.id), runtime: title.runtime || DEFAULT_RUNTIME.show,
      noBetter: (season, episode, file) => {
        const verdict = bettersLibrary(file, this.have(title, files.get(`${season}:${episode}`)), ctx);
        return verdict.ok ? undefined : verdict.reason ?? 'no better than the library’s file';
      } };
  }
  // After a show's import its grab's scope starts over: the season (`S02`) for a pack, else each episode (`S02E05`),
  // next looked at on the first backoff step (for an upgrade below the cutoff). Episodes still wanted keep their own.
  private importedEpisodes(title: LibraryTitle, grab: Grab, episodes: readonly EpisodeRef[]) {
    const now = this.now(), pack = parseRelease(grab.releaseName).seasonPack;
    const scopes = new Set(episodes.map(([s, e]) => pack ? scopeName(s) : scopeName(s, e)));
    for (const scope of scopes) this.store.setSearch({ titleId: title.id, scope, lastAt: this.store.search(title.id, scope)?.lastAt ?? now, misses: 0,
      nextAt: nextEpisodeSearchAt({ now, misses: 1 }) });
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
    const files = (item.payload.fileIds ?? [item.payload.fileId]).map(id => this.store.file(id)).filter(f => f !== undefined);
    const file = files[0];
    if (!file) return done();
    const title = this.store.title(file.titleId);
    try {
      const scanned = await this.deps.scan(dirname(file.path));
      if (!scanned) this.deps.log('library: no Plex library holds the folder; Plex will find it on its own scan', { path: file.path });
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'NO_PLEX_TOKEN')) return fail(errorText(e));
      this.deps.log('library: no Plex admin token, so Plex wasn’t told', { path: file.path });
    }
    for (const f of files) this.deps.emit('library.file.imported', { titleId: f.titleId, fileId: f.id, path: f.path, kind: title?.kind ?? 'movie', tmdbId: title?.tmdbId ?? 0 });
    return done();
  }

  // ---- Admin › Downloads ----

  // Wanted movies (missing or below the cutoff), and paused ones that would be, with their search backoff; then each
  // show's searches as the sweep would make them (a season pack or an episode), paused shows too.
  async wantedList(): Promise<WantedItem[]> {
    await this.deps.plex.ready();
    return [...this.wantedMovies(), ...this.wantedShows()];
  }
  private wantedShows(): WantedItem[] {
    const now = this.now(), open = this.store.activeGrabs();
    return this.store.monitoredShows().flatMap(title => {
      const state = this.showState(title), grabs = open.filter(g => g.titleId === title.id);
      return showScopes({ monitor: title.monitor, paused: false }, state.seasons, state.episodes, this.profile(title), now).map(scope => {
        const episodes = state.episodes.filter(e => e.season === scope.season && scope.episodes.includes(e.episode));
        const one = scope.episode !== undefined ? episodes[0] : undefined, search = this.store.search(title.id, scope.scope);
        const grab = grabs.find(g => g.episodes.some(([s, e]) => s === scope.season && scope.episodes.includes(e)));
        return { kind: 'show' as const, id: title.id, tmdbId: title.tmdbId, title: title.title, ...(title.year ? { year: title.year } : {}), addedAt: title.addedAt,
          scope: scope.scope, episodes: scope.episodes.length, ...(one?.name ? { episodeName: one.name } : {}), ...(one?.airAt !== undefined ? { airedAt: one.airAt } : {}),
          why: episodes.some(e => !e.file) ? 'missing' as const : 'cutoff' as const, ...(one?.file ? { quality: one.file.quality } : {}),
          paused: title.paused, ...(title.pausedReason ? { pausedReason: title.pausedReason } : {}),
          ...(search ? { nextAt: search.nextAt, ...(search.lastAt ? { lastAt: search.lastAt } : {}), misses: search.misses } : { misses: 0 }),
          ...(grab ? { grab: grab.state } : {}) };
      });
    });
  }
  private wantedMovies(): WantedItem[] {
    return this.store.monitoredMovies().flatMap(title => {
      const file = this.store.files(title.id)[0], search = this.store.search(title.id, 'movie'), grab = this.store.openGrabFor(title.id);
      const wanted = movieWanted({ monitor: title.monitor, paused: false, inPlex: this.deps.plex.has(title.tmdbId), ...(file ? { file } : {}) }, this.profile(title));
      if (!wanted.wanted) return [];
      return [{ kind: 'movie' as const, id: title.id, tmdbId: title.tmdbId, title: title.title, ...(title.year ? { year: title.year } : {}), addedAt: title.addedAt, why: wanted.why, ...(file ? { quality: file.quality } : {}),
        paused: title.paused, ...(title.pausedReason ? { pausedReason: title.pausedReason } : {}),
        ...(search ? { nextAt: search.nextAt, ...(search.lastAt ? { lastAt: search.lastAt } : {}), misses: search.misses } : { misses: 0 }),
        ...(grab ? { grab: grab.state } : {}) }];
    });
  }
  // Every movie, for Admin › Manage › Movies. Below cutoff is the profile's rule on its file (paused or not).
  movieList(sourceOf: (title: LibraryTitle) => MovieSource) {
    const names = new Map(this.store.profiles().map(p => [p.id, p.name])), today = new Date(this.now()).toISOString().slice(0, 10);
    return this.store.allMovies().map(t => {
      const release = (['theatrical', 'digital', 'physical'] as const).map(kind => ({ kind, day: t.released[kind] })).filter((r): r is { kind: typeof r.kind; day: string } => !!r.day && r.day >= today)
        .sort((a, b) => a.day.localeCompare(b.day))[0];
      const belowCutoff = !!t.fileQuality && movieWanted({ monitor: 'all', paused: false, inPlex: true, file: { quality: t.fileQuality } }, this.profile(t)).wanted;
      return { id: t.id, tmdbId: t.tmdbId, title: t.title, ...(t.year ? { year: t.year } : {}), ...(t.fileQuality ? { quality: t.fileQuality } : {}),
        ...(t.fileSize !== undefined ? { size: t.fileSize } : {}), profileId: t.profileId, profile: names.get(t.profileId) ?? 'Default', keep: t.keep, paused: t.paused,
        monitored: t.monitor !== 'none', belowCutoff, ...(t.grab ? { grab: t.grab } : {}), addedAt: t.addedAt, source: sourceOf(t), ...(release ? { release } : {}) };
    });
  }
  // Every show, for Admin › Manage › Shows.
  showList(sourceOf: (title: LibraryTitle) => MovieSource): ShowRow[] {
    const names = new Map(this.store.profiles().map(p => [p.id, p.name])), grabbing = this.store.grabbingTitles();
    return this.store.allShows().map(t => {
      let have = 0, total = 0, missing = 0, cutoff = 0, size = 0;
      const sizes = new Set<number>(), seasons = this.showDetail(t);
      for (const s of seasons) for (const e of s.episodes) {
        if (e.file) { have++; if (!sizes.has(e.file.id)) { sizes.add(e.file.id); size += e.file.size; } }
        if (e.file || (e.aired && e.monitored)) total++;
        if (e.wanted === 'missing') missing++; else if (e.wanted === 'cutoff') cutoff++;
      }
      const today = new Date(this.now()).toISOString().slice(0, 10);
      const nextAir = seasons.flatMap(s => s.episodes.filter(e => !e.aired && e.airDate && e.airDate >= today).map(e => ({ day: e.airDate!, season: s.season, episode: e.episode })))
        .sort((a, b) => a.day.localeCompare(b.day) || a.season - b.season || a.episode - b.episode)[0];
      return { id: t.id, tmdbId: t.tmdbId, ...(t.tvdbId ? { tvdbId: t.tvdbId } : {}), title: t.title, ...(t.year ? { year: t.year } : {}),
        ...(t.released.status ? { status: t.released.status } : {}), seasons: seasons.length, have, total, missing, cutoff, size, profileId: t.profileId,
        profile: names.get(t.profileId) ?? 'Default', keep: t.keep, paused: t.paused, monitored: t.monitor !== 'none', grabbing: grabbing.has(t.id),
        ...(nextAir ? { nextAir } : {}), addedAt: t.addedAt, source: sourceOf(t) };
    });
  }
  // A show's seasons and episodes for its dialog: each episode's file, whether it is wanted (as if unpaused), a grab
  // under way, and its own search's times; each season's pack search times.
  showDetail(title: LibraryTitle): ShowSeasonView[] {
    const state = this.showState(title), profile = this.profile(title), now = this.now(), busy = new Map<string, Grab['state']>();
    for (const g of this.store.activeGrabs()) if (g.titleId === title.id) for (const [s, e] of g.episodes) busy.set(`${s}:${e}`, g.state);
    const times = (scope: string) => { const r = this.store.search(title.id, scope); return r ? { nextAt: r.nextAt, ...(r.lastAt ? { lastAt: r.lastAt } : {}) } : {}; };
    return state.seasons.map(season => ({ season: season.season, monitored: season.monitored, ...times(scopeName(season.season)),
      episodes: state.episodes.filter(e => e.season === season.season).map(e => {
        const w = episodeWanted({ monitor: title.monitor, paused: false }, season.monitored, e, profile, now), grab = busy.get(`${e.season}:${e.episode}`);
        return { episode: e.episode, ...(e.name ? { name: e.name } : {}), ...(e.airDate ? { airDate: e.airDate } : {}), aired: e.airAt !== undefined && e.airAt <= now,
          monitored: title.monitor !== 'none' && season.monitored && e.monitored, ...(e.file ? { file: { id: e.file.id, quality: e.file.quality, size: e.file.size } } : {}),
          ...(w.wanted ? { wanted: w.why } : {}), ...(grab ? { grab } : {}), ...times(scopeName(e.season, e.episode)) };
      }) }));
  }
  // A season's switch in Admin: it and its episodes on or off. Switching one on in a show followed by nothing makes it
  // Manual, so the switch means something; the sweep searches what turns wanted.
  monitorSeason(titleId: number, season: number, on: boolean) {
    const title = this.show(titleId);
    requireThat(this.store.seasons(titleId).some(s => s.season === season), 'NOT_FOUND', 'No such season.', 404);
    this.store.followSeasons(titleId, [season], on);
    if (on && title.monitor === 'none') this.store.setFollow(titleId, 'manual', null);
    this.store.audit('library_season_monitored', { title: titleId, season, on });
  }
  async titleWanted(title: LibraryTitle) { await this.deps.plex.ready(); return this.wanted(title); }

  private movie(titleId: number) {
    const title = this.store.title(titleId);
    requireThat(title && title.kind === 'movie', 'NOT_FOUND', 'No such movie in the library.', 404);
    return title;
  }

  // Search now: queued at once, ahead of its backoff, which starts over.
  searchNow(titleId: number, scope?: string) {
    const any = this.store.title(titleId);
    if (any?.kind === 'show') return this.searchShowNow(any, scope);
    const title = this.movie(titleId);
    requireThat(!title.paused, 'TITLE_PAUSED', `${title.title} is paused. Unpause it first.`, 409);
    requireThat(title.monitor !== 'none', 'TITLE_UNMONITORED', `${title.title} isn’t monitored.`, 409);
    requireThat(!this.store.openGrabFor(title.id), 'GRAB_OPEN', `${title.title} already has a download under way.`, 409);
    const search = this.store.search(title.id, 'movie');
    this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: search?.lastAt ?? 0, misses: 0, nextAt: this.now() });
    this.deps.queue.enqueue('search', `movie:${title.id}`, { titleId: title.id });
  }

  // A show's Search now: the scope given (S02 or S02E05), or every search the show needs now.
  private searchShowNow(title: LibraryTitle, scopeText?: string) {
    requireThat(!title.paused, 'TITLE_PAUSED', `${title.title} is paused. Unpause it first.`, 409);
    requireThat(title.monitor !== 'none', 'TITLE_UNMONITORED', `${title.title} isn’t monitored.`, 409);
    const scopes = scopeText ? [scopeName(this.scopeOf(scopeText).season, this.scopeOf(scopeText).episode)] : this.scopesOf(title).map(s => s.scope);
    requireThat(scopes.length, 'NOTHING_WANTED', `${title.title} has nothing wanted to search for.`, 409);
    for (const scope of scopes) {
      const search = this.store.search(title.id, scope);
      this.store.setSearch({ titleId: title.id, scope, lastAt: search?.lastAt ?? 0, misses: 0, nextAt: this.now() });
      this.queueSearch(title.id, undefined, undefined, scope);
    }
  }

  // Unpausing counts its failures afresh: only blocklist entries from now on pause it again.
  setPaused(titleId: number, paused: boolean) {
    const title = this.store.title(titleId);
    requireThat(title, 'NOT_FOUND', 'No such title in the library.', 404);
    if (!paused && title.paused) { this.store.audit('library_resumed', { title: title.id }); this.searchAfresh(title.id); }
    this.pause(title.id, paused ? 'Paused by an admin' : null);
  }

  // Interactive search: every release found, with its decision. The releases are kept 30 minutes for Grab, so a grab
  // only ever sends what an indexer itself returned.
  private found = new Map<string, { at: number; releases: Release[] }>();
  private hold(key: string, releases: Release[]) {
    const now = this.now();
    for (const [id, entry] of this.found) if (now - entry.at > 30 * MINUTE) this.found.delete(id);
    if (this.found.size >= 20) this.found.delete(this.found.keys().next().value!);
    this.found.delete(key);
    this.found.set(key, { at: now, releases });
  }
  private show(titleId: number) {
    const title = this.store.title(titleId);
    requireThat(title && title.kind === 'show', 'NOT_FOUND', 'No such show in the library.', 404);
    return title;
  }
  private scopeOf(scope: string | undefined) {
    const parsed = parseScope(scope ?? '');
    requireThat(parsed, 'SCOPE_REQUIRED', 'Say which season or episode (S02 or S02E05).', 400);
    return parsed;
  }
  // A release's decision in a show's interactive search: a pack against the season, an episode release against the
  // episode searched (or any episode of the season searched). Nothing is rejected only for not being wanted.
  private showDecision(title: LibraryTitle, release: Release, scope: { season: number; episode?: number }, state: ReturnType<Library['showState']>, ctx: PickContext) {
    const all = state.episodes.filter(e => e.season === scope.season).map(e => e.episode);
    const episodes = scope.episode !== undefined ? [scope.episode] : all.length ? all : [1];
    return decide(release, this.episodeWant(title, scope.season, episodes, parseRelease(release.name).seasonPack, state), ctx);
  }
  private releaseView(d: Decision, best: Decision | undefined) {
    return { guid: d.release.guid, name: d.release.name, indexer: d.release.indexer, protocol: d.release.protocol,
      ...(d.release.size !== undefined ? { size: d.release.size } : {}), ...(d.release.publishedAt !== undefined ? { publishedAt: d.release.publishedAt } : {}),
      ...(d.release.grabs !== undefined ? { grabs: d.release.grabs } : {}), ...(d.release.seeders !== undefined ? { seeders: d.release.seeders } : {}),
      ...(d.release.freeleech ? { freeleech: true } : {}), ...(d.quality ? { quality: d.quality } : {}),
      score: d.score, accepted: d.accepted, upgrade: d.upgrade, reasons: d.reasons, scoreParts: d.scoreParts, rejections: d.rejections,
      ...(d.upgradeReason ? { upgradeReason: d.upgradeReason } : {}), ...(d === best ? { best: true } : {}), parsed: parsedFacts(d.parsed) };
  }
  private async interactiveShow(title: LibraryTitle, scopeText: string | undefined, signal?: AbortSignal): Promise<InteractiveSearch> {
    const scope = this.scopeOf(scopeText), result = await this.deps.indexers.search(this.showQuery(title, scope.season, scope.episode), signal, { manual: true });
    const state = this.showState(title), ctx = this.context(title);
    // An episode search shows the episode's file among the results (a season's has one per episode, so none).
    const file = scope.episode === undefined ? undefined : state.files.get(`${scope.season}:${scope.episode}`);
    const fileGrab = file?.grabId === undefined ? undefined : this.store.grab(file.grabId);
    const releases = file ? result.releases.filter(r => !matchesLibraryFile(r, file, fileGrab)) : result.releases;
    this.hold(`${title.id}:${scopeName(scope.season, scope.episode)}`, releases);
    const decisions = releases.map(r => this.showDecision(title, r, scope, state, ctx));
    const accepted = decisions.filter(d => d.accepted).sort((a, b) => compareDecisions(a, b, ctx)), best = accepted[0];
    const ranked = [...accepted, ...decisions.filter(d => !d.accepted)];
    const runtime = state.episodes.find(e => e.season === scope.season && e.episode === scope.episode)?.runtime || title.runtime || DEFAULT_RUNTIME.show;
    const have = file ? this.currentRelease(file, fileGrab?.protocol, this.have(title, file), runtime, ctx, ranked) : undefined;
    const profileRow = this.store.profiles().find(p => p.id === title.profileId);
    return {
      profile: { name: profileRow?.name ?? 'Default', cutoff: preferredText(ctx.profile) }, ...(have ? { have } : {}),
      releases: ranked.map(d => this.releaseView(d, best)),
      indexers: result.indexers.map(r => ({ indexer: r.indexer, searched: r.searched, ...(r.error ? { error: r.error } : {}) })),
    };
  }
  private grabShowRelease(title: LibraryTitle, guid: string, scopeText: string | undefined) {
    const scope = this.scopeOf(scopeText), key = `${title.id}:${scopeName(scope.season, scope.episode)}`;
    const release = this.found.get(key)?.releases.find(r => r.guid === guid);
    requireThat(release, 'SEARCH_EXPIRED', 'Search again: that result is no longer held.', 409);
    const state = this.showState(title), decision = this.showDecision(title, release, scope, state, this.context(title));
    requireThat(decision.quality, 'QUALITY_UNKNOWN', 'Its quality can’t be read from the name, so it can’t be grabbed.', 409);
    const season = decision.parsed.season ?? scope.season;
    const covers = decision.parsed.seasonPack ? state.episodes.filter(e => e.season === season).map(e => e.episode) : decision.parsed.episodes;
    requireThat(covers.length, 'EPISODES_UNKNOWN', 'It doesn’t say which episodes it holds, so it can’t be grabbed.', 409);
    const grab = this.grab(title, decision, 'By hand', covers.map(e => [season, e] as EpisodeRef));
    requireThat(grab, 'GRAB_OPEN', `Some of those episodes already have a download under way.`, 409);
    this.store.audit('library_manual_grab', { title: title.id, grab: grab.id, release: release.name, accepted: decision.accepted });
    return grab;
  }
  // The library's file as a row of interactive search, for comparison: a movie's file, or an episode search's episode file.
  private currentRelease(file: LibraryFileRow, protocol: Grab['protocol'] | undefined, have: ReturnType<Library['have']>, runtime: number,
    ctx: PickContext, decisions: Decision[]): InteractiveCurrentRelease {
    const name = file.releaseName || win32.basename(file.path);
    const tier = tierOf(ctx.profile, file.quality);
    const sizeTarget = tier >= 0 && !EARLY_COPIES.has(file.quality) ? sizeLimits(ctx.profile.tiers[tier]!, runtime)?.target : undefined;
    const score = have?.score;
    const current = { tier, ...(sizeTarget !== undefined ? { sizeTarget } : {}), ...(score !== undefined ? { score } : {}),
      release: { size: file.size, ...(protocol ? { protocol } : {}) } };
    // Insert among the ranked candidates, leaving the rejected releases in their original order.
    const position = decisions.findIndex(d => !d.accepted || (tier < 0
      ? rank(file.quality) >= rank(d.quality!)
      : compareDecisions(current, d, ctx) <= 0));
    return { current: true, name, quality: file.quality, size: file.size, ...(score !== undefined ? { score } : {}),
      scoreParts: have?.scoreParts ?? [], parsed: parsedFacts(parseRelease(name)),
      position: position < 0 ? decisions.length : position };
  }

  async interactive(titleId: number, signal?: AbortSignal, scope?: string): Promise<InteractiveSearch> {
    const any = this.store.title(titleId);
    if (any?.kind === 'show') return this.interactiveShow(any, scope, signal);
    const title = this.movie(titleId);
    // Every enabled indexer, Usenet and torrents.
    const result = await this.deps.indexers.search({ kind: 'movie', title: title.title, ...(title.year ? { year: title.year } : {}),
      ...(title.imdbId ? { imdbId: title.imdbId } : {}), uhd: allows2160p(this.profile(title)) }, signal, { manual: true });
    const file = this.store.files(title.id)[0], fileGrab = file?.grabId === undefined ? undefined : this.store.grab(file.grabId);
    const releases = file ? result.releases.filter(r => !matchesLibraryFile(r, file, fileGrab)) : result.releases;
    this.hold(String(title.id), releases);
    const want = this.want(title, file), ctx = this.context(title), { decisions, best } = pick(releases, want, ctx);
    const have = file ? this.currentRelease(file, fileGrab?.protocol, want.have, want.runtime || DEFAULT_RUNTIME.movie, ctx, decisions) : undefined;
    const profileRow = this.store.profiles().find(p => p.id === title.profileId);
    return {
      profile: { name: profileRow?.name ?? 'Default', cutoff: preferredText(ctx.profile) }, ...(have ? { have } : {}),
      releases: decisions.map(d => this.releaseView(d, best)),
      indexers: result.indexers.map(r => ({ indexer: r.indexer, searched: r.searched, ...(r.error ? { error: r.error } : {}) })),
    };
  }

  // Grab from the last interactive search. A rejected release may be grabbed by hand, but only one whose quality is known.
  grabRelease(titleId: number, guid: string, scope?: string) {
    requireWritable();
    const any = this.store.title(titleId);
    if (any?.kind === 'show') return this.grabShowRelease(any, guid, scope);
    const title = this.movie(titleId);
    const release = this.found.get(String(title.id))?.releases.find(r => r.guid === guid);
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
    const title = this.store.title(grab.titleId);
    requireThat(title, 'NOT_FOUND', 'No such title in the library.', 404);
    if (title.paused) this.setPaused(title.id, false);
    if (title.monitor === 'none') this.store.setMonitor(title.id, 'all');
    this.store.grabEvent(grab.id, 'retried');
    if (title.kind === 'show') this.searchAgain(this.store.title(title.id)!, grab.episodes);
    else this.searchNow(title.id);
  }

  // ---- refresh-title ----

  private async refresh(item: QueueItem<SearchPayload>): Promise<Outcome> {
    const title = this.store.title(item.payload.titleId);
    if (!title) return done();
    try {
      if (title.kind === 'show') await this.refreshShow(title.id);
      else {
        const facts = await this.tmdb(title.tmdbId);
        this.store.refreshed(title.id, facts);
        // New release dates: the movie is timed again from them, its misses over.
        if (JSON.stringify(facts.released) !== JSON.stringify(title.released)) this.searchAfresh(title.id);
      }
    }
    catch (e) { return fail(errorText(e), e instanceof AppError && e.code === 'NOT_FOUND'); }
    return done();
  }
}
