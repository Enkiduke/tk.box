import * as fs from 'node:fs/promises';
import { readOnly } from '../errors.js';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { runProcess } from '../streaming/ffmpeg.js';
import { parseRelease, type ParsedRelease } from '../lib/release-name.js';
import { qualityOf } from '../lib/quality.js';
import { scoreFormats } from '../lib/formats.js';
import { audioChannelsName, audioCodecName, dynamicRangeName, movieFileName, movieFolder, videoCodecName } from '../lib/naming.js';
import type { FileMedia, Grab, LibraryStore, LibraryTitle } from '../persistence/library-store.js';

// Importing a finished movie download (docs/ARR-REPLACEMENT.md, "Import and seeding", steps 1 and 3–5): find the video,
// check it, name it, bring it into the library and record it. Usenet downloads and unpacked RARs are renamed; torrents
// are hardlinked so they keep seeding (services/unpack.ts unpacks RARs first). Either is copied when the download is on
// another mount.

export const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi']);
export const SAMPLE_BYTES = 150 * 1024 * 1024;
const EXTRA_FOLDERS = /^(?:extras?|featurettes?|behind[ ._-]?the[ ._-]?scenes|deleted[ ._-]?scenes|interviews?|scenes|shorts?|trailers?|other|bonus|specials?)$/i;
const EXTRA_SUFFIX = /[ ._-](?:trailer|featurette|behindthescenes|deleted|deletedscene|interview|scene|short|other|extra)$/i;
const SAMPLE = /(?:^|[^a-z0-9])sample(?:[^a-z0-9]|$)/i;

export type Probe = { durationSec?: number; videoCodec?: string; audioCodec?: string; audioProfile?: string; channels?: number;
  transfer?: string; dolbyVision?: boolean; hdr10Plus?: boolean };
export type ProbeFn = (path: string, signal?: AbortSignal) => Promise<Probe>;
// The file operations import uses, so tests can make a rename fail with EXDEV or stop between two steps.
export type FileOps = Pick<typeof fs, 'rename' | 'copyFile' | 'unlink' | 'mkdir' | 'stat' | 'readdir' | 'rmdir' | 'link'>;
// How a download is brought in. Usenet and unpacked files are moved (renamed); a torrent's file is hardlinked, so it
// keeps seeding. Both copy instead on EXDEV (another mount), and a hardlink copies too where links aren't possible.
// `from` is the folder to read instead of the grab's (the unpack folder); `state` is the grab's state once imported
// (`seeding` for a torrent).
export type ImportOptions = { from?: string; link?: boolean; state?: 'imported' | 'seeding' };

export type Found = { path: string; size: number };
export type Skipped = { path: string; reason: string };

// Video files under `root` (or `root` itself), biggest first. Samples (named so, or under 150 MB) and extras go.
export async function findVideos(root: string, ops: FileOps = fs, minBytes = SAMPLE_BYTES): Promise<{ videos: Found[]; skipped: Skipped[] }> {
  const videos: Found[] = [], skipped: Skipped[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    const info = await ops.stat(path);
    if (info.isDirectory()) {
      if (depth > 4) return;
      for (const name of (await ops.readdir(path)).sort()) await visit(join(path, String(name)), depth + 1);
      return;
    }
    if (!info.isFile() || !VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) return;
    const inside = relative(root, path), parts = inside ? inside.split(sep) : [basename(path)], stem = basename(path, extname(path));
    if (parts.some(p => SAMPLE.test(p))) skipped.push({ path, reason: 'a sample' });
    else if (parts.slice(0, -1).some(p => EXTRA_FOLDERS.test(p)) || EXTRA_SUFFIX.test(stem)) skipped.push({ path, reason: 'an extra' });
    else if (info.size < minBytes) skipped.push({ path, reason: `under ${Math.round(minBytes / 1024 / 1024)} MB` });
    else videos.push({ path, size: info.size });
  };
  await visit(root, 0);
  return { videos: videos.sort((a, b) => b.size - a.size), skipped };
}

