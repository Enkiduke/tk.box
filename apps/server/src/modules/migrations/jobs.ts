import type { Migration } from '../../persistence/migrate.js';

// Admin › Schedule's own settings: the time zone every schedule runs in.
export const jobsMigrations: Migration[] = [
  { name: 'settings', up: `CREATE TABLE jobs_settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)` },
];
