import type { ExploreDetails, ExploreItem, ExploreRequestExtras, ExploreSeerrAccount, ExploreSeerrOptions, ExploreSeerrUser, ExplorePage, ExploreSeason, ExploreStatus, ExternalRating } from '../../../../packages/contracts/src/index.js';
import { AppError, requireThat } from '../errors.js';
import { remoteJson, remoteMessage } from './remote-json.js';
import { flagImage, tmdbImage } from './explore-images.js';

// Seerr (Overseerr, Jellyseerr): TMDB-backed discovery rows and media requests. Each viewer signs in to Seerr with
// their own Plex account token, so requests are made as, and limited to, their Seerr user.
type Info = { status?: number; status4k?: number; tvdbId?: number; ratingKey?: string;
  seasons?: { seasonNumber: number; status?: number; status4k?: number }[];
  requests?: { status?: number; is4k?: boolean; seasons?: { seasonNumber: number }[] }[] };
type Media = { id: number; mediaType?: string; title?: string; name?: string; originalTitle?: string; originalName?: string; overview?: string;
  posterPath?: string | null; backdropPath?: string | null; releaseDate?: string; firstAirDate?: string; voteAverage?: number; originalLanguage?: string; mediaInfo?: Info };
type Details = Media & { runtime?: number; episodeRunTime?: number[]; genres?: { name: string }[]; tagline?: string; numberOfEpisodes?: number;
  networks?: { name: string }[]; externalIds?: { imdbId?: string; tvdbId?: number }; imdbId?: string;
  seasons?: { seasonNumber: number; name?: string; episodeCount?: number; airDate?: string | null }[];
  status?: string; productionCountries?: { iso_3166_1?: string; name?: string }[]; originCountry?: string[];
  productionCompanies?: { name?: string }[];
  watchProviders?: { iso_3166_1?: string; flatrate?: { name?: string; logoPath?: string | null }[] }[]; credits?: { cast?: { id?: number; name?: string }[]; crew?: { id?: number; name?: string }[] };
  releases?: { results?: { iso_3166_1?: string; release_dates?: { certification?: string }[] }[] }; contentRatings?: { results?: { iso_3166_1?: string; rating?: string }[] } };
export type SeerrUser = { id: number; displayName?: string; permissions: number };
export type SeerrPublic = { initialized: boolean; applicationTitle?: string; region?: string; movie4kEnabled?: boolean; series4kEnabled?: boolean; partialRequestsEnabled?: boolean };

// Seerr permission bits (server/lib/permissions.ts). Administrators may do everything.
const ADMIN = 2, MANAGE_USERS = 8, MANAGE_REQUESTS = 16, REQUEST = 32, AUTO_APPROVE = 128, AUTO_APPROVE_MOVIE = 256, AUTO_APPROVE_TV = 512, REQUEST_4K = 1024, REQUEST_4K_MOVIE = 2048, REQUEST_4K_TV = 4096,
  REQUEST_ADVANCED = 8192, AUTO_APPROVE_4K = 32768, AUTO_APPROVE_4K_MOVIE = 65536, AUTO_APPROVE_4K_TV = 131072, REQUEST_MOVIE = 262144, REQUEST_TV = 524288;
