import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { readOnly } from '../errors.js';
import { errorDetail } from '../lib/every.js';
import { done, fail, retry, type Outcome, type QueueApi, type QueueItem } from './queue.js';
import { homeRelease } from './wanted.js';
import type { LibraryStore } from '../persistence/library-store.js';
import { SubtitleStore, nextUtcDay, whisperRecheckDue } from '../persistence/subtitle-store.js';
import { OpenSubtitlesError, movieHashOf, pickSubtitle, sidecarPath, type Login, type OpenSubtitles, type Wanted } from '../providers/opensubtitles.js';
import { findSidecar, isEnglishText, type ProbeSubtitles } from './subtitle-check.js';

// Finding English subtitles for one video (docs/PHASE-4.md, step 2), as the queue's `find-subtitles` kind, keyed by the
// video's path:
// 1. Gone from the library, already recorded, or already handed to the PC worker: nothing to do.
// 2. An English sidecar or embedded text track: recorded as `sidecar` / `embedded`.
// 3. OpenSubtitles: search by hash and TMDB id, pick, download (under the daily cap), write `<video>.en.srt`, record it,
//    and have Plex scan the folder.
// 4. Nothing found: a job for the PC worker (`queued`) at once.
// A refused or missing login stops it for an hour (`blocked`), without failing items. The backfill and the monthly
// Whisper retry (`recheck`, which skips straight to OpenSubtitles; whisperRecheckDue says when) feed it too.
// The cap, a 429 and a 406 put the item back for later (each uses one of its 10 tries).

export const FIND = 'find-subtitles', CHECK = 'check-subtitles';
const MAX_TRIES = 10, CHECK_TRIES = 3,RATE_WAIT_MS = 60000, BLOCK_MS = 3600000, BATCH = 50;
export const NO_LOGIN = 'No OpenSubtitles login in Admin › Downloads › Subtitles.';
type Payload = { path: string; recheck?: boolean };
export type SubtitleClient = Pick<OpenSubtitles, 'search' | 'download' | 'fetchText'>;
export type FinderDeps = {
  store: SubtitleStore;
  library: Pick<LibraryStore, 'fileByPath' | 'title' | 'fileEpisodes' | 'episodes' | 'filePaths' | 'hasFile'>;
  queue: Pick<QueueApi, 'handle' | 'enqueue' | 'view'>;
  probe: ProbeSubtitles;
  client: (login: Login) => SubtitleClient;
  hash?: (path: string) => Promise<string | undefined>;
  files?: { writeFile: (path: string, text: string) => Promise<void>; rename: (from: string, to: string) => Promise<void>; unlink: (path: string) => Promise<void>; readdir: (dir: string) => Promise<string[]> };
  scan: (folder: string) => Promise<unknown>;
  now?: () => number;
  log: (message: string, detail?: Record<string, unknown>) => void;
};

const realFiles = {
  writeFile: (path: string, text: string) => fs.writeFile(path, text, 'utf8'),
  rename: (from: string, to: string) => fs.rename(from, to),
  unlink: (path: string) => fs.unlink(path),
  readdir: async (dir: string) => (await fs.readdir(dir)).map(String),
};

export class SubtitleFinder {
  private cached: { key: string; client: SubtitleClient } | undefined;
  private files: NonNullable<FinderDeps['files']>;
  constructor(private deps: FinderDeps) { this.files = deps.files ?? realFiles; }
  private now() { return this.deps.now?.() ?? Date.now(); }

  register() {
    this.deps.queue.handle<Payload>(FIND, { concurrency: 2, label: 'Find subtitles', area: 'Subtitles', handler: (item, { signal }) => this.handle(item, signal),
      // Out of tries (ffprobe or a download kept failing): skipped, so the backfill doesn't take it again.
      onFailed: (item, error) => { if (!item.payload.recheck) this.deps.store.skip(item.payload.path, error); } });
    this.deps.queue.handle<Payload>(CHECK, { concurrency: 2, label: 'Check subtitles', area: 'Subtitles', handler: (item, { signal }) => this.check(item, signal),
      onFailed: (item, error) => this.deps.store.skip(item.payload.path, error) });
  }

  // Look for this video's subtitles (now, or at `runAt`).
  request(path: string, runAt?: number) {
    return this.deps.queue.enqueue(FIND, path, { path }, { maxAttempts: MAX_TRIES, ...(runAt !== undefined ? { runAt } : {}) });
  }

  // The library imported a file: whatever was known for that path was for the file it replaced, so it's forgotten
  // (with a sidecar tk.box wrote for it), and the new file is looked at: searched for when subtitles are on, else
  // only checked, so the accounting stays whole.
  async imported(path: string) {
    await this.removeSidecars(this.deps.store.forgetFile(path));
    if (this.deps.store.settings().enabled) this.request(path);
    else this.deps.queue.enqueue(CHECK, path, { path }, { maxAttempts: CHECK_TRIES });
  }

  // ---- the accounting: which files have English and which are missing it, without searching ----

