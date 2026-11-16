import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { episodeFileName, seasonFolder, seriesFolder } from '../lib/naming.js';
import { AppError, requireThat, requireWritable } from '../errors.js';
import { isQuality, type Quality } from '../lib/quality.js';
import { remoteJson, remoteMessage } from '../providers/remote-json.js';
import { followEpisodes, type EpisodeFact } from './wanted.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { EpisodeRef, EpisodeRow, FileMedia, LibraryStore, Monitor, Released, SeasonRow } from '../persistence/library-store.js';
import type { RequestStore } from '../persistence/requests-store.js';
import type { CutoverPlan, CutoverProblem, CutoverRun, CutoverSummary, CutoverView } from '../../../../packages/contracts/src/downloads.js';

// The Sonarr import (docs/PHASE-2.md, step 6), modelled on the movie cutover (services/cutover.ts at 1f48f3c). Sonarr
// is only read: /series, /episode, /episodefile, its naming, tags and quality profiles. Nothing is written there.
//
// - Dry run: what an import would write, with counts and problems. Nothing is written.
// - Import: library_titles (TMDB's facts, the folder from Sonarr's path, Keep from Clean Up's protected tags, the
//   profile mapped onto a built-in), seasons and episodes (TMDB's, with Sonarr's monitored flags), and library_files
//   with their episodes (Sonarr's quality). Refused while Sonarr's naming differs, and once shows are on tk.box.
//   Running it again brings what Sonarr did since: Sonarr is still the shows' until the Switch.
// - Switch: requests' arr_id moves from Sonarr's series ids to library_titles ids, shows are fulfilled by tk.box, and
//   the imported shows' first searches are spread over a day.
// - Switch back: requests made before the switch get their Sonarr id back, those made since are sent to Sonarr again,
//   and shows go back to Sonarr. The library keeps its shows (not searched while Sonarr has them).
// Specials (season 0) stay out.

export type SonarrSeason = { seasonNumber?: number; monitored?: boolean };
export type SonarrSeries = { id?: number; title?: string; year?: number; tvdbId?: number; tmdbId?: number; imdbId?: string; path?: string; monitored?: boolean;
  monitorNewItems?: string; qualityProfileId?: number; tags?: number[]; seasons?: SonarrSeason[] };
export type SonarrEpisode = { seasonNumber?: number; episodeNumber?: number; title?: string; monitored?: boolean; episodeFileId?: number };
export type SonarrEpisodeFile = { id?: number; seasonNumber?: number; relativePath?: string; path?: string; size?: number; sceneName?: string; releaseGroup?: string;
  quality?: { quality?: { name?: string }; revision?: { version?: number; isRepack?: boolean } };
  mediaInfo?: { audioCodec?: string; audioChannels?: number; videoCodec?: string; videoDynamicRangeType?: string } };
export type SonarrShow = SonarrSeries & { episodes: SonarrEpisode[]; files: SonarrEpisodeFile[] };
export type SonarrNaming = { renameEpisodes?: boolean; standardEpisodeFormat?: string; seriesFolderFormat?: string; seasonFolderFormat?: string; multiEpisodeStyle?: number };
export type SonarrData = { series: SonarrShow[]; naming: SonarrNaming; tags: { id?: number; label?: string }[]; profiles: { id?: number; name?: string }[] };

// What TMDB says of a show (Library.tmdbShow), or why it couldn't say.
export type TmdbShowFacts = { tmdbId: number; facts: { title: string; year?: number; tvdbId?: number; imdbId?: string; aliases: string[]; released: Released; runtime?: number };
  seasons: number[]; episodes: EpisodeFact[] };
export type TmdbLookup = TmdbShowFacts | { error: string };

export type PlannedFile = { path: string; size: number; quality: Quality; proper: boolean; releaseName?: string; releaseGroup?: string; media: FileMedia; episodes: EpisodeRef[] };
export type PlannedShow = { sonarrId: number; tmdbId: number; tvdbId: number; imdbId?: string; title: string; year?: number; aliases: string[]; released: Released; runtime?: number;
  monitor: Monitor; keep: boolean; folder: string; profileId: number; seasons: SeasonRow[]; episodes: EpisodeRow[]; files: PlannedFile[];
  tmdb: { seasons: number[]; episodes: EpisodeFact[] } };

