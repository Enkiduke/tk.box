import { EARLY_COPIES, type Quality } from '../lib/quality.js';
import { meetsCutoff, type QualityProfile } from '../lib/profiles.js';
import type { EpisodeRow, Monitor, Released, SeasonRow } from '../persistence/library-store.js';

// Wanted and search timing for movies, and which of a show's seasons and episodes are followed (docs/ARR-REPLACEMENT.md, "Wanted" and "Search timing"). Pure: the library
// reads the rows and Plex, these say what follows.

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// A miss waits 1, 2, 4, then 7 days; a title long out (LONG_OUT) that still misses after that, 14 days from the 9th
// miss and 30 from the 11th, as RSS still catches it. Anything that could change a search's outcome (a new profile,
// Monitored or Resume, Search now, new release dates or status) starts the misses over (Library.searchAfresh).
export const MISS_BACKOFF_DAYS = [1, 2, 4, 7, 7, 7, 7, 7, 14, 14, 30] as const;
export const LONG_OUT = 90 * DAY;
export const missBackoff = (misses: number, longOut = false) => {
  const days = MISS_BACKOFF_DAYS[Math.min(Math.max(misses, 1), MISS_BACKOFF_DAYS.length) - 1]!;
  return Math.min(days, longOut ? days : 7) * DAY;
};
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

// Whether tk.box has a movie or an episode: its own file, else Plex holding it (copied in by hand, or an import tk.box
// never recorded), else none. The one rule wanted, the library's state, Calendar, request labels and Clean Up share.
export type Have = 'file' | 'plex' | 'none';
export const have = (item: { file?: unknown; inPlex?: boolean }): Have => item.file ? 'file' : item.inPlex ? 'plex' : 'none';

// Wanted when monitored and not paused, and either nothing is on the server, or tk.box's file is below the cutoff: in a
// fallback tier (an early copy always is). A score under the profile's upgrade-until isn't searched for: the upgrade is
// taken when a search or the RSS feed finds it. A file Plex has that tk.box never recorded is taken as the movie.
export function movieWanted(state: MovieState, profile: QualityProfile): Wanted {
  if (state.monitor === 'none') return { wanted: false, why: 'unmonitored' };
  if (state.paused) return { wanted: false, why: 'paused' };
  return fileOrPlex(state, profile);
}
// A file below the cutoff is wanted for an upgrade; one Plex holds that tk.box has no file for is had.
function fileOrPlex(item: { file?: { quality: Quality }; inPlex?: boolean }, profile: QualityProfile): Wanted {
  switch (have(item)) {
    case 'file': return meetsCutoff(profile, item.file!.quality) ? { wanted: false, why: 'have' } : { wanted: true, why: 'cutoff' };
    case 'plex': return { wanted: false, why: 'have' };
    case 'none': return { wanted: true, why: 'missing' };
  }
}

const dayStart = (day: string | undefined) => { const at = day ? Date.parse(`${day}T00:00:00Z`) : NaN; return Number.isFinite(at) ? at : undefined; };
// When the movie can be had at home: its digital release, or its physical one when that came first.
export function homeRelease(released: Released) {
  const digital = dayStart(released.digital), physical = dayStart(released.physical);
  return digital === undefined ? physical : physical === undefined ? digital : Math.min(digital, physical);
}
// No dates at all and TMDB doesn't call it released (Planned, In Production…): not out, and not searched for until TMDB
// dates it or marks it released (the daily refresh then starts its searches over). No status (an older row) or
// Released: taken as out, as an old film TMDB never dated is.
export const unreleasedUndated = (released: Released) =>
  !released.theatrical && !released.digital && !released.physical && released.status !== undefined && released.status !== 'Released';
// A refresh that changes when the movie may be searched: new dates, or TMDB starting or stopping to call it released.
// A status first seen (a row from before statuses were kept) changes nothing by itself.
export function releaseChanged(before: Released, after: Released) {
  const days = (r: Released) => `${r.theatrical ?? ''}|${r.digital ?? ''}|${r.physical ?? ''}`;
  if (days(before) !== days(after)) return true;
  return before.status !== undefined && (before.status === 'Released') !== (after.status === 'Released');
}

// Out at home: a digital or physical release that has happened, or (with neither known) a theatrical one long enough
// ago, or no dates at all unless TMDB says it isn't released.
export function isOut(released: Released, now: number) {
  const home = homeRelease(released);
  if (home !== undefined) return home <= now;
  const theatrical = dayStart(released.theatrical);
  if (theatrical === undefined) return !unreleasedUndated(released);
  return theatrical + THEATRICAL_GRACE <= now;
}

