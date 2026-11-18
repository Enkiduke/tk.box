import type { PlexAvailability, PlexCopy } from '../providers/plex.js';

// What the Plex server holds, by TMDB id (and TVDB for shows): one index for the whole app, built in app.ts (the
// plex-index module) and read by the library (wanted, Admin's Plex links) and requests (statuses, Explore's labels,
// play links). Rebuilt when Plex says its library changed (a few seconds later, so a batch of changes reads once),
// after imports and Clean Up, and every few hours. A read that fails, or misses a library, keeps the last good index;
// the first read is used even if incomplete.
// For the shows the library follows (`follow`), it also reads which episodes Plex has, so an episode Plex holds counts
// as had (services/wanted.ts `have`) the way a movie does. Only those shows: one Plex read each, a few at a time. A
// show whose read fails keeps the episodes its last read found.
// It is also the app's one title identity (`resolve`): from a rating key (a movie's, a show's, or an episode's of a
// followed show), a TMDB or TVDB id, a library title id or a library file's path, the same title's other keys.
export type Held = { ratingKey: string; addedAt?: number; seasons: Map<number, number | undefined>;
  tmdbId?: number; tvdbId?: number; section?: string;
  // Every copy Plex has of the title (one per library it is in), this one first. Only on the copy the index answers with.
  copies?: PlexCopy[];
  // Followed shows only: the episodes Plex has, as `season:episode`, and their rating keys.
  episodes?: ReadonlySet<string>; episodeKeys?: ReadonlyMap<string, readonly [season: number, episode: number]> };
export type ShowRef = { tmdbId: number; tvdbId?: number | undefined };
export type TitleKind = 'movie' | 'show';
// Any key a module holds for a title.
export type TitleKey = { ratingKey: string } | { kind: TitleKind; tmdb: number; tvdb?: number | undefined } | { tvdb: number }
  | { libraryTitleId: number } | { path: string };
// One title's keys. `ratingKey` is set when Plex holds it (for an episode's key: the show's, with `season`/`episode`),
// with `copies`, every copy Plex has and its library (a viewer may see only some: providers/plex.ts `viewerCopies`);
// `libraryTitleId` when the library has it.
export type TitleIds = { kind: TitleKind; tmdb: number; tvdb?: number; ratingKey?: string; copies?: readonly PlexCopy[]; libraryTitleId?: number;
  season?: number; episode?: number };
// The library's side of the identity, set by the library module (it mounts after the index).
export type LibraryIdentity = {
  title(id: number): { kind: TitleKind; tmdbId: number; tvdbId?: number | null | undefined } | undefined;
  titleId(kind: TitleKind, tmdbId: number): number | undefined;
  // The library title a file belongs to.
  pathTitle(path: string): number | undefined;
};
type Keyed = { kind: TitleKind; held: Held; season?: number; episode?: number };
type Index = { movies: Map<number, Held>; shows: Map<number, Held>; showsByTvdb: Map<number, Held>; keys: Map<string, Keyed> };
const EPISODE_READS = 4;