// ffprobe under `nice -n 15` (and `ionice -c3` where it exists) on the server; straight on Windows (development).
export function ffprobe(executable = 'ffprobe'): ProbeFn {
  const args = (path: string) => ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path];
  const ionice = ['/usr/bin/ionice', '/bin/ionice'].find(p => existsSync(p));
  return async (path, signal) => {
    const command = process.platform === 'win32' ? { exe: executable, args: args(path) }
      : ionice ? { exe: ionice, args: ['-c3', 'nice', '-n', '15', executable, ...args(path)] } : { exe: 'nice', args: ['-n', '15', executable, ...args(path)] };
    const { stdout } = await runProcess(command.exe, command.args, 120000, signal);
    return parseProbe(JSON.parse(stdout));
  };
}

type Json = Record<string, unknown>;
export function parseProbe(data: unknown): Probe {
  const root = (data && typeof data === 'object' ? data : {}) as Json;
  const streams = (Array.isArray(root.streams) ? root.streams : []).filter((s): s is Json => !!s && typeof s === 'object');
  const video = streams.find(s => s.codec_type === 'video' && !(s.disposition as Json | undefined)?.attached_pic), audio = streams.find(s => s.codec_type === 'audio');
  const side = (Array.isArray(video?.side_data_list) ? video.side_data_list : []) as Json[];
  const duration = Number((root.format as Json | undefined)?.duration);
  const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
  return {
    ...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
    ...(str(video?.codec_name) ? { videoCodec: str(video?.codec_name) } : {}),
    ...(str(audio?.codec_name) ? { audioCodec: str(audio?.codec_name) } : {}),
    ...(str(audio?.profile) ? { audioProfile: str(audio?.profile) } : {}),
    ...(typeof audio?.channels === 'number' ? { channels: audio.channels } : {}),
    ...(str(video?.color_transfer) ? { transfer: str(video?.color_transfer) } : {}),
    dolbyVision: side.some(s => /dovi|dolby vision/i.test(String(s.side_data_type ?? ''))),
    hdr10Plus: side.some(s => /2094-40|hdr10\+/i.test(String(s.side_data_type ?? ''))),
  };
}

export type ImportOk = { ok: true; fileId: number; path: string; copied: boolean; replaced: string[]; skipped: Skipped[] };
// A failed download by the failure rules: nothing usable, or a fake by the length check.
export type ImportRefused = { ok: false; failure: 'no-file' | 'fake'; reason: string; skipped: Skipped[] };
export type ImportResult = ImportOk | ImportRefused;

const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const unlinkQuietly = async (ops: FileOps, path: string) => { try { await ops.unlink(path); } catch (e) { if (errno(e) !== 'ENOENT') throw e; } };

export class MovieImporter {
  constructor(private store: LibraryStore, private probe: ProbeFn, private ops: FileOps = fs,
    private log: (message: string, detail: Record<string, unknown>) => void = () => {}, private minBytes = SAMPLE_BYTES) {}

  // An upgrade that stopped after the new file was recorded but before the old one went leaves two rows for the
  // movie. The newest is the one to keep; the others are deleted from disk, then forgotten.
  async cleanLeftovers() {
    const removed: string[] = [], kept = new Map<number, string>();
    if (readOnly()) return removed;
    for (const file of this.store.leftoverFiles()) {
      const keep = kept.get(file.titleId);
      if (keep === undefined) { kept.set(file.titleId, file.path); continue; }
      if (file.path !== keep) await unlinkQuietly(this.ops, file.path);
      this.store.deleteFile(file.id);
      removed.push(file.path);
    }
    if (removed.length) this.log('library: removed files left by an interrupted upgrade', { files: removed });
    return removed;
  }

