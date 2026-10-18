import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { EncoderBudget } from '../apps/server/src/streaming/policy.js';
import { LiveTv } from '../apps/server/src/services/live-tv.js';
import { AppError } from '../apps/server/src/errors.js';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const available = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;
// Endless generated MPEG-TS per request, like a raw IPTV channel. MPEG-2/AC-3 needs a video encode; H.264/MP2 only audio.
const profiles: Record<string, string[]> = { '/mpeg2.ts': ['-c:v', 'mpeg2video', '-b:v', '2M', '-c:a', 'ac3'], '/h264.ts': ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'mp2'] };
async function channelServer() {
  const server = createServer((req, res) => {
    const args = profiles[req.url?.split('?')[0] ?? ''];
    if (!args) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', ...args, '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(res); res.on('close', () => child.kill('SIGKILL'));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function lineup(urls: string[]) {
  const store = new IptvStore(openDatabase(':memory:'), new Vault(randomBytes(32))), source = store.create('owner', { kind: 'm3u', name: 'Live' });
  store.ingest('owner', source.id, 0, Buffer.from('#EXTM3U\n' + urls.map((url, i) => `#EXTINF:-1 tvg-id="c${i}",Channel ${i}\n${url}`).join('\n')));
  for (const c of store.adminChannels(source.id)) store.editChannel('owner', c.id, { expectedRevision: store.status(source.id).revision, approval: 'approved' });
  const visible = store.visible();
  return { store, ids: urls.map((_, i) => visible.find(c => c.name === `Channel ${i}`)!.id) };
}
const rejects = (code: string) => (e: unknown) => e instanceof AppError && e.code === code;

test('live relays copy H.264, encode other video, share one upstream per channel and clean up', { skip: !available && 'FFmpeg unavailable', timeout: 120000 }, async () => {
  const { server, origin } = await channelServer(), cache = mkdtempSync(join(tmpdir(), 'tk.box-live-'));
  const { store, ids } = lineup([`${origin}/h264.ts`, `${origin}/mpeg2.ts`]), budget = new EncoderBudget(() => 1);
  const live = new LiveTv(store, budget, cache, ffmpeg, ffprobe);
  try {
    const first = await live.start('viewer-a', ids[0]!), second = await live.start('viewer-b', ids[0]!);
    assert.equal(first.delivery, 'remux', JSON.stringify(first.source)); assert.equal(first.source.videoCodec, 'h264'); assert.equal(live.count, 1);
    assert.ok(!JSON.stringify(first).includes(origin), 'the upstream URI never reaches the browser');
    const playlist = await live.playlist(first.id, 'viewer-a'), segment = playlist.split('\n').find(l => l.startsWith('seg-'))!;
    assert.match(playlist, /#EXTINF/); assert.doesNotMatch(playlist, /ENDLIST/);
    const media = await live.segment(first.id, 'viewer-a', segment); media.body.destroy(); assert.ok(media.size > 0);
    await assert.rejects(live.playlist(first.id, 'viewer-b'), rejects('SESSION_NOT_FOUND'));
    await assert.rejects(live.segment(first.id, 'viewer-a', '../index.m3u8'), rejects('INVALID_MEDIA'));

    const encoded = await live.start('viewer-a', ids[1]!);
    assert.equal(encoded.delivery, 'transcode'); assert.equal(budget.count, 1);
    // The single encoder permit is held, so a second encoded channel would be refused rather than queued.
    live.stop(encoded.id, 'viewer-a'); assert.equal(budget.count, 0);

    live.stop(first.id, 'viewer-a'); assert.equal(live.count, 1, 'another viewer keeps the relay');
    live.stop(second.id, 'viewer-b'); assert.equal(live.count, 0);
  } finally { live.close(); server.close(); }
});

test('live tuning refuses hidden channels and keeps provider credentials out of logs', { skip: !available && 'FFmpeg unavailable', timeout: 60000 }, async () => {
  const { server, origin } = await channelServer(), cache = mkdtempSync(join(tmpdir(), 'tk.box-live-')), logs: string[] = [];
  const { store, ids } = lineup([`${origin}/offline.ts?token=provider-secret`]);
  const live = new LiveTv(store, new EncoderBudget(() => 1), cache, ffmpeg, ffprobe, (m, d) => logs.push(m + JSON.stringify(d)));
  try {
    await assert.rejects(live.start('viewer', '00000000-0000-4000-8000-000000000000'), rejects('CHANNEL_NOT_FOUND'));
    await assert.rejects(live.start('viewer', ids[0]!), rejects('LIVE_TUNE_FAILED'));
    assert.equal(live.count, 0); assert.ok(logs.length > 0); assert.ok(logs.every(l => !l.includes('provider-secret')));
  } finally { live.close(); server.close(); }
});
