import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { ffmpegEnv, protocols } from '../streaming/stream-guard.js';

// One-connection channel check. A single FFmpeg run opens the stream exactly like the live
// relay does, decodes a short sample and reports, from its own log:
//  - transport failures (HTTP status, DNS, refused, timeout, undecodable data),
//  - whether the picture stayed frozen (freezedetect) and the audio stayed silent (silencedetect),
//  - a 64-bit difference hash of one frame, so identical provider "channel unavailable"
//    screens can be recognized across channels,
//  - an optional small JPEG for the administrator.
// Raw stderr can quote provider URLs with credentials; only derived codes and numbers leave here.
export type ProbeVerdict = 'online' | 'offline' | 'placeholder' | 'inconclusive';
export type ProbeResult = {
  verdict: ProbeVerdict; reason: string; elapsedMs: number;
  video?: { codec: string; width?: number; height?: number }; audio?: string;
  frames: number; mediaSeconds: number; frozen: boolean; silent: boolean;
  fingerprint?: string; informative: boolean; thumbnail: boolean;
};
// proxy: the stream guard FFmpeg reads the stream through (public addresses only); none for local-network sources.
export type ProbeOptions = { ffmpeg?: string; signal?: AbortSignal; sampleSeconds?: number; thumbnailPath?: string; proxy?: string };
export type Prober = (url: string, options: ProbeOptions) => Promise<ProbeResult>;

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Providers redirect dead channels to tiny looping files with names like these.
const placeholderPath = /\/(?:video\/)?(?:black|blank|placeholder|null|offline|unavailable|novideo|no_signal|nosignal)\.(?:ts|mp4|m3u8)$/i;
const fixed = (n: number) => Math.round(n * 100) / 100;

