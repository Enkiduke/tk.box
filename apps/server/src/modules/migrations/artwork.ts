import type { Migration } from '../../persistence/migrate.js';

export const artworkMigrations: Migration[] = [
  // The engine's settings and layouts, which tk.box writes out as its config for each run, and the history of its jobs.
  // Provider keys inside the settings are sealed.
  { name: 'settings-layouts-jobs', legacy: 17, up: `CREATE TABLE artwork_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE TABLE artwork_layouts(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE artwork_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, args TEXT NOT NULL, actor TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')), created_at INTEGER NOT NULL,
          started_at INTEGER, finished_at INTEGER, exit_code INTEGER, output TEXT NOT NULL DEFAULT '');` },
  // Collections (custom and seasonal definitions, franchise sync and acquiring), and small values the artwork schedules
  // keep between runs (last runs, the newly-added watermark).
  { name: 'collections-state', legacy: 18, up: `CREATE TABLE artwork_collections(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE TABLE artwork_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);` },
  // The provider keys (TMDB, TVDB, Fanart.tv, MDBList) move to Admin › Connections' service keys
  // (persistence/service-keys.ts), each sealed again under that store's context; TMDB is shared by the library, requests,
  // Explore, the calendar and Artwork. A key already saved there is kept. The settings' revision is kept, since none of
  // Artwork's own settings changed.
  { name: 'provider-keys-to-service-keys', up: (db, { vault }) => {
    const row = db.prepare('SELECT value FROM artwork_settings WHERE id=1').get() as { value: string } | undefined;
    const value = row && JSON.parse(row.value) as { keys?: Record<string, string> };
    if (!value?.keys) return;
    const keys = Object.entries(value.keys).filter(([name, sealed]) => ['tmdb', 'tvdb', 'fanart', 'mdblist'].includes(name) && sealed);
    if (keys.length && !vault) throw new Error('Moving the provider keys needs the encryption key.');
    for (const [name, sealed] of keys)
      db.prepare('INSERT INTO service_keys VALUES(?,?) ON CONFLICT(name) DO NOTHING').run(name, vault!.seal(vault!.open(sealed, `artwork:${name}-key`), `service-key:${name}`));
    delete value.keys;
    db.prepare('UPDATE artwork_settings SET value=? WHERE id=1').run(JSON.stringify(value));
  } }
];
