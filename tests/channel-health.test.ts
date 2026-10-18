import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { HealthStore } from '../apps/server/src/persistence/channel-health-store.js';
import { ChannelHealth } from '../apps/server/src/services/channel-health.js';
import { registerChannelHealth } from '../apps/server/src/health-api.js';
import { classify, dhash, hamming, parseAnalysis, probeStream, type ProbeResult } from '../apps/server/src/services/stream-probe.js';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg', available = spawnSync(ffmpeg, ['-version']).status === 0;
function lineup(count: number) {
  const db = openDatabase(':memory:'), store = new IptvStore(db, new Vault(randomBytes(32))), health = new HealthStore(db), source = store.create('owner', { kind: 'm3u', name: 'Live' });
  store.ingest('owner', source.id, 0, Buffer.from('#EXTM3U\n' + Array.from({ length: count }, (_, i) => `#EXTINF:-1 tvg-id="c${i}",Channel ${i}\nhttps://streams.invalid/${i}.ts`).join('\n')));
  // These tests are about hiding failures, so channels list before their first check.
  store.setListingPolicy('owner', source.id, { ...store.listingPolicy(source.id), requireCheck: false, expectedRevision: store.status(source.id).revision });
  const ids = Array.from({ length: count }, (_, i) => store.adminChannels(source.id).find(c => c.name === `Channel ${i}`)!.id);
  return { db, store, health, source: source.id, ids, visible: () => store.visible().map(c => c.id) };
}
const result = (verdict: ProbeResult['verdict'], extra: Partial<ProbeResult> = {}): ProbeResult => ({ verdict, reason: verdict === 'online' ? 'OK' : verdict === 'offline' ? 'HTTP_NOT_FOUND' : verdict === 'placeholder' ? 'FROZEN_SILENT' : 'PROVIDER_LIMIT', elapsedMs: 10, frames: 100, mediaSeconds: 7, frozen: false, silent: false, informative: false, thumbnail: false, ...extra });
const slate = '0000003226000000';

test('FFmpeg log analysis classifies transport failures, frozen silent screens, radio and live video', () => {
  const head = '  Stream #0:0[0x100]: Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 25 fps\n  Stream #0:1[0x101]: Audio: aac (LC), 48000 Hz, stereo\n';
  const stats = 'frame=  175 fps=0.0 q=-0.0 size=N/A time=00:00:07.00 bitrate=N/A speed=30x\r';
  const live = parseAnalysis(head + stats);
  assert.deepEqual(live.video, { codec: 'h264', width: 1920, height: 1080 }); assert.equal(live.audio, 'aac'); assert.equal(live.frames, 175); assert.equal(live.mediaSeconds, 7);
  assert.equal(classify(live, 'ok').verdict, 'online');
  // FFmpeg 8 ends with the time of the one-frame fingerprint output, not the sample's.
  const ffmpeg8 = parseAnalysis('  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 59.94 fps, 59.94 tbr, 90k tbn, start 135.324533\n'
    + 'frame=  182 fps=0.0 q=-0.0 q=-0.0 size=N/A time=00:00:03.03 bitrate=N/A speed=6.28x elapsed=0:00:00.48\nframe=  420 fps=0.0 q=-0.0 Lq=-0.0 size=N/A time=00:00:00.01 bitrate=N/A speed=0.017x elapsed=0:00:00.98\n');
  assert.ok(Math.abs(ffmpeg8.mediaSeconds - 7) < 0.1); assert.equal(classify(ffmpeg8, 'ok').verdict, 'online');
  const frozen = parseAnalysis(head + '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 0.04\n[silencedetect @ 0x2] silence_start: 0\n' + stats + '\n[silencedetect @ 0x2] silence_end: 7 | silence_duration: 7\n');
  assert.ok(frozen.freezeCoverage > 0.9 && frozen.silenceCoverage > 0.9);
  assert.deepEqual(classify(frozen, 'ok'), { verdict: 'placeholder', reason: 'FROZEN_SILENT', frozen: true, silent: true });
  // A still picture with sound is usually a radio station: keep it, but note it.
  const radio = parseAnalysis(head + '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 0\n' + stats);
  assert.deepEqual(classify(radio, 'ok'), { verdict: 'online', reason: 'STILL_PICTURE', frozen: true, silent: false });
  // A short freeze inside real programming is not a dead channel.
  const pause = parseAnalysis(head + '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 3\n[silencedetect @ 0x2] silence_start: 1\n[silencedetect @ 0x2] silence_end: 3\n' + stats);
  assert.equal(classify(pause, 'ok').verdict, 'online');
  const silentRadio = parseAnalysis('  Stream #0:0: Audio: mp2, 48000 Hz\n[silencedetect @ 0x2] silence_start: 0\nsize=N/A time=00:00:07.00 bitrate=N/A\n');
  assert.equal(classify(silentRadio, 'ok').reason, 'SILENT_AUDIO');
  for (const [log, reason] of [['[http @ 0x1] HTTP error 404 Not Found', 'HTTP_NOT_FOUND'], ['Server returned 403 Forbidden (access denied)', 'HTTP_FORBIDDEN'], ['Server returned 5XX Server Error reply', 'HTTP_SERVER_ERROR'],
    ['Failed to resolve hostname x.invalid: No such host is known.', 'DNS_FAILED'], ['Connection to tcp://h:80 failed: Connection refused', 'CONNECTION_REFUSED'], ['x: Invalid data found when processing input', 'INVALID_STREAM']] as const)
    assert.deepEqual(classify(parseAnalysis(log), 'failed'), { verdict: 'offline', reason, frozen: false, silent: true });
  assert.equal(classify(parseAnalysis('Server returned 429 Too Many Requests'), 'failed').verdict, 'inconclusive');
  assert.equal(classify(parseAnalysis(''), 'timeout').reason, 'TIMEOUT');
  // Providers often send dead channels to a looping black file.
  assert.equal(classify(parseAnalysis(head + "[hls @ 0x1] Opening 'https://cdn.example/video/black.ts?token=1' for reading\n" + stats), 'ok').reason, 'PLACEHOLDER_FILE');
});

