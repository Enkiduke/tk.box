import { AppError } from '../errors.js';
import { remoteJson } from './remote-json.js';

// TVmaze (api.tvmaze.com, free, no key; data CC BY-SA, credited in Admin › Connections): each episode's exact air
// time, which TMDB lacks (it gives the day only). A show is found by its TVDB id, else its IMDb id: the lookup answers
// with a redirect to the show, read here by hand as remoteJson refuses redirects. Each show's episodes are kept for
// 6 hours, and the last outcome is kept for Admin › Connections.
const BASE = 'https://api.tvmaze.com', TTL = 6 * 3600000;

export type TvmazeAiring = { season: number; episode: number; airDate?: string; airAt: number };
type TvmazeEpisode = { season?: unknown; number?: unknown; airdate?: unknown; airstamp?: unknown };
export type TvmazeState = { lastOkAt?: number; lastError?: string; lastErrorAt?: number };

export class Tvmaze {
  private cache = new Map<string, { at: number; airings: TvmazeAiring[] }>();
  readonly state: TvmazeState = {};
  constructor(private transport: typeof fetch = fetch, private now: () => number = Date.now) {}

  // The show's episodes with an air time, or [] when TVmaze doesn't know the show. Throws when TVmaze can't be read.
  async airings(ids: { tvdbId?: number; imdbId?: string }): Promise<TvmazeAiring[]> {
    const key = ids.tvdbId ? `tvdb:${ids.tvdbId}` : ids.imdbId ? `imdb:${ids.imdbId}` : undefined;
    if (!key) return [];
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL) return hit.airings;
    try {
      const show = await this.lookup(ids);
      const airings = show === undefined ? [] : await this.episodes(show);
      this.cache.set(key, { at: this.now(), airings });
      this.state.lastOkAt = this.now(); delete this.state.lastError; delete this.state.lastErrorAt;
      return airings;
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : String(e); this.state.lastErrorAt = this.now();
      throw e;
    }
  }

  // TVmaze's show id from the lookup's redirect (…/shows/169), undefined on a 404.
  private async lookup(ids: { tvdbId?: number; imdbId?: string }) {
    const url = new URL(`${BASE}/lookup/shows`);
    if (ids.tvdbId) url.searchParams.set('thetvdb', String(ids.tvdbId)); else url.searchParams.set('imdb', ids.imdbId!);
    let response: Response;
    try { response = await this.transport(url, { headers: { 'User-Agent': 'tk.box/0.0.1' }, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { throw new AppError('TVMAZE_UNAVAILABLE', 'TVmaze could not be reached.', 502); }
    await response.body?.cancel();
    if (response.status === 404) return undefined;
    if (response.status === 429) throw new AppError('TVMAZE_RATE_LIMITED', 'TVmaze is rate-limiting requests.', 503);
    const id = /\/shows\/(\d+)/.exec(response.headers.get('location') ?? '')?.[1];
    if (response.status < 300 || response.status >= 400 || !id) throw new AppError('TVMAZE_FAILED', `TVmaze's lookup returned HTTP ${response.status}.`, 502);
    return Number(id);
  }

  private async episodes(show: number): Promise<TvmazeAiring[]> {
    const { status, data } = await remoteJson(new URL(`${BASE}/shows/${show}/episodes`), {}, 'TVmaze', this.transport, 10000);
    if (status === 429) throw new AppError('TVMAZE_RATE_LIMITED', 'TVmaze is rate-limiting requests.', 503);
    if (status !== 200 || !Array.isArray(data)) throw new AppError('TVMAZE_FAILED', `TVmaze returned HTTP ${status}.`, 502);
    return (data as TvmazeEpisode[]).flatMap(e => {
      const airAt = typeof e.airstamp === 'string' ? Date.parse(e.airstamp) : NaN;
      if (typeof e.season !== 'number' || typeof e.number !== 'number' || !Number.isFinite(airAt)) return [];
      return [{ season: e.season, episode: e.number, ...(typeof e.airdate === 'string' && e.airdate ? { airDate: e.airdate } : {}), airAt }];
    });
  }
}

// TMDB's episodes with TVmaze's air time where both agree it's the same episode: the same season and number, and air
// days at most a day apart (TVmaze's day is the network's, TMDB's usually the US one). Others keep `fallback`.
export function withAirTimes<E extends { season: number; episode: number; airDate?: string; airAt?: number }>(episodes: readonly E[], airings: readonly TvmazeAiring[]): E[] {
  const byNumber = new Map(airings.map(a => [`${a.season}:${a.episode}`, a]));
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
  return episodes.map(e => {
    const a = byNumber.get(`${e.season}:${e.episode}`);
    if (!a) return e;
    if (e.airDate && a.airDate && Math.abs(day(e.airDate) - day(a.airDate)) > 86400000) return e;
    return { ...e, airAt: a.airAt };
  });
}
