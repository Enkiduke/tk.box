import { z } from 'zod';
import type { Db } from './database.js';
import { prepared } from './statements.js';
import { isQuality, type Quality } from '../lib/quality.js';
import type { Format } from '../lib/formats.js';
import type { QualityProfile } from '../lib/profiles.js';
import { MOVIES_ROOT, SHOWS_ROOT } from '../lib/naming.js';
import type { BlockedRelease, Candidate, Protocol } from '../lib/pick-rules.js';

// The library module's rows (docs/ARR-REPLACEMENT.md, "Data model" › library). SQL for the library lives here only.

// The naming formats as text, for the record (the library's files are named by them). lib/naming.ts reproduces
// them.
const NAMING = {
  movieFolder: '{Movie CleanTitle} ({Release Year}) {tmdb-{TmdbId}}',
  movieFile: '{Movie CleanTitle} {(Release Year)} {tmdb-{TmdbId}} {edition-{Edition Tags}} {[Custom Formats]}{[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[Mediainfo VideoCodec]}{-Release Group}',
  seriesFolder: '{Series TitleYear} {tvdb-{TvdbId}}',
  seasonFolder: 'Season {season:00}',
  episodeFile: '{Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle} {[Custom Formats]}{[Quality Full]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[MediaInfo VideoCodec]}{-Release Group}',
};

export const librarySettings = z.object({
  roots: z.object({ movie: z.string().min(1), show: z.string().min(1) }).strict(),
  naming: z.object({ movieFolder: z.string(), movieFile: z.string(), seriesFolder: z.string(), seasonFolder: z.string(), episodeFile: z.string() }).strict(),
  protocol: z.enum(['usenet-first', 'torrent-first']),
  rssMinutes: z.number().int().min(5).max(1440),
  seeding: z.object({ ratio: z.number().min(1), minDays: z.number().min(14), maxDays: z.number().min(14) }).strict(),
  // The download budget (docs/STALLS.md): the projected minutes left a download may have before it counts as slow. A
  // season pack gets three episodes' worth.
  budget: z.object({ movie: z.number().int().min(5).max(240), episode: z.number().int().min(5).max(240) }).strict(),
  maxFailures: z.number().int().min(1).max(50),
  properDays: z.number().int().min(0).max(60),
  defaultProfile: z.number().int().positive(),
}).strict();
export type LibrarySettings = z.infer<typeof librarySettings>;
export const defaultLibrarySettings = (defaultProfile: number): LibrarySettings => ({
  roots: { movie: MOVIES_ROOT, show: SHOWS_ROOT }, naming: { ...NAMING }, protocol: 'usenet-first', rssMinutes: 15,
  seeding: { ratio: 2, minDays: 14, maxDays: 28 }, budget: { movie: 30, episode: 15 }, maxFailures: 5, properDays: 7, defaultProfile,
});

// library_titles.released: for a movie TMDB's days (YYYY-MM-DD); for a show TMDB's status ("Returning Series", "Ended").
export type Released = { theatrical?: string; digital?: string; physical?: string; status?: string };
export type Monitor = 'all' | 'future' | 'first' | 'last' | 'manual' | 'none';
export type LibraryTitle = {
  id: number; kind: 'movie' | 'show'; tmdbId: number; tvdbId?: number; imdbId?: string; title: string; year?: number; aliases: string[];
  monitor: Monitor; monitorFrom?: number; profileId: number; root: string; folder?: string; keep: boolean;
  released: Released; paused: boolean; pausedReason?: string; addedAt: number; addedBy: string; refreshedAt?: number;
  // TMDB's runtime in minutes, for the size limits.
  runtime?: number;
  // A movie's Early copies: cams and telesyncs are taken until a better copy is out, and it's searched from its cinema release.
  earlyCopies: boolean;
};
export type FileMedia = { durationSec?: number; videoCodec?: string; dynamicRange?: string; audioCodec?: string; audioChannels?: string; copied?: boolean };
export type LibraryFileRow = { id: number; titleId: number; path: string; size: number; quality: Quality; proper: boolean; score: number;
  releaseName?: string; releaseGroup?: string; media: FileMedia; grabId?: number; importedAt: number };
export type GrabState = 'sending' | 'downloading' | 'unpacking' | 'importing' | 'imported' | 'seeding' | 'done' | 'failed' | 'cancelled';
export const OPEN_GRAB_STATES: readonly GrabState[] = ['sending', 'downloading', 'unpacking', 'importing', 'seeding'];
// A show's grab covers [season, episode] pairs (a season pack lists every episode it covers); a movie's covers none.
export type EpisodeRef = [season: number, episode: number];
export type Grab = {
  id: number; titleId: number; episodes: EpisodeRef[]; releaseName: string; indexer: string; guid: string; protocol: Protocol; size?: number; quality: Quality; score: number;
  upgrade: boolean; downloader: string; downloadId?: string; state: GrabState; progress?: number; error?: string; contentPath?: string;
  sentAt?: number; finishedAt?: number; importedAt?: number; removedAt?: number;
  // Torrents: when progress last moved, and the seeding figures qBittorrent last gave (and when).
  progressAt?: number; ratio?: number; seedingSeconds?: number; seedingCheckedAt?: number;
  // Download health (docs/STALLS.md): its strikes; the next best releases from the search that picked it; the grab it
  // was swapped in for; and, once out with nothing better, Only source (why, since when, and the last look for better).
  strikes: number; runners: RunnerUp[]; swappedFrom?: number; onlySource?: OutKind; onlySourceAt?: number; swapCheckedAt?: number;
};
// A release kept on a grab in case it has to be swapped: as the indexer found it, with its link.
export type RunnerUp = Candidate & { link: string; categories?: number[] };
// Why a download is out: a confirmed dud (dead after a reannounce, or no complete copy in the swarm) or just slow.
export type OutKind = 'dud' | 'slow';
export type GrabEventKind = GrabState | 'grabbed' | 'retried' | 'only-source';
export type GrabStep = { id: number; at: number; kind: GrabEventKind; note?: string };
export type GrabEvent = GrabStep & { grab: Grab };
export type SearchRow = { titleId: number; scope: string; lastAt: number; misses: number; nextAt: number };
// A show's seasons (season 0, specials, is never stored) and episodes. `airAt`: when it counts as aired; `airTime`:
// when it airs, exactly, where TVmaze knows.
export type SeasonRow = { season: number; monitored: boolean };
export type EpisodeRow = { season: number; episode: number; name?: string; airDate?: string; airAt?: number; airTime?: number; runtime?: number; monitored: boolean };

