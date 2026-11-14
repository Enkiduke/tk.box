import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigratedDatabase } from '../apps/server/src/modules/migrations/index.js';
import { HistoryStore } from '../apps/server/src/persistence/history-store.js';
import { PlexAdapter, type PlexGrant, type PlexSession } from '../apps/server/src/providers/plex.js';
import { PlaybackHistory } from '../apps/server/src/services/playback-history.js';
import { PlexPlaybackMonitor } from '../apps/server/src/services/plex-playback-monitor.js';
import { plexPlaybackStates } from '../apps/server/src/services/plex-notifications.js';
import { config } from './fixtures.js';

const grant: PlexGrant = { accountId: '1', serverToken: 'owner', libraries: [], role: 'admin' };
const movie = { sessionKey: '7', ratingKey: '42', title: 'A film', type: 'movie', duration: 300000, librarySectionID: '10',
  User: { id: '2', title: 'Viewer' }, Player: { product: 'Plex for Roku', platform: 'Roku', machineIdentifier: 'roku', state: 'playing' },
  Session: { id: 'plex-session' }, Media: [{ width: 1920, height: 1080 }] } satisfies PlexSession;

test('Plex playback parser handles both envelopes and skips malformed members', () => {
  const event = { sessionKey: 7, ratingKey: '42', state: 'playing', viewOffset: '1000' };
  for (const payload of [
    { NotificationContainer: { type: 'playing', PlaySessionStateNotification: [{}, event] } },
    { type: 'playing', _children: [event] }
  ]) assert.deepEqual(plexPlaybackStates(JSON.stringify(payload)), [{ ...event, sessionKey: '7', viewOffset: 1000 }]);
  assert.deepEqual(plexPlaybackStates('invalid'), []);
});

test('external collection uses identity from one shared snapshot and excludes paused and disconnected time', async () => {
  const db = openMigratedDatabase(':memory:'), store = new HistoryStore(db), history = new PlaybackHistory(store);
  let time = 1700000000000, reads = 0, rows: PlexSession[] = [{ ...movie, viewOffset: 1000 }];
  const monitor = new PlexPlaybackMonitor({ sessionSnapshot: async () => { reads++; return { rows, local: [] }; } },
    history, async () => grant, () => 'machine', undefined, () => time);
  const report = (at: number, state: 'playing' | 'paused' | 'stopped', viewOffset: number) => {
    time = 1700000000000 + at;
    monitor.states([{ sessionKey: '7', ratingKey: '42', state, viewOffset }]);
  };
  try {
    monitor.start();
    await Promise.all([monitor.refresh(), monitor.sessions(grant), monitor.sessions(grant)]);
    assert.equal(reads, 1);
    report(8000, 'playing', 9000);
    report(10000, 'paused', 11000);
    report(40000, 'playing', 11000);
    report(48000, 'playing', 19000);
    monitor.connection(false);
    time += 10000;
    monitor.connection(true);
    rows = [{ ...movie, viewOffset: 29000 }];
    await monitor.refresh();
    report(63000, 'stopped', 34000);
    history.tick(time);
    assert.deepEqual(db.prepare('SELECT source,account_id,client,watch_ms,end_reason FROM history_sessions').all(),
      [{ source: 'plex', account_id: '2', client: 'Plex for Roku · Roku', watch_ms: 23000, end_reason: 'stopped' }]);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM history_sessions').all()).includes('plex-session'));
    await monitor.sessions({ ...grant, serverToken: 'limited' });
    assert.equal(reads, 3);
  } finally { monitor.close(); history.close(); db.close(); }
});

test('Plex startup and reconnect only read current sessions', async () => {
  const db = openMigratedDatabase(':memory:'), history = new PlaybackHistory(new HistoryStore(db));
  const requests: string[] = [];
  const plex = new PlexAdapter(config(), 'tk-box-client', (async (input: string | URL | Request) => {
    requests.push(new URL(String(input)).pathname);
    return Response.json({ MediaContainer: { Metadata: [] } });
  }) as typeof fetch);
  const monitor = new PlexPlaybackMonitor(plex, history, async () => grant, () => 'machine');
  try {
    monitor.start();
    await monitor.refresh();
    monitor.connection(false);
    monitor.connection(true);
    await monitor.refresh();
    assert.deepEqual(requests, ['/status/sessions', '/status/sessions']);
    assert.deepEqual(db.prepare('SELECT * FROM history_sessions').all(), []);
  } finally { monitor.close(); history.close(); db.close(); }
});

test('external collection resumes the same Plex session after process restart', async () => {
  const db = openMigratedDatabase(':memory:'), store = new HistoryStore(db);
  const first = new PlaybackHistory(store), second = new PlaybackHistory(store);
  let now = 1700000000000, offset = 0;
  const plex = { sessionSnapshot: async () => ({ rows: [{ ...movie, User: { id: '1' }, viewOffset: offset }], local: [] }) };
  const makeMonitor = (history: PlaybackHistory) => new PlexPlaybackMonitor(plex, history,
    async () => ({ ...grant, accountId: '1001' }), () => 'machine', undefined, () => now);
  const a = makeMonitor(first), b = makeMonitor(second);
  const play = (monitor: PlexPlaybackMonitor, ms: number, position: number) => {
    now += ms;
    monitor.states([{ sessionKey: '7', ratingKey: '42', state: 'playing', viewOffset: position }]);
  };
  try {
    first.start(now);
    a.start();
    await a.refresh();
    play(a, 10000, 10000);
    first.tick(now);
    a.close();
    first.close();
    now += 20000;
    offset = 30000;
    second.start(now);
    b.start();
    await b.refresh();
    play(b, 5000, 35000);
    second.tick(now);
    assert.deepEqual(db.prepare('SELECT source,account_id,watch_ms FROM history_sessions').all(),
      [{ source: 'plex', account_id: '1001', watch_ms: 15000 }]);
  } finally { a.close(); b.close(); first.close(); second.close(); db.close(); }
});

test('Plex adapter separates tk.box sessions from external sessions', async () => {
  const plex = new PlexAdapter(config(), 'tk-box-client', (async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).pathname, '/status/sessions');
    return Response.json({ MediaContainer: { Metadata: [
      movie, { ...movie, Player: { machineIdentifier: 'tk-box-client' } }, { ...movie, Player: { product: 'tk.box' } }
    ] } });
  }) as typeof fetch);
  assert.deepEqual(await plex.sessionSnapshot(grant), { rows: [movie], local: [
    { sessionKey: '7', ratingKey: '42' }, { sessionKey: '7', ratingKey: '42' }
  ] });
});
