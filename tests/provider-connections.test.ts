import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderConnections } from '../apps/server/src/streaming/provider-connections.js';

const tick = () => new Promise(done => setImmediate(done));

test('Viewers and checks never exceed a source limit, and viewers come first', async () => {
  let limit = 2;
  const gate = new ProviderConnections(() => limit, 1000), cancelled: string[] = [];
  const a = gate.tryCheck('s', () => cancelled.push('a'))!, b = gate.tryCheck('s', () => cancelled.push('b'))!;
  assert.ok(a && b); assert.equal(gate.tryCheck('s', () => {}), undefined, 'checks stop at the limit');
  assert.ok(gate.tryCheck('other', () => {}), 'limits are per source');

  // A viewer cancels one check and waits until that check has actually let go.
  let granted = false;
  const first = gate.viewer('s').then(lease => { granted = true; return lease; });
  await tick(); assert.deepEqual(cancelled, ['a']); assert.equal(granted, false);
  assert.equal(gate.tryCheck('s', () => {}), undefined, 'no new check while a viewer waits');
  a.release(); const one = await first; assert.equal(granted, true);
  assert.deepEqual(gate.usage('s'), { limit: 2, viewers: 1, checks: 1 });

  // The second viewer takes the last check's connection.
  const second = gate.viewer('s'); await tick(); assert.deepEqual(cancelled, ['a', 'b']);
  b.release(); const two = await second;

  // Viewers never displace each other.
  await assert.rejects(gate.viewer('s'), { code: 'LIVE_CONNECTIONS_FULL' });
  // A stopping relay still holds its connection until FFmpeg exits; the next viewer waits for it.
  two.closing();
  const third = gate.viewer('s'); await tick();
  assert.deepEqual(gate.usage('s'), { limit: 2, viewers: 2, checks: 0 });
  two.release(); const three = await third;
  assert.deepEqual(gate.usage('s'), { limit: 2, viewers: 2, checks: 0 });

  // Lowering the limit keeps current viewers but admits no one new.
  limit = 1; one.release();
  await assert.rejects(gate.viewer('s'), { code: 'LIVE_CONNECTIONS_FULL' });
  assert.equal(gate.tryCheck('s', () => {}), undefined);
  three.release(); assert.ok(gate.tryCheck('s', () => {}));
});

test('A waiting viewer gives up when cancelled or when the connection never frees', async () => {
  const gate = new ProviderConnections(() => 1, 50);
  const check = gate.tryCheck('s', () => {})!;
  const abort = new AbortController(), waiting = gate.viewer('s', abort.signal);
  abort.abort(); await assert.rejects(waiting, { code: 'MEDIA_CANCELLED' });
  await assert.rejects(gate.viewer('s'), { code: 'LIVE_CONNECTIONS_BUSY' });
  check.release();
  assert.deepEqual(gate.usage('s'), { limit: 1, viewers: 0, checks: 0 });
  (await gate.viewer('s')).release();
});
