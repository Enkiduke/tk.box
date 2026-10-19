import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { CustomChannelStore } from '../apps/server/src/persistence/custom-channels.js';
import { CustomTv, segmentStart } from '../apps/server/src/services/custom-tv.js';
import { LocalMedia } from '../apps/server/src/providers/local-media.js';
import { PartProxy } from '../apps/server/src/providers/part-proxy.js';
import { EncoderBudget } from '../apps/server/src/streaming/policy.js';
import type { PlexAdapter, PlexGrant, PlexMetadata } from '../apps/server/src/providers/plex.js';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version']).status === 0;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const grant = (libraries = ['10']): PlexGrant => ({ accountId: '1', role: 'admin', serverToken: 'token', libraries: libraries.map(key => ({ key, title: 'Movies', type: 'movie' })) });

test('segments within a program stay back to back when FFmpeg falls behind; a new program re-anchors to the clock', () => {
  assert.equal(segmentStart(undefined, 10000, 2000, true), 8000, 'the first segment ends when it is found');
  // FFmpeg stalled for 5 s: the late segment still follows on, so media time and broadcast time stay in step.
  assert.equal(segmentStart(10000, 17000, 2000, false), 10000);
  // The next program starts on the clock, leaving the stall behind it.
  assert.equal(segmentStart(10000, 17000, 2000, true), 15000);
  assert.equal(segmentStart(10000, 11000, 2000, true), 10000, 'never overlaps the previous segment');
});

