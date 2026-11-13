import {createHash} from 'node:crypto';
import {AppError} from './errors.js';
import type {ExploreGenre, ExploreItem, TmdbExploreRow} from '../../../packages/contracts/src/index.js';
import {exploreGenresOf, tmdbIdsForGenre} from './providers/explore-genres.js';
import type {ExploreLibraryTitle, PlexAdapter, PlexGrant} from './providers/plex.js';
import {type Candidate, type TmdbExplore} from './providers/tmdb-explore.js';

const DAY = 86400000;
type Seed = ExploreLibraryTitle & {tmdbId: number};
type Row = {title: string; items: Candidate[]};
type Pool = Partial<Record<TmdbExploreRow, Row>>;
type Entry = {until: number; pending: Promise<Pool>; last?: {value: Pool; at: number}};
const idKey = (kind: string, id: number) => `${kind}:tmdb:${id}`;
const normalized = (title: string) => title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const titleKey = ({kind,title,year}:Pick<ExploreItem,'kind'|'title'|'year'>) => `${kind}:${year}:${normalized(title)}`;
const unique = (items: Candidate[]) => [...new Map(items.map(c => [c.item.key,c])).values()];

export function selectSeeds(titles: ExploreLibraryTitle[], now: number): Seed[] {
  const recent = titles.filter((t):t is Seed => !!t.tmdbId)
    .sort((a,b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || idKey(a.kind,a.tmdbId).localeCompare(idKey(b.kind,b.tmdbId)));
  const top = [...new Map(recent.slice().reverse().map(t => [idKey(t.kind,t.tmdbId),t])).values()].reverse().slice(0,12);
  if (!top.length) return [];
  const shift = Math.floor(now/(7*DAY)) % top.length;
  const rotated = [...top.slice(shift), ...top.slice(0,shift)];
  const first = rotated[0]!;
  const second = rotated.find(t => t.kind !== first.kind);
  return [first, ...(second ? [second] : []), ...rotated.filter(t => t !== first && t !== second)].slice(0,4);
}

const familyOf = (item: ExploreItem) => normalized(item.title).split(/\s*[:–—]\s*/)[0]!
  .replace(/(?:\s+(?:part|chapter|volume|vol\.?)\s*)?\s+(?:\d+|i{1,3}|iv|v|vi{0,3}|ix|x)$/i,'');
export function rankCandidates(lists: Candidate[][], preferred: ExploreGenre[]): Candidate[] {
  const support = new Map<string, number>();
  for (const list of lists) for (const c of unique(list)) support.set(c.item.key,(support.get(c.item.key) ?? 0)+1);
  const overlap = (c: Candidate) => preferred.filter(g => c.item.genres?.includes(g)).length;
  const confidence = (c: Candidate) => (c.item.rating ?? 0) * c.votes/(c.votes+50);
  const ranked = unique(lists.flat()).sort((a,b) => support.get(b.item.key)!-support.get(a.item.key)!
    || overlap(b)-overlap(a) || confidence(b)-confidence(a) || b.popularity-a.popularity
    || (b.date ?? '').localeCompare(a.date ?? '') || a.item.kind.localeCompare(b.item.kind) || a.item.ids.tmdb!-b.item.ids.tmdb!);
  const result: Candidate[] = [];
  while (ranked.length) {
    const recent = result.slice(-4);
    const variety = (c: Candidate) => !recent.some(r => familyOf(r.item) === familyOf(c.item))
      && recent.slice(-2).filter(r => r.item.kind === c.item.kind).length < 2
      && (!c.item.genres?.[0] || recent.filter(r => r.item.genres?.[0] === c.item.genres![0]).length < 3);
    const index = ranked.findIndex(variety);
    result.push(ranked.splice(index < 0 ? 0 : index, 1)[0]!);
  }
  return result;
}

export class ExploreRecommendations {
  private pools = new Map<string, Entry>();
  private snapshots = new Map<string,{until:number; pending:ReturnType<PlexAdapter['exploreLibrary']>}>();
  constructor(private plex: Pick<PlexAdapter,'exploreLibrary'>, private tmdb: TmdbExplore, private now = Date.now) {}
  forget(account: string) {
    for (const key of this.pools.keys()) if (key.startsWith(`${account}\n`)) this.pools.delete(key);
    for (const key of this.snapshots.keys()) if (key.startsWith(`${account}\n`)) this.snapshots.delete(key);
  }
  get(grant: PlexGrant, generation: number): Promise<Pool> {
    const scope = createHash('sha256').update(JSON.stringify([grant.serverToken,grant.libraries.map(l => [l.key,l.type]).sort()])).digest('hex');
    const viewer = `${grant.accountId}\n${scope}`, key = `${viewer}:${generation}`, now = this.now(), hit = this.pools.get(key);
    if (hit && hit.until > now) return hit.pending;
    const snapshot = this.snapshot(viewer,grant);
    const entry: Entry = {until:Infinity, pending:snapshot.pending.then(value=>this.build(value)).then(({pool,partial}) => {
      entry.until = Math.min(snapshot.until,this.now() + (partial ? 5*60000 : DAY));
      if (!partial) entry.last = {value:pool, at:this.now()};
      if (partial && hit?.last && this.now()-hit.last.at < 2*DAY) {
        entry.last = hit.last;
        return pool['top-picks']?.items.length ? pool : hit.last.value;
      }
      return pool;
    }).catch(error => {
      if (error?.code === 'CATALOG_UNAVAILABLE' && hit?.last && this.now()-hit.last.at < 2*DAY) {
        entry.until = this.now()+60000; entry.last = hit.last; return hit.last.value;
      }
      if (this.pools.get(key) === entry) this.pools.delete(key);
      throw error;
    })};
    this.pools.delete(key); this.pools.set(key,entry);
    while (this.pools.size > 64) this.pools.delete(this.pools.keys().next().value!);
    return entry.pending;
  }
  private snapshot(viewer:string,grant:PlexGrant) {
    const hit=this.snapshots.get(viewer);
    if(hit&&hit.until>this.now())return hit;
    const entry={until:Infinity,pending:this.plex.exploreLibrary(grant).then(value=>{
      entry.until=this.now()+(value.complete||value.capped?DAY:5*60000);
      return value;
    }).catch(error=>{
      if(this.snapshots.get(viewer)===entry)this.snapshots.delete(viewer);
      throw error;
    })};
    this.snapshots.delete(viewer);this.snapshots.set(viewer,entry);
    while(this.snapshots.size>64)this.snapshots.delete(this.snapshots.keys().next().value!);
    return entry;
  }
  private async build(snapshot:Awaited<ReturnType<PlexAdapter['exploreLibrary']>>): Promise<{pool:Pool; partial:boolean}> {
    const owned = new Set(snapshot.titles.filter(t => t.tmdbId).map(t => idKey(t.kind,t.tmdbId!)));
    const unidentified = new Set(snapshot.titles.filter(t => !t.tmdbId && t.year).map(titleKey));
    const unowned = (c: Candidate) => !owned.has(c.item.key) && !unidentified.has(titleKey(c.item));
    const frequencies = new Map<ExploreGenre,number>();
    for (const title of snapshot.titles) for (const genre of exploreGenresOf(title.genres)) frequencies.set(genre,(frequencies.get(genre) ?? 0)+1);
    const genres = [...frequencies].sort(([a,x],[b,y]) => y-x || a.localeCompare(b)).map(([g]) => g).slice(0,2);
    const seeds = selectSeeds(snapshot.titles,this.now());
    const pool: Pool = {};
    let partial = !snapshot.complete && !snapshot.capped;
    const tryList = async (read:Promise<Candidate[]>) => {
      try { return await read; }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('TMDB_KEY_')) throw error;
        partial = true; return [];
      }
    };
    const seedLists = await Promise.all(seeds.map(async seed => {
      const kind = seed.kind === 'movie' ? 'movie' : 'tv';
      const picks = (await tryList(this.tmdb.suggestions(kind,seed.tmdbId))).filter(unowned);
      if (picks.length < 8) picks.push(...(await tryList(this.tmdb.suggestions(kind,seed.tmdbId,true))).filter(unowned));
      return unique(picks);
    }));
    seeds.map((seed,index) => ({seed,items:seedLists[index]!})).filter(r => r.items.length).slice(0,2).forEach(({seed,items},i) => {
      pool[i ? 'because-2' : 'because-1'] = {title:`Because You Have ${seed.title}`, items:rankCandidates([items],genres)};
    });
    let top = seeds.length >= 2 ? rankCandidates(seedLists,genres) : [];
    const title = top.length ? 'Top Picks for You' : 'Popular Picks';
    const [genreLists,fallback] = await Promise.all([
      Promise.all(genres.map(genre => tryList(this.tmdb.popular(kind => tmdbIdsForGenre(genre,kind))))),
      top.length < 20 ? Promise.all([tryList(this.tmdb.trending()),tryList(this.tmdb.popular())]) : Promise.resolve([])
    ]);
    if (fallback.length) top = unique([...top,...fallback.flat().filter(unowned)]);
    if (!top.length && partial && !seedLists.some(list => list.length)) {
      // An outage should be retryable when there is nothing useful to display.
      throw new AppError('CATALOG_UNAVAILABLE','Recommendations are temporarily unavailable.',502);
    }
    pool['top-picks'] = {title,items:top};
    genres.map((genre,index) => ({genre,items:genreLists[index]!.filter(unowned)})).filter(r => r.items.length).forEach(({genre,items},i) => {
      pool[i ? 'genre-2' : 'genre-1'] = {title:`More ${genre}`,items};
    });
    return {pool,partial};
  }
}
