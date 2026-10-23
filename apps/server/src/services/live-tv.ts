import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError, requireThat } from '../errors.js';
import { opaque } from '../security/vault.js';
import { runProcess } from '../streaming/ffmpeg.js';
import { assertVideoEncode, type EncoderBudget } from '../streaming/policy.js';
import { ProviderConnections, type ConnectionLease } from '../streaming/provider-connections.js';
import type { IptvStore } from '../persistence/iptv-store.js';

export type LiveDelivery = 'remux' | 'transcode';
export type LiveSource = { videoCodec?: string; audioCodec?: string; width?: number; height?: number };
type Relay = {
  key: string; channelId: string; sourceId: string; url: string; dir: string; viewers: Set<string>; child?: ChildProcess; exited: boolean;
  encode: boolean; release: () => void; restarts: number; live: boolean; stopped: boolean; ready: Promise<void>; source?: LiveSource; stderr: string;
  lease?: ConnectionLease; cancel: AbortController;
};
export type LiveObserver = { tuned?: (channelId: string) => void; tuneFailed?: (channelId: string) => void };
type Viewer = { id: string; hash: string; channelId: string; seen: number };
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const probeSchema = z.object({ streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), pix_fmt: z.string().optional() })) });
const segmentName = /^seg-\d{6}\.ts$/;
const browserVideo = new Set(['yuv420p', 'yuvj420p']);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

// Live IPTV delivery. One FFmpeg relay per channel is shared by every viewer of
// that channel, so a provider connection limit is spent once per channel. FFmpeg
// reads HLS or raw MPEG-TS upstream and writes a short local HLS window: H.264
// video is copied, anything else is encoded within the shared CPU budget, and
// audio is always AAC because browsers cannot decode AC-3/MP2 from IPTV feeds.
// Upstream URIs stay server-side; the browser only sees this session's paths. Each relay holds
// one of the server's provider connections (shared with channel checks) until FFmpeg exits.
export class LiveTv {
  private relays = new Map<string, Relay>();
  private viewers = new Map<string, Viewer>();
  private root: string;
  private timer: NodeJS.Timeout;
  observer: LiveObserver = {};
  connections = new ProviderConnections(() => Number.POSITIVE_INFINITY);
  constructor(private store: IptvStore, private budget: EncoderBudget, cacheDir: string, private ffmpeg = 'ffmpeg', private ffprobe = 'ffprobe',
    private log: (message: string, detail: Record<string, unknown>) => void = () => {}, private options = { maxRelays: 8, maxPerViewer: 4, idleMs: 45000, readyMs: 30000 }) {
    this.root = join(cacheDir, 'live', `${process.pid}-${opaque().slice(0, 8)}`);
    void this.reapStale(join(cacheDir, 'live'));
    this.timer = setInterval(() => this.sweep(), 10000); this.timer.unref();
  }
  async start(hash: string, channelId: string) {
    const channel = this.store.tune(channelId);
    requireThat([...this.viewers.values()].filter(v => v.hash === hash).length < this.options.maxPerViewer, 'PLAYBACK_SESSION_LIMIT', 'Too many live channels are open. Stop one first.', 429);
    let relay = this.relays.get(channelId);
    if (!relay) {
      requireThat(this.relays.size < this.options.maxRelays, 'LIVE_CAPACITY_REACHED', 'Too many channels are being watched right now. Please try again shortly.', 503);
      const key = opaque().slice(0, 16);
      relay = { key, channelId, sourceId: channel.sourceId, url: channel.streamUrl, dir: join(this.root, key), viewers: new Set(), exited: true, encode: false, release: () => {}, restarts: 0, live: false, stopped: false, ready: Promise.resolve(), stderr: '', cancel: new AbortController() };
      this.relays.set(channelId, relay);
      const created = relay;
      created.ready = this.prepare(created);
      created.ready.then(() => this.observer.tuned?.(channelId), error => {
        this.destroy(created);
        if (error instanceof AppError && ['LIVE_TUNE_FAILED', 'LIVE_TUNE_TIMEOUT'].includes(error.code)) this.observer.tuneFailed?.(channelId);
      });
    }
    const viewer: Viewer = { id: opaque(), hash, channelId, seen: Date.now() };
    this.viewers.set(viewer.id, viewer); relay.viewers.add(viewer.id);
    try { await relay.ready; } catch (e) { this.stop(viewer.id, hash); throw e; }
    requireThat(this.viewers.has(viewer.id), 'SESSION_NOT_FOUND', 'Live session was stopped.', 409);
    return { id: viewer.id, streamUrl: `/api/v1/live/sessions/${viewer.id}/index.m3u8`, delivery: (relay.encode ? 'transcode' : 'remux') as LiveDelivery,
      channel: { id: channel.id, name: channel.name, number: channel.number }, source: relay.source ?? {} };
  }
  owned(id: string, hash: string) {
    const viewer = this.viewers.get(id);
    requireThat(viewer?.hash === hash, 'SESSION_NOT_FOUND', 'Live session is unavailable.', 404);
    return viewer;
  }
  async playlist(id: string, hash: string) {
    const viewer = this.owned(id, hash), relay = this.relays.get(viewer.channelId);
    // An administrator disabling or removing a channel ends its delivery.
    if (!relay || !this.store.isVisible(viewer.channelId)) { this.stop(id, hash); throw new AppError('CHANNEL_NOT_FOUND', 'Channel is no longer available.', 404); }
    viewer.seen = Date.now();
    let text: string;
    try { text = await readFile(join(relay.dir, 'index.m3u8'), 'utf8'); } catch { throw new AppError('LIVE_UNAVAILABLE', 'The channel stream is restarting.', 503, true); }
    requireThat(text.startsWith('#EXTM3U'), 'LIVE_UNAVAILABLE', 'The channel stream is restarting.', 503);
    // Only FFmpeg's own segment names are served; nothing else in the playlist can point elsewhere.
    return text.split(/\r?\n/).filter(line => !line || line.startsWith('#') || segmentName.test(line.trim())).join('\n');
  }
  async segment(id: string, hash: string, name: string) {
    requireThat(segmentName.test(name), 'INVALID_MEDIA', 'Unsupported stream path.', 400);
    const viewer = this.owned(id, hash), relay = this.relays.get(viewer.channelId);
    requireThat(relay, 'SESSION_NOT_FOUND', 'Live session is unavailable.', 404);
    viewer.seen = Date.now();
    const path = join(relay.dir, name);
    const size = await stat(path).then(s => s.size, () => { throw new AppError('SEGMENT_EXPIRED', 'Segment is no longer available.', 404); });
    return { size, body: createReadStream(path) };
  }
  stop(id: string, hash: string) {
    const viewer = this.viewers.get(id); if (!viewer || viewer.hash !== hash) return;
    this.viewers.delete(id);
    const relay = this.relays.get(viewer.channelId);
    relay?.viewers.delete(id);
    if (relay && !relay.viewers.size) this.destroy(relay);
  }
  stopWhere(matches: (v: { id: string; hash: string }) => boolean) { for (const v of [...this.viewers.values()]) if (matches(v)) this.stop(v.id, v.hash); }
  close() { clearInterval(this.timer); for (const relay of [...this.relays.values()]) this.destroy(relay); void rm(this.root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); }
  get count() { return this.relays.size; }
  isLive(channelId: string) { return !!this.relays.get(channelId)?.live; }
  // Administrator activity: how a viewer's channel is being delivered right now.
  watching(id: string) {
    const viewer = this.viewers.get(id), relay = viewer && this.relays.get(viewer.channelId);
    return relay && { delivery: (relay.encode ? 'transcode' : 'remux') as LiveDelivery, source: relay.source ?? {}, restarts: relay.restarts };
  }
  sweep(now = Date.now()) { for (const v of [...this.viewers.values()]) if (now - v.seen > this.options.idleMs) this.stop(v.id, v.hash); }

