import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AppError, requireThat } from '../errors.js';
import { assertVideoEncode, type SourceVideo, type Route, EncoderBudget } from './policy.js';
import { randomUUID } from 'node:crypto';

export async function runProcess(executable: string, args: string[], timeoutMs = 30000, signal?:AbortSignal): Promise<{stdout: string; elapsedMs: number; packetCorruptionWarnings: number}> {
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const start = performance.now(); let stdout = '', size = 0, failure: Error | undefined, packetCorruptionWarnings = 0;
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { failure = new AppError('MEDIA_TIMEOUT', 'Media processing timed out.', 504); child.kill('SIGKILL'); }, timeoutMs);
    const abort=()=>{failure=new AppError('MEDIA_CANCELLED','Media processing stopped.',409);child.kill('SIGKILL');};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > 2 * 1024 * 1024) { failure = new AppError('PROBE_LIMIT', 'Media response exceeds limit.', 502); child.kill('SIGKILL'); } else stdout += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { packetCorruptionWarnings += (b.toString().match(/Packet corrupt/g) ?? []).length; }); // Only a numeric diagnostic, never raw upstream stderr.
    child.on('error', () => { clearTimeout(timer);signal?.removeEventListener('abort',abort); reject(new AppError('MEDIA_EXECUTABLE_UNAVAILABLE', 'Media executable could not be started.', 503)); });
    child.on('close', code => { clearTimeout(timer);signal?.removeEventListener('abort',abort); if (failure) reject(failure); else if (code !== 0) reject(new AppError('MEDIA_PROCESS_FAILED', 'Media process failed. Check codec support and input availability.', 502)); else done({stdout, elapsedMs: performance.now() - start, packetCorruptionWarnings}); });
  });
}
const probeSchema = z.object({ streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(), width: z.number().optional(), height: z.number().optional(), pix_fmt: z.string().optional() })), format: z.object({ duration: z.coerce.number().positive(), format_name: z.string() }) });
// Local fixture/diagnostic tool only. No HTTP route accepts filesystem paths or arbitrary URLs.
export async function probeLocal(path: string, executable = 'ffprobe',signal?:AbortSignal) {
  const {stdout} = await runProcess(executable, ['-v', 'error', '-protocol_whitelist', 'file,crypto,data', '-show_streams', '-show_format', '-of', 'json', resolve(path).replaceAll('\\', '/')],30000,signal);
  const result = probeSchema.parse(JSON.parse(stdout)), video = result.streams.find(s => s.codec_type === 'video');
  requireThat(video, 'NO_VIDEO', 'Input contains no video track.');
  const audio = result.streams.find(s => s.codec_type === 'audio');
  const source: SourceVideo = { codec: video.codec_name, width: video.width, height: video.height, container: result.format.format_name, audioCodec: audio?.codec_name, bitDepth: /10|12/.test(video.pix_fmt ?? '') ? 10 : 8 };
  return {source, durationMs: result.format.duration * 1000};
}
export type HlsOptions = {format?: 'mpegts' | 'fmp4';signal?:AbortSignal};
export function hlsArgs(input: string, outputDir: string, source: SourceVideo, route: Route, offsetMs = 0, durationMs?: number, options: HlsOptions = {}) {
  requireThat(Number.isFinite(offsetMs) && offsetMs >= 0 && (durationMs === undefined || (Number.isFinite(durationMs) && durationMs > 0)), 'INVALID_OFFSET', 'Invalid media offset/duration.');
  requireThat(route.kind !== 'direct', 'INVALID_ROUTE', 'Direct playback does not require FFmpeg.');
  if (route.kind === 'cpu') assertVideoEncode(source); // Recheck at command construction, before any spawn.
  requireThat(!(options.format==='fmp4'&&route.kind==='cpu'),'PACKAGING_NOT_VALIDATED','CPU fMP4 packaging is not enabled until validated on the selected FFmpeg build. Use the verified MPEG-TS path.',422);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,crypto,data', '-ss', String(offsetMs / 1000), '-i', resolve(input)];
  if (durationMs !== undefined) args.push('-t', String(durationMs / 1000));
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
  if (route.kind === 'cpu') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-bf','0', '-threads', '2', '-force_key_frames', 'expr:gte(t,n_forced*2)');
    if(options.format==='fmp4')args.push('-flags','+global_header');
    if (route.maxHeight) args.push('-vf', `scale=w='if(gte(iw,ih),-2,min(${route.maxHeight},iw))':h='if(gte(iw,ih),min(${route.maxHeight},ih),-2)'`);
  } else args.push('-c:v', 'copy');
  args.push('-c:a', route.audioEncode ? 'aac' : 'copy');
  if (options.format === 'fmp4' && !route.audioEncode && source.audioCodec === 'aac' && source.container.includes('mpegts')) args.push('-bsf:a','aac_adtstoasc');
  if (route.audioEncode) args.push('-b:a', '128k');
  args.push('-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_flags', 'temp_file');
  if (options.format === 'fmp4') args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
  args.push('-hls_segment_filename', join(outputDir, `segment-%04d.${options.format === 'fmp4' ? 'm4s' : 'ts'}`).replaceAll('\\','/'), join(outputDir, 'index.m3u8').replaceAll('\\','/'));
  return args;
}
export class LocalMediaWorker {
  private running = 0;
  constructor(private budget: EncoderBudget, private ffmpeg = 'ffmpeg', private ffprobe = 'ffprobe', private maxWorkers = 4) {}
  async hls(input: string, outputDir: string, route: Route, offsetMs = 0, durationMs?: number, options: HlsOptions = {}) {
    requireThat(this.running < this.maxWorkers, 'MEDIA_WORKER_LIMIT', 'Media worker limit reached.', 503);
    this.running++;
    let release = () => {};
    try {
      const probe = await probeLocal(input, this.ffprobe,options.signal);
      const args = hlsArgs(input, outputDir, probe.source, route, offsetMs, durationMs, options);
      if (route.kind === 'cpu') release = this.budget.reserve(randomUUID());
      await mkdir(outputDir, {recursive: true, mode: 0o700});
      return { ...(await runProcess(this.ffmpeg, args, 120000,options.signal)), probe };
    } finally { release(); this.running--; }
  }
}
