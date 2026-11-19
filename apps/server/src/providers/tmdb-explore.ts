import type {ExploreItem, ExplorePage, ExploreRowInfo, ExploreWatchProviders, TmdbExploreRow} from '../../../../packages/contracts/src/index.js';
import {exploreRankingFor,type ExploreRanking,type ExploreRowRanking} from '../../../../packages/contracts/src/explore-ranking.js';
import {requireThat} from '../errors.js';
import {TtlCache} from '../lib/ttl-cache.js';
import {tmdbImage} from './explore-images.js';
import {tmdbGenres} from './explore-genres.js';
import type {TitleKind, TmdbTitles} from './tmdb-titles.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const EXPLORE_PAGE_SIZE = 20;
const RANKED_PAGES = 5, RECENT_PAGES = 2;
export const tmdbRows: Record<TmdbExploreRow, ExploreRowInfo> = {
  'popular-streaming': {id:'popular-streaming', title:'Popular on Streaming', icon:'play', streaming:true},
  'recent-streaming': {id:'recent-streaming', title:'Recently Released on Streaming', icon:'play', streaming:true},
  'top-movies': {id:'top-movies', title:'Top Movie Picks for You', icon:'movies', personal:true},
  'top-shows': {id:'top-shows', title:'Top Show Picks for You', icon:'shows', personal:true},
  'because-movie': {id:'because-movie', title:'Because You Watched · Movie', icon:'star', personal:true},
  'because-show': {id:'because-show', title:'Because You Watched · Show', icon:'star', personal:true},
  trending: {id:'trending', title:'Trending Now', icon:'star'},
  acclaimed: {id:'acclaimed', title:'Critically Acclaimed New Releases', icon:'star'},
  'popular-movies': {id:'popular-movies', title:'Popular Movies', icon:'movies'},
  'popular-shows': {id:'popular-shows', title:'Popular Shows', icon:'shows'},
  'upcoming-movies': {id:'upcoming-movies', title:'Upcoming Movies', icon:'calendar'},
  'upcoming-shows': {id:'upcoming-shows', title:'Upcoming Shows', icon:'calendar'}
};
export type Candidate = {item: ExploreItem; votes: number; popularity: number; date?: string; seasonPremiere?:string};
type Result = {items: Candidate[]; pages: number};
type DiscoverSnapshot = {items:Candidate[]; seen:Set<string>; next:number; last:number; read:(page:number)=>Promise<Result>; pending?:Promise<void>};
type UpcomingBucket = {weight:number; params:Record<string,string>; page:number; result:Result; index:number};
type Provider = {provider_id: number; provider_name: string; logo_path?: string};
type Title = {
  id?: number; title?: string; name?: string; release_date?: string; first_air_date?: string; adult?: boolean;
  overview?: string; poster_path?: string; backdrop_path?: string; original_language?: string; genre_ids?: number[];
  vote_average?: number; vote_count?: number; popularity?: number;
};
const kinds = ['movie', 'tv'] as const;
const providerName = (name:string) => name.trim().toLowerCase().replace(/\s+/g,' ').replace(/\s+plus\b/g,'+').replace(/\s+\+/g,'+');
const services = [
  {names:['netflix']}, {names:['amazon prime video', 'prime video'], label:'Prime Video'},
  {names:['disney+'], label:'Disney+'}, {names:['hulu']}, {names:['max', 'hbo max']}, {names:['apple tv+', 'apple tv']},
  {names:['peacock premium', 'peacock premium+', 'peacock'], label:'Peacock'},
  {names:['paramount+', 'paramount+ essential', 'paramount+ premium', 'paramount+ with showtime', 'paramount+ showtime'], label:'Paramount+'},
  {names:['mgm+'], label:'MGM+'}, {names:['discovery+'], label:'Discovery+'}
];
const serviceLabels = new Map(services.flatMap(({names,label})=>label?names.map(name=>[name,label] as const):[]));
const date = (value: number) => new Date(value).toISOString().slice(0, 10);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function audienceQuality(candidate: Candidate, strength:number, priorVotes = 200) {
  const rating = ((candidate.item.rating ?? 0) * candidate.votes + 6.5 * priorVotes) / (candidate.votes + priorVotes);
  return 1 + strength * (2 * Math.min(1, Math.max(0, (rating - 5.5) / 2.5)) - 1);
}

