import { AppError } from '../errors.js';
import { remoteJson } from '../providers/remote-json.js';
import type { Meta } from './artwork-files.js';

// The pictures TMDb, Fanart.tv, TVDB and Plex offer for one title (posters, logos or backdrops), as the title editor lists
// them. The title's IDs come from its .artwork.json, so looking only needs Plex for Plex's own pictures. The providers are
// asked side by side and their answers kept for a day; each one that fails becomes a note, not an error.
const TMDB = 'https://api.themoviedb.org/3', FANART = 'https://webservice.fanart.tv/v3', TVDB = 'https://api4.thetvdb.com/v4';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/original';
const ROUTES = '/api/v1/admin/artwork';
const DAY_MS = 86400000, MAX_CACHED = 400;
const ALIASES: Record<string, string> = { en: 'eng', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', ja: 'jpn', ko: 'kor', zh: 'zho', ru: 'rus' };

export type PictureKind = 'poster' | 'logo' | 'backdrop';
type Art = { url: string; thumb?: string; language?: string | null; text: boolean | null; width: number; height: number; plex?: string };
type Row = [string, Art];
type Json = Record<string, unknown>;
export type Picture = { provider: string; url: string | null; plex: string | null; view: string; thumb: string; language: string | null; text: boolean | null; width: number; height: number };
export type Keys = { tmdb?: string; tvdb?: string; fanart?: string };
// Plex's JSON answer for a path on the administrator's server (status 404 and the like come back, not thrown).
export type PlexJson = (path: string, params?: Record<string, string | number>) => Promise<{ status: number; data: unknown }>;
type Item = { type: 'movie' | 'tv' | 'collection'; tmdb?: number; tvdb?: number; imdb?: string; key?: string; season: number | null };

const list = (value: unknown) => Array.isArray(value) ? value as Json[] : [];
const num = (value: unknown) => typeof value === 'number' ? value : Number(value) || 0;
const str = (value: unknown) => typeof value === 'string' ? value : undefined;

function tmdbRows(images: Json, kind: string): Art[] {
  return list(images[kind]).flatMap(a => { const path = str(a.file_path); return path ? [{ url: IMAGE_BASE + path, thumb: `https://image.tmdb.org/t/p/w300${path}`,
    language: str(a.iso_639_1) ?? null, text: !!a.iso_639_1, width: num(a.width), height: num(a.height) }] : []; });
}
function fanartRows(data: Json, ...names: string[]): Art[] {
  return names.flatMap(name => list(data[name]).flatMap(a => { const url = str(a.url), lang = str(a.lang); return url ? [{ url, language: lang ?? null, text: !!lang && lang !== '00', width: num(a.width), height: 0 }] : []; }));
}
function tvdbRows(artwork: Json[], types: Json[], kind: string): Art[] {
  const ids = new Set(types.filter(t => String(t.name ?? '').toLowerCase().replace(/[^a-z]/g, '').includes(kind)).map(t => num(t.id)));
  return artwork.flatMap(a => { const url = str(a.image); return url && ids.has(num(a.type)) ? [{ url, thumb: str(a.thumbnail) || url, language: str(a.language) ?? null,
    text: typeof a.includesText === 'boolean' ? a.includesText : !!a.language, width: num(a.width), height: num(a.height) }] : []; });
}

export class ArtworkPictures {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private tvdbToken?: { key: string; token: Promise<string> };
  constructor(private keys: () => Keys, private language: () => string, private transport: typeof fetch = fetch, private now = Date.now) {}

  // A provider's JSON, kept a day; asked once however many requests want it at the same time.
  private json(id: string, load: () => Promise<unknown>) {
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < DAY_MS) return hit.value;
    const value = load();
    value.catch(() => { if (this.cache.get(id)?.value === value) this.cache.delete(id); });
    this.cache.delete(id); this.cache.set(id, { at: this.now(), value });
    if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
  private async get(service: string, url: URL, headers: Record<string, string> = {}) {
    const response = await remoteJson(url, { headers }, service, this.transport, 20000, 32 * 1024 * 1024);
    if (response.status === 404) return {} as Json;
    if (response.status >= 400) throw new AppError('CATALOG_UNAVAILABLE', response.status === 401 ? `${service} refused the API key` : `${service} answered ${response.status}`, 502);
    return (response.data ?? {}) as Json;
  }
  private tmdb(path: string, params: Record<string, string> = {}) {
    const key = this.keys().tmdb!, url = new URL(TMDB + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const id = `tmdb ${url}`;
    url.searchParams.set('api_key', key);
    return this.json(id, () => this.get('TMDb', url)) as Promise<Json>;
  }
  private fanart(path: string) {
    return this.json(`fanart ${path}`, () => this.get('Fanart.tv', new URL(FANART + path), { 'api-key': this.keys().fanart! })) as Promise<Json>;
  }
  private async tvdb(path: string): Promise<Json> {
    const key = this.keys().tvdb!;
    return this.json(`tvdb ${path}`, async () => {
      if (this.tvdbToken?.key !== key) {
        const token = remoteJson(new URL(`${TVDB}/login`), { method: 'POST', body: { apikey: key } }, 'TVDB', this.transport, 15000).then(r => {
          const value = str(((r.data as Json | undefined)?.data as Json | undefined)?.token);
          if (r.status >= 400 || !value) throw new AppError('CATALOG_UNAVAILABLE', r.status === 401 ? 'TVDB refused the API key' : `TVDB answered ${r.status}`, 502);
          return value;
        });
        token.catch(() => { if (this.tvdbToken?.token === token) this.tvdbToken = undefined; });
        this.tvdbToken = { key, token };
      }
      return this.get('TVDB', new URL(TVDB + path), { Authorization: `Bearer ${await this.tvdbToken.token}` });
    }) as Promise<Json>;
  }
  private rank(art: Art) {
    const lang = this.language(), value = art.language;
    return value === lang || value === (ALIASES[lang] ?? lang) ? 0 : value === 'en' || value === 'eng' ? 1 : !value || value === '00' ? 2 : 3;
  }

  // TMDb's details of the title (with its images and other IDs); undefined without a key or an ID.
  private async details(item: Item) {
    const lang = this.language();
    if (!item.tmdb || !this.keys().tmdb) return undefined;
    if (item.type === 'collection') return this.tmdb(`/collection/${item.tmdb}/images`, { include_image_language: `${lang},en,null` }).then(images => ({ images }));
    const data = await this.tmdb(`/${item.type}/${item.tmdb}`, { append_to_response: 'images,external_ids', include_image_language: `${lang},en,null` });
    const external = (data.external_ids ?? {}) as Json;
    item.tvdb ??= num(external.tvdb_id) || undefined; item.imdb ??= str(external.imdb_id) || undefined;
    return data;
  }
  // The TMDb ID of a title that only has an IMDb or TVDB one.
  private async identify(item: Item) {
    if (item.tmdb || !this.keys().tmdb) return;
    for (const [id, source] of [[item.imdb, 'imdb_id'], [item.type === 'tv' ? item.tvdb : undefined, 'tvdb_id']] as const) {
      if (!id) continue;
      const found = await this.tmdb(`/find/${id}`, { external_source: source }), matches = list(found[item.type === 'movie' ? 'movie_results' : 'tv_results']);
      if (matches.length === 1) { item.tmdb = num(matches[0]!.id); return; }
    }
  }
  private async tmdbArt(item: Item, kind: PictureKind) {
    const data = await this.details(item);
    if (!data) return [];
    const images = (data.images ?? {}) as Json;
    if (kind === 'backdrop') return tmdbRows(images, 'backdrops');
    if (kind === 'logo') return tmdbRows(images, 'logos');
    const posters = tmdbRows(images, 'posters');
    if (item.season === null) return posters;
    const seasonal = await this.tmdb(`/tv/${item.tmdb}/season/${item.season}/images`, { include_image_language: `${this.language()},en,null` });
    return [...tmdbRows(seasonal, 'posters'), ...posters];
  }
  private async fanartArt(item: Item, kind: PictureKind) {
    // Fanart files franchise logos under the TMDb collection ID in its movies namespace.
    const lookup = item.type === 'tv' ? item.tvdb : item.tmdb ?? item.imdb;
    if (!lookup || !this.keys().fanart) return [];
    const data = await this.fanart(`/${item.type === 'tv' ? 'tv' : 'movies'}/${lookup}`);
    if (kind === 'backdrop') return fanartRows(data, item.type === 'tv' ? 'showbackground' : 'moviebackground');
    if (item.type !== 'tv') return kind === 'logo' ? fanartRows(data, 'hdmovielogo', 'movielogo', 'clearlogo') : fanartRows(data, 'movieposter');
    if (kind === 'logo') return fanartRows(data, 'hdtvlogo', 'clearlogo');
    const seasonal = item.season === null ? [] : fanartRows({ seasonposter: list(data.seasonposter).filter(a => String(a.season) === String(item.season)) }, 'seasonposter');
    return [...seasonal, ...fanartRows(data, 'tvposter')];
  }
  private async tvdbArt(item: Item, kind: PictureKind) {
    if (!this.keys().tvdb || item.type === 'collection') return [];
    if (!item.tvdb && item.imdb) {
      const results = list((await this.tvdb(`/search/remoteid/${item.imdb}`)).data), field = item.type === 'movie' ? 'movie' : 'series';
      const matches = results.flatMap(r => r[field] ? [r[field] as Json] : []);
      if (matches.length === 1) item.tvdb = num(matches[0]!.id);
    }
    if (!item.tvdb) return [];
    const [record, types] = await Promise.all([this.tvdb(`/${item.type === 'movie' ? 'movies' : 'series'}/${item.tvdb}/extended`), this.tvdb('/artwork/types')]);
    const data = (record.data ?? {}) as Json, kinds = list(types.data);
    let artwork = list(data.artworks);
    if (kind === 'backdrop') return tvdbRows(artwork, kinds, 'background');
    if (kind === 'logo') return tvdbRows(artwork, kinds, 'clearlogo');
    if (item.season !== null) {
      const matches = list(data.seasons).filter(s => num(s.number) === item.season);
      const official = matches.filter(s => { const type = (s.type ?? {}) as Json; return `${type.type ?? ''} ${type.name ?? ''}`.toLowerCase().includes('official'); });
      const chosen = official.length ? official : matches;
      if (chosen.length === 1) artwork = [...list(((await this.tvdb(`/seasons/${chosen[0]!.id}/extended`)).data as Json | undefined)?.artwork), ...artwork];
    }
    return tvdbRows(artwork, kinds, 'poster');
  }
  // Pictures Plex itself lists for the title or season (its agents' and anything uploaded); no logos.
  private async plexArt(item: Item, kind: PictureKind, plex: PlexJson) {
    if (kind === 'logo' || !item.key) return [];
    let key = item.key;
    if (item.season !== null && kind === 'poster') {
      const children = (await plex(`/library/metadata/${item.key}/children`)).data as { MediaContainer?: { Metadata?: Json[] } } | undefined;
      const season = (children?.MediaContainer?.Metadata ?? []).find(c => num(c.index) === item.season);
      if (!season?.ratingKey) return [];
      key = String(season.ratingKey);
    }
    const answer = await plex(`/library/metadata/${key}/${kind === 'backdrop' ? 'arts' : 'posters'}`);
    if (answer.status >= 400) throw new AppError('PLEX_UNAVAILABLE', answer.status === 404 ? 'Plex no longer has this title under its saved ID' : `Plex answered ${answer.status}`, 502);
    const container = ((answer.data ?? {}) as { MediaContainer?: { Metadata?: Json[]; Photo?: Json[] } }).MediaContainer;
    // Plex gives agent images as their public URL; its own copies as a server path that needs the token.
    return [...container?.Metadata ?? [], ...container?.Photo ?? []].flatMap(photo => {
      const link = str(photo.key) ?? '', thumb = str(photo.thumb) ?? '', path = link.startsWith('/') ? link : thumb;
      if (/^https?:\/\//.test(link)) return [{ url: link, language: null, text: null, width: 0, height: 0 }];
      return path.startsWith('/') ? [{ url: path, plex: path, language: null, text: null, width: 0, height: 0 }] : [];
    });
  }

  async list(meta: Meta, season: number | null, kind: PictureKind, plex: PlexJson) {
    const type = meta.type === 'tv' || meta.type === 'collection' ? meta.type : 'movie';
    // Seasons share their show's logos, and their show's backdrops
    const item: Item = { type, ...num(meta.tmdb_id) ? { tmdb: num(meta.tmdb_id) } : {}, ...num(meta.tvdb_id) ? { tvdb: num(meta.tvdb_id) } : {}, ...str(meta.imdb_id) ? { imdb: str(meta.imdb_id)! } : {},
      ...meta.rating_key ? { key: String(meta.rating_key) } : {}, season: kind === 'logo' ? null : season };
    const notes: string[] = [], rows: Row[] = [];
    const guard = (name: string, work: () => Promise<Art[]>) => work().then(found => found.map(art => [name, art] as Row), (e: Error) => { notes.push(`${name}: ${e.message}`); return [] as Row[]; });
    // TMDb first: it fills in the TVDB and IMDb IDs the other providers look titles up by
    const plexRows = guard('plex', () => this.plexArt(item, kind, plex));
    const tmdbRows = guard('tmdb', async () => { await this.identify(item); return this.tmdbArt(item, kind); });
    await tmdbRows;
    for (const found of await Promise.all([tmdbRows, guard('fanart', () => this.fanartArt(item, kind)), guard('tvdb', () => this.tvdbArt(item, kind)), plexRows])) rows.push(...found);
    // Plex lists the same TMDb/TVDB images its agents found
    const seen = new Set<string>();
    let found = rows.filter(([, art]) => !seen.has(art.url) && !!seen.add(art.url));
    if (kind === 'logo') found = found.filter(([, art]) => !new URL(art.url, 'http://plex').pathname.toLowerCase().endsWith('.svg') && this.rank(art) < 3);
    // Textless (or language-neutral) first, then the rest; each group by language, then size
    found.sort(([, a], [, b]) => Number(a.text !== false) - Number(b.text !== false) || this.rank(a) - this.rank(b) || b.width - a.width);
    const items: Picture[] = found.map(([provider, art]) => {
      // The page loads images only from tk.box: Plex's own copies need the token, the providers' are proxied
      if (art.plex) { const view = `${ROUTES}/plex-image?${new URLSearchParams({ p: art.plex })}`; return { provider, url: null, plex: art.plex, view, thumb: view, language: art.language ?? null, text: art.text, width: art.width, height: art.height }; }
      const size = kind === 'backdrop' ? 'w1280' : 'w780';  // A smaller copy than the original is plenty to look at
      const view = art.url.startsWith(IMAGE_BASE) ? `https://image.tmdb.org/t/p/${size}${art.url.slice(IMAGE_BASE.length)}` : art.url;
      const thumb = art.thumb || (art.url.includes('assets.fanart.tv') ? art.url.replace('/fanart/', '/preview/') : art.url);
      const proxied = (link: string) => `${ROUTES}/image?${new URLSearchParams({ u: link })}`;
      return { provider, url: art.url, plex: null, view: proxied(view), thumb: proxied(thumb), language: art.language ?? null, text: art.text, width: art.width, height: art.height };
    });
    return { items, notes };
  }
}
