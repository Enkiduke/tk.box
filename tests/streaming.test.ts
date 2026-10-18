import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRoute, EncoderBudget, eligibleVideoEncode } from '../apps/server/src/streaming/policy.js';
import { hlsArgs,runProcess } from '../apps/server/src/streaming/ffmpeg.js';
import { SharedPipelines, retryNetworkFailure } from '../apps/server/src/streaming/pipelines.js';
const client = {videoCodecs: ['h264:8'], audioCodecs: ['aac'], containers: ['mp4', 'hls']};
const source = {codec: 'h264', width: 1920, height: 1080, container: 'mp4', audioCodec: 'aac'};
test('Auto prefers direct then remux/audio-only then eligible software fallback', () => {
  assert.equal(chooseRoute(source, client).kind, 'direct');
  const remux = chooseRoute({...source, container: 'mkv', audioCodec: 'dts'}, client); assert.equal(remux.kind, 'remux'); assert.equal(remux.audioEncode, true);
  assert.equal(chooseRoute({...source, codec: 'mpeg4'}, client).kind, 'cpu');
  assert.throws(() => chooseRoute({...source, codec: 'mpeg4'}, client, 'original'), {code: 'SOURCE_INCOMPATIBLE'});
  assert.equal(chooseRoute({...source, height: 720, width: 1280}, client, '1080p').kind, 'direct');
  assert.equal(chooseRoute(source, client, '720p').kind, 'cpu');
  assert.equal(eligibleVideoEncode({...source, width: 1080, height: 1920}), true);
});
test('4K HEVC, above-1080p, unknown metadata and subtitle routes cannot create video encode arguments', () => {
  for (const s of [{...source, codec: 'hevc', width: 3840, height: 2160}, {...source, width: 2560, height: 1440}, {...source, width: undefined}, {...source, height: NaN}]) {
    assert.throws(() => chooseRoute(s, client, '720p'), {code: 'QUALITY_NOT_PERMITTED'});
    assert.throws(() => hlsArgs('fixture', 'output', s, {kind: 'cpu', audioEncode: true}), {code: 'QUALITY_NOT_PERMITTED'});
  }
  const hevc = {...source, codec: 'hevc', width: 3840, height: 2160};
  assert.equal(chooseRoute(hevc, {...client, videoCodecs: ['hevc:8']}).kind, 'direct');
  assert.throws(() => chooseRoute({...hevc, container: 'mkv'}, {...client, videoCodecs: ['hevc:8']}), {code: 'QUALITY_NOT_PERMITTED'});
  const copy = hlsArgs('fixture', 'output', source, {kind: 'remux', audioEncode: false}); assert.equal(copy[copy.indexOf('-c:v')+1], 'copy'); assert.ok(!copy.includes('-vf'));
});
test('atomic default-two admission, fail-fast capacity, release and runtime limit changes', async () => {
  let limit = 2; const budget = new EncoderBudget(() => limit), releases: (() => void)[] = [];
  const results = await Promise.allSettled(Array.from({length: 20}, (_, i) => Promise.resolve().then(() => {const r = budget.reserve(String(i)); releases.push(r);} )));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2); assert.equal(budget.count, 2);
  const rejected = results.find(r => r.status === 'rejected'); assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'TRANSCODE_CAPACITY_REACHED');
  limit = 1; assert.throws(() => budget.reserve('new'), {code: 'TRANSCODE_CAPACITY_REACHED'}); assert.equal(budget.count, 2);
  releases[0]!(); releases[0]!(); assert.equal(budget.count, 1); assert.throws(() => budget.reserve('new'));
  releases[1]!(); assert.equal(budget.count, 0); const release = budget.reserve('manual-retry'); release();
  assert.equal(chooseRoute(source, client).kind, 'direct'); // Direct route never asks for an encoder slot.
});
test('shared pipeline single-flight, per-viewer auth, independent release, provider limit and startup failure cleanup', async () => {
  const registry = new SharedPipelines(); let starts = 0, stops = 0, authorizations = 0;
  const key = {sourceId: 'a', channelId: 'c', credentialScope: 'scope', rendition: 'original', tracks: 'default', protocol: 'hls'};
  const provider = {sharingAllowed: true, maxConnections: 1};
  const releases = await Promise.all(Array.from({length: 10}, (_, i) => registry.join(key, provider, String(i), async () => {authorizations++;}, async () => {starts++; return {stop: async () => {stops++;}};})));
  assert.equal(starts, 1); assert.equal(authorizations, 10);
  await assert.rejects(registry.join({...key, channelId: 'other'}, provider, 'other', async () => {}, async () => ({stop: async () => {}})), {code: 'IPTV_CONNECTION_LIMIT'});
  await releases[0]!(); assert.equal(stops, 0);
  await Promise.all(releases.slice(1).map(r => r())); assert.equal(stops, 1); assert.equal(registry.count, 0);
  await assert.rejects(registry.join(key, provider, 'x', async () => {throw new Error('revoked');}, async () => {throw new Error('must not start');})); assert.equal(starts, 1);
  await assert.rejects(registry.join(key, provider, 'x', async () => {}, async () => {throw new Error('startup');})); assert.equal(registry.count, 0);
});
test('IPTV recovery classifier is finite and excludes capacity, policy, auth and rate limits', () => {
  assert.deepEqual([0,1,2,3].map(a => retryNetworkFailure('UPSTREAM_TIMEOUT', a)), [2000,5000,10000,undefined]);
  for (const code of ['TRANSCODE_CAPACITY_REACHED','QUALITY_NOT_PERMITTED','PLEX_ACCESS_DENIED','IPTV_CONNECTION_LIMIT','HTTP_429']) assert.equal(retryNetworkFailure(code, 0), undefined);
});
test('unvalidated CPU fMP4 output is refused and cancelled child processes settle',async()=>{
  assert.throws(()=>hlsArgs('fixture','output',source,{kind:'cpu',audioEncode:true},0,1000,{format:'fmp4'}),{code:'PACKAGING_NOT_VALIDATED'});
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],5000,AbortSignal.timeout(100)),{code:'MEDIA_CANCELLED'});
});
