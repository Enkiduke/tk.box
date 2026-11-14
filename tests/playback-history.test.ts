import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { HistoryStore } from '../apps/server/src/persistence/history-store.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { digest, Vault } from '../apps/server/src/security/vault.js';
import { IdentityService } from '../apps/server/src/services/identity.js';
import { PlaybackHistory } from '../apps/server/src/services/playback-history.js';
import { viewedAirings } from '../apps/server/src/services/custom-tv.js';
import type { Segment } from '../apps/server/src/streaming/buffer.js';
import type { PlaybackObservation } from '../packages/contracts/src/index.js';
import { config, fakePlex } from './fixtures.js';

const delivery = {
  id: 'first', owner: 'signed-in-session', accountId: '2', client: 'Chrome · Windows',
  media: { serverId: 'plex', ratingKey: '42', libraryId: '10', title: 'Fixture movie', type: 'movie' as const, durationMs: 600000 },
  stream: { delivery: 'direct' as const }
};
const sample = (sequence: number, elapsedMs: number, positionMs: number, state: PlaybackObservation['state'] = 'playing', rate = 1) =>
  ({ sequence, elapsedMs, positionMs, state, rate });
const sessions = (db: ReturnType<typeof openDatabase>) => db.prepare(
  'SELECT generation,started_at,observed_at,ended_at,end_reason,watch_ms FROM history_sessions ORDER BY started_at'
).all();

test('Custom Channel allocations follow displayed segments across airings, pauses and Go Live', () => {
  const db = openDatabase(':memory:'), history = new PlaybackHistory(new HistoryStore(db));
  const now = new Date(2026, 10, 15, 12).getTime(), delayed = now - 120000;
  const segment = (sequence: number, airingId: string, start: number, end: number): Segment =>
    ({ id: String(sequence), uri: String(sequence), airingId, start, end, sequence, bytes: 1, programId: '10', revision: 0, discontinuity: false });
  const segments = [segment(0, 'a', delayed, delayed + 6000), segment(1, 'b', delayed + 6000, delayed + 15000),
    segment(2, 'slate', delayed + 15000, delayed + 20000), segment(3, 'c', now + 60000, now + 70000)];
  const airings = [
    { id: 'a', start: delayed, mediaStartMs: 0, subtitles: [], media: delivery.media },
    { id: 'b', start: delayed + 6000, mediaStartMs: 0, subtitles: [], media: { ...delivery.media, ratingKey: '43' }, delivery: 'transcode' as const },
    { id: 'c', start: now + 60000, mediaStartMs: 0, subtitles: [], media: { ...delivery.media, ratingKey: '44' } }
  ];
  const report = (sequence: number, elapsedMs: number, positionMs: number, at: number, state: PlaybackObservation['state'] = 'playing', epoch = 0) =>
    history.observe('first', delivery.owner, { ...sample(sequence, elapsedMs, positionMs, state), presentationUtc: at }, now + elapsedMs,
      { epoch, airings: (from, to) => viewedAirings(segments, airings, from, to) });
  try {
    history.open({ ...delivery, media: { type: 'channel', serverId: 'custom', ratingKey: 'station', title: 'Station', number: 7 } }, undefined, now);
    report(1, 0, 0, delayed);
    report(2, 10000, 10000, delayed + 10000, 'paused');
    report(3, 60000, 10000, delayed + 10000, 'paused');
    report(4, 61000, 10000, delayed + 10000);
    report(5, 67000, 16000, delayed + 16000);
    history.suspend('first', delivery.owner);
    report(1, 68000, 0, now + 60000, 'playing', 1);
    report(6, 69000, 18000, delayed + 18000);
    report(2, 71000, 3000, now + 63000, 'stopped', 1);
    history.tick(now + 71000);
    assert.deepEqual(db.prepare('SELECT source,watch_ms FROM history_sessions').get(), { source: 'custom', watch_ms: 19000 });
    assert.deepEqual(db.prepare('SELECT airing_id,watch_ms FROM history_live_allocations ORDER BY airing_id').all(), [
      { airing_id: '', watch_ms: 1000 }, { airing_id: 'a', watch_ms: 6000 }, { airing_id: 'b', watch_ms: 9000 }, { airing_id: 'c', watch_ms: 3000 }
    ]);
    assert.deepEqual(db.prepare('SELECT SUM(transcode_ms) AS converted FROM history_days').get(), { converted: 9000 });
  } finally { history.close(); db.close(); }
});

