import type { PlexAdapter } from '../../providers/plex.js';
import { parsePage, type ParsedPage } from './html.js';
import { CollectionError, SOURCE_LIMIT, chooseTitles, sourceChoice, type Details, type ListRow, type Member } from './rules.js';
import type { Item } from './plex.js';

// The public lists collections are made from (TMDb, IMDb, Letterboxd, MDBList, FlixPatrol and Plex Discover lists), the
// Discover page's suggestions and previews, and reading one list's titles.
// Only these providers' own hosts are ever asked; a list URL is rebuilt from its parts.
export class ProviderError extends Error {}
export const COLLECTION_PROVIDERS = {
  tmdb: ['TMDb', 'www.themoviedb.org'], imdb: ['IMDb', 'www.imdb.com'], letterboxd: ['Letterboxd', 'letterboxd.com'],
  mdblist: ['MDBList', 'mdblist.com'], flixpatrol: ['FlixPatrol', 'flixpatrol.com'], plex: ['Plex', 'watch.plex.tv'] } as const;
export type Provider = keyof typeof COLLECTION_PROVIDERS;
export const COLLECTION_RECOMMENDATIONS: readonly (readonly [string, string, string, 'movie' | 'tv'])[] = [
  ['TMDb Trending Movies', 'https://www.themoviedb.org/trending/movie/week', 'This week\'s trending movies', 'movie'],
  ['TMDb Trending TV', 'https://www.themoviedb.org/trending/tv/week', 'This week\'s trending shows', 'tv'],
  ['TMDb Top Rated Movies', 'https://www.themoviedb.org/movie/top-rated', 'Highly rated movies', 'movie'],
  ['IMDb Top 250', 'https://www.imdb.com/chart/top/', 'Classic and contemporary audience favorites', 'movie'],
  ['IMDb Popular Movies', 'https://www.imdb.com/chart/moviemeter/', 'Movies attracting attention on IMDb', 'movie'],
  ['IMDb Top Rated TV', 'https://www.imdb.com/chart/toptv/', 'Highly rated television', 'tv'],
  ['Letterboxd Top 250', 'https://letterboxd.com/xobl/list/official-top-250-narrative-feature-films/', 'Community-rated narrative features', 'movie'],
  ['Netflix Top 10', 'https://flixpatrol.com/top10/netflix/world/', 'Netflix\'s worldwide movie and TV charts', 'movie'],
  ['Disney+ Top 10', 'https://flixpatrol.com/top10/disney/world/', 'Disney+ worldwide movie and TV charts', 'movie'],
  ['Prime Video Top 10', 'https://flixpatrol.com/top10/amazon-prime/world/', 'Prime Video worldwide charts', 'movie'],
  ['Released This Week in History', 'https://watch.plex.tv/discover/list/historical-week', 'Plex\'s movies released this week in years past; it changes every week', 'movie']];
// Membership sources: github.com/Kometa-Team/Kometa/blob/master/defaults/both/universe.yml
export const COLLECTION_UNIVERSES: readonly (readonly [string, string, string, readonly ('movie' | 'tv')[]])[] = [
  ['avp', 'Alien / Predator', 'https://www.imdb.com/list/ls543971628/', ['movie']],
  ['arrow', 'Arrowverse', 'https://www.imdb.com/list/ls566667558/', ['movie', 'tv']],
  ['askew', 'View Askewniverse', 'https://mdblist.com/lists/k0meta/external/15362/', ['movie', 'tv']],
  ['conjuring', 'Conjuring Universe', 'https://www.imdb.com/list/ls068768438/', ['movie']],
  ['dca', 'DC Animated Universe', 'https://mdblist.com/lists/johnfawkes/dca/', ['movie', 'tv']],
  ['dceu', 'DC Extended Universe', 'https://mdblist.com/lists/fa11en82/dc-extended-universe/', ['movie', 'tv']],
  ['dcu', 'DC Universe', 'https://www.themoviedb.org/list/8642250/', ['movie', 'tv']],
  ['fast', 'Fast & Furious', 'https://www.imdb.com/list/ls4102351575/', ['movie']],
  ['marvel', 'In Association With Marvel', 'https://mdblist.com/lists/k0meta/external/15110/', ['movie', 'tv']],
  ['mcu', 'Marvel Cinematic Universe', 'https://www.imdb.com/list/ls539646485/', ['movie', 'tv']],
  ['middle', 'Middle Earth', 'https://mdblist.com/lists/k0meta/external/46550/', ['movie', 'tv']],
  ['rocky', 'Rocky / Creed', 'https://mdblist.com/lists/k0meta/external/9248/', ['movie']],
  ['trek', 'Star Trek', 'https://www.imdb.com/list/ls547463722/', ['movie', 'tv']],
  ['star', 'Star Wars Universe', 'https://www.imdb.com/list/ls501373412/', ['movie', 'tv']],
  ['mummy', 'Mummy Universe', 'https://mdblist.com/lists/k0meta/external/9249/', ['movie']],
  ['wizard', 'Wizarding World', 'https://mdblist.com/lists/k0meta/external/23683/', ['movie']],
  ['xmen', 'X-Men Universe', 'https://www.imdb.com/list/ls567618635/', ['movie', 'tv']]];
