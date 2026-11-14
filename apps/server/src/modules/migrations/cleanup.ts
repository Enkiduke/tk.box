import type { Migration } from '../../persistence/migrate.js';

// CleanupStore created these on every start before migrations were per module, so they keep IF NOT EXISTS.
export const cleanupMigrations: Migration[] = [
  { name: 'config-jobs', up: `CREATE TABLE IF NOT EXISTS cleanup_config(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, args TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, exit_code INTEGER, output TEXT);` }
];
