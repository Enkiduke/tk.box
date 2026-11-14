import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { HistoryListRow, HistoryRank, HistorySummary } from '../packages/contracts/src/index.js';
import { registerHistory } from '../apps/server/src/history-api.js';
import { openMigratedDatabase } from '../apps/server/src/modules/migrations/index.js';
import { HistoryStore, type HistorySession } from '../apps/server/src/persistence/history-store.js';
import { AppError } from '../apps/server/src/errors.js';
import { installAccess } from '../apps/server/src/modules/access.js';

test('Admin History scopes its lists and live media totals', async () => {
  const db = openMigratedDatabase(':memory:'), store = new HistoryStore(db), app = Fastify();
  const today = new Date(), now = today.getTime(), day = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  const movie = { serverId: 'machine', ratingKey: '42', libraryId: '10', title: 'Test film', type: 'movie' as const, durationMs: 60000 };
  const session: HistorySession = { id: randomUUID(), generation: 'private-generation', accountId: '2', accountName: 'Viewer',
    media: movie, startedAt: now - 1, observedAt: now, positionMs: 1000, watchMs: 1000, client: 'Chrome', stream: { delivery: 'direct' } };
  const custom: HistorySession = { ...session, id: randomUUID(), watchMs: 4000, accountId: '3',
    media: { type: 'channel', serverId: 'custom', ratingKey: 'channel', title: 'Test Channel', number: 3 } };
  const iptv: HistorySession = { ...custom, id: randomUUID(), watchMs: 3000,
    media: { type: 'channel', serverId: 'iptv', ratingKey: 'feed', title: 'IPTV Channel', number: 4 } };
  const episode: HistorySession = { ...session, id: randomUUID(), watchMs: 2000,
    media: { ...movie, type: 'episode', ratingKey: '43', title: 'Test episode', showId: '10', showTitle: 'Test show', season: 2, episode: 3 } };
  const other = Array.from({ length: 51 }, () => ({ ...session, id: randomUUID(), accountId: '4', startedAt: now - 10, source: 'plex' as const }));
  const days = (ms: number) => new Map([[day, { direct: ms, remux: 0, transcode: 0 }]]);
  store.checkpoint([{ session, days: days(1000) }, { session: custom, days: days(4000),
    live: [{ day, feedId: 'channel', watchMs: 2000, airing: { id: 'airing', start: now - 2000, end: now, media: movie } }] },
  { session: iptv, days: days(3000), live: [{ day, feedId: 'feed', watchMs: 3000,
    airing: { id: 'guide', start: now - 3000, end: now, guide: { title: 'IPTV Programme', estimated: true } } }] },
  { session: episode, days: days(2000) },
  ...other.map(s => ({ session: s, days: days(1000) }))]);
  installAccess(app, { admin: async () => ({}) as never });
  registerHistory(app, db);
  const get = (path: string) => app.inject({ url: `/api/v1/admin/history/${path}` });
  try {
    const summary = (await get('summary?days=all')).json<HistorySummary>();
    assert.equal(summary.watchMs, 61000);
    assert.equal(summary.sessions, 55);
    assert.equal(summary.viewers, 3);
    const ranked = (await get('media?days=all&kind=movies')).json<HistoryRank[]>();
    assert.equal(ranked[0]?.watchMs, 54000);
    assert.equal((await get('media?days=all&kind=channels')).json<HistoryRank[]>()[0]?.watchMs, 4000);
    const all = await get('media?days=all');
    assert.equal(all.statusCode, 200);
    assert.deepEqual(all.json().map(({ kind, title }: { kind: string; title: string }) => [kind, title]), [
      ['movie', 'Test film'], ['channel', 'Test Channel'], ['channel', 'IPTV Channel'], ['program', 'IPTV Programme'],
      ['episode', 'Test episode'], ['show', 'Test show']
    ]);
    assert.deepEqual((await get('sessions?days=all&airing=feed%3Aguide')).json().items.map((s: HistoryListRow) => s.id), [iptv.id]);
    assert.equal((await get('users?days=all&source=custom')).json<HistoryRank[]>()[0]?.id, '3');
    assert.deepEqual((await get('sessions?days=all&source=custom&media=' + ranked[0]?.id)).json().items.map((s: HistoryListRow) => s.id), [custom.id]);
    const list = (await get('sessions?days=all&source=plex&sort=longest')).json<{ items: HistoryListRow[]; next: string }>();
    const next = (await get('sessions?days=all&source=plex&sort=longest&cursor=' + encodeURIComponent(list.next))).json<{ items: HistoryListRow[] }>();
    assert.equal(list.items.length, 50);
    assert.equal(next.items.length, 1);
    assert.equal(new Set([...list.items, ...next.items].map(x => x.id)).size, 51);
    const search = (await get('sessions?days=all&q=Test%20show')).json<{ items: HistoryListRow[] }>();
    assert.deepEqual(search.items.map(row => [row.id, row.season, row.episode]), [[episode.id, 2, 3]]);
    const detail = await get('sessions/' + custom.id);
    assert.equal(detail.json().allocations[0].title, 'Test film');
    assert.equal(detail.json().session.channelNumber, 3);
    assert.equal(detail.json().observedAt, now);
    assert.deepEqual(detail.json().deliveryMs, { direct: 4000, remux: 0, transcode: 0 });
    assert.ok(!detail.body.includes('private-generation'));
    assert.equal((await get('plex-views')).statusCode, 404);
  } finally { await app.close(); store.close(); db.close(); }
});

test('Admin History checks authorization before reading or returning cached results', async () => {
  const db = openMigratedDatabase(':memory:'), app = Fastify();
  let authorized = true;
  installAccess(app, { admin: async () => {
    if (!authorized) throw new AppError('FORBIDDEN', 'Administrator access required.', 403);
    return {} as never;
  } });
  registerHistory(app, db);
  try {
    assert.equal((await app.inject('/api/v1/admin/history/summary')).statusCode, 200);
    authorized = false;
    assert.equal((await app.inject('/api/v1/admin/history/summary')).statusCode, 403);
    assert.equal((await app.inject('/api/v1/admin/history/sessions')).statusCode, 403);
  } finally { await app.close(); db.close(); }
});
