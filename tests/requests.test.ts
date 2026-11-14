import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDatabase } from '../apps/server/src/modules/migrations/index.js';
import { RequestStore } from '../apps/server/src/persistence/requests-store.js';
import { ArrFulfiller, FulfilError, type FulfilKind, type FulfilTarget, type Fulfiller, type QueueState } from '../apps/server/src/providers/arr-fulfiller.js';
import { RequestAvailability } from '../apps/server/src/services/request-availability.js';
import { Requests, requestItem } from '../apps/server/src/services/requests.js';
import type { PlexAvailability } from '../apps/server/src/providers/plex.js';
import { importSeerr } from '../apps/server/src/services/seerr-import.js';

const connected = () => ({ url: 'http://arr.test', key: 'key' });
const me = { accountId: '11', name: 'Casey' }, other = { accountId: '22', name: 'Sam' };

// A Radarr/Sonarr stand-in that records what it was asked.
class FakeFulfiller implements Fulfiller {
  added: FulfilTarget[] = []; unmonitored: [FulfilKind, number, number[]][] = []; failures: FulfilError[] = [];
  queueState: QueueState = { movies: new Set(), series: new Map() }; gone = new Set<number>(); next = 100;
  async add(target: FulfilTarget) { const failure = this.failures.shift(); if (failure) throw failure; this.added.push(target); return this.next++; }
  async queue() { return this.queueState; }
  known = new Map<number, number>();
  async find(_kind: FulfilKind, tmdbId: number) { return this.known.get(tmdbId); }
  async exists(_kind: FulfilKind, id: number) { return !this.gone.has(id); }
  async unmonitor(kind: FulfilKind, id: number, seasons: number[]) { this.unmonitored.push([kind, id, seasons]); }
  async options() { return { connected: true, profiles: [], rootFolders: [], tags: [] }; }
}
const tmdbTitles: Record<string, unknown> = {
  '/movie/603': { title: 'The Matrix', release_date: '1999-03-31' },
  '/tv/1399': { name: 'Game of Thrones', first_air_date: '2011-04-17', external_ids: { tvdb_id: 121361 }, seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }, { season_number: 3 }] }
};
function setup() {
  const db = openMigratedDatabase(':memory:');
  let clock = 1_000_000, plex: PlexAvailability = { titles: [], seasons: [], complete: true };
  const store = new RequestStore(db, () => clock), fulfiller = new FakeFulfiller();
  const availability = new RequestAvailability(async () => plex);
  const changes: string[] = [];
  const requests = new Requests(store, fulfiller, availability, { get: async (path: string) => tmdbTitles[path] }, connected, () => {}, () => clock);
  requests.changed = c => changes.push(`${c.id}:${c.status}`);
  return { db, store, fulfiller, availability, requests, changes, tick: (ms: number) => { clock += ms; },
    plex: async (next: PlexAvailability) => { plex = next; await availability.rebuild(); } };
}

test('a movie request is saved, sent to Radarr and refused a second time', async () => {
  const { requests, fulfiller, changes } = setup();
  const row = await requests.create(me, { kind: 'movie', tmdb: 603 });
  assert.equal(row.status, 'requested'); assert.equal(row.arrId, 100); assert.equal(row.title, 'The Matrix'); assert.equal(row.year, 1999);
  assert.deepEqual(fulfiller.added.map(t => [t.kind, t.tmdbId, t.search]), [['movie', 603, true]]);
  assert.deepEqual(changes, ['1:queued', '1:requested']);
  await assert.rejects(requests.create(other, { kind: 'movie', tmdb: 603 }), { code: 'REQUEST_EXISTS' });
  assert.equal(requests.labels().get('movie:tmdb:603'), 'requested');
});

