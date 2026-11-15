import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { movieFolder } from '../lib/naming.js';
import { AppError, requireThat, requireWritable } from '../errors.js';
import { isQuality, type Quality } from '../lib/quality.js';
import { remoteJson, remoteMessage } from '../providers/remote-json.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { FileMedia, LibraryStore, Released } from '../persistence/library-store.js';
import type { RequestStore } from '../persistence/requests-store.js';
import type { CutoverPlan, CutoverProblem, CutoverView } from '../../../../packages/contracts/src/downloads.js';

// The movie cutover from Radarr (docs/ARR-REPLACEMENT.md, "Phases" › Phase 1 › Cutover and Rollback). Radarr is only
// read: its /movie, naming config and tags. Nothing is written there, and it's never started or stopped from here.
//
// - Dry run: what an import would write, with counts and problems. Nothing is written.
// - Import: library_titles (folder from Radarr's path, Keep from Clean Up's protected tag) and library_files (Radarr's
//   quality), and each title's Radarr id. Refused while Radarr's naming differs from the plan's, and once movies are on
//   tk.box. Running it again updates what an earlier one wrote.
// - Switch: requests' arr_id moves from Radarr's ids to library_titles ids, and movies are fulfilled by tk.box.
// - Switch back: requests made before the switch get their Radarr id back, those made since get none (and open ones
//   go back to queued, so the sweep sends them to Radarr), and movies go back to Radarr.
// The rewrite happens on Switch rather than Import so a request never points at the wrong service in between.

export type RadarrMovieFile = { relativePath?: string; path?: string; size?: number; sceneName?: string; releaseGroup?: string;
  quality?: { quality?: { name?: string }; revision?: { version?: number; isRepack?: boolean } };
  mediaInfo?: { audioCodec?: string; audioChannels?: number; videoCodec?: string; videoDynamicRangeType?: string; runTime?: string } };
export type RadarrMovie = { id?: number; title?: string; originalTitle?: string; alternateTitles?: { title?: string }[]; year?: number; tmdbId?: number; imdbId?: string;
  monitored?: boolean; hasFile?: boolean; path?: string; tags?: number[]; inCinemas?: string; digitalRelease?: string; physicalRelease?: string; movieFile?: RadarrMovieFile };
export type RadarrNaming = { renameMovies?: boolean; standardMovieFormat?: string; movieFolderFormat?: string; colonReplacementFormat?: string };
export type RadarrData = { movies: RadarrMovie[]; naming: RadarrNaming; tags: { id?: number; label?: string }[] };

export type PlannedMovie = { radarrId: number; tmdbId: number; imdbId?: string; title: string; year?: number; aliases: string[]; monitored: boolean; keep: boolean;
  folder: string; released: Released;
  file?: { path: string; size: number; quality: Quality; proper: boolean; releaseName?: string; releaseGroup?: string; media: FileMedia } };

// Radarr's qualities that aren't rungs of the ladder by that name. SD becomes DVD, the lowest non-early rung.
const QUALITY_ALIASES: Record<string, Quality> = {
  DVDSCR: 'SCREENER', REGIONAL: 'SCREENER', 'DVD-R': 'DVD', SDTV: 'DVD', 'WEBDL-480p': 'DVD', 'WEBRip-480p': 'DVD', 'Bluray-480p': 'DVD', 'Bluray-576p': 'DVD',
  'Raw-HD': 'HDTV-1080p', 'BR-DISK': 'Remux-1080p',
};
export function ladderQuality(name: string | undefined): Quality | undefined {
  if (!name) return undefined;
  return isQuality(name) ? name : QUALITY_ALIASES[name];
}
const day = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !value.startsWith('0001') ? value.slice(0, 10) : undefined;
const channels = (n: number | undefined) => n === undefined || !Number.isFinite(n) ? undefined : n.toFixed(1);
const trimSlash = (p: string) => p.replace(/[\\/]+$/, '');

