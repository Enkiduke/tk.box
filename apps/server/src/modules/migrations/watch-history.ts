import type { Migration } from '../../persistence/migrate.js';

// Watch history (HistoryStore): sessions, the media they played, per-day totals and live allocations.
export const watchHistoryMigrations: Migration[] = [
  { name: 'history', legacy: 23, up: `CREATE TABLE history_media (
        id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, rating_key TEXT NOT NULL, metadata TEXT NOT NULL,
        UNIQUE(server_id, rating_key, metadata)
      );
      CREATE TABLE history_sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT,
        media_id INTEGER NOT NULL REFERENCES history_media(id), client TEXT NOT NULL, stream TEXT NOT NULL,
        generation TEXT NOT NULL, started_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, ended_at INTEGER,
        end_reason TEXT, watch_ms INTEGER NOT NULL CHECK (watch_ms>=0), position_ms INTEGER NOT NULL
      );
      CREATE INDEX history_sessions_by_time ON history_sessions(started_at DESC, id);
      CREATE INDEX history_sessions_by_account ON history_sessions(account_id, started_at DESC, id);
      CREATE INDEX history_sessions_by_media ON history_sessions(media_id, started_at DESC, id);
      CREATE INDEX history_open_sessions ON history_sessions(id) WHERE ended_at IS NULL;
      CREATE INDEX history_recoverable_sessions ON history_sessions(observed_at DESC)
        WHERE end_reason IN ('interrupted','replacing','idle');
      CREATE TABLE history_days (
        session_id TEXT NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE, day TEXT NOT NULL,
        direct_ms INTEGER NOT NULL, remux_ms INTEGER NOT NULL, transcode_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, day)
      );
      CREATE INDEX history_days_by_date ON history_days(day, session_id);` },
  { name: 'live-allocations', legacy: 24, up: `CREATE TABLE history_live_allocations (
        session_id TEXT NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,
        day TEXT NOT NULL, feed_id TEXT NOT NULL, airing_id TEXT NOT NULL,
        media_id INTEGER REFERENCES history_media(id), details TEXT,
        watch_ms INTEGER NOT NULL CHECK(watch_ms>0),
        PRIMARY KEY(session_id,day,feed_id,airing_id)
      );
      CREATE INDEX history_live_media ON history_live_allocations(media_id,day) WHERE media_id IS NOT NULL;
      CREATE INDEX history_live_feed ON history_live_allocations(feed_id,day);` },
  { name: 'summary-indexes', legacy: 25, up: `CREATE INDEX history_sessions_by_watch_time ON history_sessions(watch_ms DESC,id DESC);
      CREATE INDEX history_media_by_show ON history_media(server_id,json_extract(metadata,'$.showId'));
      CREATE INDEX history_media_by_season ON history_media(server_id,json_extract(metadata,'$.seasonId'));` },
  // The title's TMDB and TVDB ids (an episode's: its show's), from the title identity (plexIndex.resolve) as each row
  // is recorded. Older rows are filled by the module after each Plex index rebuild.
  { name: 'title-ids', up: `ALTER TABLE history_media ADD COLUMN tmdb_id INTEGER;
      ALTER TABLE history_media ADD COLUMN tvdb_id INTEGER;
      CREATE INDEX history_media_by_tmdb ON history_media(tmdb_id) WHERE tmdb_id IS NOT NULL;` },
  // Watch dates saved from the old watch-history service (Tautulli) for one Plex server, which Clean Up kept until now
  // (cleanup_watch_snapshot): watch history owns who watched what. Account '' is anyone. Each row's TMDB/TVDB ids are
  // filled by the module after each Plex index rebuild, like history_media's. `history_imports` is when the dates were
  // saved, by whom, and how many titles were checked. Runs before Clean Up's `drop-watch-snapshot` (watch history
  // mounts first); a database without Clean Up's table has nothing to copy.
  { name: 'imported-watches', up: db => {
    db.exec(`CREATE TABLE history_imported_watches(server_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('movie','show','season')),
        rating_key TEXT NOT NULL, account TEXT NOT NULL, at INTEGER NOT NULL, tmdb_id INTEGER, tvdb_id INTEGER,
        PRIMARY KEY(server_id, scope, rating_key, account)) WITHOUT ROWID;
      CREATE TABLE history_imports(server_id TEXT PRIMARY KEY, saved_at INTEGER NOT NULL, saved_by TEXT NOT NULL, checked INTEGER NOT NULL);`);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_watch_snapshot'").get()) return;
    const state = db.prepare("SELECT value FROM cleanup_config WHERE name='state:watch-snapshot'").get() as { value: string } | undefined;
    // Rows were only ever read for the server the state names, so without it there is nothing usable.
    if (!state) return;
    const saved = JSON.parse(state.value) as { at: number; by: string; serverId: string; checked: number };
    db.prepare('INSERT INTO history_imports(server_id,saved_at,saved_by,checked) VALUES(?,?,?,?)').run(saved.serverId, saved.at, saved.by, saved.checked);
    db.prepare(`INSERT INTO history_imported_watches(server_id,scope,rating_key,account,at)
        SELECT ?,scope,rating_key,account,at FROM cleanup_watch_snapshot`).run(saved.serverId);
  } }
];
