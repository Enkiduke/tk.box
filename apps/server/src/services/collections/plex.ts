import type { PlexAdapter } from '../../providers/plex.js';
import { CHARTS, CollectionError, collectionKey } from './rules.js';

// Plex as the collections engine reads and changes it, with the token of the administrator who started the job (a
// scheduled job: the Plex admin's). The libraries are Artwork's chosen ones (by ID or title). Never cached.
export type Item = { type: 'movie' | 'tv'; rating_key: string; title: string; year: string; genres: string[]; library: string; tmdb_id?: number; tvdb_id?: number; imdb_id?: string };
export type PlexCollection = { rating_key: string; title: string; library: string; smart: boolean; chart?: string };
type Node = Record<string, any>;
const container = (data: unknown) => ((data as { MediaContainer?: Node } | undefined)?.MediaContainer ?? {}) as Node;
const truthy = (v: unknown) => v === true || v === 1 || v === '1';

export function plexItem(node: Node, library: string): Item {
  const item: Item = { type: node.type === 'show' ? 'tv' : 'movie', rating_key: String(node.ratingKey), title: String(node.title ?? ''), year: node.year === undefined ? '' : String(node.year),
    genres: ((node.Genre ?? []) as { tag?: string }[]).map(g => g.tag ?? ''), library };
  for (const guid of [String(node.guid ?? ''), ...((node.Guid ?? []) as { id?: string }[]).map(g => String(g.id ?? ''))]) {
    const tmdb = /(?:tmdb|themoviedb):\/\/(\d+)/.exec(guid), tvdb = /(?:tvdb|thetvdb):\/\/(\d+)/.exec(guid), imdb = /imdb:\/\/(tt\d+)/.exec(guid);
    if (tmdb) item.tmdb_id = Number(tmdb[1]);
    if (tvdb) item.tvdb_id = Number(tvdb[1]);
    if (imdb) item.imdb_id = imdb[1];
  }
  return item;
}