type Interval = { start: number; end?: number };
export type Analysis = {
  frames: number; mediaSeconds: number; hasVideo: boolean; hasAudio: boolean; video?: ProbeResult['video']; audio?: string;
  freezeCoverage: number; silenceCoverage: number; error?: string; placeholderUrl: boolean; noVideoOutput: boolean;
};
// Fraction of the sample covered by detector intervals. A detector only reports an interval once it has
// lasted its minimum duration, back-dated to where it began; an interval still open at the end runs to it.
function coverage(intervals: Interval[], total: number) {
  if (total <= 0) return 0;
  return Math.min(1, intervals.reduce((sum, i) => sum + Math.max(0, Math.min(total, i.end ?? total) - Math.max(0, i.start)), 0) / total);
}
function intervals(stderr: string, start: RegExp, end: RegExp) {
  const found: Interval[] = [];
  for (const line of stderr.split(/[\r\n]+/)) {
    const s = start.exec(line), e = end.exec(line);
    if (s) found.push({ start: Number(s[1]) });
    else if (e && found.length && found.at(-1)!.end === undefined) found.at(-1)!.end = Number(e[1]);
  }
  return found;
}
// FFmpeg's wording for the failures that matter. Order matters: specific statuses before generic ones.
const failures: [RegExp, string][] = [
  [/(?:Server returned|HTTP error) (?:429|458|509)|Too Many Requests/i, 'PROVIDER_LIMIT'],
  [/(?:Server returned|HTTP error) (?:404|410)|404 Not Found/i, 'HTTP_NOT_FOUND'],
  [/(?:Server returned|HTTP error) (?:401|403|451)|401 Unauthorized|403 Forbidden/i, 'HTTP_FORBIDDEN'],
  [/(?:Server returned|HTTP error) 5(?:\d\d|XX)/i, 'HTTP_SERVER_ERROR'],
  [/(?:Server returned|HTTP error) 4(?:\d\d|XX)/i, 'HTTP_ERROR'],
  [/Failed to resolve hostname|Name or service not known|No such host|getaddrinfo/i, 'DNS_FAILED'],
  [/Connection refused/i, 'CONNECTION_REFUSED'],
  [/timed out|Operation timed out/i, 'TIMEOUT'],
  [/Invalid data found when processing input|could not find codec parameters|Unable to find a suitable output format|moov atom not found|Error opening input/i, 'INVALID_STREAM'],
  [/Connection reset|End of file|I\/O error|Input\/output error/i, 'CONNECTION_LOST']
];
export function parseAnalysis(stderr: string): Analysis {
  const lines = stderr.split(/[\r\n]+/), streams = lines.filter(l => /^\s*Stream #0:\d+.*?: (Video|Audio):/.test(l));
  const videoLine = streams.find(l => / Video: /.test(l)), audioLine = streams.find(l => / Audio: /.test(l));
  const size = videoLine && /, (\d{2,5})x(\d{2,5})[ ,]/.exec(videoLine);
  const video = videoLine ? { codec: / Video: ([\w-]+)/.exec(videoLine)?.[1] ?? 'unknown', ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}) } : undefined;
  const stats = [...stderr.matchAll(/frame=\s*(\d+)/g)].at(-1), frames = stats ? Number(stats[1]) : 0;
  // The final progress line is not reliable: with several outputs, FFmpeg 8 reports the time of one that
  // stopped after a single frame. Take the furthest time seen, or the decoded video frames at the input rate.
  const times = [...stderr.matchAll(/time=\s*(-?\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)].map(t => Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]));
  const fps = videoLine ? Number(/, ([\d.]+) fps/.exec(videoLine)?.[1] ?? 0) : 0;
  const mediaSeconds = Math.max(0, ...times, fps > 0 ? frames / fps : 0);
  const freeze = intervals(stderr, /freezedetect\.freeze_start:\s*(-?[\d.]+)/, /freezedetect\.freeze_end:\s*(-?[\d.]+)/);
  const silence = intervals(stderr, /silence_start:\s*(-?[\d.]+)/, /silence_end:\s*(-?[\d.]+)/);
  const opened = [...stderr.matchAll(/Opening '([^']+)' for reading/g)].map(m => { try { return new URL(m[1]!).pathname; } catch { return ''; } });
  return {
    frames, mediaSeconds, hasVideo: !!videoLine, hasAudio: !!audioLine, video, audio: audioLine ? / Audio: ([\w-]+)/.exec(audioLine)?.[1] : undefined,
    freezeCoverage: coverage(freeze, mediaSeconds), silenceCoverage: coverage(silence, mediaSeconds),
    error: failures.find(([pattern]) => pattern.test(stderr))?.[1], placeholderUrl: opened.some(p => placeholderPath.test(p)),
    noVideoOutput: /does not contain any stream|Stream map '0:v:0' matches no streams/.test(stderr)
  };
}
// Most of the sample still and quiet; leaves room for the opening second of a live join.
const STILL = 0.7, MIN_SAMPLE = 3;
export function classify(a: Analysis, exited: 'ok' | 'failed' | 'timeout'): Pick<ProbeResult, 'verdict' | 'reason' | 'frozen' | 'silent'> {
  const frozen = a.hasVideo && a.frames > 1 && a.mediaSeconds >= 5 && a.freezeCoverage >= STILL;
  const silent = !a.hasAudio || (a.mediaSeconds >= 5 && a.silenceCoverage >= STILL);
  const decoded = a.mediaSeconds >= MIN_SAMPLE && (a.frames > 0 || (a.hasAudio && !a.hasVideo));
  if (a.placeholderUrl) return { verdict: 'placeholder', reason: 'PLACEHOLDER_FILE', frozen, silent };
  if (decoded) {
    if (frozen && silent) return { verdict: 'placeholder', reason: 'FROZEN_SILENT', frozen, silent };
    if (!a.hasVideo && silent) return { verdict: 'placeholder', reason: 'SILENT_AUDIO', frozen, silent };
    return { verdict: 'online', reason: frozen ? 'STILL_PICTURE' : 'OK', frozen, silent };
  }
  // Rate limits say nothing about the channel itself; try again later.
  if (a.error === 'PROVIDER_LIMIT') return { verdict: 'inconclusive', reason: a.error, frozen, silent };
  if (a.error) return { verdict: 'offline', reason: a.error, frozen, silent };
  if (exited === 'timeout') return { verdict: 'offline', reason: 'TIMEOUT', frozen, silent };
  return { verdict: 'offline', reason: a.mediaSeconds > 0 || a.frames > 0 ? 'STREAM_ENDED' : 'NO_MEDIA', frozen, silent };
}
// 9x8 grayscale → 64-bit difference hash. Robust to scaling and re-encoding. A frame needs a few
// clear edges to carry identity: black or flat-colour frames hash to noise and are never matched.
export function dhash(gray: Buffer) {
  if (gray.length < 72) return undefined;
  let bits = 0n, edges = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const left = gray[y * 9 + x]!, right = gray[y * 9 + x + 1]!;
    bits = (bits << 1n) | (left > right ? 1n : 0n); if (Math.abs(left - right) >= 4) edges++;
  }
  return { fingerprint: bits.toString(16).padStart(16, '0'), informative: edges >= 3 };
}
export function hamming(a: string, b: string) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
export const SIMILAR = 6;

