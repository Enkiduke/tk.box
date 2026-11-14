import type { Migration } from '../../persistence/migrate.js';

type Row = { value: string };
const table = (db: Parameters<Exclude<Migration['up'], string>>[0], name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// The Radarr and Sonarr connections, one row each. Radarr's address and key were part of Collections' settings and Sonarr's
// of Clean Up's; `connections` moves them here and takes them out of those. The sealed keys move as they are, so each
// row records the context its key was sealed with (`key_context`); a key saved here later is sealed as `arr:<name>-key`.
export const arrMigrations: Migration[] = [
  { name: 'connections', up: db => {
    db.exec(`CREATE TABLE arr_connections(name TEXT PRIMARY KEY CHECK(name IN ('radarr','sonarr')), revision INTEGER NOT NULL,
      url TEXT NOT NULL, sealed_key TEXT, key_context TEXT, CHECK((sealed_key IS NULL) = (key_context IS NULL)))`);
    const insert = db.prepare('INSERT INTO arr_connections VALUES(?,1,?,?,?)');
    if (table(db, 'artwork_collections')) {
      const row = db.prepare('SELECT value FROM artwork_collections WHERE id=1').get() as Row | undefined;
      if (row) {
        const { radarrKey, ...value } = JSON.parse(row.value) as { radarrKey?: string; radarr?: { url?: string } & Record<string, unknown> };
        const { url = '', ...radarr } = value.radarr ?? {};
        if (url || radarrKey) insert.run('radarr', url, radarrKey ?? null, radarrKey ? 'artwork:radarr-key' : null);
        if (value.radarr) db.prepare('UPDATE artwork_collections SET value=? WHERE id=1').run(JSON.stringify({ ...value, radarr }));
      }
    }
    if (table(db, 'cleanup_config')) {
      const row = db.prepare("SELECT value FROM cleanup_config WHERE name='connections'").get() as Row | undefined;
      if (row) {
        const { sonarrUrl = '', sonarrKey, ...rest } = JSON.parse(row.value) as { sonarrUrl?: string; sonarrKey?: string };
        if (sonarrUrl || sonarrKey) insert.run('sonarr', sonarrUrl, sonarrKey ?? null, sonarrKey ? 'cleanup:sonarr-key' : null);
        db.prepare("UPDATE cleanup_config SET value=? WHERE name='connections'").run(JSON.stringify(rest));
      }
    }
  } }
];
