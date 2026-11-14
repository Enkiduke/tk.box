import type { Migration } from '../../persistence/migrate.js';

export const artworkMigrations: Migration[] = [
  // The engine's settings and layouts, which tk.box writes out as its config for each run, and the history of its jobs.
  // Provider keys inside the settings are sealed.
  { name: 'settings-layouts-jobs', legacy: 17, up: `CREATE TABLE artwork_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE TABLE artwork_layouts(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE artwork_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, args TEXT NOT NULL, actor TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')), created_at INTEGER NOT NULL,
          started_at INTEGER, finished_at INTEGER, exit_code INTEGER, output TEXT NOT NULL DEFAULT '');` },
  // Collections (custom and seasonal definitions, franchise sync and Radarr), and small values the artwork schedules
  // keep between runs (last runs, the newly-added watermark).
  { name: 'collections-state', legacy: 18, up: `CREATE TABLE artwork_collections(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE TABLE artwork_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);` }
];
