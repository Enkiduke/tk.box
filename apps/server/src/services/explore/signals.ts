// What each Explore signal does (packages/contracts/src/explore-rows.ts lists them): filters as TMDB query parameters
// and as tests on fetched titles, boosts as score terms. Every TMDB row runs through these; the sources
// (providers/tmdb-explore.ts, explore-recommendations.ts) supply the base score and the candidates.
import {list,num,signalActive,signalValues,type ExploreParamValue,type ExploreRowDef,type ExploreSignalId} from '../../../../../packages/contracts/src/explore-rows.js';
import type {ExploreGenre} from '../../../../../packages/contracts/src/index.js';
import {tmdbGenreIds} from '../../providers/explore-genres.js';

const DAY = 86400000;
const date = (value: number) => new Date(value).toISOString().slice(0, 10);
// A title fetched for a row: its card, TMDB's vote count and popularity, its release day and a show's latest season premiere.
export type Candidate = {item: import('../../../../../packages/contracts/src/index.js').ExploreItem; votes: number; popularity: number; date?: string; seasonPremiere?: string};
export type Values = Record<string, ExploreParamValue>;

// A row ready to run: each signal's values (neutral when off) and whether it is on with an effect.
export type Plan = {def: ExploreRowDef; values: (id: ExploreSignalId) => Values; active: (id: ExploreSignalId) => boolean};
export function plan(def: ExploreRowDef): Plan {
  const values = new Map<ExploreSignalId, Values>();
  return {def, values:id => {let v = values.get(id); if (!v) values.set(id, v = signalValues(def, id)); return v;}, active:id => signalActive(def, id)};
}

// TMDB's score as a multiplier around 1 (±strength), pulled toward 6.5 until about `priorVotes` votes.
export function audienceQuality(candidate: Candidate, strength: number, priorVotes = 200) {
  const rating = ((candidate.item.rating ?? 0) * candidate.votes + 6.5 * priorVotes) / (candidate.votes + priorVotes);
  return 1 + strength * (2 * Math.min(1, Math.max(0, (rating - 5.5) / 2.5)) - 1);
}
// A lift of up to `strength`% that fades to nothing over `days` after `day`.
export function recentBoost(day: string | undefined, now: number, days: number, strength: number) {
  const age = (now - Date.parse(day ?? '')) / DAY;
  return Number.isFinite(age) && age >= 0 ? Math.max(0, 1 - age / days) * strength / 100 : 0;
}
export const popularityMultiplier = (candidate: Candidate, strength: number) => {
  const popularity = Math.max(0, candidate.popularity);
  return 1 + strength / 100 * popularity / (popularity + 50);
};
// How new a title is: 1 for its first `fullDays`, fading to 0 at `endDays`; something not out yet counts a little.
export function freshness(day: string | undefined, now: number, fullDays = 182, endDays = 1095) {
  if (!day) return 0;
  const age = (now - Date.parse(day)) / DAY;
  if (!Number.isFinite(age)) return 0;
  if (age < 0) return 0.3;
  return age <= fullDays ? 1 : Math.max(0, 1 - (age - fullDays) / (endDays - fullDays));
}