export function recentBoost(day: string | undefined, now: number, days: number, strength: number) {
  const age = (now - Date.parse(day ?? '')) / DAY;
  return Number.isFinite(age) && age >= 0 ? Math.max(0, 1 - age / days) * strength / 100 : 0;
}

export const popularityMultiplier = (candidate:Candidate, strength:number) => {
  const popularity=Math.max(0,candidate.popularity);
  return 1 + strength/100 * popularity/(popularity+50);
};

export const passesRating = (candidate:Candidate, settings:ExploreRowRanking) =>
  (candidate.item.rating??0)>=(settings.minimumRating??0) && candidate.votes>=(settings.minimumVotes??0);

const ratingFilters = (settings:ExploreRowRanking):Record<string,string> => ({
  ...(settings.minimumRating&&{'vote_average.gte':String(settings.minimumRating)}),
  ...(settings.minimumVotes&&{'vote_count.gte':String(settings.minimumVotes)})
});

export function tmdbCandidate(raw: Title | null, type: TitleKind): Candidate | undefined {
  const id = raw?.id, title = type === 'movie' ? raw?.title : raw?.name;
  if (!raw || raw.adult || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof title !== 'string' || !title.trim()) return;
  const kind = type === 'movie' ? 'movie' : 'show';
  const released = type === 'movie' ? raw.release_date : raw.first_air_date;
  const day = typeof released === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(released) ? released : undefined;
  const rating = number(raw.vote_average);
  return {
    item: {key:`${kind}:tmdb:${id}`, kind, source:'tmdb', title, ids:{tmdb:id}, year:day ? Number(day.slice(0, 4)) : undefined,
      summary:typeof raw.overview === 'string' ? raw.overview : undefined,
      posterUrl:tmdbImage(typeof raw.poster_path === 'string' ? raw.poster_path : undefined, 'w342'),
      backdropUrl:tmdbImage(typeof raw.backdrop_path === 'string' ? raw.backdrop_path : undefined, 'w1280'),
      language:typeof raw.original_language === 'string' ? raw.original_language : undefined,
      genres:tmdbGenres(Array.isArray(raw.genre_ids) ? raw.genre_ids : []), rating:rating || undefined,
      ratings:rating > 0 && rating <= 10 ? [{source:'tmdb',score:rating}] : undefined},
    votes:number(raw.vote_count), popularity:number(raw.popularity), date:day
  };
}

export function mixCandidates(lists: Candidate[][]) {
  const unique = new Map<string, Candidate>();
  for (let i = 0; lists.some(list => i < list.length); i++) {
    for (const list of lists) {
      const candidate = list[i];
      if (candidate && !unique.has(candidate.item.key)) unique.set(candidate.item.key, candidate);
    }
  }
  return [...unique.values()];
}

