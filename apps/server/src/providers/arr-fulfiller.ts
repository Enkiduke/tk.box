import { AppError } from '../errors.js';
import { releaseDay } from '../lib/release-day.js';
import { remoteJson, remoteMessage } from './remote-json.js';
import type { ArrService } from './arr-tags.js';
import type { RequestRelease } from '../../../../packages/contracts/src/index.js';

// How a request reaches a downloader: tk.box's library for movies (LibraryFulfiller), Sonarr for shows (ArrFulfiller)
// until phase 2.
export type FulfilKind = 'movie' | 'show';
export type FulfilTarget = { kind: FulfilKind; tmdbId: number; tvdbId?: number; title: string; seasons: number[]; monitorFuture: boolean;
  profileId?: number; rootFolder?: string; tags: number[]; search: boolean; seasonFolders?: boolean;
  // The requester's account id (tk.box's library records who added a title; Sonarr ignores it).
  requestedBy?: string };
// What is downloading: the library's movie ids, and Sonarr's series with their seasons (`undefined` when a record names none).
export type QueueState = { movies: Set<number>; series: Map<number, Set<number | undefined>> };
// `tkbox`: tk.box's own library answers for the kind (its pick profiles; no folders or tags).
export type ArrOptions = { connected: boolean; tkbox?: boolean; profiles: { id: number; name: string }[]; rootFolders: { path: string; freeSpace?: number }[]; tags: { id: number; label: string }[] };
export type FulfilProgress = { at?: number; release?: RequestRelease };
export interface Fulfiller {
  // Adds the title, or monitors and searches it when it's already there. Returns its id there.
  add(target: FulfilTarget): Promise<number>;
  queue(): Promise<QueueState>;
  // Its id there, if it has the title (for requests imported from Seerr, which tk.box never sent).
  find(kind: FulfilKind, tmdbId: number, tvdbId?: number): Promise<number | undefined>;
  // false once the title has been deleted there.
  exists(kind: FulfilKind, arrId: number): Promise<boolean>;
  progress(kind: FulfilKind, arrId: number, seasons: number[], now: number): Promise<FulfilProgress>;
  // Stops watching the movie, or these seasons of the show.
  unmonitor(kind: FulfilKind, arrId: number, seasons: number[]): Promise<void>;
  options(kind: FulfilKind): Promise<ArrOptions>;
  // A tag's id by label, made there when it doesn't exist yet (a request's Keep).
  tagId?(kind: FulfilKind, label: string): Promise<number>;
}

// `permanent`: trying again won't help (it was refused). Otherwise the sweep retries later.
export class FulfilError extends AppError {
  constructor(message: string, readonly permanent: boolean) { super('REQUEST_SEND_FAILED', message, 502); }
}

type Json = Record<string, unknown>;

function timestamp(value: unknown) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

