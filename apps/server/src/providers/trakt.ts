import type { ExploreItem, ExplorePage } from '../../../../packages/contracts/src/index.js';
import type { ExploreStore, TraktTokens } from '../persistence/explore-store.js';
import { AppError, requireThat } from '../errors.js';
import { remoteJson, remoteMessage } from './remote-json.js';
import { imagePath } from './explore-images.js';

// Trakt: public trending and popular lists need only the administrator's Trakt app; a viewer's watchlist and
// recommendations need that viewer to link their Trakt account (device code sign-in).
type Ids = { trakt?: number; slug?: string; imdb?: string; tmdb?: number; tvdb?: number };
type Media = { title?: string; year?: number; ids?: Ids; overview?: string; runtime?: number; rating?: number; aired_episodes?: number; language?: string;
  images?: { poster?: string[]; fanart?: string[] } };
type Entry = { type?: string; movie?: Media; show?: Media };
const API = 'https://api.trakt.tv', OOB = 'urn:ietf:wg:oauth:2.0:oob', LIMIT = 20;
const image = (list?: string[]) => list?.[0] ? imagePath(/^https?:\/\//.test(list[0]) ? list[0] : `https://${list[0]}`) : undefined;
export function traktItem(media: Media | undefined, kind: 'movie' | 'show'): ExploreItem | undefined {
  const ids = media?.ids;
  if (!media?.title || !ids || (!ids.tmdb && !ids.imdb && !ids.trakt)) return undefined;
  return { key: ids.tmdb ? `${kind}:tmdb:${ids.tmdb}` : `${kind}:trakt:${ids.trakt ?? ids.imdb}`, source: 'trakt', kind, title: media.title,
    ...(media.year ? { year: media.year } : {}), ...(media.overview ? { summary: media.overview } : {}),
    posterUrl: image(media.images?.poster), backdropUrl: image(media.images?.fanart), ...(media.rating ? { rating: media.rating } : {}),
    ...(media.runtime ? { durationMs: media.runtime * 60000 } : {}), ...(kind === 'show' && media.aired_episodes ? { episodeCount: media.aired_episodes } : {}),
    ...(media.language ? { language: media.language } : {}),
    ids: { ...(ids.tmdb ? { tmdb: ids.tmdb } : {}), ...(ids.imdb ? { imdb: ids.imdb } : {}), ...(ids.tvdb ? { tvdb: ids.tvdb } : {}), ...(ids.trakt ? { trakt: ids.trakt } : {}) } };
}
// Lists of `{movie}`/`{show}` wrappers (trending, watchlist, search) or bare media (popular, recommendations).
export function traktItems(data: unknown, fixed?: 'movie' | 'show') {
  return (Array.isArray(data) ? data as (Entry & Media)[] : []).flatMap(entry => {
    // Watchlisted seasons and episodes also carry their show; only whole titles are listed.
    if (entry.type && entry.type !== 'movie' && entry.type !== 'show') return [];
    if (entry.movie) return traktItem(entry.movie, 'movie') ?? [];
    if (entry.show) return traktItem(entry.show, 'show') ?? [];
    return fixed ? traktItem(entry, fixed) ?? [] : [];
  });
}

export const traktRows = [
  { id: 'watchlist', title: 'Trakt Watchlist', icon: 'star', path: '/sync/watchlist', personal: true },
  { id: 'recommended-movies', title: 'Recommended Movies', icon: 'movies', path: '/recommendations/movies', kind: 'movie', personal: true, single: true },
  { id: 'recommended-shows', title: 'Recommended Shows', icon: 'shows', path: '/recommendations/shows', kind: 'show', personal: true, single: true },
  { id: 'trending-movies', title: 'Trending Movies', icon: 'trending', path: '/movies/trending', kind: 'movie' },
  { id: 'trending-shows', title: 'Trending Shows', icon: 'trending', path: '/shows/trending', kind: 'show' },
  { id: 'popular-movies', title: 'Popular Movies', icon: 'movies', path: '/movies/popular', kind: 'movie' },
  { id: 'popular-shows', title: 'Popular Shows', icon: 'shows', path: '/shows/popular', kind: 'show' }
] as const;

type Pending = { deviceCode: string; expires: number; interval: number; lastPoll: number };
export class Trakt {
  private devices = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<TraktTokens>>();
  constructor(private store: ExploreStore, private transport: typeof fetch = fetch) {}
  configured() { return !!this.store.trakt(); }
  private app() { const app = this.store.trakt(); requireThat(app, 'TRAKT_NOT_CONFIGURED', 'Trakt is not set up. An administrator can add it in Admin › Connections.', 409); return app; }
  private async send(path: string, query: Record<string, string | number>, access?: string, method = 'GET', body?: unknown) {
    const url = new URL(path, API); for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return remoteJson(url, { method, headers: { 'trakt-api-version': '2', 'trakt-api-key': this.app().clientId, ...(access ? { Authorization: `Bearer ${access}` } : {}) }, ...(body !== undefined ? { body } : {}) }, 'Trakt', this.transport);
  }
  // A current access token for the viewer, refreshed shortly before it expires. Undefined when they have not linked Trakt.
  private async access(accountId: string, now = Date.now()) {
    const link = this.store.traktLink(accountId); if (!link) return undefined;
    if (link.tokens.expires - now > 86400000) return link.tokens.access;
    let pending = this.refreshing.get(accountId);
    if (!pending) {
      pending = (async () => {
        const app = this.app(), response = await remoteJson(new URL('/oauth/token', API), { method: 'POST', body: { refresh_token: link.tokens.refresh, client_id: app.clientId, client_secret: app.secret, redirect_uri: OOB, grant_type: 'refresh_token' } }, 'Trakt', this.transport);
        if (response.status === 400 || response.status === 401) { this.store.removeTraktLink(accountId); throw new AppError('TRAKT_UNLINKED', 'Your Trakt link expired. Connect Trakt again in Settings › Explore.', 409); }
        const tokens = this.tokens(response.data); requireThat(response.status === 200 && tokens, 'TRAKT_UNAVAILABLE', 'Trakt could not renew your sign-in.', 502);
        this.store.saveTraktLink(accountId, tokens); return tokens;
      })().finally(() => this.refreshing.delete(accountId));
      this.refreshing.set(accountId, pending);
    }
    return (await pending).access;
  }
  private tokens(data: unknown, now = Date.now()): TraktTokens | undefined {
    const value = data as { access_token?: string; refresh_token?: string; expires_in?: number; created_at?: number } | undefined;
    if (!value?.access_token || !value.refresh_token) return undefined;
    return { access: value.access_token, refresh: value.refresh_token, expires: (value.created_at ? value.created_at * 1000 : now) + (value.expires_in ?? 86400) * 1000 };
  }
  // The linked Trakt user's name, or undefined when this viewer has not linked Trakt.
  linked(accountId: string) { if (!this.configured()) return undefined; const link = this.store.traktLink(accountId); return link && (link.username ?? 'Trakt'); }
  rows(accountId: string) { const linked = !!this.store.traktLink(accountId); return traktRows.filter(r => linked || !('personal' in r)); }
  async row(accountId: string, id: string, page: number): Promise<ExplorePage> {
    const row = traktRows.find(r => r.id === id); requireThat(row, 'NOT_FOUND', 'Unknown row.', 404);
    const access = 'personal' in row ? await this.access(accountId) : undefined;
    requireThat(!('personal' in row) || access, 'TRAKT_UNLINKED', 'Connect Trakt in Settings › Explore to see this row.', 409);
    // Recommendations come as one list of up to 100, not in pages.
    const single = 'single' in row;
    if (single && page > 1) return { items: [], page, hasMore: false };
    const response = await this.send(row.path, single ? { limit: 60, extended: 'full,images', ignore_collected: 'true' } : { page, limit: LIMIT, extended: 'full,images' }, access);
    this.forbidden(response.status);
    if (response.status === 401) { this.store.removeTraktLink(accountId); throw new AppError('TRAKT_UNLINKED', 'Your Trakt link expired. Connect Trakt again in Settings › Explore.', 409); }
    requireThat(response.status === 200, 'TRAKT_UNAVAILABLE', remoteMessage(response.data) ?? 'Trakt could not load this row.', 502);
    const pages = Number(response.headers.get('x-pagination-page-count')), total = Number(response.headers.get('x-pagination-item-count'));
    const items = traktItems(response.data, 'kind' in row ? row.kind : undefined);
    return { items, page, hasMore: !single && Number.isFinite(pages) && page < pages, ...(single ? { total: items.length } : Number.isFinite(total) && total > 0 ? { total } : {}) };
  }
  async search(query: string) {
    const response = await this.send('/search/movie,show', { query, limit: 30, extended: 'full,images' });
    this.forbidden(response.status);
    requireThat(response.status === 200, 'TRAKT_UNAVAILABLE', remoteMessage(response.data) ?? 'Trakt search failed.', 502);
    return traktItems(response.data);
  }
  // Trakt answers 403 to a client ID it does not know or an app it has not approved.
  private forbidden(status: number) {
    if (status === 403) throw new AppError('TRAKT_APP_REJECTED', 'Trakt did not accept this server’s Trakt app. An administrator can check the client ID in Admin › Connections.', 502);
  }
  // Device code sign-in: the viewer enters the code at Trakt's address while the page polls.
  async startLink(accountId: string, now = Date.now()) {
    const response = await remoteJson(new URL('/oauth/device/code', API), { method: 'POST', body: { client_id: this.app().clientId } }, 'Trakt', this.transport);
    const value = response.data as { device_code?: string; user_code?: string; verification_url?: string; expires_in?: number; interval?: number } | undefined;
    requireThat(response.status === 200 && value?.device_code && value.user_code, 'TRAKT_UNAVAILABLE', remoteMessage(response.data) ?? 'Trakt could not start sign-in. Check the Trakt app settings.', 502);
    this.devices.set(accountId, { deviceCode: value.device_code, expires: now + (value.expires_in ?? 600) * 1000, interval: (value.interval ?? 5) * 1000, lastPoll: 0 });
    return { userCode: value.user_code, verificationUrl: value.verification_url ?? 'https://trakt.tv/activate', interval: value.interval ?? 5, expiresIn: value.expires_in ?? 600 };
  }
  async pollLink(accountId: string, now = Date.now()): Promise<{ status: 'pending' | 'linked' | 'expired' | 'denied'; user?: string }> {
    const pending = this.devices.get(accountId);
    if (!pending || pending.expires <= now) { this.devices.delete(accountId); return { status: 'expired' }; }
    if (now - pending.lastPoll < pending.interval) return { status: 'pending' };
    pending.lastPoll = now;
    const app = this.app(), response = await remoteJson(new URL('/oauth/device/token', API), { method: 'POST', body: { code: pending.deviceCode, client_id: app.clientId, client_secret: app.secret } }, 'Trakt', this.transport);
    if (response.status === 400) return { status: 'pending' };
    if (response.status === 429) { pending.interval += 1000; return { status: 'pending' }; }
    if (response.status === 418) { this.devices.delete(accountId); return { status: 'denied' }; }
    if (response.status !== 200) { this.devices.delete(accountId); return { status: 'expired' }; }
    const tokens = this.tokens(response.data); requireThat(tokens, 'TRAKT_UNAVAILABLE', 'Trakt did not return a sign-in.', 502);
    this.devices.delete(accountId);
    const settings = await remoteJson(new URL('/users/settings', API), { headers: { 'trakt-api-version': '2', 'trakt-api-key': app.clientId, Authorization: `Bearer ${tokens.access}` } }, 'Trakt', this.transport).catch(() => undefined);
    const user = (settings?.data as { user?: { username?: string; name?: string } } | undefined)?.user, name = user?.name || user?.username;
    this.store.saveTraktLink(accountId, tokens, name ?? undefined);
    return { status: 'linked', ...(name ? { user: name } : {}) };
  }
  async unlink(accountId: string) {
    const link = this.store.traktLink(accountId), app = this.store.trakt();
    this.store.removeTraktLink(accountId); this.devices.delete(accountId);
    if (link && app) await remoteJson(new URL('/oauth/revoke', API), { method: 'POST', body: { token: link.tokens.access, client_id: app.clientId, client_secret: app.secret } }, 'Trakt', this.transport).catch(() => undefined);
  }
}
