import type { Migration } from '../../persistence/migrate.js';
import { DEFAULT_PROFILE_NAME, defaultProfile, defaultScoreRules, type Profile, type ScoreRule } from '../../lib/quality.js';
import type { Format } from '../../lib/formats.js';
import { fromLegacy } from '../../lib/profiles.js';
import { BUILTIN_FORMATS, BUILTIN_PROFILES, builtInProfile } from '../../lib/builtin-profiles.js';
import { defaultLibrarySettings } from '../../persistence/library-store.js';

// Titles, files, grabs, the blocklist, search backoff, pick profiles, score rules and the library settings
// (docs/ARR-REPLACEMENT.md, "Data model" › library). The tables are the plan's, as written. The seed is the default
// "1080p" profile, the default score rules and the settings row.
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
  // The one-time import from the old download services: each imported title's id there, so requests' arr_id can move between
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
    db.prepare('UPDATE library_settings SET revision=revision+1, value=? WHERE id=1').run(JSON.stringify({ ...value, fulfil }));
  } },
  // Downloads › History: every step of every grab (grabbed, sent, imported, failed, removed…), kept after the grab's
  // row moves on. Grabs from before it get their first and last step from the grab's own times.
  { name: 'grab-events', up: `
    CREATE TABLE grab_events(id INTEGER PRIMARY KEY, grab_id INTEGER NOT NULL REFERENCES grabs(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT);
    CREATE INDEX grab_events_at ON grab_events(at);
    CREATE INDEX grab_events_grab ON grab_events(grab_id);
    INSERT INTO grab_events(grab_id, at, kind)
      SELECT id, COALESCE(sent_at, finished_at, imported_at, removed_at), 'grabbed' FROM grabs WHERE COALESCE(sent_at, finished_at, imported_at, removed_at) IS NOT NULL;
    INSERT INTO grab_events(grab_id, at, kind)
      SELECT id, imported_at, CASE WHEN state = 'seeding' THEN 'seeding' ELSE 'imported' END FROM grabs WHERE imported_at IS NOT NULL;
    INSERT INTO grab_events(grab_id, at, kind, note)
      SELECT id, COALESCE(removed_at, finished_at), state, error FROM grabs
      WHERE state IN ('failed','cancelled','done') AND COALESCE(removed_at, finished_at) IS NOT NULL;` },
  // Quality profiles v2 (docs/PROFILES.md, "Migration"): formats replace score rules, profiles become tiers and scores.
  // The phase-1 "1080p" becomes Standard with its id, so titles and requests keep pointing at it; any other profile is
  // converted as it was (one tier per rung, its rules as its scores); Quality, Best, Lite and Any are added. A title's
  // TMDB runtime is kept for the size limits.
  { name: 'profiles-v2', up: db => {
    db.exec(`CREATE TABLE formats(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, value TEXT NOT NULL, position INTEGER NOT NULL);
      ALTER TABLE pick_profiles ADD COLUMN built_in TEXT;
      ALTER TABLE library_titles ADD COLUMN runtime INTEGER;`);
    const rules = (db.prepare('SELECT * FROM score_rules ORDER BY position, id').all() as { name: string; label: string | null; pattern: string; points: number; ban: number; applies: ScoreRule['applies'] }[])
      .map(r => ({ name: r.name, ...(r.label ? { label: r.label } : {}), pattern: r.pattern, points: r.points, ban: !!r.ban, applies: r.applies }));
    const formats: Format[] = [...BUILTIN_FORMATS], taken = new Set(formats.map(f => f.name.toLowerCase()));
    const update = db.prepare('UPDATE pick_profiles SET name = ?, value = ?, built_in = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, name, value FROM pick_profiles ORDER BY id').all() as { id: number; name: string; value: string }[];
    const names = new Set(rows.map(r => r.name.toLowerCase()));
    for (const row of rows) {
      if (row.name.toLowerCase() === DEFAULT_PROFILE_NAME.toLowerCase() && !names.has('standard')) {
        const standard = builtInProfile('standard')!;
        update.run(standard.name, JSON.stringify(standard.profile), standard.key, row.id);
        names.delete(row.name.toLowerCase()); names.add('standard');
        continue;
      }
      // Its rules become formats of their own, named apart from the built-ins.
      const { profile, formats: own } = fromLegacy(JSON.parse(row.value) as Profile, rules, 'movie');
      const scores: Record<string, number | 'ban'> = {};
      for (const format of own) {
        let name = format.name;
        if (!formats.some(f => f.name === name && JSON.stringify(f.conditions) === JSON.stringify(format.conditions))) {
          for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${format.name} (rule${i > 1 ? ` ${i}` : ''})`;
          taken.add(name.toLowerCase());
          formats.push({ ...format, name });
        }
        scores[name] = profile.scores[format.name]!;
      }
      update.run(row.name, JSON.stringify({ ...profile, scores }), null, row.id);
    }
    const insertFormat = db.prepare('INSERT INTO formats(name, value, position) VALUES(?, ?, ?)');
    formats.forEach(({ name, ...value }, i) => insertFormat.run(name, JSON.stringify(value), i));
    const insertProfile = db.prepare('INSERT INTO pick_profiles(name, value, built_in) VALUES(?, ?, ?)'), has = db.prepare('SELECT 1 FROM pick_profiles WHERE built_in = ?');
    for (const { key, name, profile } of BUILTIN_PROFILES) {
      if (has.get(key)) continue;
      let free = name;
      for (let i = 2; names.has(free.toLowerCase()); i++) free = `${name} ${i}`;
      names.add(free.toLowerCase());
      insertProfile.run(free, JSON.stringify(profile), key);
    }
    db.exec('DROP TABLE score_rules;');
  } },
  // Phase 2: an episode's own TMDB runtime, for its size limits (runtimes vary within a show).
  { name: 'show-episodes', up: `ALTER TABLE library_episodes ADD COLUMN runtime INTEGER;` },
  // Phase 2 step 6, the one-time show import: each imported show's id there, so requests' arr_id could move on Switch
  // and Switch back. Dropped by `retire-import`.
  { name: 'show-cutover', up: `
    CREATE TABLE show_cutover(source_id INTEGER PRIMARY KEY, title_id INTEGER NOT NULL REFERENCES library_titles(id) ON DELETE CASCADE);
    CREATE INDEX show_cutover_title ON show_cutover(title_id);
    CREATE TABLE show_cutover_state(id INTEGER PRIMARY KEY CHECK(id = 1), imported_at INTEGER, summary TEXT, switched_at INTEGER, switched_back_at INTEGER);` },
  // The Monitored switch: the follow mode a title had before it was switched off, given back when it's switched on.
  { name: 'monitor-was', up: `ALTER TABLE library_titles ADD COLUMN monitor_was TEXT;` },
  // Phase 2 step 7: shows are always tk.box's. The import's tables and the old connections table go, and the
  // settings lose `fulfil`.
  { name: 'retire-import', up: db => {
    db.exec('DROP TABLE IF EXISTS show_cutover; DROP TABLE IF EXISTS show_cutover_state; DROP TABLE IF EXISTS arr_connections;');
    const row = db.prepare('SELECT value FROM library_settings WHERE id=1').get() as { value: string } | undefined;
    if (!row) return;
    const { fulfil: _, ...value } = JSON.parse(row.value) as { fulfil?: unknown };
    db.prepare('UPDATE library_settings SET revision=revision+1, value=? WHERE id=1').run(JSON.stringify(value));
  } },
  // Early copies is each movie's own switch: the settings lose `earlyCopies`, and with it on, every movie starts on.
  { name: 'early-copies-per-movie', up: db => {
    db.exec('ALTER TABLE library_titles ADD COLUMN early_copies INTEGER NOT NULL DEFAULT 0;');
    const row = db.prepare('SELECT value FROM library_settings WHERE id=1').get() as { value: string } | undefined;
    if (!row) return;
    const { earlyCopies, ...value } = JSON.parse(row.value) as { earlyCopies?: boolean };
    if (earlyCopies) db.exec(`UPDATE library_titles SET early_copies = 1 WHERE kind = 'movie';`);
    db.prepare('UPDATE library_settings SET revision=revision+1, value=? WHERE id=1').run(JSON.stringify(value));
  } },
  // Slow and stalled downloads (docs/STALLS.md): a grab's strikes, its runner-ups from the search that picked it, the
  // release it was swapped in for, and when it became Only source (and why: a dud or slow) and was last checked for a
  // faster release. Blocklist entries get a kind: `skipped` ones expire (`until`) and never count toward pausing. The
  // settings swap `stalledHours` for the download budget.
  { name: 'download-health', up: db => {
    db.exec(`ALTER TABLE grabs ADD COLUMN strikes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE grabs ADD COLUMN runners TEXT;
      ALTER TABLE grabs ADD COLUMN swapped_from INTEGER;
      ALTER TABLE grabs ADD COLUMN only_source TEXT;
      ALTER TABLE grabs ADD COLUMN only_source_at INTEGER;
      ALTER TABLE grabs ADD COLUMN swap_checked_at INTEGER;
      ALTER TABLE blocklist ADD COLUMN kind TEXT NOT NULL DEFAULT 'failed';
      ALTER TABLE blocklist ADD COLUMN until INTEGER;`);
    const row = db.prepare('SELECT value FROM library_settings WHERE id=1').get() as { value: string } | undefined;
    if (!row) return;
    const { stalledHours: _, ...value } = JSON.parse(row.value) as { stalledHours?: number };
    db.prepare('UPDATE library_settings SET revision=revision+1, value=? WHERE id=1').run(JSON.stringify({ ...value, budget: { movie: 30, episode: 15 } }));
  } },
];