test('Frame fingerprints match re-encoded copies and ignore featureless frames', () => {
  const frame = Buffer.alloc(72, 17); for (const i of [30, 31, 32, 39, 40, 41]) frame[i] = 120;
  const noisy = Buffer.from(frame); noisy[30] = 118; noisy[5] = 18;
  const a = dhash(frame)!, b = dhash(noisy)!;
  assert.ok(a.informative); assert.ok(hamming(a.fingerprint, b.fingerprint) <= 6);
  assert.equal(dhash(Buffer.alloc(72, 0))!.informative, false);
  assert.equal(dhash(Buffer.alloc(10)), undefined);
  assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64);
});

test('Failures are confirmed before hiding, only while the provider serves other channels, and one success restores', () => {
  const { db, store, health, ids: [a, b, c, d], visible } = lineup(4);
  try {
    // A provider-wide failure (nothing has played yet) hides nothing.
    for (const id of [a, b]) { health.record(id!, result('offline')); health.record(id!, result('offline')); }
    assert.equal(visible().length, 4);
    health.record(c!, result('online'));
    assert.equal(health.record(a!, result('offline'))!.status, 'unchecked');
    assert.equal(visible().length, 4, 'a single failure only schedules a confirmation');
    assert.equal(health.summary(store.status(store.list()[0]!.id).id).confirming, 1);
    assert.equal(health.record(a!, result('offline'))!.status, 'offline');
    assert.ok(!visible().includes(a!)); assert.equal(store.isVisible(a!), false);
    // Rate limits never count.
    health.record(b!, result('inconclusive')); health.record(b!, result('inconclusive'));
    assert.ok(visible().includes(b!));
    health.record(a!, result('online'));
    assert.ok(visible().includes(a!), 'one success restores');
    // Frozen silent screens follow the same confirmation rule.
    health.record(d!, result('placeholder')); assert.ok(visible().includes(d!));
    health.record(d!, result('placeholder')); assert.ok(!visible().includes(d!));
  } finally { db.close(); }
});

