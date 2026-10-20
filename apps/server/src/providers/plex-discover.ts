import type { ExploreItem, ExplorePage, ExploreRowInfo } from '../../../../packages/contracts/src/index.js';
import type { PlexAdapter } from './plex.js';
import { requireThat } from '../errors.js';
import { plexPhoto } from './explore-images.js';

// Plex Discover: the viewer's universal watchlist and the shelves Plex shows on its own Discover page.
type Tag = { tag?: string };
export type DiscoverMetadata = { ratingKey?: string; guid?: string; type?: string; title?: string; year?: number; summary?: string; thumb?: string; art?: string;
  duration?: number; rating?: number; audienceRating?: number; leafCount?: number; tagline?: string; studio?: string; contentRating?: string;
  Guid?: { id?: string }[]; Genre?: Tag[]; Role?: Tag[]; originallyAvailableAt?: string;
  Rating?: { image: string; value: number; type?: string }[]; ratingImage?: string; audienceRatingImage?: string };
type Container = { MediaContainer?: { Metadata?: DiscoverMetadata[]; Hub?: { key?: string; hubKey?: string; title?: string; type?: string; Metadata?: DiscoverMetadata[] }[]; totalSize?: number; size?: number;
  SearchResults?: { SearchResult?: { Metadata?: DiscoverMetadata | DiscoverMetadata[] }[] }[]; UserState?: { watchlistedAt?: number } | { watchlistedAt?: number }[] } };
const container = (data: unknown) => (data as Container | undefined)?.MediaContainer ?? {};

// The external ids in a Discover title's guids.
export function discoverIds(m: DiscoverMetadata) {
  const ids: ExploreItem['ids'] = {};
  if (m.ratingKey) ids.plex = m.ratingKey;
  if (m.guid?.startsWith('plex://')) ids.plexGuid = m.guid;
  for (const guid of [m.guid, ...(m.Guid ?? []).map(g => g.id)]) {
    const [, provider, id] = /^(imdb|tmdb|tvdb):\/\/(.+)$/.exec(guid ?? '') ?? [];
    if (provider === 'imdb' && id && !ids.imdb) ids.imdb = id;
    else if (provider === 'tmdb' && id && /^\d+$/.test(id) && !ids.tmdb) ids.tmdb = Number(id);
    else if (provider === 'tvdb' && id && /^\d+$/.test(id) && !ids.tvdb) ids.tvdb = Number(id);
  }
  return ids;
}
export function discoverItem(m: DiscoverMetadata): ExploreItem | undefined {
  const kind = m.type === 'movie' ? 'movie' : m.type === 'show' ? 'show' : undefined;
  if (!kind || !m.title || !m.ratingKey) return undefined;
  const ids = discoverIds(m), rating = m.audienceRating ?? m.rating;
  return { key: ids.tmdb ? `${kind}:tmdb:${ids.tmdb}` : `${kind}:plex:${m.ratingKey}`, source: 'plex', kind, title: m.title,
    ...(m.year ? { year: m.year } : {}), ...(m.summary ? { summary: m.summary } : {}),
    posterUrl: plexPhoto(m.thumb, 300, 450), backdropUrl: plexPhoto(m.art, 1280, 720), ...(rating ? { rating } : {}),
    ...(m.duration ? { durationMs: m.duration } : {}), ...(kind === 'show' && m.leafCount ? { episodeCount: m.leafCount } : {}), ids };
}
const items = (list: DiscoverMetadata[] = []) => { const seen = new Set<string>(); return list.flatMap(m => { const item = discoverItem(m); if (!item || seen.has(item.key)) return []; seen.add(item.key); return [item]; }); };
// Shelf keys are Discover paths, carried in the row id.
const hubId = (key: string) => `hub.${Buffer.from(key).toString('base64url')}`;
const hubKey = (id: string) => { const key = Buffer.from(id.slice(4), 'base64url').toString('utf8'); requireThat(/^\/[^/]/.test(key) && key.length < 600, 'NOT_FOUND', 'Unknown row.', 404); return key; };
// Shelves of categories (genres, decades) and trailers hold nothing to open.
const unlisted = new Set(['directory', 'clip']);
const LIMIT = 20, HUB_LIMIT = 50;
// Discover shelves and search leave out a title's external ids, which Seerr's labels are matched on. One batched
// metadata read fills them in; ids are public catalog data, so they are kept for every viewer.
const knownIds = new Map<string, ExploreItem['ids']>();
const remember = (key: string, ids: ExploreItem['ids']) => { knownIds.delete(key); knownIds.set(key, ids); if (knownIds.size > 5000) knownIds.delete(knownIds.keys().next().value!); };

