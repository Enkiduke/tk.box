import type { Migration } from '../../persistence/migrate.js';

// Custom channels and their schedules. Channel numbers are in the core lineup_numbers.
export const customChannelsMigrations: Migration[] = [
  // Published schedules (ChannelScheduler).
  { name: 'schedules', legacy: 1, up: `CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publications(id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), revision INTEGER NOT NULL,
        effective_at INTEGER NOT NULL, superseded INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL, UNIQUE(channel_id,revision));` },
  // Administrator-made program lists of Plex media. `draft` is the editable list and `published` the list as last
  // published (before the scheduler rotates it). Sources record each show or season added, for automatic new episodes.
  { name: 'channels', legacy: 12, up: `CREATE TABLE custom_channels(id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', logo_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
          draft TEXT NOT NULL DEFAULT '[]', published TEXT);
        CREATE TABLE custom_sources(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES custom_channels(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('show','season')), plex_id TEXT NOT NULL, title TEXT NOT NULL, specials INTEGER NOT NULL DEFAULT 0,
          auto_add INTEGER NOT NULL DEFAULT 0, last_checked INTEGER, last_result TEXT, last_error TEXT, UNIQUE(channel_id,kind,plex_id));
        CREATE TABLE custom_favorites(account_id TEXT NOT NULL REFERENCES users(account_id), channel_id TEXT NOT NULL REFERENCES custom_channels(id) ON DELETE CASCADE,
          PRIMARY KEY(account_id,channel_id));` },
  // Automatic new episodes: each show or season selection remembers every episode it has seen, so an episode the
  // administrator removed is never re-added. `seeded` marks sources whose seen set is complete (older ones are
  // seeded from Plex, adding nothing, the first time they are checked).
  { name: 'seen-episodes', legacy: 13, up: `ALTER TABLE custom_sources ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE custom_source_episodes(source_id TEXT NOT NULL REFERENCES custom_sources(id) ON DELETE CASCADE, plex_id TEXT NOT NULL, PRIMARY KEY(source_id,plex_id));` },
  // Collections and categories (Plex genres) become channel sources too. SQLite can't widen a CHECK in place, so the
  // table is rebuilt; the seen-episode rows are copied aside first because dropping a parent would cascade them away.
  { name: 'collection-genre-sources', legacy: 14, up: `CREATE TEMP TABLE seen_backup AS SELECT * FROM custom_source_episodes;
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
        DROP TABLE seen_backup;` },
  // Which Plex title's logo a custom channel uses when it has no logo address: NULL picks its main show, 'none' turns it off.
  { name: 'plex-logo', legacy: 15, up: 'ALTER TABLE custom_channels ADD COLUMN plex_logo TEXT' }
];