test('Shared and learned offline screens, always-listed channels and the hide policy', () => {
  const { db, store, health, source, ids, visible } = lineup(6);
  try {
    health.record(ids[5]!, result('online'));
    const still = (extra: Partial<ProbeResult> = {}) => result('online', { reason: 'STILL_PICTURE', frozen: true, informative: true, fingerprint: slate, ...extra });
    // Two frozen channels on the same picture may be radio; a third makes it the provider's screen.
    health.record(ids[0]!, still()); health.record(ids[1]!, still({ fingerprint: '0000003226000001' }));
    assert.equal(visible().length, 6);
    assert.equal(health.record(ids[2]!, still())!.status, 'placeholder');
    assert.deepEqual(visible().filter(id => ids.slice(0, 3).includes(id)), []);
    // Featureless frames (black, flat colour) never cluster.
    for (const id of ids.slice(3, 5)) health.record(id, still({ informative: false, fingerprint: '0000000000000000' }));
    assert.ok(visible().includes(ids[3]!) && visible().includes(ids[4]!));
    // Learning a screen hides matching channels at once, even if their picture moves.
    health.record(ids[3]!, result('online', { informative: true, fingerprint: 'f0f0f0f0f0f0f0f0' }));
    assert.deepEqual(health.markSlate('owner', ids[3]!), { matched: 1 });
    assert.ok(!visible().includes(ids[3]!));
    assert.equal(health.record(ids[4]!, result('online', { informative: true, fingerprint: 'f0f0f0f0f0f0f0f1' }))!.status, 'placeholder');
    store.editChannel('owner', ids[4]!, { expectedRevision: store.status(source).revision, listing: 'always' }); assert.ok(visible().includes(ids[4]!));
    health.setPolicy('owner', source, { intervalHours: 24, connections: 1, hideFailing: false });
    assert.equal(visible().length, 6);
    health.setPolicy('owner', source, { intervalHours: 24, connections: 1, hideFailing: true });
    health.clearSlates('owner', source);
    assert.equal(health.summary(source).slates, 0);
    assert.equal(health.forSource(source).get(ids[3]!)!.queued, true, 'channels hidden by a cleared screen are rechecked');
  } finally { db.close(); }
});

test('Source removal deletes health state', () => {
  const { db, store, health, source, ids } = lineup(2);
  try {
    health.record(ids[0]!, result('online', { informative: true, fingerprint: slate })); health.markSlate('owner', ids[0]!);
    health.setPolicy('owner', source, { intervalHours: 6, connections: 2, hideFailing: true });
    store.remove('owner', source, store.status(source).revision);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM iptv_channel_health').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM iptv_offline_slates').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('The scheduler respects provider connections, yields to viewers and trusts running relays', async () => {
  const { db, store, health, source, ids } = lineup(5), cache = mkdtempSync(join(tmpdir(), 'tk-health-'));
  const running = new Map<string, (r: ProbeResult) => void>(), aborted: string[] = [];
  const service = new ChannelHealth(store, health, cache, ffmpeg, () => {}, { maxChecks: 4, sampleSeconds: 7, tickMs: 60000 }, async (url, { signal }) => new Promise(done => {
    running.set(url, done); signal?.addEventListener('abort', () => { aborted.push(url); running.delete(url); done(result('inconclusive', { reason: 'CANCELLED' })); });
  }));
  const settle = () => new Promise(done => setTimeout(done, 20));
  try {
    service.relays = { live: id => id === ids[4] };
    service.pump(); await settle();
    assert.equal(running.size, 1, 'default policy is one provider connection');
    // A viewer tuning on this source takes the connection back once the check has exited.
    const viewer = await service.connections.viewer(source);
    assert.equal(aborted.length, 1); assert.equal(service.active(source), 0);
    service.pump(); await settle(); assert.equal(running.size, 0, 'no check while the viewer holds the only connection');
    viewer.release();
    health.setPolicy('owner', source, { intervalHours: 24, connections: 3, hideFailing: true });
    service.pump(); await settle();
    assert.equal(running.size, 3);
    for (const done of [...running.values()]) done(result('online')); running.clear(); await settle();
    // The live channel was marked online from its relay without spending a connection.
    const states = health.forSource(source);
    assert.equal(states.get(ids[4]!)?.reason, 'LIVE_RELAY');
    assert.equal([...states.values()].filter(s => s.status === 'online').length, 4);
  } finally { service.close(); db.close(); }
});

test('Health API is administrator-scoped and never returns stream locations', async () => {
  const { db, store, health, source, ids } = lineup(2), app = Fastify(), cache = mkdtempSync(join(tmpdir(), 'tk-health-'));
  const service = new ChannelHealth(store, health, cache, ffmpeg, () => {}, { maxChecks: 0, sampleSeconds: 7, tickMs: 60000 });
  let role = 'admin';
  registerChannelHealth(app, store, health, service, async () => { if (role !== 'admin') throw Object.assign(new Error('Administrator access required.'), { statusCode: 403 }); return { grant: { accountId: 'owner' } }; });
  try {
    const read = await app.inject({ url: `/api/v1/admin/iptv/sources/${source}/health` });
    assert.equal(read.statusCode, 200); assert.equal(read.json().policy.connections, 1); assert.equal(read.json().summary.unchecked, 2);
    assert.ok(!read.body.includes('streams.invalid'));
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/admin/iptv/sources/${source}/health`, payload: { intervalHours: 0, connections: 2, hideFailing: true } })).json().policy.intervalHours, 0);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/admin/iptv/sources/${source}/health`, payload: { intervalHours: 0, connections: 20, hideFailing: true } })).statusCode === 200, false);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/admin/iptv/sources/${source}/health/check`, payload: {} })).json().queued, 2);
    // Selected channels; ids from elsewhere are ignored.
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/admin/iptv/sources/${source}/health/check-channels`, payload: { ids: [ids[0], ids[0], '00000000-0000-4000-8000-000000000000'] } })).json().queued, 1);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/admin/iptv/sources/${source}/health/check-channels`, payload: { ids: [] } })).statusCode === 200, false);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/admin/iptv/channels/${ids[0]}/health/slate`, payload: {} })).statusCode, 409);
    assert.equal((await app.inject({ url: `/api/v1/admin/iptv/channels/${ids[0]}/health/thumbnail` })).statusCode, 404);
    role = 'viewer';
    assert.equal((await app.inject({ url: `/api/v1/admin/iptv/sources/${source}/health` })).statusCode, 403);
  } finally { service.close(); await app.close(); db.close(); }
});

