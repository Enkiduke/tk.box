import { requireThat } from '../errors.js';
import { remoteJson } from './remote-json.js';
import { tmdbImage } from './explore-images.js';

// Admin › Collections picks titles by searching TMDb, and shows a collection's members as posters. Both use the
// artwork engine's TMDb key; answers are kept for a day, so reopening a collection asks TMDb only for new members.
export type TitleKind = 'movie' | 'tv';
export type TitleCard = { tmdb_id: number; title: string; year?: number; poster?: string };
export type TitleMember = { rating_key?: string; tmdb_id?: number; imdb_id?: string; title?: string; year?: number };
type Row = { id?: unknown; title?: unknown; name?: unknown; release_date?: unknown; first_air_date?: unknown; poster_path?: unknown };
const DAY_MS = 86400000, MAX_CACHED = 3000;

export class TmdbTitles {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(private key: () => string | undefined, private transport: typeof fetch = fetch, private now = Date.now) {}
  configured() { return !!this.key(); }
  private get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const key = this.key();
    requireThat(key, 'TMDB_KEY_MISSING', 'Add a TMDb key in Artwork › Settings to search for titles.', 409);
    const id = `${path}?${new URLSearchParams(params)}`, hit = this.cache.get(id);
    if (hit && this.now() - hit.at < DAY_MS) return hit.value;
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    for (const [k, v] of Object.entries({ ...params, api_key: key })) url.searchParams.set(k, v);
    const value = remoteJson(url, {}, 'TMDb', this.transport, 10000).then(r => {
      requireThat(r.status !== 401, 'CATALOG_UNAVAILABLE', 'TMDb refused the API key.', 502);
      requireThat(r.status < 500 && r.status !== 429, 'CATALOG_UNAVAILABLE', `TMDb answered ${r.status}.`, 502);
      return r.status === 404 ? undefined : r.data;
    });
    value.catch(() => this.cache.delete(id));
    this.cache.delete(id); this.cache.set(id, { at: this.now(), value });
    if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    return value;
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
