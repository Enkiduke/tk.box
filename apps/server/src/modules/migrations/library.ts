import type { Migration } from '../../persistence/migrate.js';
import { DEFAULT_PROFILE_NAME, defaultProfile, defaultScoreRules } from '../../lib/quality.js';
import { defaultLibrarySettings } from '../../persistence/library-store.js';

// Titles, files, grabs, the blocklist, search backoff, pick profiles, score rules and the library settings
// (docs/ARR-REPLACEMENT.md, "Data model" › library). The tables are the plan's, as written. The seed is the default
// "1080p" profile, the default score rules and the settings row, with shows fulfilled by Sonarr.
export const libraryMigrations: Migration[] = [
  { name: 'library', up: `
    CREATE TABLE pick_profiles(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
    CREATE TABLE library_titles(
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('movie','show')),
      tmdb_id INTEGER NOT NULL, tvdb_id INTEGER, imdb_id TEXT,
      title TEXT NOT NULL, year INTEGER, aliases TEXT NOT NULL DEFAULT '[]',
      monitor TEXT NOT NULL CHECK(monitor IN ('all','future','first','last','manual','none')),
      monitor_from INTEGER,
      profile_id INTEGER NOT NULL REFERENCES pick_profiles(id),
      root TEXT NOT NULL,
      folder TEXT,
      keep INTEGER NOT NULL DEFAULT 0,
      released TEXT,
      paused INTEGER NOT NULL DEFAULT 0, paused_reason TEXT,
      added_at INTEGER NOT NULL, added_by TEXT NOT NULL,
      refreshed_at INTEGER,
      UNIQUE(kind, tmdb_id)
    );
    CREATE TABLE library_seasons(title_id INTEGER NOT NULL REFERENCES library_titles(id) ON DELETE CASCADE,
      season INTEGER NOT NULL CHECK(season > 0), monitored INTEGER NOT NULL, PRIMARY KEY(title_id, season));
    CREATE TABLE library_episodes(
      title_id INTEGER NOT NULL REFERENCES library_titles(id) ON DELETE CASCADE,
      season INTEGER NOT NULL CHECK(season > 0), episode INTEGER NOT NULL,
      name TEXT, air_date TEXT, air_at INTEGER, monitored INTEGER NOT NULL,
      PRIMARY KEY(title_id, season, episode)
    );
    CREATE TABLE library_files(
      id INTEGER PRIMARY KEY,
      title_id INTEGER NOT NULL REFERENCES library_titles(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL,
      quality TEXT NOT NULL,
      proper INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0,
      release_name TEXT, release_group TEXT, media TEXT NOT NULL DEFAULT '{}',
      grab_id INTEGER, imported_at INTEGER NOT NULL
    );
    CREATE TABLE library_file_episodes(file_id INTEGER NOT NULL REFERENCES library_files(id) ON DELETE CASCADE,
      title_id INTEGER NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
      PRIMARY KEY(title_id, season, episode));
    CREATE TABLE grabs(
      id INTEGER PRIMARY KEY,
      title_id INTEGER NOT NULL REFERENCES library_titles(id) ON DELETE CASCADE,
      episodes TEXT NOT NULL DEFAULT '[]',
      release_name TEXT NOT NULL, indexer TEXT NOT NULL, guid TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('usenet','torrent')),
      size INTEGER, quality TEXT NOT NULL, score INTEGER NOT NULL, upgrade INTEGER NOT NULL DEFAULT 0,
      downloader TEXT NOT NULL, download_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('sending','downloading','unpacking','importing','imported','seeding','done','failed','cancelled')),
      progress REAL, error TEXT, content_path TEXT,
      sent_at INTEGER, finished_at INTEGER, imported_at INTEGER, removed_at INTEGER
    );
    CREATE INDEX grabs_open ON grabs(state) WHERE state IN ('sending','downloading','unpacking','importing','seeding');
    CREATE TABLE blocklist(id INTEGER PRIMARY KEY, title_id INTEGER, release_name TEXT NOT NULL, indexer TEXT,
      guid TEXT, info_hash TEXT, reason TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE searches(title_id INTEGER NOT NULL, scope TEXT NOT NULL,
      last_at INTEGER NOT NULL, misses INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, PRIMARY KEY(title_id, scope));
    CREATE TABLE score_rules(id INTEGER PRIMARY KEY, name TEXT NOT NULL, label TEXT, pattern TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0, ban INTEGER NOT NULL DEFAULT 0,
      applies TEXT NOT NULL DEFAULT 'both' CHECK(applies IN ('movie','show','both')), position INTEGER NOT NULL);
    CREATE TABLE library_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);` },
  { name: 'library-seed', up: db => {
    const profile = db.prepare('INSERT INTO pick_profiles(name, value) VALUES(?, ?)').run(DEFAULT_PROFILE_NAME, JSON.stringify(defaultProfile()));
    const rule = db.prepare('INSERT INTO score_rules(name, label, pattern, points, ban, applies, position) VALUES(?, ?, ?, ?, ?, ?, ?)');
    defaultScoreRules().forEach((r, i) => rule.run(r.name, r.label ?? null, r.pattern, r.points, r.ban ? 1 : 0, r.applies, i));
    db.prepare('INSERT INTO library_settings(id, revision, value) VALUES(1, 1, ?)')
      .run(JSON.stringify(defaultLibrarySettings(Number(profile.lastInsertRowid))));
  } },
  // The cutover from Radarr (and later Sonarr): each imported title's id there, so requests' arr_id can move between
  // the two ids on Switch and Switch back, and when each kind was imported, switched and switched back.
  { name: 'library-cutover', up: `
    CREATE TABLE library_cutover(kind TEXT NOT NULL CHECK(kind IN ('movie','show')), arr_id INTEGER NOT NULL,
      title_id INTEGER NOT NULL REFERENCES library_titles(id) ON DELETE CASCADE, PRIMARY KEY(kind, arr_id));
    CREATE INDEX library_cutover_title ON library_cutover(title_id);
    CREATE TABLE library_cutover_state(kind TEXT PRIMARY KEY CHECK(kind IN ('movie','show')),
      imported_at INTEGER, summary TEXT, switched_at INTEGER, switched_back_at INTEGER);` },
  // Torrents (phase 3): when a download's progress last moved (the stalled rule), and a seeding torrent's ratio and
  // seeding time as qBittorrent last gave them, with when.
  { name: 'library-torrents', up: `
    ALTER TABLE grabs ADD COLUMN progress_at INTEGER;
    ALTER TABLE grabs ADD COLUMN ratio REAL;
    ALTER TABLE grabs ADD COLUMN seeding_seconds INTEGER;
    ALTER TABLE grabs ADD COLUMN seeding_checked_at INTEGER;
    CREATE INDEX grabs_download ON grabs(download_id);` },
  // Phase 3.5: movies are always tk.box's. The cutover's tables go, and the settings lose `fulfil.movie`.
  { name: 'drop-cutover', up: db => {
    db.exec('DROP TABLE IF EXISTS library_cutover; DROP TABLE IF EXISTS library_cutover_state;');
    const row = db.prepare('SELECT value FROM library_settings WHERE id=1').get() as { value: string } | undefined;
    if (!row) return;
    const value = JSON.parse(row.value) as { fulfil?: { movie?: string; show?: string } };
    const { movie: _, ...fulfil } = value.fulfil ?? {};
    db.prepare('UPDATE library_settings SET revision=revision+1, value=? WHERE id=1').run(JSON.stringify({ ...value, fulfil: { show: 'sonarr', ...fulfil } }));
  } }
];