test('a station joins mid-program, plays the next program on time and cleans up', { skip: !available && 'FFmpeg unavailable', timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk.box-custom-tv-')), media = join(dir, 'media'), cache = join(dir, 'cache');
  const make = (name: string, video: string[]) => {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', ...video, '-c:a', 'aac', join(media, name)]);
    assert.equal(r.status, 0, r.stderr.toString());
  };
  spawnSync(process.platform === 'win32' ? 'cmd' : 'mkdir', process.platform === 'win32' ? ['/c', 'mkdir', media] : ['-p', media]);
  make('a.mp4', ['-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p']);
  make('b.mkv', ['-c:v', 'mpeg4', '-q:v', '5']);
  const items: Record<string, PlexMetadata> = {
    '1': { ratingKey: '1', librarySectionID: '10', title: 'A', duration: 6000, type: 'movie', Media: [{ container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 640, height: 360, Part: [{ key: '/library/parts/1/1/file.mp4', file: join(media, 'a.mp4'), Stream: [{ id: '1', streamType: 1, bitDepth: 8 }] }] }] },
    '2': { ratingKey: '2', librarySectionID: '10', title: 'B', duration: 6000, type: 'movie', Media: [{ container: 'mkv', videoCodec: 'mpeg4', audioCodec: 'aac', width: 640, height: 360, Part: [{ key: '/library/parts/2/2/file.mkv', file: join(media, 'b.mkv'), Stream: [{ id: '2', streamType: 1 }] }] }] },
  };
  const plex = { metadata: async (_g: PlexGrant, id: string) => items[id]! } as unknown as PlexAdapter;
  const db = openDatabase(':memory:'), store = new CustomChannelStore(db), budget = new EncoderBudget(() => 2), logs: string[] = [];
  let retention = 30 * 60000;
  const tv = new CustomTv(store, plex, new LocalMedia({ roots: [media], pathMap: [] }), new PartProxy(plex), budget, cache, () => retention, 64 * 1024 * 1024, ffmpeg, (m, d) => logs.push(m + JSON.stringify(d)));
  // The service's own timers are unref'd (the server keeps the process alive); this stands in for the server.
  const keep = setInterval(() => {}, 1000);
  try {
    const channel = store.create('admin', { name: 'Test' });
    const video = { codec: 'h264', width: 640, height: 360 };
    const added = store.addItems('admin', channel.id, { expectedRevision: channel.revision, ids: ['1', '2'] }, ['1', '2'].map(id => ({ root: { id, type: 'movie' as const, title: id }, items: [{ mediaId: id, kind: 'movie' as const, title: items[id]!.title, durationMs: 6000, video }] })));
    // On air since 2 s ago: tuning joins A two seconds in, and B starts 4 s from now.
    const start = Date.now() - 2000;
    store.publish('admin', channel.id, { expectedRevision: added.channel.revision, expectedPublication: 0 }, start);
    const session = await tv.start('viewer', grant(), channel.id);
    assert.ok(Date.now() - start < 6000, 'the first segment is ready while the joined program is still on');
    assert.equal(session.delivery, 'remux'); assert.match(session.streamUrl, /\/index\.m3u8$/);
    // A viewer without the program's library is refused and its session ends.
    const outsider = await tv.start('outsider', grant(), channel.id);
    await assert.rejects(tv.playlist(outsider.id, 'outsider', grant(['20'])), { code: 'PLEX_ACCESS_DENIED' });
    assert.equal(tv.has(outsider.id), false);
    const second = await tv.start('viewer', grant(), channel.id);
    assert.equal(tv.count, 1, 'viewers of one channel share one station');
    let playlist = '';
    for (let i = 0; i < 60 && !/^#EXT-X-DISCONTINUITY$/m.test(playlist); i++) { await sleep(500); playlist = await tv.playlist(second.id, 'viewer', grant()); }
    assert.match(playlist, /^#EXT-X-DISCONTINUITY$/m, 'the next program follows behind a discontinuity');
    assert.ok(Date.now() - start >= 6000, 'B starts no earlier than its slot');
    // Subtitles follow what aired: A was joined about 2 s in and copied, so it starts on the keyframe at 2 s; B starts at 0.
    const aired = tv.airings(second.id, 'viewer');
    assert.equal(aired.length, 2);
    assert.deepEqual(aired.map(a => tv.airingMedia(second.id, 'viewer', a.id)), ['1', '2']);
    assert.equal(aired[0]!.mediaStartMs, 2000);
    assert.ok(aired[1]!.start > aired[0]!.start && aired[1]!.mediaStartMs < 1000);
    assert.throws(() => tv.airingMedia(second.id, 'viewer', 'missing'), { code: 'SUBTITLE_NOT_FOUND' });
    assert.throws(() => tv.airings(second.id, 'someone-else'), { code: 'SESSION_NOT_FOUND' });
    const name = playlist.split('\n').find(l => /^seg-\d{6}\.ts$/.test(l))!;
    const segment = await tv.segment(second.id, 'viewer', name);
    assert.ok(segment.size > 0); segment.body.destroy();
    await assert.rejects(tv.segment(second.id, 'viewer', '../index.m3u8'), { code: 'INVALID_MEDIA' });
    // One viewer pauses on the first program; the other stays live and the station keeps going.
    const firstStart = Number(new Date(/#EXT-X-PROGRAM-DATE-TIME:(\S+)/.exec(playlist)![1]!).getTime());
    let state = tv.pause(second.id, 'viewer', firstStart + 500);
    assert.equal(state.state, 'PAUSED'); assert.equal(tv.state(session.id, 'viewer').state, 'LIVE');
    const pinned = state.viewerCursorUtc;
    await sleep(2500);
    state = tv.state(second.id, 'viewer'); assert.equal(state.viewerCursorUtc, pinned, 'a paused cursor stays put'); assert.ok(state.behindLiveMs > 2000);
    const delayed = await tv.playlist(second.id, 'viewer', grant()), live = await tv.playlist(session.id, 'viewer', grant());
    assert.match(delayed, /#EXT-X-START:TIME-OFFSET=/); assert.doesNotMatch(live, /#EXT-X-START/);
    const firstSequence = (text: string) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)![1]);
    assert.ok(firstSequence(delayed) <= firstSequence(live));
    assert.ok(new Date(/#EXT-X-PROGRAM-DATE-TIME:(\S+)/.exec(delayed)![1]!).getTime() <= pinned, 'the delayed window reaches back to the paused point');
    state = tv.resume(second.id, 'viewer'); assert.equal(state.state, 'PLAYING_DELAYED');
    await sleep(1000); assert.ok(tv.state(second.id, 'viewer').viewerCursorUtc > pinned, 'a resumed cursor advances but stays behind live');
    assert.equal(tv.goLive(second.id, 'viewer').state, 'LIVE');
    assert.equal(firstSequence(await tv.playlist(second.id, 'viewer', grant())), firstSequence(await tv.playlist(session.id, 'viewer', grant())));
    // Lowering retention below a viewer's delay expires it; Go Live recovers.
    tv.pause(second.id, 'viewer', firstStart + 500); retention = 1000;
    assert.equal(tv.state(second.id, 'viewer').state, 'EXPIRED');
    await assert.rejects(tv.playlist(second.id, 'viewer', grant()), { code: 'BUFFER_EXPIRED' });
    assert.throws(() => tv.resume(second.id, 'viewer'), { code: 'BUFFER_EXPIRED' });
    assert.equal(tv.goLive(second.id, 'viewer').state, 'LIVE'); retention = 30 * 60000;
    assert.ok(tv.usage().bytes > 0);
    tv.stop(session.id, 'viewer'); tv.stop(second.id, 'viewer');
    assert.equal(tv.count, 0);
    for (let i = 0; i < 20 && existsSync(join(cache, 'custom')) && budget.count; i++) await sleep(250);
    await sleep(500);
    assert.equal(budget.count, 0, 'encoder permit released');
    assert.ok(!logs.some(l => l.includes(media)), 'logs never carry media paths');
  } finally { clearInterval(keep); tv.close(); db.close(); await sleep(500); rmSync(dir, { recursive: true, force: true }); }
});