// Filters TMDB's discover endpoint can apply itself.
export function filterQuery(p: Plan, type: 'movie' | 'tv'): Record<string, string> {
  const query: Record<string, string> = {};
  if (p.active('minRating')) query['vote_average.gte'] = String(num(p.values('minRating'), 'rating'));
  if (p.active('minVotes')) query['vote_count.gte'] = String(num(p.values('minVotes'), 'votes'));
  const genres = p.active('genres') ? tmdbGenreIds(list(p.values('genres'), 'genres')) : [];
  if (genres.length) query.with_genres = genres.join('|');
  const languages = p.active('languages') ? list(p.values('languages'), 'languages') : [];
  if (languages.length) query.with_original_language = languages.join('|');
  void type;
  return query;
}
// The release-date range a discover query keeps: the release window and the year range, within `lower`/`upper` if given.
// `seasons`: the release window is left to an episode air-date range instead (see countsSeasons).
export function dateRange(p: Plan, now: number, lower?: string, upper?: string, seasons = false) {
  let gte = lower, lte = upper;
  const later = (a: string | undefined, b: string) => !a || b > a ? b : a, earlier = (a: string | undefined, b: string) => !a || b < a ? b : a;
  if (p.active('releasedWithin') && !seasons) gte = later(gte, date(now - num(p.values('releasedWithin'), 'days') * DAY));
  if (p.active('years')) {
    const v = p.values('years');
    gte = later(gte, `${num(v, 'from')}-01-01`); lte = earlier(lte, `${num(v, 'to')}-12-31`);
  }
  return {gte, lte};
}
// Released within, with new seasons counted: a show also passes when its latest season (2 on) premiered in the window.
export const countsSeasons = (p: Plan) => p.active('releasedWithin') && num(p.values('releasedWithin'), 'seasons') === 1;
export function releasedWithin(p: Plan, c: Candidate, now: number) {
  const days = num(p.values('releasedWithin'), 'days');
  const within = (day?: string) => {const age = (now - Date.parse(day ?? '')) / DAY; return Number.isFinite(age) && age >= 0 && age <= days;};
  return within(c.date) || (countsSeasons(p) && c.item.kind === 'show' && within(c.seasonPremiere));
}
// Filters on a fetched title, for sources TMDB can't filter (trending, recommendations) and what a query left out.
export function passesFilters(p: Plan, c: Candidate, now: number, skip: ExploreSignalId[] = []) {
  const on = (id: ExploreSignalId) => !skip.includes(id) && p.active(id);
  if (on('minRating') && (c.item.rating ?? 0) < num(p.values('minRating'), 'rating')) return false;
  if (on('minVotes') && c.votes < num(p.values('minVotes'), 'votes')) return false;
  if (on('releasedWithin') && !releasedWithin(p, c, now)) return false;
  if (on('genres')) {
    const genres = list(p.values('genres'), 'genres');
    if (genres.length && !c.item.genres?.some(g => genres.includes(g as ExploreGenre))) return false;
  }
  if (on('languages')) {
    const languages = list(p.values('languages'), 'languages');
    if (languages.length && (!c.item.language || !languages.includes(c.item.language))) return false;
  }
  if (on('years')) {
    const v = p.values('years'), year = c.item.year;
    if (!year || year < num(v, 'from') || year > num(v, 'to')) return false;
  }
  return true;
}

// What scoring a title may draw on beyond the title itself: the viewer's taste (recommendations) and a daily roll.
export type ScoreContext = {now: number; genreShare?: (c: Candidate) => number; era?: (year?: number) => number; roll?: number};
type Boost = {add?: (c: Candidate, v: Values, ctx: ScoreContext) => number; mul?: (c: Candidate, v: Values, ctx: ScoreContext) => number};
const boosts: Partial<Record<ExploreSignalId, Boost>> = {
  recentRelease: {add:(c, v, ctx) => recentBoost(c.date, ctx.now, num(v, 'days'), num(v, 'boost'))},
  freshness: {add:(c, v, ctx) => num(v, 'boost') / 100 * freshness(c.date, ctx.now, num(v, 'fullDays'), num(v, 'endDays'))},
  newSeason: {add:(c, v, ctx) => recentBoost(c.seasonPremiere, ctx.now, num(v, 'days'), num(v, 'boost'))},
  eraAffinity: {mul:(c, _v, ctx) => ctx.era?.(c.item.year) ?? 1},
  genreAffinity: {mul:(c, v, ctx) => 1 + num(v, 'strength') / 100 * (ctx.genreShare?.(c) ?? 0)},
  audience: {mul:(c, v) => audienceQuality(c, num(v, 'strength') / 100, num(v, 'priorVotes'))},
  popularity: {mul:(c, v) => popularityMultiplier(c, num(v, 'strength'))},
  shuffle: {mul:(_c, v, ctx) => 1 + num(v, 'strength') / 100 * (2 * (ctx.roll ?? 0.5) - 1)}
};
const order = Object.keys(boosts) as ExploreSignalId[];
// The boosts a row has on, of those this source scores with.
export const scoring = (p: Plan, allowed: readonly ExploreSignalId[] = order) => order.filter(id => allowed.includes(id) && p.active(id));
// A title's score: its base × (1 + the added terms) × each multiplier, in a fixed order. The base when no boost is on.
export function boostScore(p: Plan, c: Candidate, ctx: ScoreContext, ids = scoring(p), base = 1) {
  let lift = 1;
  for (const id of ids) {const add = boosts[id]!.add; if (add) lift += add(c, p.values(id), ctx);}
  let score = base * lift;
  for (const id of ids) {const mul = boosts[id]!.mul; if (mul) score *= mul(c, p.values(id), ctx);}
  return score;
}
// The added terms alone, for a discover source's promoted titles (those count only when a boost lifts them).
export function boostAdded(p: Plan, c: Candidate, ctx: ScoreContext, ids = scoring(p)) {
  let add = 0;
  for (const id of ids) add += boosts[id]!.add?.(c, p.values(id), ctx) ?? 0;
  return add;
}