// `earlyCopies`: the movie's own switch.
export type TimingInput = { now: number; released: Released; earlyCopies: boolean; file?: { quality: Quality } };

// Never before the cinema release: nothing worth having is out sooner, Early copies or not.
export const beforeCinemas = (released: Released, now: number) => { const at = dayStart(released.theatrical); return at !== undefined && at > now ? at : undefined; };

// On request or add: at once when the movie is out. Not out: from its cinema release with Early copies on, else from
// its home release (with no home date yet, a week on but not before cinemas), with RSS only until then.
// Undated and not released: looked at again a day on, after TMDB's daily refresh, with no indexer search till it's dated.
export function firstSearchAt(input: TimingInput): number {
  if (unreleasedUndated(input.released)) return input.now + DAY;
  if (isOut(input.released, input.now)) return input.now;
  const cinemas = beforeCinemas(input.released, input.now);
  if (input.earlyCopies) return cinemas ?? input.now;
  return homeRelease(input.released) ?? Math.max(input.now + MISS_BACKOFF_DAYS[3] * DAY, cinemas ?? 0);
}

// After a search that found nothing to grab (`misses` counts it). The backoff, then:
// - not before the cinema release;
// - not out with Early copies off: not before the home release;
// - an early copy on disk: at most 12 hours (Early copies);
// - from the home release: every 6 hours for 3 days, when the good copies appear;
// - and never past the home release while waiting for it.
export function nextSearchAt(input: TimingInput & { misses: number }): number {
  const { now, released, earlyCopies, file } = input;
  if (unreleasedUndated(released)) return now + DAY;
  const home = homeRelease(released);
  let next = now + missBackoff(input.misses, isOut(released, now - LONG_OUT));
  const cinemas = beforeCinemas(released, now);
  if (earlyCopies && cinemas !== undefined) return cinemas;
  if (!earlyCopies && !isOut(released, now) && home !== undefined) return home;
  if (earlyCopies && file && EARLY_COPIES.has(file.quality)) next = Math.min(next, now + EARLY_COPY_EVERY);
  if (home !== undefined && home <= now && now < home + RELEASE_WINDOW) next = Math.min(next, now + RELEASE_EVERY);
  if (home !== undefined && home > now) next = Math.min(next, home);
  return cinemas === undefined ? next : Math.max(next, cinemas);
}

// ---- Shows: which seasons and episodes are followed ----

// TMDB gives an episode's air date, not its time. Without TVmaze's exact time (providers/tvmaze.ts) it counts as aired
// at the end of that day in US Pacific time (08:00 UTC the next day), when an episode shown anywhere in the US that day
// is out. RSS picks up anything sooner.
const AIRED_AFTER = DAY + 8 * HOUR;
export const airedAt = (airDate: string | undefined) => { const day = dayStart(airDate); return day === undefined ? undefined : day + AIRED_AFTER; };
// When an episode counts as aired (library_episodes.air_at): TVmaze's exact time where known, else the guess above.
// The one place that decides it; the library stores only what it gives.
export const episodeAiredAt = (e: { airDate?: string | undefined; airTime?: number | undefined }) => e.airTime ?? airedAt(e.airDate);

// A show's airings as the artwork engine's status banners read them (TMDB's last_episode_to_air, next_episode_to_air
// and each season's air_date, apps/artwork show_details), from the library's own air times so the banners agree with
// when tk.box grabs: TVmaze's exact time where known (a streamer's day ahead of the broadcast TMDB lists), as a US
// Pacific day like the aired guess above, not the server's (UTC would make a 9 pm ET Sunday episode Monday's); else
// TMDB's day. Aired is episodeAiredAt's call (the stored airAt), or `held`: an episode tk.box or Plex has is out
// whatever the listings say, as of today at the latest.
export type AiringDay = { season_number: number; episode_number: number; air_date: string };
export type ShowAirings = { last?: AiringDay; next?: AiringDay; seasons: Record<string, string> };
const pacific = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export const pacificDay = (at: number) => pacific.format(at);
export function showAirings(episodes: readonly { season: number; episode: number; airDate?: string; airAt: number; airTime?: number; held?: boolean }[], now: number,
  dayOf: (at: number) => string = pacificDay): ShowAirings {
  const out: ShowAirings = { seasons: {} }, today = dayOf(now);
  let last: { at: number; e: AiringDay } | undefined, next: { at: number; e: AiringDay } | undefined;
  const order = (a: AiringDay, b: AiringDay) => a.season_number - b.season_number || a.episode_number - b.episode_number;
  for (const e of episodes) {
    const listed = e.airTime !== undefined ? dayOf(e.airTime) : e.airDate;
    if (!listed || e.season < 1) continue;
    const early = e.held && e.airAt > now, day = early && listed > today ? today : listed, at = early ? now : e.airAt;
    const entry = { season_number: e.season, episode_number: e.episode, air_date: day }, key = String(e.season);
    if (!out.seasons[key] || day < out.seasons[key]) out.seasons[key] = day;
    if (at <= now) { if (!last || at > last.at || (at === last.at && order(entry, last.e) > 0)) last = { at, e: entry }; }
    else if (!next || at < next.at || (at === next.at && order(entry, next.e) < 0)) next = { at, e: entry };
  }
  if (last) out.last = last.e;
  if (next) out.next = next.e;
  return out;
}