export class PlexDiscover {
  constructor(private plex: PlexAdapter) {}
  async rows(token: string): Promise<ExploreRowInfo[]> {
    const hubs = await this.plex.discover(token, '/hubs/sections/home', { includeMeta: 1 }).then(data => container(data).Hub ?? [], () => []);
    const seen = new Set<string>();
    return [{ id: 'watchlist', title: 'Watchlist', icon: 'star', personal: true }, ...hubs.flatMap(hub => {
      const key = hub.key ?? hub.hubKey;
      if (!key || !hub.title || unlisted.has(hub.type ?? '') || !/^\/[^/]/.test(key) || seen.has(key)) return [];
      seen.add(key); return [{ id: hubId(key), title: hub.title, icon: 'trending' }];
    })];
  }
  async row(token: string, id: string, page: number): Promise<ExplorePage> {
    if (id === 'watchlist') {
      const data = container(await this.plex.discover(token, '/library/sections/watchlist/all', { 'X-Plex-Container-Start': (page - 1) * LIMIT, 'X-Plex-Container-Size': LIMIT, includeGuids: 1, includeMeta: 1 }));
      const list = data.Metadata ?? [], total = data.totalSize ?? data.size;
      return { items: await this.withIds(token, items(list)), page, hasMore: total !== undefined ? (page - 1) * LIMIT + list.length < total : list.length === LIMIT, ...(total !== undefined ? { total } : {}) };
    }
    requireThat(id.startsWith('hub.'), 'NOT_FOUND', 'Unknown row.', 404);
    // Discover serves a shelf in one piece; it ignores offsets.
    if (page > 1) return { items: [], page, hasMore: false };
    const data = container(await this.plex.discover(token, hubKey(id), { limit: HUB_LIMIT, includeGuids: 1, includeMeta: 1, includeUserState: 1, excludeElements: 'Media,Image' }));
    const list = await this.withIds(token, items(data.Metadata?.length ? data.Metadata : data.Hub?.[0]?.Metadata));
    return { items: list, page, hasMore: false, total: data.totalSize && data.totalSize > list.length ? Math.min(data.totalSize, HUB_LIMIT) : list.length };
  }
  async search(token: string, query: string) {
    const data = container(await this.plex.discover(token, '/library/search', { query, limit: 30, searchTypes: 'movies,tv', searchProviders: 'discover', includeGuids: 1, includeMetadata: 1, filterPeople: 1 }));
    return this.withIds(token, items((data.SearchResults ?? []).flatMap(group => (group.SearchResult ?? []).flatMap(r => Array.isArray(r.Metadata) ? r.Metadata.slice(0, 1) : r.Metadata ? [r.Metadata] : []))));
  }
  private async withIds(token: string, list: ExploreItem[]) {
    const missing = [...new Set(list.filter(i => !i.ids.tmdb && i.ids.plex && !knownIds.has(i.ids.plex)).map(i => i.ids.plex!))].filter(k => /^[\w-]{1,64}$/.test(k));
    // Discover answers at most 20 titles per read.
    const chunks = Array.from({ length: Math.ceil(missing.length / 20) }, (_, i) => missing.slice(i * 20, i * 20 + 20));
    await Promise.all(chunks.map(async chunk => {
      const found = await this.plex.discover(token, `/library/metadata/${chunk.join(',')}`, { includeGuids: 1, excludeElements: 'Media,Image', 'X-Plex-Container-Size': chunk.length }).then(data => container(data).Metadata ?? [], () => undefined);
      if (!found) return;
      for (const m of found) if (m.ratingKey) remember(m.ratingKey, discoverIds(m));
      // Titles Discover could not resolve are not asked for again.
      for (const key of chunk) if (!knownIds.has(key)) remember(key, {});
    }));
    const seen = new Set<string>();
    return list.flatMap(item => {
      const ids = { ...(item.ids.plex ? knownIds.get(item.ids.plex) : {}), ...item.ids };
      const key = ids.tmdb ? `${item.kind}:tmdb:${ids.tmdb}` : item.key;
      if (seen.has(key)) return [];
      seen.add(key); return [{ ...item, key, ids }];
    });
  }
  async metadata(token: string, ratingKey: string) {
    requireThat(/^[\w-]{1,64}$/.test(ratingKey), 'INVALID_MEDIA', 'Invalid Discover identifier.');
    return container(await this.plex.discover(token, `/library/metadata/${ratingKey}`, { includeGuids: 1 })).Metadata?.[0];
  }
  // Discover's title for external ids. Discover answers a guid only together with the type (1 movie, 2 show).
  async match(token: string, kind: 'movie' | 'show', ids: ExploreItem['ids']) {
    const guid = ids.imdb ? `imdb://${ids.imdb}` : ids.tmdb ? `tmdb://${ids.tmdb}` : ids.tvdb ? `tvdb://${ids.tvdb}` : undefined;
    if (!guid) return undefined;
    return container(await this.plex.discover(token, '/library/metadata/matches', { type: kind === 'movie' ? 1 : 2, guid, includeGuids: 1 }).catch(() => undefined)).Metadata?.[0];
  }
  async watchlisted(token: string, ratingKey: string) {
    const state = container(await this.plex.discover(token, `/library/metadata/${ratingKey}/userState`).catch(() => undefined)).UserState;
    return !!(Array.isArray(state) ? state[0] : state)?.watchlistedAt;
  }
  async setWatchlisted(token: string, ratingKey: string, add: boolean) {
    requireThat(/^[\w-]{1,64}$/.test(ratingKey), 'INVALID_MEDIA', 'Invalid Discover identifier.');
    await this.plex.discover(token, add ? '/actions/addToWatchlist' : '/actions/removeFromWatchlist', { ratingKey }, 'PUT');
  }
}
