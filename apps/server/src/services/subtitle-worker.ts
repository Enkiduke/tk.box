import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { readOnly } from '../errors.js';
import { errorDetail } from '../lib/every.js';
import { runProcess } from '../streaming/ffmpeg.js';
import { sidecarPath } from '../providers/opensubtitles.js';
import { episodesLabel } from './wanted.js';
import type { LibraryStore } from '../persistence/library-store.js';
import type { SubtitleStore } from '../persistence/subtitle-store.js';
import type { SubtitleWorkerStore } from '../persistence/subtitle-worker-store.js';

// The server's side of the PC worker (docs/PHASE-5.md): handing out jobs, the audio, and checking and writing what
// the worker makes. The worker runs whisper.cpp on 16 kHz mono FLAC that ffmpeg makes here, one job at a time.

const MIN_CUES_PER_HOUR = 20, MAX_REPEAT = 0.3, REPEAT_MIN_CUES = 10, END_SLACK_SEC = 2;
const AUDIO_TIMEOUT_MS = 30 * 60000;

export type SrtCheck = { ok: true; cues: number; text: string } | { ok: false; error: string };

const TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;
const seconds = (t: string) => {
  const m = TIME.exec(t.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000 : undefined;
};
const lineKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// What a worker sent: it must be SRT, every cue inside the video (a couple of seconds' slack at the end), at least 20
// cues an hour, and no more than 30% of cues one line (Whisper's failure on silence; from 10 cues up). Returns the
// text with its line endings made plain.
export function checkSrt(raw: string, durationSec: number): SrtCheck {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { ok: false, error: 'The subtitle is empty.' };
  const blocks = text.split(/\n[ \t]*\n+/), lines: string[] = [];
  for (const [i, block] of blocks.entries()) {
    const rows = block.split('\n');
    const timing = rows.findIndex(r => r.includes('-->'));
    if (timing < 0 || timing > 1) return { ok: false, error: `Cue ${i + 1} isn’t SRT.` };
    const [from, to] = rows[timing]!.split('-->').map(s => s.trim().split(/\s+/)[0] ?? '');
    const start = seconds(from ?? ''), end = seconds(to ?? '');
    if (start === undefined || end === undefined || end < start) return { ok: false, error: `Cue ${i + 1} has a bad time.` };
    if (end > durationSec + END_SLACK_SEC) return { ok: false, error: `Cue ${i + 1} ends after the video does.` };
    lines.push(lineKey(rows.slice(timing + 1).join(' ')));
  }
  const needed = Math.ceil(MIN_CUES_PER_HOUR * durationSec / 3600);
  if (lines.length < needed) return { ok: false, error: `Only ${lines.length} cues; at least ${needed} expected.` };
  if (lines.length >= REPEAT_MIN_CUES) {
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top / lines.length > MAX_REPEAT) return { ok: false, error: `${Math.round(100 * top / lines.length)}% of cues are the same line.` };
  }
  return { ok: true, cues: lines.length, text: `${text}\n` };
}

// ffmpeg under nice (and ionice where it exists) on the server; straight on Windows (development).
export function ffmpegAudio(executable = 'ffmpeg') {
  const ionice = ['/usr/bin/ionice', '/bin/ionice'].find(p => existsSync(p));
  return async (input: string, output: string, signal?: AbortSignal) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-f', 'flac', output];
    const command = process.platform === 'win32' ? { exe: executable, args }
      : ionice ? { exe: ionice, args: ['-c3', 'nice', '-n', '15', executable, ...args] } : { exe: 'nice', args: ['-n', '15', executable, ...args] };
    await runProcess(command.exe, command.args, AUDIO_TIMEOUT_MS, signal);
  };
}