test('a show request takes the open regular seasons; asking for all of them also watches new ones', async () => {
  const { requests, fulfiller, plex } = setup();
  await plex({ titles: [{ kind: 'show', ratingKey: '9', tmdbId: 1399, addedAt: 100 }], seasons: [{ showKey: '9', season: 1, addedAt: 100 }], complete: true });
  const all = await requests.create(me, { kind: 'show', tmdb: 1399 });
  assert.deepEqual(all.seasons.map(s => s.season), [2, 3]); assert.equal(all.monitorFuture, true); assert.equal(all.tvdbId, 121361);
  assert.equal(fulfiller.added[0]!.tvdbId, 121361);
  await assert.rejects(requests.create(other, { kind: 'show', tmdb: 1399, seasons: [2] }), { code: 'REQUEST_EXISTS' });
  await assert.rejects(requests.create(other, { kind: 'show', tmdb: 1399, seasons: [7] }), { code: 'INVALID_REQUEST' });
  await assert.rejects(requests.create(other, { kind: 'show', tmdb: 1399 }), /Every season/);
});

test('picking some seasons does not watch new ones', async () => {
  const { requests } = setup();
  const row = await requests.create(me, { kind: 'show', tmdb: 1399, seasons: [1] });
  assert.equal(row.monitorFuture, false); assert.deepEqual(row.seasons.map(s => s.season), [1]);
});

test('a send that fails is retried with backoff and fails after the fifth try; a refusal fails at once', async () => {
  const { requests, fulfiller, store, tick } = setup();
  fulfiller.failures = Array.from({ length: 5 }, () => new FulfilError('Radarr could not be reached.', false));
  const row = await requests.create(me, { kind: 'movie', tmdb: 603 });
  assert.equal(row.status, 'queued'); assert.equal(row.attempts, 1); assert.equal(row.nextAttemptAt, 1_000_000 + 60000);
  await requests.sweep(); assert.equal(store.get(row.id)!.attempts, 1);  // not due yet
  for (const wait of [60000, 5 * 60000, 30 * 60000]) { tick(wait); await requests.sweep(); }
  assert.equal(store.get(row.id)!.attempts, 4); assert.equal(store.get(row.id)!.status, 'queued');
  tick(2 * 3600000); await requests.sweep();
  const failed = store.get(row.id)!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.seen, false); assert.match(requestItem(failed).error!, /reached/);
  assert.equal(requests.labels().has('movie:tmdb:603'), false);
  // Retried by an administrator, it goes through.
  assert.equal((await requests.retry(row.id)).status, 'requested');

  const { requests: r2, fulfiller: f2 } = setup();
  f2.failures = [new FulfilError('Movie already has a file in another root folder', true)];
  assert.equal((await r2.create(me, { kind: 'movie', tmdb: 603 })).status, 'failed');
});

test('statuses follow the Radarr/Sonarr queue and then Plex, season by season', async () => {
  const { requests, fulfiller, store, plex } = setup();
  const movie = await requests.create(me, { kind: 'movie', tmdb: 603 }), show = await requests.create(me, { kind: 'show', tmdb: 1399, seasons: [1, 2] });
  fulfiller.queueState = { movies: new Set([movie.arrId!]), series: new Map([[show.arrId!, new Set<number | undefined>([2])]]) };
  await requests.sweep();
  assert.equal(store.get(movie.id)!.status, 'downloading'); assert.equal(store.get(show.id)!.status, 'downloading');
  assert.equal(requests.labels().get('show:tmdb:1399'), 'downloading');
  fulfiller.queueState = { movies: new Set(), series: new Map() };
  await requests.sweep();
  assert.equal(store.get(movie.id)!.status, 'requested');
  await plex({ titles: [{ kind: 'movie', ratingKey: '1', tmdbId: 603, addedAt: 500 }, { kind: 'show', ratingKey: '9', tmdbId: 1399, addedAt: 600 }],
    seasons: [{ showKey: '9', season: 1, addedAt: 700 }], complete: true });
  await requests.sweep();
  assert.equal(store.get(movie.id)!.status, 'available'); assert.equal(store.get(movie.id)!.availableAt, 500000);
  const partial = store.get(show.id)!;
  assert.equal(partial.status, 'partial'); assert.deepEqual(partial.seasons, [{ season: 1, availableAt: 700000 }, { season: 2 }]);
  assert.equal(requests.labels().get('show:tmdb:1399'), 'partial'); assert.equal(requests.labels().get('movie:tmdb:603'), 'available');
  await plex({ titles: [{ kind: 'show', ratingKey: '9', tmdbId: 1399, addedAt: 600 }], seasons: [{ showKey: '9', season: 1, addedAt: 700 }, { showKey: '9', season: 2, addedAt: 800 }], complete: true });
  await requests.sweep();
  assert.equal(store.get(show.id)!.status, 'available'); assert.equal(store.get(show.id)!.availableAt, 600000);
  assert.equal(requests.labels().get('show:tmdb:1399'), 'available');
  assert.equal(store.unseen(me.accountId), 2);
  store.markSeen(me.accountId); assert.equal(store.unseen(me.accountId), 0);
});

