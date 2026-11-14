import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../apps/server/src/lib/ttl-cache.js';
import { every } from '../apps/server/src/lib/every.js';

test('TtlCache keeps values until they expire and drops the oldest past its cap', () => {
  const cache = new TtlCache<number>(2);
  cache.set('a', 1, 100, 0); cache.set('b', 2, 100, 0);
  assert.equal(cache.get('a', 99), 1);
  assert.equal(cache.get('a', 100), undefined, 'expired at its time');
  cache.get('a', 50); cache.set('c', 3, 100, 50);
  assert.equal(cache.get('a', 50), undefined, 'a hit does not refresh age');
  assert.equal(cache.get('b', 50), 2);
  cache.set('b', 4, 100, 60); cache.set('d', 5, 100, 60);
  assert.equal(cache.get('c', 60), undefined, 'rewriting b made c the oldest');
  cache.prune(160); assert.equal(cache.size, 0);
});

test('TtlCache.remember shares one pending read and retries after a failure', async () => {
  const cache = new TtlCache<Promise<string>>(10);
  let reads = 0, fail = true;
  const read = () => { reads++; return fail ? Promise.reject(new Error('down')) : Promise.resolve('ok'); };
  const first = cache.remember('k', 1000, read, 0), second = cache.remember('k', 1000, read, 0);
  assert.equal(first, second);
  await assert.rejects(first, /down/);
  fail = false;
  assert.equal(await cache.remember('k', 1000, read, 1), 'ok');
  assert.equal(await cache.remember('k', 1000, read, 2), 'ok');
  assert.equal(reads, 2);
  cache.deleteWhere(key => key === 'k'); assert.equal(cache.get('k', 3), undefined);
});

test('every skips a run while the last is going and reports errors', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let runs = 0, finish = () => {};
    const errors: unknown[] = [];
    const task = every(10, () => { runs++; if (runs === 3) throw new Error('boom'); if (runs === 1) return new Promise<void>(done => { finish = done; }); }, e => errors.push(e));
    mock.timers.tick(10); mock.timers.tick(10);
    assert.equal(runs, 1, 'the second run waits for the first');
    finish(); await new Promise(setImmediate);
    mock.timers.tick(10); mock.timers.tick(10);
    assert.equal(runs, 3); assert.equal((errors[0] as Error).message, 'boom');
    task.stop(); mock.timers.tick(50); assert.equal(runs, 3);
  } finally { mock.timers.reset(); }
});
