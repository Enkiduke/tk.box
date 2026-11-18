import type { Migration } from '../../persistence/migrate.js';

// Requests made in tk.box (docs/REQUESTS.md). A row is its own outbox: `queued` until the library took it, then
// its status follows the library and Plex. Several rows may name one title (other people, other seasons).
export const requestsMigrations: Migration[] = [
  { name: 'requests', up: `
    CREATE TABLE requests(
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('movie','show')),
      tmdb_id INTEGER NOT NULL CHECK(tmdb_id > 0), tvdb_id INTEGER, title TEXT NOT NULL, year INTEGER,
      account_id TEXT, account_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','requested','downloading','partial','available','failed','removed')),
      status_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 1,
      profile_id INTEGER, root_folder TEXT, tags TEXT NOT NULL DEFAULT '[]',
      monitor_future INTEGER NOT NULL DEFAULT 0,
      arr_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
      available_at INTEGER,
      removed_at INTEGER, removed_by TEXT,
      seerr_id INTEGER UNIQUE
    );
    CREATE INDEX requests_title ON requests(kind, tmdb_id);
    CREATE INDEX requests_account ON requests(account_id, created_at);
    CREATE INDEX requests_open ON requests(status) WHERE status IN ('queued','requested','downloading','partial');
    CREATE TABLE request_seasons(
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      season INTEGER NOT NULL CHECK(season > 0),
      available_at INTEGER,
      PRIMARY KEY(request_id, season)
    );
    CREATE TABLE requests_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);` },
  // Admin › Requests › Requests site: its port (none: off) and public address.
  { name: 'requests_site', up: `
    CREATE TABLE requests_site(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, port INTEGER, public_url TEXT);` },
  // Phase D (docs/SINGLE-SOURCE.md): `arr_id` was always a library_titles id, and `removed_by='arr'` meant removed in
  // the library. Keep (tag -1) and a movie's Early copies (tag -2) become the request's own flags, out of its tags.
  { name: 'title-id', up: `
    ALTER TABLE requests RENAME COLUMN arr_id TO title_id;
    UPDATE requests SET removed_by='library' WHERE removed_by='arr';
    ALTER TABLE requests ADD COLUMN keep INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE requests ADD COLUMN early_copies INTEGER NOT NULL DEFAULT 0;
    UPDATE requests SET keep=1 WHERE EXISTS (SELECT 1 FROM json_each(requests.tags) WHERE value=-1);
    UPDATE requests SET early_copies=1 WHERE kind='movie' AND EXISTS (SELECT 1 FROM json_each(requests.tags) WHERE value=-2);
    UPDATE requests SET tags=(SELECT json_group_array(value) FROM json_each(requests.tags) WHERE value >= 0) WHERE EXISTS (SELECT 1 FROM json_each(requests.tags) WHERE value < 0);
    CREATE INDEX requests_title_id ON requests(title_id) WHERE title_id IS NOT NULL;` }
];