export function args(url: string, sample: number, video: boolean, thumbnail?: string, proxy?: string) {
  const out = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-protocol_whitelist', protocols(proxy), '-user_agent', userAgent,
    '-rw_timeout', '10000000', '-threads', '1', '-t', String(sample), '-i', url,
    // Detectors run on a tiny copy: freeze comparison is cheaper and compression noise is smoothed away.
    '-map', '0:v:0?', '-map', '0:a:0?', '-vf', `setpts=PTS-STARTPTS,scale=160:-2,freezedetect=n=-50dB:d=${sample - 2}`,
    '-af', `asetpts=PTS-STARTPTS,silencedetect=n=-50dB:d=${sample - 2}`, '-f', 'null', '-'];
  if (!video) return out;
  const pick = `setpts=PTS-STARTPTS,select='gte(t,${Math.min(3, sample - 2)})'`;
  out.push('-map', '0:v:0', '-vf', `${pick},scale=9:8:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1');
  if (thumbnail) out.push('-map', '0:v:0', '-vf', `${pick},scale=320:-2`, '-frames:v', '1', '-q:v', '7', '-f', 'image2', '-update', '1', '-y', thumbnail.replaceAll('\\', '/'));
  return out;
}
function run(executable: string, argv: string[], timeoutMs: number, signal?: AbortSignal, proxy?: string) {
  return new Promise<{ stderr: string; stdout: Buffer; exited: 'ok' | 'failed' | 'timeout' | 'cancelled' | 'unavailable' }>(done => {
    let stderr = '', exited: 'timeout' | 'cancelled' | undefined;const stdout: Buffer[] = [];
    const child = spawn(executable, argv, { shell: false, windowsHide: true, env: ffmpegEnv(proxy), stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (why: 'timeout' | 'cancelled') => { exited ??= why; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs), abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', (b: Buffer) => { if (stdout.length < 16) stdout.push(b); });
    // Keep the head (stream info) and the tail (final statistics); detector lines are few and short.
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); if (stderr.length > 256000) stderr = stderr.slice(0, 64000) + stderr.slice(-128000); });
    const finish = (result: 'ok' | 'failed' | 'unavailable') => { clearTimeout(timer); signal?.removeEventListener('abort', abort); done({ stderr, stdout: Buffer.concat(stdout), exited: exited ?? result }); };
    child.on('error', () => finish('unavailable'));
    child.on('close', code => finish(code === 0 ? 'ok' : 'failed'));
  });
}
export const probeStream: Prober = async (url, { ffmpeg = 'ffmpeg', signal, sampleSeconds = 7, thumbnailPath, proxy }) => {
  const started = performance.now(), sample = Math.max(5, Math.min(20, sampleSeconds)), timeout = (sample + 20) * 1000;
  const temp = thumbnailPath && `${thumbnailPath}.part.jpg`;
  let result = await run(ffmpeg, args(url, sample, true, temp, proxy), timeout, signal, proxy), analysis = parseAnalysis(result.stderr);
  // Audio-only inputs (radio) cannot feed the picture outputs; repeat with the detectors alone.
  if (result.exited === 'failed' && analysis.noVideoOutput && analysis.hasAudio && !analysis.hasVideo) {
    result = await run(ffmpeg, args(url, sample, false, undefined, proxy), timeout, signal, proxy); analysis = parseAnalysis(result.stderr);
  }
  const elapsedMs = Math.round(performance.now() - started), base = { elapsedMs, video: analysis.video, audio: analysis.audio, frames: analysis.frames, mediaSeconds: fixed(analysis.mediaSeconds), informative: false, thumbnail: false };
  if (result.exited === 'unavailable' || result.exited === 'cancelled') {
    if (temp) await rm(temp, { force: true }).catch(() => {});
    return { ...base, verdict: 'inconclusive', reason: result.exited === 'cancelled' ? 'CANCELLED' : 'CHECKER_UNAVAILABLE', frozen: false, silent: false };
  }
  const verdict = classify(analysis, result.exited), hash = dhash(result.stdout);
  let thumbnail = false;
  if (temp) thumbnail = await rename(temp, thumbnailPath!).then(() => true, async () => { await rm(temp, { force: true }).catch(() => {}); return false; });
  return { ...base, ...verdict, fingerprint: hash?.fingerprint, informative: hash?.informative ?? false, thumbnail };
};