// Sonarr's profiles onto the built-ins (the user, 2026-11-15; 1080p Quality → Quality added 2026-11-16). Any other gets
// the default profile.
const PROFILE_MAP: Record<string, string> = { '1080p balanced': 'standard', '1080p quality': 'quality', '720p/1080p high efficiency': 'lite', any: 'any' };
// Sonarr's qualities that aren't rungs of the ladder by that name.
const QUALITY_ALIASES: Record<string, Quality> = { 'Bluray-1080p Remux': 'Remux-1080p', 'Bluray-2160p Remux': 'Remux-2160p', 'Raw-HD': 'HDTV-1080p', 'DVD-R': 'DVD' };
export function ladderQuality(name: string | undefined): Quality | undefined {
  if (!name) return undefined;
  return isQuality(name) ? name : QUALITY_ALIASES[name];
}
// Sonarr's multi-episode style 5: Prefixed Range (S01E01-E03), the one lib/naming.ts makes.
const PREFIXED_RANGE = 5;
const channels = (n: number | undefined) => n === undefined || !Number.isFinite(n) ? undefined : n.toFixed(1);
const trimSlash = (p: string) => p.replace(/[\\/]+$/, '');
const slash = (p: string) => trimSlash(p.replaceAll('\\', '/'));
const key = (season: number, episode: number) => `${season}:${episode}`;

