import { z } from 'zod';
import type { Db } from './database.js';
import { prepared } from './statements.js';
import { isQuality, type Profile, type Quality, type ScoreRule } from '../lib/quality.js';
import { MOVIES_ROOT } from '../lib/naming.js';
import type { BlockedRelease, Protocol } from '../lib/pick-rules.js';

// The library module's rows (docs/ARR-REPLACEMENT.md, "Data model" › library). SQL for the library lives here only.

export const SHOWS_ROOT = '/srv/media/tv';

// Radarr's and Sonarr's formats as text, for the record and the cutover's comparison. lib/naming.ts reproduces them.
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
  earlyCopies: z.boolean(),
  protocol: z.enum(['usenet-first', 'torrent-first']),
  rssMinutes: z.number().int().min(5).max(1440),
  seeding: z.object({ ratio: z.number().min(1), minDays: z.number().min(14), maxDays: z.number().min(14) }).strict(),
  stalledHours: z.number().min(1).max(168),
  maxFailures: z.number().int().min(1).max(50),
  properDays: z.number().int().min(0).max(60),
  defaultProfile: z.number().int().positive(),
  fulfil: z.object({ movie: z.enum(['radarr', 'tkbox']), show: z.enum(['sonarr', 'tkbox']) }).strict(),
}).strict();
export type LibrarySettings = z.infer<typeof librarySettings>;
export const defaultLibrarySettings = (defaultProfile: number): LibrarySettings => ({
  roots: { movie: MOVIES_ROOT, show: SHOWS_ROOT }, naming: { ...NAMING }, earlyCopies: false, protocol: 'usenet-first', rssMinutes: 15,
  seeding: { ratio: 2, minDays: 14, maxDays: 28 }, stalledHours: 6, maxFailures: 5, properDays: 7, defaultProfile,
  fulfil: { movie: 'radarr', show: 'sonarr' },
});

// library_titles.released for a movie: TMDB's days (YYYY-MM-DD).
export type Released = { theatrical?: string; digital?: string; physical?: string };
export type Monitor = 'all' | 'future' | 'first' | 'last' | 'manual' | 'none';
export type LibraryTitle = {
  id: number; kind: 'movie' | 'show'; tmdbId: number; tvdbId?: number; imdbId?: string; title: string; year?: number; aliases: string[];
  monitor: Monitor; monitorFrom?: number; profileId: number; root: string; folder?: string; keep: boolean;
  released: Released; paused: boolean; pausedReason?: string; addedAt: number; addedBy: string; refreshedAt?: number;
};
export type FileMedia = { durationSec?: number; videoCodec?: string; dynamicRange?: string; audioCodec?: string; audioChannels?: string; copied?: boolean };
export type LibraryFileRow = { id: number; titleId: number; path: string; size: number; quality: Quality; proper: boolean; score: number;
  releaseName?: string; releaseGroup?: string; media: FileMedia; grabId?: number; importedAt: number };
export type GrabState = 'sending' | 'downloading' | 'unpacking' | 'importing' | 'imported' | 'seeding' | 'done' | 'failed' | 'cancelled';
export const OPEN_GRAB_STATES: readonly GrabState[] = ['sending', 'downloading', 'unpacking', 'importing', 'seeding'];
export type Grab = {
  id: number; titleId: number; releaseName: string; indexer: string; guid: string; protocol: Protocol; size?: number; quality: Quality; score: number;
  upgrade: boolean; downloader: string; downloadId?: string; state: GrabState; progress?: number; error?: string; contentPath?: string;
  sentAt?: number; finishedAt?: number; importedAt?: number; removedAt?: number;
};
export type SearchRow = { titleId: number; scope: string; lastAt: number; misses: number; nextAt: number };

type TitleRaw = { id: number; kind: 'movie' | 'show'; tmdb_id: number; tvdb_id: number | null; imdb_id: string | null; title: string; year: number | null; aliases: string;
  monitor: Monitor; monitor_from: number | null; profile_id: number; root: string; folder: string | null; keep: number; released: string | null; paused: number;
  paused_reason: string | null; added_at: number; added_by: string; refreshed_at: number | null };
type FileRaw = { id: number; title_id: number; path: string; size: number; quality: string; proper: number; score: number; release_name: string | null;
  release_group: string | null; media: string; grab_id: number | null; imported_at: number };