test('an incomplete Plex read keeps the last index', async () => {
  const { availability, plex } = setup();
  await plex({ titles: [{ kind: 'movie', ratingKey: '1', tmdbId: 603 }], seasons: [], complete: true });
  await plex({ titles: [], seasons: [], complete: false });
  assert.ok(availability.movie(603));
});

test('cancelling unmonitors only what no other request needs; a title deleted from Radarr is marked removed', async () => {
  const { requests, fulfiller, store, tick } = setup();
  const mine = await requests.create(me, { kind: 'show', tmdb: 1399, seasons: [1, 2] });
  const theirs = await requests.create(other, { kind: 'show', tmdb: 1399, seasons: [3] });
  await assert.rejects(requests.cancel(mine.id, { accountId: other.accountId, admin: false }), { code: 'NOT_FOUND' });
  const cancelled = await requests.cancel(mine.id, { accountId: me.accountId, admin: false });
  assert.equal(cancelled.status, 'removed'); assert.equal(requestItem(cancelled).removedBy, 'requester');
  assert.deepEqual(fulfiller.unmonitored, [['show', mine.arrId, [1, 2]]]);
  // Once downloading, only an administrator can take it away.
  fulfiller.queueState = { movies: new Set(), series: new Map([[theirs.arrId!, new Set<number | undefined>([3])]]) };
  await requests.sweep();
  await assert.rejects(requests.cancel(theirs.id, { accountId: other.accountId, admin: false }), { code: 'REQUEST_IN_PROGRESS' });
  const movie = await requests.create(me, { kind: 'movie', tmdb: 603 });
  fulfiller.gone.add(movie.arrId!); tick(3600000);
  await requests.sweep();
  assert.equal(store.get(movie.id)!.status, 'removed'); assert.equal(requestItem(store.get(movie.id)!).removedBy, 'arr');
  assert.equal(requestItem(await requests.cancel(theirs.id, { accountId: me.accountId, admin: true })).removedBy, 'admin');
});

