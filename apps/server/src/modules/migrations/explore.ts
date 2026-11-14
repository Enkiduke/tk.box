import type { Migration } from '../../persistence/migrate.js';

// ExploreStore created these on every start before migrations were per module, so they keep IF NOT EXISTS.
export const exploreMigrations: Migration[] = [
  { name: 'settings-layout', up: `CREATE TABLE IF NOT EXISTS explore_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS explore_layout(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);` },
  // Trakt was removed: its links and saved client keys go.
  { name: 'drop-trakt', up: `DROP TABLE IF EXISTS explore_trakt_links;
      UPDATE explore_settings SET value=json_remove(value,'$.traktClientId','$.traktSecret') WHERE json_type(value,'$.traktClientId') IS NOT NULL OR json_type(value,'$.traktSecret') IS NOT NULL;` }
];
