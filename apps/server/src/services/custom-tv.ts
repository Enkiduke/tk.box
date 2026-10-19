import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, requireThat } from '../errors.js';
import { opaque } from '../security/vault.js';
import { assertVideoEncode, type EncoderBudget } from '../streaming/policy.js';
import { SegmentBuffer, ViewerCursor, renderManifest, type Segment } from '../streaming/buffer.js';
import type { CustomChannelStore } from '../persistence/custom-channels.js';
import { customAudioMap, mediaTracks, type PlexAdapter, type PlexGrant } from '../providers/plex.js';
import type { LocalMedia } from '../providers/local-media.js';
import type { PartProxy } from '../providers/part-proxy.js';
import type { Slot } from './scheduler.js';
import type { LiveDelivery, LiveSource } from './live-tv.js';

type Station = {
  key: string; channelId: string; dir: string; viewers: Set<string>; grant: PlexGrant; stopped: boolean; child?: ChildProcess;
  ready: Promise<void>; output: boolean; stderr: string; library?: string; encode: boolean; source?: LiveSource;
  // The retained window, indexed by broadcast time. `buffer` mirrors it for viewer cursors.
  segments: Segment[]; buffer: SegmentBuffer; lastSequence: number; discontinuities: number; indexer?: NodeJS.Timeout; indexing: boolean; pressure: boolean; checkedDisk: number;
  airings: Airing[]; opening?: Omit<Airing, 'start'>;
};
// One run of a program (or the blank slate) on the station, from its first segment's broadcast time. `mediaStartMs`
// is the media position shown at `start`, so captions follow broadcast time: media = mediaStartMs + (utc - start).
type Airing = { id: string; mediaId?: string; start: number; mediaStartMs: number; subtitles: ReturnType<typeof mediaTracks>['subtitles'] };
type Viewer = { id: string; hash: string; channelId: string; seen: number; cursor: ViewerCursor };
type Input = { path: string; demuxer?: string; protocols: string };
export type TimeshiftState = { state: string; viewerCursorUtc: number; broadcastNowUtc: number; behindLiveMs: number; bufferStartUtc?: number; bufferEndUtc?: number };
const segmentName = /^seg-\d{6}\.ts$/;
const LIVE_WINDOW_MS = 90000, LIVE_SEGMENTS = 8, LEAD_IN_MS = 30000, FREE_FLOOR = 1024 ** 3;
const sleep = (ms: number) => new Promise(done => setTimeout(done, Math.max(0, ms)).unref());
// A segment's broadcast start. A program's first segment is placed by the clock; the rest follow back to back, since
// its media is continuous. Stamping them by arrival would put a gap wherever FFmpeg fell behind (a slow read or
// encode), and captions, timed from the airing's start by broadcast time, would run ahead by every gap.
export function segmentStart(previousEnd: number | undefined, now: number, durationMs: number, newProgram: boolean) {
  if (previousEnd === undefined) return Math.round(now - durationMs);
  return newProgram ? Math.round(Math.max(previousEnd, now - durationMs)) : previousEnd;
}