type TitleRaw = { id: number; kind: 'movie' | 'show'; tmdb_id: number; tvdb_id: number | null; imdb_id: string | null; title: string; year: number | null; aliases: string;
  monitor: Monitor; monitor_from: number | null; profile_id: number; root: string; folder: string | null; keep: number; released: string | null; paused: number;
  paused_reason: string | null; added_at: number; added_by: string; refreshed_at: number | null; runtime: number | null; early_copies: number };
type FileRaw = { id: number; title_id: number; path: string; size: number; quality: string; proper: number; score: number; release_name: string | null;
  release_group: string | null; media: string; grab_id: number | null; imported_at: number };
type GrabRaw = { id: number; title_id: number; episodes: string; release_name: string; indexer: string; guid: string; protocol: Protocol; size: number | null; quality: string; score: number;
  upgrade: number; downloader: string; download_id: string | null; state: GrabState; progress: number | null; error: string | null; content_path: string | null;
  sent_at: number | null; finished_at: number | null; imported_at: number | null; removed_at: number | null;
  progress_at: number | null; ratio: number | null; seeding_seconds: number | null; seeding_checked_at: number | null;
  strikes: number; runners: string | null; swapped_from: number | null; only_source: OutKind | null; only_source_at: number | null; swap_checked_at: number | null };

