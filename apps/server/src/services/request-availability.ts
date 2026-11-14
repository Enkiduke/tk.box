import type { PlexAvailability } from '../providers/plex.js';

// What the Plex server holds, by TMDB id (and TVDB for shows), for request statuses and Explore's labels. Rebuilt when
// Plex says its library changed (a few seconds later, so a batch of changes reads once) and every few hours. A read
// that fails, or misses a library, keeps the last good index; the first read is used even if incomplete.
export type Held = { ratingKey: string; addedAt?: number; seasons: Map<number, number | undefined> };
type Index = { movies: Map<number, Held>; shows: Map<number, Held>; showsByTvdb: Map<number, Held> };

export class RequestAvailability {
  private index?: Index;
  private reading?: Promise<void>;
  private timer?: NodeJS.Timeout;
  // Told after each rebuild that changed the index.
  changed?: () => void;
  constructor(private read: () => Promise<PlexAvailability>, private log: (message: string, detail: object) => void = () => {}) {}
  ready() { return !!this.index; }
  movie(tmdbId: number) { return this.index?.movies.get(tmdbId); }
  show(tmdbId: number, tvdbId?: number) { return this.index?.shows.get(tmdbId) ?? (tvdbId ? this.index?.showsByTvdb.get(tvdbId) : undefined); }
  // Every title Plex holds, keyed like Explore items (`movie:tmdb:603`).
  *titles(): Generator<[kind: 'movie' | 'show', tmdbId: number, held: Held]> {
    for (const [id, held] of this.index?.movies ?? []) yield ['movie', id, held];
    for (const [id, held] of this.index?.shows ?? []) yield ['show', id, held];
  }
  rebuild() {
    this.reading ??= this.read().then(found => {
      if (!found.complete && this.index) { this.log('request availability: Plex read incomplete; keeping the last index', {}); return; }
      this.index = build(found); this.changed?.();
    }, e => { this.log('request availability: Plex read failed', { error: (e as Error).message }); }).finally(() => { this.reading = undefined; });
    return this.reading;
  }
  // Plex reports changes in bursts while it scans.
  soon(ms = 30000) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.rebuild(), ms); this.timer.unref(); }
  close() { clearTimeout(this.timer); }
}

const ms = (seconds?: number) => seconds === undefined ? undefined : seconds * 1000;
export function build(found: PlexAvailability): Index {
  const index: Index = { movies: new Map(), shows: new Map(), showsByTvdb: new Map() }, byKey = new Map<string, Held>();
  for (const t of found.titles) {
    const held: Held = { ratingKey: t.ratingKey, ...(t.addedAt ? { addedAt: ms(t.addedAt) } : {}), seasons: new Map() };
    if (t.kind === 'movie') { if (t.tmdbId && !index.movies.has(t.tmdbId)) index.movies.set(t.tmdbId, held); continue; }
    byKey.set(t.ratingKey, held);
    if (t.tmdbId && !index.shows.has(t.tmdbId)) index.shows.set(t.tmdbId, held);
    if (t.tvdbId && !index.showsByTvdb.has(t.tvdbId)) index.showsByTvdb.set(t.tvdbId, held);
  }
  for (const s of found.seasons) if (s.season > 0) byKey.get(s.showKey)?.seasons.set(s.season, ms(s.addedAt));
  return index;
}