const has = (permissions: number, ...any: number[]) => (permissions & ADMIN) !== 0 || any.some(bit => (permissions & bit) !== 0);
export const seerrCan = (user: SeerrUser, settings?: SeerrPublic): Omit<ExploreSeerrAccount, 'user'> => ({
  canRequest: { movie: has(user.permissions, REQUEST, REQUEST_MOVIE), show: has(user.permissions, REQUEST, REQUEST_TV) },
  fourK: { movie: !!settings?.movie4kEnabled && has(user.permissions, REQUEST_4K, REQUEST_4K_MOVIE), show: !!settings?.series4kEnabled && has(user.permissions, REQUEST_4K, REQUEST_4K_TV) },
  // Request managers' own requests are approved as they are made.
  autoApprove: { movie: has(user.permissions, MANAGE_REQUESTS, AUTO_APPROVE, AUTO_APPROVE_MOVIE), show: has(user.permissions, MANAGE_REQUESTS, AUTO_APPROVE, AUTO_APPROVE_TV),
    movie4k: has(user.permissions, MANAGE_REQUESTS, AUTO_APPROVE_4K, AUTO_APPROVE_4K_MOVIE), show4k: has(user.permissions, MANAGE_REQUESTS, AUTO_APPROVE_4K, AUTO_APPROVE_4K_TV) },
  advanced: has(user.permissions, MANAGE_REQUESTS, REQUEST_ADVANCED), requestAs: has(user.permissions, MANAGE_USERS)
});

// MediaInfo.status: 2 pending (approved, waiting on the downloader), 3 processing, 4 partly available, 5 available.
// Pending and processing both read as Requested: the title is on its way. 6 and 7 differ between Overseerr and
// Jellyseerr (deleted, blocklisted) and get no badge. Request.status 1 is pending approval and 2 approved; both
// count as requested until the media status moves on.
const active = (r: { status?: number }) => r.status === 1 || r.status === 2;
const fromCode = (status: number | undefined, requested = false): ExploreStatus | undefined =>
  status === 5 ? 'available' : status === 4 ? 'partial' : status === 2 || status === 3 || requested ? 'requested' : undefined;
export function seerrStatus(info: Info | undefined, is4k = false): ExploreStatus | undefined {
  if (!info) return undefined;
  return fromCode(is4k ? info.status4k : info.status, !!info.requests?.some(r => !!r.is4k === is4k && active(r)));
}
// Each regular season with its availability or open request. Specials are left out, as Seerr leaves them out of requests.
export function seerrSeasons(details: Details, is4k = false): ExploreSeason[] {
  return (details.seasons ?? []).filter(s => s.seasonNumber > 0).map(s => {
    const known = details.mediaInfo?.seasons?.find(m => m.seasonNumber === s.seasonNumber);
    const requested = !!details.mediaInfo?.requests?.some(r => !!r.is4k === is4k && active(r) && (r.seasons ?? []).some(rs => rs.seasonNumber === s.seasonNumber));
    const value = fromCode(is4k ? known?.status4k : known?.status, requested);
    return { number: s.seasonNumber, name: s.name || `Season ${s.seasonNumber}`, ...(s.episodeCount ? { episodeCount: s.episodeCount } : {}), ...(s.airDate ? { airDate: s.airDate } : {}), ...(value ? { status: value } : {}) };
  });
}
const year = (date?: string) => date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
export function seerrItem(m: Media, type?: 'movie' | 'tv'): ExploreItem | undefined {
  const mediaType = m.mediaType ?? type, title = m.title || m.name || m.originalTitle || m.originalName;
  if ((mediaType !== 'movie' && mediaType !== 'tv') || !title || !Number.isInteger(m.id)) return undefined;
  const kind = mediaType === 'tv' ? 'show' : 'movie', released = year(m.releaseDate || m.firstAirDate), status = seerrStatus(m.mediaInfo);
  return { key: `${kind}:tmdb:${m.id}`, source: 'seerr', kind, title, ...(released ? { year: released } : {}), ...(m.overview ? { summary: m.overview } : {}),
    posterUrl: tmdbImage(m.posterPath, 'w342'), backdropUrl: tmdbImage(m.backdropPath, 'w1280'), ...(m.voteAverage ? { rating: m.voteAverage } : {}),
    ...(m.originalLanguage ? { language: m.originalLanguage } : {}), ids: { tmdb: m.id, ...(m.mediaInfo?.tvdbId ? { tvdb: m.mediaInfo.tvdbId } : {}) }, ...(status ? { status } : {}) };
}
type Tracked = { mediaType?: string; tmdbId?: number; status?: number; status4k?: number };
// Seerr's media list as a status for each title, keyed like Explore items (`movie:tmdb:603`). A title with no standard
// copy shows its 4K state.
export function statusIndex(media: Tracked[]) {
  const index = new Map<string, ExploreStatus>();
  for (const m of media) {
    const status = fromCode(m.status) ?? fromCode(m.status4k);
    if (status && m.tmdbId && (m.mediaType === 'movie' || m.mediaType === 'tv')) index.set(`${m.mediaType === 'tv' ? 'show' : 'movie'}:tmdb:${m.tmdbId}`, status);
  }
  return index;
}

