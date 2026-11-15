import type {TmdbExploreRow} from './index.js';

const minimums = {minimumRating:0, minimumVotes:0};
const audience = {audienceRating:0, ratingPriorVotes:200};
const release = {releaseBoost:0, releaseBoostDays:90};
const season = {seasonBoost:0, seasonDays:90};
const personal = {
  ...minimums, ...season, freshness:100, freshnessFullDays:182, freshnessEndDays:1095, genreAffinity:40, eraAffinity:40,
  audienceRating:40, ratingPriorVotes:200, shuffle:15, recommendationDecay:8, variety:1, popularityBoost:0
};
const top = {...personal, watchRankRetention:90, watchHalfLife:180, watchFrequency:100, seedDiversity:1};
const upcoming = {...minimums, ...audience, nearPopularity:125, midPopularity:112.5, nearDays:44, midDays:89, futureDays:547};

export const exploreRankingDefaults = {
  'popular-movies': {...minimums, ...audience, ...release},
  'popular-shows': {...minimums, ...audience, ...release, ...season},
  'popular-streaming': {...minimums, ...audience, ...release, ...season},
  'recent-streaming': {...minimums, ...audience, ...release, ...season, releaseDays:180, popularityBoost:0},
  trending: {...minimums, ...audience, ...release, ...season, trendingDays:7, popularityBoost:0},
  acclaimed: {...audience, ...release, ...season, releaseDays:365, minimumRating:7.2, minimumVotes:50, popularityBoost:0},
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
export type ExploreRanking = Partial<Record<TmdbExploreRow, ExploreRankingOptions>>;

const exploreRankingFields: Record<ExploreRankingField, {min:number; max:number; step:number}> = {
  releaseBoost:{min:0,max:200,step:1}, releaseBoostDays:{min:1,max:1095,step:1}, releaseDays:{min:1,max:1095,step:1},
  seasonBoost:{min:0,max:200,step:1}, seasonDays:{min:1,max:365,step:1},
  audienceRating:{min:0,max:100,step:1}, minimumRating:{min:0,max:10,step:0.1}, minimumVotes:{min:0,max:10000,step:1},
  nearPopularity:{min:0,max:300,step:0.5}, midPopularity:{min:0,max:300,step:0.5}, futureDays:{min:1,max:1095,step:1},
  nearDays:{min:0,max:1094,step:1}, midDays:{min:1,max:1095,step:1},
  trendingDays:{min:1,max:7,step:6}, freshness:{min:0,max:200,step:1}, genreAffinity:{min:0,max:100,step:1},
  eraAffinity:{min:0,max:100,step:1}, ratingPriorVotes:{min:1,max:10000,step:1}, shuffle:{min:0,max:100,step:1},
  recommendationDecay:{min:1,max:100,step:1}, watchRankRetention:{min:1,max:100,step:1},
  watchHalfLife:{min:1,max:3650,step:1}, watchFrequency:{min:0,max:200,step:1},
  variety:{min:0,max:1,step:1}, seedDiversity:{min:0,max:1,step:1},
  freshnessFullDays:{min:0,max:1824,step:1}, freshnessEndDays:{min:1,max:1825,step:1}, popularityBoost:{min:0,max:200,step:1}
};

const maxBefore:Partial<Record<ExploreRankingField,ExploreRankingField>> = {
  nearDays:'midDays', freshnessFullDays:'freshnessEndDays'
};
const minAfter:Partial<Record<ExploreRankingField,ExploreRankingField>> = {midDays:'nearDays',freshnessEndDays:'freshnessFullDays'};

export function exploreRankingBounds(field:ExploreRankingField, values:Partial<Record<ExploreRankingField,unknown>>) {
  const bounds=exploreRankingFields[field], before=maxBefore[field], after=minAfter[field];
  const lower=after?values[after]:undefined, upper=before?values[before]:undefined;
  return {min:typeof lower==='number'?Math.max(bounds.min,lower+1):bounds.min,
    max:typeof upper==='number'?Math.min(bounds.max,upper-1):bounds.max, step:bounds.step};
}

type Signal = {label:string; description:string; fields:ExploreRankingField[]; neutral:ExploreRowRanking; initial?:ExploreRowRanking};
export const exploreRankingSignals = {
  releaseRecency:{label:'Recent releases',description:'Boost recently released movies and new series.',fields:['releaseBoost','releaseBoostDays'],neutral:{releaseBoost:0},initial:{releaseBoost:25}},
  freshness:{label:'Title freshness',description:'Favor newer titles in recommendations.',fields:['freshness','freshnessFullDays','freshnessEndDays'],neutral:{freshness:0}},
  seasonRecency:{label:'New seasons',description:'Boost returning shows when a new regular season premieres.',fields:['seasonBoost','seasonDays'],neutral:{seasonBoost:0},initial:{seasonBoost:25}},
  popularity:{label:'TMDB popularity',description:'Favor titles with more engagement on TMDB.',fields:['popularityBoost'],neutral:{popularityBoost:0},initial:{popularityBoost:25}},
  audience:{label:'Audience rating',description:'Give more influence to ratings backed by more votes.',fields:['audienceRating','ratingPriorVotes'],neutral:{audienceRating:0},initial:{audienceRating:25}},
  genre:{label:'Genre affinity',description:'Favor genres the viewer watches.',fields:['genreAffinity'],neutral:{genreAffinity:0}},
  era:{label:'Release-era affinity',description:'Favor release years close to the viewer’s watch history.',fields:['eraAffinity'],neutral:{eraAffinity:0}},
  matchRank:{label:'TMDB recommendation position',description:'Give more influence to titles higher on each recommendation list.',fields:['recommendationDecay'],neutral:{recommendationDecay:0}},
  watchRank:{label:'Watch history order',description:'Give more influence to titles higher in watch history.',fields:['watchRankRetention'],neutral:{watchRankRetention:100}},
  watchRecency:{label:'Watch recency',description:'Reduce the influence of older watches over time.',fields:['watchHalfLife'],neutral:{watchHalfLife:0}},
  watchFrequency:{label:'Watch frequency',description:'Give more influence to titles watched more often.',fields:['watchFrequency'],neutral:{watchFrequency:0}},
  variety:{label:'Genre and franchise variety',description:'Space out similar titles when alternatives are available.',fields:['variety'],neutral:{variety:0}},
  seedDiversity:{label:'Variety across watched titles',description:'Spread recommendations across several watches.',fields:['seedDiversity'],neutral:{seedDiversity:0}},
  shuffle:{label:'Daily shuffle',description:'Vary the order a little each day.',fields:['shuffle'],neutral:{shuffle:0}},
  upcoming:{label:'Upcoming release proximity',description:'Apply different popularity multipliers to near-term releases.',fields:['nearPopularity','nearDays','midPopularity','midDays'],neutral:{nearPopularity:100,midPopularity:100}},
  trending:{label:'Trending chart window',description:'Choose which TMDB chart supplies the row. Weekly is the standard chart.',fields:['trendingDays'],neutral:{trendingDays:7}},
  minimumRating:{label:'Minimum rating',description:'Require a minimum TMDB audience rating.',fields:['minimumRating'],neutral:{minimumRating:0},initial:{minimumRating:7}},
  minimumVotes:{label:'Minimum votes',description:'Require a minimum number of TMDB votes.',fields:['minimumVotes'],neutral:{minimumVotes:0},initial:{minimumVotes:50}},
  releaseWindow:{label:'Release window',description:'Limit the row to titles released within this many days.',fields:['releaseDays'],neutral:{releaseDays:0}},
  upcomingWindow:{label:'Upcoming window',description:'Limit how far into the future the row looks.',fields:['futureDays'],neutral:{futureDays:0}}
} satisfies Record<string, Signal>;

export type ExploreSignalId = keyof typeof exploreRankingSignals;
export type ExploreRankingOptions = ExploreRowRanking & {signals?: Partial<Record<ExploreSignalId, boolean>>};
export const exploreSignalIds = Object.keys(exploreRankingSignals) as ExploreSignalId[];
export const exploreSignal = (id:ExploreSignalId):Signal => exploreRankingSignals[id];

export function exploreSignalsFor(row:TmdbExploreRow) {
  return exploreSignalIds.filter(id=>{
    if (id==='seasonRecency' && (row==='top-movies'||row==='because-movie')) return false;
    return exploreSignal(id).fields.every(field=>Object.hasOwn(exploreRankingDefaults[row],field));
  });
}

export function exploreSignalIsActive(id:ExploreSignalId, settings:ExploreRankingOptions | undefined, values:ExploreRowRanking) {
  return settings?.signals?.[id] ?? (id==='trending'||!Object.entries(exploreSignal(id).neutral).every(([field,value])=>values[field as ExploreRankingField]===value));
}

export function exploreRankingFor<Row extends TmdbExploreRow>(row: Row, ranking?: ExploreRanking): Defaults[Row] {
  const options:ExploreRankingOptions=ranking?.[row]??{};
  const {signals,...overrides}=options;
  const resolved:ExploreRowRanking={...exploreRankingDefaults[row],...overrides};
  if ((row==='popular-movies'||row==='popular-shows') && overrides.releaseBoostDays===undefined && overrides.releaseDays!==undefined) {
    resolved.releaseBoostDays=overrides.releaseDays;
  }
  for (const id of exploreSignalsFor(row)) {
    const signal=exploreSignal(id), enabled=signals?.[id];
    if (enabled===false) Object.assign(resolved,signal.neutral);
    if (enabled!==true) continue;
    if (id==='variety'||id==='seedDiversity') resolved[id]=1;
    for (const field of signal.fields) {
      const initial=signal.initial?.[field];
      if (initial!==undefined&&overrides[field]===undefined&&resolved[field]===signal.neutral[field]) resolved[field]=initial;
    }
  }
  return resolved as Defaults[Row];
}
