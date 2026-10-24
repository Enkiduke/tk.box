import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamGuard, ffmpegEnv, protocols } from '../apps/server/src/streaming/stream-guard.js';
import { args } from '../apps/server/src/services/stream-probe.js';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg', available = spawnSync(ffmpeg, ['-version']).status === 0;
const listen = (server: Server) => new Promise<number>(done => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));
const proxyPort = async (guard: StreamGuard) => Number(new URL(await guard.url()).port);
// One HTTP request through the proxy, in absolute form as FFmpeg sends it.
const viaProxy = (port: number, url: string) => new Promise<{ status: number; body: string }>((done, fail) => {
  const req = request({ host: '127.0.0.1', port, path: url, headers: { host: new URL(url).host } }, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => done({ status: res.statusCode ?? 0, body }));
  });
  req.on('error', fail); req.end();
});
// The proxy's answer to a CONNECT, as its status line.
const tunnel = (port: number, target: string) => new Promise<string>((done, fail) => {
  const socket = connect(port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  socket.once('data', b => { done(b.toString().split('\r\n')[0]!); socket.destroy(); }); socket.on('error', fail);
});

test('the stream guard refuses loopback, private and mixed addresses, for HTTP and CONNECT', async t => {
  const resolved: Record<string, string[]> = { 'lan.test': ['10.0.0.5'], 'mixed.test': ['93.184.216.34', '192.168.1.2'] };
  const guard = new StreamGuard(async host => (resolved[host] ?? []).map(address => ({ address, family: 4 })));
  t.after(() => guard.close());
  const port = await proxyPort(guard);
  for (const url of ['http://127.0.0.1:32400/library', 'http://lan.test/stream.ts', 'http://mixed.test/stream.ts', 'http://[::1]/x', 'http://unknown.test/x'])
    assert.equal((await viaProxy(port, url)).status, 403, url);
  for (const target of ['127.0.0.1:443', 'lan.test:443', 'mixed.test:443', '169.254.169.254:80']) assert.match(await tunnel(port, target), / 403 /, target);
  assert.match(await tunnel(port, 'no-port.test'), / 400 /);
  // Origin-form requests are not proxy requests.
  assert.equal(await new Promise(done => request({ host: '127.0.0.1', port, path: '/x' }, res => { res.resume(); done(res.statusCode); }).end()), 400);
});

test('the stream guard forwards allowed HTTP and tunnels allowed CONNECT to the checked address', async t => {
  const upstream = createServer((req, res) => res.end(`seen ${req.url} ${req.headers.host}`)), upstreamPort = await listen(upstream);
  const asked: string[] = [], guard = new StreamGuard(async host => { asked.push(host); return [{ address: '127.0.0.1', family: 4 }]; }, () => true);
  t.after(() => { guard.close(); upstream.close(); });
  const port = await proxyPort(guard);
  const answer = await viaProxy(port, `http://provider.test:${upstreamPort}/live/1.ts?x=1`);
  assert.equal(answer.status, 200); assert.equal(answer.body, `seen /live/1.ts?x=1 provider.test:${upstreamPort}`);
  assert.match(await tunnel(port, `provider.test:${upstreamPort}`), / 200 /);
  assert.deepEqual(asked, ['provider.test', 'provider.test']);
});

test('FFmpeg runs through the proxy, without no_proxy, only when one is given', () => {
  const plain = args('https://p.test/1.ts', 7, false), guarded = args('https://p.test/1.ts', 7, false, undefined, 'http://127.0.0.1:9');
  assert.equal(plain[plain.indexOf('-protocol_whitelist') + 1], 'http,https,tcp,tls,crypto');
  assert.equal(guarded[guarded.indexOf('-protocol_whitelist') + 1], 'http,https,tcp,tls,crypto,httpproxy');
  assert.equal(protocols(undefined).includes('httpproxy'), false);
  // Any spelling of a proxy variable is replaced; without a guard, a configured proxy is left alone.
  assert.deepEqual(ffmpegEnv('http://127.0.0.1:9', { PATH: '/bin', no_proxy: '*', NO_PROXY: '*', HTTP_PROXY: 'http://elsewhere' }), { PATH: '/bin', http_proxy: 'http://127.0.0.1:9' });
  assert.deepEqual(ffmpegEnv(undefined, { PATH: '/bin', No_Proxy: '*', http_proxy: 'http://corp' }), { PATH: '/bin', http_proxy: 'http://corp' });
});

test('sources block local-network streams until an administrator allows them', () => {
  const store = new IptvStore(openDatabase(':memory:'), new Vault(randomBytes(32))), source = store.create('owner', { kind: 'm3u', name: 'Tuner' });
  store.ingest('owner', source.id, 0, Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nhttp://192.168.1.20:5004/auto/v1\n'));
  const channel = store.adminChannels(source.id)[0]!.id;
  assert.equal(store.status(source.id).allowPrivateStreams, false);
  assert.equal(store.streamFor(channel).allowPrivate, false);
  const allowed = store.policy('owner', source.id, { expectedRevision: store.status(source.id).revision, intervalHours: 12, allowPrivateStreams: true });
  assert.equal(allowed.allowPrivateStreams, true); assert.equal(store.streamFor(channel).allowPrivate, true);
  // An interval-only change keeps the setting.
  assert.equal(store.policy('owner', source.id, { expectedRevision: allowed.revision, intervalHours: 6 }).allowPrivateStreams, true);
});

test('real FFmpeg sends HTTP, HLS segments and HTTPS through the guard', { skip: !available && 'FFmpeg is not installed' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-guard-')), clip = join(dir, 'clip.ts');
  assert.equal(spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', '-c:v', 'mpeg2video', '-f', 'mpegts', clip]).status, 0);
  const bytes = readFileSync(clip);
  // Media on one port; a playlist on another names that port by an absolute URL.
  const media = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'video/mp2t' }); res.end(bytes); }), mediaPort = await listen(media);
  const playlist = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:${mediaPort}/seg.ts\n#EXT-X-ENDLIST\n`); }), playlistPort = await listen(playlist);
  const run = (proxy: string, url: string) => new Promise<number | null>(done => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', protocols(proxy), '-rw_timeout', '5000000', '-i', url, '-f', 'null', '-'], { env: ffmpegEnv(proxy), stdio: 'ignore' });
    child.on('close', done);
  });
  const seen: string[] = [], open = new StreamGuard(undefined, address => { seen.push(address); return true; }), closed = new StreamGuard(undefined, address => { seen.push(`refused ${address}`); return false; });
  t.after(() => { open.close(); closed.close(); media.close(); playlist.close(); });
  assert.equal(await run(await open.url(), `http://127.0.0.1:${playlistPort}/index.m3u8`), 0);
  // The playlist and its segment both went through the proxy.
  assert.ok(seen.length >= 2, String(seen));
  seen.length = 0;
  assert.notEqual(await run(await closed.url(), `http://127.0.0.1:${mediaPort}/clip.ts`), 0);
  assert.deepEqual(seen, ['refused 127.0.0.1']);
  seen.length = 0;
  // HTTPS goes through CONNECT, so the guard sees it before any TLS.
  assert.notEqual(await run(await closed.url(), `https://127.0.0.1:${mediaPort}/clip.ts`), 0);
  assert.deepEqual(seen, ['refused 127.0.0.1']);
});