const IMDB_CHARTS: Record<string, string> = { top: 'TOP_RATED_MOVIES', toptv: 'TOP_RATED_TV_SHOWS', moviemeter: 'MOST_POPULAR_MOVIES', tvmeter: 'MOST_POPULAR_TV_SHOWS' };
const IMDB_TITLE = 'id titleText { text } releaseYear { year }';
const IMDB_PAGE = 'pageInfo { hasNextPage endCursor } edges { title { ' + IMDB_TITLE + ' titleType { id canHaveEpisodes } series { series { ' + IMDB_TITLE + ' } } } }';
const IMDB_MOVIE_TYPES = new Set(['movie', 'tvMovie', 'short', 'tvShort', 'video', 'tvSpecial']);
const PATTERNS: Record<Provider, RegExp> = {
  tmdb: /^\/(?:collection\/\d+(?:-[\w-]+)?|list\/\d+(?:-[\w-]+)?|trending\/(?:movie|tv)\/(?:day|week)|(?:movie|tv)\/(?:popular|top-rated))$/,
  imdb: /^\/(?:list\/ls\d+|chart\/(?:top|toptv|moviemeter|tvmeter))$/,
  letterboxd: /^\/[\w-]+\/list\/[\w-]+$/,
  mdblist: /^\/lists\/(?:\d+|[\w-]+\/[\w-]+|[\w-]+\/external\/\d+)$/,
  flixpatrol: /^\/top10\/[\w-]+\/[\w-]+(?:\/\d{4}-\d{2}-\d{2})?$/,
  plex: /^\/discover\/list\/[\w-]+$/ };

