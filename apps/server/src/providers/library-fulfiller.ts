import { AppError } from '../errors.js';
import { movieReleaseDate } from '../lib/release-day.js';
import { FulfilError, type FulfilKind, type FulfilProgress, type FulfilTarget, type Fulfiller, type QueueState } from './arr-fulfiller.js';
import { isOut } from '../services/wanted.js';
import type { Library } from '../services/library.js';
import type { LibraryStore } from '../persistence/library-store.js';

// Requests fulfilled by tk.box's own library (docs/ARR-REPLACEMENT.md), behind the same Fulfiller as Sonarr.
// Movies only in phase 1; ids are library_titles ids. Keep is the title's own flag, offered as one tag.
export const KEEP_TAG = -1;

export class LibraryFulfiller implements Fulfiller {
  constructor(private library: Pick<Library, 'add' | 'unmonitor'>, private store: LibraryStore) {}
  private movies(kind: FulfilKind) { if (kind !== 'movie') throw new FulfilError('tk.box fulfils movies only so far; shows go to Sonarr.', true); }

  async add(target: FulfilTarget) {
    this.movies(target.kind);
    try {
      const title = await this.library.add({ tmdbId: target.tmdbId, by: target.requestedBy ?? 'requests', ...(target.profileId ? { profileId: target.profileId } : {}),
        keep: target.tags.includes(KEEP_TAG), search: target.search });
      return title.id;
    } catch (e) {
      if (e instanceof FulfilError) throw e;
      throw new FulfilError(e instanceof Error ? e.message : String(e), e instanceof AppError && e.code === 'NOT_FOUND');
    }
  }
  async queue(): Promise<QueueState> { return { movies: this.store.grabbingTitles(), series: new Map() }; }
  async find(kind: FulfilKind, tmdbId: number) { return kind === 'movie' ? this.store.titleByTmdb('movie', tmdbId)?.id : undefined; }
  async exists(_kind: FulfilKind, id: number) { return !!this.store.title(id); }
  async progress(kind: FulfilKind, id: number, _seasons: number[], now: number): Promise<FulfilProgress> {
    const title = kind === 'movie' ? this.store.title(id) : undefined;
    if (!title) return {};
    const at = this.store.search(id, 'movie')?.lastAt || undefined;
    const { theatrical, digital, physical } = title.released;
    const date = movieReleaseDate({ inCinemas: theatrical, digitalRelease: digital, physicalRelease: physical });
    const waiting = !isOut(title.released, now);
    return { ...(at ? { at } : {}), ...((date || waiting) && { release: { kind: 'movie', ...(date ? { date } : {}), ...(waiting ? { waitingForRelease: true as const } : {}) } }) };
  }
  async unmonitor(kind: FulfilKind, id: number) { if (kind === 'movie') this.library.unmonitor(id); }
  async options(kind: FulfilKind) {
    this.movies(kind);
    // The profiles are pick_profiles, the default first; the root is the library's own and Keep its own flag, so no
    // folders or tags to pick.
    const first = this.store.settings().defaultProfile, profiles = this.store.profiles();
    return { connected: true, tkbox: true, profiles: [...profiles.filter(p => p.id === first), ...profiles.filter(p => p.id !== first)], rootFolders: [], tags: [] };
  }
  async tagId() { return KEEP_TAG; }
}

// One Fulfiller in front of two: each call goes to the one `choose` names for its kind (movies to the library, shows
// to Sonarr until phase 2).
export function fulfillerByKind(choose: (kind: FulfilKind) => Fulfiller): Fulfiller {
  return {
    add: target => choose(target.kind).add(target),
    // Each kind's own queue: movies from the movie fulfiller, series from the show one.
    queue: async () => {
      const movie = choose('movie'), show = choose('show');
      if (movie === show) return movie.queue();
      const [m, s] = await Promise.all([movie.queue(), show.queue()]);
      return { movies: m.movies, series: s.series };
    },
    find: (kind, tmdbId, tvdbId) => choose(kind).find(kind, tmdbId, tvdbId),
    exists: (kind, id) => choose(kind).exists(kind, id),
    progress: (kind, id, seasons, now) => choose(kind).progress(kind, id, seasons, now),
    unmonitor: (kind, id, seasons) => choose(kind).unmonitor(kind, id, seasons),
    options: kind => choose(kind).options(kind),
    tagId: async (kind, label) => {
      const f = choose(kind);
      if (!f.tagId) throw new AppError('REQUESTS_UNAVAILABLE', 'Keep isn’t available here.', 409);
      return f.tagId(kind, label);
    },
  };
}
