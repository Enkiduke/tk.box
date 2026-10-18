import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, requireThat } from '../errors.js';
import { opaque } from '../security/vault.js';
import { assertVideoEncode, type EncoderBudget } from '../streaming/policy.js';
import type { CustomChannelStore } from '../persistence/custom-channels.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import type { LocalMedia } from '../providers/local-media.js';
import type { PartProxy } from '../providers/part-proxy.js';
import type { Slot } from './scheduler.js';
import type { LiveDelivery, LiveSource } from './live-tv.js';

type Station = {
  key: string; channelId: string; dir: string; viewers: Set<string>; grant: PlexGrant; stopped: boolean; child?: ChildProcess;
  ready: Promise<void>; output: boolean; stderr: string; library?: string; encode: boolean; source?: LiveSource;
};
type Viewer = { id: string; hash: string; channelId: string; seen: number };
type Input = { path: string; demuxer?: string; protocols: string };
const segmentName = /^seg-\d{6}\.ts$/;
const sleep = (ms: number) => new Promise(done => setTimeout(done, Math.max(0, ms)).unref());

// Custom channel playout. A channel is a schedule, not a running video: a station starts when the first viewer
// tunes in and stops when the last one leaves. It plays one program at a time, joining the airing program at its
// clock position and moving to whatever the schedule says is next, so publishing and the clock are always honored.
// Each program is one FFmpeg run, read in real time, appending to one shared HLS window behind a discontinuity.
// Browser-safe H.264 is copied; other 1080p-or-lower video is encoded within the shared encoder budget; audio is AAC.
// Plex history is never touched: media is read from disk or as a plain part request, and no timeline is reported.
export class CustomTv {
  private stations = new Map<string, Station>();
  private viewers = new Map<string, Viewer>();
  private root: string;
  private timer: NodeJS.Timeout;
  constructor(private store: CustomChannelStore, private plex: PlexAdapter, private local: LocalMedia, private parts: PartProxy, private budget: EncoderBudget, cacheDir: string,
    private ffmpeg = 'ffmpeg', private log: (message: string, detail: Record<string, unknown>) => void = () => {},
    private options = { maxStations: 6, maxPerViewer: 4, idleMs: 45000, readyMs: 30000 }) {
    this.root = join(cacheDir, 'custom', `${process.pid}-${opaque().slice(0, 8)}`);
    void this.reapStale(join(cacheDir, 'custom'));
    this.timer = setInterval(() => this.sweep(), 10000); this.timer.unref();
  }
  has(id: string) { return this.viewers.has(id); }
  async start(hash: string, grant: PlexGrant, channelId: string) {
    const channel = this.store.tune(channelId);
    requireThat([...this.viewers.values()].filter(v => v.hash === hash).length < this.options.maxPerViewer, 'PLAYBACK_SESSION_LIMIT', 'Too many live channels are open. Stop one first.', 429);
    let station = this.stations.get(channelId);
    if (!station) {
      requireThat(this.stations.size < this.options.maxStations, 'LIVE_CAPACITY_REACHED', 'Too many channels are being watched right now. Please try again shortly.', 503);
      const key = opaque().slice(0, 16), created: Station = { key, channelId, dir: join(this.root, key), viewers: new Set(), grant, stopped: false, ready: Promise.resolve(), output: false, stderr: '', encode: false };
      this.stations.set(channelId, created);
      created.ready = mkdir(created.dir, { recursive: true, mode: 0o700 }).then(() => { void this.run(created); return this.waitReady(created); });
      created.ready.catch(() => this.destroy(created));
      station = created;
    }
    station.grant = grant;
    const viewer: Viewer = { id: opaque(), hash, channelId, seen: Date.now() };
    this.viewers.set(viewer.id, viewer); station.viewers.add(viewer.id);
    try { await station.ready; } catch (e) { this.stop(viewer.id, hash); throw e; }
    requireThat(this.viewers.has(viewer.id), 'SESSION_NOT_FOUND', 'Live session was stopped.', 409);
    this.authorize(station, grant, viewer);
    return { id: viewer.id, streamUrl: `/api/v1/live/sessions/${viewer.id}/index.m3u8`, delivery: (station.encode ? 'transcode' : 'remux') as LiveDelivery, channel, source: station.source ?? {} };
  }
  private owned(id: string, hash: string) {
    const viewer = this.viewers.get(id);
    requireThat(viewer?.hash === hash, 'SESSION_NOT_FOUND', 'Live session is unavailable.', 404);
    return viewer;
  }
  // Every viewer needs access to the library of what is airing, checked again on each playlist.
  private authorize(station: Station, grant: PlexGrant, viewer: Viewer) {
    if (station.library && !grant.libraries.some(l => l.key === station.library)) { this.stop(viewer.id, viewer.hash); throw new AppError('PLEX_ACCESS_DENIED', 'This program isn’t available to your Plex account.', 403); }
  }
  async playlist(id: string, hash: string, grant: PlexGrant) {
    const viewer = this.owned(id, hash), station = this.stations.get(viewer.channelId);
    if (!station || !this.store.isVisible(viewer.channelId)) { this.stop(id, hash); throw new AppError('CHANNEL_NOT_FOUND', 'Channel is no longer available.', 404); }
    this.authorize(station, grant, viewer); station.grant = grant; viewer.seen = Date.now();
    let text: string;
    try { text = await readFile(join(station.dir, 'index.m3u8'), 'utf8'); } catch { throw new AppError('LIVE_UNAVAILABLE', 'The channel stream is restarting.', 503, true); }
    requireThat(text.startsWith('#EXTM3U'), 'LIVE_UNAVAILABLE', 'The channel stream is restarting.', 503);
    return text.split(/\r?\n/).filter(line => !line || line.startsWith('#') || segmentName.test(line.trim())).join('\n');
  }
  async segment(id: string, hash: string, name: string) {
    requireThat(segmentName.test(name), 'INVALID_MEDIA', 'Unsupported stream path.', 400);
    const viewer = this.owned(id, hash), station = this.stations.get(viewer.channelId);
    requireThat(station, 'SESSION_NOT_FOUND', 'Live session is unavailable.', 404);
    viewer.seen = Date.now();
    const path = join(station.dir, name);
    const size = await stat(path).then(s => s.size, () => { throw new AppError('SEGMENT_EXPIRED', 'Segment is no longer available.', 404); });
    return { size, body: createReadStream(path) };
  }
  stop(id: string, hash: string) {
    const viewer = this.viewers.get(id); if (!viewer || viewer.hash !== hash) return;
    this.viewers.delete(id);
    const station = this.stations.get(viewer.channelId);
    station?.viewers.delete(id);
    if (station && !station.viewers.size) this.destroy(station);
  }
  stopWhere(matches: (v: { id: string; hash: string }) => boolean) { for (const v of [...this.viewers.values()]) if (matches(v)) this.stop(v.id, v.hash); }
  close() { clearInterval(this.timer); for (const s of [...this.stations.values()]) this.destroy(s); void rm(this.root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); }
  sweep(now = Date.now()) { for (const v of [...this.viewers.values()]) if (now - v.seen > this.options.idleMs) this.stop(v.id, v.hash); }
  get count() { return this.stations.size; }