export class PlexIndex {
  private index?: Index;
  private reading?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private listeners: (() => void)[] = [];
  private followed: () => Iterable<ShowRef> = () => [];
  private libraryIds?: LibraryIdentity;
  constructor(private read: () => Promise<PlexAvailability>, private log: (message: string, detail: object) => void = () => {},
    // A show's episodes on Plex, by its rating key.
    private readEpisodes?: (ratingKey: string) => Promise<readonly { season: number; episode: number; ratingKey?: string }[]>) {}
  // `listener` is told after each rebuild that replaced the index.
  onChange(listener: () => void) { this.listeners.push(listener); }
  // The shows whose episodes to read (the library's followed shows), asked at each rebuild.
  follow(shows: () => Iterable<ShowRef>) { this.followed = shows; }
  // The library's title ids and paths, for `resolve`.
  library(ids: LibraryIdentity) { this.libraryIds = ids; }
  // The title behind any key, with its other keys; undefined when neither Plex nor the library knows it.
  resolve(key: TitleKey): TitleIds | undefined {
    if ('ratingKey' in key) {
      const keyed = this.index?.keys.get(key.ratingKey);
      return keyed && this.ids(keyed.kind, keyed.held, keyed.season === undefined ? {} : { season: keyed.season, episode: keyed.episode! });
    }
    if ('tmdb' in key) {
      const held = key.kind === 'movie' ? this.movie(key.tmdb) : this.show(key.tmdb, key.tvdb);
      const tvdb = key.tvdb ?? held?.tvdbId;
      return this.withLibrary({ kind: key.kind, tmdb: key.tmdb, ...(tvdb ? { tvdb } : {}), ...plexKeys(held) });
    }
    if ('tvdb' in key) {
      const held = this.index?.showsByTvdb.get(key.tvdb);
      return held && this.ids('show', held, {});
    }
    const id = 'path' in key ? this.libraryIds?.pathTitle(key.path) : key.libraryTitleId, title = id === undefined ? undefined : this.libraryIds?.title(id);
    if (id === undefined || !title) return undefined;
    const held = title.kind === 'movie' ? this.movie(title.tmdbId) : this.show(title.tmdbId, title.tvdbId ?? undefined);
    const tvdb = title.tvdbId ?? held?.tvdbId;
    return { kind: title.kind, tmdb: title.tmdbId, ...(tvdb ? { tvdb } : {}), ...plexKeys(held), libraryTitleId: id };
  }
  private ids(kind: TitleKind, held: Held, episode: { season?: number; episode?: number }): TitleIds | undefined {
    if (!held.tmdbId) return undefined;
    // A second copy answers with the title's copies, itself first.
    const main = kind === 'movie' ? this.movie(held.tmdbId) : this.show(held.tmdbId, held.tvdbId);
    const copies = main?.copies ? [...main.copies].sort((a, b) => +(b.ratingKey === held.ratingKey) - +(a.ratingKey === held.ratingKey)) : copiesOf(held);
    return this.withLibrary({ kind, tmdb: held.tmdbId, ...(held.tvdbId ? { tvdb: held.tvdbId } : {}), ratingKey: held.ratingKey, copies, ...episode });
  }
  private withLibrary(ids: TitleIds): TitleIds {
    const libraryTitleId = this.libraryIds?.titleId(ids.kind, ids.tmdb);
    return libraryTitleId === undefined ? ids : { ...ids, libraryTitleId };
  }
  ready() { return !!this.index; }
  movie(tmdbId: number) { return this.index?.movies.get(tmdbId); }
  show(tmdbId: number, tvdbId?: number | undefined) { return this.index?.shows.get(tmdbId) ?? (tvdbId ? this.index?.showsByTvdb.get(tvdbId) : undefined); }
  // Every title Plex holds, keyed like Explore items (`movie:tmdb:603`).
  *titles(): Generator<[kind: 'movie' | 'show', tmdbId: number, held: Held]> {
    for (const [id, held] of this.index?.movies ?? []) yield ['movie', id, held];
    for (const [id, held] of this.index?.shows ?? []) yield ['show', id, held];
  }
  rebuild() {
    this.reading ??= this.read().then(found => {
      if (!found.complete && this.index) { this.log('plex index: Plex read incomplete; keeping the last index', {}); return; }
      const next = build(found);
      return this.readFollowed(next).then(() => {
        this.index = next;
        for (const listener of this.listeners) listener();
      });
    }, e => { this.log('plex index: Plex read failed', { error: (e as Error).message }); }).finally(() => { this.reading = undefined; });
    return this.reading;
  }
  // One followed show's episodes read again (just added, or its seasons followed), then readers are told.
  async refreshShow(show: ShowRef) {
    const held = this.show(show.tmdbId, show.tvdbId);
    if (!held || !this.readEpisodes) return;
    await this.readShow(this.index!, held, held);
    for (const listener of this.listeners) listener();
  }
  private async readFollowed(next: Index) {
    if (!this.readEpisodes) return;
    const started = Date.now(), shows = new Set<Held>();
    for (const ref of this.followed()) {
      const held = next.shows.get(ref.tmdbId) ?? (ref.tvdbId ? next.showsByTvdb.get(ref.tvdbId) : undefined);
      if (held) shows.add(held);
    }
    const old = new Map<string, Held>();
    for (const held of this.index?.shows.values() ?? []) old.set(held.ratingKey, held);
    const pending = shows.values();
    let failed = 0;
    await Promise.all(Array.from({ length: Math.min(EPISODE_READS, shows.size) }, async () => {
      for (const held of pending) if (!await this.readShow(next, held, old.get(held.ratingKey))) failed++;
    }));
    this.log('plex index: episodes read', { shows: shows.size, failed, ms: Date.now() - started });
  }
  // False when the read failed (the show keeps `previous`'s episodes).
  private async readShow(index: Index, held: Held, previous: Held | undefined) {
    // An episode's rating key resolves to its show.
    const keyEpisodes = (keys: ReadonlyMap<string, readonly [number, number]> | undefined) => {
      for (const [key, [season, episode]] of keys ?? []) index.keys.set(key, { kind: 'show', held, season, episode });
    };
    try {
      const found = (await this.readEpisodes!(held.ratingKey)).filter(e => e.season > 0);
      held.episodes = new Set(found.map(e => `${e.season}:${e.episode}`));
      held.episodeKeys = new Map(found.flatMap(e => e.ratingKey ? [[e.ratingKey, [e.season, e.episode] as const]] : []));
      keyEpisodes(held.episodeKeys);
      return true;
    } catch (e) {
      if (previous?.episodes) held.episodes = previous.episodes;
      if (previous?.episodeKeys) { held.episodeKeys = previous.episodeKeys; keyEpisodes(held.episodeKeys); }
      this.log('plex index: a show’s episodes could not be read', { ratingKey: held.ratingKey, error: (e as Error).message });
      return false;
    }
  }
  // Plex reports changes in bursts while it scans.
  soon(ms = 30000) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.rebuild(), ms); this.timer.unref(); }
  close() { clearTimeout(this.timer); }
}

