// Explore's layout and ranking as saved before rows became definitions: the source order, hidden sources and rows,
// the TMDB row order and each row's ranking settings in one record. Read once, by the explore-rows migration.
import {builtInRows,exploreSignal,normalizeRowDef,setSignal,type BuiltInRow,type ExploreParamValue,type ExploreRowDef,type ExploreSignalId} from '../../../../../packages/contracts/src/explore-rows.js';
import {exploreRankingFor,exploreSignalsFor,exploreRankingSignals,type ExploreRankingOptions,type ExploreRowRanking} from './legacy-ranking.js';

export type LegacyLayout = {order: string[]; hidden: string[]; hiddenRows: string[]; tmdbOrder?: string[]; ranking?: Record<string, unknown>};
type LegacySignal = keyof typeof exploreRankingSignals;

// Each old signal as its new one, with each new parameter's old field.
const signals: Partial<Record<LegacySignal, {id: ExploreSignalId; params: Record<string, keyof ExploreRowRanking>}>> = {
  releaseRecency:{id:'recentRelease', params:{boost:'releaseBoost', days:'releaseBoostDays'}},
  freshness:{id:'freshness', params:{boost:'freshness', fullDays:'freshnessFullDays', endDays:'freshnessEndDays'}},
  seasonRecency:{id:'newSeason', params:{boost:'seasonBoost', days:'seasonDays'}},
  popularity:{id:'popularity', params:{strength:'popularityBoost'}},
  audience:{id:'audience', params:{strength:'audienceRating', priorVotes:'ratingPriorVotes'}},
  genre:{id:'genreAffinity', params:{strength:'genreAffinity'}},
  era:{id:'eraAffinity', params:{strength:'eraAffinity'}},
  matchRank:{id:'matchPosition', params:{decay:'recommendationDecay'}},
  watchRank:{id:'watchOrder', params:{retention:'watchRankRetention'}},
  watchRecency:{id:'watchRecency', params:{halfLife:'watchHalfLife'}},
  watchFrequency:{id:'watchFrequency', params:{strength:'watchFrequency'}},
  variety:{id:'variety', params:{}},
  seedDiversity:{id:'spread', params:{}},
  shuffle:{id:'shuffle', params:{strength:'shuffle'}},
  upcoming:{id:'upcomingProximity', params:{near:'nearPopularity', nearDays:'nearDays', mid:'midPopularity', midDays:'midDays'}},
  minimumRating:{id:'minRating', params:{rating:'minimumRating'}},
  minimumVotes:{id:'minVotes', params:{votes:'minimumVotes'}},
  releaseWindow:{id:'releasedWithin', params:{days:'releaseDays'}},
  upcomingWindow:{id:'upcomingWithin', params:{days:'futureDays'}}
};

// A built-in row with its old ranking settings, as a definition with the same effect: each old signal is on when its
// resolved values do something, with those values.
export function legacyRowDef(row: BuiltInRow, options?: ExploreRankingOptions): ExploreRowDef {
  const base: ExploreRowDef = builtInRows[row];
  const values = exploreRankingFor(row, options ? {[row]:options} : undefined) as ExploreRowRanking;
  let def: ExploreRowDef = {...base, signals:[]};
  if (def.source.type === 'tmdb-trending') def = {...def, source:{...def.source, window:values.trendingDays === 1 ? 'day' : 'week'}};
  for (const old of exploreSignalsFor(row)) {
    const map = signals[old];
    if (!map || !exploreSignal(map.id).applies(def.source)) continue;
    const neutral = Object.entries(exploreRankingSignals[old].neutral) as [keyof ExploreRowRanking, number][];
    const on = old === 'seedDiversity' ? values.seedDiversity === 1 : !neutral.every(([field, value]) => values[field] === value);
    if (!on) continue;
    const params: Record<string, ExploreParamValue> = {...exploreSignal(map.id).defaults};
    for (const [param, field] of Object.entries(map.params)) if (typeof values[field] === 'number') params[param] = values[field];
    def = setSignal(def, {id:map.id, on:true, params});
  }
  return normalizeRowDef(def);
}

const renamedRows: Record<string, string[]> = {'top-picks':['top-movies', 'top-shows'], 'because-1':['because-movie'], 'because-2':['because-show'], 'genre-1':[], 'genre-2':[]};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const renamed = (list: string[], prefix = '') => [...new Set(list.flatMap(id => {
  if (!id.startsWith(prefix)) return [id];
  return renamedRows[id.slice(prefix.length)]?.map(row => prefix + row) ?? [id];
}))];
const retired = (id: string) => /^(trakt|seerr)(:|$)/.test(id);
// The saved record, with retired sources and renamed rows sorted out. Nothing saved: Plex's watchlist hidden.
export function legacyLayout(value: unknown): LegacyLayout {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const order = strings(saved.order ?? ['tmdb', 'plex']).filter(s => s === 'tmdb' || s === 'plex');
  return {order:[...new Set([...order, 'tmdb', 'plex'])], hidden:strings(saved.hidden).filter(s => !retired(s)),
    hiddenRows:renamed(strings(saved.hiddenRows ?? ['plex:watchlist']).filter(s => !retired(s)), 'tmdb:'),
    tmdbOrder:saved.tmdbOrder === undefined ? undefined : renamed(strings(saved.tmdbOrder)),
    ranking:saved.ranking && typeof saved.ranking === 'object' ? saved.ranking as Record<string, unknown> : undefined};
}