export const seerrRows = [
  { id: 'trending', title: 'Trending', icon: 'trending', path: '/discover/trending' },
  { id: 'popular-movies', title: 'Popular Movies', icon: 'movies', path: '/discover/movies', type: 'movie' },
  { id: 'popular-shows', title: 'Popular Shows', icon: 'shows', path: '/discover/tv', type: 'tv' },
  { id: 'upcoming-movies', title: 'Upcoming Movies', icon: 'calendar', path: '/discover/movies/upcoming', type: 'movie' },
  { id: 'upcoming-shows', title: 'Upcoming Shows', icon: 'calendar', path: '/discover/tv/upcoming', type: 'tv' }
] as const;

type Session = { cookie: string; user: SeerrUser };
export type SeerrConnection = { url: string; apiKey?: string };
// With the administrator's API key, browsing (rows, search, details, statuses) reads Seerr as the server and nobody
// signs in. A viewer is signed in to Seerr only to request, so the request is theirs. Without a key, every read
// signs the viewer in as well.
export class Seerr {
  private sessions = new Map<string, Session>();
  private signing = new Map<string, Promise<Session>>();
  private settings = new Map<string, { value: SeerrPublic; until: number }>();
  private index?: { key: string; until: number; value: Promise<Map<string, ExploreStatus>> };
  constructor(private connection: () => SeerrConnection | undefined, private transport: typeof fetch = fetch) {}
  configured() { return !!this.connection(); }
  // Statuses on Plex and Trakt titles need the media list, which only the API key may read.
  hasKey() { return !!this.connection()?.apiKey; }
  private url(base: string, path: string, query: Record<string, string | number> = {}) {
    const url = new URL(`${base}/api/v1${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url;
  }
  private current() { const connection = this.connection(); requireThat(connection, 'SEERR_NOT_CONFIGURED', 'Seerr is not set up. An administrator can add it in Admin › Connections.', 409); return connection; }
  // Unauthenticated: proves the address is an initialized Seerr. Cached briefly, since every row reads it.
  async publicSettings(base = this.current().url, fresh = false, now = Date.now()) {
    const cached = this.settings.get(base); if (cached && cached.until > now && !fresh) return cached.value;
    const response = await remoteJson(this.url(base, '/settings/public'), {}, 'Seerr', this.transport, 8000);
    const data = response.data as SeerrPublic | undefined;
    requireThat(response.status === 200 && data && typeof data.initialized === 'boolean', 'SEERR_UNAVAILABLE', 'No Seerr answered at that address.', 502);
    requireThat(data.initialized, 'SEERR_UNAVAILABLE', 'Seerr has not finished its first-run setup.', 502);
    this.settings.set(base, { value: data, until: now + 600000 });
    return data;
  }
  // Settings check: the key opens Seerr's API.
  async checkKey(base: string, apiKey: string) {
    const response = await remoteJson(this.url(base, '/auth/me'), { headers: { 'X-Api-Key': apiKey } }, 'Seerr', this.transport, 8000);
    requireThat(response.status === 200, 'SEERR_KEY_REJECTED', 'Seerr did not accept that API key.', 400);
  }
  private async signIn(base: string, plexToken: string): Promise<Session> {
    const response = await remoteJson(this.url(base, '/auth/plex'), { method: 'POST', body: { authToken: plexToken } }, 'Seerr', this.transport, 20000);
    if (response.status === 401 || response.status === 403) throw new AppError('SEERR_ACCESS_DENIED', remoteMessage(response.data) ?? 'Seerr did not let this Plex account sign in. Ask the administrator to import you in Seerr or allow new Plex sign-ins.', 403);
    requireThat(response.status === 200, 'SEERR_UNAVAILABLE', remoteMessage(response.data) ?? 'Seerr sign-in failed.', 502);
    const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]!).find(c => c.startsWith('connect.sid='));
    requireThat(cookie, 'SEERR_UNAVAILABLE', 'Seerr did not start a session.', 502);
    // The login body can be a partial user; /auth/me has the stored permissions.
    const me = await remoteJson(this.url(base, '/auth/me'), { headers: { Cookie: cookie } }, 'Seerr', this.transport);
    const user = me.data as SeerrUser | undefined;
    requireThat(me.status === 200 && user && Number.isInteger(user.id), 'SEERR_UNAVAILABLE', 'Seerr did not return your account.', 502);
    return { cookie, user: { id: user.id, displayName: user.displayName, permissions: Number(user.permissions) || 0 } };
  }
  private session(base: string, accountId: string, plexToken: string, fresh = false) {
    const key = `${base}\n${accountId}`, current = this.sessions.get(key);
    if (current && !fresh) return Promise.resolve(current);
    let pending = this.signing.get(key);
    if (!pending) {
      pending = this.signIn(base, plexToken).then(s => { this.sessions.set(key, s); return s; }).finally(() => this.signing.delete(key));
      this.signing.set(key, pending);
    }
    return pending;
  }
  // The viewer's Seerr account and what it may request, signing them in if they are not yet.
  async account(accountId: string, plexToken: string) {
    const base = this.current().url, [session, settings] = await Promise.all([this.session(base, accountId, plexToken), this.publicSettings(base)]);
    return { ...(session.user.displayName ? { user: session.user.displayName } : {}), ...seerrCan(session.user, settings) };
  }
  private check(response: { status: number; data: unknown }) {
    if (response.status === 409) throw new AppError('SEERR_CONFLICT', remoteMessage(response.data) ?? 'This title has already been requested.', 409);
    if (response.status === 404) throw new AppError('NOT_FOUND', 'Seerr does not know this title.', 404);
    requireThat(response.status >= 200 && response.status < 300, 'SEERR_UNAVAILABLE', remoteMessage(response.data) ?? 'Seerr could not complete the request.', 502);
    return response.data;
  }
  // As the viewer. An expired Seerr session is renewed with the Plex token and the request is sent once more.
  async call(accountId: string, plexToken: string, method: string, path: string, query: Record<string, string | number> = {}, body?: unknown) {
    const base = this.current().url;
    for (let attempt = 0; ; attempt++) {
      const session = await this.session(base, accountId, plexToken, attempt > 0);
      const response = await remoteJson(this.url(base, path, query), { method, headers: { Cookie: session.cookie }, ...(body !== undefined ? { body } : {}) }, 'Seerr', this.transport);
      if ((response.status === 401 || response.status === 403) && attempt === 0) continue;
      if (response.status === 401 || response.status === 403) throw new AppError('SEERR_FORBIDDEN', remoteMessage(response.data) ?? 'Your Seerr account is not allowed to do that.', 403);
      return this.check(response);
    }
  }
  // A read for browsing: with the API key when there is one, else as the viewer.
  private async read(accountId: string, plexToken: string, path: string, query: Record<string, string | number> = {}) {
    const { url, apiKey } = this.current();
    if (!apiKey) return this.call(accountId, plexToken, 'GET', path, query);
    const response = await remoteJson(this.url(url, path, query), { headers: { 'X-Api-Key': apiKey } }, 'Seerr', this.transport);
    if (response.status === 401 || response.status === 403) throw new AppError('SEERR_KEY_REJECTED', 'Seerr no longer accepts the API key. An administrator can update it in Admin › Connections.', 502);
    return this.check(response);
  }
  // Every title Seerr tracks, read in pages with the API key and kept for a few minutes. Undefined without a key.
  statuses(now = Date.now()): Promise<Map<string, ExploreStatus> | undefined> {
    const connection = this.connection(), apiKey = connection?.apiKey;
    if (!connection || !apiKey) return Promise.resolve(undefined);
    const key = `${connection.url}\n${apiKey}`;
    if (this.index?.key === key && this.index.until > now) return this.index.value;
    const value = (async () => {
      const media: Tracked[] = [];
      for (let page = 0; page < 50; page++) {
        const response = await remoteJson(this.url(connection.url, '/media', { take: 100, skip: page * 100, filter: 'all', sort: 'added' }), { headers: { 'X-Api-Key': apiKey } }, 'Seerr', this.transport);
        requireThat(response.status === 200, 'SEERR_UNAVAILABLE', 'Seerr could not list its media.', 502);
        const data = response.data as { results?: Tracked[]; pageInfo?: { pages?: number } } | undefined;
        media.push(...(data?.results ?? []));
        if (!data?.results?.length || page + 1 >= (data.pageInfo?.pages ?? 0)) break;
      }
      return statusIndex(media);
    })();
    this.index = { key, until: now + 300000, value };
    // A failed read is not kept.
    value.catch(() => { if (this.index?.value === value) this.index = undefined; });
    return value;
  }
  async row(accountId: string, plexToken: string, id: string, page: number): Promise<ExplorePage> {
    const row = seerrRows.find(r => r.id === id); requireThat(row, 'NOT_FOUND', 'Unknown row.', 404);
    return this.page(await this.read(accountId, plexToken, row.path, { page }), page, 'type' in row ? row.type : undefined);
  }
  async search(accountId: string, plexToken: string, query: string) {
    return this.page(await this.read(accountId, plexToken, '/search', { query, page: 1 }), 1).items;
  }
  private page(data: unknown, page: number, type?: 'movie' | 'tv'): ExplorePage {
    const value = (data ?? {}) as { results?: Media[]; totalPages?: number; totalResults?: number };
    const items = (value.results ?? []).flatMap(m => seerrItem(m, type) ?? []);
    return { items, page, hasMore: page < (value.totalPages ?? 0), ...(value.totalResults !== undefined ? { total: value.totalResults } : {}) };
  }
  async details(accountId: string, plexToken: string, kind: 'movie' | 'show', tmdb: number) {
    return await this.read(accountId, plexToken, `/${kind === 'show' ? 'tv' : 'movie'}/${tmdb}`) as Details;
  }
  async ratings(accountId: string, plexToken: string, kind: 'movie' | 'show', tmdb: number) {
    return seerrRatings(await this.read(accountId, plexToken, kind === 'movie' ? `/movie/${tmdb}/ratingscombined` : `/tv/${tmdb}/ratings`).catch(() => undefined), kind);
  }
  // A cast or crew member's IMDb id (nm…). The title's credits name the right person when its TMDB id is known;
  // otherwise TMDB's most relevant person with exactly that name.
  async imdbPerson(accountId: string, plexToken: string, name: string, title?: { kind: 'movie' | 'show'; tmdb: number }) {
    const credits = title ? await this.details(accountId, plexToken, title.kind, title.tmdb).then(d => [...d.credits?.cast ?? [], ...d.credits?.crew ?? []], () => []) : [];
    let id = matchPerson(name, credits);
    if (id === undefined) {
      const found = (await this.read(accountId, plexToken, '/search', { query: name, page: 1 }) ?? {}) as { results?: { id?: number; name?: string; mediaType?: string }[] };
      id = matchPerson(name, (found.results ?? []).filter(r => r.mediaType === 'person'));
    }
    if (id === undefined) return undefined;
    const person = (await this.read(accountId, plexToken, `/person/${id}`) ?? {}) as { imdbId?: string | null };
    return person.imdbId && /^nm\d{1,12}$/.test(person.imdbId) ? person.imdbId : undefined;
  }
  // The Radarr (movies) or Sonarr (shows) servers for that quality and one server's profiles, folders and tags, as the viewer.
  async options(accountId: string, plexToken: string, kind: 'movie' | 'show', is4k: boolean, serverId?: number): Promise<ExploreSeerrOptions> {
    const service = kind === 'movie' ? 'radarr' : 'sonarr';
    const list = ((await this.call(accountId, plexToken, 'GET', `/service/${service}`) ?? []) as { id: number; name: string; is4k?: boolean; isDefault?: boolean }[]).filter(s => !!s.is4k === is4k);
    const server = list.find(s => s.id === serverId) ?? list.find(s => s.isDefault) ?? list[0];
    const empty = { servers: list.map(({ id, name }) => ({ id, name })), profiles: [], rootFolders: [], languageProfiles: [], tags: [], defaultTags: [] };
    if (!server) return empty;
    const detail = (await this.call(accountId, plexToken, 'GET', `/service/${service}/${server.id}`) ?? {}) as { server?: { activeProfileId?: number; activeDirectory?: string; activeLanguageProfileId?: number; activeTags?: number[] };
      profiles?: { id: number; name: string }[]; rootFolders?: { path: string; freeSpace?: number }[]; languageProfiles?: { id: number; name: string }[] | null; tags?: { id: number; label: string }[] };
    const active = detail.server ?? {};
    return { ...empty, serverId: server.id, profiles: (detail.profiles ?? []).map(({ id, name }) => ({ id, name })), ...(active.activeProfileId !== undefined ? { profileId: active.activeProfileId } : {}),
      rootFolders: (detail.rootFolders ?? []).map(({ path, freeSpace }) => ({ path, ...(freeSpace !== undefined ? { freeSpace } : {}) })), ...(active.activeDirectory ? { rootFolder: active.activeDirectory } : {}),
      languageProfiles: (detail.languageProfiles ?? []).map(({ id, name }) => ({ id, name })), ...(active.activeLanguageProfileId !== undefined ? { languageProfileId: active.activeLanguageProfileId } : {}),
      tags: (detail.tags ?? []).map(({ id, label }) => ({ id, label })), defaultTags: active.activeTags ?? [] };
  }
  // Seerr's users, for requesting on someone's behalf. Seerr lists them only to those who manage users.
  async users(accountId: string, plexToken: string): Promise<ExploreSeerrUser[]> {
    const data = (await this.call(accountId, plexToken, 'GET', '/user', { take: 500, skip: 0, sort: 'displayname' }) ?? {}) as { results?: { id: number; displayName?: string; email?: string }[] };
    return (data.results ?? []).map(u => ({ id: u.id, name: u.displayName || u.email || `User ${u.id}`, ...(u.email ? { email: u.email } : {}) }));
  }
  async request(accountId: string, plexToken: string, kind: 'movie' | 'show', tmdb: number, seasons: number[] | undefined, is4k: boolean, extras: ExploreRequestExtras = {}) {
    await this.call(accountId, plexToken, 'POST', '/request', {}, { mediaType: kind === 'show' ? 'tv' : 'movie', mediaId: tmdb, is4k, ...(kind === 'show' ? { seasons: seasons?.length ? seasons : 'all' } : {}), ...extras });
    this.index = undefined;
  }
}
export type SeerrDetails = Details;
// Names compared without case, accents or punctuation, so Plex's "Penélope Cruz" finds TMDB's "Penelope Cruz".
const personKey = (name: string) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// The first candidate with that name, in the order given.
export function matchPerson(name: string, candidates: { id?: number; name?: string }[]) {
  const key = personKey(name);
  return key ? candidates.find(c => Number.isInteger(c.id) && c.name && personKey(c.name) === key)?.id : undefined;
}
const date = (value?: string | null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
// The facts Seerr shows beside a title. Streaming services are those for Seerr's discover region (US when unset).
export function seerrFacts(details: Details, kind: 'movie' | 'show', region = 'US'): Partial<ExploreDetails> {
  const countries = details.productionCountries?.length ? details.productionCountries.flatMap(c => c.name ? [{ ...(c.iso_3166_1 ? { code: c.iso_3166_1 } : {}), name: c.name, flagUrl: flagImage(c.iso_3166_1) }] : [])
    : (details.originCountry ?? []).map(code => ({ code, name: code, flagUrl: flagImage(code) }));
  // TMDB lists a service again for each store that resells it (AMC+ Amazon Channel, AMC+ Roku Premium Channel…); those are dropped.
  const providers = (details.watchProviders?.find(p => p.iso_3166_1 === region)?.flatrate ?? []).filter(p => !/\bchannel\b/i.test(p.name ?? ''))
    .flatMap(p => p.name ? [{ name: p.name, logoUrl: tmdbImage(p.logoPath, 'w92') }] : []).slice(0, 8);
  const released = date(kind === 'movie' ? details.releaseDate : details.firstAirDate);
  return { ...(details.status ? { status: details.status } : {}), ...(released ? { released } : {}), ...(details.originalLanguage ? { language: details.originalLanguage } : {}),
    countries: countries.map(({ flagUrl, ...c }) => flagUrl ? { ...c, flagUrl } : c), studios: kind === 'movie' ? (details.productionCompanies ?? []).flatMap(c => c.name ? [c.name] : []).slice(0, 3) : [], providers };
}
type RottenTomatoes = { criticsScore?: number; criticsRating?: string; audienceScore?: number; audienceRating?: string; url?: string };
// Rotten Tomatoes (and for movies IMDb) scores, on Plex's 0–10 scale like the library's, with the Rotten Tomatoes page.
export function seerrRatings(data: unknown, kind: 'movie' | 'show') {
  const value = (data ?? {}) as { rt?: RottenTomatoes; imdb?: { criticsScore?: number } } & RottenTomatoes, rt = kind === 'movie' ? value.rt : value;
  const ratings: ExternalRating[] = [];
  const score = (n?: number) => typeof n === 'number' && n > 0 && n <= 100;
  if (kind === 'movie' && typeof value.imdb?.criticsScore === 'number' && value.imdb.criticsScore > 0 && value.imdb.criticsScore <= 10) ratings.push({ source: 'imdb', score: value.imdb.criticsScore });
  if (score(rt?.criticsScore)) ratings.push({ source: 'tomatometer', score: rt!.criticsScore! / 10, fresh: rt!.criticsRating !== 'Rotten' });
  if (score(rt?.audienceScore)) ratings.push({ source: 'popcornmeter', score: rt!.audienceScore! / 10, fresh: rt!.audienceRating !== 'Spilled' });
  return { ratings, ...(rt?.url && /^https:\/\/www\.rottentomatoes\.com\//.test(rt.url) ? { url: rt.url } : {}) };
}
// Details fields the Explore dialog shows: the US certificate when there is one, else the first.
export function seerrCertificate(details: Details, kind: 'movie' | 'show') {
  if (kind === 'movie') {
    const results = details.releases?.results ?? [], pick = (r: (typeof results)[number]) => r.release_dates?.find(d => d.certification)?.certification;
    const us = results.find(r => r.iso_3166_1 === 'US');
    return (us && pick(us)) ?? results.map(pick).find(Boolean);
  }
  const results = details.contentRatings?.results ?? [];
  return results.find(r => r.iso_3166_1 === 'US')?.rating ?? results.find(r => r.rating)?.rating;
}