export class TmdbExplore {
  private ranked = new TtlCache<Promise<DiscoverSnapshot>>(24);
  constructor(private client: TmdbTitles, private now = Date.now) {}
  private async providerList(path: string, params: Record<string, string> = {}) {
    const data = await this.client.get(`/watch/providers/${path}`, params) as {results?: unknown[]} | undefined;
    requireThat(Array.isArray(data?.results), 'CATALOG_UNAVAILABLE', 'TMDB could not list streaming providers.', 502);
    return data.results;
  }
  async providers(region: string): Promise<ExploreWatchProviders> {
    const rawRegions = await this.providerList('regions') as {iso_3166_1?: string; english_name?: string}[];
    const regions = rawRegions.flatMap(value => value && typeof value.iso_3166_1 === 'string' && /^[A-Z]{2}$/.test(value.iso_3166_1)
      ? [{code:value.iso_3166_1, name:typeof value.english_name === 'string' ? value.english_name : value.iso_3166_1}] : []);
    requireThat(regions.some(r => r.code === region), 'INVALID_REGION', 'Choose a supported streaming region.', 400);
    const lists = await Promise.all(kinds.map(async kind => await this.providerList(kind, {watch_region:region}) as Provider[]));
    const providers = [...new Map(lists.flat().flatMap(p => p && Number.isSafeInteger(p.provider_id) && p.provider_id > 0 && typeof p.provider_name === 'string'
      ? [[p.provider_id, {id:p.provider_id, name:p.provider_name, logoUrl:tmdbImage(typeof p.logo_path === 'string' ? p.logo_path : undefined, 'w92')}] as const] : [])).values()];
    providers.sort((a,b) => a.name.localeCompare(b.name) || a.id - b.id);
    const providerIds = new Map(providers.map(p=>[providerName(p.name),p.id]));
    const defaults = services.flatMap(({names}) => names.map(name=>providerIds.get(name)).find(id=>id!==undefined)??[]);
    const labeledProviders=providers.map(p=>({...p,name:serviceLabels.get(providerName(p.name))??p.name}));
    labeledProviders.sort((a,b)=>a.name.localeCompare(b.name)||a.id-b.id);
    return {regions, providers:labeledProviders, defaults};
  }
  private async titles(type: TitleKind, path: string, params: Record<string, string>, ttl?: number, missingIsEmpty = false): Promise<Result> {
    const data = await this.client.get(path, params, ttl) as {results?: Title[]; total_pages?: number} | undefined;
    if (!data && missingIsEmpty) return {items:[], pages:0};
    requireThat(Array.isArray(data?.results), 'CATALOG_UNAVAILABLE', 'TMDB could not load these titles.', 502);
    return {items:data.results.flatMap(row => tmdbCandidate(row, type) ?? []), pages:Math.max(0, Math.min(500, Math.floor(number(data.total_pages))))};
  }
  async trending(types:readonly TitleKind[]=kinds, days = 7) {
    return mixCandidates(await Promise.all(types.map(type => this.titles(type, `/trending/${type}/${days === 1 ? 'day' : 'week'}`, {}, 6 * HOUR).then(r => r.items))));
  }
  async search(query:string,kind?:ExploreItem['kind']) {
    const types=kind?[kind==='show'?'tv':'movie'] as const:kinds;
    const lists=await Promise.all(types.map(type=>this.titles(type,`/search/${type}`,{query,include_adult:'false'},15*60000)));
    return mixCandidates(lists.map(list=>list.items)).map(({item})=>item);
  }
  async suggestions(type: TitleKind, id: number, similar = false) {
    return (await this.titles(type, `/${type}/${id}/${similar ? 'similar' : 'recommendations'}`, {}, undefined, true)).items;
  }
  // A title's name, for a Because You Watched row whose watched title came without one.
  async title(type: TitleKind, id: number) {
    const data = await this.client.get(`/${type}/${id}`) as {title?: unknown; name?: unknown} | undefined;
    const name = type === 'movie' ? data?.title : data?.name;
    requireThat(typeof name === 'string' && !!name.trim(), 'CATALOG_UNAVAILABLE', 'TMDB could not name this title.', 502);
    return name;
  }
  private async upcoming(type:TitleKind, page:number, now:number, ranking?:ExploreRanking):Promise<ExplorePage> {
    const settings = exploreRankingFor(type === 'movie' ? 'upcoming-movies' : 'upcoming-shows', ranking);
    const {nearPopularity,midPopularity,nearDays,midDays,futureDays} = settings;
    const field=type==='movie'?'primary_release_date':'first_air_date';
    const read=(params:Record<string,string>,at:number)=>this.titles(type,`/discover/${type}`,{
      include_adult:'false',sort_by:'popularity.desc',...ratingFilters(settings),...params,page:String(at)
    },12*HOUR);
    // Each date range has a constant multiplier, so its TMDB popularity order is also its weighted order.
    const ranges=[[0,nearDays,nearPopularity/100],[nearDays+1,midDays,midPopularity/100],[midDays+1,undefined,1]] as const;
    const visible=ranges.filter(([start])=>!futureDays||start<=futureDays);
    const buckets=await Promise.all(visible.map(async ([start,end,weight]):Promise<UpcomingBucket>=>{
      const last=futureDays?Math.min(end??futureDays,futureDays):end;
      const params={[`${field}.gte`]:date(now+start*DAY),...(last!==undefined&&{[`${field}.lte`]:date(now+last*DAY)})};
      return {weight,params,page:1,result:await read(params,1),index:0};
    }));
    const seen=new Set<string>(), ranked:{candidate:Candidate;score:number}[]=[];
    const offset=(page-1)*EXPLORE_PAGE_SIZE;
    // With audience weighting, score the first five pages together so a high-rated title can move between pages.
    const rerank=settings.audienceRating>0&&page<=RANKED_PAGES;
    const skip=rerank?0:offset, count=rerank?RANKED_PAGES*EXPLORE_PAGE_SIZE:EXPLORE_PAGE_SIZE;
    let hasTail=false;
    while(true){
      let next:UpcomingBucket|undefined;
      let score=-Infinity;
      for(const bucket of buckets){
        while(bucket.index>=bucket.result.items.length&&bucket.page<bucket.result.pages){
          bucket.result=await read(bucket.params,++bucket.page);
          bucket.index=0;
        }
        const candidate=bucket.result.items[bucket.index];
        if(candidate&&candidate.popularity*bucket.weight>score){
          next=bucket;
          score=candidate.popularity*bucket.weight;
        }
      }
      if(!next)break;
      const candidate=next.result.items[next.index++]!;
      if(seen.has(candidate.item.key))continue;
      seen.add(candidate.item.key);
      if(seen.size<=skip)continue;
      if(ranked.length===count){hasTail=true;break;}
      ranked.push({candidate,score:rerank?score*audienceQuality(candidate,settings.audienceRating/100,settings.ratingPriorVotes):score});
    }
    if(rerank)ranked.sort((a,b)=>b.score-a.score);
    const start=rerank?offset:0, end=start+EXPLORE_PAGE_SIZE;
    return {items:ranked.slice(start,end).map(({candidate})=>candidate.item),page,hasMore:hasTail||ranked.length>end};
  }
  private async seasonPremiere(id: number, today: string) {
    const details = await this.client.get(`/tv/${id}`, {}, 12 * HOUR).catch(error => {
      if (error?.code === 'CATALOG_UNAVAILABLE') return undefined;
      throw error;
    }) as {seasons?:{season_number?:number; air_date?:string | null}[]} | undefined;
    const seasons = Array.isArray(details?.seasons) ? details.seasons : [];
    return seasons.reduce<string | undefined>((latest, season) => {
      const day = season?.air_date;
      return (season?.season_number ?? 0) >= 2 && typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today && (!latest || day > latest) ? day : latest;
    }, undefined);
  }
  async returningSeasons(items:Candidate[], now:number, limit=40) {
    const shows = mixCandidates([items]).filter(c=>c.item.kind==='show').slice(0,limit), today=date(now);
    return new Map(await Promise.all(shows.map(async ({item})=>[item.key,await this.seasonPremiere(item.ids.tmdb!,today)] as const)));
  }
  private async discoverSnapshot(type:TitleKind, now:number, params:Record<string,string>, settings:ExploreRowRanking): Promise<DiscoverSnapshot> {
    const today = date(now);
    const field = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    const {releaseBoost=0,releaseBoostDays=90,audienceRating=0,ratingPriorVotes=200,seasonBoost=0,seasonDays=90,popularityBoost=0} = settings;
    const fetchPage = (page:number, extra:Record<string,string> = {}) => this.titles(type, `/discover/${type}`, {
      ...params, ...extra, page:String(page)
    }, 12 * HOUR);
    const gather = async (limit:number, extra?:Record<string,string>) => {
      const first = await fetchPage(1, extra), count = Math.max(1, Math.min(limit, first.pages));
      const rest = await Promise.all(Array.from({length:count-1}, (_, index) => fetchPage(index+2, extra)));
      return {items:[first,...rest].flatMap(result=>result.items), count, last:first.pages};
    };
    const releaseStart=date(now-releaseBoostDays*DAY), lower=params[`${field}.gte`];
    const [baseResults,releases,airing] = await Promise.all([
      gather(RANKED_PAGES),
      releaseBoost ? gather(RECENT_PAGES, {[`${field}.gte`]:lower&&lower>releaseStart?lower:releaseStart,[`${field}.lte`]:today}).then(result=>result.items) : [],
      type === 'tv' && seasonBoost ? gather(RECENT_PAGES, {'air_date.gte':date(now-seasonDays*DAY),'air_date.lte':today}).then(result=>result.items) : []
    ]);
    const premieres = type === 'tv' && seasonBoost
      ? await this.returningSeasons([...baseResults.items.slice(0,EXPLORE_PAGE_SIZE),...airing],now,60) : undefined;
    const score = (candidate:Candidate) => {
      const boost = recentBoost(candidate.date, now, releaseBoostDays, releaseBoost)
        + recentBoost(premieres?.get(candidate.item.key), now, seasonDays, seasonBoost);
      const age=(now-Date.parse(candidate.date??''))/DAY;
      const baseline=params.sort_by==='vote_average.desc'?candidate.item.rating??0
        :params.sort_by===`${field}.desc`?(Number.isFinite(age)?1/(1+Math.max(0,age)/30):0):candidate.popularity;
      return {candidate,boost,score:baseline * (1+boost) * audienceQuality(candidate,audienceRating/100,ratingPriorVotes) * popularityMultiplier(candidate,popularityBoost)};
    };
    const base = mixCandidates([baseResults.items]).map(score), baseKeys = new Set(base.map(({candidate})=>candidate.item.key));
    const cutoff = base.reduce((min,entry)=>Math.min(min,entry.score),Infinity);
    const promoted = mixCandidates([[...releases,...airing]]).filter(c=>!baseKeys.has(c.item.key)).map(score)
      .filter(entry=>entry.boost>0 && (!base.length || entry.score>=cutoff));
    const items = [...base,...promoted].sort((a,b)=>b.score-a.score).map(({candidate})=>candidate);
    return {items, seen:new Set(items.map(({item})=>item.key)), next:baseResults.count+1, last:baseResults.last, read:fetchPage};
  }
  private async rankedDiscover(type:TitleKind, page:number, now:number, params:Record<string,string>, settings:ExploreRowRanking) {
    const today = date(now);
    const key = JSON.stringify([type,this.client.credentialGeneration(),today,params,settings]);
    const snapshot = await this.ranked.remember(key, HOUR, () => this.discoverSnapshot(type, Date.parse(today), params, settings), now);
    // Keep the rest of the catalog browsable in TMDB order, skipping titles already promoted into the ranked results.
    const end = page * EXPLORE_PAGE_SIZE;
    while (snapshot.items.length <= end && snapshot.next <= snapshot.last) {
      snapshot.pending ??= snapshot.read(snapshot.next).then(({items}) => {
        for (const candidate of items) {
          if (snapshot.seen.has(candidate.item.key)) continue;
          snapshot.seen.add(candidate.item.key);
          snapshot.items.push(candidate);
        }
        snapshot.next++;
      }).finally(() => {snapshot.pending=undefined;});
      await snapshot.pending;
    }
    return {items:snapshot.items.slice(end-EXPLORE_PAGE_SIZE,end),hasMore:page<500&&snapshot.items.length>end};
  }
  async page(row: TmdbExploreRow, page: number, streaming?: {region: string; ids: number[]}, kind?:ExploreItem['kind'], ranking?:ExploreRanking): Promise<ExplorePage> {
    if (streaming && !streaming.ids.length) return {items:[], page, hasMore:false};
    const now = this.now();
    const types: readonly TitleKind[] = row.endsWith('-movies') ? ['movie'] : row.endsWith('-shows') ? ['tv'] : kinds;
    const selected=kind?types.filter(type=>type===(kind==='show'?'tv':'movie')):types;
    if (row === 'trending') {
      const settings=exploreRankingFor(row, ranking), day=Date.parse(date(now));
      const items=(await this.trending(selected, settings.trendingDays)).filter(candidate=>passesRating(candidate,settings));
      if (!settings.releaseBoost&&!settings.seasonBoost&&!settings.popularityBoost&&!settings.audienceRating) return sliceExplore(items,page);
      const seasons=settings.seasonBoost?await this.returningSeasons(items,day):undefined;
      const scored=items.map((candidate,index)=>({candidate,score:(1 + recentBoost(candidate.date,day,settings.releaseBoostDays,settings.releaseBoost)
        + recentBoost(seasons?.get(candidate.item.key),day,settings.seasonDays,settings.seasonBoost))
        * popularityMultiplier(candidate,settings.popularityBoost) * audienceQuality(candidate,settings.audienceRating/100,settings.ratingPriorVotes)/(1+index/8)}));
      return sliceExplore(scored.sort((a,b)=>b.score-a.score).map(({candidate})=>candidate),page);
    }
    if(row==='upcoming-movies'||row==='upcoming-shows'){
      const type=selected[0];
      return type?this.upcoming(type,page,now,ranking):{items:[],page,hasMore:false};
    }
    const settings:ExploreRowRanking = exploreRankingFor(row, ranking);
    const lists = await Promise.all(selected.map(async type => {
      const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
      const days = row==='recent-streaming'||row==='acclaimed'?settings.releaseDays:undefined;
      const params: Record<string,string> = {
        include_adult:'false',
        sort_by:row === 'acclaimed' ? 'vote_average.desc' : row === 'recent-streaming' ? `${dateField}.desc` : 'popularity.desc',
        ...(days && {[`${dateField}.gte`]:date(now-days*DAY)}),
        ...(row!=='popular-streaming' && {[`${dateField}.lte`]:date(now)}),
        ...ratingFilters(settings),
        ...(streaming && {watch_region:streaming.region, with_watch_providers:streaming.ids.join('|'), with_watch_monetization_types:'flatrate'})
      };
      const read = (n: number) => this.titles(type, `/discover/${type}`, {...params, page:String(n)}, 12 * HOUR);
      if (page > 500) return {items:[], hasMore:false};
      if(settings.releaseBoost||settings.audienceRating||settings.popularityBoost||type==='tv'&&settings.seasonBoost) return this.rankedDiscover(type,page,now,params,settings);
      const first = await read(1);
      const result=page===1?first:page>first.pages?{items:[],pages:first.pages}:await read(page);
      return {items:result.items,hasMore:page<result.pages};
    }));
    return {items:mixCandidates(lists.map(list => list.items)).map(c => c.item), page, hasMore:lists.some(list => list.hasMore)};
  }
}

export function sliceExplore(items: Candidate[], page: number, title?: string): ExplorePage {
  const start = (page - 1) * EXPLORE_PAGE_SIZE;
  return {items:items.slice(start, start+EXPLORE_PAGE_SIZE).map(c => c.item), page, hasMore:items.length > start+EXPLORE_PAGE_SIZE, total:items.length, ...(title && {title})};
}
