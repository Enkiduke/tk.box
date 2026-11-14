import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { migrate } from '../apps/server/src/persistence/migrate.js';
import { moduleMigrations } from '../apps/server/src/modules/migrations/index.js';
import { ArrStore } from '../apps/server/src/persistence/arr-store.js';
import { ArtworkStore } from '../apps/server/src/persistence/artwork-store.js';
import { CleanupStore } from '../apps/server/src/persistence/cleanup-store.js';
import { Vault } from '../apps/server/src/security/vault.js';

const value = (db: ReturnType<typeof openDatabase>, sql: string) => JSON.parse((db.prepare(sql).get() as { value: string }).value) as Record<string, unknown>;

test('the connections migration moves Radarr out of Collections and Sonarr out of Clean Up, keys still opening', () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  migrate(db, 'artwork', moduleMigrations.artwork!); migrate(db, 'cleanup', moduleMigrations.cleanup!);
  db.prepare('INSERT INTO artwork_collections VALUES(1,4,?)').run(JSON.stringify({ definitions: null, automatic: [], franchise: {}, schedules: {},
    radarr: { url: 'http://radarr:7878', rootFolder: '/movies', qualityProfileId: 4, search: true }, radarrKey: vault.seal('radarr-key', 'artwork:radarr-key') }));
  db.prepare("INSERT INTO cleanup_config VALUES('connections',2,?)").run(JSON.stringify({ tautulliUrl: 'http://tautulli:8181', tautulliKey: vault.seal('tautulli-key', 'cleanup:tautulli-key'),
    sonarrUrl: 'http://sonarr:8989', sonarrKey: vault.seal('sonarr-key', 'cleanup:sonarr-key') }));
  migrate(db, 'arr', moduleMigrations.arr!);
  const arr = new ArrStore(db, vault);
  assert.deepEqual(arr.connection('radarr'), { url: 'http://radarr:7878', key: 'radarr-key' });
  assert.deepEqual(arr.connection('sonarr'), { url: 'http://sonarr:8989', key: 'sonarr-key' });
  const collections = value(db, 'SELECT value FROM artwork_collections');
  assert.deepEqual(collections.radarr, { rootFolder: '/movies', qualityProfileId: 4, search: true });
  assert.equal('radarrKey' in collections, false);
  assert.equal(new ArtworkStore(db, vault, 'apps/artwork/defaults.json').collections().revision, 4);
  assert.deepEqual(Object.keys(value(db, "SELECT value FROM cleanup_config WHERE name='connections'")).sort(), ['tautulliKey', 'tautulliUrl']);
  assert.deepEqual(new CleanupStore(db, vault).connections(), { tautulliUrl: 'http://tautulli:8181', tautulliKey: 'tautulli-key' });
  // A key saved later is sealed under the arr module's own context; leaving the key out keeps the moved one.
  arr.update('admin', 'sonarr', 1, { url: 'http://sonarr.lan:8989/' });
  assert.deepEqual(arr.connection('sonarr'), { url: 'http://sonarr.lan:8989', key: 'sonarr-key' });
  assert.deepEqual(arr.update('admin', 'radarr', 1, { url: 'http://radarr:7878', key: 'new-key' }), { revision: 2, url: 'http://radarr:7878', keySet: true });
  assert.equal((db.prepare("SELECT key_context FROM arr_connections WHERE name='radarr'").get() as { key_context: string }).key_context, 'arr:radarr-key');
  assert.deepEqual(arr.connection('radarr'), { url: 'http://radarr:7878', key: 'new-key' });
  assert.deepEqual(arr.update('admin', 'radarr', 2, { url: '', key: '' }), { revision: 3, url: '', keySet: false });
  assert.throws(() => arr.update('admin', 'radarr', 2, { url: '' }), { code: 'REVISION_CONFLICT' });
});

test('a new database has no connections and nothing to move', () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  migrate(db, 'arr', moduleMigrations.arr!);
  for (const [owner, list] of Object.entries(moduleMigrations)) migrate(db, owner, list);
  const arr = new ArrStore(db, vault);
  assert.deepEqual(arr.connection('radarr'), { url: '' });
  assert.deepEqual(arr.view(), { radarr: { revision: 0, url: '', keySet: false }, sonarr: { revision: 0, url: '', keySet: false } });
  assert.throws(() => arr.update('admin', 'sonarr', 0, { url: 'ftp://sonarr' }));
});