// Reads what the dry run and import need from Sonarr, a few series at a time. Read only.
export async function readSonarr(service: ArrService, transport: typeof fetch = fetch): Promise<SonarrData> {
  requireThat(service.url && service.key, 'CUTOVER_SONARR_MISSING', 'Connect Sonarr in Admin › Connections first. It must be running for the import.', 409);
  const get = async (path: string) => {
    let response;
    try { response = await remoteJson(new URL(`${trimSlash(service.url)}/api/v3/${path}`), { headers: { 'X-Api-Key': service.key! } }, 'Sonarr', transport, 60000, 128 * 1024 * 1024); }
    catch (e) { throw new AppError('CUTOVER_SONARR_UNAVAILABLE', `Sonarr can't be reached: ${(e as Error).message}`, 502); }
    if (response.status === 401 || response.status === 403) throw new AppError('CUTOVER_SONARR_UNAVAILABLE', 'Sonarr refused the API key.', 502);
    if (response.status >= 400) throw new AppError('CUTOVER_SONARR_UNAVAILABLE', remoteMessage(response.data) ?? `Sonarr answered ${response.status}.`, 502);
    return response.data;
  };
  const [series, naming, tags, profiles] = await Promise.all([get('series'), get('config/naming'), get('tag'), get('qualityprofile')]);
  const unexpected = () => new AppError('CUTOVER_SONARR_UNAVAILABLE', 'Sonarr answered with something unexpected.', 502);
  if (!Array.isArray(series) || !naming || typeof naming !== 'object' || !Array.isArray(tags) || !Array.isArray(profiles)) throw unexpected();
  const shows = await mapLimit(series as SonarrSeries[], 4, async s => {
    if (typeof s.id !== 'number') return { ...s, episodes: [], files: [] };
    const [episodes, files] = await Promise.all([get(`episode?seriesId=${s.id}`), get(`episodefile?seriesId=${s.id}`)]);
    if (!Array.isArray(episodes) || !Array.isArray(files)) throw unexpected();
    return { ...s, episodes: episodes as SonarrEpisode[], files: files as SonarrEpisodeFile[] };
  });
  return { series: shows, naming: naming as SonarrNaming, tags: tags as SonarrData['tags'], profiles: profiles as SonarrData['profiles'] };
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

// The folders Sonarr keeps series in (each series' parent folder).
export function sonarrRoots(data: SonarrData) {
  return [...new Set(data.series.flatMap(s => typeof s.path === 'string' && s.path ? [posix.dirname(slash(s.path))] : []))];
}
// Sonarr's roots that are tk.box's show root under another name, by where each resolves on disk (on Whatbox,
// /home/<user> is a link to /mnt/<disk>/<user>). One that doesn't resolve here isn't the same folder.
export async function sameRoots(roots: readonly string[], root: string, resolve: (path: string) => Promise<string> = realpath) {
  const real = async (p: string) => slash(await resolve(p));
  const mine = await real(root).catch(() => slash(root)), same: string[] = [];
  for (const r of roots) if (r !== slash(root) && await real(r).then(p => p === mine, () => false)) same.push(r);
  return same;
}

type PlanSettings = { roots: { show: string }; naming: { seriesFolder: string; seasonFolder: string; episodeFile: string }; defaultProfile: number };
// The built-in profiles' ids by key, and every profile's name by id (for the summary).
type PlanProfiles = { builtIn: (key: string) => number | undefined; name: (id: number) => string };

// What an import would write, and what stops it or is left out. Pure. `tmdb` is each series' TMDB show by Sonarr id;
// `sameAs` are Sonarr's roots that are the show root under another name, whose series are recorded under the show root.
export function planShows(data: SonarrData, tmdb: ReadonlyMap<number, TmdbLookup>, settings: PlanSettings, keepTags: readonly string[], profiles: PlanProfiles,
  sameAs: readonly string[] = []) {
  const problems: CutoverProblem[] = [], shows: PlannedShow[] = [];
  const n = data.naming;
  if ((n.standardEpisodeFormat ?? '').trim() !== settings.naming.episodeFile.trim())
    problems.push({ kind: 'naming', blocking: true, detail: `Sonarr's episode format is “${n.standardEpisodeFormat ?? ''}”` });
  if ((n.seriesFolderFormat ?? '').trim() !== settings.naming.seriesFolder.trim())
    problems.push({ kind: 'naming', blocking: true, detail: `Sonarr's series folder format is “${n.seriesFolderFormat ?? ''}”` });
  if ((n.seasonFolderFormat ?? '').trim() !== settings.naming.seasonFolder.trim())
    problems.push({ kind: 'naming', blocking: true, detail: `Sonarr's season folder format is “${n.seasonFolderFormat ?? ''}”` });
  if (n.multiEpisodeStyle !== undefined && n.multiEpisodeStyle !== PREFIXED_RANGE)
    problems.push({ kind: 'naming', blocking: false, detail: 'Sonarr names multi-episode files in another style; tk.box uses Prefixed Range (S01E01-E02)' });
  if (n.renameEpisodes === false) problems.push({ kind: 'naming', blocking: false, detail: 'Sonarr doesn’t rename episodes, so older files may not follow the format' });

  const keepLabels = new Set(keepTags.map(t => t.toLowerCase()));
  const keepIds = new Set(data.tags.flatMap(t => typeof t.id === 'number' && typeof t.label === 'string' && keepLabels.has(t.label.toLowerCase()) ? [t.id] : []));
  const sonarrProfile = new Map(data.profiles.flatMap(p => typeof p.id === 'number' ? [[p.id, p.name ?? `#${p.id}`] as const] : []));
  const root = slash(settings.roots.show), seen = new Set<number>();
  let specials = 0;
  for (const s of data.series) {
    // Sonarr's title, with the year unless the title already ends with it ("Invasion (2021)").
    const title = s.title ?? 'Untitled', name = s.year && !title.endsWith(`(${s.year})`) ? `${title} (${s.year})` : title;
    if (typeof s.id !== 'number') continue;
    specials += s.files.filter(f => f.seasonNumber === 0).length;
    if (typeof s.tvdbId !== 'number' || s.tvdbId <= 0) { problems.push({ kind: 'no-tmdb', blocking: false, title: name, detail: 'No TVDB id in Sonarr' }); continue; }
    const found = tmdb.get(s.id);
    if (!found || 'error' in found) { problems.push({ kind: 'no-tmdb', blocking: false, title: name, detail: found?.error ?? 'Not found on TMDB' }); continue; }
    if (seen.has(found.tmdbId)) { problems.push({ kind: 'duplicate', blocking: false, title: name, detail: `TMDB ${found.tmdbId} is in Sonarr twice` }); continue; }
    const sonarrPath = typeof s.path === 'string' ? slash(s.path) : '';
    const under = [root, ...sameAs.map(slash)].find(r => sonarrPath.startsWith(`${r}/`));
    const folder = under ? sonarrPath.slice(under.length + 1) : undefined;
    if (!folder || folder.includes('/')) { problems.push({ kind: 'outside-root', blocking: false, title: name, detail: sonarrPath ? `${sonarrPath} isn’t a folder in ${root}` : 'No path in Sonarr' }); continue; }
    seen.add(found.tmdbId);
    const path = `${root}/${folder}`, facts = found.facts;
    // tk.box names new episodes from TMDB's title and year: a folder it would name differently means its new files
    // won't share the old ones' names. Listed, not blocking: the folder is kept as Sonarr made it.
    const ours = seriesFolder({ title: facts.title, ...(facts.year ? { year: facts.year } : {}), tvdbId: s.tvdbId });
    if (ours !== folder) problems.push({ kind: 'folder-name', blocking: false, title: name, detail: `Sonarr: ${folder} · tk.box: ${ours}` });

    // The profile: Sonarr's onto a built-in.
    const sonarrName = typeof s.qualityProfileId === 'number' ? sonarrProfile.get(s.qualityProfileId) : undefined;
    const builtIn = sonarrName ? PROFILE_MAP[sonarrName.toLowerCase()] : undefined;
    const mapped = builtIn ? profiles.builtIn(builtIn) : undefined;
    if (mapped === undefined) problems.push({ kind: 'profile', blocking: false, title: name, detail: `Sonarr's profile “${sonarrName ?? '?'}” has no match; it gets ${profiles.name(settings.defaultProfile)}` });
    const profileId = mapped ?? settings.defaultProfile;

    // Monitoring: Sonarr's mode, and its season and episode flags for what TMDB lists; followEpisodes decides the rest.
    const monitor: Monitor = s.monitored === false ? 'none' : s.monitorNewItems === 'all' ? 'all' : 'manual';
    const tmdbEpisodes = new Set(found.episodes.map(e => key(e.season, e.episode)));
    const storedSeasons = (s.seasons ?? []).flatMap(x => typeof x.seasonNumber === 'number' && x.seasonNumber > 0 && found.seasons.includes(x.seasonNumber)
      ? [{ season: x.seasonNumber, monitored: x.monitored !== false }] : []);
    const storedEpisodes = s.episodes.flatMap(e => typeof e.seasonNumber === 'number' && e.seasonNumber > 0 && typeof e.episodeNumber === 'number'
      && tmdbEpisodes.has(key(e.seasonNumber, e.episodeNumber)) ? [{ season: e.seasonNumber, episode: e.episodeNumber, monitored: e.monitored !== false }] : []);
    const followed = followEpisodes({ monitor }, found, { seasons: storedSeasons, episodes: storedEpisodes });

    // Files: each with the episodes Sonarr gives it that TMDB lists too.
    const byFile = new Map<number, SonarrEpisode[]>();
    for (const e of s.episodes) if (typeof e.episodeFileId === 'number' && e.episodeFileId > 0) byFile.set(e.episodeFileId, [...byFile.get(e.episodeFileId) ?? [], e]);
    const names = new Map(found.episodes.map(e => [key(e.season, e.episode), e.name]));
    const files: PlannedFile[] = [], unknown: string[] = [], renamed: string[] = [], outside: string[] = [], qualities = new Set<string>();
    for (const f of s.files) {
      if (typeof f.id !== 'number' || f.seasonNumber === 0) continue;
      const covered = (byFile.get(f.id) ?? []).filter(e => typeof e.seasonNumber === 'number' && e.seasonNumber > 0 && typeof e.episodeNumber === 'number')
        .sort((a, b) => a.seasonNumber! - b.seasonNumber! || a.episodeNumber! - b.episodeNumber!);
      if (!covered.length) continue;
      const known = covered.filter(e => tmdbEpisodes.has(key(e.seasonNumber!, e.episodeNumber!)));
      for (const e of covered) if (!known.includes(e)) unknown.push(`S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`);
      const given = f.path ? slash(f.path) : f.relativePath ? posix.join(sonarrPath, slash(f.relativePath)) : undefined;
      const rest = given?.startsWith(`${sonarrPath}/`) ? given.slice(sonarrPath.length + 1) : undefined;
      if (!rest) { outside.push(given ?? '(no path)'); continue; }
      const quality = ladderQuality(f.quality?.quality?.name);
      if (!quality) { qualities.add(f.quality?.quality?.name ?? '?'); continue; }
      if (!known.length) continue;
      const refs = known.map(e => [e.seasonNumber!, e.episodeNumber!] as EpisodeRef);
      // The name tk.box would give it, before the media tokens (the tail is shared with movies and checked there). Both
      // carry the extension, so `head` drops only that and not a title's last dot (Mrs. Diaz, I.F.T).
      const ext = rest.match(/\.[^./]+$/)?.[0] ?? '.mkv';
      const mine = `${seasonFolder(refs[0]![0])}/${episodeFileName({ title: facts.title, ...(facts.year ? { year: facts.year } : {}) },
        refs.map(([season, episode]) => ({ season, episode, ...(names.get(key(season, episode)) ? { title: names.get(key(season, episode))! } : {}) })), { quality: 'Unknown' }, ext)}${ext}`;
      const head = (p: string) => p.replace(/\.[^./]+$/, '').replace(/ ?\[Unknown\]$/, '').split(' [')[0]!.trim();
      if (head(rest) !== head(mine)) renamed.push(`${head(rest)} · tk.box: ${head(mine)}`);
      const mi = f.mediaInfo ?? {}, ch = channels(mi.audioChannels);
      files.push({ path: `${path}/${rest}`, size: typeof f.size === 'number' ? f.size : 0, quality, proper: (f.quality?.revision?.version ?? 1) > 1 || !!f.quality?.revision?.isRepack,
        ...(f.sceneName ? { releaseName: f.sceneName } : {}), ...(f.releaseGroup ? { releaseGroup: f.releaseGroup } : {}),
        media: { ...(mi.videoCodec ? { videoCodec: mi.videoCodec } : {}), ...(mi.videoDynamicRangeType ? { dynamicRange: mi.videoDynamicRangeType } : {}),
          ...(mi.audioCodec ? { audioCodec: mi.audioCodec } : {}), ...(ch ? { audioChannels: ch } : {}) }, episodes: refs });
    }
    const few = (list: string[]) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
    if (unknown.length) problems.push({ kind: 'episode', blocking: false, title: name, detail: `TMDB doesn’t list ${few(unknown)}; files with only those are left out` });
    if (outside.length) problems.push({ kind: 'outside-root', blocking: false, title: name, detail: `${outside.length} file${outside.length > 1 ? 's' : ''} outside its folder, left out: ${few(outside)}` });
    if (qualities.size) problems.push({ kind: 'quality', blocking: false, title: name, detail: `Sonarr's quality ${[...qualities].map(q => `“${q}”`).join(', ')} isn’t on the ladder; those files are left out` });
    if (renamed.length) problems.push({ kind: 'file-name', blocking: false, title: name, detail: `${renamed.length} of ${files.length} files named differently, e.g. ${renamed[0]}` });

    shows.push({ sonarrId: s.id, tmdbId: found.tmdbId, tvdbId: s.tvdbId, ...(facts.imdbId ? { imdbId: facts.imdbId } : {}), title: facts.title, ...(facts.year ? { year: facts.year } : {}),
      aliases: facts.aliases, released: facts.released, ...(facts.runtime ? { runtime: facts.runtime } : {}), monitor, keep: (s.tags ?? []).some(t => keepIds.has(t)), folder, profileId,
      seasons: followed.seasons, episodes: followed.episodes, files, tmdb: { seasons: found.seasons, episodes: found.episodes } });
  }
  const byProfile: Record<string, number> = {};
  for (const show of shows) { const p = profiles.name(show.profileId); byProfile[p] = (byProfile[p] ?? 0) + 1; }
  const summary: CutoverSummary = { series: data.series.length, importable: shows.length, monitored: shows.filter(t => t.monitor !== 'none').length,
    episodes: shows.reduce((n, t) => n + t.episodes.length, 0), files: shows.reduce((n, t) => n + t.files.length, 0), keep: shows.filter(t => t.keep).length,
    specials, problems: problems.length, profiles: byProfile, sameRoots: [...sameAs] };
  return { shows, problems, summary, namingOk: !problems.some(p => p.blocking) };
}

// The library's side of the import (Library), so this file needs no Library to test.
export type CutoverLibrary = {
  tmdbShow(tmdbId: number): Promise<Omit<TmdbShowFacts, 'tmdbId'>>;
  tmdbByTvdb(tvdbId: number): Promise<number | undefined>;
  spreadSearches(titleIds: readonly number[], from: number, over: number): number;
};
type Deps = { store: LibraryStore; library: CutoverLibrary; requests: Pick<RequestStore, 'moveArrIds'>; sonarr: () => ArrService; keepTags: () => readonly string[];
  transport?: typeof fetch; now?: () => number; resolve?: (path: string) => Promise<string> };

const DAY = 24 * 3600 * 1000;

export class ShowCutover {
  // The last dry run or import, kept in memory for the page to poll; one runs at a time.
  private last?: CutoverRun;
  constructor(private deps: Deps) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  private get store() { return this.deps.store; }

  view(): CutoverView {
    return { fulfil: this.store.settings().fulfil.show, imported: this.store.cutoverIds().size, ...this.store.cutoverState(), ...(this.last ? { run: this.last } : {}) };
  }

  // Starts a dry run or an import in the background and answers at once. The import's guards are checked first, so
  // a refusal answers the request. `done` resolves when it has finished (tests wait on it).
  start(kind: CutoverRun['kind'], actor: string) {
    requireThat(!this.last || this.last.finishedAt !== undefined, 'CUTOVER_RUNNING', 'A dry run or import is already running.', 409);
    if (kind === 'import') this.guardImport();
    const run: CutoverRun = { kind, startedAt: this.now() };
    this.last = run;
    const done = (kind === 'import' ? this.import(actor) : this.dryRun()).then(plan => { run.plan = plan; }, e => { run.error = (e as Error).message; })
      .finally(() => { run.finishedAt = this.now(); });
    return { view: this.view(), done };
  }
  private guardImport() {
    requireWritable();
    requireThat(this.store.settings().fulfil.show === 'sonarr', 'CUTOVER_SWITCHED', 'Shows are on tk.box. Switch back to Sonarr before importing again.', 409);
  }

  // Each series' TMDB show: by Sonarr's TMDB id, else found by its TVDB id.
  private async tmdb(data: SonarrData) {
    const found = new Map<number, TmdbLookup>();
    await mapLimit(data.series, 4, async s => {
      if (typeof s.id !== 'number' || typeof s.tvdbId !== 'number') return;
      try {
        const tmdbId = typeof s.tmdbId === 'number' && s.tmdbId > 0 ? s.tmdbId : await this.deps.library.tmdbByTvdb(s.tvdbId);
        if (tmdbId === undefined) { found.set(s.id, { error: `TMDB has no show for TVDB ${s.tvdbId}` }); return; }
        found.set(s.id, { tmdbId, ...await this.deps.library.tmdbShow(tmdbId) });
      } catch (e) { found.set(s.id, { error: `TMDB: ${(e as Error).message}` }); }
    });
    return found;
  }

  private async plan() {
    const data = await readSonarr(this.deps.sonarr(), this.deps.transport), settings = this.store.settings();
    const names = new Map(this.store.profiles().map(p => [p.id, p.name]));
    const profiles: PlanProfiles = { builtIn: k => this.store.builtInProfile(k), name: id => names.get(id) ?? `#${id}` };
    return planShows(data, await this.tmdb(data), settings, this.deps.keepTags(), profiles, await sameRoots(sonarrRoots(data), settings.roots.show, this.deps.resolve));
  }

  async dryRun(): Promise<CutoverPlan> {
    const plan = await this.plan();
    return { summary: plan.summary, problems: plan.problems.slice(0, 500), namingOk: plan.namingOk };
  }

  async import(actor: string): Promise<CutoverPlan> {
    this.guardImport();
    const plan = await this.plan(), settings = this.store.settings();
    // Checked again: a Switch could have happened while Sonarr was being read.
    this.guardImport();
    if (!plan.namingOk) throw new AppError('CUTOVER_NAMING', `Sonarr's naming differs from tk.box's: ${plan.problems.filter(p => p.blocking).map(p => p.detail).join('; ')}.`, 409);
    let added = 0, updated = 0;
    this.store.db.transaction(() => {
      for (const t of plan.shows) {
        let title = this.store.titleByTmdb('show', t.tmdbId);
        const facts = { tvdbId: t.tvdbId, ...(t.imdbId ? { imdbId: t.imdbId } : {}), title: t.title, ...(t.year ? { year: t.year } : {}), aliases: t.aliases, released: t.released,
          ...(t.runtime ? { runtime: t.runtime } : {}) };
        if (!title) {
          title = this.store.insertTitle({ kind: 'show', tmdbId: t.tmdbId, ...facts, monitor: t.monitor, profileId: t.profileId, root: settings.roots.show, keep: t.keep, addedBy: 'cutover' });
          added++;
        } else updated++;
        const ours = title.addedBy === 'cutover';
        if (t.keep && !title.keep) this.store.setKeep(title.id, true);
        this.store.refreshed(title.id, facts);
        this.store.setFolder(title.id, t.folder);
        if (ours) {
          // Sonarr is still the show's: its mode, profile and flags win, and file records it no longer has go (from
          // the database only; Sonarr looks after the disk until the Switch).
          this.store.setFollow(title.id, t.monitor, null);
          this.store.setProfile(title.id, t.profileId);
          this.store.saveEpisodes(title.id, t.seasons, t.episodes);
          const paths = new Set(t.files.map(f => f.path));
          for (const f of this.store.files(title.id)) if (!paths.has(f.path)) this.store.deleteFile(f.id);
        } else {
          // A show tk.box had already (a request since a Switch back): its own flags stay.
          const follow = { monitor: title.monitor, ...(title.monitorFrom !== undefined ? { monitorFrom: title.monitorFrom } : {}) };
          const next = followEpisodes(follow, t.tmdb, { seasons: this.store.seasons(title.id), episodes: this.store.episodes(title.id) });
          this.store.saveEpisodes(title.id, next.seasons, next.episodes);
        }
        // Each file with its episodes in this transaction, or cleanLeftovers would take it for an upgrade's leftover.
        for (const f of t.files) {
          const id = this.store.insertFile({ titleId: title.id, path: f.path, size: f.size, quality: f.quality, proper: f.proper, score: 0,
            ...(f.releaseName ? { releaseName: f.releaseName } : {}), ...(f.releaseGroup ? { releaseGroup: f.releaseGroup } : {}), media: f.media });
          this.store.mapEpisodes(id, title.id, f.episodes);
        }
        // A file whose episodes all moved to another (an upgrade Sonarr made) has no episodes left: its record goes.
        for (const f of this.store.unmappedShowFiles(title.id)) this.store.deleteFile(f.id);
        this.store.setCutoverId(t.sonarrId, title.id);
      }
      const { profiles: _, sameRoots: __, ...counts } = plan.summary;
      this.store.setCutoverState({ importedAt: this.now(), summary: { ...counts, added, updated } });
      this.store.audit('library_cutover_imported', { kind: 'show', by: actor, ...counts, added, updated });
    })();
    return { summary: { ...plan.summary, added, updated }, problems: plan.problems.slice(0, 500), namingOk: true };
  }

  switch(actor: string): CutoverView {
    requireWritable();
    requireThat(!this.last || this.last.finishedAt !== undefined, 'CUTOVER_RUNNING', 'Wait for the dry run or import to finish.', 409);
    requireThat(this.store.settings().fulfil.show === 'sonarr', 'CUTOVER_SWITCHED', 'Shows are already on tk.box.', 409);
    requireThat(this.store.cutoverState().importedAt, 'CUTOVER_NOT_IMPORTED', 'Import from Sonarr first.', 409);
    const now = this.now(), ids = this.store.cutoverIds();
    const { moved, searches } = this.store.db.transaction(() => {
      const result = this.deps.requests.moveArrIds('show', ids, { toArr: false });
      this.store.setFulfil(actor, 'tkbox');
      this.store.setCutoverState({ switchedAt: now });
      return { moved: result, searches: this.deps.library.spreadSearches([...new Set(ids.values())], now, DAY) };
    })();
    return { ...this.view(), requests: moved, searches };
  }

  switchBack(actor: string): CutoverView {
    requireWritable();
    requireThat(this.store.settings().fulfil.show === 'tkbox', 'CUTOVER_NOT_SWITCHED', 'Shows are already on Sonarr.', 409);
    const since = this.store.cutoverState().switchedAt, now = this.now();
    const back = new Map([...this.store.cutoverIds()].map(([sonarrId, titleId]) => [titleId, sonarrId]));
    const moved = this.store.db.transaction(() => {
      const result = this.deps.requests.moveArrIds('show', back, { toArr: true, ...(since !== undefined ? { since } : {}) });
      this.store.setFulfil(actor, 'sonarr');
      this.store.setCutoverState({ switchedBackAt: now });
      return result;
    })();
    return { ...this.view(), requests: moved };
  }
}