// Reads what the dry run and import need from Radarr. Read only.
export async function readRadarr(service: ArrService, transport: typeof fetch = fetch): Promise<RadarrData> {
  requireThat(service.url && service.key, 'CUTOVER_RADARR_MISSING', 'Connect Radarr in Admin › Connections first. It must be running for the import.', 409);
  const get = async (path: string) => {
    let response;
    try { response = await remoteJson(new URL(`${trimSlash(service.url)}/api/v3/${path}`), { headers: { 'X-Api-Key': service.key! } }, 'Radarr', transport, 60000, 128 * 1024 * 1024); }
    catch (e) { throw new AppError('CUTOVER_RADARR_UNAVAILABLE', `Radarr can't be reached: ${(e as Error).message}`, 502); }
    if (response.status === 401 || response.status === 403) throw new AppError('CUTOVER_RADARR_UNAVAILABLE', 'Radarr refused the API key.', 502);
    if (response.status >= 400) throw new AppError('CUTOVER_RADARR_UNAVAILABLE', remoteMessage(response.data) ?? `Radarr answered ${response.status}.`, 502);
    return response.data;
  };
  const [movies, naming, tags] = await Promise.all([get('movie'), get('config/naming'), get('tag')]);
  requireThat(Array.isArray(movies) && naming && typeof naming === 'object' && Array.isArray(tags), 'CUTOVER_RADARR_UNAVAILABLE', 'Radarr answered with something unexpected.', 502);
  return { movies: movies as RadarrMovie[], naming: naming as RadarrNaming, tags: tags as RadarrData['tags'] };
}

const slash = (p: string) => trimSlash(p.replaceAll('\\', '/'));
// The folders Radarr keeps movies in (each movie's parent folder).
export function radarrRoots(data: RadarrData) {
  return [...new Set(data.movies.flatMap(m => typeof m.path === 'string' && m.path ? [posix.dirname(slash(m.path))] : []))];
}
// Radarr's roots that are tk.box's movie root under another name, by where each resolves on disk (on Whatbox,
// /home/<user> is a link to /mnt/<disk>/<user>). One that doesn't resolve here isn't the same folder.
export async function sameRoots(roots: readonly string[], root: string, resolve: (path: string) => Promise<string> = realpath) {
  const real = async (p: string) => slash(await resolve(p));
  const mine = await real(root).catch(() => slash(root)), same: string[] = [];
  for (const r of roots) if (r !== slash(root) && await real(r).then(p => p === mine, () => false)) same.push(r);
  return same;
}