  // Deletes a movie's files that are in its own folder under its root, then the folder if nothing else is left in it
  // (sidecar subtitles and the like keep it). Files recorded anywhere else are left alone. Returns the folder.
  async deleteFiles(title: LibraryTitle) {
    const slash = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
    const folder = title.folder && !/[\\/]|^\.\.?$/.test(title.folder) ? `${slash(title.root)}/${title.folder}` : undefined;
    const inside = (path: string) => !!folder && slash(path).startsWith(`${folder}/`) && !slash(path).split('/').includes('..');
    const removed: string[] = [];
    for (const file of this.store.files(title.id)) {
      if (!inside(file.path)) { this.log('library: left a file outside the movie’s folder', { title: title.id, path: file.path }); continue; }
      await unlinkQuietly(this.ops, file.path);
      this.store.deleteFile(file.id);
      removed.push(file.path);
    }
    if (folder) try { if (!(await this.ops.readdir(folder)).length) await this.ops.rmdir(folder); } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
    return { folder, removed };
  }

  // `runtimeMin` is TMDB's runtime; the file must be at least half of it. Errors it can't act on (permissions, a full
  // disk) are thrown, for the queue to retry.
  async import(grab: Grab, title: LibraryTitle, runtimeMin: number | undefined, signal?: AbortSignal, options: ImportOptions = {}): Promise<ImportResult> {
    await this.cleanLeftovers();
    const contentPath = options.from ?? grab.contentPath;
    if (!contentPath) return { ok: false, failure: 'no-file', reason: 'The downloader gave no folder.', skipped: [] };
    let found: Awaited<ReturnType<typeof findVideos>>;
    try { found = await findVideos(contentPath, this.ops, this.minBytes); }
    catch (e) { if (errno(e) === 'ENOENT') return { ok: false, failure: 'no-file', reason: `${contentPath} doesn't exist.`, skipped: [] }; throw e; }
    const { videos, skipped } = found;
    const main = videos[0];
    if (!main) return { ok: false, failure: 'no-file', reason: skipped.length ? `No usable video: ${skipped.map(s => `${basename(s.path)} is ${s.reason}`).join('; ')}.` : 'No video file in the download.', skipped };

    // The file's own name, the folder's when the file's is obfuscated, else the release name the grab was for.
    const fileParse = parseRelease(basename(main.path, extname(main.path)));
    const folderName = main.path !== contentPath ? basename(dirname(main.path)) : undefined;
    const candidates = [fileParse, ...(folderName ? [parseRelease(folderName)] : []), parseRelease(grab.releaseName)];
    const parsed: ParsedRelease = candidates.find(p => !p.obfuscated && qualityOf(p)) ?? parseRelease(grab.releaseName);
    const quality = qualityOf(parsed) ?? grab.quality;

    const probe = await this.probe(main.path, signal);
    if (runtimeMin && runtimeMin > 0) {
      const need = runtimeMin * 60 / 2;
      if (probe.durationSec === undefined) return { ok: false, failure: 'fake', reason: 'ffprobe found no length.', skipped };
      if (probe.durationSec < need) return { ok: false, failure: 'fake',
        reason: `It runs ${Math.round(probe.durationSec / 60)} min, under half of the ${runtimeMin} min runtime.`, skipped };
    }

    // The score under the title's profile when imported (shown on the file; picks work it out again from the name).
    const { score, labels } = scoreFormats({ parsed, ...(quality ? { quality } : {}) }, this.store.formats(), this.store.profile(title.profileId)?.scores ?? {});
    const media: FileMedia = {
      ...(probe.durationSec !== undefined ? { durationSec: Math.round(probe.durationSec) } : {}),
      ...optional('videoCodec', videoCodecName(parsed, probe.videoCodec)),
      ...optional('dynamicRange', dynamicRangeName(probe)),
      ...optional('audioCodec', audioCodecName(probe.audioCodec, probe.audioProfile)),
      ...optional('audioChannels', audioChannelsName(probe.channels)),
    };
    const naming = { title: title.title, ...(title.year ? { year: title.year } : {}), tmdbId: title.tmdbId };
    const group = parsed.group ?? parseRelease(grab.releaseName).group;
    const folder = title.folder ?? movieFolder(naming);
    const name = movieFileName(naming, { quality, proper: parsed.proper, repack: parsed.repack, editions: parsed.editions, customFormats: labels,
      ...media, ...(group ? { group } : {}) });
    const dest = join(title.root, folder, `${name}${extname(main.path).toLowerCase()}`);

    const copied = options.link ? await this.linkInto(main.path, dest) : await this.place(main.path, dest);
    if (copied) media.copied = true;
    // Recorded first: the new file, the title's folder and the grab. Only then does the old file go.
    const fileId = this.store.db.transaction(() => {
      this.store.setFolder(title.id, folder);
      const id = this.store.insertFile({ titleId: title.id, path: dest, size: main.size, quality, proper: parsed.proper || parsed.repack, score,
        releaseName: grab.releaseName, ...(group ? { releaseGroup: group } : {}), media, grabId: grab.id });
      this.store.updateGrab(grab.id, { state: options.state ?? 'imported', importedAt: Date.now(), progress: 1, error: null }, dest);
      // On another mount the file was copied, not moved: said in the activity (Admin › Downloads reads it in 1c).
      if (copied) this.store.audit('library_import_copied', { grab: grab.id, title: title.id, from: main.path, to: dest });
      return id;
    })();
    const replaced: string[] = [];
    for (const old of this.store.files(title.id).filter(f => f.id !== fileId)) {
      try {
        if (old.path !== dest) await unlinkQuietly(this.ops, old.path);
        this.store.deleteFile(old.id);
        replaced.push(old.path);
      } catch (e) {
        // Left for the next pass (cleanLeftovers), which removes it.
        this.log('library: the old file could not be removed yet', { path: old.path, error: (e as Error).message });
      }
    }
    return { ok: true, fileId, path: dest, copied, replaced, skipped };
  }