// A show's follow mode (docs/ARR-REPLACEMENT.md, "Wanted"): `monitorFrom` for Future, `chosen` for Manual's seasons.
export type ShowFollow = { monitor: Monitor; monitorFrom?: number; chosen?: readonly number[] };
export type EpisodeFact = Omit<EpisodeRow, 'monitored'>;

// The monitored flags after a TMDB refresh. Seasons and episodes already stored keep theirs (an admin may have
// switched them); the first time, every season follows the mode. Later, a new season is followed only under All (or
// Future, when it airs after `monitorFrom`): First, Last and Manual stay on the seasons they were given. A new episode
// follows its season, and under Future only when it airs after `monitorFrom` (or has no date yet). Seasons `chosen` (a
// request's) decide the first time under any mode, in full: their episodes are all followed, aired or not.
export function followEpisodes(follow: ShowFollow, tmdb: { seasons: readonly number[]; episodes: readonly EpisodeFact[] },
  stored: { seasons: readonly SeasonRow[]; episodes: readonly Pick<EpisodeRow, 'season' | 'episode' | 'monitored'>[] }) {
  const numbers = [...new Set([...tmdb.seasons, ...tmdb.episodes.map(e => e.season)])].filter(n => n > 0).sort((a, b) => a - b);
  const first = stored.seasons.length === 0;
  const after = (e: Pick<EpisodeFact, 'airAt'>) => e.airAt === undefined || follow.monitorFrom === undefined || e.airAt > follow.monitorFrom;
  const newSeason = (season: number) => {
    if (first && follow.chosen) return follow.chosen.includes(season);
    switch (follow.monitor) {
      case 'all': return true;
      case 'future': return tmdb.episodes.every(e => e.season !== season) || tmdb.episodes.some(e => e.season === season && after(e));
      case 'first': return first && season === numbers[0];
      case 'last': return first && season === numbers[numbers.length - 1];
      case 'manual': return first && !!follow.chosen?.includes(season);
      case 'none': return false;
    }
  };
  const oldSeasons = new Map(stored.seasons.map(s => [s.season, s.monitored]));
  const seasons: SeasonRow[] = numbers.map(season => ({ season, monitored: oldSeasons.get(season) ?? newSeason(season) }));
  const seasonOn = new Map(seasons.map(s => [s.season, s.monitored]));
  const oldEpisodes = new Map(stored.episodes.map(e => [`${e.season}:${e.episode}`, e.monitored]));
  const episodes: EpisodeRow[] = tmdb.episodes.filter(e => e.season > 0).map(e => ({ ...e,
    monitored: oldEpisodes.get(`${e.season}:${e.episode}`) ?? (!!seasonOn.get(e.season)
      && (follow.monitor !== 'future' || after(e) || (first && !!follow.chosen?.includes(e.season)))) }));
  return { seasons, episodes };
}

// TMDB's statuses for a show that won't air again: refreshed weekly instead of daily.
export const showEnded = (released: Released) => released.status === 'Ended' || released.status === 'Canceled';

// ---- Shows: wanted episodes and what to search ----

// `inPlex`: Plex holds the episode (the Plex index, for followed shows).
export type ShowEpisodeState = Pick<EpisodeRow, 'season' | 'episode' | 'airAt' | 'monitored'> & { file?: { quality: Quality }; inPlex?: boolean };

// An episode is wanted on the movie rules once it has aired: monitored (and its season), the show not paused, and
// neither a file (tk.box's records, library_file_episodes) nor Plex holding it, or a file below the cutoff.
export function episodeWanted(show: { monitor: Monitor; paused: boolean }, seasonMonitored: boolean, episode: ShowEpisodeState, profile: QualityProfile, now: number): Wanted {
  if (show.monitor === 'none' || !seasonMonitored || !episode.monitored) return { wanted: false, why: 'unmonitored' };
  if (show.paused) return { wanted: false, why: 'paused' };
  if (episode.airAt === undefined || episode.airAt > now) return { wanted: false, why: 'unmonitored' };
  return fileOrPlex(episode, profile);
}

