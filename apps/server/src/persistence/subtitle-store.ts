import { z } from 'zod';
import type { Db } from './database.js';
import { prepared } from './statements.js';
import type { Vault } from '../security/vault.js';
import type { Login } from '../providers/opensubtitles.js';
import type { SubtitleJobState, TitleSubtitle } from '../../../../packages/contracts/src/subtitles.js';

// subtitle-finder's tables (modules/migrations/subtitle-finder.ts; docs/PHASE-4.md).

const HOUR_MS = 3600000, DAY_MS = 24 * HOUR_MS, RECENT_MS = 30 * DAY_MS, SETTLED_MS = 365 * DAY_MS;
const SECRET_CONTEXT = 'subtitle-finder:opensubtitles';
// A job a title's dialog shows on a missing file: still to run, or failed.
const TITLE_OPEN: readonly SubtitleJobState[] = ['queued', 'claimed', 'failed'];

export const subtitleSettings = z.object({
  enabled: z.boolean().default(false),
  // VIP allows 1000 a day; 900 leaves headroom.
  dailyCap: z.number().int().min(0).max(5000).default(900),
  preferHearingImpaired: z.boolean().default(false),
  // {apiKey, username, password}, sealed with the vault.
  sealed: z.string().optional(),
}).strip();
export type SubtitleSettings = z.infer<typeof subtitleSettings>;
export type SubtitleSource = 'embedded' | 'sidecar' | 'opensubtitles' | 'whisper';
export type SubtitleFile = { path: string; language: string; source: SubtitleSource; subtitlePath?: string; osFileId?: number; hashMatch?: boolean; at: number };
export type JobState = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
// A job that stops the search for its video: with the worker, or failed there.
const OPEN = "('queued','claimed','failed')";

// The UTC day a download counts on, as YYYY-MM-DD.
export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
// The start of the next UTC day, when an over-cap job may try again.
export const nextUtcDay = (at: number) => Math.floor(at / DAY_MS) * DAY_MS + DAY_MS;

// Whether a Whisper subtitle is due another look on OpenSubtitles: daily while the release is under 30 days old (when
// community subtitles turn up), monthly until it's a year old, then never: an old title with nothing by then keeps
// Whisper's. `releasedAt` is the movie's home release or the episode's air date; unknown counts as old. A "day" is 20
// hours, so the daily retry doesn't miss one for the minutes the last look took.
export function whisperRecheckDue(input: { now: number; lastAt: number; releasedAt?: number }) {
  if (input.releasedAt === undefined) return false;
  const age = input.now - input.releasedAt;
  if (age >= SETTLED_MS) return false;
  return input.now - input.lastAt >= (age < RECENT_MS ? 20 * HOUR_MS : RECENT_MS);
}

type FileRow = { path: string; language: string; source: SubtitleSource; subtitle_path: string | null; os_file_id: number | null; hash_match: number | null; at: number };

export class SubtitleStore {
  constructor(readonly db: Db, private vault: Vault, private now: () => number = Date.now) {}

  settings(): SubtitleSettings & { revision: number } {
    const row = prepared(this.db, 'SELECT revision, value FROM subtitle_settings WHERE id = 1').get() as { revision: number; value: string } | undefined;
    let raw: unknown = {};
    try { raw = row ? JSON.parse(row.value) : {}; } catch { /* defaults */ }
    const value = subtitleSettings.safeParse(raw);
    return { ...(value.success ? value.data : subtitleSettings.parse({})), revision: row?.revision ?? 0 };
  }

  // The saved login, or undefined when any part of it is missing.
  login(): Login | undefined {
    const { sealed } = this.settings();
    if (!sealed) return undefined;
    try {
      const login = JSON.parse(this.vault.open(sealed, SECRET_CONTEXT)) as Partial<Login>;
      return login.apiKey && login.username && login.password ? { apiKey: login.apiKey, username: login.username, password: login.password } : undefined;
    } catch { return undefined; }
  }
  // Which parts of the login are saved (the values are never shown).
  loginParts(): { apiKey: boolean; username?: string; password: boolean } {
    const { sealed } = this.settings();
    if (!sealed) return { apiKey: false, password: false };
    try {
      const login = JSON.parse(this.vault.open(sealed, SECRET_CONTEXT)) as Partial<Login>;
      return { apiKey: !!login.apiKey, ...(login.username ? { username: login.username } : {}), password: !!login.password };
    } catch { return { apiKey: false, password: false }; }
  }