  // Hardlinks into the library (to a partial name, renamed into place, so a file already there is replaced whole). On
  // EXDEV, or where the filesystem takes no links, copies instead. The download's own file stays: it is seeding.
  private async linkInto(source: string, dest: string) {
    await this.ops.mkdir(dirname(dest), { recursive: true });
    if (source === dest) return false;
    const partial = `${dest}.tk-partial`;
    await unlinkQuietly(this.ops, partial);
    let copied = false;
    try { await this.ops.link(source, partial); }
    catch (e) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(errno(e) ?? '')) throw e;
      copied = true;
      try { await this.ops.copyFile(source, partial); } catch (copyError) { await unlinkQuietly(this.ops, partial).catch(() => {}); throw copyError; }
    }
    try { await this.ops.rename(partial, dest); } catch (e) { await unlinkQuietly(this.ops, partial).catch(() => {}); throw e; }
    return copied;
  }

  // Renames into the library; on EXDEV (another mount) copies to a partial name, renames that into place, then removes
  // the download's copy. True when it copied.
  private async place(source: string, dest: string) {
    await this.ops.mkdir(dirname(dest), { recursive: true });
    if (source === dest) return false;
    try { await this.ops.rename(source, dest); return false; }
    catch (e) { if (errno(e) !== 'EXDEV') throw e; }
    const partial = `${dest}.tk-partial`;
    try {
      await this.ops.copyFile(source, partial);
      await this.ops.rename(partial, dest);
    } catch (e) { await unlinkQuietly(this.ops, partial).catch(() => {}); throw e; }
    await unlinkQuietly(this.ops, source);
    return true;
  }
}

function optional<K extends keyof FileMedia>(key: K, value: FileMedia[K] | undefined): Partial<FileMedia> {
  return value === undefined ? {} : { [key]: value } as Partial<FileMedia>;
}
