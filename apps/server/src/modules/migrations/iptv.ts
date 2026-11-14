import type Database from 'better-sqlite3';
import type { Migration } from '../../persistence/migrate.js';

const hasColumn = (db: Database.Database, table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);

// IPTV sources, channels, health, listing and Live Events (sports). Channel numbers are in the core lineup_numbers.
export const iptvMigrations: Migration[] = [
  { name: 'sources', legacy: 2, up: `CREATE TABLE IF NOT EXISTS iptv_sources(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('m3u','xmltv')), name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, interval_hours INTEGER NOT NULL CHECK(interval_hours BETWEEN 1 AND 168),
      auto_add INTEGER NOT NULL DEFAULT 0, encrypted_endpoint TEXT, encrypted_snapshot TEXT,
      encrypted_candidate TEXT, candidate_digest TEXT, last_attempt INTEGER, last_success INTEGER,
      next_due INTEGER, last_error TEXT, retry_after INTEGER);
      CREATE TABLE IF NOT EXISTS iptv_channels(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES iptv_sources(id),
      identity TEXT NOT NULL, encrypted_provider TEXT NOT NULL, approval TEXT NOT NULL CHECK(approval IN ('pending','approved','ignored')),
      present INTEGER NOT NULL, conflict INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,missing_since INTEGER,display_name TEXT,
      UNIQUE(source_id,identity));
      CREATE TABLE IF NOT EXISTS iptv_favorites(account_id TEXT NOT NULL REFERENCES users(account_id),channel_id TEXT NOT NULL REFERENCES iptv_channels(id),PRIMARY KEY(account_id,channel_id));
      CREATE TABLE IF NOT EXISTS iptv_mappings(channel_id TEXT NOT NULL REFERENCES iptv_channels(id),feed_id TEXT NOT NULL REFERENCES iptv_sources(id),value TEXT NOT NULL,PRIMARY KEY(channel_id,feed_id));
      CREATE TABLE IF NOT EXISTS iptv_source_feeds(source_id TEXT PRIMARY KEY REFERENCES iptv_sources(id),feed_id TEXT NOT NULL REFERENCES iptv_sources(id));` },
  // Channel health: machine-observed playability, separate from administrator curation.
  { name: 'channel-health', legacy: 3, up: `CREATE TABLE IF NOT EXISTS iptv_health_policies(source_id TEXT PRIMARY KEY REFERENCES iptv_sources(id),
      interval_hours INTEGER NOT NULL CHECK(interval_hours BETWEEN 0 AND 168), connections INTEGER NOT NULL CHECK(connections BETWEEN 1 AND 8), hide_failing INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS iptv_channel_health(channel_id TEXT PRIMARY KEY REFERENCES iptv_channels(id),
      status TEXT NOT NULL DEFAULT 'unchecked' CHECK(status IN ('unchecked','online','offline','placeholder')), reason TEXT, detail TEXT,
      fingerprint TEXT, frozen INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, last_online INTEGER, failures INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0, exempt INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS iptv_channel_health_due ON iptv_channel_health(due);
      CREATE TABLE IF NOT EXISTS iptv_offline_slates(source_id TEXT NOT NULL REFERENCES iptv_sources(id), fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(source_id,fingerprint));` },
  // Channel stacks: NULL groups automatically by station name, '' keeps a channel separate.
  { name: 'channel-stacks', legacy: 4, up: db => { if (!hasColumn(db, 'iptv_channels', 'stack_key')) db.exec('ALTER TABLE iptv_channels ADD COLUMN stack_key TEXT'); } },
  // Sports events: fetched schedules, and the window each channel of an event-driven source airs in.
  { name: 'sports', legacy: 5, up: `CREATE TABLE IF NOT EXISTS sports_policies(source_id TEXT PRIMARY KEY REFERENCES iptv_sources(id), enabled INTEGER NOT NULL, lead_minutes INTEGER NOT NULL CHECK(lead_minutes BETWEEN 0 AND 720));
      CREATE TABLE IF NOT EXISTS sports_events(id TEXT PRIMARY KEY, source TEXT NOT NULL, sport TEXT NOT NULL, league TEXT NOT NULL, title TEXT NOT NULL,
        start INTEGER NOT NULL, end INTEGER NOT NULL, state TEXT NOT NULL, time_known INTEGER NOT NULL, sides TEXT NOT NULL, abbreviations TEXT NOT NULL, ended_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sports_windows(channel_id TEXT PRIMARY KEY REFERENCES iptv_channels(id), source_id TEXT NOT NULL REFERENCES iptv_sources(id), event_id TEXT,
        title TEXT NOT NULL, league TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, visible_from INTEGER NOT NULL, visible_until INTEGER NOT NULL, state TEXT, matched_by TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sports_windows_source ON sports_windows(source_id);
      CREATE TABLE IF NOT EXISTS sports_admitted(channel_id TEXT PRIMARY KEY REFERENCES iptv_channels(id));` },
  // Feeds of one event share a guide row; matches without a scheduled event group by matchup.
  { name: 'sports-stacks', legacy: 6, up: db => { if (!hasColumn(db, 'sports_windows', 'stack_key')) db.exec('ALTER TABLE sports_windows ADD COLUMN stack_key TEXT'); } },
  // The sport an event channel carries, for its fallback icon.
  { name: 'sports-window-sport', legacy: 7, up: db => { if (!hasColumn(db, 'sports_windows', 'sport')) db.exec('ALTER TABLE sports_windows ADD COLUMN sport TEXT'); } },
  // Live Events settings: which leagues are shown and in what order, and the event channel number block.
  // Events and windows keep a stable league key; rows fetched before this get one on the next download.
  { name: 'sports-settings', legacy: 8, up: db => {
    for (const table of ['sports_events', 'sports_windows'])
      if (!hasColumn(db, table, 'league_key')) db.exec(`ALTER TABLE ${table} ADD COLUMN league_key TEXT`);
    db.exec('CREATE TABLE IF NOT EXISTS sports_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)');
  } },
  // Listing replaces approval: channels list themselves by per-source rules. `listing` is the administrator's override,
  // `event` and `guide_exempt` are derived from the channel's group and name. The old approval and enabled columns
  // are no longer read; ignored or disabled channels become hidden and health exemptions become "always list".
  { name: 'listing', legacy: 9, up: db => {
    if (!hasColumn(db, 'iptv_channels', 'listing')) {
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
  } },
  // The provider connection limit is server-wide; it starts from the highest per-source limit set before.
  // iptv_health_policies.connections is no longer read.
  { name: 'connection-limit', legacy: 10, up: db => {
    db.exec('CREATE TABLE IF NOT EXISTS iptv_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)');
    const { n } = db.prepare('SELECT MAX(connections) AS n FROM iptv_health_policies').get() as { n: number | null };
    db.prepare('INSERT OR IGNORE INTO iptv_settings VALUES(1,0,?)').run(JSON.stringify({ maxConnections: n ?? 1 }));
  } },
  // Sources are ordered by the administrator; the guide lists their channels in that order. Starts in creation order.
  { name: 'source-order', legacy: 11, up: 'ALTER TABLE iptv_sources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0; UPDATE iptv_sources SET sort_order=rowid;' },
  // League logos, kept on the server so event channels show them without reaching ESPN or TheSportsDB.
  { name: 'league-logos', legacy: 16, up: 'CREATE TABLE sports_league_logos(league_key TEXT PRIMARY KEY, url TEXT, type TEXT, bytes BLOB, checked_at INTEGER NOT NULL)' },
  // Both teams' logo addresses per event (JSON), for an event channel's matchup logo.
  { name: 'event-logos', legacy: 19, up: 'ALTER TABLE sports_events ADD COLUMN logos TEXT' },
  // Streams reach public addresses only, unless an administrator allows a source's local-network streams.
  { name: 'private-streams', legacy: 20, up: 'ALTER TABLE iptv_sources ADD COLUMN allow_private_streams INTEGER NOT NULL DEFAULT 0' },
  // Event channels being watched past their window, and until when they stay on (SportsStore.hold).
  { name: 'sports-holds', legacy: 21, up: 'CREATE TABLE sports_holds(channel_id TEXT PRIMARY KEY, until INTEGER NOT NULL)' },
  // Refreshes and channel checks on a schedule (JSON, packages/contracts/src/schedule.ts); NULL is every interval_hours.
  { name: 'schedules', legacy: 22, up: 'ALTER TABLE iptv_sources ADD COLUMN schedule TEXT; ALTER TABLE iptv_health_policies ADD COLUMN schedule TEXT' }
];
