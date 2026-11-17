import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { runProcess } from '../streaming/ffmpeg.js';

// Does a video already have English? (docs/PHASE-4.md, step 2.) An embedded English *text* track that isn't forced
// (image tracks, PGS and VobSub, don't count: question 3), or an English sidecar beside it that isn't forced.

export type SubtitleStream = { codec?: string; language?: string; title?: string; forced: boolean };
export type ProbeSubtitles = (path: string, signal?: AbortSignal) => Promise<SubtitleStream[]>;

const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const ENGLISH = new Set(['en', 'eng', 'english']);

export const isEnglishText = (s: SubtitleStream) =>
  !!s.codec && TEXT_CODECS.has(s.codec.toLowerCase()) && !!s.language && ENGLISH.has(s.language.toLowerCase()) && !s.forced && !/forced/i.test(s.title ?? '');

type Json = Record<string, unknown>;
export function parseSubtitleStreams(data: unknown): SubtitleStream[] {
  const streams = Array.isArray((data as Json | undefined)?.streams) ? (data as Json).streams as unknown[] : [];
  return streams.filter((s): s is Json => !!s && typeof s === 'object' && (s as Json).codec_type === 'subtitle').map(s => {
    const tags = (s.tags && typeof s.tags === 'object' ? s.tags : {}) as Json, disposition = (s.disposition && typeof s.disposition === 'object' ? s.disposition : {}) as Json;
    const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
    const codec = str(s.codec_name), language = str(tags.language), title = str(tags.title);
    return { ...(codec ? { codec } : {}), ...(language ? { language } : {}), ...(title ? { title } : {}), forced: disposition.forced === 1 };
  });
}

// ffprobe's subtitle streams, under `nice -n 15` (and `ionice -c3`) on the server, as the library's ffprobe runs.
export function probeSubtitles(executable = 'ffprobe'): ProbeSubtitles {
  const args = (path: string) => ['-v', 'error', '-select_streams', 's', '-show_streams', '-of', 'json', path];
  const ionice = ['/usr/bin/ionice', '/bin/ionice'].find(p => existsSync(p));
  return async (path, signal) => {
    const command = process.platform === 'win32' ? { exe: executable, args: args(path) }
      : ionice ? { exe: ionice, args: ['-c3', 'nice', '-n', '15', executable, ...args(path)] } : { exe: 'nice', args: ['-n', '15', executable, ...args(path)] };
    const { stdout } = await runProcess(command.exe, command.args, 120000, signal);
    return parseSubtitleStreams(JSON.parse(stdout));
  };
}

// An English sidecar's name for the video `stem`: `<stem>.en.srt`, `.eng.srt`, `.english.srt`, with `.sdh`, `.hi`
// or `.cc` allowed, and `.ass`, `.ssa` or `.vtt` too. `.forced` (or `.foreign`) anywhere doesn't count.
export function englishSidecar(stem: string, name: string) {
  if (!name.toLowerCase().startsWith(stem.toLowerCase() + '.')) return false;
  const rest = name.slice(stem.length + 1).toLowerCase().split('.');
  if (rest.includes('forced') || rest.includes('foreign')) return false;
  return rest.length >= 2 && ['srt', 'ass', 'ssa', 'vtt'].includes(rest.at(-1)!) && ENGLISH.has(rest[0]!) && rest.slice(1, -1).every(p => ['sdh', 'hi', 'cc'].includes(p));
}

// The English sidecar beside a video, if there is one.
export async function findSidecar(videoPath: string, list: (dir: string) => Promise<string[]> = async d => (await readdir(d)).map(String)): Promise<string | undefined> {
  const dir = dirname(videoPath), stem = basename(videoPath, extname(videoPath));
  let names: string[];
  try { names = await list(dir); } catch { return undefined; }
  const name = names.sort().find(n => englishSidecar(stem, n));
  return name ? join(dir, name) : undefined;
}
