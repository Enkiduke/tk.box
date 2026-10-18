import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { cpus, platform } from 'node:os';
import { runProcess, LocalMediaWorker, probeLocal, hlsArgs } from '../apps/server/src/streaming/ffmpeg.js';
import { EncoderBudget } from '../apps/server/src/streaming/policy.js';
import { SegmentBuffer, ViewerCursor, renderManifest, type Segment } from '../apps/server/src/streaming/buffer.js';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { ChannelScheduler } from '../apps/server/src/services/scheduler.js';

const root = resolve('.local/media-spike'), ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
await mkdir(root, {recursive: true});
const version = (await runProcess(ffmpeg, ['-version'])).stdout.split('\n')[0];
// Generated test patterns only; no copyrighted footage or real service credentials.
const a = join(root, 'source-a.ts'), b = join(root, 'source-b.avi');
await runProcess(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-threads','2','-preset','veryfast','-pix_fmt','yuv420p','-g','50','-sc_threshold','0','-c:a','aac','-f','mpegts',a]);
await runProcess(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','8','-c:v','mpeg4','-q:v','4','-threads','2','-c:a','pcm_s16le',b]);
const db = openDatabase(':memory:'), scheduler = new ChannelScheduler(db), anchor = Date.now();
scheduler.publish('fixture', [{occurrenceId: 'a', mediaId: 'fixture-a', title: 'Pattern A', durationMs: 8000, mediaOffsetMs: 0}, {occurrenceId: 'b', mediaId: 'fixture-b', title: 'Pattern B', durationMs: 8000, mediaOffsetMs: 0}], 0, anchor, 'fixture');
const joinSlot = scheduler.current('fixture', anchor + 2000); assert.equal(joinSlot.offsetMs, 2000);
const budget = new EncoderBudget(() => 2), worker = new LocalMediaWorker(budget, ffmpeg, ffprobe);
const copyDir = join(root, 'a'), cpuDir = join(root, 'b');
const copy = await worker.hls(a, copyDir, {kind: 'remux', audioEncode: false}, joinSlot.offsetMs, 6000);
const cpu = await worker.hls(b, cpuDir, {kind: 'cpu', audioEncode: true}, 0, 8000);
assert.equal(budget.count, 0);
const segments: Segment[] = []; let cursor = anchor + 2000;
for (const [program, dir] of [['a', copyDir], ['b', cpuDir]] as const) {
  const lines = (await readFile(join(dir, 'index.m3u8'), 'utf8')).split(/\r?\n/); let duration = 0, first = true;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]) * 1000;
    else if (line && !line.startsWith('#')) {
      const file = join(dir, line), bytes = (await stat(file)).size;
      segments.push({id: `${program}-${segments.length}`, start: cursor, end: cursor + duration, bytes, programId: program, revision: 1, uri: `${program}/${line}`, discontinuity: program === 'b' && first, sequence: segments.length});
      cursor += duration; first = false;
    }
  }
}
assert.ok(Math.abs(segments.find(s => s.programId === 'b')!.start - (anchor + 8000)) < 100);
const buffer = new SegmentBuffer(16 * 1024 * 1024, () => 30000);
for (const s of segments) buffer.add(s, s.end);
const paused = new ViewerCursor(buffer, () => 30000), live = new ViewerCursor(buffer, () => 30000);
paused.pause(anchor + 4000, anchor + 4500); paused.resume(anchor + 11000);
assert.equal(paused.position(anchor + 16000), anchor + 9000); assert.equal(live.position(anchor + 16000), anchor + 16000);
await writeFile(join(root, 'joined.m3u8'), renderManifest(segments, true));
await writeFile(join(root, 'delayed.m3u8'), renderManifest(buffer.from(anchor + 4000), true));
const decoded = await runProcess(ffmpeg, ['-hide_banner','-loglevel','warning','-nostdin','-protocol_whitelist','file,crypto,data','-i',join(root,'joined.m3u8').replaceAll('\\','/'),'-map','0:v:0','-progress','pipe:1','-f','null','-']);
const delayedDecoded = await runProcess(ffmpeg, ['-hide_banner','-loglevel','warning','-nostdin','-protocol_whitelist','file,crypto,data','-i',join(root,'delayed.m3u8').replaceAll('\\','/'),'-map','0:v:0','-progress','pipe:1','-f','null','-']);
const frames = Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);
assert.ok(frames >= 345 && frames <= 355, `Expected about 350 decoded frames, got ${frames}`);
const delayedFrames = Number([...delayedDecoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]); assert.ok(delayedFrames > 0 && delayedFrames < frames);
// Compare compressed video packet payload hashes across a full TS -> HLS copy route.
const fullCopyDir = join(root, 'copy-verification'); await worker.hls(a, fullCopyDir, {kind: 'remux', audioEncode: false});
const hash = async (input: string) => (await runProcess(ffmpeg, ['-hide_banner','-loglevel','error','-protocol_whitelist','file,crypto,data','-i',input.replaceAll('\\','/'),'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
const originalHash = await hash(a), remuxHash = await hash(join(fullCopyDir, 'index.m3u8')); assert.equal(remuxHash, originalHash);
let blockedBeforeSpawn = false;
try { hlsArgs(a, root, {codec:'hevc',width:3840,height:2160,container:'mp4'}, {kind:'cpu',audioEncode:true}); } catch {blockedBeforeSpawn = true;}
assert.ok(blockedBeforeSpawn);
paused.goLive(); assert.equal(paused.position(anchor + 16000), anchor + 16000);
const report = {generatedAt: new Date().toISOString(), environment: {platform: platform(), cpu: cpus()[0]?.model, ffmpeg: version},
  sourceA: await probeLocal(a, ffprobe), sourceB: await probeLocal(b, ffprobe),
  fixtureJoinOffsetMs: joinSlot.offsetMs, boundaryErrorMs: segments.find(s => s.programId === 'b')!.start - (anchor + 8000),
  streamCopyMs: Math.round(copy.elapsedMs), cpuEncodeMs: Math.round(cpu.elapsedMs), fixtureDurationMs: 8000,
  compressedVideoHashPreserved: originalHash === remuxHash, decodedFramesAcrossBoundary: frames, delayedManifestDecodedFrames: delayedFrames,
  packetCorruptionWarningsAtDiscontinuity: decoded.packetCorruptionWarnings,
  segmentBytes: buffer.bytes, segmentCount: segments.length, sharedBytesForTwoViewerCursors: buffer.bytes,
  blocked4kHevcBeforeSpawn: blockedBeforeSpawn,
  limitations: ['Generated 320x180 fixtures on a Windows development host only.', 'Not a Plex, provider, browser, 1080p load or 4K direct-play verification.', 'No continuous live FFmpeg playout, keyframe-start latency or production disk-pressure benchmark proven.', 'Pause state uses simulated clocks over real retained HLS bytes; browser-level pause continuity still needs testing.']};
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); db.close();
console.log(JSON.stringify(report, null, 2));