  private async prepare(relay: Relay) {
    relay.lease = await this.connections.viewer(relay.cancel.signal);
    if (relay.stopped) { relay.lease.release(); throw new AppError('MEDIA_CANCELLED', 'Live session was stopped.', 409); }
    await mkdir(relay.dir, { recursive: true, mode: 0o700 });
    this.spawn(relay, false); await this.waitReady(relay);
    const source = await this.probe(relay), video = source.videoCodec;
    relay.source = { videoCodec: video, audioCodec: source.audioCodec, width: source.width, height: source.height };
    if (video && !(video === 'h264' && browserVideo.has(source.pixFmt ?? 'yuv420p'))) {
      // Same admission rules as VOD: verified 1080p-or-lower sources only, one shared encoder permit.
      assertVideoEncode({ codec: video, width: source.width, height: source.height, container: 'mpegts' });
      relay.release = this.budget.reserve(`live:${relay.key}`); relay.encode = true;
      await this.kill(relay); await rm(relay.dir, { recursive: true, force: true, maxRetries: 5 }); await mkdir(relay.dir, { recursive: true, mode: 0o700 });
      relay.stderr = ''; this.spawn(relay, false); await this.waitReady(relay);
    }
    relay.live = true;
  }
  private args(relay: Relay, append: boolean) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-user_agent', userAgent];
    // Raw MPEG-TS reconnects in place. HLS is read in real time: a provider "channel" that is
    // really a finished VOD playlist would otherwise be consumed at full speed past the window.
    if (/\.m3u8?$/i.test(new URL(relay.url).pathname)) args.push('-re');
    else args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    args.push('-rw_timeout', '15000000', '-fflags', '+genpts+discardcorrupt', '-i', relay.url, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn');
    if (relay.encode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-bf', '0', '-threads', '2', '-vf', 'yadif=deint=interlaced', '-force_key_frames', 'expr:gte(t,n_forced*2)');
    else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '8', '-hls_delete_threshold', '4',
      '-hls_flags', `delete_segments+independent_segments+omit_endlist+temp_file${append ? '+append_list+discont_start' : ''}`,
      '-hls_segment_filename', join(relay.dir, 'seg-%06d.ts').replaceAll('\\', '/'), join(relay.dir, 'index.m3u8').replaceAll('\\', '/'));
    return args;
  }
  private spawn(relay: Relay, append: boolean) {
    const child = spawn(this.ffmpeg, this.args(relay, append), { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    relay.child = child; relay.exited = false;
    child.stderr!.on('data', (b: Buffer) => { relay.stderr = (relay.stderr + b.toString()).slice(-2000); });
    child.on('error', () => { relay.exited = true; relay.stderr += '\nFFmpeg could not be started.'; });
    child.on('close', code => {
      if (relay.child !== child) return;
      relay.exited = true;
      if (relay.stopped) return;
      this.log('live relay exited', { channelId: relay.channelId, code, restarts: relay.restarts, detail: this.redact(relay) });
      // Upstream hiccups are common; resume into the same window behind a discontinuity.
      if (relay.live && relay.viewers.size && relay.restarts < 5) {
        relay.restarts++;
        setTimeout(() => { if (!relay.stopped && relay.child === child) this.spawn(relay, true); }, 2000).unref();
      }
    });
  }
  private async waitReady(relay: Relay) {
    const deadline = Date.now() + this.options.readyMs;
    while (Date.now() < deadline) {
      if (relay.stopped) throw new AppError('MEDIA_CANCELLED', 'Live session was stopped.', 409);
      try { if (/#EXTINF/.test(await readFile(join(relay.dir, 'index.m3u8'), 'utf8'))) return; } catch { /* not written yet */ }
      if (relay.exited) {
        this.log('live tune failed', { channelId: relay.channelId, detail: this.redact(relay) });
        throw new AppError('LIVE_TUNE_FAILED', 'The channel could not be tuned. The provider may be offline, limit connections, or use an unsupported format.', 502, true);
      }
      await sleep(250);
    }
    throw new AppError('LIVE_TUNE_TIMEOUT', 'The channel did not start in time. Please try again.', 504, true);
  }
  private async probe(relay: Relay) {
    const text = await readFile(join(relay.dir, 'index.m3u8'), 'utf8'), first = text.split(/\r?\n/).find(l => segmentName.test(l.trim()))?.trim();
    requireThat(first, 'LIVE_TUNE_FAILED', 'The channel produced no media.', 502);
    const { stdout } = await runProcess(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-of', 'json', join(relay.dir, first).replaceAll('\\', '/')], 15000);
    const streams = probeSchema.parse(JSON.parse(stdout)).streams, video = streams.find(s => s.codec_type === 'video'), audio = streams.find(s => s.codec_type === 'audio');
    return { videoCodec: video?.codec_name, pixFmt: video?.pix_fmt, width: video?.width, height: video?.height, audioCodec: audio?.codec_name };
  }
  private kill(relay: Relay) {
    const child = relay.child;
    if (!child || relay.exited) return Promise.resolve();
    return new Promise<void>(done => { child.once('close', () => done()); child.kill('SIGKILL'); });
  }
  private destroy(relay: Relay) {
    if (relay.stopped) return;
    relay.stopped = true; relay.release(); relay.cancel.abort();
    const lease = relay.lease; lease?.closing();
    if (this.relays.get(relay.channelId) === relay) this.relays.delete(relay.channelId);
    for (const id of relay.viewers) this.viewers.delete(id);
    // The connection is only free once FFmpeg has exited and closed its upstream socket.
    void this.kill(relay).finally(() => lease?.release()).then(() => rm(relay.dir, { recursive: true, force: true, maxRetries: 5 })).catch(() => {});
  }
  // Windows of processes that ended without closing (crash, forced stop) are removed.
  private async reapStale(parent: string) {
    for (const name of await readdir(parent).catch(() => [] as string[])) {
      const pid = Number(name.split('-')[0]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try { process.kill(pid, 0); } catch { await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); }
    }
  }
  // FFmpeg errors can quote the upstream URI, which may embed provider credentials.
  private redact(relay: Relay) { return relay.stderr.replaceAll(relay.url, '<stream>').replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '<url>').trim().slice(-600); }
}
