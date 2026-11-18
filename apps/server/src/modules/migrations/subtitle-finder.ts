import type { Migration } from '../../persistence/migrate.js';

// Subtitles from OpenSubtitles.com (docs/ARR-REPLACEMENT.md, "Data model" › subtitle-finder; docs/PHASE-4.md).
// subtitle_files: what a video has in English and where it came from. subtitle_jobs: a video OpenSubtitles had nothing
// for, 'waiting' out the grace and then 'queued' for the PC worker (phase 5). subtitle_usage: downloads per UTC day,
// for the daily cap. The worker table comes with phase 5.
export const subtitleFinderMigrations: Migration[] = [
  { name: 'subtitle-finder', up: `
    CREATE TABLE subtitle_files(
      path TEXT NOT NULL, language TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('embedded','sidecar','opensubtitles','whisper')),
      subtitle_path TEXT, os_file_id INTEGER, hash_match INTEGER, at INTEGER NOT NULL,
      PRIMARY KEY(path, language)
    );
    CREATE TABLE subtitle_jobs(
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en',
      state TEXT NOT NULL CHECK(state IN ('waiting','queued','claimed','done','failed','cancelled')),
      not_before INTEGER NOT NULL,
      worker_id INTEGER, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
      created_at INTEGER NOT NULL, done_at INTEGER, UNIQUE(path, language)
    );
    CREATE INDEX subtitle_jobs_due ON subtitle_jobs(state, not_before);
    CREATE TABLE subtitle_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
    INSERT INTO subtitle_settings(id, revision, value) VALUES(1, 1, '{}');
    CREATE TABLE subtitle_usage(day TEXT PRIMARY KEY, downloads INTEGER NOT NULL DEFAULT 0);` },
  // Videos the finder gave up on (ffprobe or the download failed through every try), so the backfill doesn't take them
  // again. Retry in Admin › Downloads › Subtitles clears one.
  { name: 'subtitle-skips', up: `
    CREATE TABLE subtitle_skips(path TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);` },
  // Videos checked and found without English (no sidecar, no embedded text track), for the accounting in Admin ›
  // Downloads › Subtitles. Gone once English is recorded for it, or the video is.
  { name: 'subtitle-missing', up: `
    CREATE TABLE subtitle_missing(path TEXT PRIMARY KEY, at INTEGER NOT NULL);` },
  // The PC workers (docs/PHASE-5.md): each one's bearer token, stored as its SHA-256, and revocable.
  { name: 'subtitle-workers', up: `
    CREATE TABLE subtitle_workers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);` },
  // No more 3-day grace: a video OpenSubtitles had nothing for goes to the worker at once, so any still waiting goes now.
  { name: 'subtitle-no-grace', up: `
    UPDATE subtitle_jobs SET state = 'queued', not_before = created_at WHERE state = 'waiting';` }
];
