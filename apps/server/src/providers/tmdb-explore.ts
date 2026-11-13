import type {ExploreItem, ExplorePage, ExploreRowInfo, ExploreWatchProviders, TmdbExploreRow} from '../../../../packages/contracts/src/index.js';
import {requireThat} from '../errors.js';
import {tmdbImage} from './explore-images.js';
import {tmdbGenres} from './explore-genres.js';
import type {TitleKind, TmdbTitles} from './tmdb-titles.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const UPCOMING_DAYS = 365 * 1.5;
const EXPLORE_PAGE_SIZE = 20;
export const tmdbRows: Record<TmdbExploreRow, ExploreRowInfo> = {
  'popular-streaming': {id:'popular-streaming', title:'Popular on Streaming', icon:'play', streaming:true},
  'recent-streaming': {id:'recent-streaming', title:'Recently Released on Streaming', icon:'play', streaming:true},
  'top-picks': {id:'top-picks', title:'Top Picks for You', icon:'star', personal:true},
  'because-1': {id:'because-1', title:'Because You Watched · First Pick', icon:'star', personal:true},
  'because-2': {id:'because-2', title:'Because You Watched · Second Pick', icon:'star', personal:true},
  'genre-1': {id:'genre-1', title:'More in Your Favorite Genres · First Genre', icon:'star', personal:true},
  'genre-2': {id:'genre-2', title:'More in Your Favorite Genres · Second Genre', icon:'star', personal:true},
  trending: {id:'trending', title:'Trending Now', icon:'star'},
  acclaimed: {id:'acclaimed', title:'Critically Acclaimed New Releases', icon:'star'},
  'popular-movies': {id:'popular-movies', title:'Popular Movies', icon:'movies'},
  'popular-shows': {id:'popular-shows', title:'Popular Shows', icon:'shows'},
  'upcoming-movies': {id:'upcoming-movies', title:'Upcoming Movies', icon:'calendar'},
  'upcoming-shows': {id:'upcoming-shows', title:'Upcoming Shows', icon:'calendar'}
};
export type Candidate = {item: ExploreItem; votes: number; popularity: number; date?: string};
type Result = {items: Candidate[]; pages: number};
type UpcomingBucket = {weight:number; params:Record<string,string>; page:number; result:Result; index:number};
type Provider = {provider_id: number; provider_name: string; logo_path?: string};
type Title = {
  id?: number; title?: string; name?: string; release_date?: string; first_air_date?: string; adult?: boolean;
  overview?: string; poster_path?: string; backdrop_path?: string; original_language?: string; genre_ids?: number[];
  vote_average?: number; vote_count?: number; popularity?: number;
};
const kinds = ['movie', 'tv'] as const;
const services = [
  ['netflix'], ['amazon prime video', 'prime video'], ['disney+'], ['hulu'], ['max', 'hbo max'], ['apple tv+', 'apple tv'],
  ['peacock premium', 'peacock premium plus', 'peacock'],
  ['paramount+', 'paramount+ essential', 'paramount+ premium', 'paramount+ with showtime', 'paramount+ showtime'],
  ['mgm+'], ['discovery+']
];
const providerName = (name:string) => name.trim().toLowerCase().replace(/\s+/g,' ').replace(/\s+plus\b/g,'+').replace(/\s+\+/g,'+');
const date = (value: number) => new Date(value).toISOString().slice(0, 10);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function tmdbCandidate(raw: Title | null, type: TitleKind): Candidate | undefined {
  const id = raw?.id, title = type === 'movie' ? raw?.title : raw?.name;
  if (!raw || raw.adult || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof title !== 'string' || !title.trim()) return;
  const kind = type === 'movie' ? 'movie' : 'show';
  const released = type === 'movie' ? raw.release_date : raw.first_air_date;
  const day = typeof released === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(released) ? released : undefined;
  return {
    item: {key:`${kind}:tmdb:${id}`, kind, source:'tmdb', title, ids:{tmdb:id}, year:day ? Number(day.slice(0, 4)) : undefined,
      summary:typeof raw.overview === 'string' ? raw.overview : undefined,
      posterUrl:tmdbImage(typeof raw.poster_path === 'string' ? raw.poster_path : undefined, 'w342'),
      backdropUrl:tmdbImage(typeof raw.backdrop_path === 'string' ? raw.backdrop_path : undefined, 'w1280'),
      language:typeof raw.original_language === 'string' ? raw.original_language : undefined,
      genres:tmdbGenres(Array.isArray(raw.genre_ids) ? raw.genre_ids : []), rating:number(raw.vote_average) || undefined},
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
    const defaults = services.flatMap(names => names.map(name=>providerIds.get(providerName(name))).find(id=>id!==undefined)??[]);
    return {regions, providers, defaults};
  }
  private async titles(type: TitleKind, path: string, params: Record<string, string>, ttl?: number, missingIsEmpty = false): Promise<Result> {
    const data = await this.client.get(path, params, ttl) as {results?: Title[]; total_pages?: number} | undefined;
    if (!data && missingIsEmpty) return {items:[], pages:0};
    requireThat(Array.isArray(data?.results), 'CATALOG_UNAVAILABLE', 'TMDB could not load these titles.', 502);
    return {items:data.results.flatMap(row => tmdbCandidate(row, type) ?? []), pages:Math.max(0, Math.min(500, Math.floor(number(data.total_pages))))};
  }
  async trending(types:readonly TitleKind[]=kinds) {
    return mixCandidates(await Promise.all(types.map(type => this.titles(type, `/trending/${type}/week`, {}, 6 * HOUR).then(r => r.items))));
  }
  async suggestions(type: TitleKind, id: number, similar = false) {
    return (await this.titles(type, `/${type}/${id}/${similar ? 'similar' : 'recommendations'}`, {}, undefined, true)).items;
  }
  async popular(genreIds?: (kind: TitleKind) => number[]) {
    return mixCandidates(await Promise.all(kinds.map(async type => {
      const ids = genreIds?.(type);
      if (ids && !ids.length) return [];
      return (await this.titles(type, `/discover/${type}`, {include_adult:'false', sort_by:'popularity.desc', page:'1',
        ...(ids && {with_genres:ids.join('|')})}, 12 * HOUR)).items;
    })));
  }
  private async upcoming(type:TitleKind, page:number, now:number):Promise<ExplorePage> {
    const field=type==='movie'?'primary_release_date':'first_air_date';
    const read=(params:Record<string,string>,at:number)=>this.titles(type,`/discover/${type}`,{
      include_adult:'false',sort_by:'popularity.desc',...params,page:String(at)
    },12*HOUR);
    // Each date range has a constant multiplier, so its TMDB popularity order is also its weighted order.
    const ranges=[[0,44,1.25],[45,89,1.125],[90,UPCOMING_DAYS,1]] as const;
    const buckets=await Promise.all(ranges.map(async ([start,end,weight]):Promise<UpcomingBucket>=>{
      const params={[`${field}.gte`]:date(now+start*DAY),[`${field}.lte`]:date(now+Math.floor(end)*DAY)};
      return {weight,params,page:1,result:await read(params,1),index:0};
    }));
    const seen=new Set<string>(),items:ExploreItem[]=[];
    const offset=(page-1)*EXPLORE_PAGE_SIZE;
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
      if(!next)return {items,page,hasMore:false};
      const {item}=next.result.items[next.index++]!;
      if(seen.has(item.key))continue;
      seen.add(item.key);
      if(seen.size<=offset)continue;
      if(items.length===EXPLORE_PAGE_SIZE)return {items,page,hasMore:true};
      items.push(item);
    }
  }
  async page(row: TmdbExploreRow, page: number, streaming?: {region: string; ids: number[]}, kind?:ExploreItem['kind']): Promise<ExplorePage> {
    if (streaming && !streaming.ids.length) return {items:[], page, hasMore:false};
    const now = this.now();
    const types: readonly TitleKind[] = row.endsWith('-movies') ? ['movie'] : row.endsWith('-shows') ? ['tv'] : kinds;
    const selected=kind?types.filter(type=>type===(kind==='show'?'tv':'movie')):types;
    if (row === 'trending') return sliceExplore(await this.trending(selected), page);
    if(row==='upcoming-movies'||row==='upcoming-shows'){
      const type=selected[0];
      return type?this.upcoming(type,page,now):{items:[],page,hasMore:false};
    }
    const lists = await Promise.all(selected.map(async type => {
      const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
      const days = row === 'recent-streaming' ? 180 : row === 'acclaimed' ? 365 : undefined;
      const params: Record<string,string> = {
        include_adult:'false',
        sort_by:row === 'acclaimed' ? 'vote_average.desc' : row === 'recent-streaming' ? `${dateField}.desc` : 'popularity.desc',
        ...(days && {[`${dateField}.gte`]:date(now-days*24*HOUR), [`${dateField}.lte`]:date(now)}),
        ...((row === 'popular-movies' || row === 'popular-shows') && {[`${dateField}.lte`]:date(now)}),
        ...(row === 'acclaimed' && {'vote_average.gte':'7.2', 'vote_count.gte':'50'}),
        ...(streaming && {watch_region:streaming.region, with_watch_providers:streaming.ids.join('|'), with_watch_monetization_types:'flatrate'})
      };
      const read = (n: number) => this.titles(type, `/discover/${type}`, {...params, page:String(n)}, 12 * HOUR);
      if (page > 500) return {items:[], pages:0};
      const first = await read(1);
      if (page === 1) return first;
      if (page > first.pages) return {items:[], pages:first.pages};
      return read(page);
    }));
    return {items:mixCandidates(lists.map(list => list.items)).map(c => c.item), page, hasMore:lists.some(list => page < list.pages)};
  }
}

export function sliceExplore(items: Candidate[], page: number, title?: string): ExplorePage {
  const start = (page - 1) * EXPLORE_PAGE_SIZE;
  return {items:items.slice(start, start+EXPLORE_PAGE_SIZE).map(c => c.item), page, hasMore:items.length > start+EXPLORE_PAGE_SIZE, total:items.length, ...(title && {title})};
}
