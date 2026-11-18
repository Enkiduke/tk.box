import * as fs from 'node:fs/promises';
import { readOnly } from '../errors.js';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { runProcess } from '../streaming/ffmpeg.js';
import { parseRelease, type ParsedRelease } from '../lib/release-name.js';
import { qualityOf, type Quality } from '../lib/quality.js';
import { scoreFormats } from '../lib/formats.js';
import { audioChannelsName, audioCodecName, dynamicRangeName, episodeFileName, movieFileName, movieFolder, seasonFolder, seriesFolder, videoCodecName } from '../lib/naming.js';
import type { EpisodeRef, FileMedia, Grab, LibraryFileRow, LibraryStore, LibraryTitle } from '../persistence/library-store.js';

// Importing a finished download (docs/ARR-REPLACEMENT.md, "Import and seeding", steps 1 and 3–5): a movie's biggest
// video, or a show's videos mapped to episodes (docs/PHASE-2.md, step 3); check each, name it, bring it into the library
// and record it. Usenet downloads and unpacked RARs are renamed; torrents are hardlinked so they keep seeding
// (services/unpack.ts unpacks RARs first). Either is copied when the download is on another mount.

export const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi']);
export const SAMPLE_BYTES = 150 * 1024 * 1024;
const EXTRA_FOLDERS = /^(?:extras?|featurettes?|behind[ ._-]?the[ ._-]?scenes|deleted[ ._-]?scenes|interviews?|scenes|shorts?|trailers?|other|bonus|specials?)$/i;
const EXTRA_SUFFIX = /[ ._-](?:trailer|featurette|behindthescenes|deleted|deletedscene|interview|scene|short|other|extra)$/i;
const SAMPLE = /(?:^|[^a-z0-9])sample(?:[^a-z0-9]|$)/i;

export type Probe = { durationSec?: number; videoCodec?: string; audioCodec?: string; audioProfile?: string; channels?: number;
  transfer?: string; dolbyVision?: boolean; hdr10Plus?: boolean };
export type ProbeFn = (path: string, signal?: AbortSignal) => Promise<Probe>;
// The file operations import uses, so tests can make a rename fail with EXDEV or stop between two steps.
export type FileOps = Pick<typeof fs, 'rename' | 'copyFile' | 'unlink' | 'mkdir' | 'stat' | 'readdir' | 'rmdir' | 'rm' | 'link'>;
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

// A show's import: each file brought in, with the episodes it was recorded for.
export type EpisodeFileImported = { fileId: number; path: string; episodes: EpisodeRef[]; copied: boolean };
export type EpisodesOk = { ok: true; files: EpisodeFileImported[]; replaced: string[]; skipped: Skipped[] };
export type EpisodesResult = EpisodesOk | ImportRefused;

// What the importer needs to know about a show (Library builds it): its episodes, with names for the file names and
// runtimes for the length check; the runtime of one with none (the show's, else 45); and why a file doesn't better the
// library's file for an episode (the pick rules', so import and pick agree), undefined when it does or there's none.
export type ShowEpisode = { season: number; episode: number; name?: string; runtime?: number };
export type ShowImport = {
  episodes: readonly ShowEpisode[];
  runtime: number;
  noBetter: (season: number, episode: number, file: { quality: Quality; score: number; parsed: ParsedRelease }) => string | undefined;
};

const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const unlinkQuietly = async (ops: FileOps, path: string) => { try { await ops.unlink(path); } catch (e) { if (errno(e) !== 'ENOENT') throw e; } };
const pad2 = (n: number) => String(n).padStart(2, '0');
const code = ([season, episode]: EpisodeRef) => `S${pad2(season)}E${pad2(episode)}`;
const key = ([season, episode]: EpisodeRef) => `${season}:${episode}`;
const noVideo = (skipped: readonly Skipped[]) =>
  skipped.length ? `No usable video: ${skipped.map(s => `${basename(s.path)} is ${s.reason}`).join('; ')}.` : 'No video file in the download.';

// What a video's names say: its own, its folder's (when it's in one) and, for the quality, the grab's release name.
type Described = { fileParse: ParsedRelease; folderParse?: ParsedRelease; parsed: ParsedRelease; quality: Quality; score: number; labels: string[]; group?: string };

export class LibraryImporter {
  constructor(private store: LibraryStore, private probe: ProbeFn, private ops: FileOps = fs,
    private log: (message: string, detail: Record<string, unknown>) => void = () => {}, private minBytes = SAMPLE_BYTES) {}