export class CollectionsPlex {
  private sectionList?: Promise<{ key: string; title: string; type: string }[]>;
  constructor(private plex: PlexAdapter, private token: string, private libraries: string[]) {}
  read(path: string, params: Record<string, string | number> = {}) { return this.plex.serverRead(this.token, path, params).then(container); }
  send(method: 'POST' | 'PUT' | 'DELETE', path: string, params: Record<string, string | number> = {}) { return this.plex.serverSend(this.token, method, path, params).then(container); }
  private allSections() { return this.sectionList ??= this.read('/library/sections').then(c => ((c.Directory ?? []) as Node[]).map(d => ({ key: String(d.key), title: String(d.title), type: String(d.type) }))); }
  // A paged listing: every entry Plex sends, 200 at a time.
  private async *pages(path: string, params: Record<string, string | number> = {}, size = 200) {
    for (let start = 0; ;) {
      const page = await this.read(path, { ...params, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
      const entries = (page.Metadata ?? []) as Node[];
      if (!entries.length) return;
      yield entries;
      start += entries.length;
      if (start >= Number(page.totalSize ?? page.size ?? entries.length)) return;
    }
  }
  // (key, title) of the chosen libraries of one type.
  async sections(kind: 'movie' | 'show') {
    if (!this.libraries.length) return [];
    const chosen = new Set(this.libraries);
    return (await this.allSections()).filter(s => s.type === kind && (chosen.has(s.key) || chosen.has(s.title))).map(s => [s.key, s.title] as const);
  }
  // Every movie and show in the chosen libraries (of one type).
  async scan(mediaType?: 'movie' | 'show') {
    if (!this.libraries.length) return [];
    const sections = await this.allSections(), items: Item[] = [], selected = new Set<string>();
    const available = sections.map(s => `${s.title} (ID ${s.key}, ${s.type})`).join(', ') || 'none';
    for (const name of this.libraries) {
      const section = sections.find(s => s.key === name || s.title === name);
      if (!section || !['movie', 'show'].includes(section.type)) {
        if (mediaType) continue;
        throw new CollectionError(`No movie/TV Plex library found for '${name}'. Available libraries: ${available}`);
      }
      if ((mediaType && section.type !== mediaType) || selected.has(section.key)) continue;
      selected.add(section.key);
      for await (const entries of this.pages(`/library/sections/${section.key}/all`, { includeGuids: 1, excludeElements: 'Media,Role,Director,Writer,Country,Producer,Image,Collection,Field' }))
        for (const e of entries) if (e.type === 'movie' || e.type === 'show') items.push(plexItem(e, section.title));
    }
    if (mediaType && !selected.size) throw new CollectionError(`No configured ${mediaType} Plex library was found. Available libraries: ${available}`);
    return items;
  }
  // Every collection in one library, whatever it holds.
  async collectionEntries(section: string) {
    const out: Node[] = [];
    for await (const entries of this.pages(`/library/sections/${section}/collections`)) out.push(...entries.filter(e => e.type === 'collection'));
    return out;
  }
  // {collection key: [(rating key, smart)]} of one library, to see what already exists.
  async collectionTitles(section: string) {
    const found = new Map<string, [string, boolean][]>();
    for (const e of await this.collectionEntries(section)) {
      const key = collectionKey(String(e.title ?? ''));
      found.set(key, [...(found.get(key) ?? []), [String(e.ratingKey), truthy(e.smart)]]);
    }
    return found;
  }
  // The collections in the chosen libraries of one type (a TV library's may hold shows, seasons or episodes).
  async collections(kind: 'movie' | 'show') {
    const out: PlexCollection[] = [];
    for (const [key, title] of await this.sections(kind))
      for (const e of await this.collectionEntries(key)) {
        if (kind !== 'show' && (e.subtype ?? kind) !== kind) continue;
        const chart = CHARTS.find(([k, name]) => k === kind && collectionKey(String(e.title)) === collectionKey(name))?.[1];
        out.push({ rating_key: String(e.ratingKey), title: String(e.title ?? ''), library: title, smart: truthy(e.smart), ...(chart ? { chart } : {}) });
      }
    return out;
  }
  async metadata(ratingKey: string, params: Record<string, string | number> = {}) {
    return (((await this.read(`/library/metadata/${ratingKey}`, params)).Metadata ?? []) as Node[]).find(e => String(e.ratingKey) === String(ratingKey)) as Node | undefined;
  }
  // {rating key: title} of a collection's titles.
  async members(ratingKey: string) {
    const children = (await this.read(`/library/metadata/${ratingKey}/children`, { excludeElements: 'Media,Role,Director,Writer,Country,Guid,Producer,Genre,Image' })).Metadata ?? [];
    return new Map((children as Node[]).map(e => [String(e.ratingKey), String(e.title ?? '')]));
  }
  async machine() { return String((await this.read('/')).machineIdentifier ?? ''); }
  // The rating keys of what someone is watching now.
  async playing() { return new Set(((await this.read('/status/sessions')).Metadata ?? [] as Node[]).filter((e: Node) => e.type === 'movie').map((e: Node) => String(e.ratingKey))); }
  // One title, as a scan lists it; a season's or episode's key stands for its show.
  async addedItem(ratingKey: string): Promise<Item | undefined> {
    let node = await this.metadata(ratingKey);
    if (!node) throw new CollectionError(`Plex item ${ratingKey} was not found`);
    if (node.type === 'season' || node.type === 'episode') {
      const show = node.type === 'season' ? node.parentRatingKey : node.grandparentRatingKey;
      if (!show) throw new CollectionError(`Plex did not say which show ${node.type} ${ratingKey} belongs to`);
      node = await this.metadata(String(show), { includeGuids: 1 });
    } else node = await this.metadata(ratingKey, { includeGuids: 1 });
    if (!node || (node.type !== 'movie' && node.type !== 'show')) return undefined;
    return plexItem(node, String(node.librarySectionTitle ?? ''));
  }
}
