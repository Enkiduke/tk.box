import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AppError, requireThat } from '../errors.js';
import { matroskaTextTrack } from './matroska-subtitles.js';
import { subtitleInputFormat, type PlexAdapter, type PlexGrant, type PlexMetadata } from '../providers/plex.js';
import { LocalMedia, type LocalPart } from '../providers/local-media.js';

type Stream = NonNullable<PlexMetadata['Media'][number]['Part'][number]['Stream']>[number];
const MAX_VTT_BYTES = 16 * 1024 * 1024;

// Browser subtitles (PLAY-SUB): Plex text subtitles are converted to WebVTT by the
// local FFmpeg. Node fetches the source with the server token in a header and pipes
// it to FFmpeg's stdin, so the token never appears on a command line. Plex cannot
// deliver an embedded track by itself (/library/streams/{id} is 501 for those, and the
// transcoder only emits subtitle segments in step with playback), so Matroska tracks
// are read block by block through the file's cue index; other embedded tracks need the
// whole part. In same-host mode (MEDIA_ROOTS) FFmpeg instead reads the part from disk,
// which is seekable, so any container is quick; the Plex paths remain the fallback.
// Results are cached and concurrent requests share one job.
export class SubtitleService {
  private pending = new Map<string, Promise<string>>();
  constructor(private plex: PlexAdapter, private ffmpeg: string, private cacheDir: string, private local = new LocalMedia(), private maxJobs = 2, private timeoutMs = 15 * 60000) {}
  async webvtt(grant: PlexGrant, item: PlexMetadata, streamId: string) {
    const part = item.Media[0]?.Part[0], stream = part?.Stream?.find(s => s.id === streamId && s.streamType === 3);
    requireThat(part && stream, 'SUBTITLE_NOT_FOUND', 'Subtitle track is unavailable.', 404);
    const format = subtitleInputFormat(stream.codec);
    requireThat(format && (stream.key || stream.index !== undefined), 'SUBTITLE_UNSUPPORTED', 'This subtitle format cannot be shown in the browser.', 422);
    const id = createHash('sha256').update(JSON.stringify([part.key, stream.id, stream.key ?? null, stream.index ?? null])).digest('hex');
    const file = join(this.cacheDir, 'subtitles', `${id}.vtt`);
    try { return await readFile(file, 'utf8'); } catch { /* not cached yet */ }
    let job = this.pending.get(id);
    if (!job) {
      if (this.pending.size >= this.maxJobs) throw new AppError('SUBTITLE_BUSY', 'Other subtitles are still being prepared. Try again shortly.', 503, true);
      job = this.extract(grant, item, stream, format).then(async text => {
        await mkdir(join(this.cacheDir, 'subtitles'), { recursive: true });
        await writeFile(`${file}.tmp`, text, { mode: 0o600 }); await rename(`${file}.tmp`, file);
        return text;
      }).finally(() => this.pending.delete(id));
      this.pending.set(id, job);
    }
    return job;
  }
  private async extract(grant: PlexGrant, item: PlexMetadata, stream: Stream, format: string) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const timeout = () => new AppError('MEDIA_TIMEOUT', 'Subtitles took too long to prepare.', 504);
    try {
      if (!stream.key && stream.index !== undefined) {
        // `item` came from plex.metadata for this grant; LocalMedia confines the path to MEDIA_ROOTS.
        const part = await this.local.open(grant, item);
        if (part) try { return await this.convert(part, undefined, `0:${stream.index}`, abort.signal, timeout); } finally { await part.handle.close(); }
      }
      if (!stream.key && stream.index !== undefined && /^(mkv|webm)$/i.test(item.Media[0]?.container ?? '')) {
        // Fast path: only the Matroska index and the subtitle blocks are read (seconds, not minutes).
        // Files it cannot handle (no subtitle cues, encryption) fall through to a whole-part read.
        const track = await matroskaTextTrack((start, end) => this.range(grant, item, start, end, abort.signal), stream.index).catch(error => {
          if (abort.signal.aborted) throw timeout();
          if (error instanceof AppError && error.code === 'SOURCE_INCOMPATIBLE') throw error;
          return undefined;
        });
        if (track) return await this.convert(Readable.from([Buffer.from(track.text)]), track.format, '0:s:0', abort.signal, timeout);
      }
      const source = await this.plex.subtitleSource(grant, item, stream.key, abort.signal);
      requireThat(source.body, 'PLEX_STREAM_FAILED', 'Plex subtitle delivery failed.', 502);
      return await this.convert(Readable.fromWeb(source.body as import('node:stream/web').ReadableStream), stream.key ? format : undefined,
        stream.key ? '0:s:0' : `0:${stream.index}`, abort.signal, timeout);
    } finally { clearTimeout(timer); }
  }
  // One byte range of the part; [start, end). A server that ignores Range is not read further.
  private async range(grant: PlexGrant, item: PlexMetadata, start: number, end: number, signal: AbortSignal) {
    const response = await this.plex.directPart(grant, item, `bytes=${start}-${end - 1}`, signal);
    if (response.status !== 206 || !response.body) { await response.body?.cancel(); throw new AppError('PLEX_STREAM_FAILED', 'Plex subtitle delivery failed.', 502); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
      size += (chunk as Buffer).length; chunks.push(chunk as Buffer);
      if (size > end - start) throw new AppError('PLEX_STREAM_FAILED', 'Plex subtitle delivery failed.', 502);
    }
    return Buffer.concat(chunks);
  }
  // A local part is opened by FFmpeg itself (file protocol only, demuxer forced by container);
  // anything else is piped to stdin. Neither puts the Plex token on the command line.
  private convert(source: Readable | LocalPart, format: string | undefined, map: string, signal: AbortSignal, timeout: () => AppError) {
    const input = source instanceof Readable ? source : undefined;
    const inputArgs = input ? ['-protocol_whitelist', 'pipe', ...(format ? ['-f', format] : []), '-i', 'pipe:0']
      : ['-protocol_whitelist', 'file', '-f', (source as LocalPart).demuxer, '-i', `file:${(source as LocalPart).path}`];
    const args = ['-hide_banner', '-loglevel', 'error', ...inputArgs, '-map', map, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'];
    return new Promise<string>((done, reject) => {
      const child = spawn(this.ffmpeg, args, { shell: false, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
      let failure: AppError | undefined, size = 0; const chunks: Buffer[] = [];
      const kill = (error: AppError) => { failure ??= error; input?.destroy(); child.kill('SIGKILL'); };
      if (signal.aborted) kill(timeout()); else signal.addEventListener('abort', () => kill(timeout()), { once: true });
      if (input && child.stdin) {
        // FFmpeg may finish or fail before the source ends; a closed stdin is expected then.
        child.stdin.on('error', () => input.destroy());
        input.on('error', () => kill(new AppError('PLEX_STREAM_FAILED', 'Plex subtitle delivery failed.', 502)));
        input.pipe(child.stdin);
      }
      child.stdout!.on('data', (b: Buffer) => { size += b.length; if (size > MAX_VTT_BYTES) kill(new AppError('SUBTITLE_LIMIT', 'Subtitle track is too large.', 502)); else chunks.push(b); });
      child.on('error', () => reject(new AppError('MEDIA_EXECUTABLE_UNAVAILABLE', 'Media executable could not be started.', 503)));
      child.on('close', code => {
        input?.destroy();
        const text = Buffer.concat(chunks).toString('utf8');
        if (failure) reject(failure);
        else if (code !== 0 || !text.startsWith('WEBVTT')) reject(new AppError('SUBTITLE_FAILED', 'This subtitle track could not be converted.', 422));
        else done(text);
      });
    });
  }
}
