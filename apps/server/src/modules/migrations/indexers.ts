import type { Migration } from '../../persistence/migrate.js';

// NZBGeek and IPTorrents (docs/ARR-REPLACEMENT.md, "Data model" › indexers). Secrets are sealed with the vault.
// rss_seen is pruned after 14 days.
export const indexersMigrations: Migration[] = [
  { name: 'indexers', up: `
    CREATE TABLE indexers(
      name TEXT PRIMARY KEY CHECK(name IN ('nzbgeek','iptorrents')),
      enabled INTEGER NOT NULL DEFAULT 0,
      sealed_secret TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      last_ok_at INTEGER, last_error TEXT, paused_until INTEGER
    );
    CREATE TABLE indexer_usage(indexer TEXT NOT NULL, day TEXT NOT NULL, searches INTEGER NOT NULL DEFAULT 0,
      grabs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(indexer, day));
    CREATE TABLE rss_seen(indexer TEXT NOT NULL, guid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(indexer, guid));` }
];
