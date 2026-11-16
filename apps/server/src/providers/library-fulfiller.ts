import { AppError } from '../errors.js';
import { movieReleaseDate } from '../lib/release-day.js';
import { FulfilError, type FulfilKind, type FulfilProgress, type FulfilTarget, type Fulfiller, type QueueState } from './arr-fulfiller.js';
import { isOut, scopeName } from '../services/wanted.js';
import type { Library } from '../services/library.js';
import type { LibraryStore, LibraryTitle } from '../persistence/library-store.js';
import type { RequestRelease } from '../../../../packages/contracts/src/index.js';

// Requests fulfilled by tk.box's own library (docs/ARR-REPLACEMENT.md), behind the same Fulfiller as Sonarr: movies
// always, shows once `fulfil.show` is `tkbox` (requests choose). Ids are library_titles ids. Keep is the title's own
// flag, offered as one tag.
export const KEEP_TAG = -1;
type Episode = Extract<RequestRelease, { kind: 'episode' }>;

export class LibraryFulfiller implements Fulfiller {
  constructor(private library: Pick<Library, 'add' | 'addShow' | 'unmonitor' | 'unmonitorSeasons'>, private store: LibraryStore) {}

  async add(target: FulfilTarget) {
    const common = { tmdbId: target.tmdbId, by: target.requestedBy ?? 'requests', ...(target.profileId ? { profileId: target.profileId } : {}),
      keep: target.tags.includes(KEEP_TAG), search: target.search };
    try {
      const title = target.kind === 'movie' ? await this.library.add(common)
        : await this.library.addShow({ ...common, seasons: target.seasons, monitorFuture: target.monitorFuture });
      return title.id;
    } catch (e) {
      if (e instanceof FulfilError) throw e;
      throw new FulfilError(e instanceof Error ? e.message : String(e), e instanceof AppError && (e.code === 'NOT_FOUND' || e.code === 'NO_TVDB_ID'));
    }
  }
  async queue(): Promise<QueueState> {
    const series = new Map<number, Set<number | undefined>>();
    for (const [id, seasons] of this.store.grabbingSeasons()) series.set(id, new Set(seasons));
    return { movies: this.store.grabbingTitles(), series };
  }
  async find(kind: FulfilKind, tmdbId: number) { return this.store.titleByTmdb(kind, tmdbId)?.id; }
  async exists(_kind: FulfilKind, id: number) { return !!this.store.title(id); }
  async progress(kind: FulfilKind, id: number, seasons: number[], now: number): Promise<FulfilProgress> {
    const title = this.store.title(id);
    if (!title || title.kind !== kind) return {};
    return kind === 'movie' ? this.movieProgress(title, now) : this.showProgress(title, seasons, now);
  }
  private movieProgress(title: LibraryTitle, now: number): FulfilProgress {
    const at = this.store.search(title.id, 'movie')?.lastAt || undefined;
    const { theatrical, digital, physical } = title.released;
    const date = movieReleaseDate({ inCinemas: theatrical, digitalRelease: digital, physicalRelease: physical });
    const waiting = !isOut(title.released, now);
    return { ...(at ? { at } : {}), ...((date || waiting) && { release: { kind: 'movie', ...(date ? { date } : {}), ...(waiting ? { waitingForRelease: true as const } : {}) } }) };
  }
  // As Sonarr's: among the asked seasons' episodes with no file, the last search of their scopes, and the latest to
  // have aired (else the next to air).
  private showProgress(title: LibraryTitle, seasons: readonly number[], now: number): FulfilProgress {
    if (!seasons.length) return {};
    const files = this.store.episodeFiles(title.id);
    const missing = this.store.episodes(title.id).filter(e => seasons.includes(e.season) && !files.has(`${e.season}:${e.episode}`));
    let at: number | undefined, latestAired: Episode | undefined, nextToAir: Episode | undefined;
    const searched = (scope: string) => { const last = this.store.search(title.id, scope)?.lastAt; if (last && (at === undefined || last > at)) at = last; };
    for (const season of new Set(missing.map(e => e.season))) searched(scopeName(season));
    for (const e of missing) {
      searched(scopeName(e.season, e.episode));
      if (!e.airDate) continue;
      const aired = e.airAt !== undefined && e.airAt <= now;
      const airing: Episode = { kind: 'episode', day: e.airDate, aired, season: e.season, episode: e.episode };
      if (aired && (!latestAired || e.airDate > latestAired.day)) latestAired = airing;
      if (!aired && (!nextToAir || e.airDate < nextToAir.day)) nextToAir = airing;
    }
    const release = latestAired ?? nextToAir;
    return { ...(at ? { at } : {}), ...(release ? { release } : {}) };
  }
  async unmonitor(kind: FulfilKind, id: number, seasons: number[]) {
    if (kind === 'movie') this.library.unmonitor(id); else this.library.unmonitorSeasons(id, seasons);
  }
  async options(_kind: FulfilKind) {
    // The profiles are pick_profiles, the default first; the root is the library's own and Keep its own flag, so no
    // folders or tags to pick.
    const first = this.store.settings().defaultProfile, profiles = this.store.profiles();
    return { connected: true, tkbox: true, profiles: [...profiles.filter(p => p.id === first), ...profiles.filter(p => p.id !== first)], rootFolders: [], tags: [] };
  }
  async tagId() { return KEEP_TAG; }
}

// One Fulfiller in front of two: each call goes to the one `choose` names for its kind (movies to the library, shows
// by `fulfil.show`).
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
