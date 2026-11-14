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
      CREATE INDEX history_media_by_season ON history_media(server_id,json_extract(metadata,'$.seasonId'));` }
];