const json = <T>(text: string | null, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
const quality = (text: string): Quality => isQuality(text) ? text : 'DVD';
const opt = <K extends string, V>(key: K, value: V | null | undefined) => (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const title = (r: TitleRaw): LibraryTitle => ({
  id: r.id, kind: r.kind, tmdbId: r.tmdb_id, ...opt('tvdbId', r.tvdb_id), ...opt('imdbId', r.imdb_id), title: r.title, ...opt('year', r.year),
  aliases: json<string[]>(r.aliases, []), monitor: r.monitor, ...opt('monitorFrom', r.monitor_from), profileId: r.profile_id, root: r.root, ...opt('folder', r.folder),
  keep: !!r.keep, released: json<Released>(r.released, {}), paused: !!r.paused, ...opt('pausedReason', r.paused_reason), addedAt: r.added_at, addedBy: r.added_by,
  ...opt('refreshedAt', r.refreshed_at), ...opt('runtime', r.runtime), earlyCopies: !!r.early_copies,
});
const file = (r: FileRaw): LibraryFileRow => ({
  id: r.id, titleId: r.title_id, path: r.path, size: r.size, quality: quality(r.quality), proper: !!r.proper, score: r.score, ...opt('releaseName', r.release_name),
  ...opt('releaseGroup', r.release_group), media: json<FileMedia>(r.media, {}), ...opt('grabId', r.grab_id), importedAt: r.imported_at,
});
const grab = (r: GrabRaw): Grab => ({
  id: r.id, titleId: r.title_id, episodes: json<EpisodeRef[]>(r.episodes, []), releaseName: r.release_name, indexer: r.indexer, guid: r.guid, protocol: r.protocol, ...opt('size', r.size), quality: quality(r.quality),
  score: r.score, upgrade: !!r.upgrade, downloader: r.downloader, ...opt('downloadId', r.download_id), state: r.state, ...opt('progress', r.progress),
  ...opt('error', r.error), ...opt('contentPath', r.content_path), ...opt('sentAt', r.sent_at), ...opt('finishedAt', r.finished_at),
  ...opt('importedAt', r.imported_at), ...opt('removedAt', r.removed_at), ...opt('progressAt', r.progress_at), ...opt('ratio', r.ratio),
  ...opt('seedingSeconds', r.seeding_seconds), ...opt('seedingCheckedAt', r.seeding_checked_at),
  strikes: r.strikes ?? 0, runners: json<RunnerUp[]>(r.runners, []), ...opt('swappedFrom', r.swapped_from), ...opt('onlySource', r.only_source),
  ...opt('onlySourceAt', r.only_source_at), ...opt('swapCheckedAt', r.swap_checked_at),
});
const OPEN = `state IN ('sending','downloading','unpacking','importing','seeding')`;
// Under way: open but not yet imported. A seeding torrent's title is in the library, so it may be searched and upgraded.
const ACTIVE = `state IN ('sending','downloading','unpacking','importing')`;
// A season's search scope, as searches.scope keeps it (services/wanted.ts, scopeName).
const scopeOf = (season: number) => `S${String(season).padStart(2, '0')}`;

export type NewTitle = { kind: 'movie' | 'show'; tmdbId: number; tvdbId?: number; monitorFrom?: number; imdbId?: string; title: string; year?: number; aliases: string[]; monitor: Monitor; profileId: number;
  root: string; keep: boolean; released: Released; addedBy: string; runtime?: number; earlyCopies?: boolean };
export type NewGrab = { titleId: number; episodes?: EpisodeRef[]; releaseName: string; indexer: string; guid: string; protocol: Protocol; size?: number; quality: Quality; score: number;
  upgrade: boolean; downloader: string; runners?: RunnerUp[]; swappedFrom?: number };
export type NewFile = { titleId: number; path: string; size: number; quality: Quality; proper: boolean; score: number; releaseName?: string; releaseGroup?: string;
  media: FileMedia; grabId?: number };

export class LibraryStore {
  constructor(readonly db: Db, private now: () => number = Date.now) {}

  settings(): LibrarySettings & { revision: number } {
    const row = prepared(this.db, 'SELECT revision, value FROM library_settings WHERE id = 1').get() as { revision: number; value: string } | undefined;
    const value = row ? librarySettings.safeParse(JSON.parse(row.value)) : undefined;
    return { ...(value?.success ? value.data : defaultLibrarySettings(1)), revision: row?.revision ?? 0 };
  }
  // A partial change to the settings, refused when someone else saved first.
  updateSettings(actor: string, expectedRevision: number, patch: Partial<LibrarySettings>) {
    return this.db.transaction(() => {
      const { revision, ...current } = this.settings();
      if (revision !== expectedRevision) return false;
      const next = librarySettings.parse({ ...current, ...patch });
      prepared(this.db, 'UPDATE library_settings SET revision = revision + 1, value = ? WHERE id = 1').run(JSON.stringify(next));
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)').run(actor, 'library_settings_changed', this.now(), JSON.stringify(patch));
      return true;
    })();
  }

  // An entry in the audit log (what the library did on its own, as 'library').
  audit(event: string, detail: Record<string, unknown>) {
    prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)').run('library', event, this.now(), JSON.stringify(detail));
  }

  // ---- Profiles and formats (docs/PROFILES.md) ----

  profile(id: number): QualityProfile | undefined {
    const row = prepared(this.db, 'SELECT value FROM pick_profiles WHERE id = ?').get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as QualityProfile : undefined;
  }
  profiles() { return (prepared(this.db, 'SELECT id, name FROM pick_profiles ORDER BY id').all() as { id: number; name: string }[]); }
  // Each profile in full, with the built-in it came from and how many titles use it.
  profileRows() {
    return (prepared(this.db, 'SELECT p.id, p.name, p.value, p.built_in, (SELECT COUNT(*) FROM library_titles t WHERE t.profile_id = p.id) AS used FROM pick_profiles p ORDER BY p.id').all() as
      { id: number; name: string; value: string; built_in: string | null; used: number }[])
      .map(r => ({ id: r.id, name: r.name, value: JSON.parse(r.value) as QualityProfile, ...opt('builtIn', r.built_in), used: r.used }));
  }
  profileNamed(name: string) { return prepared(this.db, 'SELECT id FROM pick_profiles WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined; }
  insertProfile(name: string, value: QualityProfile, builtIn?: string) {
    return Number(prepared(this.db, 'INSERT INTO pick_profiles(name, value, built_in) VALUES(?, ?, ?)').run(name, JSON.stringify(value), builtIn ?? null).lastInsertRowid);
  }
  updateProfile(id: number, name: string, value: QualityProfile) { prepared(this.db, 'UPDATE pick_profiles SET name = ?, value = ? WHERE id = ?').run(name, JSON.stringify(value), id); }
  deleteProfile(id: number) { prepared(this.db, 'DELETE FROM pick_profiles WHERE id = ?').run(id); }

  formats(): Format[] {
    return (prepared(this.db, 'SELECT name, value FROM formats ORDER BY position, id').all() as { name: string; value: string }[])
      .map(r => ({ name: r.name, ...JSON.parse(r.value) as Omit<Format, 'name'> }));
  }
  // The whole ordered list at once (Admin saves it as one).
  replaceFormats(formats: readonly Format[]) {
    prepared(this.db, 'DELETE FROM formats').run();
    const insert = prepared(this.db, 'INSERT INTO formats(name, value, position) VALUES(?, ?, ?)');
    formats.forEach(({ name, ...value }, i) => insert.run(name, JSON.stringify(value), i));
  }


  // Every movie in the library with its newest file and last grab (Admin › Manage › Movies).
  allMovies() {
    return (prepared(this.db, `SELECT t.*, f.quality AS file_quality, f.size AS file_size,
        (SELECT g.state FROM grabs g WHERE g.title_id = t.id ORDER BY g.id DESC LIMIT 1) AS grab_state
      FROM library_titles t LEFT JOIN library_files f ON f.id = (SELECT id FROM library_files WHERE title_id = t.id ORDER BY imported_at DESC, id DESC LIMIT 1)
      WHERE t.kind = 'movie' ORDER BY t.title COLLATE NOCASE, t.id`).all() as (TitleRaw & { file_quality: string | null; file_size: number | null; grab_state: GrabState | null })[])
      .map(r => ({ ...title(r), ...opt('fileQuality', r.file_quality === null ? null : quality(r.file_quality)), ...opt('fileSize', r.file_size), ...opt('grab', r.grab_state) }));
  }
  // Every title, for library.states.
  allTitles() { return (prepared(this.db, 'SELECT * FROM library_titles ORDER BY id').all() as TitleRaw[]).map(title); }
  // Every show in the library (Admin › Manage › Shows), and the ones tk.box watches (Wanted).
  allShows() { return (prepared(this.db, `SELECT * FROM library_titles WHERE kind = 'show' ORDER BY title COLLATE NOCASE, id`).all() as TitleRaw[]).map(title); }
  monitoredShows() { return (prepared(this.db, `SELECT * FROM library_titles WHERE kind = 'show' AND monitor != 'none' ORDER BY title COLLATE NOCASE, id`).all() as TitleRaw[]).map(title); }
  // A show's files' episodes, by file id.
  fileEpisodes(titleId: number) {
    const byFile = new Map<number, EpisodeRef[]>();
    for (const r of prepared(this.db, 'SELECT file_id, season, episode FROM library_file_episodes WHERE title_id = ? ORDER BY season, episode').all(titleId) as
      { file_id: number; season: number; episode: number }[]) byFile.set(r.file_id, [...byFile.get(r.file_id) ?? [], [r.season, r.episode]]);
    return byFile;
  }
  // Every movie tk.box watches (Admin › Downloads › Wanted).
  monitoredMovies() { return (prepared(this.db, `SELECT * FROM library_titles WHERE kind = 'movie' AND monitor != 'none' ORDER BY title COLLATE NOCASE, id`).all() as TitleRaw[]).map(title); }
  grabsFor(titleId: number, limit = 50) { return (prepared(this.db, 'SELECT * FROM grabs WHERE title_id = ? ORDER BY id DESC LIMIT ?').all(titleId, limit) as GrabRaw[]).map(grab); }
  // Finished grabs, newest first: imported, done and cancelled (history), or failed.
  finishedGrabs(failed: boolean, limit: number) {
    return (prepared(this.db, `SELECT * FROM grabs WHERE ${failed ? "state = 'failed'" : `state != 'failed' AND NOT ${OPEN}`}
      ORDER BY COALESCE(finished_at, imported_at, sent_at, 0) DESC, id DESC LIMIT ?`).all(limit) as GrabRaw[]).map(grab);
  }

  title(id: number) { const r = prepared(this.db, 'SELECT * FROM library_titles WHERE id = ?').get(id) as TitleRaw | undefined; return r ? title(r) : undefined; }
  titleByTmdb(kind: 'movie' | 'show', tmdbId: number) {
    const r = prepared(this.db, 'SELECT * FROM library_titles WHERE kind = ? AND tmdb_id = ?').get(kind, tmdbId) as TitleRaw | undefined;
    return r ? title(r) : undefined;
  }
  // Monitored, unpaused movies: the ones the sweep and RSS look at.
  activeMovies() { return (prepared(this.db, `SELECT * FROM library_titles WHERE kind = 'movie' AND monitor != 'none' AND paused = 0 ORDER BY id`).all() as TitleRaw[]).map(title); }
  insertTitle(t: NewTitle) {
    const id = Number(prepared(this.db, `INSERT INTO library_titles(kind, tmdb_id, tvdb_id, imdb_id, title, year, aliases, monitor, monitor_from, profile_id, root, keep, released, added_at, added_by, refreshed_at, runtime, early_copies)
      VALUES(@kind, @tmdbId, @tvdbId, @imdbId, @title, @year, @aliases, @monitor, @monitorFrom, @profileId, @root, @keep, @released, @now, @addedBy, @now, @runtime, @earlyCopies)`)
      .run({ ...t, tvdbId: t.tvdbId ?? null, monitorFrom: t.monitorFrom ?? null, imdbId: t.imdbId ?? null, year: t.year ?? null, runtime: t.runtime ?? null, aliases: JSON.stringify(t.aliases), keep: t.keep ? 1 : 0, earlyCopies: t.earlyCopies ? 1 : 0, released: JSON.stringify(t.released), now: this.now() }).lastInsertRowid);
    return this.title(id)!;
  }
  // TMDB's facts, from add or refresh-title.
  refreshed(id: number, facts: { tvdbId?: number; imdbId?: string; title: string; year?: number; aliases: string[]; released: Released; runtime?: number }) {
    prepared(this.db, 'UPDATE library_titles SET tvdb_id = COALESCE(?, tvdb_id), imdb_id = COALESCE(?, imdb_id), title = ?, year = ?, aliases = ?, released = ?, runtime = COALESCE(?, runtime), refreshed_at = ? WHERE id = ?')
      .run(facts.tvdbId ?? null, facts.imdbId ?? null, facts.title, facts.year ?? null, JSON.stringify(facts.aliases), JSON.stringify(facts.released), facts.runtime ?? null, this.now(), id);
  }
  setMonitor(id: number, monitor: Monitor) { prepared(this.db, 'UPDATE library_titles SET monitor = ? WHERE id = ?').run(monitor, id); }
  // The Monitored switch. Off keeps the follow mode it had; on gives it back (`fallback` when it never had one).
  unfollow(id: number) {
    prepared(this.db, `UPDATE library_titles SET monitor_was = CASE WHEN monitor != 'none' THEN monitor ELSE monitor_was END, monitor = 'none' WHERE id = ?`).run(id);
  }
  refollow(id: number, fallback: Monitor) {
    prepared(this.db, `UPDATE library_titles SET monitor = COALESCE(monitor_was, ?), monitor_was = NULL WHERE id = ? AND monitor = 'none'`).run(fallback, id);
  }
  // A show's mode with Future's start (null keeps none).
  setFollow(id: number, monitor: Monitor, monitorFrom: number | null) {
    prepared(this.db, 'UPDATE library_titles SET monitor = ?, monitor_from = ? WHERE id = ?').run(monitor, monitorFrom, id);
  }
  // Switches these seasons of a show on or off, with all their episodes.
  followSeasons(titleId: number, seasons: readonly number[], on: boolean) {
    const list = JSON.stringify([...seasons]);
    this.db.transaction(() => {
      prepared(this.db, 'UPDATE library_seasons SET monitored = ? WHERE title_id = ? AND season IN (SELECT value FROM json_each(?))').run(on ? 1 : 0, titleId, list);
      prepared(this.db, 'UPDATE library_episodes SET monitored = ? WHERE title_id = ? AND season IN (SELECT value FROM json_each(?))').run(on ? 1 : 0, titleId, list);
    })();
  }
  // Clean Up deleted a season (its files already gone through Plex): its file records go, and it and its episodes are
  // switched off with their search rows, so nothing searches for it again. Returns the paths it had.
  forgetSeason(titleId: number, season: number) {
    return this.db.transaction(() => {
      const files = prepared(this.db, `SELECT DISTINCT f.id, f.path FROM library_files f JOIN library_file_episodes fe ON fe.file_id = f.id
        WHERE fe.title_id = ? AND fe.season = ?`).all(titleId, season) as { id: number; path: string }[];
      for (const f of files) this.deleteFile(f.id);
      this.followSeasons(titleId, [season], false);
      prepared(this.db, `DELETE FROM searches WHERE title_id = ? AND (scope = ? OR scope LIKE ?)`).run(titleId, scopeOf(season), `${scopeOf(season)}E%`);
      return files.map(f => f.path);
    })();
  }
  // Monitored, unpaused shows (their TMDB refresh).
  activeShows() { return (prepared(this.db, `SELECT * FROM library_titles WHERE kind = 'show' AND monitor != 'none' AND paused = 0 ORDER BY id`).all() as TitleRaw[]).map(title); }

  seasons(titleId: number): SeasonRow[] {
    return (prepared(this.db, 'SELECT season, monitored FROM library_seasons WHERE title_id = ? ORDER BY season').all(titleId) as { season: number; monitored: number }[])
      .map(r => ({ season: r.season, monitored: !!r.monitored }));
  }
  episodes(titleId: number): EpisodeRow[] {
    return (prepared(this.db, 'SELECT * FROM library_episodes WHERE title_id = ? ORDER BY season, episode').all(titleId) as
      { season: number; episode: number; name: string | null; air_date: string | null; air_at: number | null; air_time: number | null; runtime: number | null; monitored: number }[])
      .map(r => ({ season: r.season, episode: r.episode, ...opt('name', r.name), ...opt('airDate', r.air_date), ...opt('airAt', r.air_at), ...opt('airTime', r.air_time), ...opt('runtime', r.runtime),
        monitored: !!r.monitored }));
  }
  // A show's seasons and episodes as TMDB now lists them (refresh-title). Ones TMDB dropped go, unless a file is mapped
  // to them. Specials (season 0) are never stored.
  saveEpisodes(titleId: number, seasons: SeasonRow[], episodes: EpisodeRow[]) {
    this.db.transaction(() => {
      const season = prepared(this.db, `INSERT INTO library_seasons(title_id, season, monitored) VALUES(?, ?, ?)
        ON CONFLICT(title_id, season) DO UPDATE SET monitored = excluded.monitored`);
      const episode = prepared(this.db, `INSERT INTO library_episodes(title_id, season, episode, name, air_date, air_at, air_time, runtime, monitored) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(title_id, season, episode) DO UPDATE SET name = excluded.name, air_date = excluded.air_date, air_at = excluded.air_at, air_time = excluded.air_time, runtime = excluded.runtime,
          monitored = excluded.monitored`);
      const keepSeasons = seasons.filter(s => s.season > 0), keepEpisodes = episodes.filter(e => e.season > 0);
      for (const s of keepSeasons) season.run(titleId, s.season, s.monitored ? 1 : 0);
      for (const e of keepEpisodes) episode.run(titleId, e.season, e.episode, e.name ?? null, e.airDate ?? null, e.airAt ?? null, e.airTime ?? null, e.runtime ?? null, e.monitored ? 1 : 0);
      prepared(this.db, `DELETE FROM library_episodes WHERE title_id = ? AND (season, episode) NOT IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM library_file_episodes f WHERE f.title_id = library_episodes.title_id AND f.season = library_episodes.season AND f.episode = library_episodes.episode)`)
        .run(titleId, JSON.stringify(keepEpisodes.map(e => [e.season, e.episode])));
      prepared(this.db, `DELETE FROM library_seasons WHERE title_id = ? AND season NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM library_episodes e WHERE e.title_id = library_seasons.title_id AND e.season = library_seasons.season)`)
        .run(titleId, JSON.stringify(keepSeasons.map(s => s.season)));
    })();
  }
  setKeep(id: number, keep: boolean) { prepared(this.db, 'UPDATE library_titles SET keep = ? WHERE id = ?').run(keep ? 1 : 0, id); }
  setEarlyCopies(id: number, on: boolean) { prepared(this.db, 'UPDATE library_titles SET early_copies = ? WHERE id = ?').run(on ? 1 : 0, id); }
  setPaused(id: number, reason: string | null) { prepared(this.db, 'UPDATE library_titles SET paused = ?, paused_reason = ? WHERE id = ?').run(reason === null ? 0 : 1, reason, id); }
  setAddedBy(id: number, by: string) { prepared(this.db, 'UPDATE library_titles SET added_by = ? WHERE id = ?').run(by, id); }
  setFolder(id: number, folder: string) { prepared(this.db, 'UPDATE library_titles SET folder = ? WHERE id = ? AND folder IS NULL').run(folder, id); }
  setProfile(id: number, profileId: number) { prepared(this.db, 'UPDATE library_titles SET profile_id = ? WHERE id = ?').run(profileId, id); }
  deleteTitle(id: number) { prepared(this.db, 'DELETE FROM library_titles WHERE id = ?').run(id); }
  // Titles recorded as living in this folder under this root.
  titlesInFolder(root: string, folder: string) { return (prepared(this.db, 'SELECT id FROM library_titles WHERE root = ? AND folder = ?').all(root, folder) as { id: number }[]).map(r => r.id); }

  // Newest first. A movie has one; two means an upgrade stopped between recording the new file and deleting the old.
  files(titleId: number) { return (prepared(this.db, 'SELECT * FROM library_files WHERE title_id = ? ORDER BY imported_at DESC, id DESC').all(titleId) as FileRaw[]).map(file); }
  // Titles with more than one file row for a movie: leftovers of an upgrade cut short.
  leftoverFiles() {
    return (prepared(this.db, `SELECT f.* FROM library_files f JOIN library_titles t ON t.id = f.title_id WHERE t.kind = 'movie' AND f.title_id IN
      (SELECT title_id FROM library_files GROUP BY title_id HAVING COUNT(*) > 1) ORDER BY f.title_id, f.imported_at DESC, f.id DESC`).all() as FileRaw[]).map(file);
  }
  insertFile(f: NewFile) {
    return (prepared(this.db, `INSERT INTO library_files(title_id, path, size, quality, proper, score, release_name, release_group, media, grab_id, imported_at)
      VALUES(@titleId, @path, @size, @quality, @proper, @score, @releaseName, @releaseGroup, @media, @grabId, @now)
      ON CONFLICT(path) DO UPDATE SET title_id = excluded.title_id, size = excluded.size, quality = excluded.quality, proper = excluded.proper, score = excluded.score,
        release_name = excluded.release_name, release_group = excluded.release_group, media = excluded.media, grab_id = excluded.grab_id, imported_at = excluded.imported_at
      RETURNING id`).get({ ...f, proper: f.proper ? 1 : 0, releaseName: f.releaseName ?? null, releaseGroup: f.releaseGroup ?? null, media: JSON.stringify(f.media),
        grabId: f.grabId ?? null, now: this.now() }) as { id: number }).id;
  }
  // A show's file's episodes. Each episode has one file: mapping it here moves it off the file it had.
  mapEpisodes(fileId: number, titleId: number, episodes: readonly EpisodeRef[]) {
    const map = prepared(this.db, `INSERT INTO library_file_episodes(file_id, title_id, season, episode) VALUES(?, ?, ?, ?)
      ON CONFLICT(title_id, season, episode) DO UPDATE SET file_id = excluded.file_id`);
    for (const [season, episode] of episodes) map.run(fileId, titleId, season, episode);
  }
  // Show files no episode is mapped to: an upgrade took all their episodes and stopped before deleting them.
  unmappedShowFiles(titleId?: number) {
    return (prepared(this.db, `SELECT f.* FROM library_files f JOIN library_titles t ON t.id = f.title_id WHERE t.kind = 'show'
      AND (? IS NULL OR f.title_id = ?) AND NOT EXISTS (SELECT 1 FROM library_file_episodes fe WHERE fe.file_id = f.id) ORDER BY f.id`)
      .all(titleId ?? null, titleId ?? null) as FileRaw[]).map(file);
  }
  file(id: number) { const r = prepared(this.db, 'SELECT * FROM library_files WHERE id = ?').get(id) as FileRaw | undefined; return r ? file(r) : undefined; }
  deleteFile(id: number) { prepared(this.db, 'DELETE FROM library_files WHERE id = ?').run(id); }
  // For subtitle-finder: a file by its path, and every file's path (to forget subtitles of files gone).
  fileByPath(path: string) { const r = prepared(this.db, 'SELECT * FROM library_files WHERE path = ?').get(path) as FileRaw | undefined; return r ? file(r) : undefined; }
  hasFile(path: string) { return !!prepared(this.db, 'SELECT 1 FROM library_files WHERE path = ?').get(path); }
  filePaths() { return new Set((prepared(this.db, 'SELECT path FROM library_files').all() as { path: string }[]).map(r => r.path)); }

  grab(id: number) { const r = prepared(this.db, 'SELECT * FROM grabs WHERE id = ?').get(id) as GrabRaw | undefined; return r ? grab(r) : undefined; }
  openGrabs() { return (prepared(this.db, `SELECT * FROM grabs WHERE ${OPEN} ORDER BY id`).all() as GrabRaw[]).map(grab); }
  // Grabs under way (not seeding), for the 30-second check.
  activeGrabs() { return (prepared(this.db, `SELECT * FROM grabs WHERE ${ACTIVE} ORDER BY id`).all() as GrabRaw[]).map(grab); }
  hasOpenGrabs() { return !!prepared(this.db, `SELECT 1 FROM grabs WHERE ${ACTIVE} LIMIT 1`).get(); }
  // Seeding torrents, for the hourly seeding check.
  seedingGrabs() { return (prepared(this.db, `SELECT * FROM grabs WHERE state = 'seeding' ORDER BY id`).all() as GrabRaw[]).map(grab); }
  hasSeeding() { return !!prepared(this.db, `SELECT 1 FROM grabs WHERE state = 'seeding' LIMIT 1`).get(); }
  // Whether any grab, in any state, has this download id (a torrent's info hash).
  knowsDownload(downloadId: string) { return !!prepared(this.db, 'SELECT 1 FROM grabs WHERE download_id = ? LIMIT 1').get(downloadId); }
  // The newest grab for each of these download ids (Admin's live queue).
  grabsByDownload(downloadIds: string[]) {
    if (!downloadIds.length) return new Map<string, Grab>();
    const rows = prepared(this.db, `SELECT * FROM grabs WHERE id IN (SELECT MAX(id) FROM grabs WHERE download_id IN (SELECT value FROM json_each(?)) GROUP BY download_id)`)
      .all(JSON.stringify(downloadIds)) as GrabRaw[];
    return new Map(rows.map(grab).map(g => [g.downloadId!, g]));
  }
  // The title's grab under way (a seeding torrent doesn't count).
  openGrabFor(titleId: number) { const r = prepared(this.db, `SELECT * FROM grabs WHERE title_id = ? AND ${ACTIVE} ORDER BY id DESC LIMIT 1`).get(titleId) as GrabRaw | undefined; return r ? grab(r) : undefined; }
  // A show's episodes with a grab under way.
  grabbingEpisodes(titleId: number): EpisodeRef[] {
    return (prepared(this.db, `SELECT episodes FROM grabs WHERE title_id = ? AND ${ACTIVE}`).all(titleId) as { episodes: string }[]).flatMap(r => json<EpisodeRef[]>(r.episodes, []));
  }
  // Titles with a grab under way (library.state's downloading).
  grabbingTitles() { return new Set((prepared(this.db, `SELECT DISTINCT title_id FROM grabs WHERE ${ACTIVE}`).all() as { title_id: number }[]).map(r => r.title_id)); }
  // A step in a grab's history (grab_events): a GrabState it moved to, `grabbed` or `retried`.
  grabEvent(grabId: number, kind: GrabEventKind, note?: string) {
    prepared(this.db, 'INSERT INTO grab_events(grab_id, at, kind, note) VALUES(?, ?, ?, ?)').run(grabId, this.now(), kind, note ?? null);
  }
  // Downloads › History, newest first.
  grabEvents(limit: number): GrabEvent[] {
    return (prepared(this.db, `SELECT e.id AS event_id, e.at AS event_at, e.kind AS event_kind, e.note AS event_note, g.* FROM grab_events e
      JOIN grabs g ON g.id = e.grab_id ORDER BY e.at DESC, e.id DESC LIMIT ?`).all(limit) as (GrabRaw & { event_id: number; event_at: number; event_kind: GrabEventKind; event_note: string | null })[])
      .map(r => ({ id: r.event_id, at: r.event_at, kind: r.event_kind, ...opt('note', r.event_note), grab: grab(r) }));
  }
  // Downloads › History by grab: the `limit` grabs with the latest steps, newest first, each with all its steps, oldest first.
  grabHistory(limit: number): { grab: Grab; steps: GrabStep[] }[] {
    const rows = prepared(this.db, `SELECT g.* FROM grabs g JOIN (SELECT grab_id, MAX(at) AS last_at FROM grab_events GROUP BY grab_id) e ON e.grab_id = g.id
      ORDER BY e.last_at DESC, g.id DESC LIMIT ?`).all(limit) as GrabRaw[];
    if (!rows.length) return [];
    const steps = new Map<number, GrabStep[]>(rows.map(r => [r.id, []]));
    for (const e of prepared(this.db, `SELECT id, grab_id, at, kind, note FROM grab_events WHERE grab_id IN (SELECT value FROM json_each(?)) ORDER BY at, id`)
      .all(JSON.stringify(rows.map(r => r.id))) as { id: number; grab_id: number; at: number; kind: GrabEventKind; note: string | null }[])
      steps.get(e.grab_id)!.push({ id: e.id, at: e.at, kind: e.kind, ...opt('note', e.note) });
    return rows.map(r => ({ grab: grab(r), steps: steps.get(r.id)! }));
  }
  // A new grab, unless one under way already covers it (then undefined): for a movie any open grab of the title, for a
  // show one covering any of the same episodes. `note`: how it was grabbed ("By hand").
  insertGrab(g: NewGrab, note?: string) {
    return this.db.transaction(() => {
      if (g.episodes?.length ? this.grabbingEpisodes(g.titleId).some(([s, e]) => g.episodes!.some(([s2, e2]) => s === s2 && e === e2)) : this.openGrabFor(g.titleId)) return undefined;
      const id = Number(prepared(this.db, `INSERT INTO grabs(title_id, episodes, release_name, indexer, guid, protocol, size, quality, score, upgrade, downloader, state, runners, swapped_from)
        VALUES(@titleId, @episodes, @releaseName, @indexer, @guid, @protocol, @size, @quality, @score, @upgrade, @downloader, 'sending', @runners, @swappedFrom)`)
        .run({ ...g, episodes: JSON.stringify(g.episodes ?? []), size: g.size ?? null, upgrade: g.upgrade ? 1 : 0,
          runners: g.runners?.length ? JSON.stringify(g.runners) : null, swappedFrom: g.swappedFrom ?? null }).lastInsertRowid);
      this.grabEvent(id, 'grabbed', note);
      return this.grab(id)!;
    })();
  }
  // A change of state is a step in Downloads › History; `note` says more than the state (the error, by default).
  updateGrab(id: number, fields: Partial<{ state: GrabState; downloadId: string; progress: number | null; error: string | null; contentPath: string;
    sentAt: number; finishedAt: number; importedAt: number; removedAt: number; progressAt: number; ratio: number; seedingSeconds: number; seedingCheckedAt: number;
    strikes: number; runners: RunnerUp[]; onlySource: OutKind | null; onlySourceAt: number | null; swapCheckedAt: number }>,
    note?: string) {
    if (fields.state) {
      const was = (prepared(this.db, 'SELECT state FROM grabs WHERE id = ?').get(id) as { state: GrabState } | undefined)?.state;
      if (was && was !== fields.state) this.grabEvent(id, fields.state, note ?? fields.error ?? undefined);
    }
    const columns: Record<string, string> = { state: 'state', downloadId: 'download_id', progress: 'progress', error: 'error', contentPath: 'content_path',
      sentAt: 'sent_at', finishedAt: 'finished_at', importedAt: 'imported_at', removedAt: 'removed_at', progressAt: 'progress_at', ratio: 'ratio',
      seedingSeconds: 'seeding_seconds', seedingCheckedAt: 'seeding_checked_at', strikes: 'strikes', runners: 'runners', onlySource: 'only_source',
      onlySourceAt: 'only_source_at', swapCheckedAt: 'swap_checked_at' };
    const keys = Object.keys(fields).filter(k => k in columns).sort();
    if (!keys.length) return;
    prepared(this.db, `UPDATE grabs SET ${keys.map(k => `${columns[k]} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...Object.fromEntries(keys.map(k => [k, k === 'runners' ? JSON.stringify(fields.runners ?? []) : (fields as Record<string, unknown>)[k] ?? null])), id });
  }
  // The grab's last sent time, for PROPER/REPACK within properDays.
  grabbedAt(grabId: number | undefined) { return grabId === undefined ? undefined : this.grab(grabId)?.sentAt; }

  // Failed releases, and skipped ones until their time is up.
  blocklist(titleId: number): BlockedRelease[] {
    return (prepared(this.db, 'SELECT release_name, indexer, guid, info_hash FROM blocklist WHERE (title_id = ? OR title_id IS NULL) AND (until IS NULL OR until > ?)').all(titleId, this.now()) as
      { release_name: string; indexer: string | null; guid: string | null; info_hash: string | null }[])
      .map(r => ({ name: r.release_name, ...opt('indexer', r.indexer), ...opt('guid', r.guid), ...opt('infoHash', r.info_hash) }));
  }
  // `until`: a skip (docs/STALLS.md, "Skip, not blocklist"), which picks ignore until then and which never counts
  // toward pausing; without it a failure, for good.
  block(entry: { titleId: number; releaseName: string; indexer: string; guid: string; infoHash?: string; reason: string; until?: number }) {
    prepared(this.db, 'INSERT INTO blocklist(title_id, release_name, indexer, guid, info_hash, reason, at, kind, until) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(entry.titleId, entry.releaseName, entry.indexer, entry.guid, entry.infoHash ?? null, entry.reason, this.now(), entry.until === undefined ? 'failed' : 'skipped', entry.until ?? null);
  }
  // Skips whose time is up (the sweep).
  pruneSkips() { return prepared(this.db, `DELETE FROM blocklist WHERE kind = 'skipped' AND until <= ?`).run(this.now()).changes; }
  // When an admin last unpaused the title: its failures count from then.
  resumedAt(titleId: number) {
    return (prepared(this.db, `SELECT MAX(at) AS at FROM audit WHERE actor = 'library' AND event = 'library_resumed' AND json_extract(detail, '$.title') = ?`).get(titleId) as { at: number | null }).at ?? undefined;
  }
  // Failures counted toward pausing: blocklisted releases since the title's last import (or ever).
  failuresSince(titleId: number, since: number) {
    return (prepared(this.db, `SELECT COUNT(*) AS n FROM blocklist WHERE title_id = ? AND at >= ? AND kind = 'failed'`).get(titleId, since) as { n: number }).n;
  }

  search(titleId: number, scope: string) {
    const r = prepared(this.db, 'SELECT * FROM searches WHERE title_id = ? AND scope = ?').get(titleId, scope) as { title_id: number; scope: string; last_at: number; misses: number; next_at: number } | undefined;
    return r ? { titleId: r.title_id, scope: r.scope, lastAt: r.last_at, misses: r.misses, nextAt: r.next_at } satisfies SearchRow : undefined;
  }
  // A title's searches start their misses over, each due by `dueBy` (a show's; a movie's is timed by the library).
  resetSearches(titleId: number, dueBy: number) {
    prepared(this.db, 'UPDATE searches SET misses = 0, next_at = MIN(next_at, ?) WHERE title_id = ?').run(dueBy, titleId);
  }
  setSearch(row: SearchRow) {
    prepared(this.db, `INSERT INTO searches(title_id, scope, last_at, misses, next_at) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(title_id, scope) DO UPDATE SET last_at = excluded.last_at, misses = excluded.misses, next_at = excluded.next_at`)
      .run(row.titleId, row.scope, row.lastAt, row.misses, row.nextAt);
  }
  // A show's files by episode ("season:episode"); an episode has one.
  episodeFiles(titleId: number) {
    const rows = prepared(this.db, `SELECT fe.season, fe.episode, f.* FROM library_file_episodes fe JOIN library_files f ON f.id = fe.file_id
      WHERE fe.title_id = ? ORDER BY f.imported_at DESC, f.id DESC`).all(titleId) as (FileRaw & { season: number; episode: number })[];
    const byEpisode = new Map<string, LibraryFileRow>();
    for (const r of rows) if (!byEpisode.has(`${r.season}:${r.episode}`)) byEpisode.set(`${r.season}:${r.episode}`, file(r));
    return byEpisode;
  }
  // Movies for the calendar (library.calendar decides which it shows): each with its TMDB dates and whether tk.box has
  // a file.
  calendarMovies() {
    return (prepared(this.db, `SELECT t.*, EXISTS(SELECT 1 FROM library_files f WHERE f.title_id = t.id) AS has_file FROM library_titles t WHERE t.kind = 'movie'`)
      .all() as (TitleRaw & { has_file: number })[]).map(r => ({ ...title(r), hasFile: !!r.has_file }));
  }
  // Shows' episodes airing from `from` to `to` (YYYY-MM-DD), for the calendar (library.calendar decides which it shows):
  // the show, the episode, its exact air time where known, whether the show, its season and the episode are all
  // monitored, and whether tk.box has a file for it.
  calendarEpisodes(from: string, to: string) {
    return (prepared(this.db, `SELECT t.*, e.season AS e_season, e.episode AS e_episode, e.name AS e_name, e.air_date AS e_air_date, e.air_time AS e_air_time,
        (t.monitor != 'none' AND COALESCE(s.monitored, 0) AND e.monitored) AS e_followed,
        EXISTS(SELECT 1 FROM library_file_episodes fe WHERE fe.title_id = t.id AND fe.season = e.season AND fe.episode = e.episode) AS has_file
      FROM library_episodes e JOIN library_titles t ON t.id = e.title_id LEFT JOIN library_seasons s ON s.title_id = e.title_id AND s.season = e.season
      WHERE t.kind = 'show' AND e.air_date >= ? AND e.air_date <= ?
      ORDER BY e.air_date, t.id, e.season, e.episode`)
      .all(from, to) as (TitleRaw & { e_season: number; e_episode: number; e_name: string | null; e_air_date: string; e_air_time: number | null; e_followed: number; has_file: number })[])
      .map(r => ({ show: title(r), season: r.e_season, episode: r.e_episode, ...opt('name', r.e_name), airDate: r.e_air_date, ...opt('airTime', r.e_air_time),
        followed: !!r.e_followed, hasFile: !!r.has_file }));
  }
  // Shows Clean Up must keep (library_titles.keep), by TMDB id.
  keptShows() { return new Set((prepared(this.db, `SELECT tmdb_id FROM library_titles WHERE kind = 'show' AND keep = 1`).all() as { tmdb_id: number }[]).map(r => r.tmdb_id)); }
  // Movies Clean Up must keep (library_titles.keep), by TMDB id.
  keptMovies() { return new Set((prepared(this.db, `SELECT tmdb_id FROM library_titles WHERE kind = 'movie' AND keep = 1`).all() as { tmdb_id: number }[]).map(r => r.tmdb_id)); }

  // Movies whose next search is due.
  dueMovies(now: number) {
    return (prepared(this.db, `SELECT t.* FROM library_titles t LEFT JOIN searches s ON s.title_id = t.id AND s.scope = 'movie'
      WHERE t.kind = 'movie' AND t.monitor != 'none' AND t.paused = 0 AND (s.next_at IS NULL OR s.next_at <= ?) ORDER BY IFNULL(s.next_at, 0), t.id`).all(now) as TitleRaw[]).map(title);
  }
}