  // A change to the settings, refused (false) when someone else saved first. Each login part given is saved; an empty
  // string clears it; one left out is kept.
  updateSettings(actor: string, expectedRevision: number, patch: Partial<Omit<SubtitleSettings, 'sealed'>>, login?: Partial<Login>) {
    return this.db.transaction(() => {
      const { revision, ...current } = this.settings();
      if (revision !== expectedRevision) return false;
      let sealed = current.sealed;
      if (login && Object.keys(login).length) {
        let saved: Partial<Login> = {};
        try { saved = sealed ? JSON.parse(this.vault.open(sealed, SECRET_CONTEXT)) as Partial<Login> : {}; } catch { /* start over */ }
        for (const key of ['apiKey', 'username', 'password'] as const) {
          const v = login[key];
          if (v === undefined) continue;
          if (v === '') delete saved[key]; else saved[key] = v;
        }
        sealed = Object.keys(saved).length ? this.vault.seal(JSON.stringify(saved), SECRET_CONTEXT) : undefined;
      }
      const next = subtitleSettings.parse({ ...current, ...patch, ...(sealed ? { sealed } : {}) });
      if (!sealed) delete next.sealed;
      prepared(this.db, 'UPDATE subtitle_settings SET revision = revision + 1, value = ? WHERE id = 1').run(JSON.stringify(next));
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)').run(actor, 'subtitle_settings_changed', this.now(),
        JSON.stringify({ ...patch, ...(login ? { login: Object.keys(login) } : {}) }));
      return true;
    })();
  }

  // ---- the daily cap ----

  downloadsOn(day: string) {
    return (prepared(this.db, 'SELECT downloads FROM subtitle_usage WHERE day = ?').get(day) as { downloads: number } | undefined)?.downloads ?? 0;
  }
  // Whether another download fits under today's cap.
  canDownload(at = this.now()) { return this.downloadsOn(utcDay(at)) < this.settings().dailyCap; }
  countDownload(at = this.now()) {
    prepared(this.db, 'INSERT INTO subtitle_usage(day, downloads) VALUES(?, 1) ON CONFLICT(day) DO UPDATE SET downloads = downloads + 1').run(utcDay(at));
  }
  // OpenSubtitles said the account has none left today: today's count is set to the cap, so nothing else tries.
  capReached(at = this.now()) {
    prepared(this.db, 'INSERT INTO subtitle_usage(day, downloads) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET downloads = max(downloads, excluded.downloads)')
      .run(utcDay(at), this.settings().dailyCap);
  }

  // ---- what each video has ----

  file(path: string, language = 'en'): SubtitleFile | undefined {
    const row = prepared(this.db, 'SELECT * FROM subtitle_files WHERE path = ? AND language = ?').get(path, language) as FileRow | undefined;
    return row ? {
      path: row.path, language: row.language, source: row.source, at: row.at,
      ...(row.subtitle_path ? { subtitlePath: row.subtitle_path } : {}), ...(row.os_file_id !== null ? { osFileId: row.os_file_id } : {}),
      ...(row.hash_match !== null ? { hashMatch: row.hash_match === 1 } : {}),
    } : undefined;
  }
  // Records what a video has, and closes any job open for it.
  recordFile(file: Omit<SubtitleFile, 'at'>) {
    this.db.transaction(() => {
      prepared(this.db, `INSERT INTO subtitle_files(path, language, source, subtitle_path, os_file_id, hash_match, at) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path, language) DO UPDATE SET source = excluded.source, subtitle_path = excluded.subtitle_path, os_file_id = excluded.os_file_id,
        hash_match = excluded.hash_match, at = excluded.at`)
        .run(file.path, file.language, file.source, file.subtitlePath ?? null, file.osFileId ?? null, file.hashMatch === undefined ? null : file.hashMatch ? 1 : 0, this.now());
      prepared(this.db, "UPDATE subtitle_jobs SET state = 'done', done_at = ? WHERE path = ? AND language = ? AND state IN ('waiting','queued','claimed')")
        .run(this.now(), file.path, file.language);
      prepared(this.db, 'DELETE FROM subtitle_missing WHERE path = ?').run(file.path);
    })();
  }
  // The video is gone (an upgrade or a delete): its row and open jobs go. Returns the generated sidecar to delete, if
  // tk.box wrote it (OpenSubtitles or Whisper); a sidecar that was there already isn't tk.box's to delete.
  forgetFile(path: string): string[] {
    return this.db.transaction(() => {
      const rows = prepared(this.db, "SELECT subtitle_path FROM subtitle_files WHERE path = ? AND source IN ('opensubtitles','whisper') AND subtitle_path IS NOT NULL").all(path) as { subtitle_path: string }[];
      prepared(this.db, 'DELETE FROM subtitle_files WHERE path = ?').run(path);
      prepared(this.db, 'DELETE FROM subtitle_skips WHERE path = ?').run(path);
      prepared(this.db, 'DELETE FROM subtitle_missing WHERE path = ?').run(path);
      prepared(this.db, "UPDATE subtitle_jobs SET state = 'cancelled', done_at = ? WHERE path = ? AND state IN ('waiting','queued','claimed')").run(this.now(), path);
      return rows.map(r => r.subtitle_path);
    })();
  }

  // ---- jobs for the PC worker ----

  job(path: string, language = 'en') {
    return prepared(this.db, 'SELECT id, state, not_before AS notBefore, attempts FROM subtitle_jobs WHERE path = ? AND language = ?').get(path, language) as
      { id: number; state: JobState; notBefore: number; attempts: number } | undefined;
  }
  // Whether the video is with the worker or failed there (a done or cancelled job was for a file since replaced).
  openJob(path: string, language = 'en') { const job = this.job(path, language); return job && OPEN.includes(`'${job.state}'`) ? job : undefined; }
  // OpenSubtitles had nothing: the video is queued for the worker at once.
  nothingFound(path: string, language = 'en') {
    const now = this.now();
    prepared(this.db, `INSERT INTO subtitle_jobs(path, language, state, not_before, created_at) VALUES(?, ?, 'queued', ?, ?)
      ON CONFLICT(path, language) DO UPDATE SET state = 'queued', not_before = excluded.not_before, created_at = excluded.created_at, attempts = 0,
      worker_id = NULL, lease_until = NULL, error = NULL, done_at = NULL`)
      .run(path, language, now, now);
  }
  // Every video with a row or an open job, for forgetting the ones the library no longer has.
  knownPaths() {
    return (prepared(this.db, `SELECT path FROM subtitle_files UNION SELECT path FROM subtitle_missing UNION SELECT path FROM subtitle_jobs WHERE state IN ('queued','claimed')`).all() as { path: string }[]).map(r => r.path);
  }
  // Every video the finder has dealt with or is dealing with: recorded, with the worker or failed there, or skipped.
  handledPaths() {
    return new Set((prepared(this.db, `SELECT path FROM subtitle_files UNION SELECT path FROM subtitle_jobs WHERE state IN ${OPEN}
      UNION SELECT path FROM subtitle_skips`).all() as { path: string }[]).map(r => r.path));
  }
  skip(path: string, reason: string) {
    prepared(this.db, 'INSERT INTO subtitle_skips(path, reason, at) VALUES(?, ?, ?) ON CONFLICT(path) DO UPDATE SET reason = excluded.reason, at = excluded.at').run(path, reason, this.now());
  }
  // The accounting: videos checked and found without English, and those with it.
  markMissing(path: string) {
    prepared(this.db, 'INSERT INTO subtitle_missing(path, at) VALUES(?, ?) ON CONFLICT(path) DO UPDATE SET at = excluded.at').run(path, this.now());
  }
  // What one file has in English, for its title's Admin dialog: English subtitles, a skip, missing (with its job), or
  // not yet checked.
  titleState(path: string): TitleSubtitle {
    const english = prepared(this.db, "SELECT source, subtitle_path, hash_match, at FROM subtitle_files WHERE path = ? AND language = 'en'").get(path) as
      { source: SubtitleSource; subtitle_path: string | null; hash_match: number | null; at: number } | undefined;
    if (english) return { state: 'english', source: english.source, at: english.at, ...(english.subtitle_path ? { subtitlePath: english.subtitle_path } : {}),
      ...(english.hash_match !== null ? { hashMatch: english.hash_match === 1 } : {}) };
    const skip = prepared(this.db, 'SELECT reason, at FROM subtitle_skips WHERE path = ?').get(path) as { reason: string; at: number } | undefined;
    if (skip) return { state: 'skipped', reason: skip.reason, at: skip.at };
    const job = prepared(this.db, "SELECT state, not_before AS notBefore, attempts, error FROM subtitle_jobs WHERE path = ? AND language = 'en'").get(path) as
      { state: SubtitleJobState; notBefore: number; attempts: number; error: string | null } | undefined;
    const missing = prepared(this.db, 'SELECT at FROM subtitle_missing WHERE path = ?').get(path) as { at: number } | undefined;
    const open = job && TITLE_OPEN.includes(job.state) ? job : undefined;
    if (missing || open) return { state: 'missing', ...(missing ? { at: missing.at } : {}),
      ...(open ? { job: { state: open.state, notBefore: open.notBefore, attempts: open.attempts, ...(open.error ? { error: open.error } : {}) } } : {}) };
    return { state: 'unchecked' };
  }
  missingPaths() { return new Set((prepared(this.db, 'SELECT path FROM subtitle_missing').all() as { path: string }[]).map(r => r.path)); }
  missing() { return prepared(this.db, 'SELECT path, at FROM subtitle_missing ORDER BY path').all() as { path: string; at: number }[]; }
  englishPaths() { return new Set((prepared(this.db, "SELECT path FROM subtitle_files WHERE language = 'en'").all() as { path: string }[]).map(r => r.path)); }
  skipCount() { return (prepared(this.db, 'SELECT count(*) AS n FROM subtitle_skips').get() as { n: number }).n; }
  unskip(path: string) { return prepared(this.db, 'DELETE FROM subtitle_skips WHERE path = ?').run(path).changes > 0; }
  skips(limit = 100) {
    return prepared(this.db, 'SELECT path, reason, at FROM subtitle_skips ORDER BY at DESC LIMIT ?').all(limit) as { path: string; reason: string; at: number }[];
  }
  // Whisper subtitles and when each was last looked for on OpenSubtitles, longest ago first (whisperRecheckDue).
  whisperFiles() {
    return prepared(this.db, `SELECT path, at FROM subtitle_files WHERE source = 'whisper' ORDER BY at`).all() as { path: string; at: number }[];
  }
  // OpenSubtitles still had nothing for a Whisper subtitle: the next look counts from now.
  touch(path: string, language = 'en') { prepared(this.db, 'UPDATE subtitle_files SET at = ? WHERE path = ? AND language = ?').run(this.now(), path, language); }
  // How many recorded videos each source accounts for.
  sources(): Record<SubtitleSource, number> {
    const counts: Record<SubtitleSource, number> = { embedded: 0, sidecar: 0, opensubtitles: 0, whisper: 0 };
    for (const r of prepared(this.db, 'SELECT source, count(*) AS n FROM subtitle_files GROUP BY source').all() as { source: SubtitleSource; n: number }[]) counts[r.source] = r.n;
    return counts;
  }
  // Admin › Downloads › Subtitles: the open or failed jobs, newest first.
  jobs(limit = 200) {
    return prepared(this.db, `SELECT path, state, not_before AS notBefore, attempts, error, created_at AS createdAt FROM subtitle_jobs
      WHERE state IN ${OPEN} ORDER BY created_at DESC LIMIT ?`).all(limit) as
      { path: string; state: JobState; notBefore: number; attempts: number; error: string | null; createdAt: number }[];
  }
  counts(): Record<JobState, number> {
    const counts: Record<JobState, number> = { queued: 0, claimed: 0, done: 0, failed: 0, cancelled: 0 };
    for (const r of prepared(this.db, 'SELECT state, count(*) AS n FROM subtitle_jobs GROUP BY state').all() as { state: JobState; n: number }[]) if (r.state in counts) counts[r.state] = r.n;
    return counts;
  }
}