const ms = (seconds?: number) => seconds === undefined ? undefined : seconds * 1000;
const copiesOf = (held: Held): PlexCopy[] => held.copies ?? [{ ratingKey: held.ratingKey, ...(held.section ? { section: held.section } : {}) }];
const plexKeys = (held: Held | undefined) => held ? { ratingKey: held.ratingKey, copies: copiesOf(held) } : {};
// The first copy of a title answers for it; later ones are listed in its `copies`.
const addCopy = (main: Held, copy: Held) => { main.copies = [...copiesOf(main), ...copiesOf(copy)]; };
export function build(found: PlexAvailability): Index {
  const index: Index = { movies: new Map(), shows: new Map(), showsByTvdb: new Map(), keys: new Map() }, byKey = new Map<string, Held>();
  for (const t of found.titles) {
    const held: Held = { ratingKey: t.ratingKey, ...(t.addedAt ? { addedAt: ms(t.addedAt) } : {}), seasons: new Map(),
      ...(t.tmdbId ? { tmdbId: t.tmdbId } : {}), ...(t.tvdbId ? { tvdbId: t.tvdbId } : {}), ...(t.section ? { section: t.section } : {}) };
    index.keys.set(t.ratingKey, { kind: t.kind, held });
    if (t.kind === 'movie') {
      const main = t.tmdbId ? index.movies.get(t.tmdbId) : undefined;
      if (main) addCopy(main, held); else if (t.tmdbId) index.movies.set(t.tmdbId, held);
      continue;
    }
    byKey.set(t.ratingKey, held);
    const main = (t.tmdbId ? index.shows.get(t.tmdbId) : undefined) ?? (t.tvdbId ? index.showsByTvdb.get(t.tvdbId) : undefined);
    if (main) addCopy(main, held);
    if (t.tmdbId && !index.shows.has(t.tmdbId)) index.shows.set(t.tmdbId, held);
    if (t.tvdbId && !index.showsByTvdb.has(t.tvdbId)) index.showsByTvdb.set(t.tvdbId, held);
  }
  for (const s of found.seasons) if (s.season > 0) byKey.get(s.showKey)?.seasons.set(s.season, ms(s.addedAt));
  return index;
}