export type WorkerDeps = {
  workers: SubtitleWorkerStore;
  store: Pick<SubtitleStore, 'recordFile' | 'file'>;
  library: Pick<LibraryStore, 'fileByPath' | 'title' | 'fileEpisodes'>;
  audioDir: string;
  makeAudio: (input: string, output: string, signal?: AbortSignal) => Promise<void>;
  // The video's length when the library doesn't know it (ffprobe).
  probeDuration: (path: string) => Promise<number | undefined>;
  files?: { writeFile: (path: string, text: string) => Promise<void>; rename: (from: string, to: string) => Promise<void>; unlink: (path: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>; readdir: (dir: string) => Promise<string[]>; mkdir: (dir: string) => Promise<void> };
  scan: (folder: string) => Promise<unknown>;
  log: (message: string, detail?: Record<string, unknown>) => void;
};
export type Claim = { id: number; title: string; language: 'en'; durationSec: number; leaseUntil: number; audio: string };
export type ResultOutcome = { ok: true; subtitlePath: string } | { ok: false; error: string; state?: 'queued' | 'failed' };

const realFiles: NonNullable<WorkerDeps['files']> = {
  writeFile: (path, text) => fs.writeFile(path, text, 'utf8'),
  rename: (from, to) => fs.rename(from, to),
  unlink: path => fs.unlink(path),
  exists: path => fs.access(path).then(() => true, () => false),
  readdir: async dir => (await fs.readdir(dir).catch(() => [])).map(String),
  mkdir: async dir => { await fs.mkdir(dir, { recursive: true }); },
};

export class SubtitleWorkerService {
  private files: NonNullable<WorkerDeps['files']>;
  private making = new Map<number, Promise<string>>();
  constructor(private deps: WorkerDeps) { this.files = deps.files ?? realFiles; }

  audioPath(jobId: number) { return join(this.deps.audioDir, `${jobId}.flac`); }

  // The next job for this worker, or undefined. Leases that ran out are taken back first. A job whose video has gone,
  // or whose length can't be read, uses an attempt and the next is tried.
  async claim(workerId: number): Promise<Claim | undefined> {
    if (readOnly()) return undefined;
    for (const id of this.deps.workers.expire()) await this.removeAudio(id);
    for (let tries = 0; tries < 5; tries++) {
      const job = this.deps.workers.claim(workerId);
      if (!job) return undefined;
      const file = this.deps.library.fileByPath(job.path), title = file && this.deps.library.title(file.titleId);
      const durationSec = file?.media.durationSec ?? await this.deps.probeDuration(job.path).catch(() => undefined);
      if (!file || !title || !durationSec) { this.deps.workers.fail(job.id, workerId, !file || !title ? 'The library no longer has the video.' : 'The video’s length couldn’t be read.'); continue; }
      const refs = title.kind === 'show' ? this.deps.library.fileEpisodes(title.id).get(file.id) ?? [] : [];
      const name = title.kind === 'show' ? `${title.title}${refs.length ? ` ${episodesLabel(refs)}` : ''}` : `${title.title}${title.year ? ` (${title.year})` : ''}`;
      return { id: job.id, title: name, language: 'en', durationSec, leaseUntil: job.leaseUntil, audio: `/api/v1/subtitle-worker/jobs/${job.id}/audio` };
    }
    return undefined;
  }

  // The job's audio, made once (concurrent requests share it) and kept until the job ends.
  async audio(workerId: number, jobId: number): Promise<string | undefined> {
    const job = this.deps.workers.held(jobId, workerId);
    if (!job) return undefined;
    const path = this.audioPath(jobId);
    if (await this.files.exists(path)) return path;
    let making = this.making.get(jobId);
    if (!making) {
      making = (async () => {
        await this.files.mkdir(this.deps.audioDir);
        const partial = `${path}.part`;
        try { await this.deps.makeAudio(job.path, partial); await this.files.rename(partial, path); }
        catch (e) { await this.files.unlink(partial).catch(() => undefined); throw e; }
        return path;
      })().finally(() => this.making.delete(jobId));
      this.making.set(jobId, making);
    }
    return making;
  }

  heartbeat(workerId: number, jobId: number) { return this.deps.workers.heartbeat(jobId, workerId); }

  async fail(workerId: number, jobId: number, reason: string) {
    const state = this.deps.workers.fail(jobId, workerId, reason);
    if (state) await this.removeAudio(jobId);
    return state;
  }

  // What the worker made: checked, then written as `<video>.en.srt` and recorded as `whisper`. One that fails the
  // checks counts as a failed attempt. An English sidecar that turned up meanwhile is kept, and recorded instead.
  async result(workerId: number, jobId: number, srt: string, model: string): Promise<ResultOutcome | undefined> {
    const job = this.deps.workers.held(jobId, workerId);
    if (!job) return undefined;
    const file = this.deps.library.fileByPath(job.path);
    const durationSec = file?.media.durationSec ?? await this.deps.probeDuration(job.path).catch(() => undefined);
    if (!file || !durationSec) return { ok: false, error: 'The library no longer has the video.', ...this.stateOf(await this.fail(workerId, jobId, 'The library no longer has the video.')) };
    const check = checkSrt(srt, durationSec);
    if (!check.ok) {
      this.deps.log('subtitles: the worker’s subtitle failed the checks', { path: job.path, model, error: check.error });
      return { ok: false, error: check.error, ...this.stateOf(await this.fail(workerId, jobId, check.error)) };
    }
    const dest = sidecarPath(job.path, false);
    if (readOnly()) { this.deps.log('subtitles: read-only, so the worker’s subtitle wasn’t written', { path: job.path }); return { ok: true, subtitlePath: dest }; }
    if (await this.files.exists(dest)) {
      this.deps.store.recordFile({ path: job.path, language: 'en', source: 'sidecar', subtitlePath: dest });
    } else {
      const partial = `${dest}.tk-partial`;
      await this.files.writeFile(partial, check.text);
      await this.files.rename(partial, dest);
      this.deps.store.recordFile({ path: job.path, language: 'en', source: 'whisper', subtitlePath: dest });
      this.deps.log('subtitles: made by the PC worker', { path: job.path, model, cues: check.cues });
    }
    await this.removeAudio(jobId);
    await this.deps.scan(dirname(job.path)).catch(e => this.deps.log('subtitles: Plex wasn’t told about the new subtitle', { path: job.path, ...errorDetail(e) }));
    return { ok: true, subtitlePath: dest };
  }

  // Leases that ran out are taken back, and audio for jobs no longer claimed is removed. Hourly, with the tidy.
  async sweep() {
    const expired = this.deps.workers.expire(), claimed = this.deps.workers.claimedIds();
    for (const name of await this.files.readdir(this.deps.audioDir)) {
      const id = Number(/^(\d+)\.flac(\.part)?$/.exec(name)?.[1]);
      if (Number.isInteger(id) && !claimed.has(id) && !this.making.has(id)) await this.files.unlink(join(this.deps.audioDir, name)).catch(() => undefined);
    }
    return expired.length;
  }

  private stateOf(state: 'queued' | 'failed' | undefined) { return state ? { state } : {}; }
  private async removeAudio(jobId: number) {
    await this.files.unlink(this.audioPath(jobId)).catch(e => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log('subtitles: the worker’s audio could not be deleted', { jobId, ...errorDetail(e) });
    });
  }
}