test('ArrFulfiller adds a new movie, adopts an existing one, and sorts refusals from outages', async () => {
  const calls: string[] = [];
  let existing: unknown[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), path = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
    calls.push(init?.body ? `${path} ${init.body}` : path);
    if (url.pathname === '/api/v3/movie' && init?.method !== 'POST') return Response.json(existing);
    if (url.pathname === '/api/v3/movie/lookup/tmdb') return Response.json({ tmdbId: 603, title: 'The Matrix' });
    if (url.pathname === '/api/v3/qualityprofile') return Response.json([{ id: 4, name: 'HD' }]);
    if (url.pathname === '/api/v3/rootfolder') return Response.json([{ path: '/movies' }]);
    if (url.pathname === '/api/v3/movie' && init?.method === 'POST') return Response.json({ id: 7 }, { status: 201 });
    if (url.pathname === '/api/v3/movie/8') return Response.json({});
    if (url.pathname === '/api/v3/command') return Response.json({});
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const arr = new ArrFulfiller(connected, transport);
  const target: FulfilTarget = { kind: 'movie', tmdbId: 603, title: 'The Matrix', seasons: [], monitorFuture: false, tags: [3], search: true };
  assert.equal(await arr.add(target), 7);
  const posted = JSON.parse(calls.find(c => c.startsWith('POST /api/v3/movie '))!.slice('POST /api/v3/movie '.length));
  assert.deepEqual([posted.qualityProfileId, posted.rootFolderPath, posted.monitored, posted.tags, posted.addOptions], [4, '/movies', true, [3], { searchForMovie: true }]);
  existing = [{ id: 8, tmdbId: 603, monitored: false, hasFile: false }]; calls.length = 0;
  assert.equal(await arr.add({ ...target, profileId: 9, rootFolder: '/4k' }), 8);
  assert.deepEqual(calls.map(c => c.split(' ').slice(0, 2).join(' ')), ['GET /api/v3/movie?tmdbId=603', 'PUT /api/v3/movie/8', 'POST /api/v3/command']);
  const refusing = new ArrFulfiller(connected, (async () => Response.json([{ errorMessage: 'Path is not valid' }], { status: 400 })) as typeof fetch);
  await assert.rejects(refusing.add(target), (e: FulfilError) => e.permanent && /Path is not valid/.test(e.message));
  const down = new ArrFulfiller(connected, (async () => new Response('', { status: 503 })) as typeof fetch);
  await assert.rejects(down.add(target), (e: FulfilError) => !e.permanent);
  await assert.rejects(new ArrFulfiller(() => ({ url: '' })).add(target), (e: FulfilError) => !e.permanent && /isn't connected/.test(e.message));
});

test('ArrFulfiller adds a series with only the chosen seasons monitored, and monitors more on one Sonarr has', async () => {
  const bodies: Record<string, unknown>[] = [];
  let existing: unknown[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.body) bodies.push({ path: `${init.method} ${url.pathname}`, ...JSON.parse(String(init.body)) });
    if (url.pathname === '/api/v3/series' && init?.method !== 'POST') return Response.json(existing);
    if (url.pathname === '/api/v3/series/lookup') return Response.json([{ tvdbId: 121361, title: 'GoT', seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }] }]);
    if (url.pathname === '/api/v3/qualityprofile') return Response.json([{ id: 1 }]);
    if (url.pathname === '/api/v3/rootfolder') return Response.json([{ path: '/tv' }]);
    if (url.pathname === '/api/v3/languageprofile') return Response.json([{ id: 2 }]);
    if (url.pathname === '/api/v3/series' && init?.method === 'POST') return Response.json({ id: 5 });
    return Response.json({});
  }) as typeof fetch;
  const arr = new ArrFulfiller(connected, transport);
  const target: FulfilTarget = { kind: 'show', tmdbId: 1399, tvdbId: 121361, title: 'GoT', seasons: [2], monitorFuture: false, tags: [], search: true };
  assert.equal(await arr.add(target), 5);
  const added = bodies[0] as { seasons: { seasonNumber: number; monitored: boolean }[]; monitorNewItems: string; languageProfileId: number; seasonFolder: boolean };
  assert.deepEqual(added.seasons.map(s => [s.seasonNumber, s.monitored]), [[0, false], [1, false], [2, true]]);
  assert.equal(added.monitorNewItems, 'none'); assert.equal(added.languageProfileId, 2); assert.equal(added.seasonFolder, true);
  existing = [{ id: 6, seasons: [{ seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: false }] }]; bodies.length = 0;
  assert.equal(await arr.add({ ...target, seasons: [1], monitorFuture: true }), 6);
  const put = bodies[0] as { path: string; seasons: { seasonNumber: number; monitored: boolean }[]; monitorNewItems: string };
  assert.equal(put.path, 'PUT /api/v3/series/6'); assert.deepEqual(put.seasons.map(s => s.monitored), [true, false]); assert.equal(put.monitorNewItems, 'all');
  assert.deepEqual(bodies.slice(1).map(b => [b.name, b.seasonNumber]), [['SeasonSearch', 1]]);
  await assert.rejects(arr.add({ ...target, tvdbId: undefined }), (e: FulfilError) => e.permanent);
});

