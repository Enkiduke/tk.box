import { EARLY_COPIES, rank, type Profile, type Quality } from '../lib/quality.js';
import type { Monitor, Released } from '../persistence/library-store.js';

// Wanted and search timing for movies (docs/ARR-REPLACEMENT.md, "Wanted" and "Search timing"). Pure: the library
// reads the rows and Plex, these say what follows.

const HOUR = 3600000, DAY = 24 * HOUR;
// A miss waits 1, 2, 4, then every 7 days.
export const MISS_BACKOFF_DAYS = [1, 2, 4, 7] as const;
export const missBackoff = (misses: number) => MISS_BACKOFF_DAYS[Math.min(Math.max(misses, 1), MISS_BACKOFF_DAYS.length) - 1]! * DAY;
export const EARLY_COPY_EVERY = 12 * HOUR, RELEASE_EVERY = 6 * HOUR, RELEASE_WINDOW = 3 * DAY;
// A movie with no home release date is taken as out this long after it reached cinemas.
const THEATRICAL_GRACE = 120 * DAY;

export type MovieState = {
  monitor: Monitor; paused: boolean;
  // Plex holds the movie (by TMDB id).
  inPlex: boolean;
  // tk.box's file for it (library_files), when it has one.
  file?: { quality: Quality };
};
export type Wanted = { wanted: true; why: 'missing' | 'cutoff' } | { wanted: false; why: 'unmonitored' | 'paused' | 'have' };

// Wanted when monitored and not paused, and either nothing is on the server, or tk.box's file is below the cutoff (an
// early copy always is). A file Plex has that tk.box never recorded (before the cutover) is taken as the movie.
export function movieWanted(state: MovieState, profile: Pick<Profile, 'cutoff'>): Wanted {
  if (state.monitor === 'none') return { wanted: false, why: 'unmonitored' };
  if (state.paused) return { wanted: false, why: 'paused' };
  if (state.file) return EARLY_COPIES.has(state.file.quality) || rank(state.file.quality) < rank(profile.cutoff) ? { wanted: true, why: 'cutoff' } : { wanted: false, why: 'have' };
  return state.inPlex ? { wanted: false, why: 'have' } : { wanted: true, why: 'missing' };
}

const dayStart = (day: string | undefined) => { const at = day ? Date.parse(`${day}T00:00:00Z`) : NaN; return Number.isFinite(at) ? at : undefined; };
// When the movie can be had at home: its digital release, or its physical one when that came first.
export function homeRelease(released: Released) {
  const digital = dayStart(released.digital), physical = dayStart(released.physical);
  return digital === undefined ? physical : physical === undefined ? digital : Math.min(digital, physical);
}
// Out at home: a digital or physical release that has happened, or (with neither known) a theatrical one long enough
// ago, or no dates at all.
export function isOut(released: Released, now: number) {
  const home = homeRelease(released);
  if (home !== undefined) return home <= now;
  const theatrical = dayStart(released.theatrical);
  return theatrical === undefined || theatrical + THEATRICAL_GRACE <= now;
}

export type TimingInput = { now: number; released: Released; earlyCopies: boolean; file?: { quality: Quality } };

// On request or add: at once, unless the movie isn't out and Early copies is off. Then RSS only until its home
// release (undefined: no search until then; the sweep has nothing due).
export function firstSearchAt(input: TimingInput): number {
  if (input.earlyCopies || isOut(input.released, input.now)) return input.now;
  return homeRelease(input.released) ?? input.now + MISS_BACKOFF_DAYS[3] * DAY;
}

// After a search that found nothing to grab (`misses` counts it). The backoff, then:
// - not out with Early copies off: not before the home release;
// - an early copy on disk: at most 12 hours (Early copies);
// - from the home release: every 6 hours for 3 days, when the good copies appear;
// - and never past the home release while waiting for it.
export function nextSearchAt(input: TimingInput & { misses: number }): number {
  const { now, released, earlyCopies, file } = input;
  const home = homeRelease(released);
  let next = now + missBackoff(input.misses);
  if (!earlyCopies && !isOut(released, now) && home !== undefined) return home;
  if (earlyCopies && file && EARLY_COPIES.has(file.quality)) next = Math.min(next, now + EARLY_COPY_EVERY);
  if (home !== undefined && home <= now && now < home + RELEASE_WINDOW) next = Math.min(next, now + RELEASE_EVERY);
  if (home !== undefined && home > now) next = Math.min(next, home);
  return next;
}