// Endless generated MPEG-TS per request, like raw IPTV channels: real programming, a provider's
// frozen "unavailable" screen, and a still picture with sound (radio).
const feeds: Record<string, string[]> = {
  '/live.ts': ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
  '/slate.ts': ['-f', 'lavfi', '-i', 'color=c=navy:size=640x360:rate=25,drawbox=x=200:y=150:w=240:h=60:color=white:t=fill', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'],
  '/radio.ts': ['-f', 'lavfi', '-i', 'color=c=darkgreen:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000']
};
test('Real FFmpeg checks tell live channels from dead links and offline screens', { skip: !available && 'FFmpeg is unavailable' }, async () => {
  const server = createServer((req, res) => {
    const input = feeds[req.url ?? ''];
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Not a stream</html>'); return; }
    if (!input) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', ...input, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'mp2', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(res); res.on('close', () => child.kill('SIGKILL'));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cache = mkdtempSync(join(tmpdir(), 'tk-probe-'));
  try {
    const [live, slateFeed, radio, missing, page] = await Promise.all(['/live.ts', '/slate.ts', '/radio.ts', '/gone.ts', '/page'].map((path, i) => probeStream(origin + path, { ffmpeg, sampleSeconds: 6, thumbnailPath: join(cache, `${i}.jpg`) })));
    assert.equal(live!.verdict, 'online'); assert.equal(live!.reason, 'OK'); assert.equal(live!.video?.width, 640); assert.ok(live!.thumbnail && existsSync(join(cache, '0.jpg')));
    assert.equal(slateFeed!.verdict, 'placeholder'); assert.equal(slateFeed!.reason, 'FROZEN_SILENT'); assert.ok(slateFeed!.informative && slateFeed!.fingerprint);
    assert.equal(radio!.verdict, 'online'); assert.equal(radio!.reason, 'STILL_PICTURE');
    assert.deepEqual([missing!.verdict, missing!.reason], ['offline', 'HTTP_NOT_FOUND']);
    assert.deepEqual([page!.verdict, page!.reason], ['offline', 'INVALID_STREAM']);
    // A cancelled check reports nothing about the channel.
    const abort = new AbortController(), pending = probeStream(origin + '/live.ts', { ffmpeg, signal: abort.signal }); setTimeout(() => abort.abort(), 300);
    assert.deepEqual([(await pending).verdict, (await pending).reason], ['inconclusive', 'CANCELLED']);
  } finally { server.close(); }
});
