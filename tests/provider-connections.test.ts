import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderConnections } from '../apps/server/src/streaming/provider-connections.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { IptvSettingsStore } from '../apps/server/src/persistence/iptv-settings.js';
import { Vault } from '../apps/server/src/security/vault.js';

const tick = () => new Promise(done => setImmediate(done));

test('Viewers and checks never exceed the server-wide limit, and viewers come first', async () => {
  let limit = 2;
  const gate = new ProviderConnections(() => limit, 1000), cancelled: string[] = [];
  const a = gate.tryCheck(() => cancelled.push('a'))!, b = gate.tryCheck(() => cancelled.push('b'))!;
  assert.ok(a && b); assert.equal(gate.tryCheck(() => {}), undefined, 'checks stop at the limit');

  // A viewer cancels one check and waits until that check has actually let go.
  let granted = false;
  const first = gate.viewer().then(lease => { granted = true; return lease; });
  await tick(); assert.deepEqual(cancelled, ['a']); assert.equal(granted, false);
  assert.equal(gate.tryCheck(() => {}), undefined, 'no new check while a viewer waits');
  a.release(); const one = await first; assert.equal(granted, true);
  assert.deepEqual(gate.usage(), { limit: 2, viewers: 1, checks: 1 });

  // The second viewer takes the last check's connection.
  const second = gate.viewer(); await tick(); assert.deepEqual(cancelled, ['a', 'b']);
  b.release(); const two = await second;

  // Viewers never displace each other.
  await assert.rejects(gate.viewer(), { code: 'LIVE_CONNECTIONS_FULL' });
  // A stopping relay still holds its connection until FFmpeg exits; the next viewer waits for it.
  two.closing();
  const third = gate.viewer(); await tick();
  assert.deepEqual(gate.usage(), { limit: 2, viewers: 2, checks: 0 });
  two.release(); const three = await third;
  assert.deepEqual(gate.usage(), { limit: 2, viewers: 2, checks: 0 });

  // Lowering the limit keeps current viewers but admits no one new.
  limit = 1; one.release();
  await assert.rejects(gate.viewer(), { code: 'LIVE_CONNECTIONS_FULL' });
  assert.equal(gate.tryCheck(() => {}), undefined);
  three.release(); assert.ok(gate.tryCheck(() => {}));
});

test('A waiting viewer gives up when cancelled or when the connection never frees', async () => {
  const gate = new ProviderConnections(() => 1, 50);
  const check = gate.tryCheck(() => {})!;
  const abort = new AbortController(), waiting = gate.viewer(abort.signal);
  abort.abort(); await assert.rejects(waiting, { code: 'MEDIA_CANCELLED' });
  await assert.rejects(gate.viewer(), { code: 'LIVE_CONNECTIONS_BUSY' });
  check.release();
  assert.deepEqual(gate.usage(), { limit: 1, viewers: 0, checks: 0 });
  (await gate.viewer()).release();
});

test('The server-wide limit starts from the highest per-source limit set before it existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-iptv-settings-')), file = join(dir, 'db.sqlite');
  let db = openDatabase(file);
  const store = new IptvStore(db, new Vault(randomBytes(32))), a = store.create('owner', { kind: 'm3u', name: 'A' }), b = store.create('owner', { kind: 'm3u', name: 'B' });
  db.prepare('INSERT INTO iptv_health_policies VALUES(?,24,2,1),(?,24,3,1)').run(a.id, b.id);
  db.exec('DROP TABLE iptv_settings; DELETE FROM migrations WHERE version=10'); db.close();
  db = openDatabase(file);
  try {
    const settings = new IptvSettingsStore(db);
    assert.equal(settings.get().maxConnections, 3);
    assert.equal(settings.update('owner', 0, { maxConnections: 2 }).maxConnections, 2);
    assert.throws(() => settings.update('owner', 0, { maxConnections: 4 }), { code: 'REVISION_CONFLICT' });
    assert.throws(() => settings.update('owner', 1, { maxConnections: 0 }));
  } finally { db.close(); }
});
