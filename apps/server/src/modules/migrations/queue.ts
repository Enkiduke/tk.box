import type { Migration } from '../../persistence/migrate.js';

// The durable work queue (docs/ARR-REPLACEMENT.md, "The job queue"): one table, many kinds, one open item per (kind, key).
export const queueMigrations: Migration[] = [
  { name: 'queue_items', up: `
    CREATE TABLE queue_items(
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed','cancelled')),
      run_at INTEGER NOT NULL,
      lease_until INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX queue_open ON queue_items(kind, key) WHERE state IN ('queued','running');
    CREATE INDEX queue_due ON queue_items(state, run_at);` }
];
