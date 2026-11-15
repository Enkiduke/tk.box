import type { Migration } from '../../persistence/migrate.js';

// Alerts behind the bell (docs/NOTIFICATIONS.md). An 'account' row is one viewer's; an 'admins' row is shared by every
// admin, each with their own read and dismissed state in notification_reads. A row with a `key` and no `resolved_at` is
// an open condition: posting the same key again updates it instead of adding a row.
export const notificationsMigrations: Migration[] = [
  { name: 'notifications', up: `
    CREATE TABLE notifications(
      id INTEGER PRIMARY KEY,
      audience TEXT NOT NULL CHECK(audience IN ('account','admins')),
      account_id TEXT,
      kind TEXT NOT NULL,
      tone TEXT NOT NULL CHECK(tone IN ('success','info','warning','error')),
      title TEXT NOT NULL, detail TEXT, link TEXT,
      key TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER,
      CHECK((audience='account') = (account_id IS NOT NULL))
    );
    CREATE INDEX notifications_account ON notifications(account_id, updated_at) WHERE audience='account';
    CREATE INDEX notifications_admins ON notifications(updated_at) WHERE audience='admins';
    CREATE UNIQUE INDEX notifications_open ON notifications(audience, IFNULL(account_id,''), key) WHERE key IS NOT NULL AND resolved_at IS NULL;
    CREATE TABLE notification_reads(
      notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      read_at INTEGER, dismissed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(notification_id, account_id)
    );` }
];