test('IPTV keeps one view for verified feed failover and starts another for a new station', () => {
  const db = openDatabase(':memory:'), history = new PlaybackHistory(new HistoryStore(db));
  const now = new Date(2026, 10, 15, 12).getTime();
  const feed = (id: string) => ({ ...delivery, id, media: { type: 'channel' as const, serverId: 'iptv' as const, ratingKey: id, title: id, number: 2 } });
  const guide = { id: 'guide-event', start: now - 60000, end: now + 60000, guide: { title: 'Recorded guide title', estimated: true as const } };
  const sameStation = (from: string, to: string) => from === 'primary' && to === 'backup';
  const watch = (id: string, start: number, end: number, withGuide: boolean) => {
    const live = { epoch: 0, airings: () => withGuide ? [guide] : [] };
    history.observe(id, delivery.owner, { ...sample(1, 0, 0), presentationUtc: now + start }, now + start, live);
    history.observe(id, delivery.owner, { ...sample(2, end - start, end - start), presentationUtc: now + end }, now + end, live);
  };
  try {
    history.open(feed('primary'), undefined, now);
    watch('primary', 0, 2500, true);
    history.end('primary', 'replacing', now + 3000);
    history.open(feed('backup'), 'primary', now + 4000, sameStation);
    watch('backup', 4000, 7000, false);
    history.open(feed('different'), 'backup', now + 8000, sameStation);
    watch('different', 8000, 9000, false);
    history.tick(now + 10000);
    assert.deepEqual(db.prepare('SELECT watch_ms FROM history_sessions ORDER BY started_at').all(), [{ watch_ms: 5500 }, { watch_ms: 1000 }]);
    const rows = db.prepare('SELECT feed_id,airing_id,details,watch_ms FROM history_live_allocations ORDER BY feed_id').all() as
      { feed_id: string; airing_id: string; details: string | null; watch_ms: number }[];
    assert.deepEqual(rows.map(({ details: _, ...row }) => row), [
      { feed_id: 'backup', airing_id: '', watch_ms: 3000 }, { feed_id: 'different', airing_id: '', watch_ms: 1000 },
      { feed_id: 'primary', airing_id: 'guide-event', watch_ms: 2500 }
    ]);
    assert.deepEqual(JSON.parse(rows.at(-1)!.details!).guide, guide.guide);
  } finally { history.close(); db.close(); }
});

test('VOD history only credits advancing playback and splits it at server midnight', () => {
  const db = openDatabase(':memory:'), history = new PlaybackHistory(new HistoryStore(db));
  const start = new Date(2026, 10, 14, 23, 59, 55).getTime();
  const observe = (value: PlaybackObservation) => history.observe('first', delivery.owner, value, start + value.elapsedMs);
  try {
    history.open(delivery, undefined, start);
    observe(sample(1, 0, 42000));
    history.tick(start);
    assert.deepEqual(sessions(db), []);
    observe(sample(2, 8000, 50000, 'buffering'));
    observe(sample(3, 14000, 50000));
    observe(sample(4, 17000, 53000, 'paused'));
    observe(sample(5, 77000, 53000, 'paused'));
    observe(sample(6, 80000, 53000));
    observe(sample(7, 83000, 200000, 'seeking'));
    observe(sample(8, 85000, 200000, 'playing', 2));
    observe(sample(9, 87000, 204000, 'playing', 2));
    observe(sample(9, 87000, 205000, 'playing', 2));
    observe(sample(10, 92000, 204000, 'ended', 2));
    history.tick(start + 92000);
    assert.deepEqual(sessions(db), [{ generation: digest('first'), started_at: start, observed_at: start + 87000,
      ended_at: start + 87000, end_reason: 'ended', watch_ms: 13000 }]);
    assert.deepEqual(db.prepare('SELECT day,direct_ms FROM history_days ORDER BY day').all(), [
      { day: '2026-11-14', direct_ms: 5000 }, { day: '2026-11-15', direct_ms: 8000 }
    ]);
  } finally { history.close(); db.close(); }
});

