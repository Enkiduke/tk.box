import type { Migration } from '../../persistence/migrate.js';

// CleanupStore created these on every start before migrations were per module, so they keep IF NOT EXISTS.
export const cleanupMigrations: Migration[] = [
  { name: 'config-jobs', up: `CREATE TABLE IF NOT EXISTS cleanup_config(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, args TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, exit_code INTEGER, output TEXT);` },
  // Remove from Seerr went with Seerr: tk.box marks a deleted title's requests removed itself.
  { name: 'drop-seerr', up: `UPDATE cleanup_config SET value=json_remove(value,'$.deleteFromSeerr') WHERE name='settings'` },
  // The watch dates Tautulli held, saved once (Save watch history) so they outlast it. Account '' is anyone.
  { name: 'watch-snapshot', up: `CREATE TABLE cleanup_watch_snapshot(scope TEXT NOT NULL CHECK(scope IN ('movie','show','season')), rating_key TEXT NOT NULL,
        account TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(scope, rating_key, account)) WITHOUT ROWID` }
];