  // An upgrade that stopped after the new file was recorded but before the old one went leaves the old one behind:
  // for a movie a second row (the newest is kept), for a show a file no episode is mapped to any more. Those are
  // deleted from disk, then forgotten. (So a show's file must be mapped to its episodes when it's recorded.)
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
    for (const file of this.store.unmappedShowFiles()) {
      await unlinkQuietly(this.ops, file.path);
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

  // An admin deleted one file: it goes from disk if it's inside the title's folder (a file recorded elsewhere is only
  // forgotten), its record goes, and a season folder it leaves empty goes too. Returns the folder for Plex to scan.
  async deleteOneFile(title: LibraryTitle, fileId: number) {
    const slash = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
    const file = this.store.file(fileId);
    if (!file || file.titleId !== title.id) return undefined;
    const folder = title.folder && !/[\\/]|^\.\.?$/.test(title.folder) ? `${slash(title.root)}/${title.folder}` : undefined;
    const path = slash(file.path), inside = !!folder && path.startsWith(`${folder}/`) && !path.split('/').includes('..');
    if (inside) await unlinkQuietly(this.ops, file.path);
    else this.log('library: forgot a file outside the title’s folder without deleting it', { title: title.id, path: file.path });
    this.store.deleteFile(file.id);
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (inside && parent !== folder) try { if (!(await this.ops.readdir(parent)).length) await this.ops.rmdir(parent); } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
    return { folder: inside ? folder : undefined, deleted: inside, path: file.path };
  }

  // An admin deleted the title: its whole folder under its root goes (season folders, subtitles, everything in it), and
  // the records of its files with it. Recorded files outside that folder are left alone. A folder another title also
  // uses isn't removed; only this title's own files in it are.
  async deleteTitleFolder(title: LibraryTitle) {
    const slash = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
    const folder = title.folder && !/[\\/]|^\.\.?$/.test(title.folder) ? `${slash(title.root)}/${title.folder}` : undefined;
    const shared = !!folder && this.store.titlesInFolder(title.root, title.folder!).some(id => id !== title.id);
    if (!folder || shared) {
      if (shared) this.log('library: another title uses this folder, so only the title’s own files go', { title: title.id, folder });
      const { removed } = await this.deleteFiles(title);
      return { folder, removed };
    }
    const inside = (path: string) => slash(path).startsWith(`${folder}/`) && !slash(path).split('/').includes('..');
    const removed: string[] = [];
    for (const file of this.store.files(title.id)) {
      if (!inside(file.path)) { this.log('library: left a file outside the title’s folder', { title: title.id, path: file.path }); continue; }
      removed.push(file.path);
    }
    await this.ops.rm(folder, { recursive: true, force: true });
    for (const file of this.store.files(title.id)) if (inside(file.path)) this.store.deleteFile(file.id);
    return { folder, removed };
  }

  // `runtimeMin` is TMDB's runtime; the file must be at least half of it. Errors it can't act on (permissions, a full
  // disk) are thrown, for the queue to retry.
  async import(grab: Grab, title: LibraryTitle, runtimeMin: number | undefined, signal?: AbortSignal, options: ImportOptions = {}): Promise<ImportResult> {
    await this.cleanLeftovers();
    const found = await this.videos(grab, options);
    if (!found.ok) return found;
    const { contentPath, videos, skipped } = found;
    const main = videos[0]!;
    const { parsed, quality, score, labels, group } = this.describe(main.path, contentPath, grab, title);

    const probe = await this.probe(main.path, signal);
    if (runtimeMin && runtimeMin > 0) {
      const tooShort = this.tooShort(probe, runtimeMin);
      if (tooShort) return { ok: false, failure: 'fake', reason: tooShort, skipped };
    }

    const media = mediaOf(parsed, probe);
    const naming = { title: title.title, ...(title.year ? { year: title.year } : {}), tmdbId: title.tmdbId };
    const folder = title.folder ?? movieFolder(naming);
    const name = movieFileName(naming, { quality, proper: parsed.proper, repack: parsed.repack, editions: parsed.editions, customFormats: labels,
      ...media, ...(group ? { group } : {}) });
    const dest = join(title.root, folder, `${name}${extname(main.path).toLowerCase()}`);

    const copied = await this.bringIn(main.path, dest, options);
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
    const replaced = await this.removeOld(this.store.files(title.id).filter(f => f.id !== fileId), [dest]);
    return { ok: true, fileId, path: dest, copied, replaced, skipped };
  }

  // A show's download: every video in it, each mapped to episodes by its SxxEyy (its folder's when its own name is
  // obfuscated; a grab of one episode with one video takes it). Only episodes the grab covers count; the biggest file
  // for an episode wins; a file that doesn't better the library's for each of its episodes is skipped, as is one under
  // half their runtimes. Each file is recorded with its episodes, which move off the file they had; a file left with no
  // episodes is then deleted. Fewer files than the grab said is fine: the rest stay wanted. None at all is a failure.
  async importEpisodes(grab: Grab, title: LibraryTitle, show: ShowImport, signal?: AbortSignal, options: ImportOptions = {}): Promise<EpisodesResult> {
    await this.cleanLeftovers();
    if (title.tvdbId === undefined) throw new Error(`${title.title} has no TVDB id to name its files by.`);
    const found = await this.videos(grab, options);
    if (!found.ok) return found;
    const { contentPath, videos } = found, skipped = [...found.skipped];
    const known = new Map(show.episodes.map(e => [key([e.season, e.episode]), e]));
    const covered = new Set(grab.episodes.length ? grab.episodes.map(key) : known.keys());
    const claimed = new Set<string>();

    type Plan = { video: Found; described: Described; refs: EpisodeRef[]; probe?: Probe };
    const plans: Plan[] = [];
    for (const video of videos) {
      const described = this.describe(video.path, contentPath, grab, title);
      const named = [described.fileParse, described.folderParse].find(p => p && !p.obfuscated && !p.multiSeason && p.season !== undefined && p.episodes.length);
      let refs: EpisodeRef[] = named ? named.episodes.map(e => [named.season!, e] as EpisodeRef) : [];
      if (!named && videos.length === 1 && covered.size === 1) refs = [...covered].map(k => k.split(':').map(Number) as EpisodeRef);
      if (!refs.length) { skipped.push({ path: video.path, reason: 'not named for an episode' }); continue; }
      const inGrab = refs.filter(r => covered.has(key(r)) && known.has(key(r)));
      if (!inGrab.length) { skipped.push({ path: video.path, reason: `${refs.map(code).join(', ')} not in the grab` }); continue; }
      const free = inGrab.filter(r => !claimed.has(key(r)));
      if (!free.length) { skipped.push({ path: video.path, reason: `a bigger file has ${inGrab.map(code).join(', ')}` }); continue; }
      // Every episode it holds must be bettered, as a pick requires: a file never replaces an episode with one no better.
      const worse = free.flatMap(r => { const why = show.noBetter(r[0], r[1], described); return why ? [`${code(r)}: ${why}`] : []; });
      if (worse.length) { skipped.push({ path: video.path, reason: worse.join('; ') }); continue; }
      for (const r of free) claimed.add(key(r));
      plans.push({ video, described, refs: free });
    }

    // The length check for every file first, so the grab can be recorded with the last file brought in.
    let fakes = 0;
    for (const plan of plans) {
      const probe = await this.probe(plan.video.path, signal);
      const minutes = plan.refs.reduce((sum, r) => sum + (known.get(key(r))?.runtime || show.runtime), 0);
      const tooShort = this.tooShort(probe, minutes);
      if (tooShort) { fakes++; skipped.push({ path: plan.video.path, reason: `a fake: ${tooShort}` }); continue; }
      plan.probe = probe;
    }
    const keep = plans.filter((p): p is Plan & { probe: Probe } => !!p.probe);
    if (!keep.length) {
      const reason = `No usable episode: ${skipped.map(s => `${basename(s.path)}, ${s.reason}`).join('; ')}.`;
      return { ok: false, failure: fakes && fakes === plans.length ? 'fake' : 'no-file', reason, skipped };
    }

    const naming = { title: title.title, ...(title.year ? { year: title.year } : {}), tvdbId: title.tvdbId };
    const folder = title.folder ?? seriesFolder(naming);
    const files: EpisodeFileImported[] = [];
    for (const [index, { video, described: { parsed, quality, score, labels, group }, refs, probe }] of keep.entries()) {
      const media = mediaOf(parsed, probe), ext = extname(video.path).toLowerCase();
      const sorted = [...refs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const episodes = sorted.map(r => { const name = known.get(key(r))?.name; return { season: r[0], episode: r[1], ...(name ? { title: name } : {}) }; });
      const name = episodeFileName(naming, episodes, { quality, proper: parsed.proper, repack: parsed.repack, customFormats: labels, ...media, ...(group ? { group } : {}) }, ext);
      const dest = join(title.root, folder, seasonFolder(sorted[0]![0]), `${name}${ext}`);
      const copied = await this.bringIn(video.path, dest, options);
      if (copied) media.copied = true;
      const last = index === keep.length - 1;
      // Recorded with its episodes in one step (so a show's file is never recorded unmapped), the grab with the last.
      const fileId = this.store.db.transaction(() => {
        this.store.setFolder(title.id, folder);
        const id = this.store.insertFile({ titleId: title.id, path: dest, size: video.size, quality, proper: parsed.proper || parsed.repack, score,
          releaseName: grab.releaseName, ...(group ? { releaseGroup: group } : {}), media, grabId: grab.id });
        this.store.mapEpisodes(id, title.id, sorted);
        if (last) this.store.updateGrab(grab.id, { state: options.state ?? 'imported', importedAt: Date.now(), progress: 1, error: null },
          keep.length > 1 ? `${keep.length} files into ${dirname(dest)}` : dest);
        if (copied) this.store.audit('library_import_copied', { grab: grab.id, title: title.id, from: video.path, to: dest });
        return id;
      })();
      files.push({ fileId, path: dest, episodes: sorted, copied });
    }
    const replaced = await this.removeOld(this.store.unmappedShowFiles(title.id), files.map(f => f.path));
    return { ok: true, files, replaced, skipped };
  }

  // The download's videos (from the unpack folder when there is one), or why there are none to look at.
  private async videos(grab: Grab, options: ImportOptions): Promise<{ ok: true; contentPath: string; videos: Found[]; skipped: Skipped[] } | ImportRefused> {
    const contentPath = options.from ?? grab.contentPath;
    if (!contentPath) return { ok: false, failure: 'no-file', reason: 'The downloader gave no folder.', skipped: [] };
    let found: Awaited<ReturnType<typeof findVideos>>;
    try { found = await findVideos(contentPath, this.ops, this.minBytes); }
    catch (e) { if (errno(e) === 'ENOENT') return { ok: false, failure: 'no-file', reason: `${contentPath} doesn't exist.`, skipped: [] }; throw e; }
    if (!found.videos.length) return { ok: false, failure: 'no-file', reason: noVideo(found.skipped), skipped: found.skipped };
    return { ok: true, contentPath, ...found };
  }

  // The file's own name, the folder's when the file's is obfuscated, else the release name the grab was for; and its
  // score under the title's profile when imported (shown on the file; picks work it out again from the name).
  private describe(path: string, contentPath: string, grab: Grab, title: LibraryTitle): Described {
    const fileParse = parseRelease(basename(path, extname(path)));
    const folderParse = path !== contentPath ? parseRelease(basename(dirname(path))) : undefined;
    const release = parseRelease(grab.releaseName);
    const parsed = [fileParse, ...(folderParse ? [folderParse] : []), release].find(p => !p.obfuscated && qualityOf(p)) ?? release;
    const quality = qualityOf(parsed) ?? grab.quality;
    const { score, labels } = scoreFormats({ parsed, quality }, this.store.formats(), this.store.profile(title.profileId)?.scores ?? {});
    const group = parsed.group ?? release.group;
    return { fileParse, ...(folderParse ? { folderParse } : {}), parsed, quality, score, labels, ...(group ? { group } : {}) };
  }

  // Why the file fails the length check (at least half of `minutes`), or undefined when it passes.
  private tooShort(probe: Probe, minutes: number) {
    if (probe.durationSec === undefined) return 'ffprobe found no length.';
    if (probe.durationSec < minutes * 60 / 2) return `It runs ${Math.round(probe.durationSec / 60)} min, under half of the ${minutes} min runtime.`;
    return undefined;
  }

  private bringIn(source: string, dest: string, options: ImportOptions) {
    return options.link ? this.linkInto(source, dest) : this.place(source, dest);
  }

  // Files an import replaced: deleted from disk (unless a new file took the same path), then forgotten. One that can't
  // be removed yet is left for the next pass (cleanLeftovers).
  private async removeOld(old: readonly LibraryFileRow[], kept: readonly string[]) {
    const replaced: string[] = [];
    for (const file of old) {
      try {
        if (!kept.includes(file.path)) await unlinkQuietly(this.ops, file.path);
        this.store.deleteFile(file.id);
        replaced.push(file.path);
      } catch (e) {
        this.log('library: the old file could not be removed yet', { path: file.path, error: (e as Error).message });
      }
    }
    return replaced;
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

function mediaOf(parsed: ParsedRelease, probe: Probe): FileMedia {
  return {
    ...(probe.durationSec !== undefined ? { durationSec: Math.round(probe.durationSec) } : {}),
    ...optional('videoCodec', videoCodecName(parsed, probe.videoCodec)),
    ...optional('dynamicRange', dynamicRangeName(probe)),
    ...optional('audioCodec', audioCodecName(probe.audioCodec, probe.audioProfile)),
    ...optional('audioChannels', audioChannelsName(probe.channels)),
  };
}

function optional<K extends keyof FileMedia>(key: K, value: FileMedia[K] | undefined): Partial<FileMedia> {
  return value === undefined ? {} : { [key]: value } as Partial<FileMedia>;
}