// Sonarr, for shows until phase 2. Movies are tk.box's library's (LibraryFulfiller); a movie here is refused.
export class ArrFulfiller implements Fulfiller {
  constructor(private connection: () => ArrService, private transport: typeof fetch = fetch) {}
  private shows(kind: FulfilKind) { if (kind !== 'show') throw new FulfilError('Movies are tk.box’s own; Sonarr takes shows only.', true); }
  private async call(kind: FulfilKind, path: string, init: { method?: string; body?: unknown } = {}, allow404 = false) {
    this.shows(kind);
    const name = 'Sonarr', { url, key } = this.connection();
    if (!url || !key) throw new FulfilError(`${name} isn't connected. Add it in Admin › Connections.`, false);
    let response;
    try { response = await remoteJson(new URL(`${url}/api/v3/${path}`), { ...init, headers: { 'X-Api-Key': key } }, name, this.transport, 20000, 64 * 1024 * 1024); }
    catch (e) { throw new FulfilError((e as Error).message, false); }
    if (allow404 && response.status === 404) return undefined;
    if (response.status === 401 || response.status === 403) throw new FulfilError(`${name} refused the API key.`, false);
    if (response.status >= 500 || response.status === 429) throw new FulfilError(remoteMessage(response.data) ?? `${name} answered ${response.status}.`, false);
    if (response.status >= 400) throw new FulfilError(arrMessage(response.data) ?? `${name} answered ${response.status}.`, true);
    return response.data;
  }
  private async first<T>(kind: FulfilKind, path: string) { const list = await this.call(kind, path); return Array.isArray(list) ? list[0] as T | undefined : undefined; }
  private async destination(kind: FulfilKind, target: FulfilTarget) {
    const [profiles, folders] = await Promise.all([this.call(kind, 'qualityprofile'), this.call(kind, 'rootfolder')]) as [Json[] | undefined, Json[] | undefined];
    const profileId = target.profileId || (profiles?.[0]?.id as number | undefined), rootFolderPath = target.rootFolder || (folders?.[0]?.path as string | undefined);
    if (!profileId || !rootFolderPath) throw new FulfilError(`Sonarr has no quality profile or root folder to add to.`, true);
    return { qualityProfileId: profileId, rootFolderPath };
  }
  async add(target: FulfilTarget) {
    this.shows(target.kind);
    return this.addSeries(target);
  }
  private async addSeries(target: FulfilTarget) {
    if (!target.tvdbId) throw new FulfilError('TMDB has no TVDB id for this show, which Sonarr needs.', true);
    const wanted = new Set(target.seasons);
    const existing = await this.first<Json>('show', `series?tvdbId=${target.tvdbId}`);
    if (existing && typeof existing.id === 'number') {
      const seasons = (existing.seasons as { seasonNumber: number; monitored: boolean }[] | undefined) ?? [];
      const next = { ...existing, monitored: true, seasons: seasons.map(s => wanted.has(s.seasonNumber) ? { ...s, monitored: true } : s),
        ...(target.monitorFuture ? { monitorNewItems: 'all' } : {}) };
      await this.call('show', `series/${existing.id}`, { method: 'PUT', body: next });
      if (target.search) for (const seasonNumber of target.seasons) await this.call('show', 'command', { method: 'POST', body: { name: 'SeasonSearch', seriesId: existing.id, seasonNumber } });
      return existing.id;
    }
    const lookup = await this.first<Json>('show', `series/lookup?term=tvdb:${target.tvdbId}`);
    if (!lookup || typeof lookup.tvdbId !== 'number') throw new FulfilError(`Sonarr can't find TVDB ${target.tvdbId}.`, true);
    // Sonarr v3 needs a language profile; v4 has none and ignores the field.
    const language = await this.call('show', 'languageprofile', {}, true).catch(() => undefined) as Json[] | undefined;
    const seasons = ((lookup.seasons as { seasonNumber: number }[] | undefined) ?? []).map(s => ({ ...s, monitored: s.seasonNumber > 0 && wanted.has(s.seasonNumber) }));
    const added = await this.call('show', 'series', { method: 'POST', body: { ...lookup, ...await this.destination('show', target), seasonFolder: target.seasonFolders ?? true,
      monitored: true, seasons, monitorNewItems: target.monitorFuture ? 'all' : 'none', tags: target.tags,
      ...(Array.isArray(language) && typeof language[0]?.id === 'number' ? { languageProfileId: language[0].id } : {}),
      addOptions: { searchForMissingEpisodes: target.search } } }) as Json | undefined;
    if (typeof added?.id !== 'number') throw new FulfilError('Sonarr did not return the series it added.', false);
    return added.id;
  }
  async queue(): Promise<QueueState> {
    const state: QueueState = { movies: new Set(), series: new Map() }, { url, key } = this.connection();
    if (!url || !key) return state;
    const data = await this.call('show', 'queue?pageSize=1000&includeUnknownSeriesItems=false') as { records?: Json[] } | undefined;
    for (const r of data?.records ?? []) if (typeof r.seriesId === 'number') {
      const seasons = state.series.get(r.seriesId) ?? new Set();
      seasons.add(typeof r.seasonNumber === 'number' ? r.seasonNumber : typeof (r.episode as Json | undefined)?.seasonNumber === 'number' ? (r.episode as Json).seasonNumber as number : undefined);
      state.series.set(r.seriesId, seasons);
    }
    return state;
  }
  async find(kind: FulfilKind, _tmdbId: number, tvdbId?: number) {
    this.shows(kind);
    if (!tvdbId) return undefined;
    const found = await this.first<Json>(kind, `series?tvdbId=${tvdbId}`);
    return typeof found?.id === 'number' ? found.id : undefined;
  }
  async exists(kind: FulfilKind, arrId: number) {
    return (await this.call(kind, `series/${arrId}`, {}, true)) !== undefined;
  }
  async progress(kind: FulfilKind, arrId: number, seasons: number[], now: number): Promise<FulfilProgress> {
    this.shows(kind);
    if (!seasons.length) return {};
    const episodes = await this.call(kind, `episode?seriesId=${arrId}`) as Json[];
    const today = new Date(now).toISOString().slice(0, 10);
    type Airing = Extract<RequestRelease, { kind: 'episode' }>;
    let latestSearch: number | undefined;
    let latestAired: Airing | undefined, nextToAir: Airing | undefined;
    for (const episode of episodes) {
      if (episode.hasFile !== false || typeof episode.seasonNumber !== 'number' || !seasons.includes(episode.seasonNumber)) continue;
      const at = timestamp(episode.lastSearchTime);
      if (at !== undefined && (latestSearch === undefined || at > latestSearch)) latestSearch = at;
      const utcDay = releaseDay(episode.airDateUtc);
      const day = releaseDay(episode.airDate) ?? utcDay;
      if (!day || typeof episode.episodeNumber !== 'number') continue;
      const airTime = utcDay ? timestamp(episode.airDateUtc) : undefined;
      const aired = airTime === undefined ? day < today : airTime <= now;
      const airing: Airing = { kind: 'episode', day, aired, season: episode.seasonNumber, episode: episode.episodeNumber };
      if (aired && (!latestAired || day > latestAired.day)) latestAired = airing;
      if (!aired && (!nextToAir || day < nextToAir.day)) nextToAir = airing;
    }
    return { at: latestSearch, release: latestAired ?? nextToAir };
  }
  async unmonitor(kind: FulfilKind, arrId: number, seasons: number[]) {
    const path = `series/${arrId}`, item = await this.call(kind, path, {}, true) as Json | undefined;
    if (!item) return;
    const off = new Set(seasons), list = (item.seasons as { seasonNumber: number; monitored: boolean }[] | undefined) ?? [];
    if (!list.some(s => off.has(s.seasonNumber) && s.monitored)) return;
    await this.call(kind, path, { method: 'PUT', body: { ...item, seasons: list.map(s => off.has(s.seasonNumber) ? { ...s, monitored: false } : s) } });
  }
  async tagId(kind: FulfilKind, label: string) {
    const tags = await this.call(kind, 'tag') as Json[] | undefined;
    const found = (tags ?? []).find(t => typeof t.label === 'string' && t.label.toLowerCase() === label.toLowerCase())?.id;
    if (typeof found === 'number') return found;
    const made = await this.call(kind, 'tag', { method: 'POST', body: { label } }) as Json | undefined;
    if (typeof made?.id !== 'number') throw new AppError('CATALOG_UNAVAILABLE', `Sonarr didn't make the tag “${label}”.`, 502);
    return made.id;
  }
  async options(kind: FulfilKind): Promise<ArrOptions> {
    this.shows(kind);
    const { url, key } = this.connection();
    if (!url || !key) return { connected: false, profiles: [], rootFolders: [], tags: [] };
    const [profiles, folders, tags] = await Promise.all(['qualityprofile', 'rootfolder', 'tag'].map(p => this.call(kind, p))) as (Json[] | undefined)[];
    return { connected: true,
      profiles: (profiles ?? []).flatMap(p => typeof p.id === 'number' && typeof p.name === 'string' ? [{ id: p.id, name: p.name }] : []),
      rootFolders: (folders ?? []).flatMap(f => typeof f.path === 'string' ? [{ path: f.path, ...(typeof f.freeSpace === 'number' ? { freeSpace: f.freeSpace } : {}) }] : []),
      tags: (tags ?? []).flatMap(t => typeof t.id === 'number' && typeof t.label === 'string' ? [{ id: t.id, label: t.label }] : []) };
  }
}
// Sonarr answers a refused add with a list of validation failures.
function arrMessage(data: unknown) {
  if (Array.isArray(data)) { const first = data.find(e => e && typeof e === 'object' && typeof (e as Json).errorMessage === 'string') as Json | undefined; if (first) return String(first.errorMessage).slice(0, 300); }
  return remoteMessage(data);
}
