import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { migrate } from '../apps/server/src/persistence/migrate.js';
import { moduleMigrations } from '../apps/server/src/modules/migrations/index.js';
import { defineModule, mountModule, type ModuleContext } from '../apps/server/src/modules/module.js';
import { EventBus } from '../apps/server/src/modules/bus.js';
import { watchHistoryModule } from '../apps/server/src/modules/watch-history.js';
import { customChannelsModule } from '../apps/server/src/modules/custom-channels.js';
import { iptvModule } from '../apps/server/src/modules/iptv.js';
import { arrModule } from '../apps/server/src/modules/arr.js';
import { artworkModule } from '../apps/server/src/modules/artwork.js';
import { requestsModule } from '../apps/server/src/modules/requests.js';
import { exploreModule } from '../apps/server/src/modules/explore.js';
import { cleanupModule } from '../apps/server/src/modules/cleanup.js';

const tables = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(r => r.name);

test('migrations run once each, in order, recorded per owner', () => {
  const db = openDatabase(':memory:'), ran: string[] = [];
  const list = [
    { name: 'a', up: 'CREATE TABLE a(x)' },
    { name: 'b', up: () => { ran.push('b'); } }
  ];
  migrate(db, 'one', list); migrate(db, 'one', list);
  assert.deepEqual(ran, ['b']);
  // The same name under another owner is a different migration.
  migrate(db, 'two', [{ name: 'b', up: () => { ran.push('two:b'); } }]);
  assert.deepEqual(ran, ['b', 'two:b']);
  migrate(db, 'one', [...list, { name: 'c', up: () => { ran.push('c'); } }]);
  assert.deepEqual(ran, ['b', 'two:b', 'c']);
});

test('a failing migration leaves none of its batch applied', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => migrate(db, 'bad', [{ name: 'ok', up: 'CREATE TABLE fine(x)' }, { name: 'broken', up: 'CREATE TABLE nope(' }]));
  assert.ok(!tables(db).includes('fine'));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE owner='bad'").get() as { n: number }).n, 0);
});

test('a change the old numbered list recorded is marked applied without running', () => {
  const db = openDatabase(':memory:'), ran: string[] = [];
  db.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(7)');
  migrate(db, 'm', [{ name: 'old', legacy: 7, up: () => { ran.push('old'); } }, { name: 'newer', legacy: 8, up: () => { ran.push('newer'); } }]);
  assert.deepEqual(ran, ['newer']);
  assert.deepEqual((db.prepare("SELECT name FROM schema_migrations WHERE owner='m' ORDER BY name").all() as { name: string }[]).map(r => r.name), ['newer', 'old']);
});

test('duplicate migration names are refused', () => {
  assert.throws(() => migrate(openDatabase(':memory:'), 'd', [{ name: 'x', up: '' }, { name: 'x', up: '' }]), /listed twice/);
});

test('mountModule applies the module migrations before setup', async () => {
  const db = openDatabase(':memory:'), ctx = { db, bus: new EventBus() } as unknown as ModuleContext;
  let seen: string[] = [];
  const module = defineModule({ name: 'things', migrations: [{ name: 'things', up: 'CREATE TABLE things(x)' }], setup() { seen = tables(db); return { api: {} }; } });
  await mountModule(Fastify(), ctx, module, undefined);
  assert.ok(seen.includes('things'));
});

test('the migration registry matches the modules that own tables', () => {
  const owners = [watchHistoryModule, customChannelsModule, iptvModule, arrModule, artworkModule, requestsModule, exploreModule, cleanupModule];
  assert.deepEqual(Object.keys(moduleMigrations), owners.map(m => m.name));
  for (const m of owners) assert.equal(moduleMigrations[m.name], m.migrations, m.name);
});
