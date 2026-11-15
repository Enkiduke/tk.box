import type {TmdbExploreRow} from './index.js';

const personal = {
  freshness:100, genreAffinity:40, eraAffinity:40, audienceRating:40, ratingPriorVotes:200, shuffle:15, recommendationDecay:8, variety:1
};
const top = {...personal, watchRankRetention:90, watchHalfLife:180, watchFrequency:100, seedDiversity:1};
const upcoming = {nearPopularity:125, midPopularity:112.5, futureDays:547};

export const exploreRankingDefaults = {
  'popular-movies': {releaseBoost:0, releaseDays:90, audienceRating:0},
  'popular-shows': {releaseBoost:0, releaseDays:90, seasonBoost:0, seasonDays:90, audienceRating:0},
  'popular-streaming': {},
  'recent-streaming': {releaseDays:180},
  trending: {trendingDays:7},
  acclaimed: {releaseDays:365, minimumRating:7.2, minimumVotes:50},
  'upcoming-movies': upcoming,
  'upcoming-shows': upcoming,
  'top-movies': top,
  'top-shows': top,
  'because-movie': personal,
  'because-show': personal
} satisfies Record<TmdbExploreRow, object>;

type Defaults = typeof exploreRankingDefaults;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
export type ExploreRankingField = KeysOfUnion<Defaults[TmdbExploreRow]>;
export type ExploreRowRanking = Partial<Record<ExploreRankingField, number>>;
export type ExploreRanking = Partial<{[Row in TmdbExploreRow]: Partial<Defaults[Row]>}>;

export const exploreRankingFields: Record<ExploreRankingField, {min:number; max:number; step:number}> = {
  releaseBoost:{min:0,max:200,step:1}, releaseDays:{min:1,max:1095,step:1},
  seasonBoost:{min:0,max:200,step:1}, seasonDays:{min:1,max:365,step:1},
  audienceRating:{min:0,max:100,step:1}, minimumRating:{min:0,max:10,step:0.1}, minimumVotes:{min:0,max:10000,step:1},
  nearPopularity:{min:0,max:300,step:0.5}, midPopularity:{min:0,max:300,step:0.5}, futureDays:{min:90,max:1095,step:1},
  trendingDays:{min:1,max:7,step:6}, freshness:{min:0,max:200,step:1}, genreAffinity:{min:0,max:100,step:1},
  eraAffinity:{min:0,max:100,step:1}, ratingPriorVotes:{min:1,max:10000,step:1}, shuffle:{min:0,max:100,step:1},
  recommendationDecay:{min:1,max:100,step:1}, watchRankRetention:{min:1,max:100,step:1},
  watchHalfLife:{min:1,max:3650,step:1}, watchFrequency:{min:0,max:200,step:1},
  variety:{min:0,max:1,step:1}, seedDiversity:{min:0,max:1,step:1}
};

export function exploreRankingFor<Row extends TmdbExploreRow>(row: Row, ranking?: ExploreRanking): Defaults[Row] {
  return {...exploreRankingDefaults[row], ...ranking?.[row]};
}