// What an import would write, and what stops it or is left out. Pure. `sameAs` are Radarr's roots that are the movie
// root under another name; what's under them is recorded under the movie root.
export function planMovies(data: RadarrData, settings: { roots: { movie: string }; naming: { movieFolder: string; movieFile: string } }, keepTags: readonly string[],
  sameAs: readonly string[] = []) {
  const problems: CutoverProblem[] = [], titles: PlannedMovie[] = [];
  const naming = data.naming;
  if ((naming.standardMovieFormat ?? '').trim() !== settings.naming.movieFile.trim())
    problems.push({ kind: 'naming', blocking: true, detail: `Radarr's movie file format is “${naming.standardMovieFormat ?? ''}”` });
  if ((naming.movieFolderFormat ?? '').trim() !== settings.naming.movieFolder.trim())
    problems.push({ kind: 'naming', blocking: true, detail: `Radarr's movie folder format is “${naming.movieFolderFormat ?? ''}”` });
  // A colon CleanTitle leaves (10:30) is replaced the way Radarr's “Smart Replace” does.
  if (naming.colonReplacementFormat && naming.colonReplacementFormat !== 'smart')
    problems.push({ kind: 'naming', blocking: false, detail: `Radarr replaces colons with “${naming.colonReplacementFormat}”; tk.box uses smart replace` });
  if (naming.renameMovies === false) problems.push({ kind: 'naming', blocking: false, detail: 'Radarr doesn’t rename movies, so older files may not follow the format' });

  const keepLabels = new Set(keepTags.map(t => t.toLowerCase()));
  const keepIds = new Set(data.tags.flatMap(t => typeof t.id === 'number' && typeof t.label === 'string' && keepLabels.has(t.label.toLowerCase()) ? [t.id] : []));
  const root = trimSlash(settings.roots.movie), seen = new Set<number>();
  for (const m of data.movies) {
    const name = `${m.title ?? 'Untitled'}${m.year ? ` (${m.year})` : ''}`;
    if (typeof m.id !== 'number') continue;
    if (typeof m.tmdbId !== 'number' || m.tmdbId <= 0) { problems.push({ kind: 'no-tmdb', blocking: false, title: name, detail: 'No TMDB id in Radarr' }); continue; }
    if (seen.has(m.tmdbId)) { problems.push({ kind: 'duplicate', blocking: false, title: name, detail: `TMDB ${m.tmdbId} is in Radarr twice` }); continue; }
    const radarrPath = typeof m.path === 'string' ? slash(m.path) : '';
    const under = [root, ...sameAs.map(slash)].find(r => radarrPath.startsWith(`${r}/`));
    const folder = under ? radarrPath.slice(under.length + 1) : undefined;
    if (!folder || folder.includes('/')) { problems.push({ kind: 'outside-root', blocking: false, title: name, detail: radarrPath ? `${radarrPath} isn’t a folder in ${root}` : 'No path in Radarr' }); continue; }
    seen.add(m.tmdbId);
    // Recorded under tk.box's root, whatever name Radarr knew it by.
    const path = `${root}/${folder}`;
    // A folder tk.box would name differently means its clean-title rule doesn't match Radarr's, so new movies would be
    // named unlike the old ones. Listed, not blocking: the folder itself is kept as Radarr made it.
    const ours = movieFolder({ title: m.title ?? name, ...(m.year ? { year: m.year } : {}), tmdbId: m.tmdbId });
    if (ours !== folder) problems.push({ kind: 'folder-name', blocking: false, title: name, detail: `Radarr: ${folder} · tk.box: ${ours}` });
    const released: Released = { ...(day(m.inCinemas) ? { theatrical: day(m.inCinemas) } : {}), ...(day(m.digitalRelease) ? { digital: day(m.digitalRelease) } : {}),
      ...(day(m.physicalRelease) ? { physical: day(m.physicalRelease) } : {}) };
    const aliases = [...new Set([m.originalTitle, ...(m.alternateTitles ?? []).map(a => a.title)].filter((t): t is string => !!t && t !== m.title))].slice(0, 50);
    const planned: PlannedMovie = { radarrId: m.id, tmdbId: m.tmdbId, ...(m.imdbId ? { imdbId: m.imdbId } : {}), title: m.title ?? name, ...(m.year ? { year: m.year } : {}),
      aliases, monitored: m.monitored !== false, keep: (m.tags ?? []).some(t => keepIds.has(t)), folder, released };
    const f = m.hasFile ? m.movieFile : undefined;
    if (f) {
      const given = f.path ? slash(f.path) : f.relativePath ? posix.join(radarrPath, slash(f.relativePath)) : undefined;
      const filePath = given?.startsWith(`${radarrPath}/`) ? `${path}/${given.slice(radarrPath.length + 1)}` : given;
      const quality = ladderQuality(f.quality?.quality?.name);
      if (!filePath || !filePath.startsWith(`${path}/`)) problems.push({ kind: 'outside-root', blocking: false, title: name, detail: `Its file ${filePath ?? '(no path)'} isn’t in its folder; imported without the file` });
      else if (!quality) problems.push({ kind: 'quality', blocking: false, title: name, detail: `Radarr's quality “${f.quality?.quality?.name ?? '?'}” isn’t on the ladder; imported without the file` });
      else {
        const mi = f.mediaInfo ?? {}, ch = channels(mi.audioChannels);
        planned.file = { path: filePath, size: typeof f.size === 'number' ? f.size : 0, quality, proper: (f.quality?.revision?.version ?? 1) > 1 || !!f.quality?.revision?.isRepack,
          ...(f.sceneName ? { releaseName: f.sceneName } : {}), ...(f.releaseGroup ? { releaseGroup: f.releaseGroup } : {}),
          media: { ...(mi.videoCodec ? { videoCodec: mi.videoCodec } : {}), ...(mi.videoDynamicRangeType ? { dynamicRange: mi.videoDynamicRangeType } : {}),
            ...(mi.audioCodec ? { audioCodec: mi.audioCodec } : {}), ...(ch ? { audioChannels: ch } : {}) } };
      }
    }
    titles.push(planned);
  }
  const summary = { movies: data.movies.length, importable: titles.length, monitored: titles.filter(t => t.monitored).length, files: titles.filter(t => t.file).length,
    keep: titles.filter(t => t.keep).length, problems: problems.length };
  return { titles, problems, summary, namingOk: !problems.some(p => p.blocking) };
}

type Deps = { library: LibraryStore; requests: Pick<RequestStore, 'moveArrIds'>; radarr: () => ArrService; keepTags: () => readonly string[];
  transport?: typeof fetch; now?: () => number; resolve?: (path: string) => Promise<string> };

export class MovieCutover {
  constructor(private deps: Deps) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  private get store() { return this.deps.library; }

  view(): CutoverView {
    const s = this.store.cutoverState('movie');
    return { fulfil: this.store.settings().fulfil.movie, imported: this.store.cutoverIds('movie').size, ...s };
  }

