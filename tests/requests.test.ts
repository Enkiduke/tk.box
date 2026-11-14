import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDatabase } from '../apps/server/src/modules/migrations/index.js';
import { RequestStore } from '../apps/server/src/persistence/requests-store.js';
import { ArrFulfiller, FulfilError, type FulfilKind, type FulfilTarget, type Fulfiller, type QueueState } from '../apps/server/src/providers/arr-fulfiller.js';
import { RequestAvailability } from '../apps/server/src/services/request-availability.js';
import { Requests, requestItem } from '../apps/server/src/services/requests.js';
import type { PlexAvailability } from '../apps/server/src/providers/plex.js';

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

test('a request imported from Seerr is found in Sonarr by the sweep and followed', async () => {
  const { requests, store, fulfiller } = setup();
  const show = store.insert({ kind: 'show', tmdbId: 1399, tvdbId: 121361, title: 'Game of Thrones', accountId: '22', accountName: 'Sam', status: 'requested', seerrId: 2, seasons: [{ season: 1 }] });
  fulfiller.known.set(1399, 42);
  fulfiller.queueState = { movies: new Set(), series: new Map([[42, new Set<number | undefined>([1])]]) };
  await requests.sweep();
  assert.equal(store.get(show.id)!.arrId, 42); assert.equal(store.get(show.id)!.status, 'downloading');
});

test('a title\'s request state marks each regular season available, downloading or requested, and the rest open', async () => {
  const { requests, fulfiller, plex } = setup();
  await plex({ titles: [{ kind: 'show', ratingKey: '9', tmdbId: 1399 }], seasons: [{ showKey: '9', season: 1 }], complete: true });
  const row = await requests.create(me, { kind: 'show', tmdb: 1399, seasons: [2] });
  fulfiller.queueState = { movies: new Set(), series: new Map([[row.arrId!, new Set<number | undefined>([2])]]) };
  await requests.sweep();
  const state = await requests.titleState('show', 1399, 121361);
  assert.deepEqual(state.seasons.map(s => [s.number, s.status]), [[1, 'available'], [2, 'downloading'], [3, undefined]]);
  assert.equal(state.requestable, true);
  assert.equal(requests.plexKey('show', 1399), '9');
  assert.deepEqual(await requests.titleState('movie', 603), { requestable: true, seasons: [] });
  await requests.create(me, { kind: 'movie', tmdb: 603 });
  assert.equal((await requests.titleState('movie', 603)).requestable, false);
});

test('Clean Up gets the requests on the server, and a title it deleted has its requests removed', async () => {
  const { requests, store, plex } = setup();
  await plex({ titles: [{ kind: 'movie', ratingKey: '1', tmdbId: 603, addedAt: 500 }], seasons: [], complete: true });
  const movie = store.insert({ kind: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999, accountId: '11', accountName: 'Casey', status: 'available', availableAt: 500000 });
  store.insert({ kind: 'show', tmdbId: 1399, tvdbId: 121361, title: 'Game of Thrones', accountName: 'Local', status: 'partial', seasons: [{ season: 1, availableAt: 600000 }, { season: 2 }] });
  await requests.create(other, { kind: 'show', tmdb: 1399, seasons: [3] });
  assert.deepEqual(requests.forCleanup(), [
    { id: movie.id, kind: 'movie', tmdb: 603, tvdb: null, title: 'The Matrix', year: 1999, requester_plex_id: 11, available_at: new Date(500000).toISOString(), seasons: [] },
    { id: 2, kind: 'tv', tmdb: 1399, tvdb: 121361, title: 'Game of Thrones', year: null, requester_plex_id: null, available_at: null, seasons: [1, 2] }]);
  requests.removedByCleanup([{ kind: 'movie', tmdb: 603 }]);
  assert.equal(store.get(movie.id)!.status, 'removed'); assert.equal(requestItem(store.get(movie.id)!).removedBy, 'cleanup');
  assert.equal(requests.forCleanup().length, 1);
});