// A search scope, as `searches.scope` keeps it: S02 (a season, pack first) or S02E05.
export type ShowScope = { scope: string; season: number; episode?: number; episodes: number[] };
export const scopeName = (season: number, episode?: number) => `S${String(season).padStart(2, '0')}${episode === undefined ? '' : `E${String(episode).padStart(2, '0')}`}`;
// Episodes in a word, as Admin shows a grab or a file: S02 for a whole season (more than one episode), else runs
// such as S02E05, S02E05–E07 or S02E01+E03; seasons joined by commas. `seasonSize`: how many episodes a season has.
export function episodesLabel(refs: readonly (readonly [number, number])[], seasonSize?: (season: number) => number) {
  const bySeason = new Map<number, Set<number>>();
  for (const [s, e] of refs) bySeason.set(s, (bySeason.get(s) ?? new Set()).add(e));
  const pad = (n: number) => String(n).padStart(2, '0');
  return [...bySeason].sort((a, b) => a[0] - b[0]).map(([season, set]) => {
    const episodes = [...set].sort((a, b) => a - b), size = seasonSize?.(season);
    if (size && episodes.length > 1 && episodes.length >= size) return scopeName(season);
    const runs: string[] = [];
    let start = episodes[0]!, last = start;
    for (const e of [...episodes.slice(1), undefined]) {
      if (e === last + 1) { last = e; continue; }
      runs.push(start === last ? `E${pad(start)}` : `E${pad(start)}–E${pad(last)}`);
      if (e !== undefined) start = last = e;
    }
    return `${scopeName(season)}${runs.join('+')}`;
  }).join(', ');
}
export function parseScope(scope: string): { season: number; episode?: number } | undefined {
  const m = /^S(\d{2,})(?:E(\d{2,}))?$/.exec(scope);
  return m ? { season: Number(m[1]), ...(m[2] ? { episode: Number(m[2]) } : {}) } : undefined;
}

// What to search for a show. A season that has finished airing, with every monitored episode wanted and at least two
// of them, is searched as one (a pack first: the season search also returns its episodes). Otherwise each wanted
// episode on its own. Episodes with a grab under way are left out.
export function showScopes(show: { monitor: Monitor; paused: boolean }, seasons: readonly SeasonRow[], episodes: readonly ShowEpisodeState[],
  profile: QualityProfile, now: number, grabbing: readonly (readonly [number, number])[] = []): ShowScope[] {
  const busy = new Set(grabbing.map(([s, e]) => `${s}:${e}`)), on = new Map(seasons.map(s => [s.season, s.monitored]));
  const scopes: ShowScope[] = [];
  for (const season of seasons) {
    const all = episodes.filter(e => e.season === season.season);
    const wanted = all.filter(e => !busy.has(`${e.season}:${e.episode}`) && episodeWanted(show, !!on.get(e.season), e, profile, now).wanted).map(e => e.episode);
    if (!wanted.length) continue;
    const monitored = all.filter(e => e.monitored);
    const finished = all.length > 0 && all.every(e => e.airAt !== undefined && e.airAt <= now);
    if (finished && wanted.length >= 2 && wanted.length === monitored.length) { scopes.push({ scope: scopeName(season.season), season: season.season, episodes: wanted }); continue; }
    for (const episode of wanted) scopes.push({ scope: scopeName(season.season, episode), season: season.season, episode, episodes: [episode] });
  }
  return scopes;
}

// New episodes: searched 15 minutes after they air (uploads of a big show are up by then), at 1 hour and at 6 hours,
// then on the backoff. A season, or an episode that aired long ago, is searched at once.
export const AIRED_SEARCHES = [15 * MINUTE, 1 * HOUR, 6 * HOUR] as const;
export function firstEpisodeSearchAt(now: number, airAt?: number) {
  return airAt === undefined ? now : Math.max(now, airAt + AIRED_SEARCHES[0]);
}
// `lastAiredAt`: for a season, when its last episode aired (an episode's own air time otherwise).
export function nextEpisodeSearchAt(input: { now: number; misses: number; airAt?: number; lastAiredAt?: number }) {
  const { now, misses, airAt } = input, aired = input.lastAiredAt ?? airAt;
  const next = airAt === undefined ? undefined : AIRED_SEARCHES.map(after => airAt + after).find(at => at > now);
  return next ?? now + missBackoff(misses, aired !== undefined && aired <= now - LONG_OUT);
}