  private async plan() {
    const data = await readRadarr(this.deps.radarr(), this.deps.transport), settings = this.store.settings();
    return planMovies(data, settings, this.deps.keepTags(), await sameRoots(radarrRoots(data), settings.roots.movie, this.deps.resolve));
  }

  async dryRun(): Promise<CutoverPlan> {
    const plan = await this.plan();
    return { summary: plan.summary, problems: plan.problems.slice(0, 500), namingOk: plan.namingOk };
  }

  async import(actor: string): Promise<CutoverPlan> {
    requireWritable();
    requireThat(this.store.settings().fulfil.movie === 'radarr', 'CUTOVER_SWITCHED', 'Movies are on tk.box. Switch back to Radarr before importing again.', 409);
    const settings = this.store.settings(), plan = await this.plan();
    if (!plan.namingOk) throw new AppError('CUTOVER_NAMING', `Radarr's naming differs from tk.box's: ${plan.problems.filter(p => p.blocking).map(p => p.detail).join('; ')}.`, 409);
    const now = this.now();
    let added = 0, updated = 0;
    this.store.db.transaction(() => {
      for (const t of plan.titles) {
        let title = this.store.titleByTmdb('movie', t.tmdbId);
        if (!title) {
          title = this.store.insertTitle({ kind: 'movie', tmdbId: t.tmdbId, ...(t.imdbId ? { imdbId: t.imdbId } : {}), title: t.title, ...(t.year ? { year: t.year } : {}),
            aliases: t.aliases, monitor: t.monitored ? 'all' : 'none', profileId: settings.defaultProfile, root: settings.roots.movie, keep: t.keep, released: t.released, addedBy: 'cutover' });
          added++;
        } else {
          if (t.keep && !title.keep) this.store.setKeep(title.id, true);
          if (title.addedBy === 'cutover') this.store.setMonitor(title.id, t.monitored ? 'all' : 'none');
          updated++;
        }
        this.store.setFolder(title.id, t.folder);
        if (t.file) this.store.insertFile({ titleId: title.id, path: t.file.path, size: t.file.size, quality: t.file.quality, proper: t.file.proper, score: 0,
          ...(t.file.releaseName ? { releaseName: t.file.releaseName } : {}), ...(t.file.releaseGroup ? { releaseGroup: t.file.releaseGroup } : {}), media: t.file.media });
        // Searched at the first sweep once movies are switched (the library doesn't search before then).
        if (!this.store.search(title.id, 'movie')) this.store.setSearch({ titleId: title.id, scope: 'movie', lastAt: 0, misses: 0, nextAt: now });
        this.store.setCutoverId('movie', t.radarrId, title.id);
      }
      const summary = { ...plan.summary, added, updated };
      this.store.setCutoverState('movie', { importedAt: now, summary });
      this.store.audit('library_cutover_imported', { kind: 'movie', by: actor, ...summary });
    })();
    return { summary: { ...plan.summary, added, updated }, problems: plan.problems.slice(0, 500), namingOk: true };
  }

  switch(actor: string) {
    requireWritable();
    requireThat(this.store.settings().fulfil.movie === 'radarr', 'CUTOVER_SWITCHED', 'Movies are already on tk.box.', 409);
    requireThat(this.store.cutoverState('movie').importedAt, 'CUTOVER_NOT_IMPORTED', 'Import from Radarr first.', 409);
    const now = this.now();
    const moved = this.store.db.transaction(() => {
      const result = this.deps.requests.moveArrIds('movie', this.store.cutoverIds('movie'), { toArr: false });
      this.store.setFulfil(actor, 'movie', 'tkbox');
      this.store.setCutoverState('movie', { switchedAt: now });
      return result;
    })();
    return { ...this.view(), requests: moved };
  }

  switchBack(actor: string) {
    requireWritable();
    requireThat(this.store.settings().fulfil.movie === 'tkbox', 'CUTOVER_NOT_SWITCHED', 'Movies are already on Radarr.', 409);
    const since = this.store.cutoverState('movie').switchedAt, now = this.now();
    const back = new Map([...this.store.cutoverIds('movie')].map(([arrId, titleId]) => [titleId, arrId]));
    const moved = this.store.db.transaction(() => {
      const result = this.deps.requests.moveArrIds('movie', back, { toArr: true, ...(since !== undefined ? { since } : {}) });
      this.store.setFulfil(actor, 'movie', 'radarr');
      this.store.setCutoverState('movie', { switchedBackAt: now });
      return result;
    })();
    return { ...this.view(), requests: moved };
  }
}
