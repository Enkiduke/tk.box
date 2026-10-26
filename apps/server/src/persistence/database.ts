import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { playbackSettings, type PlaybackSettings } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(account_id TEXT PRIMARY KEY, allowed INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES users(account_id), encrypted_credential TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_challenges(hash TEXT PRIMARY KEY, pin_id INTEGER NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS playback_sessions(id TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('plex_vod','custom_linear','iptv_live')), rating_key TEXT, expires INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_playback_mode BEFORE UPDATE OF mode ON playback_sessions
        BEGIN SELECT RAISE(ABORT,'Playback mode is immutable'); END;
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publications(id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), revision INTEGER NOT NULL,
        effective_at INTEGER NOT NULL, superseded INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL, UNIQUE(channel_id,revision));`);
    db.prepare('INSERT OR IGNORE INTO settings VALUES(1,0,?)').run(JSON.stringify({ maxConcurrentCpuVideoTranscodes: 2, pauseRetentionMinutes: 30 }));
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(1)').run();
    db.exec(`CREATE TABLE IF NOT EXISTS iptv_sources(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('m3u','xmltv')), name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, interval_hours INTEGER NOT NULL CHECK(interval_hours BETWEEN 1 AND 168),
      auto_add INTEGER NOT NULL DEFAULT 0, encrypted_endpoint TEXT, encrypted_snapshot TEXT,
      encrypted_candidate TEXT, candidate_digest TEXT, last_attempt INTEGER, last_success INTEGER,
      next_due INTEGER, last_error TEXT, retry_after INTEGER);
      CREATE TABLE IF NOT EXISTS lineup_numbers(channel_id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE CHECK(number>0), position INTEGER NOT NULL CHECK(position>=0));
      CREATE TABLE IF NOT EXISTS iptv_channels(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES iptv_sources(id),
      identity TEXT NOT NULL, encrypted_provider TEXT NOT NULL, approval TEXT NOT NULL CHECK(approval IN ('pending','approved','ignored')),
      present INTEGER NOT NULL, conflict INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,missing_since INTEGER,display_name TEXT,
      UNIQUE(source_id,identity));
      CREATE TABLE IF NOT EXISTS iptv_favorites(account_id TEXT NOT NULL REFERENCES users(account_id),channel_id TEXT NOT NULL REFERENCES iptv_channels(id),PRIMARY KEY(account_id,channel_id));
      CREATE TABLE IF NOT EXISTS iptv_mappings(channel_id TEXT NOT NULL REFERENCES iptv_channels(id),feed_id TEXT NOT NULL REFERENCES iptv_sources(id),value TEXT NOT NULL,PRIMARY KEY(channel_id,feed_id));`);
    db.exec('CREATE TABLE IF NOT EXISTS iptv_source_feeds(source_id TEXT PRIMARY KEY REFERENCES iptv_sources(id),feed_id TEXT NOT NULL REFERENCES iptv_sources(id))');
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(2)').run();
    // Channel health: machine-observed playability, separate from administrator curation.
    db.exec(`CREATE TABLE IF NOT EXISTS iptv_health_policies(source_id TEXT PRIMARY KEY REFERENCES iptv_sources(id),
      interval_hours INTEGER NOT NULL CHECK(interval_hours BETWEEN 0 AND 168), connections INTEGER NOT NULL CHECK(connections BETWEEN 1 AND 8), hide_failing INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS iptv_channel_health(channel_id TEXT PRIMARY KEY REFERENCES iptv_channels(id),
      status TEXT NOT NULL DEFAULT 'unchecked' CHECK(status IN ('unchecked','online','offline','placeholder')), reason TEXT, detail TEXT,
      fingerprint TEXT, frozen INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, last_online INTEGER, failures INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0, exempt INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS iptv_channel_health_due ON iptv_channel_health(due);
      CREATE TABLE IF NOT EXISTS iptv_offline_slates(source_id TEXT NOT NULL REFERENCES iptv_sources(id), fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(source_id,fingerprint));`);
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(3)').run();
    // Channel stacks: NULL groups automatically by station name, '' keeps a channel separate.
    if (!(db.prepare('PRAGMA table_info(iptv_channels)').all() as {name: string}[]).some(c => c.name === 'stack_key')) db.exec('ALTER TABLE iptv_channels ADD COLUMN stack_key TEXT');
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(4)').run();
    // Sports events: fetched schedules, and the window each channel of an event-driven source airs in.
    db.exec(`CREATE TABLE IF NOT EXISTS sports_policies(source_id TEXT PRIMARY KEY REFERENCES iptv_sources(id), enabled INTEGER NOT NULL, lead_minutes INTEGER NOT NULL CHECK(lead_minutes BETWEEN 0 AND 720));
      CREATE TABLE IF NOT EXISTS sports_events(id TEXT PRIMARY KEY, source TEXT NOT NULL, sport TEXT NOT NULL, league TEXT NOT NULL, title TEXT NOT NULL,
        start INTEGER NOT NULL, end INTEGER NOT NULL, state TEXT NOT NULL, time_known INTEGER NOT NULL, sides TEXT NOT NULL, abbreviations TEXT NOT NULL, ended_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sports_windows(channel_id TEXT PRIMARY KEY REFERENCES iptv_channels(id), source_id TEXT NOT NULL REFERENCES iptv_sources(id), event_id TEXT,
        title TEXT NOT NULL, league TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, visible_from INTEGER NOT NULL, visible_until INTEGER NOT NULL, state TEXT, matched_by TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sports_windows_source ON sports_windows(source_id);
      CREATE TABLE IF NOT EXISTS sports_admitted(channel_id TEXT PRIMARY KEY REFERENCES iptv_channels(id));`);
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(5)').run();
    // Feeds of one event share a guide row; matches without a scheduled event group by matchup.
    if (!(db.prepare('PRAGMA table_info(sports_windows)').all() as {name: string}[]).some(c => c.name === 'stack_key')) db.exec('ALTER TABLE sports_windows ADD COLUMN stack_key TEXT');
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(6)').run();
    // The sport an event channel carries, for its fallback icon.
    if (!(db.prepare('PRAGMA table_info(sports_windows)').all() as {name: string}[]).some(c => c.name === 'sport')) db.exec('ALTER TABLE sports_windows ADD COLUMN sport TEXT');
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(7)').run();
    // Live Events settings: which leagues are shown and in what order, and the event channel number block.
    // Events and windows keep a stable league key; rows fetched before this get one on the next download.
    for (const table of ['sports_events', 'sports_windows'])
      if (!(db.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[]).some(c => c.name === 'league_key')) db.exec(`ALTER TABLE ${table} ADD COLUMN league_key TEXT`);
    db.exec('CREATE TABLE IF NOT EXISTS sports_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(8)').run();
    // Listing replaces approval: channels list themselves by per-source rules. `listing` is the administrator's override,
    // `event` and `guide_exempt` are derived from the channel's group and name. The old approval and enabled columns
    // are no longer read; ignored or disabled channels become hidden and health exemptions become "always list".
    if (!(db.prepare('PRAGMA table_info(iptv_channels)').all() as {name: string}[]).some(c => c.name === 'listing')) {
      db.exec(`ALTER TABLE iptv_channels ADD COLUMN listing TEXT NOT NULL DEFAULT 'auto' CHECK(listing IN ('auto','always','hidden'));
        ALTER TABLE iptv_channels ADD COLUMN event INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE iptv_channels ADD COLUMN guide_exempt INTEGER NOT NULL DEFAULT 0;
        UPDATE iptv_channels SET listing='hidden' WHERE approval='ignored' OR enabled=0;
        UPDATE iptv_channels SET listing='always' WHERE listing='auto' AND id IN (SELECT channel_id FROM iptv_channel_health WHERE exempt=1);
        UPDATE iptv_channels SET event=1 WHERE source_id IN (SELECT source_id FROM sports_policies WHERE enabled=1);`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS iptv_listing_policies(source_id TEXT PRIMARY KEY REFERENCES iptv_sources(id), require_check INTEGER NOT NULL,
        require_guide INTEGER NOT NULL, guide_hours INTEGER NOT NULL CHECK(guide_hours BETWEEN 0 AND 24), always_on TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS iptv_groups(source_id TEXT NOT NULL REFERENCES iptv_sources(id), name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('auto','regular','events')), guide_exempt INTEGER NOT NULL, PRIMARY KEY(source_id,name));
      CREATE TABLE IF NOT EXISTS iptv_guide_coverage(channel_id TEXT NOT NULL REFERENCES iptv_channels(id), start INTEGER NOT NULL, end INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS iptv_guide_coverage_channel ON iptv_guide_coverage(channel_id,end);`);
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(9)').run();
    // The provider connection limit is server-wide; it starts from the highest per-source limit set before.
    // iptv_health_policies.connections is no longer read.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=10').get()) {
      db.exec('CREATE TABLE IF NOT EXISTS iptv_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)');
      const { n } = db.prepare('SELECT MAX(connections) AS n FROM iptv_health_policies').get() as { n: number | null };
      db.prepare('INSERT OR IGNORE INTO iptv_settings VALUES(1,0,?)').run(JSON.stringify({ maxConnections: n ?? 1 }));
      db.prepare('INSERT INTO migrations VALUES(10)').run();
    }
    // Sources are ordered by the administrator; the guide lists their channels in that order. Starts in creation order.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=11').get()) {
      db.exec('ALTER TABLE iptv_sources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0; UPDATE iptv_sources SET sort_order=rowid;');
      db.prepare('INSERT INTO migrations VALUES(11)').run();
    }
    // Custom channels: administrator-made program lists of Plex media. `draft` is the editable list and `published`
    // the list as last published (before the scheduler rotates it). Schedules live in `channels`/`publications`,
    // numbers in `lineup_numbers`. Sources record each show or season added, for automatic new episodes.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=12').get()) {
      db.exec(`CREATE TABLE custom_channels(id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', logo_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
          draft TEXT NOT NULL DEFAULT '[]', published TEXT);
        CREATE TABLE custom_sources(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES custom_channels(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('show','season')), plex_id TEXT NOT NULL, title TEXT NOT NULL, specials INTEGER NOT NULL DEFAULT 0,
          auto_add INTEGER NOT NULL DEFAULT 0, last_checked INTEGER, last_result TEXT, last_error TEXT, UNIQUE(channel_id,kind,plex_id));
        CREATE TABLE custom_favorites(account_id TEXT NOT NULL REFERENCES users(account_id), channel_id TEXT NOT NULL REFERENCES custom_channels(id) ON DELETE CASCADE,
          PRIMARY KEY(account_id,channel_id));`);
      db.prepare('INSERT INTO migrations VALUES(12)').run();
    }
    // Automatic new episodes: each show or season selection remembers every episode it has seen, so an episode the
    // administrator removed is never re-added. `seeded` marks sources whose seen set is complete (older ones are
    // seeded from Plex, adding nothing, the first time they are checked).
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=13').get()) {
      db.exec(`ALTER TABLE custom_sources ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE custom_source_episodes(source_id TEXT NOT NULL REFERENCES custom_sources(id) ON DELETE CASCADE, plex_id TEXT NOT NULL, PRIMARY KEY(source_id,plex_id));`);
      db.prepare('INSERT INTO migrations VALUES(13)').run();
    }
    // Collections and categories (Plex genres) become channel sources too. SQLite can't widen a CHECK in place, so the
    // table is rebuilt; the seen-episode rows are copied aside first because dropping a parent would cascade them away.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=14').get()) {
      db.exec(`CREATE TEMP TABLE seen_backup AS SELECT * FROM custom_source_episodes;
        DROP TABLE custom_source_episodes;
        CREATE TABLE custom_sources_v14(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES custom_channels(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('show','season','collection','genre')), plex_id TEXT NOT NULL, title TEXT NOT NULL, specials INTEGER NOT NULL DEFAULT 0,
          auto_add INTEGER NOT NULL DEFAULT 0, last_checked INTEGER, last_result TEXT, last_error TEXT, seeded INTEGER NOT NULL DEFAULT 0, UNIQUE(channel_id,kind,plex_id));
        INSERT INTO custom_sources_v14(id,channel_id,kind,plex_id,title,specials,auto_add,last_checked,last_result,last_error,seeded)
          SELECT id,channel_id,kind,plex_id,title,specials,auto_add,last_checked,last_result,last_error,seeded FROM custom_sources;
        DROP TABLE custom_sources;
        ALTER TABLE custom_sources_v14 RENAME TO custom_sources;
        CREATE TABLE custom_source_episodes(source_id TEXT NOT NULL REFERENCES custom_sources(id) ON DELETE CASCADE, plex_id TEXT NOT NULL, PRIMARY KEY(source_id,plex_id));
        INSERT INTO custom_source_episodes SELECT * FROM seen_backup;
        DROP TABLE seen_backup;`);
      db.prepare('INSERT INTO migrations VALUES(14)').run();
    }
    // Which Plex title's logo a custom channel uses when it has no logo address: NULL picks its main show, 'none' turns it off.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=15').get()) {
      db.exec('ALTER TABLE custom_channels ADD COLUMN plex_logo TEXT');
      db.prepare('INSERT INTO migrations VALUES(15)').run();
    }
    // League logos, kept on the server so event channels show them without reaching ESPN or TheSportsDB.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=16').get()) {
      db.exec('CREATE TABLE sports_league_logos(league_key TEXT PRIMARY KEY, url TEXT, type TEXT, bytes BLOB, checked_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO migrations VALUES(16)').run();
    }
    // Artwork (Admin › Artwork): the engine's settings and layouts, which tk.box writes out as its config for each run,
    // and the history of its jobs. Provider keys inside the settings are sealed.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=17').get()) {
      db.exec(`CREATE TABLE artwork_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE TABLE artwork_layouts(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE artwork_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, args TEXT NOT NULL, actor TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')), created_at INTEGER NOT NULL,
          started_at INTEGER, finished_at INTEGER, exit_code INTEGER, output TEXT NOT NULL DEFAULT '');`);
      db.prepare('INSERT INTO migrations VALUES(17)').run();
    }
    // Artwork collections (custom and seasonal definitions, franchise sync and Radarr), and small values the artwork
    // schedules keep between runs (last runs, the newly-added watermark).
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=18').get()) {
      db.exec(`CREATE TABLE artwork_collections(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE TABLE artwork_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      db.prepare('INSERT INTO migrations VALUES(18)').run();
    }
    // Both teams' logo addresses per event (JSON), for an event channel's matchup logo.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=19').get()) {
      db.exec('ALTER TABLE sports_events ADD COLUMN logos TEXT');
      db.prepare('INSERT INTO migrations VALUES(19)').run();
    }
    // Streams reach public addresses only, unless an administrator allows a source's local-network streams.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=20').get()) {
      db.exec('ALTER TABLE iptv_sources ADD COLUMN allow_private_streams INTEGER NOT NULL DEFAULT 0');
      db.prepare('INSERT INTO migrations VALUES(20)').run();
    }
    // Event channels being watched past their window, and until when they stay on (SportsStore.hold).
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=21').get()) {
      db.exec('CREATE TABLE sports_holds(channel_id TEXT PRIMARY KEY, until INTEGER NOT NULL)');
      db.prepare('INSERT INTO migrations VALUES(21)').run();
    }
    // Refreshes and channel checks on a schedule (JSON, packages/contracts/src/schedule.ts); NULL is every interval_hours.
    if (!db.prepare('SELECT 1 FROM migrations WHERE version=22').get()) {
      db.exec('ALTER TABLE iptv_sources ADD COLUMN schedule TEXT; ALTER TABLE iptv_health_policies ADD COLUMN schedule TEXT');
      db.prepare('INSERT INTO migrations VALUES(22)').run();
    }
  })();
  return db;
}
export type Db = ReturnType<typeof openDatabase>;
export class SettingsStore {
  constructor(private db: Db) {}
  get() {
    const row = this.db.prepare('SELECT revision,value FROM settings WHERE id=1').get() as {revision: number; value: string};
    return { revision: row.revision, ...playbackSettings.parse(JSON.parse(row.value)) };
  }
  update(actor: string, expectedRevision: number, value: PlaybackSettings) {
    const valid = playbackSettings.parse(value);
    return this.db.transaction(() => {
      const result = this.db.prepare('UPDATE settings SET revision=revision+1,value=? WHERE id=1 AND revision=?').run(JSON.stringify(valid), expectedRevision);
      if (!result.changes) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'playback_settings_changed', Date.now(), JSON.stringify(valid));
      return this.get();
    })();
  }
}