  // The playout loop: always play what the clock says is airing, from where it is now.
  private async run(s: Station) {
    let idle = 0;
    while (!s.stopped) {
      const now = Date.now();
      let slot: Slot;
      try { slot = this.store.scheduler.current(s.channelId, now); } catch { this.destroy(s); return; }
      // Too little of this program is left to be worth starting; wait for the next one.
      if (slot.end - now < 1000) { await sleep(slot.end - now + 1); continue; }
      const started = Date.now(), ok = await this.program(s, slot).catch(e => { this.log('custom program failed', { channelId: s.channelId, code: e instanceof AppError ? e.code : 'ERROR' }); return false; });
      if (s.stopped) return;
      // A failed or short file fills the rest of its slot with a blank screen, so the next program still starts on time.
      const left = slot.end - Date.now();
      if (left >= (ok ? 3000 : 1000)) {
        const shown = await this.slate(s, left);
        if (!shown && !ok && Date.now() - started < 2000) await sleep(Math.min(left, 2000 * ++idle));
      } else idle = 0;
    }
  }
  private async program(s: Station, slot: Slot) {
    const item = await this.plex.metadata(s.grant, slot.entry.mediaId), media = item.Media[0];
    requireThat(media, 'SOURCE_INCOMPATIBLE', 'No playable media.', 422);
    s.library = item.librarySectionID;
    const video = media.Part[0]?.Stream?.find(st => st.streamType === 1), encode = !(media.videoCodec === 'h264' && (video?.bitDepth ?? 8) <= 8);
    let release = () => {};
    if (encode) { assertVideoEncode({ codec: media.videoCodec, width: media.width, height: media.height, container: media.container }); release = this.budget.reserve(`custom:${s.key}`); }
    let input: Input, done = () => {};
    try {
      const part = await this.local.open(s.grant, item);
      if (part) { await part.handle.close(); input = { path: part.path, demuxer: part.demuxer, protocols: 'file' }; }
      else { const proxied = await this.parts.url(s.grant, item); done = proxied.release; input = { path: proxied.url, protocols: 'http,tcp' }; }
      s.encode = encode; s.source = { videoCodec: media.videoCodec, audioCodec: media.audioCodec, width: media.width, height: media.height };
      // Join at the clock position as of this moment, so startup time never leaves the channel behind its schedule.
      const now = Date.now(), offsetMs = slot.entry.mediaOffsetMs + Math.max(0, now - slot.start);
      return await this.exec(s, [...this.inputArgs(input, offsetMs), '-t', ((slot.end - now) / 1000).toFixed(3), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
        ...(encode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-threads', '2', '-force_key_frames', 'expr:gte(t,n_forced*2)'] : ['-c:v', 'copy']),
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2']);
    } finally { release(); done(); }
  }
  private inputArgs(input: Input, offsetMs: number) {
    return ['-protocol_whitelist', input.protocols, '-fflags', '+genpts', ...(offsetMs > 500 ? ['-ss', (offsetMs / 1000).toFixed(3)] : []), '-re', ...(input.demuxer ? ['-f', input.demuxer] : []), '-i', input.path];
  }
  // A plain dark screen with silence for the rest of a slot. Tiny and cheap to encode, so it needs no encoder permit.
  private slate(s: Station, ms: number) {
    s.library = undefined;
    return this.exec(s, ['-re', '-f', 'lavfi', '-i', 'color=c=0x0e0e12:s=1280x720:r=25', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', (ms / 1000).toFixed(3),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', '-b:a', '64k']);
  }
  // Runs one FFmpeg into the station's HLS window and resolves when it exits: true for a clean finish.
  private exec(s: Station, args: string[]) {
    if (s.stopped) return Promise.resolve(false);
    const append = s.output, out = (name: string) => join(s.dir, name).replaceAll('\\', '/');
    const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, '-max_muxing_queue_size', '1024',
      // Short segments keep tuning quick: the first one is listed as soon as two seconds are read.
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '15', '-hls_delete_threshold', '8',
      '-hls_flags', `delete_segments+independent_segments+omit_endlist+temp_file${append ? '+append_list+discont_start' : ''}`,
      '-hls_segment_filename', out('seg-%06d.ts'), out('index.m3u8')], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    s.child = child; s.stderr = '';
    child.stderr!.on('data', (b: Buffer) => { s.stderr = (s.stderr + b.toString()).slice(-2000); });
    return new Promise<boolean>(done => {
      let finished = false;
      const end = (ok: boolean) => { if (finished) return; finished = true; if (s.child === child) s.child = undefined; done(ok); };
      child.on('error', () => { s.stderr += '\nFFmpeg could not be started.'; end(false); });
      child.on('close', code => {
        // Once FFmpeg has written a playlist, later programs append to it.
        void readFile(join(s.dir, 'index.m3u8'), 'utf8').then(t => { if (/#EXTINF/.test(t)) s.output = true; }, () => {}).finally(() => {
          if (code !== 0 && !s.stopped) this.log('custom playout exited', { channelId: s.channelId, code, detail: this.redact(s.stderr) });
          end(code === 0);
        });
      });
    });
  }
  private async waitReady(s: Station) {
    const deadline = Date.now() + this.options.readyMs;
    while (Date.now() < deadline) {
      if (s.stopped) throw new AppError('MEDIA_CANCELLED', 'Live session was stopped.', 409);
      try { if ((await readFile(join(s.dir, 'index.m3u8'), 'utf8')).match(/#EXTINF/g)?.length) { s.output = true; return; } } catch { /* not written yet */ }
      await sleep(250);
    }
    throw new AppError('LIVE_TUNE_TIMEOUT', 'The channel did not start in time. Please try again.', 504, true);
  }
  private destroy(s: Station) {
    if (s.stopped) return;
    s.stopped = true;
    if (this.stations.get(s.channelId) === s) this.stations.delete(s.channelId);
    for (const id of s.viewers) this.viewers.delete(id);
    const child = s.child;
    const exited = !child || child.exitCode !== null ? Promise.resolve() : new Promise<void>(done => { child.once('close', () => done()); child.kill('SIGKILL'); });
    void exited.then(() => rm(s.dir, { recursive: true, force: true, maxRetries: 5 })).catch(() => {});
  }
  private async reapStale(parent: string) {
    for (const name of await readdir(parent).catch(() => [] as string[])) {
      const pid = Number(name.split('-')[0]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try { process.kill(pid, 0); } catch { await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); }
    }
  }
  // FFmpeg errors can quote file paths or the loopback part address.
  private redact(text: string) { return text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '<url>').replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+/g, '<path>').trim().slice(-600); }
}