test('the Seerr import copies requests once, maps requesters by Plex id, and skips declined ones', async () => {
  const { requests, store, fulfiller } = setup();
  const seerr = [
    { id: 1, status: 2, type: 'movie', createdAt: '2026-01-02T03:04:05.000Z', media: { tmdbId: 603, status: 5, mediaAddedAt: '2026-01-05T00:00:00.000Z' }, requestedBy: { plexId: 11, displayName: 'Casey' } },
    { id: 2, status: 2, type: 'tv', createdAt: '2026-02-01T00:00:00.000Z', media: { tmdbId: 1399, tvdbId: 121361, status: 3 }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }], requestedBy: { plexId: 22, displayName: 'Sam' } },
    { id: 3, status: 3, type: 'movie', media: { tmdbId: 604, status: 1 }, requestedBy: { plexId: 22 } },
    { id: 4, status: 1, type: 'movie', media: { tmdbId: 605, status: 1 }, requestedBy: { email: 'local@seerr' } }
  ];
  const asked: string[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); asked.push(`${url.searchParams.get('skip')} ${(init?.headers as Record<string, string>)['X-Api-Key']}`);
    if ((init?.headers as Record<string, string>)['X-Api-Key'] !== 'seerr-key') return new Response('', { status: 401 });
    return Response.json({ pageInfo: { results: seerr.length }, results: url.searchParams.get('skip') === '0' ? seerr : [] });
  }) as typeof fetch;
  const tmdb = { get: async (path: string) => tmdbTitles[path] };
  await assert.rejects(importSeerr(store, tmdb, 'http://seerr.test', 'wrong', transport), { code: 'SEERR_KEY_REJECTED' });
  assert.deepEqual(await importSeerr(store, tmdb, 'http://seerr.test/', 'seerr-key', transport), { imported: 3, skipped: 0, declined: 1, withoutPlexId: 1 });
  requests.imported();
  const [movie, show, pending] = store.list({ page: 1, size: 10 }).items.sort((a, b) => a.seerrId! - b.seerrId!);
  assert.deepEqual([movie!.status, movie!.title, movie!.accountId, movie!.createdAt, movie!.availableAt], ['available', 'The Matrix', '11', Date.parse('2026-01-02T03:04:05.000Z'), Date.parse('2026-01-05T00:00:00.000Z')]);
  assert.deepEqual([show!.status, show!.tvdbId, show!.accountName, show!.seasons.map(s => s.season)], ['requested', 121361, 'Sam', [1, 2]]);
  assert.deepEqual([pending!.status, pending!.accountId, pending!.accountName, pending!.title], ['queued', undefined, 'local@seerr', 'TMDB 605']);
  assert.equal(requests.labels().get('show:tmdb:1399'), 'requested');
  // Run again: nothing new.
  assert.deepEqual(await importSeerr(store, tmdb, 'http://seerr.test', 'seerr-key', transport), { imported: 0, skipped: 3, declined: 1, withoutPlexId: 0 });
  // The sweep sends the request Seerr held for approval, and finds the imported show in Sonarr to follow it.
  fulfiller.known.set(1399, 42);
  fulfiller.queueState = { movies: new Set(), series: new Map([[42, new Set<number | undefined>([1])]]) };
  await requests.sweep();
  assert.equal(store.get(pending!.id)!.status, 'requested');
  assert.equal(store.get(show!.id)!.arrId, 42); assert.equal(store.get(show!.id)!.status, 'downloading');
});
