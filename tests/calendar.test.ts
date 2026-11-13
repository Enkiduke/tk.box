import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type {CalendarPage} from '../packages/contracts/src/index.js';
import {registerCalendar} from '../apps/server/src/calendar-api.js';
import {AppError} from '../apps/server/src/errors.js';
import {PlexAdapter, type PlexGrant} from '../apps/server/src/providers/plex.js';
import {config} from './fixtures.js';

test('Calendar keeps the earliest home release and groups episodes by their local air day', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const requests: string[] = [], matched: string[] = [];
  const series = {title: 'The Show', tvdbId: 42};
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.hostname);
    assert.equal(url.pathname, '/api/v3/calendar');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'test-key');
    assert.equal(url.searchParams.get('unmonitored'), 'true');
    assert.equal(url.searchParams.get('start'), '2026-11-11T00:00:00.000Z');
    if (url.hostname === 'radarr.test') return Response.json([
      {title: 'The Movie', tmdbId: 1, inCinemas: '2026-11-11', physicalRelease: '2026-11-12T00:00:00Z', digitalRelease: '2026-11-13', hasFile: true},
      {title: 'Already Out', tmdbId: 2, physicalRelease: '2026-11-13', digitalRelease: '2026-11-11', hasFile: false},
      {title: 'Theatrical Only', tmdbId: 3, inCinemas: '2026-11-13', hasFile: false},
      {title: 'Invalid Date', tmdbId: 4, digitalRelease: '2026-11-00'},
    ]);
    assert.equal(url.searchParams.get('includeSeries'), 'true');
    const timed = {series, seasonNumber: 2, episodeNumber: 1, airDate: '2026-11-13', airDateUtc: '2026-11-13T02:00:00Z', hasFile: true};
    return Response.json([timed, timed, {...timed, title: 'TBA', episodeNumber: 2, airDateUtc: null},
      {...timed, episodeNumber: 3, airDateUtc: '2026-11-14T06:00:00Z'}]);
  };
  registerCalendar(app, {calendarMedia: async (grant, kind, _, guids) => {
    matched.push(`${grant.accountId}:${guids.join(',')}`);
    if (grant.accountId !== 'owner') return [];
    return kind === 'movie' ? [{id: '100'}] : [{id: '201', season: 2, episode: 1}];
  }}, async request => {
    const accountId = request.headers['x-test-account'];
    if (typeof accountId !== 'string') throw new AppError('UNAUTHORIZED', 'Sign in.', 401);
    return {grant: {accountId, role: 'viewer', serverToken: accountId, libraries: []}};
  }, () => ({radarr: {url: 'http://radarr.test', key: 'test-key'}, sonarr: {url: 'http://sonarr.test', key: 'test-key'}}), transport);
  const url = '/api/v1/calendar?from=2026-11-12&to=2026-11-14&zone=America%2FNew_York';
  assert.equal((await app.inject(url)).statusCode, 401);
  const owner = { 'x-test-account': 'owner' };
  assert.equal((await app.inject({url: `${url}&account=viewer`, headers: owner})).statusCode, 403);
  assert.equal((await app.inject({url: url.replace('2026-11-14', '2027-11-14'), headers: owner})).statusCode, 400);
  const result = await app.inject({url, headers: owner});
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json<CalendarPage>().dates.map(({day, kind, title, plexItemId, episodeTitle}) => [day, kind, title, plexItemId, episodeTitle]), [
    ['2026-11-12', 'physical', 'The Movie', '100', undefined],
    ['2026-11-12', 'episode', 'The Show', '201', undefined],
    ['2026-11-13', 'episode', 'The Show', undefined, undefined],
    ['2026-11-13', 'theatrical', 'Theatrical Only', undefined, undefined],
  ]);
  const viewer = await app.inject({url, headers: {'x-test-account': 'viewer'}});
  assert.ok(viewer.json<CalendarPage>().dates.every(entry => !entry.plexItemId));
  assert.deepEqual(requests.sort(), ['radarr.test', 'sonarr.test']);
  assert.deepEqual(matched.sort(), ['owner:tmdb://1', 'owner:tvdb://42', 'viewer:tmdb://1', 'viewer:tvdb://42']);
});

test('Calendar still returns the working feed during provider and Plex failures', async t => {
  const app = Fastify();
  t.after(() => app.close());
  registerCalendar(app, {calendarMedia: async () => {throw new Error('Plex is unavailable');}}, async () => ({
    grant: {accountId: 'owner', role: 'admin', serverToken: 'owner', libraries: []},
  }), () => ({radarr: {url: 'http://radarr.test', key: 'key'}, sonarr: {url: 'http://sonarr.test', key: 'key'}}), async input => {
    return new URL(String(input)).hostname === 'sonarr.test' ? new Response(null, {status: 503}) :
      Response.json([{title: 'The Movie', tmdbId: 1, digitalRelease: '2026-11-12', hasFile: true}]);
  });
  const response = await app.inject('/api/v1/calendar?from=2026-11-12&to=2026-11-14');
  assert.equal(response.statusCode, 200);
  const result = response.json<CalendarPage>();
  assert.deepEqual(result.sources, {Radarr: 'ready', Sonarr: 'unavailable'});
  assert.equal(result.plexUnavailable, true);
  assert.equal(result.dates[0]?.availabilityUnknown, true);
});

test('Calendar checks duplicate Plex series for the matching episode within the viewer’s libraries', async () => {
  const series = (id: string, section: string) => ({ratingKey: id, librarySectionID: section, type: 'show', title: 'The Show', Guid: [{id: 'tvdb://42'}]});
  const first = series('100', '20'), second = series('200', '30');
  const calls: string[] = [];
  const plex = new PlexAdapter(config(), 'test', async (input, init) => {
    const url = new URL(String(input)), path = url.pathname;
    calls.push(path);
    assert.equal(new Headers(init?.headers).get('x-plex-token'), 'viewer-token');
    if (path.endsWith('/all')) return Response.json({MediaContainer: {Metadata: [path.includes('/20/') ? first : second]}});
    if (path.endsWith('/allLeaves')) return Response.json({MediaContainer: {Metadata: path.includes('/200/') ? [
      {ratingKey: '201', type: 'episode', title: 'Premiere', parentIndex: 2, index: 1, grandparentRatingKey: '200'},
      {ratingKey: '901', type: 'episode', title: 'Unrelated', parentIndex: 2, index: 2, grandparentRatingKey: '900'},
    ] : []}});
    return Response.json({MediaContainer: {Metadata: [path.endsWith('/100') ? first : second]}});
  });
  const grant: PlexGrant = {accountId: 'viewer', role: 'viewer', serverToken: 'viewer-token',
    libraries: [{key: '20', title: 'TV', type: 'show'}, {key: '30', title: 'TV 4K', type: 'show'}]};
  const read = (viewer: PlexGrant) => plex.calendarMedia(viewer, 'show', 'The Show', ['tvdb://42']);
  assert.deepEqual(await read(grant), [{id: '201', posterUrl: undefined, season: 2, episode: 1}]);
  const count = calls.length;
  await read(grant);
  assert.equal(calls.length, count);
  assert.deepEqual(await read({...grant, libraries: grant.libraries.slice(0, 1)}), []);
  assert.ok(calls.slice(count).every(path => !/\/30\/|\/200/.test(path)));
});
