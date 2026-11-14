import { AppError } from '../errors.js';
import { remoteJson, remoteMessage } from './remote-json.js';
import type { ArrService } from './arr-tags.js';

// How a request reaches a downloader. Radarr and Sonarr today (ArrFulfiller); a later replacement implements the same.
export type FulfilKind = 'movie' | 'show';
export type FulfilTarget = { kind: FulfilKind; tmdbId: number; tvdbId?: number; title: string; seasons: number[]; monitorFuture: boolean;
  profileId?: number; rootFolder?: string; tags: number[]; search: boolean; seasonFolders?: boolean };
// What Radarr or Sonarr is downloading: movie ids, and for Sonarr each series' seasons (`undefined` when a record names none).
export type QueueState = { movies: Set<number>; series: Map<number, Set<number | undefined>> };
export type ArrOptions = { connected: boolean; profiles: { id: number; name: string }[]; rootFolders: { path: string; freeSpace?: number }[]; tags: { id: number; label: string }[] };
export interface Fulfiller {
  // Adds the title, or monitors and searches it when it's already there. Returns its id in Radarr or Sonarr.
  add(target: FulfilTarget): Promise<number>;
  queue(): Promise<QueueState>;
  // Its id there, if Radarr or Sonarr has the title (for requests imported from Seerr, which tk.box never sent).
  find(kind: FulfilKind, tmdbId: number, tvdbId?: number): Promise<number | undefined>;
  // false once the title has been deleted there.
  exists(kind: FulfilKind, arrId: number): Promise<boolean>;
  // Stops watching the movie, or these seasons of the show.
  unmonitor(kind: FulfilKind, arrId: number, seasons: number[]): Promise<void>;
  options(kind: FulfilKind): Promise<ArrOptions>;
}

// `permanent`: trying again won't help (Radarr or Sonarr refused it). Otherwise the sweep retries later.
export class FulfilError extends AppError {
  constructor(message: string, readonly permanent: boolean) { super('REQUEST_SEND_FAILED', message, 502); }
}

type Json = Record<string, unknown>;
const service = (kind: FulfilKind) => kind === 'movie' ? 'Radarr' : 'Sonarr';