  // Every library file not yet known to have English is checked again (a sidecar, or an embedded text track); one
  // without is recorded as missing. Needs no login, and nothing is downloaded. Returns how many were queued.
  checkLibrary() {
    const known = this.deps.store.englishPaths();
    let queued = 0;
    for (const path of [...this.deps.library.filePaths()].sort()) {
      if (known.has(path)) continue;
      if (this.deps.queue.enqueue(CHECK, path, { path }, { maxAttempts: CHECK_TRIES }).added) queued++;
    }
    return queued;
  }
  // How many checks are queued or running.
  checking() {
    const kind = this.deps.queue.view().kinds.find(k => k.kind === CHECK);
    return kind ? kind.queued + kind.running : 0;
  }
  // The library's files: how many have English, how many are missing it, and how many aren't checked yet.
  accounting() {
    const all = this.deps.library.filePaths(), english = this.deps.store.englishPaths(), missing = this.deps.store.missingPaths();
    let have = 0, lacking = 0;
    for (const path of all) if (english.has(path)) have++; else if (missing.has(path)) lacking++;
    return { total: all.size, english: have, missing: lacking, unchecked: all.size - have - lacking };
  }

  // A sidecar or an embedded English text track: recorded, true. Neither: recorded as missing, false.
  private async local(path: string, signal?: AbortSignal) {
    const { store } = this.deps;
    const sidecar = await findSidecar(path, this.files.readdir);
    if (sidecar) { store.recordFile({ path, language: 'en', source: 'sidecar', subtitlePath: sidecar }); return true; }
    const streams = await this.deps.probe(path, signal);
    if (streams.some(isEnglishText)) { store.recordFile({ path, language: 'en', source: 'embedded' }); return true; }
    store.markMissing(path);
    return false;
  }
  async check(item: QueueItem<Payload>, signal?: AbortSignal): Promise<Outcome> {
    const { path } = item.payload;
    if (!this.deps.library.fileByPath(path) || this.deps.store.file(path)) return done();
    try { await this.local(path, signal); } catch (e) { return fail(`ffprobe: ${errorText(e)}`); }
    return done();
  }

  // The library deleted or replaced these files (library.title.changed): what was known for each goes at once, with a
  // sidecar tk.box wrote for it. A path a new file took is left for `imported`. Returns how many were forgotten.
  async gone(paths: readonly string[]) {
    const left = paths.filter(p => !this.deps.library.hasFile(p));
    for (const path of left) await this.removeSidecars(this.deps.store.forgetFile(path));
    return left.length;
  }

  // The hourly safety net for `gone`. Videos the library no longer has (an upgrade replaced them, or they were deleted): their rows and jobs go, with
  // any sidecar tk.box wrote that's still there. Returns how many were forgotten.
  async reconcile() {
    const have = this.deps.library.filePaths();
    const gone = this.deps.store.knownPaths().filter(p => !have.has(p));
    for (const path of gone) await this.removeSidecars(this.deps.store.forgetFile(path));
    return gone.length;
  }

  private async removeSidecars(paths: string[]) {
    if (readOnly()) return;
    for (const path of paths) {
      try { await this.files.unlink(path); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log('subtitles: a sidecar could not be deleted', { path, ...errorDetail(e) });
      }
    }
  }

  private client(login: Login) {
    const key = JSON.stringify(login);
    if (this.cached?.key !== key) this.cached = { key, client: this.deps.client(login) };
    return this.cached.client;
  }

  // What to search for, and when the video came out (for the Whisper rechecks).
  private wanted(path: string): { wanted: Wanted; releasedAt?: number } | undefined {
    const file = this.deps.library.fileByPath(path);
    const title = file && this.deps.library.title(file.titleId);
    if (!file || !title) return undefined;
    if (title.kind === 'movie') {
      const releasedAt = homeRelease(title.released) ?? dayOf(title.released.theatrical);
      return { wanted: { kind: 'movie', tmdbId: title.tmdbId }, ...(releasedAt !== undefined ? { releasedAt } : {}) };
    }
    const first = this.deps.library.fileEpisodes(title.id).get(file.id)?.[0];
    if (!first) return undefined;
    const [season, episode] = first, row = this.deps.library.episodes(title.id).find(e => e.season === season && e.episode === episode);
    const releasedAt = row?.airAt ?? dayOf(row?.airDate);
    return { wanted: { kind: 'episode', showTmdbId: title.tmdbId, season, episode }, ...(releasedAt !== undefined ? { releasedAt } : {}) };
  }

  // ---- the backfill and the monthly retry (step 3) ----

  // Why the finder can't reach OpenSubtitles (no login, or it was refused), until the settings are saved again or an
  // hour has passed. Items that hit it end without a failure: the backfill takes their videos again later.
  blocked(): string | undefined {
    if (this.block && this.block.until > this.now()) return this.block.reason;
    this.block = undefined;
    return undefined;
  }
  unblock() { this.block = undefined; }
  private block: { reason: string; until: number } | undefined;
  private stop(reason: string): Outcome {
    this.block = { reason, until: this.now() + BLOCK_MS };
    this.deps.log('subtitles: stopped', { reason });
    return done();
  }