test('VOD replacement preserves one view across release and restart without crediting downtime', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tkbox-history-'));
  const db = openDatabase(join(directory, 'history.sqlite')), store = new HistoryStore(db);
  const start = Date.now() - 100000;
  const first = new PlaybackHistory(store), second = new PlaybackHistory(store);
  try {
    first.open(delivery, undefined, start);
    first.observe('first', delivery.owner, sample(1, 0, 0), start);
    first.observe('first', delivery.owner, sample(2, 5000, 5000), start + 5000);
    first.end('first', 'replacing', start + 6000);
    first.open({ ...delivery, id: 'second', stream: { delivery: 'transcode' } }, 'first', start + 7000);
    first.observe('first', delivery.owner, sample(3, 8000, 8000, 'stopped'), start + 8000);
    first.observe('second', delivery.owner, sample(1, 0, 6000), start + 12000);
    first.observe('second', delivery.owner, sample(2, 4000, 10000), start + 16000);
    first.tick(start + 16000);
    assert.equal((sessions(db)[0] as {watch_ms: number}).watch_ms, 9000);
    store.close();
    second.tick(start + 100000);
    assert.equal((sessions(db)[0] as {end_reason: string}).end_reason, 'interrupted');
    second.open({ ...delivery, id: 'third' }, 'second', start + 101000);
    second.observe('third', delivery.owner, sample(1, 0, 10000), start + 102000);
    second.observe('third', delivery.owner, sample(2, 1000, 11000, 'stopped'), start + 103000);
    second.tick(start + 103000);
    assert.deepEqual(sessions(db), [{ generation: digest('third'), started_at: start, observed_at: start + 103000,
      ended_at: start + 103000, end_reason: 'stopped', watch_ms: 10000 }]);
    assert.deepEqual(db.prepare('SELECT SUM(direct_ms) AS direct,SUM(transcode_ms) AS transcode FROM history_days').get(),
      { direct: 6000, transcode: 4000 });
  } finally {
    first.close(); second.close(); store.close(); db.close();
    rmSync(join(directory, 'history.sqlite'), { force: true });
    rmSync(join(directory, 'history.sqlite-wal'), { force: true });
    rmSync(join(directory, 'history.sqlite-shm'), { force: true });
    rmdirSync(directory);
  }
});

test('a failed SQLite checkpoint retries its time once and ignores abandoned startup', () => {
  const db = openDatabase(':memory:'), store = new HistoryStore(db);
  let failed = false;
  const history = new PlaybackHistory({
    recover: since => store.recover(since),
    checkpoint(batch) {
      if (!failed) { failed = true; throw new Error('SQLITE_BUSY'); }
      store.checkpoint(batch);
    }
  });
  try {
    history.open({ ...delivery, id: 'abandoned' }, undefined, 0);
    history.open(delivery, undefined, 0);
    history.observe('first', delivery.owner, sample(1, 0, 0), 0);
    history.observe('first', delivery.owner, sample(2, 5000, 5000), 5000);
    history.tick(5000);
    history.observe('first', delivery.owner, sample(3, 8000, 8000, 'stopped'), 8000);
    history.tick(36000);
    history.tick(200000);
    assert.equal(sessions(db).length, 1);
    assert.equal((sessions(db)[0] as {watch_ms: number}).watch_ms, 8000);
    assert.deepEqual(db.prepare('SELECT SUM(direct_ms) AS watched FROM history_days').get(), { watched: 8000 });
  } finally { history.close(); db.close(); }
});

test('the owned VOD progress route records history even when Plex timeline sync fails', async () => {
  const db = openDatabase(':memory:'), f = fakePlex(), vault = new Vault(randomBytes(32));
  const transport = (async (url: string | URL | Request, init?: RequestInit) => new URL(String(url)).pathname === '/:/timeline'
    ? new Response('', { status: 503 }) : f.transport(url, init)) as typeof fetch;
  const plex = new PlexAdapter(config(), 'test', transport), identity = new IdentityService(db, vault, plex);
  const app = await buildApp(config(), db, vault, plex, false);
  try {
    const first = await identity.finish((await identity.start()).binding), other = await identity.finish((await identity.start()).binding);
    assert.ok(first && other);
    const headers = { cookie: `tk.box_local=${first.cookie}`, origin: 'http://127.0.0.1:3000' };
    const created = await app.inject({ method: 'POST', url: '/api/v1/playback/sessions', headers, payload: {
      mode: 'plex_vod', ratingKey: '42', capabilities: { videoCodecs: ['h264:8'], audioCodecs: ['aac'], containers: ['mp4', 'hls'] }
    } });
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().id as string, url = `/api/v1/playback/sessions/${id}/progress`;
    const baseline = { observation: sample(1, 0, 0) };
    const forbidden = await app.inject({ method: 'PATCH', url, headers: { ...headers, cookie: `tk.box_local=${other.cookie}` }, payload: baseline });
    assert.equal(forbidden.statusCode, 404);
    assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: baseline })).statusCode, 200);
    assert.deepEqual(sessions(db), []);
    const progress = await app.inject({ method: 'PATCH', url, headers, payload: { timeMs: 1000, state: 'stopped',
      observation: sample(2, 1000, 1000, 'ended') } });
    assert.equal(progress.statusCode, 502);
    await setImmediate();
    assert.equal((sessions(db)[0] as {watch_ms: number}).watch_ms, 1000);
    assert.equal((sessions(db)[0] as {end_reason: string}).end_reason, 'ended');
    assert.equal(f.calls.filter(call => call.path === '/library/metadata/42').length, 2);
  } finally { await app.close(); db.close(); }
});