export class ArrFulfiller implements Fulfiller {
  constructor(private connection: (name: 'radarr' | 'sonarr') => ArrService, private transport: typeof fetch = fetch) {}
  private async call(kind: FulfilKind, path: string, init: { method?: string; body?: unknown } = {}, allow404 = false) {
    const name = service(kind), { url, key } = this.connection(kind === 'movie' ? 'radarr' : 'sonarr');
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
    if (!profileId || !rootFolderPath) throw new FulfilError(`${service(kind)} has no quality profile or root folder to add to.`, true);
    return { qualityProfileId: profileId, rootFolderPath };
  }
  async add(target: FulfilTarget) {
    return target.kind === 'movie' ? this.addMovie(target) : this.addSeries(target);
  }
  private async addMovie(target: FulfilTarget) {
    const existing = await this.first<Json>('movie', `movie?tmdbId=${target.tmdbId}`);
    if (existing && typeof existing.id === 'number') {
      if (!existing.monitored) await this.call('movie', `movie/${existing.id}`, { method: 'PUT', body: { ...existing, monitored: true } });
      if (target.search && !existing.hasFile) await this.call('movie', 'command', { method: 'POST', body: { name: 'MoviesSearch', movieIds: [existing.id] } });
      return existing.id;
    }
    const lookup = await this.call('movie', `movie/lookup/tmdb?tmdbId=${target.tmdbId}`) as Json | undefined;
    if (!lookup || typeof lookup.tmdbId !== 'number') throw new FulfilError(`Radarr can't find TMDB ${target.tmdbId}.`, true);
    const added = await this.call('movie', 'movie', { method: 'POST', body: { ...lookup, ...await this.destination('movie', target), monitored: true, minimumAvailability: 'released',
      tags: target.tags, addOptions: { searchForMovie: target.search } } }) as Json | undefined;
    if (typeof added?.id !== 'number') throw new FulfilError('Radarr did not return the movie it added.', false);
    return added.id;
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
    const state: QueueState = { movies: new Set(), series: new Map() };
    const read = async (kind: FulfilKind) => {
      const name = kind === 'movie' ? 'radarr' : 'sonarr', { url, key } = this.connection(name);
      if (!url || !key) return [];
      const data = await this.call(kind, 'queue?pageSize=1000&includeUnknownMovieItems=false&includeUnknownSeriesItems=false') as { records?: Json[] } | undefined;
      return data?.records ?? [];
    };
    const [movies, series] = await Promise.all([read('movie'), read('show')]);
    for (const r of movies) if (typeof r.movieId === 'number') state.movies.add(r.movieId);
    for (const r of series) if (typeof r.seriesId === 'number') {
      const seasons = state.series.get(r.seriesId) ?? new Set();
      seasons.add(typeof r.seasonNumber === 'number' ? r.seasonNumber : typeof (r.episode as Json | undefined)?.seasonNumber === 'number' ? (r.episode as Json).seasonNumber as number : undefined);
      state.series.set(r.seriesId, seasons);
    }
    return state;
  }
  async find(kind: FulfilKind, tmdbId: number, tvdbId?: number) {
    if (kind === 'show' && !tvdbId) return undefined;
    const found = await this.first<Json>(kind, kind === 'movie' ? `movie?tmdbId=${tmdbId}` : `series?tvdbId=${tvdbId}`);
    return typeof found?.id === 'number' ? found.id : undefined;
  }
  async exists(kind: FulfilKind, arrId: number) {
    return (await this.call(kind, `${kind === 'movie' ? 'movie' : 'series'}/${arrId}`, {}, true)) !== undefined;
  }
  async unmonitor(kind: FulfilKind, arrId: number, seasons: number[]) {
    const path = `${kind === 'movie' ? 'movie' : 'series'}/${arrId}`, item = await this.call(kind, path, {}, true) as Json | undefined;
    if (!item) return;
    if (kind === 'movie') { if (item.monitored) await this.call(kind, path, { method: 'PUT', body: { ...item, monitored: false } }); return; }
    const off = new Set(seasons), list = (item.seasons as { seasonNumber: number; monitored: boolean }[] | undefined) ?? [];
    if (!list.some(s => off.has(s.seasonNumber) && s.monitored)) return;
    await this.call(kind, path, { method: 'PUT', body: { ...item, seasons: list.map(s => off.has(s.seasonNumber) ? { ...s, monitored: false } : s) } });
  }
  async options(kind: FulfilKind): Promise<ArrOptions> {
    const { url, key } = this.connection(kind === 'movie' ? 'radarr' : 'sonarr');
    if (!url || !key) return { connected: false, profiles: [], rootFolders: [], tags: [] };
    const [profiles, folders, tags] = await Promise.all(['qualityprofile', 'rootfolder', 'tag'].map(p => this.call(kind, p))) as (Json[] | undefined)[];
    return { connected: true,
      profiles: (profiles ?? []).flatMap(p => typeof p.id === 'number' && typeof p.name === 'string' ? [{ id: p.id, name: p.name }] : []),
      rootFolders: (folders ?? []).flatMap(f => typeof f.path === 'string' ? [{ path: f.path, ...(typeof f.freeSpace === 'number' ? { freeSpace: f.freeSpace } : {}) }] : []),
      tags: (tags ?? []).flatMap(t => typeof t.id === 'number' && typeof t.label === 'string' ? [{ id: t.id, label: t.label }] : []) };
  }
}
// Radarr and Sonarr answer a refused add with a list of validation failures.
function arrMessage(data: unknown) {
  if (Array.isArray(data)) { const first = data.find(e => e && typeof e === 'object' && typeof (e as Json).errorMessage === 'string') as Json | undefined; if (first) return String(first.errorMessage).slice(0, 300); }
  return remoteMessage(data);
}