type GrabRaw = { id: number; title_id: number; release_name: string; indexer: string; guid: string; protocol: Protocol; size: number | null; quality: string; score: number;
  upgrade: number; downloader: string; download_id: string | null; state: GrabState; progress: number | null; error: string | null; content_path: string | null;
  sent_at: number | null; finished_at: number | null; imported_at: number | null; removed_at: number | null };

const json = <T>(text: string | null, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
const quality = (text: string): Quality => isQuality(text) ? text : 'DVD';
const opt = <K extends string, V>(key: K, value: V | null | undefined) => (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const title = (r: TitleRaw): LibraryTitle => ({
  id: r.id, kind: r.kind, tmdbId: r.tmdb_id, ...opt('tvdbId', r.tvdb_id), ...opt('imdbId', r.imdb_id), title: r.title, ...opt('year', r.year),
  aliases: json<string[]>(r.aliases, []), monitor: r.monitor, ...opt('monitorFrom', r.monitor_from), profileId: r.profile_id, root: r.root, ...opt('folder', r.folder),
  keep: !!r.keep, released: json<Released>(r.released, {}), paused: !!r.paused, ...opt('pausedReason', r.paused_reason), addedAt: r.added_at, addedBy: r.added_by,
  ...opt('refreshedAt', r.refreshed_at),
});
const file = (r: FileRaw): LibraryFileRow => ({
  id: r.id, titleId: r.title_id, path: r.path, size: r.size, quality: quality(r.quality), proper: !!r.proper, score: r.score, ...opt('releaseName', r.release_name),
  ...opt('releaseGroup', r.release_group), media: json<FileMedia>(r.media, {}), ...opt('grabId', r.grab_id), importedAt: r.imported_at,
});
const grab = (r: GrabRaw): Grab => ({
  id: r.id, titleId: r.title_id, releaseName: r.release_name, indexer: r.indexer, guid: r.guid, protocol: r.protocol, ...opt('size', r.size), quality: quality(r.quality),
  score: r.score, upgrade: !!r.upgrade, downloader: r.downloader, ...opt('downloadId', r.download_id), state: r.state, ...opt('progress', r.progress),
  ...opt('error', r.error), ...opt('contentPath', r.content_path), ...opt('sentAt', r.sent_at), ...opt('finishedAt', r.finished_at),
  ...opt('importedAt', r.imported_at), ...opt('removedAt', r.removed_at),
});
const OPEN = `state IN ('sending','downloading','unpacking','importing','seeding')`;

export type NewTitle = { kind: 'movie'; tmdbId: number; imdbId?: string; title: string; year?: number; aliases: string[]; monitor: Monitor; profileId: number;
  root: string; keep: boolean; released: Released; addedBy: string };
export type NewGrab = { titleId: number; releaseName: string; indexer: string; guid: string; protocol: Protocol; size?: number; quality: Quality; score: number;
  upgrade: boolean; downloader: string };
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

  profile(id: number): Profile | undefined {
    const row = prepared(this.db, 'SELECT value FROM pick_profiles WHERE id = ?').get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Profile : undefined;
  }
  profiles() { return (prepared(this.db, 'SELECT id, name FROM pick_profiles ORDER BY id').all() as { id: number; name: string }[]); }
  rules(): ScoreRule[] {
    return (prepared(this.db, 'SELECT * FROM score_rules ORDER BY position, id').all() as { name: string; label: string | null; pattern: string; points: number; ban: number; applies: ScoreRule['applies'] }[])
      .map(r => ({ name: r.name, ...(r.label ? { label: r.label } : {}), pattern: r.pattern, points: r.points, ban: !!r.ban, applies: r.applies }));
  }

  // Admin › Downloads › Pick rules: each profile in full, with how many titles use it.
  profileRows() {
    return (prepared(this.db, 'SELECT p.id, p.name, p.value, (SELECT COUNT(*) FROM library_titles t WHERE t.profile_id = p.id) AS used FROM pick_profiles p ORDER BY p.id').all() as
      { id: number; name: string; value: string; used: number }[]).map(r => ({ id: r.id, name: r.name, value: JSON.parse(r.value) as Profile, used: r.used }));
  }
  profileNamed(name: string) { return prepared(this.db, 'SELECT id FROM pick_profiles WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined; }
  insertProfile(name: string, value: Profile) { return Number(prepared(this.db, 'INSERT INTO pick_profiles(name, value) VALUES(?, ?)').run(name, JSON.stringify(value)).lastInsertRowid); }
  updateProfile(id: number, name: string, value: Profile) { prepared(this.db, 'UPDATE pick_profiles SET name = ?, value = ? WHERE id = ?').run(name, JSON.stringify(value), id); }
  deleteProfile(id: number) { prepared(this.db, 'DELETE FROM pick_profiles WHERE id = ?').run(id); }
  // The whole ordered list at once (Admin's table is saved as one).
  replaceRules(rules: readonly ScoreRule[]) {
    prepared(this.db, 'DELETE FROM score_rules').run();
    const insert = prepared(this.db, 'INSERT INTO score_rules(name, label, pattern, points, ban, applies, position) VALUES(?, ?, ?, ?, ?, ?, ?)');
    rules.forEach((r, i) => insert.run(r.name, r.label ?? null, r.pattern, r.ban ? 0 : r.points, r.ban ? 1 : 0, r.applies, i));
  }

  // Every movie tk.box watches (Admin › Downloads › Wanted).
  monitoredMovies() { return (prepared(this.db, `SELECT * FROM library_titles WHERE kind = 'movie' AND monitor != 'none' ORDER BY title COLLATE NOCASE, id`).all() as TitleRaw[]).map(title); }
  grabsFor(titleId: number, limit = 50) { return (prepared(this.db, 'SELECT * FROM grabs WHERE title_id = ? ORDER BY id DESC LIMIT ?').all(titleId, limit) as GrabRaw[]).map(grab); }
  // Finished grabs, newest first: imported, done and cancelled (history), or failed.
  finishedGrabs(failed: boolean, limit: number) {
    return (prepared(this.db, `SELECT * FROM grabs WHERE ${failed ? "state = 'failed'" : `state NOT IN ('failed','sending','downloading','unpacking','importing','seeding')`}
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
    const id = Number(prepared(this.db, `INSERT INTO library_titles(kind, tmdb_id, imdb_id, title, year, aliases, monitor, profile_id, root, keep, released, added_at, added_by, refreshed_at)
      VALUES(@kind, @tmdbId, @imdbId, @title, @year, @aliases, @monitor, @profileId, @root, @keep, @released, @now, @addedBy, @now)`)
      .run({ ...t, imdbId: t.imdbId ?? null, year: t.year ?? null, aliases: JSON.stringify(t.aliases), keep: t.keep ? 1 : 0, released: JSON.stringify(t.released), now: this.now() }).lastInsertRowid);
    return this.title(id)!;
  }
  // TMDB's facts, from add or refresh-title.
  refreshed(id: number, facts: { imdbId?: string; title: string; year?: number; aliases: string[]; released: Released }) {
    prepared(this.db, 'UPDATE library_titles SET imdb_id = COALESCE(?, imdb_id), title = ?, year = ?, aliases = ?, released = ?, refreshed_at = ? WHERE id = ?')
      .run(facts.imdbId ?? null, facts.title, facts.year ?? null, JSON.stringify(facts.aliases), JSON.stringify(facts.released), this.now(), id);
  }
  setMonitor(id: number, monitor: Monitor) { prepared(this.db, 'UPDATE library_titles SET monitor = ? WHERE id = ?').run(monitor, id); }
  setKeep(id: number, keep: boolean) { prepared(this.db, 'UPDATE library_titles SET keep = ? WHERE id = ?').run(keep ? 1 : 0, id); }
  setPaused(id: number, reason: string | null) { prepared(this.db, 'UPDATE library_titles SET paused = ?, paused_reason = ? WHERE id = ?').run(reason === null ? 0 : 1, reason, id); }
  setAddedBy(id: number, by: string) { prepared(this.db, 'UPDATE library_titles SET added_by = ? WHERE id = ?').run(by, id); }
  setFolder(id: number, folder: string) { prepared(this.db, 'UPDATE library_titles SET folder = ? WHERE id = ? AND folder IS NULL').run(folder, id); }
  setProfile(id: number, profileId: number) { prepared(this.db, 'UPDATE library_titles SET profile_id = ? WHERE id = ?').run(profileId, id); }
  deleteTitle(id: number) { prepared(this.db, 'DELETE FROM library_titles WHERE id = ?').run(id); }

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
  file(id: number) { const r = prepared(this.db, 'SELECT * FROM library_files WHERE id = ?').get(id) as FileRaw | undefined; return r ? file(r) : undefined; }
  deleteFile(id: number) { prepared(this.db, 'DELETE FROM library_files WHERE id = ?').run(id); }

  grab(id: number) { const r = prepared(this.db, 'SELECT * FROM grabs WHERE id = ?').get(id) as GrabRaw | undefined; return r ? grab(r) : undefined; }
  openGrabs() { return (prepared(this.db, `SELECT * FROM grabs WHERE ${OPEN} ORDER BY id`).all() as GrabRaw[]).map(grab); }
  hasOpenGrabs() { return !!prepared(this.db, `SELECT 1 FROM grabs WHERE ${OPEN} LIMIT 1`).get(); }
  openGrabFor(titleId: number) { const r = prepared(this.db, `SELECT * FROM grabs WHERE title_id = ? AND ${OPEN} ORDER BY id DESC LIMIT 1`).get(titleId) as GrabRaw | undefined; return r ? grab(r) : undefined; }
  // Titles with a grab under way (LibraryFulfiller.queue).
  grabbingTitles() { return new Set((prepared(this.db, `SELECT DISTINCT title_id FROM grabs WHERE ${OPEN}`).all() as { title_id: number }[]).map(r => r.title_id)); }
  // A new grab, unless the title already has an open one (then undefined).
  insertGrab(g: NewGrab) {
    return this.db.transaction(() => {
      if (this.openGrabFor(g.titleId)) return undefined;
      const id = Number(prepared(this.db, `INSERT INTO grabs(title_id, release_name, indexer, guid, protocol, size, quality, score, upgrade, downloader, state)
        VALUES(@titleId, @releaseName, @indexer, @guid, @protocol, @size, @quality, @score, @upgrade, @downloader, 'sending')`)
        .run({ ...g, size: g.size ?? null, upgrade: g.upgrade ? 1 : 0 }).lastInsertRowid);
      return this.grab(id)!;
    })();
  }
  updateGrab(id: number, fields: Partial<{ state: GrabState; downloadId: string; progress: number | null; error: string | null; contentPath: string;
    sentAt: number; finishedAt: number; importedAt: number; removedAt: number }>) {
    const columns: Record<string, string> = { state: 'state', downloadId: 'download_id', progress: 'progress', error: 'error', contentPath: 'content_path',
      sentAt: 'sent_at', finishedAt: 'finished_at', importedAt: 'imported_at', removedAt: 'removed_at' };
    const keys = Object.keys(fields).filter(k => k in columns).sort();
    if (!keys.length) return;
    prepared(this.db, `UPDATE grabs SET ${keys.map(k => `${columns[k]} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...Object.fromEntries(keys.map(k => [k, (fields as Record<string, unknown>)[k] ?? null])), id });
  }
  // The grab's last sent time, for PROPER/REPACK within properDays.
  grabbedAt(grabId: number | undefined) { return grabId === undefined ? undefined : this.grab(grabId)?.sentAt; }

  blocklist(titleId: number): BlockedRelease[] {
    return (prepared(this.db, 'SELECT release_name, indexer, guid, info_hash FROM blocklist WHERE title_id = ? OR title_id IS NULL').all(titleId) as
      { release_name: string; indexer: string | null; guid: string | null; info_hash: string | null }[])
      .map(r => ({ name: r.release_name, ...opt('indexer', r.indexer), ...opt('guid', r.guid), ...opt('infoHash', r.info_hash) }));
  }
  block(entry: { titleId: number; releaseName: string; indexer: string; guid: string; reason: string }) {
    prepared(this.db, 'INSERT INTO blocklist(title_id, release_name, indexer, guid, reason, at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(entry.titleId, entry.releaseName, entry.indexer, entry.guid, entry.reason, this.now());
  }
  // When an admin last unpaused the title: its failures count from then.
  resumedAt(titleId: number) {
    return (prepared(this.db, `SELECT MAX(at) AS at FROM audit WHERE actor = 'library' AND event = 'library_resumed' AND json_extract(detail, '$.title') = ?`).get(titleId) as { at: number | null }).at ?? undefined;
  }
  // Failures counted toward pausing: blocklisted releases since the title's last import (or ever).
  failuresSince(titleId: number, since: number) {
    return (prepared(this.db, 'SELECT COUNT(*) AS n FROM blocklist WHERE title_id = ? AND at >= ?').get(titleId, since) as { n: number }).n;
  }

  search(titleId: number, scope: string) {
    const r = prepared(this.db, 'SELECT * FROM searches WHERE title_id = ? AND scope = ?').get(titleId, scope) as { title_id: number; scope: string; last_at: number; misses: number; next_at: number } | undefined;
    return r ? { titleId: r.title_id, scope: r.scope, lastAt: r.last_at, misses: r.misses, nextAt: r.next_at } satisfies SearchRow : undefined;
  }
  setSearch(row: SearchRow) {
    prepared(this.db, `INSERT INTO searches(title_id, scope, last_at, misses, next_at) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(title_id, scope) DO UPDATE SET last_at = excluded.last_at, misses = excluded.misses, next_at = excluded.next_at`)
      .run(row.titleId, row.scope, row.lastAt, row.misses, row.nextAt);
  }
  // Who fulfils a kind (the cutover's Switch and Switch back; the settings PUT doesn't take it).
  setFulfil(actor: string, kind: 'movie', to: 'radarr' | 'tkbox') {
    return this.db.transaction(() => {
      const { revision, ...current } = this.settings();
      const next = librarySettings.parse({ ...current, fulfil: { ...current.fulfil, [kind]: to } });
      prepared(this.db, 'UPDATE library_settings SET revision = revision + 1, value = ? WHERE id = 1').run(JSON.stringify(next));
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)').run(actor, 'library_fulfil_changed', this.now(), JSON.stringify({ kind, to, revision }));
    })();
  }

  // ---- The cutover ----

  // Radarr's id for each imported title, by that id.
  cutoverIds(kind: 'movie' | 'show') {
    return new Map((prepared(this.db, 'SELECT arr_id, title_id FROM library_cutover WHERE kind = ?').all(kind) as { arr_id: number; title_id: number }[]).map(r => [r.arr_id, r.title_id]));
  }
  setCutoverId(kind: 'movie' | 'show', arrId: number, titleId: number) {
    prepared(this.db, 'INSERT INTO library_cutover(kind, arr_id, title_id) VALUES(?, ?, ?) ON CONFLICT(kind, arr_id) DO UPDATE SET title_id = excluded.title_id').run(kind, arrId, titleId);
  }
  cutoverState(kind: 'movie' | 'show') {
    const r = prepared(this.db, 'SELECT * FROM library_cutover_state WHERE kind = ?').get(kind) as
      { imported_at: number | null; summary: string | null; switched_at: number | null; switched_back_at: number | null } | undefined;
    return { ...opt('importedAt', r?.imported_at), ...opt('summary', r?.summary ? JSON.parse(r.summary) as Record<string, number> : undefined),
      ...opt('switchedAt', r?.switched_at), ...opt('switchedBackAt', r?.switched_back_at) };
  }
  setCutoverState(kind: 'movie' | 'show', fields: { importedAt?: number; summary?: Record<string, number>; switchedAt?: number; switchedBackAt?: number }) {
    prepared(this.db, `INSERT INTO library_cutover_state(kind, imported_at, summary, switched_at, switched_back_at) VALUES(@kind, @importedAt, @summary, @switchedAt, @switchedBackAt)
      ON CONFLICT(kind) DO UPDATE SET imported_at = COALESCE(excluded.imported_at, imported_at), summary = COALESCE(excluded.summary, summary),
        switched_at = COALESCE(excluded.switched_at, switched_at), switched_back_at = COALESCE(excluded.switched_back_at, switched_back_at)`)
      .run({ kind, importedAt: fields.importedAt ?? null, summary: fields.summary ? JSON.stringify(fields.summary) : null, switchedAt: fields.switchedAt ?? null,
        switchedBackAt: fields.switchedBackAt ?? null });
  }
  // Every movie, for the calendar: its TMDB dates and whether tk.box has a file for it.
  calendarMovies() {
    return (prepared(this.db, `SELECT t.*, EXISTS(SELECT 1 FROM library_files f WHERE f.title_id = t.id) AS has_file FROM library_titles t WHERE t.kind = 'movie'`).all() as
      (TitleRaw & { has_file: number })[]).map(r => ({ ...title(r), hasFile: !!r.has_file }));
  }
  // Movies Clean Up must keep (library_titles.keep), by TMDB id.
  keptMovies() { return new Set((prepared(this.db, `SELECT tmdb_id FROM library_titles WHERE kind = 'movie' AND keep = 1`).all() as { tmdb_id: number }[]).map(r => r.tmdb_id)); }

  // Movies whose next search is due.
  dueMovies(now: number) {
    return (prepared(this.db, `SELECT t.* FROM library_titles t LEFT JOIN searches s ON s.title_id = t.id AND s.scope = 'movie'
      WHERE t.kind = 'movie' AND t.monitor != 'none' AND t.paused = 0 AND (s.next_at IS NULL OR s.next_at <= ?) ORDER BY IFNULL(s.next_at, 0), t.id`).all(now) as TitleRaw[]).map(title);
  }
}