  // Ready to download: switched on, a login saved and not refused, and room under today's cap.
  private ready() {
    const { store } = this.deps;
    return store.settings().enabled && !!store.login() && !this.blocked() && store.canDownload(this.now());
  }
  private busy() {
    const kind = this.deps.queue.view().kinds.find(k => k.kind === FIND);
    return !!kind && kind.queued + kind.running > 0;
  }

  // The library's files the finder hasn't dealt with: total and how many are left.
  progress() {
    const all = this.deps.library.filePaths(), handled = this.deps.store.handledPaths();
    let left = 0;
    for (const path of all) if (!handled.has(path)) left++;
    return { total: all.size, left };
  }

  // The backfill over the whole library (docs/PHASE-4.md, question 1): BATCH videos at a time, once the last batch
  // has run, while there's room under the cap. Returns how many were queued.
  backfill() {
    if (!this.ready() || this.busy()) return 0;
    const handled = this.deps.store.handledPaths(), next: string[] = [];
    for (const path of [...this.deps.library.filePaths()].sort()) {
      if (handled.has(path)) continue;
      next.push(path);
      if (next.length >= BATCH) break;
    }
    for (const path of next) this.request(path);
    return next.length;
  }

  // Whisper subtitles are looked for on OpenSubtitles again, daily while the release is new and monthly until it's a
  // year old (whisperRecheckDue); a match replaces them. Returns how many.
  whisperRetry() {
    if (!this.ready()) return 0;
    const now = this.now(), paths: string[] = [];
    for (const { path, at } of this.deps.store.whisperFiles()) {
      const releasedAt = this.wanted(path)?.releasedAt;
      if (!whisperRecheckDue({ now, lastAt: at, ...(releasedAt !== undefined ? { releasedAt } : {}) })) continue;
      paths.push(path);
      if (paths.length >= BATCH) break;
    }
    for (const path of paths) this.deps.queue.enqueue(FIND, path, { path, recheck: true }, { maxAttempts: MAX_TRIES });
    return paths.length;
  }

  async handle(item: QueueItem<Payload>, signal?: AbortSignal): Promise<Outcome> {
    const { path, recheck } = item.payload, { store } = this.deps, settings = store.settings();
    if (!settings.enabled) return done();
    const target = this.wanted(path), known = store.file(path);
    if (!target) return done();
    if (recheck ? known?.source !== 'whisper' : known) return done();
    if (!recheck) {
      if (store.openJob(path)) return done();

      try { if (await this.local(path, signal)) return done(); } catch (e) { return fail(`ffprobe: ${errorText(e)}`); }
    }

    const login = store.login();
    if (!login) return this.stop(NO_LOGIN);
    if (this.blocked()) return done();
    if (!store.canDownload(this.now())) return retry(nextUtcDay(this.now()));
    const client = this.client(login);
    try {
      const hash = await (this.deps.hash ?? movieHashOf)(path).catch(() => undefined);
      const hit = pickSubtitle(await client.search(target.wanted, hash, signal), settings.preferHearingImpaired);
      if (!hit && recheck) { store.touch(path); return done(); }
      if (!hit) {
        store.nothingFound(path);
        this.deps.log('subtitles: none on OpenSubtitles, queued for the worker', { path });
        return done();
      }
      const download = await client.download(hit.fileId, signal);
      store.countDownload(this.now());
      if (download.remaining !== undefined && download.remaining <= 0) store.capReached(this.now());
      const text = await client.fetchText(download.link, signal);
      if (!text.includes('-->')) return fail('OpenSubtitles sent a file that isn’t SRT.');
      if (readOnly()) { this.deps.log('subtitles: read-only, so the subtitle wasn’t written', { path }); return done(); }
      const dest = sidecarPath(path, hit.hearingImpaired), partial = `${dest}.tk-partial`;
      await this.files.writeFile(partial, text);
      await this.files.rename(partial, dest);
      // A Whisper subtitle replaced under another name (.en.sdh.srt) goes.
      if (recheck && known?.subtitlePath && known.subtitlePath !== dest) await this.removeSidecars([known.subtitlePath]);
      store.recordFile({ path, language: 'en', source: 'opensubtitles', subtitlePath: dest, osFileId: hit.fileId, hashMatch: hit.hashMatch });
      this.deps.log('subtitles: downloaded from OpenSubtitles', { path, fileId: hit.fileId, hashMatch: hit.hashMatch });
      await this.deps.scan(dirname(path)).catch(e => this.deps.log('subtitles: Plex wasn’t told about the new subtitle', { path, ...errorDetail(e) }));
      return done();
    } catch (e) {
      if (e instanceof OpenSubtitlesError) {
        if (e.kind === 'quota') { store.capReached(this.now()); return retry(e.resetAt ?? nextUtcDay(this.now())); }
        if (e.kind === 'rate') return retry(this.now() + RATE_WAIT_MS);
        if (e.kind === 'auth') return this.stop(e.message);
      }
      return fail(errorText(e));
    }
  }
}

const dayOf = (day: string | undefined) => {
  const at = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
  return Number.isFinite(at) ? at : undefined;
};
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
