import { AppError } from '../errors.js';
import { remoteJson } from './remote-json.js';

// TheTVDB v4 (the key from Admin › Connections), for matching a show TMDB gives no TVDB id (library › show matches):
// a search by name, and a series' seasons with each one's episode count and first air date. The login token is kept
// until the key changes or TVDB refuses it; answers are kept 10 minutes.
const BASE = 'https://api4.thetvdb.com/v4', TTL = 10 * 60000;

export type TvdbSeries = { tvdbId: number; name: string; year?: number; image?: string; network?: string };
export type TvdbSeason = { season: number; episodes: number; firstAired?: string };
type Json = Record<string, unknown>;
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : undefined; };

export class Tvdb {
  private token?: { key: string; value: Promise<string> };
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(private key: () => string | undefined, private transport: typeof fetch = fetch, private now: () => number = Date.now) {}
  configured() { return !!this.key(); }

  async search(query: string): Promise<TvdbSeries[]> {
    const url = new URL(`${BASE}/search`);
    url.searchParams.set('query', query); url.searchParams.set('type', 'series'); url.searchParams.set('limit', '20');
    const data = await this.get(url) as Json[] | undefined;
    return (Array.isArray(data) ? data : []).flatMap(row => {
      const tvdbId = num(row.tvdb_id), name = str(row.name);
      if (!tvdbId || !name) return [];
      const year = num(row.year), image = str(row.image_url) ?? str(row.thumbnail), network = str(row.network);
      return [{ tvdbId, name, ...(year ? { year } : {}), ...(image ? { image } : {}), ...(network ? { network } : {}) }];
    });
  }

  // The series and its seasons in aired order (specials left out), from every page of its episodes.
  async series(tvdbId: number): Promise<{ series: TvdbSeries; seasons: TvdbSeason[] }> {
    let series: TvdbSeries | undefined;
    const seasons = new Map<number, TvdbSeason>();
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${BASE}/series/${tvdbId}/episodes/default`);
      url.searchParams.set('page', String(page));
      const data = await this.get(url, true) as { series?: Json; episodes?: Json[] } | undefined;
      if (!data?.series) break;
      if (!series) {
        const name = str(data.series.name) ?? `TVDB ${tvdbId}`, year = num(data.series.year), image = str(data.series.image);
        series = { tvdbId, name, ...(year ? { year } : {}), ...(image ? { image } : {}) };
      }
      const episodes = Array.isArray(data.episodes) ? data.episodes : [];
      for (const e of episodes) {
        const season = typeof e.seasonNumber === 'number' ? e.seasonNumber : undefined;
        if (!season || season < 1 || typeof e.number !== 'number') continue;
        const row = seasons.get(season) ?? { season, episodes: 0 }, aired = str(e.aired);
        row.episodes++;
        if (aired && (!row.firstAired || aired < row.firstAired)) row.firstAired = aired;
        seasons.set(season, row);
      }
      if (episodes.length < 500) break;
    }
    if (!series) throw new AppError('NOT_FOUND', `TVDB doesn't know series ${tvdbId}.`, 404);
    return { series, seasons: [...seasons.values()].sort((a, b) => a.season - b.season) };
  }

  private get(url: URL, missingOk = false): Promise<unknown> {
    const id = url.toString(), hit = this.cache.get(id);
    if (hit && this.now() - hit.at < TTL) return hit.value;
    const value = this.load(url, missingOk);
    this.cache.set(id, { at: this.now(), value });
    value.catch(() => { if (this.cache.get(id)?.value === value) this.cache.delete(id); });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
  private async load(url: URL, missingOk: boolean) {
    const response = await remoteJson(url, { headers: { Authorization: `Bearer ${await this.login()}` } }, 'TVDB', this.transport, 15000, 16 * 1024 * 1024);
    if (response.status === 401) { this.token = undefined; throw new AppError('TVDB_REFUSED', 'TVDB refused the API key.', 502); }
    if (response.status === 404 && missingOk) return undefined;
    if (response.status >= 400) throw new AppError('TVDB_FAILED', `TVDB answered ${response.status}.`, 502);
    return (response.data as Json | undefined)?.data;
  }
  private login() {
    const key = this.key();
    if (!key) throw new AppError('TVDB_KEY_MISSING', 'Add a TVDB key in Admin › Connections.', 409);
    if (this.token?.key !== key) {
      const value = remoteJson(new URL(`${BASE}/login`), { method: 'POST', body: { apikey: key } }, 'TVDB', this.transport, 15000).then(r => {
        const token = str(((r.data as Json | undefined)?.data as Json | undefined)?.token);
        if (r.status >= 400 || !token) throw new AppError('TVDB_REFUSED', r.status === 401 ? 'TVDB refused the API key.' : `TVDB answered ${r.status}.`, 502);
        return token;
      });
      value.catch(() => { if (this.token?.value === value) this.token = undefined; });
      this.token = { key, value };
    }
    return this.token.value;
  }
}