// The canonical public list URL. Never forwards user-supplied credentials, hosts or query strings.
export function collectionSource(url: unknown): [Provider, string] {
  if (typeof url !== 'string') throw new CollectionError('Enter a public collection URL');
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { throw new CollectionError('Unsupported list URL. Use a TMDb list/collection/chart, IMDb list/chart, Letterboxd list, MDBList list, FlixPatrol Top 10 or Plex Discover list URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new CollectionError('Use an HTTPS collection URL without credentials or a custom port');
  const provider = (Object.keys(COLLECTION_PROVIDERS) as Provider[]).find(key => { const host = COLLECTION_PROVIDERS[key][1]; return parsed.hostname === host || parsed.hostname === host.replace(/^www\./, ''); });
  let path = parsed.pathname.replace(/\/+$/, '');
  if (provider === 'plex') path = path.replace(/^\/me(?=\/)/, '');  // watch.plex.tv/me/discover/... is the signed-in view of the same list
  if (!provider || !PATTERNS[provider].test(path))
    throw new CollectionError('Unsupported list URL. Use a TMDb list/collection/chart, IMDb list/chart, Letterboxd list, MDBList list, FlixPatrol Top 10 or Plex Discover list URL');
  return [provider, `https://${COLLECTION_PROVIDERS[provider][1]}${path}/`];
}

// The hosts the sources may ask: each provider's site (its pages and their title pages), MDBList's API and IMDb's.
const HOSTS = new Set([...Object.values(COLLECTION_PROVIDERS).map(([, host]) => host), 'api.mdblist.com', 'api.graphql.imdb.com']);
type Fetch = typeof fetch;
// Up to 3 redirects, each to one of those hosts; GETs are tried again after 429 or 5xx, as the engine's session did.
async function request(transport: Fetch, url: URL, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, maxBytes = 16 * 1024 * 1024) {
  for (let hop = 0, attempt = 0; hop < 4;) {
    if (!HOSTS.has(url.hostname) || url.protocol !== 'https:') throw new CollectionError('The list redirected elsewhere; it was not read');
    let response: Response;
    try { response = await transport(url, { method: init.method ?? 'GET', headers: { 'User-Agent': 'tk.box/1.0', ...init.headers }, ...(init.body ? { body: init.body } : {}), redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
    catch { throw new ProviderError(`${url.hostname}: could not be reached`); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location') ?? '', url); hop++; continue;
    }
    if ((response.status === 429 || response.status >= 500) && (init.method ?? 'GET') === 'GET' && attempt < 3) {
      await response.body?.cancel();
      const wait = Math.min(Number(response.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt, 10000);
      await new Promise(resolve => setTimeout(resolve, wait)); attempt++; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new ProviderError(`${url.hostname}: HTTP ${response.status}`); }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); throw new CollectionError('That page is larger than 16 MB'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new CollectionError('Too many redirects');
}

// Answers kept between runs and Discover's requests: API answers for a day, pages for an hour.
class Remembered {
  private entries = new Map<string, { until: number; value: unknown }>();
  constructor(private max = 300) {}
  get<T>(key: string) { const hit = this.entries.get(key); if (!hit || hit.until < Date.now()) return undefined; this.entries.delete(key); this.entries.set(key, hit); return hit.value as T; }
  set<T>(key: string, value: T, ttl: number) { this.entries.delete(key); this.entries.set(key, { until: Date.now() + ttl, value }); while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!); return value; }
}
const remembered = new Remembered();

export type Tmdb = { configured(): boolean; get(path: string, params?: Record<string, string>): Promise<unknown> };
export type SourceRow = ListRow & { details?: Details | null };
export type Fetched = { provider: Provider; url: string; name: string; type: 'movie' | 'tv'; limit: number; items: SourceRow[]; left_out: { title: string; year: string; why: string }[]; candidates?: SourceRow[]; details?: boolean };
type Json = Record<string, any>;
const strings = (params: Record<string, string | number | boolean | undefined>) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}
export { mapLimit };
function* objects(value: unknown): Generator<Json> {
  if (Array.isArray(value)) { for (const child of value) yield* objects(child); }
  else if (value && typeof value === 'object') { yield value as Json; for (const child of Object.values(value)) yield* objects(child); }
}

export type SourcesContext = { tmdb: Tmdb; mdblistKey?: string; region: string; plex: PlexAdapter; token: string; transport?: Fetch; scan?: (kind: 'movie' | 'show') => Promise<Item[]> };
export class CollectionSources {
  private transport: Fetch;
  constructor(private ctx: SourcesContext) { this.transport = ctx.transport ?? fetch; }
  get tmdbConfigured() { return this.ctx.tmdb.configured(); }
  async tmdb(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Json> {
    if (!this.ctx.tmdb.configured()) throw new CollectionError('Add a TMDb key in Admin › Connections to use TMDb collections');
    try { return ((await this.ctx.tmdb.get(path, strings(params))) ?? {}) as Json; }
    catch (e) { throw new ProviderError((e as Error).message); }
  }
  private async mdblist(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<any> {
    if (!this.ctx.mdblistKey) throw new CollectionError('Add an MDBList key in Admin › Connections to use this collection provider');
    const url = new URL('https://api.mdblist.com' + path);
    for (const [k, v] of Object.entries(strings(params))) url.searchParams.set(k, v);
    const key = 'mdblist:' + url.toString();
    const hit = remembered.get<unknown>(key); if (hit !== undefined) return hit;
    url.searchParams.set('apikey', this.ctx.mdblistKey);
    const text = await request(this.transport, url, { headers: { Accept: 'application/json' } });
    try { return remembered.set(key, JSON.parse(text), 86400000); } catch { throw new ProviderError('api.mdblist.com: invalid answer'); }
  }
  async page(url: string): Promise<ParsedPage> {
    const key = 'page:' + url, hit = remembered.get<ParsedPage>(key);
    if (hit) return hit;
    return remembered.set(key, parsePage(await request(this.transport, new URL(url))), 3600000);
  }
  // IMDb's own GraphQL API: list and chart pages refuse servers, but the API their site loads from answers them.
  private async imdb(field: string, variables: Record<string, string | null> = {}) {
    const names: Record<string, string> = { id: 'ID!', after: 'String' }, keys = Object.keys(variables);
    const query = `query${keys.length ? '(' + keys.map(k => `$${k}: ${names[k]}`).join(', ') + ')' : ''} { ${field} }`;
    const key = 'imdb:' + JSON.stringify([query, variables]), hit = remembered.get<Json>(key);
    if (hit) return hit;
    const text = await request(this.transport, new URL('https://api.graphql.imdb.com/'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-imdb-client-name': 'imdb-web-next' }, body: JSON.stringify({ query, variables }) });
    let data: Json;
    try { data = JSON.parse(text) as Json; } catch { throw new ProviderError('api.graphql.imdb.com: invalid answer'); }
    const errors = ((data.errors ?? []) as Json[]).map(e => e.extensions?.code ?? e.message);
    if (errors.includes('RESOURCE_NOT_FOUND')) throw new CollectionError('That IMDb list doesn\'t exist');
    if (errors.includes('FORBIDDEN')) throw new CollectionError('That IMDb list is private; make it public on IMDb first');
    if (errors.length || !data.data) throw new CollectionError('IMDb did not return the list (' + (errors[0] ?? 'empty answer') + ')');
    return remembered.set(key, data.data as Json, 3600000);
  }
  // Plex's Discover catalog (its online lists), read with the run's Plex token and never cached.
  private async plexDiscover(path: string, params: Record<string, string | number> = {}) {
    try { return ((await this.ctx.plex.discover(this.ctx.token, path, params)) as Json)?.MediaContainer ?? {}; }
    catch (e) {
      if ((e as { code?: string }).code === 'PLEX_ACCESS_DENIED') throw new CollectionError('Plex Discover refused tk.box\'s Plex token, so its lists can\'t be read');
      throw new ProviderError((e as Error).message);
    }
  }
  recommendations(provider = 'all', query = '') {
    if (provider !== 'all' && !(provider in COLLECTION_PROVIDERS)) throw new CollectionError('Unknown collection provider');
    const q = query.toLowerCase();
    const rows: Json[] = COLLECTION_RECOMMENDATIONS.map(([name, url, description, type]) => ({ name, url, description, type, provider: collectionSource(url)[0] }))
      .filter(r => (provider === 'all' || r.provider === provider) && `${r.name} ${r.description}`.toLowerCase().includes(q));
    if ((provider === 'all' || provider === 'mdblist') && (!query || 'popular mdblist collections'.includes(q)))
      rows.push({ name: 'Popular MDBList collections', url: null, description: 'Browse community lists ranked by likes (needs an MDBList key)', type: 'movie', provider: 'mdblist' });
    return rows;
  }
  // The universes of one media type, those you have most of first, counted from each one's list as the Discover index
  // last read it; one not read yet is still offered, without a count, last.
  async universes(query: string, kind: string, lists: Map<string, Member[]>) {
    if (kind !== 'movie' && kind !== 'tv') throw new CollectionError('Choose movies or TV for universe collections');
    const rows: Json[] = COLLECTION_UNIVERSES.filter(([, name, , kinds]) => kinds.includes(kind) && name.toLowerCase().includes(query.toLowerCase())).map(([key, name, url]) => {
      const [provider, canonical] = collectionSource(url);
      return { key, name, url: canonical, type: kind, provider, description: 'Curated universe membership from ' + COLLECTION_PROVIDERS[provider][0] };
    });
    if (!rows.some(r => lists.has(`${r.key}:${kind}`)) || !this.ctx.scan) return rows;
    const items = await this.ctx.scan(kind === 'movie' ? 'movie' : 'show');
    const counted = rows.map(row => {
      const members = lists.get(`${row.key}:${kind}`);
      if (!members) return row;
      const owned = ownedMembers(members, items);
      return { ...row, owned, total: members.length, description: `You have ${owned} of ${members.length}. ${row.description}` };
    });
    return counted.sort((a, b) => Number(!('owned' in a)) - Number(!('owned' in b)) || (b.owned ?? 0) - (a.owned ?? 0) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
  async discover(provider: string, query = '') {
    let rows: Json[] = [];
    if (provider === 'tmdb') {
      if (!query.trim()) return this.recommendations(provider);
      for (const row of ((await this.tmdb('/search/collection', { query, page: 1 })).results ?? []).slice(0, 20))
        rows.push({ name: row.name, url: `https://www.themoviedb.org/collection/${row.id}/`, description: row.overview ?? '', type: 'movie', provider });
    } else if (provider === 'mdblist') {
      const results = query ? await this.mdblist('/lists/search', { query }) : await this.mdblist('/lists/top');
      for (const row of (Array.isArray(results) ? results : []).slice(0, 20))
        rows.push({ name: row.name, url: `https://mdblist.com/lists/${row.id}/`, description: row.description || 'Popular MDBList collection', type: row.mediatype === 'show' ? 'tv' : 'movie', provider });
    } else if (provider === 'letterboxd') {
      const page = await this.page('https://letterboxd.com/lists/popular/this/week/'), seen = new Set<string>();
      for (const link of page.links)
        if (/^\/[\w-]+\/list\/[\w-]+\/$/.test(link.url) && link.title && !seen.has(link.url)) {
          seen.add(link.url);
          if (link.title.toLowerCase().includes(query.toLowerCase())) rows.push({ name: link.title, url: 'https://letterboxd.com' + link.url, description: 'Popular this week on Letterboxd', type: 'movie', provider });
        }
      rows = rows.slice(0, 20);
      if (!rows.length && !query) throw new CollectionError('Letterboxd did not return readable public lists; try a specific list URL');
    } else if (provider === 'imdb' || provider === 'flixpatrol' || provider === 'plex') rows = this.recommendations(provider, query);
    else throw new CollectionError('Choose a provider to browse');
    return rows;
  }
  // What filters and sorts read about one title: its year, TMDb rating, genres, original language and certification (in
  // the collections region), from TMDb's details (cached).
  async details(kind: 'movie' | 'tv', tmdbId: number): Promise<Details> {
    const region = this.ctx.region;
    let found: Json, dated: unknown, ratings: unknown[];
    if (kind === 'movie') {
      found = await this.tmdb(`/movie/${tmdbId}`, { append_to_response: 'release_dates' }); dated = found.release_date;
      ratings = ((found.release_dates?.results ?? []) as Json[]).filter(r => r.iso_3166_1 === region).flatMap(r => ((r.release_dates ?? []) as Json[]).map(c => c.certification));
    } else {
      found = await this.tmdb(`/tv/${tmdbId}`, { append_to_response: 'content_ratings' }); dated = found.first_air_date;
      ratings = ((found.content_ratings?.results ?? []) as Json[]).filter(r => r.iso_3166_1 === region).map(r => r.rating);
    }
    const year = String(dated ?? '').slice(0, 4);
    return { year: /^\d+$/.test(year) ? Number(year) : null, rating: found.vote_average || null, language: found.original_language || null,
      genres: ((found.genres ?? []) as Json[]).map(g => g.name).filter(Boolean), certification: (ratings.find(r => r) as string | undefined) ?? null };
  }
  // A list's titles. With `choose` (a collection's filter and sort) or titles to `exclude`, the whole list is read, the
  // excluded titles taken out, the rest filtered and sorted, and only then cut to `limit`; what was left out comes back
  // with why. With `candidates`, every title of the whole list also comes back with its TMDb details, for the editor.
  async fetch(url: unknown, kind: 'movie' | 'tv' = 'movie', limitIn?: number, options: { resolve?: boolean; choose?: { filter?: unknown; sort?: unknown }; exclude?: Member[]; candidates?: boolean; today?: Date } = {}): Promise<Fetched> {
    const [provider, canonical] = collectionSource(url);
    let limit = limitIn ?? SOURCE_LIMIT, resolve = options.resolve ?? true;
    if (!Number.isInteger(limit) || limit < 1 || limit > 250 || (kind !== 'movie' && kind !== 'tv')) throw new CollectionError('Choose movies or TV and a source limit from 1 to 250');
    const choose = sourceChoice(options.choose ?? {}), exclude = options.exclude ?? [], candidates = !!options.candidates, wanted = limit;
    const choosing = Object.keys(choose).length > 0;
    if (choosing && !this.tmdbConfigured && !candidates) throw new CollectionError('Filtering or sorting a list needs a TMDb API key');
    if (choosing || exclude.length || candidates) { limit = 250; resolve = true; }
    const path = new URL(canonical).pathname.replace(/\/+$/, '');
    let name = COLLECTION_RECOMMENDATIONS.find(r => collectionSource(r[1])[1] === canonical)?.[0] ?? path.split('/').at(-1)!.replaceAll('-', ' ');
    const rows: SourceRow[] = [];
    const add = (row: Json, mediaIn?: string, titleOnly = false) => {
      const media = mediaIn || row.media_type || row.mediatype || kind;
      if ((['show', 'tv', 'TVSeries'].includes(media) ? 'tv' : 'movie') !== kind) return;
      const ids = (row.ids ?? {}) as Json, title = String(row.title || row.name || '');
      const year = String(row.year || row.release_year || String(row.release_date || row.first_air_date || '').slice(0, 4) || '');
      let member: Member | undefined = ids.tmdb || row.tmdb_id ? { tmdb_id: Number(ids.tmdb || row.tmdb_id) } : undefined;
      const imdb = ids.imdb || row.imdb_id;
      if (!member && imdb && /^tt\d+$/.test(String(imdb))) member = { imdb_id: String(imdb) };
      if (!member && title && (year || titleOnly)) member = { title, ...(year ? { year: Number(year) } : {}) };
      if (!member) throw new CollectionError('A source title could not be identified; refusing partial membership');
      if (!rows.some(r => JSON.stringify(r.member) === JSON.stringify(member))) rows.push({ title: title || String(Object.values(member)[0]), year, member });
    };
    const tooMany = () => new CollectionError('Too many source pages; choose a smaller collection limit');
    if (provider === 'tmdb') {
      if (path.startsWith('/collection/')) {
        const result = await this.tmdb('/collection/' + /\/collection\/(\d+)/.exec(path)![1]);
        name = result.name;
        for (const row of (result.parts ?? []) as Json[]) add({ ...row, tmdb_id: row.id }, 'movie');
      } else {
        const endpoint = path.startsWith('/list/') ? '/list/' + /\/list\/(\d+)/.exec(path)![1] : path.replace('top-rated', 'top_rated');
        let page = 1;
        for (; page <= 25; page++) {
          const result = await this.tmdb(endpoint, { page });
          name = result.name || name;
          const batch = (result.items ?? result.results ?? []) as Json[];
          for (const row of batch) add({ ...row, tmdb_id: row.id }, row.media_type || (path.includes('/tv/') ? 'tv' : 'movie'));
          if (rows.length >= limit || !batch.length || page >= (result.total_pages ?? 1)) break;
        }
        if (page > 25) throw tooMany();
      }
    } else if (provider === 'mdblist') {
      const external = /^\/lists\/[\w-]+\/external\/(\d+)$/.exec(path), endpoint = external ? '/external/lists/' + external[1] : path;
      if (external || /^\/lists\/\d+$/.test(endpoint)) {
        let metadata = await this.mdblist(endpoint);
        if (Array.isArray(metadata)) metadata = metadata[0] ?? {};
        name = metadata?.name || name;
      }
      let offset = 0;
      for (; offset < 2500; offset += 100) {
        const result = await this.mdblist(endpoint + '/items', { limit: 100, offset, ...(external ? { unified: 'True' } : {}) });
        const batch = (Array.isArray(result) ? result : result?.[kind === 'movie' ? 'movies' : 'shows'] ?? result?.items ?? []) as Json[];
        for (const row of batch) add({ ...row, tmdb_id: row.id || row.tmdbid }, row.mediatype || row.type || kind);
        const empty = !result || (Array.isArray(result) ? !result.length : !['movies', 'shows', 'items'].some(key => result[key]?.length));
        if (rows.length >= limit || empty) break;
      }
      if (offset >= 2500) throw tooMany();
    } else if (provider === 'imdb') {
      const chart = path.startsWith('/chart/') ? IMDB_CHARTS[path.split('/').at(-1)!] : undefined;
      let after: string | null = null, round = 0;
      for (; round < 25; round++) {
        let result: Json;
        if (chart) result = (await this.imdb(`chartTitles(first: 250, chart: {chartType: ${chart}}) { ${IMDB_PAGE.replace('title {', 'node {')} }`)).chartTitles;
        else {
          const found = (await this.imdb(`list(id: $id) { name { originalText } titleListItemSearch(first: 250, after: $after) { ${IMDB_PAGE} } }`, { id: path.split('/').at(-1)!, after })).list as Json;
          name = found.name?.originalText || name;
          result = found.titleListItemSearch;
        }
        for (const edge of (result.edges ?? []) as Json[]) {
          let title = (edge.title ?? edge.node) as Json | undefined;
          if (!title || !/^tt\d+$/.test(String(title.id))) throw new CollectionError('An IMDb list item has no readable identifier; refusing partial membership');
          const type = (title.titleType ?? {}) as Json, typeId = type.id as string | undefined;
          let media: string;
          if (typeId === 'tvEpisode') {
            if (kind !== 'tv') continue;
            title = (title.series?.series ?? {}) as Json;
            if (!/^tt\d+$/.test(String(title.id))) throw new CollectionError('An IMDb episode has no parent series ID; refusing partial membership');
            media = 'tv';
          } else if (type.canHaveEpisodes) media = 'tv';
          else if (typeId === undefined || typeId === null || IMDB_MOVIE_TYPES.has(typeId)) media = 'movie';
          else continue;
          add({ title: title.titleText?.text ?? '', year: String(title.releaseYear?.year ?? ''), imdb_id: title.id }, media);
        }
        if (rows.length >= limit || !result.pageInfo.hasNextPage) break;
        after = result.pageInfo.endCursor;
      }
      if (round >= 25) throw tooMany();
    } else if (provider === 'plex') {
      // The list is one of Discover's home shelves; its slug is in the shelf's key or identifier.
      const slug = path.split('/').at(-1)!, escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hubs = ((await this.plexDiscover('/hubs/sections/home', { includeMeta: 1 })).Hub ?? []) as Json[];
      const hub = hubs.find(h => new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(['key', 'hubKey', 'hubIdentifier', 'context'].map(k => String(h[k] ?? '')).join(' '))
        || String(h.title ?? '').toLowerCase() === name.toLowerCase());
      if (!hub || !String(hub.key || hub.hubKey || '').startsWith('/'))
        throw new CollectionError(`Plex Discover doesn't offer the ${slug} list to this account. It offers: ${hubs.map(h => h.title).filter(Boolean).join(', ') || 'none'}`);
      name = hub.title || name;
      const found = await this.plexDiscover(hub.key || hub.hubKey, { limit: Math.min(limit * 2, 250), includeGuids: 1, includeMeta: 1, excludeElements: 'Media,Image' });
      const entries = ((found.Metadata ?? found.Hub?.[0]?.Metadata ?? []) as Json[]).filter(m => m.type === (kind === 'tv' ? 'show' : 'movie'));
      // Discover's shelves often leave out the external IDs; one read per 20 titles fills them in.
      const guids = new Map<string, Json[]>();
      const missing = entries.filter(m => m.ratingKey && !m.Guid && /^[\w-]{1,64}$/.test(m.ratingKey)).map(m => m.ratingKey as string);
      for (let start = 0; start < missing.length; start += 20)
        for (const m of ((await this.plexDiscover('/library/metadata/' + missing.slice(start, start + 20).join(','), { includeGuids: 1, excludeElements: 'Media,Image' })).Metadata ?? []) as Json[])
          guids.set(m.ratingKey, m.Guid ?? []);
      for (const m of entries) {
        const ids: Json = {};
        for (const guid of (m.Guid ?? guids.get(m.ratingKey) ?? []) as Json[]) {
          const id = /^(tmdb|imdb):\/\/(\w+)$/.exec(String(guid.id ?? ''));
          if (id && !(id[1]! in ids) && (id[1] === 'imdb' || /^\d+$/.test(id[2]!))) ids[id[1]!] = id[2];
        }
        add({ title: m.title, year: String(m.year ?? ''), ids }, m.type === 'show' ? 'tv' : 'movie');
        if (rows.length >= limit) break;
      }
    } else {
      let page = await this.page(canonical);
      name = page.title.split(' • ')[0]!.trim() || name;
      const links: string[] = [], seen = new Set<string>(), labels = new Map<string, string>(), mediaTypes = new Map<string, string | null>();
      const host = COLLECTION_PROVIDERS[provider][1], pattern = provider === 'letterboxd' ? /^\/film\/[\w-]+\/$/ : /^\/title\/[\w-]+\/$/;
      let number = 1;
      for (; number <= 10; number++) {
        const found = provider === 'letterboxd' && page.posters.length ? page.posters.map(p => ({ ...p, table: true, media: null, next: false })) : page.links;
        for (const link of found) {
          if (provider === 'flixpatrol' && (!link.table || ![null, kind].includes(link.media))) continue;
          let target: URL; try { target = new URL(link.url, canonical); } catch { continue; }
          if (target.hostname === host && pattern.test(target.pathname) && !seen.has(target.href)) {
            seen.add(target.href); links.push(target.href); labels.set(target.href, link.title); mediaTypes.set(target.href, link.media);
          }
        }
        if (links.length >= limit * (provider === 'flixpatrol' ? 2 : 1)) break;
        const next = page.links.find(l => l.next);
        if (!next) break;
        const target = new URL(next.url, canonical);
        if (target.hostname !== host || !target.pathname.startsWith(path + '/')) throw new CollectionError('Unexpected pagination link from provider');
        page = await this.page(target.href);
      }
      if (number > 10) throw tooMany();
      for (const target of links) {
        const label = /^(.+) \((\d{4})\)$/.exec(labels.get(target) ?? '');
        if (provider === 'letterboxd' && label) { add({ title: label[1], year: label[2] }, 'movie'); if (rows.length >= limit) break; continue; }
        const detail = await this.page(target);
        let found = false;
        for (const link of detail.links) {
          const match = /themoviedb\.org\/(movie|tv)\/(\d+)/.exec(link.url);
          if (match) { add({ title: detail.title.split(' (')[0]!.split(' • ')[0], tmdb_id: Number(match[2]) }, match[1]); found = true; break; }
        }
        if (!found) for (const script of detail.scripts) {
          for (const obj of objects(script)) if (obj['@type'] === 'Movie' || obj['@type'] === 'TVSeries') { add({ title: obj.name, year: String(obj.datePublished ?? '').slice(0, 4) }, obj['@type']); found = true; break; }
          if (found) break;
        }
        if (!found && provider === 'flixpatrol' && mediaTypes.get(target) === kind && labels.get(target)) { add({ title: labels.get(target) }, kind, true); found = true; }
        if (!found) throw new CollectionError('A source title could not be identified; import stopped to avoid partial membership');
        if (rows.length >= limit) break;
      }
    }
    if (!rows.length) throw new CollectionError('No readable titles of the selected media type were returned; check the list, media type and provider access');
    rows.splice(limit);
    // Counting what you have needs no TMDb IDs (Plex knows IMDb IDs, titles and years); only adding a list does.
    if (resolve && this.tmdbConfigured)
      for (const row of rows) {
        const member = row.member;
        let matches: Json[];
        if (member.imdb_id) matches = (await this.tmdb('/find/' + member.imdb_id, { external_source: 'imdb_id' }))[kind === 'movie' ? 'movie_results' : 'tv_results'] ?? [];
        else if (member.title) {
          const result = await this.tmdb('/search/' + kind, { query: member.title, ...(member.year ? { [kind === 'movie' ? 'year' : 'first_air_date_year']: member.year } : {}) });
          matches = ((result.results ?? []) as Json[]).filter(m => String(m.title || m.name || '').toLowerCase() === member.title!.toLowerCase()
            && (!member.year || String(m.release_date || m.first_air_date || '').slice(0, 4) === String(member.year)));
          if ((result.total_pages ?? 1) > 1) matches = [];
        } else continue;
        if (matches.length === 1) {
          const match = matches[0]!;
          Object.assign(row, { member: { tmdb_id: match.id }, title: match.title || match.name || row.title, year: String(match.release_date || match.first_air_date || row.year).slice(0, 4) });
        }
      }
    let items: SourceRow[] = rows, leftOut: Fetched['left_out'] = [], everything: SourceRow[] | undefined;
    if (choosing || exclude.length || candidates) {
      const found = (choosing || candidates) && this.tmdbConfigured
        ? await mapLimit(rows, 6, row => row.member.tmdb_id ? this.details(kind, row.member.tmdb_id) : Promise.resolve(null)) : rows.map(() => null);
      everything = rows.map((row, i) => ({ ...row, details: found[i] }));
      const chosen = chooseTitles(everything, choose, wanted, options.today, exclude);
      items = chosen.kept; leftOut = chosen.left;
    }
    return { provider, url: canonical, name, type: kind, limit: wanted, items, left_out: leftOut, ...(candidates ? { candidates: everything, details: this.tmdbConfigured } : {}) };
  }
}

// How many of a list's members are in Plex, matched by TMDb or IMDb ID, or by title and year.
export function ownedMembers(members: Member[], items: Item[]) {
  const tmdb = new Set(items.flatMap(i => i.tmdb_id ? [i.tmdb_id] : [])), imdb = new Set(items.flatMap(i => i.imdb_id ? [i.imdb_id] : []));
  const titles = new Set(items.map(i => `${i.title.toLowerCase()}\0${i.year}`)), named = new Set(items.map(i => i.title.toLowerCase()));
  return members.filter(m => (m.tmdb_id && tmdb.has(m.tmdb_id)) || (m.imdb_id && imdb.has(m.imdb_id))
    || (m.title !== undefined && (m.year ? titles.has(`${String(m.title).toLowerCase()}\0${m.year}`) : named.has(String(m.title).toLowerCase())))).length;
}