// Custom channel playout. A channel is a schedule, not a running video: a station starts when the first viewer
// tunes in and stops when the last one leaves. It plays one program at a time, joining the airing program at its
// clock position and moving to whatever the schedule says is next, so publishing and the clock are always honored.
// Each program is one FFmpeg run, read in real time, appending to one shared HLS window behind a discontinuity.
// Browser-safe H.264 is copied; other 1080p-or-lower video is encoded within the shared encoder budget; audio is AAC.
// Plex history is never touched: media is read from disk or as a plain part request, and no timeline is reported.
//
// Pause, Resume and Go Live are per viewer. Segments are shared and kept, by broadcast time, for as long as a paused
// or delayed viewer needs them (up to the pause retention setting, the byte cap and a free-space floor). Each viewer
// gets its own manifest: the live edge, or a window starting at its own cursor. The station's clock never pauses.
export class CustomTv {
  private stations = new Map<string, Station>();
  private viewers = new Map<string, Viewer>();
  private root: string;
  private timer: NodeJS.Timeout;
  constructor(private store: CustomChannelStore, private plex: PlexAdapter, private local: LocalMedia, private parts: PartProxy, private budget: EncoderBudget, cacheDir: string,
    private retentionMs: () => number, private maxBytes: number, private ffmpeg = 'ffmpeg', private log: (message: string, detail: Record<string, unknown>) => void = () => {},
    private options = { maxStations: 6, maxPerViewer: 4, idleMs: 45000, readyMs: 30000, indexMs: 1000, freeBytes: (dir: string) => statfs(dir).then(s => s.bavail * s.bsize) }) {
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
      const key = opaque().slice(0, 16);
      const created: Station = { key, channelId, dir: join(this.root, key), viewers: new Set(), grant, stopped: false, ready: Promise.resolve(), output: false, stderr: '', encode: false,
        segments: [], buffer: new SegmentBuffer(this.maxBytes, () => this.retained(created)), lastSequence: -1, discontinuities: 0, indexing: false, pressure: false, checkedDisk: 0, airings: [] };
      this.stations.set(channelId, created);
      created.ready = mkdir(created.dir, { recursive: true, mode: 0o700 }).then(() => {
        created.indexer = setInterval(() => void this.index(created), this.options.indexMs); created.indexer.unref();
        void this.run(created); return this.waitReady(created);
      });
      created.ready.catch(() => this.destroy(created));
      station = created;
    }
    station.grant = grant;
    const target = station, viewer: Viewer = { id: opaque(), hash, channelId, seen: Date.now(), cursor: new ViewerCursor(station.buffer, () => this.effectiveRetention(target)) };
    this.viewers.set(viewer.id, viewer); station.viewers.add(viewer.id);
    try { await station.ready; } catch (e) { this.stop(viewer.id, hash); throw e; }
    requireThat(this.viewers.has(viewer.id), 'SESSION_NOT_FOUND', 'Live session was stopped.', 409);
    this.authorize(station, grant, viewer, station.library ? [station.library] : []);
    return { id: viewer.id, streamUrl: `/api/v1/live/sessions/${viewer.id}/index.m3u8`, delivery: (station.encode ? 'transcode' : 'remux') as LiveDelivery, channel, source: station.source ?? {}, timeshift: true };
  }
  private owned(id: string, hash: string) {
    const viewer = this.viewers.get(id);
    requireThat(viewer?.hash === hash, 'SESSION_NOT_FOUND', 'Live session is unavailable.', 404);
    const station = this.stations.get(viewer.channelId);
    requireThat(station, 'SESSION_NOT_FOUND', 'Live session is unavailable.', 404);
    viewer.seen = Date.now();
    return { viewer, station };
  }
  // Every viewer needs access to the library of each program it is sent, checked on every manifest.
  private authorize(station: Station, grant: PlexGrant, viewer: Viewer, libraries: string[]) {
    if (libraries.some(l => l && !grant.libraries.some(g => g.key === l))) { this.stop(viewer.id, viewer.hash); throw new AppError('PLEX_ACCESS_DENIED', 'This program isn’t available to your Plex account.', 403); }
    station.grant = grant;
  }
  async playlist(id: string, hash: string, grant: PlexGrant, now = Date.now()) {
    const { viewer, station } = this.owned(id, hash);
    if (!this.store.isVisible(viewer.channelId)) { this.stop(id, hash); throw new AppError('CHANNEL_NOT_FOUND', 'Channel is no longer available.', 404); }
    const state = viewer.cursor.inspect(now);
    requireThat(state.state !== 'EXPIRED', 'BUFFER_EXPIRED', 'Buffer expired. Go Live to continue.', 410);
    if (!station.segments.length) throw new AppError('LIVE_UNAVAILABLE', 'The channel stream is starting.', 503, true);
    // Live viewers follow the edge; delayed viewers get a window from just before their own position.
    const live = state.state === 'LIVE', window = live ? station.segments.slice(-LIVE_SEGMENTS) : station.segments.filter(s => s.end > state.cursor - LEAD_IN_MS);
    this.authorize(station, grant, viewer, [...new Set(window.map(s => s.programId))]);
    return renderManifest(window, false, live ? undefined : state.cursor);
  }
  async segment(id: string, hash: string, name: string, now = Date.now()) {
    requireThat(segmentName.test(name), 'INVALID_MEDIA', 'Unsupported stream path.', 400);
    const { viewer, station } = this.owned(id, hash);
    requireThat(viewer.cursor.inspect(now).state !== 'EXPIRED', 'BUFFER_EXPIRED', 'Buffer expired. Go Live to continue.', 410);
    requireThat(station.segments.some(s => s.uri === name), 'SEGMENT_EXPIRED', 'Segment is no longer available.', 404);
    const path = join(station.dir, name);
    const size = await stat(path).then(s => s.size, () => { throw new AppError('SEGMENT_EXPIRED', 'Segment is no longer available.', 404); });
    return { size, body: createReadStream(path) };
  }
  // Pause pins the viewer at the broadcast time it was showing (the stream's program date-time, which is server time).
  pause(id: string, hash: string, displayedUtc: number, now = Date.now()) {
    requireThat(Number.isFinite(displayedUtc), 'INVALID_CURSOR', 'Invalid presentation time.');
    const { viewer, station } = this.owned(id, hash), first = station.segments[0], last = station.segments.at(-1);
    requireThat(first && last, 'BUFFER_EXPIRED', 'Nothing is buffered to pause on yet.', 409);
    viewer.cursor.pause(Math.round(Math.max(first.start, Math.min(displayedUtc, last.end - 1, now))), now);
    return this.state(id, hash, now);
  }
  // What aired when within reach of this viewer, for subtitles. The slate has no media and no subtitles.
  airings(id: string, hash: string) {
    return this.owned(id, hash).station.airings.map(({ id, start, mediaStartMs, subtitles }) => ({ id, start, mediaStartMs, subtitles }));
  }
  airingMedia(id: string, hash: string, airingId: string) {
    const media = this.owned(id, hash).station.airings.find(a => a.id === airingId)?.mediaId;
    requireThat(media, 'SUBTITLE_NOT_FOUND', 'This program is no longer available.', 404);
    return media;
  }
  resume(id: string, hash: string, now = Date.now()) { this.owned(id, hash).viewer.cursor.resume(now); return this.state(id, hash, now); }
  goLive(id: string, hash: string, now = Date.now()) { this.owned(id, hash).viewer.cursor.goLive(); return this.state(id, hash, now); }
  state(id: string, hash: string, now = Date.now()): TimeshiftState {
    const { viewer, station } = this.owned(id, hash), s = viewer.cursor.inspect(now);
    return { state: s.state, viewerCursorUtc: s.cursor, broadcastNowUtc: now, behindLiveMs: s.state === 'LIVE' ? 0 : s.behindLiveMs, bufferStartUtc: station.segments[0]?.start, bufferEndUtc: station.segments.at(-1)?.end };
  }
  stop(id: string, hash: string) {
    const viewer = this.viewers.get(id); if (!viewer || viewer.hash !== hash) return;
    viewer.cursor.stop(); this.viewers.delete(id);
    const station = this.stations.get(viewer.channelId);
    station?.viewers.delete(id);
    if (station && !station.viewers.size) this.destroy(station);
  }
  stopWhere(matches: (v: { id: string; hash: string }) => boolean) { for (const v of [...this.viewers.values()]) if (matches(v)) this.stop(v.id, v.hash); }
  close() { clearInterval(this.timer); for (const s of [...this.stations.values()]) this.destroy(s); void rm(this.root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); }
  sweep(now = Date.now()) { for (const v of [...this.viewers.values()]) if (now - v.seen > this.options.idleMs) this.stop(v.id, v.hash); }
  get count() { return this.stations.size; }
  // Administrator diagnostics: what the pause buffer actually holds.
  usage(now = Date.now()) {
    const stations = [...this.stations.values()], delayed = [...this.viewers.values()].filter(v => ['PAUSED', 'PLAYING_DELAYED'].includes(v.cursor.inspect(now).state));
    return { bytes: stations.reduce((n, s) => n + s.buffer.bytes, 0), maxBytesPerChannel: this.maxBytes, stations: stations.length, delayedViewers: delayed.length,
      bufferedMs: Math.max(0, ...stations.map(s => s.segments.length ? s.segments.at(-1)!.end - s.segments[0]!.start : 0)), storagePressure: stations.some(s => s.pressure) };
  }

  private delayed(s: Station) { return [...s.viewers].some(id => { const state = this.viewers.get(id)?.cursor.state; return state === 'PAUSED' || state === 'PLAYING_DELAYED'; }); }
  // How far back segments are kept: the pause retention while someone is behind live, else just the live window.
  private retained(s: Station) { return !s.pressure && this.delayed(s) ? Math.max(LIVE_WINDOW_MS, this.retentionMs()) : LIVE_WINDOW_MS; }
  // Low disk shortens what a delayed viewer may rely on, so their cursor expires instead of silently jumping.
  private effectiveRetention(s: Station) { return s.pressure ? LIVE_WINDOW_MS : this.retentionMs(); }
  // Follows FFmpeg's playlist and adds each new segment to the retained window, timed by broadcast clock.
  private async index(s: Station, now = Date.now()) {
    if (s.indexing || s.stopped) return; s.indexing = true;
    try {
      const text = await readFile(join(s.dir, 'index.m3u8'), 'utf8').catch(() => '');
      let discontinuity = false, duration = 0;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
        else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice(8)) * 1000;
        else if (segmentName.test(line)) {
          const sequence = Number(line.slice(4, 10));
          if (sequence > s.lastSequence && duration > 0) {
            const bytes = await stat(join(s.dir, line)).then(x => x.size, () => 0);
            if (!bytes) break;
            const previous = s.segments.at(-1), start = segmentStart(previous?.end, now, duration, discontinuity || !!s.opening), marked = discontinuity && !!previous;
            s.segments.push({ id: line, uri: line, start, end: start + Math.max(1, Math.round(duration)), bytes, programId: s.library ?? '', revision: 0, sequence, discontinuity: marked, discontinuitySequence: s.discontinuities });
            if (marked) s.discontinuities++;
            if (s.opening) { s.airings.push({ ...s.opening, start }); s.opening = undefined; }
            s.lastSequence = sequence;
          }
          discontinuity = false; duration = 0;
        }
      }
      if (now - s.checkedDisk > 10000) { s.checkedDisk = now; s.pressure = await this.options.freeBytes(s.dir).then(free => free < FREE_FLOOR, () => false); }
      await this.prune(s, now);
    } finally { s.indexing = false; }
  }
  private async prune(s: Station, now: number) {
    const keepFrom = now - this.retained(s);
    let bytes = s.segments.reduce((n, x) => n + x.bytes, 0);
    while (s.segments.length > LIVE_SEGMENTS && (bytes > this.maxBytes || s.segments[0]!.end <= keepFrom)) {
      const old = s.segments.shift()!; bytes -= old.bytes;
      // The next segment's discontinuity count already counts tags before it, so removal keeps HLS numbering right.
      await unlink(join(s.dir, old.uri)).catch(() => {});
    }
    s.buffer.replace(s.segments);
    while (s.airings.length > 1 && s.segments[0] && s.airings[1]!.start <= s.segments[0].start) s.airings.shift();
  }

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
      const opening = { id: opaque().slice(0, 16), mediaId: item.ratingKey, mediaStartMs: offsetMs, subtitles: mediaTracks(item).subtitles };
      s.opening = opening;
      // Copied video starts at the keyframe before the join point, which can be seconds earlier.
      if (!encode && offsetMs > 500) void this.keyframe(input, offsetMs).then(at => { if (at !== undefined) opening.mediaStartMs = at; });
      return await this.exec(s, [...this.inputArgs(input, offsetMs), '-t', ((slot.end - now) / 1000).toFixed(3), '-map', '0:v:0', '-map', customAudioMap(item), '-sn', '-dn',
        ...(encode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-threads', '2', '-force_key_frames', 'expr:gte(t,n_forced*2)'] : ['-c:v', 'copy']),
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2']);
    } finally { release(); done(); }
  }
  // The source time of the keyframe a copied join starts on: the first video packet after the same input seek, timestamps kept.
  private keyframe(input: Input, offsetMs: number) {
    return new Promise<number | undefined>(done => {
      const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts', ...this.inputArgs(input, offsetMs).filter(a => a !== '-re'), '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', 'framecrc', '-'],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000); timer.unref();
      child.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
      child.on('error', () => { clearTimeout(timer); done(undefined); });
      child.on('close', () => {
        clearTimeout(timer);
        const base = /^#tb 0: (\d+)\/(\d+)/m.exec(out), packet = /^0,\s*(-?\d+),\s*(-?\d+),/m.exec(out);
        const ms = base && packet ? Number(packet[2]) * Number(base[1]) / Number(base[2]) * 1000 : NaN;
        // Only a keyframe shortly before the join point is believable; anything else keeps the scheduled position.
        done(Number.isFinite(ms) && ms <= offsetMs + 50 && ms >= offsetMs - 30000 ? Math.round(Math.min(ms, offsetMs)) : undefined);
      });
    });
  }
  private inputArgs(input: Input, offsetMs: number) {
    return ['-protocol_whitelist', input.protocols, '-fflags', '+genpts', ...(offsetMs > 500 ? ['-ss', (offsetMs / 1000).toFixed(3)] : []), '-re', ...(input.demuxer ? ['-f', input.demuxer] : []), '-i', input.path];
  }
  // A plain dark screen with silence for the rest of a slot. Tiny and cheap to encode, so it needs no encoder permit.
  private slate(s: Station, ms: number) {
    s.library = undefined; s.opening = { id: opaque().slice(0, 16), mediaStartMs: 0, subtitles: [] };
    return this.exec(s, ['-re', '-f', 'lavfi', '-i', 'color=c=0x0e0e12:s=1280x720:r=25', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', (ms / 1000).toFixed(3),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', '-b:a', '64k']);
  }
  // Runs one FFmpeg into the station's HLS output and resolves when it exits: true for a clean finish.
  // FFmpeg never deletes segments; the retained window above decides what is kept.
  private exec(s: Station, args: string[]) {
    if (s.stopped) return Promise.resolve(false);
    const append = s.output, out = (name: string) => join(s.dir, name).replaceAll('\\', '/');
    const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, '-max_muxing_queue_size', '1024',
      // Short segments keep tuning quick: the first one is listed as soon as two seconds are read.
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '15',
      '-hls_flags', `independent_segments+omit_endlist+temp_file${append ? '+append_list+discont_start' : ''}`,
      '-hls_segment_filename', out('seg-%06d.ts'), out('index.m3u8')], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    s.child = child; s.stderr = '';
    child.stderr!.on('data', (b: Buffer) => { s.stderr = (s.stderr + b.toString()).slice(-2000); });
    return new Promise<boolean>(done => {
      let finished = false;
      const end = (ok: boolean) => { if (finished) return; finished = true; if (s.child === child) s.child = undefined; done(ok); };
      child.on('error', () => { s.stderr += '\nFFmpeg could not be started.'; end(false); });
      child.on('close', code => {
        // Index what this program wrote before the next one appends; later programs continue the same playlist.
        void this.index(s).finally(() => {
          if (s.segments.length) s.output = true;
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
      if (s.segments.length) { s.output = true; return; }
      await sleep(250);
    }
    throw new AppError('LIVE_TUNE_TIMEOUT', 'The channel did not start in time. Please try again.', 504, true);
  }
  private destroy(s: Station) {
    if (s.stopped) return;
    s.stopped = true; clearInterval(s.indexer);
    if (this.stations.get(s.channelId) === s) this.stations.delete(s.channelId);
    for (const id of s.viewers) { this.viewers.get(id)?.cursor.stop(); this.viewers.delete(id); }
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
