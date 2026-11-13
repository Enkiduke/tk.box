import { requireThat } from '../errors.js';
import { remoteJson } from './remote-json.js';
import { tmdbImage } from './explore-images.js';
import type { CalendarEpisodeLabel, CalendarEntry } from '../../../../packages/contracts/src/index.js';

// Admin › Collections picks titles by searching TMDb, and shows a collection's members as posters. Both use the
// artwork engine's TMDb key; answers are kept for a day, so reopening a collection asks TMDb only for new members.
export type TitleKind = 'movie' | 'tv';
export type TitleCard = { tmdb_id: number; title: string; year?: number; poster?: string };
export type TitleMember = { rating_key?: string; tmdb_id?: number; imdb_id?: string; title?: string; year?: number };
type Row = { id?: unknown; title?: unknown; name?: unknown; release_date?: unknown; first_air_date?: unknown; poster_path?: unknown };
const DAY_MS = 86400000, MAX_CACHED = 3000;
type Cached = { until: number; savedAt?: number; data?: unknown; pending?: Promise<unknown> };

export class TmdbTitles {
  private cache = new Map<string, Cached>();
  private credential?: string;
  private generation = 0;
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private key: () => string | undefined, private transport: typeof fetch = fetch, private now = Date.now) {}
  credentialGeneration() {
    const key = this.key();
    if (this.credential !== key) {
      this.credential = key;
      this.cache.clear();
      this.generation++;
    }
    return this.generation;
  }
  configured() { this.credentialGeneration(); return !!this.credential; }
  private async limited<T>(read: () => Promise<T>): Promise<T> {
    if (this.active < 6) this.active++;
    else {
      requireThat(this.waiting.length < 120, 'CATALOG_UNAVAILABLE', 'TMDB is busy. Try again in a moment.', 502);
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
    try { return await read(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  async get(path: string, params: Record<string, string> = {}, ttl = DAY_MS): Promise<unknown> {
    const generation = this.credentialGeneration(), key = this.credential;
    requireThat(key, 'TMDB_KEY_MISSING', 'Add a TMDB key in Artwork › Settings.', 409);
    const query = new URLSearchParams(params); query.sort();
    const id = `${path}?${query}`, hit = this.cache.get(id), now = this.now();
    if (hit?.pending) return hit.pending;
    if (hit && hit.until > now) return hit.data;
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    url.search = query.toString(); url.searchParams.set('api_key', key);
    const entry: Cached = { until: 0, savedAt: hit?.savedAt, data: hit?.data };
    entry.pending = this.limited(async () => {
      requireThat(this.credentialGeneration() === generation, 'TMDB_KEY_CHANGED', 'TMDB settings changed. Try again.', 409);
      const r = await remoteJson(url, {}, 'TMDB', this.transport, 10000);
      requireThat(r.status !== 401 && r.status !== 403, 'TMDB_KEY_REJECTED', 'TMDB refused the API key. Check Artwork › Settings.', 502);
      requireThat(r.status === 404 || (r.status === 200 && r.data !== undefined), 'CATALOG_UNAVAILABLE', `TMDB answered ${r.status}.`, 502);
      return r.status === 404 ? undefined : r.data;
    }).then(data => {
      requireThat(this.credentialGeneration() === generation, 'TMDB_KEY_CHANGED', 'TMDB settings changed. Try again.', 409);
      entry.savedAt = this.now(); entry.until = entry.savedAt + ttl; entry.data = data;
      return data;
    }).catch(error => {
      if (this.credentialGeneration() === generation && error?.code === 'CATALOG_UNAVAILABLE' &&
          entry.savedAt !== undefined && this.now() - entry.savedAt <= ttl + DAY_MS) {
        entry.until = this.now() + 60000;
        return entry.data;
      }
      if (this.cache.get(id) === entry) this.cache.delete(id);
      throw error;
    }).finally(() => {
      entry.pending = undefined;
      this.trim();
    });
    this.cache.delete(id); this.cache.set(id, entry);
    this.trim();
    return entry.pending;
  }
  private trim() {
    if (this.cache.size <= MAX_CACHED) return;
    for (const [id, entry] of this.cache) {
      if (!entry.pending) this.cache.delete(id);
      if (this.cache.size <= MAX_CACHED) break;
    }
  }
  private card(row: Row | undefined): TitleCard | null {
    if (!row || typeof row.id !== 'number') return null;
    const title = typeof row.title === 'string' ? row.title : typeof row.name === 'string' ? row.name : '';
    const year = Number(String(row.release_date || row.first_air_date || '').slice(0, 4)) || undefined;
    const poster = tmdbImage(typeof row.poster_path === 'string' ? row.poster_path : undefined, 'w342');
    return { tmdb_id: row.id, title, ...(year ? { year } : {}), ...(poster ? { poster } : {}) };
  }
  private async results(kind: TitleKind, query: string, year?: number) {
    const data = await this.get(`/search/${kind}`, { query, include_adult: 'false', ...(year ? { [kind === 'movie' ? 'year' : 'first_air_date_year']: String(year) } : {}) }) as { results?: Row[] } | undefined;
    return (Array.isArray(data?.results) ? data.results : []).map(r => this.card(r)).filter((c): c is TitleCard => !!c);
  }
  search(kind: TitleKind, query: string) { return this.results(kind, query).then(r => r.slice(0, 20)); }

  async episodeFinales(ids: CalendarEntry['ids'], season: number, episodes: number[]): Promise<Map<number, CalendarEpisodeLabel>> {
    const labels = new Map<number, CalendarEpisodeLabel>();
    if (!this.configured()) return labels;
    let series = ids.tmdb;
    if (!series && (ids.tvdb || ids.imdb)) {
      const found = await this.get(`/find/${ids.tvdb ?? ids.imdb}`, {external_source: ids.tvdb ? 'tvdb_id' : 'imdb_id'}) as {tv_results?: Row[]} | undefined;
      const matches = found?.tv_results;
      const match = matches?.length === 1 ? matches[0]?.id : undefined;
      if (typeof match === 'number' && Number.isSafeInteger(match) && match > 0) series = match;
    }
    if (!series) return labels;
    const path = `/tv/${series}`;
    const details = await this.get(`${path}/season/${season}`) as {episodes?: {episode_number: number; episode_type?: string}[]} | undefined;
    const scheduled = new Set(episodes);
    for (const episode of details?.episodes ?? []) {
      if (episode.episode_type === 'finale' && scheduled.has(episode.episode_number)) labels.set(episode.episode_number, 'season-finale');
    }
    if (!labels.size) return labels;
    // A season finale is also a series finale only when the show is over and this is its confirmed last episode.
    const show = await this.get(path).catch(() => undefined) as {status?: string; last_episode_to_air?: {season_number: number; episode_number: number}} | undefined;
    const last = show?.last_episode_to_air;
    if (show?.status === 'Ended' && last?.season_number === season && labels.has(last.episode_number)) {
      labels.set(last.episode_number, 'series-finale');
    }
    return labels;
  }
  // One card per member, in order; null where TMDb has no match (or the member is a Plex ID, which TMDb can't answer).
  async lookup(kind: TitleKind, members: TitleMember[]): Promise<(TitleCard | null)[]> {
    const one = async (m: TitleMember): Promise<TitleCard | null> => {
      if (m.tmdb_id) return this.card(await this.get(`/${kind}/${m.tmdb_id}`) as Row | undefined);
      if (m.imdb_id) {
        const found = await this.get(`/find/${m.imdb_id}`, { external_source: 'imdb_id' }) as Record<string, Row[] | undefined> | undefined;
        return this.card(found?.[kind === 'movie' ? 'movie_results' : 'tv_results']?.[0]);
      }
      if (m.title) {
        const rows = await this.results(kind, m.title, m.year), name = m.title.toLocaleLowerCase();
        return rows.find(r => r.title.toLocaleLowerCase() === name) ?? null;
      }
      return null;
    };
    const out: (TitleCard | null)[] = new Array(members.length).fill(null);
    let next = 0;
    const worker = async () => { while (next < members.length) { const i = next++; try { out[i] = await one(members[i]!); } catch { out[i] = null; } } };
    await Promise.all(Array.from({ length: Math.min(8, members.length) }, worker));
    return out;
  }
}
