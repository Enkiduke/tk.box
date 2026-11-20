import {createHash} from 'node:crypto';
import {AppError} from './errors.js';
import type {ExploreGenre, ExploreItem} from '../../../packages/contracts/src/index.js';
import {builtInRows,num,type ExploreRowDef} from '../../../packages/contracts/src/explore-rows.js';
import {exploreGenresOf} from './providers/explore-genres.js';
import type {PlexAdapter, PlexGrant} from './providers/plex.js';
import type {TmdbExplore} from './providers/tmdb-explore.js';
import {audienceQuality,boostScore,passesFilters,plan,scoring,type Candidate,type Plan} from './services/explore/signals.js';
export {freshness} from './services/explore/signals.js';

// Explore's suggestions: each viewer's Top Movie Picks, Top Show Picks and one Because You Watched row for each kind,
// from everything they watched, wherever they watched it (tk.box's player, Plex's apps on this server, Plex elsewhere,
// the saved watch history). Built once a day per viewer; the day, the viewer and their Refresh presses seed the shuffle,
// so suggestions change daily and on Refresh but hold still while someone browses.
const DAY = 86400000;
type Kind = ExploreItem['kind'];
type Row = {title: string; items: Candidate[]};
export const personalRows = ['top-movies', 'top-shows', 'because-movie', 'because-show'] as const;
export type PersonalRow = typeof personalRows[number];
export type ExplorePool = Partial<Record<PersonalRow, Row>>;
// The four rows' definitions, as Admin › Explore saved them.
export type PersonalDefs = Record<PersonalRow, ExploreRowDef>;
export const defaultPersonalDefs: PersonalDefs = {'top-movies':builtInRows['top-movies'], 'top-shows':builtInRows['top-shows'],
  'because-movie':builtInRows['because-movie'], 'because-show':builtInRows['because-show']};
type Entry = {until: number; pending: Promise<ExplorePool>; last?: {value: ExplorePool; at: number}};
// One watched title. `at` (ms) is the latest watch when the source dates it; `plays` counts sessions (a show's episodes).
// `year` is the title's release year (a show's first).
export type WatchedTitle = {kind: Kind; tmdbId: number; title?: string; year?: number; genres?: string[]; at?: number; plays?: number};
const idKey = (kind: string, id: number) => `${kind}:tmdb:${id}`;
const normalized = (title: string) => title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const unique = (items: Candidate[]) => [...new Map(items.map(c => [c.item.key, c])).values()];
// WIDE_SEEDS: watched titles a viewer's filters draw on, so filtered rows still fill.
const SEEDS = 8, WIDE_SEEDS = 20, RECENT = 10, TOP_LIMIT = 60, BECAUSE_LIMIT = 40, ROW_SHOWN = 20, BECAUSE_MIN = 6;
// How much each watch counts: per step down the list, the half-life of a watch's age, and the lift for many plays.
type SeedScoring = {watchRankRetention: number; watchHalfLife: number; watchFrequency: number};
export const seedScoring = (p: Plan): SeedScoring => ({watchRankRetention:num(p.values('watchOrder'), 'retention'),
  watchHalfLife:num(p.values('watchRecency'), 'halfLife'), watchFrequency:num(p.values('watchFrequency'), 'strength')});
const topPlan = plan(builtInRows['top-movies']), defaultTop = seedScoring(topPlan);
const defaultScoring = plan(builtInRows['because-movie']);
const eraStrength = (p: Plan) => num(p.values('eraAffinity'), 'strength') / 100;

// One list from every source, each title once with its latest date, most plays, and whatever name and genres any
// source gave. Dated titles go newest first; titles only an undated source knows (Plex's account history, which is in
// its own newest-first order) take turns with them.
export function mergeHistory(lists: WatchedTitle[][]): WatchedTitle[] {
  const merged = new Map<string, WatchedTitle>(), undated: string[] = [];
  for (const list of lists) for (const title of list) {
    const key = idKey(title.kind, title.tmdbId), found = merged.get(key);
    if (!found) { merged.set(key, {...title}); if (title.at === undefined) undated.push(key); continue; }
    if (title.at !== undefined && (found.at === undefined || title.at > found.at)) found.at = title.at;
    if (title.plays !== undefined) found.plays = Math.max(found.plays ?? 0, title.plays);
    if (!found.title && title.title) found.title = title.title;
    if (!found.year && title.year) found.year = title.year;
    if (!found.genres?.length && title.genres?.length) found.genres = title.genres;
  }
  const dated = [...merged.values()].filter(t => t.at !== undefined).sort((a, b) => b.at! - a.at! || a.tmdbId - b.tmdbId);
  const rest = undated.map(key => merged.get(key)!).filter(t => t.at === undefined), result: WatchedTitle[] = [];
  for (let i = 0; i < Math.max(dated.length, rest.length); i++) for (const t of [dated[i], rest[i]]) if (t) result.push(t);
  return result;
}

// How much a watched title says about the viewer: later in the list counts less, older watches fade (but never below
// a quarter), and a title watched often (a show's many episodes) counts up to twice.
export function seedWeight(title: WatchedTitle, rank: number, now: number, settings:SeedScoring = defaultTop) {
  const age = title.at === undefined ? 0 : Math.max(0, now - title.at) / DAY;
  const recency=settings.watchHalfLife?Math.max(0.25, 0.5 ** (age / settings.watchHalfLife)):1;
  return (settings.watchRankRetention / 100) ** rank * recency
    * (1 + settings.watchFrequency / 100 * Math.min(1, Math.log10(Math.max(1, title.plays ?? 1))));
}

// The viewer's genres, weighted like their watches, as shares that add up to 1.
export function genreTaste(history: WatchedTitle[], now: number, seeds?:SeedScoring) {
  const weights = new Map<ExploreGenre, number>();
  history.forEach((title, rank) => {
    const genres = exploreGenresOf(title.genres ?? []), weight = seedWeight(title, rank, now, seeds);
    for (const genre of genres) weights.set(genre, (weights.get(genre) ?? 0) + weight / genres.length);
  });
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  return new Map([...weights].map(([genre, weight]) => [genre, total ? weight / total : 0]));
}

// The viewer's eras: how much of their watching (weighted like their watches) is within 5 years of a release year,
// as a multiplier from 0.6 (none) to 1.4 (half or more). Without any years known it changes nothing.
export function eraTaste(history: WatchedTitle[], now: number, seeds?:SeedScoring, strength = eraStrength(defaultScoring)) {
  const years = history.flatMap((title, rank) => title.year ? [{year: title.year, weight: seedWeight(title, rank, now, seeds)}] : []);
  const total = years.reduce((sum, y) => sum + y.weight, 0);
  return (year?: number) => {
    if (!total || !year) return 1;
    const near = years.reduce((sum, y) => sum + (Math.abs(y.year - year) <= 5 ? y.weight : 0), 0);
    return 1 + strength * (2 * Math.min(1, 2 * near / total) - 1);
  };
}

// TMDB's score as a multiplier from 0.6 (5.5 or less) to 1.4 (8 or more), pulled toward 6.5 until about 200 votes.
export function quality(c: Candidate) {
  const audience = defaultScoring.values('audience');
  return audienceQuality(c, num(audience, 'strength') / 100, num(audience, 'priorVotes'));
}
export type Taste = {genres: Map<ExploreGenre, number>; era?: (year?: number) => number};

// A small, repeatable random number generator, so a day's suggestions are the same on every read.
export function seededRandom(seed: string) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const familyOf = (item: ExploreItem) => normalized(item.title).split(/\s*[:–—]\s*/)[0]!
  .replace(/(?:\s+(?:part|chapter|volume|vol\.?)\s*)?\s+(?:\d+|i{1,3}|iv|v|vi{0,3}|ix|x)$/i, '');

// Each candidate's score: how strongly the watched titles that suggest it point to it (TMDB lists the best match
// first), times boosts for being new (up to 2x), from an era the viewer watches (0.6-1.4x), in their genres (up to
// 1.4x) and well rated by many (0.6-1.4x), and a small random factor. The order then keeps one series' entries and one
// genre from bunching up, and, with several watched titles, keeps any one of them from supplying most of the row:
// a pick counts toward the watched title that adds most to its score, and one past that title's cap moves down.
export function scoreCandidates(lists: {weight: number; items: Candidate[]}[], taste: Taste, now: number, random: () => number, settings:Plan = topPlan): Candidate[] {
  const relevance = new Map<string, number>(), byKey = new Map<string, Candidate>(), source = new Map<string, {list: number; part: number}>();
  const decay = num(settings.values('matchPosition'), 'decay');
  lists.forEach(({weight, items}, list) => unique(items).forEach((c, position) => {
    const part = decay ? weight / (1 + position / decay) : weight;
    relevance.set(c.item.key, (relevance.get(c.item.key) ?? 0) + part);
    if (!byKey.has(c.item.key)) byKey.set(c.item.key, c);
    if ((source.get(c.item.key)?.part ?? -1) < part) source.set(c.item.key, {list, part});
  }));
  const score = new Map<string, number>(), ids = scoring(settings);
  const genreShare = (c: Candidate) => Math.min(1, (c.item.genres ?? []).reduce((sum, g) => sum + (taste.genres.get(g) ?? 0), 0));
  for (const [key, c] of byKey) {
    // Every title takes its roll, shuffle or not, so the day's later draws don't depend on the setting.
    const roll = random();
    score.set(key, boostScore(settings, c, {now, genreShare, era:taste.era, roll}, ids, relevance.get(key)!));
  }
  const ranked = [...byKey.values()].sort((a, b) => score.get(b.item.key)! - score.get(a.item.key)! || a.item.ids.tmdb! - b.item.ids.tmdb!);
  const result: Candidate[] = [], supplied = new Map<number, number>(), capped = settings.active('spread') && lists.length > 1;
  const spread = settings.values('spread'), capShown = num(spread, 'shownCap'), capRow = num(spread, 'rowCap');
  while (ranked.length) {
    const recent = result.slice(-4);
    const variety = (c: Candidate) => !settings.active('variety') || (!recent.some(r => familyOf(r.item) === familyOf(c.item))
      && (!c.item.genres?.[0] || recent.filter(r => r.item.genres?.[0] === c.item.genres![0]).length < 3));
    const fits = (c: Candidate) => !capped || (supplied.get(source.get(c.item.key)!.list) ?? 0) < (result.length < ROW_SHOWN ? capShown : capRow);
    let index = ranked.findIndex(c => fits(c) && variety(c));
    if (index < 0) index = ranked.findIndex(fits);
    const [next] = ranked.splice(index < 0 ? 0 : index, 1);
    const list = source.get(next!.item.key)!.list;
    supplied.set(list, (supplied.get(list) ?? 0) + 1);
    result.push(next!);
  }
  return result;
}

// The last few different titles of a kind, in a random order: the Because You Watched row tries them in turn.
export function becauseOrder(history: WatchedTitle[], random: () => number) {
  const recent = history.slice(0, RECENT);
  for (let i = recent.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [recent[i], recent[j]] = [recent[j]!, recent[i]!]; }
  return recent;
}

type Sources = {
  // tk.box's own watch history and the saved watch history for this account, as TMDB titles.
  history?: (accountId: string) => WatchedTitle[];
  // Titles not to suggest: on the server or with a request label (`movie:tmdb:603`).
  excluded?: () => {has(key: string): boolean};
};
export class ExploreRecommendations {
  private pools = new Map<string, Entry>();
  private rolls = new Map<string, number>();
  constructor(private plex: Pick<PlexAdapter, 'exploreRecentlyWatched' | 'exploreAccountHistory'>, private tmdb: TmdbExplore,
    private sources: Sources = {}, private now = Date.now) {}
  // Refresh: rebuild, and roll the day's random picks again.
  forget(account: string) {
    for (const key of this.pools.keys()) if (key.startsWith(`${account}\n`)) this.pools.delete(key);
    this.rolls.set(account, (this.rolls.get(account) ?? 0) + 1);
  }
  // `wide`: the defs carry a viewer's filters; the pool reads further and is kept apart from the unfiltered one.
  get(grant: PlexGrant, generation: number, accountToken?: string, defs:PersonalDefs = defaultPersonalDefs, preview=false, wide=false): Promise<ExplorePool> {
    const scope = createHash('sha256').update(JSON.stringify([grant.serverToken, grant.libraries.map(l => [l.key, l.type]).sort()])).digest('hex');
    const tokenScope = createHash('sha256').update(accountToken ?? '').digest('hex');
    const now = this.now(), today = new Date(now), day = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
    const roll = this.rolls.get(grant.accountId) ?? 0;
    const settings = {movie:{top:plan(defs['top-movies']), because:plan(defs['because-movie'])}, show:{top:plan(defs['top-shows']), because:plan(defs['because-show'])}};
    const prefix=`${grant.accountId}\n${scope}:${preview?'preview':'live'}:${wide?'filtered':'plain'}:`;
    const key = `${prefix}${tokenScope}:${generation}:${roll}:${JSON.stringify(defs)}`, hit = this.pools.get(key);
    if (hit && hit.until > now) return hit.pending;
    const local = this.plex.exploreRecentlyWatched(grant, now).catch(() => []);
    const account = accountToken ? this.plex.exploreAccountHistory(grant, accountToken).catch(() => []) : Promise.resolve([]);
    const entry: Entry = {until: Infinity, pending: Promise.all([local, account]).then(([local, account]) => {
      const own = (() => { try { return this.sources.history?.(grant.accountId) ?? []; } catch { return []; } })();
      return this.build(mergeHistory([own, local.map(t => ({...t, at: t.lastViewedAt * 1000})), account]), now, `${grant.accountId}:${day}:${roll}`, settings, wide);
    }).then(({pool, partial}) => {
      entry.until = partial ? Math.min(midnight, this.now() + 5 * 60000) : midnight;
      if (!partial) entry.last = {value: pool, at: this.now()};
      if (partial && hit?.last && this.now() - hit.last.at < 2 * DAY) {
        entry.last = hit.last;
        return Object.keys(pool).length ? pool : hit.last.value;
      }
      return pool;
    }).catch(error => {
      if (error?.code === 'CATALOG_UNAVAILABLE' && hit?.last && this.now() - hit.last.at < 2 * DAY) {
        entry.until = this.now() + 60000; entry.last = hit.last; return hit.last.value;
      }
      if (this.pools.get(key) === entry) this.pools.delete(key);
      throw error;
    })};
    // An earlier day's or roll's pool for this viewer is replaced.
    for (const old of this.pools.keys()) if (old.startsWith(prefix) && old !== key) this.pools.delete(old);
    this.pools.delete(key); this.pools.set(key, entry);
    while (this.pools.size > 64) this.pools.delete(this.pools.keys().next().value!);
    return entry.pending;
  }
  private async build(history: WatchedTitle[], now: number, seed: string, settings:Record<Kind,{top:Plan; because:Plan}>, wide: boolean): Promise<{pool: ExplorePool; partial: boolean}> {
    const watched = new Set(history.map(t => idKey(t.kind, t.tmdbId))), excluded = this.sources.excluded?.();
    const fresh = (c: Candidate) => !watched.has(c.item.key) && !excluded?.has(c.item.key);
    let partial = false, reads = 0, failures = 0;
    const tryList = async (read: Promise<Candidate[]>) => {
      reads++;
      try { return await read; }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('TMDB_KEY_')) throw error;
        partial = true; failures++; return [];
      }
    };
    const lists = new Map<string, Promise<Candidate[]>>();
    const suggestions = (seed: WatchedTitle) => {
      const key = idKey(seed.kind, seed.tmdbId), found = lists.get(key);
      if (found) return found;
      const type = seed.kind === 'movie' ? 'movie' : 'tv', sameKind = (c: Candidate) => c.item.kind === seed.kind && fresh(c);
      const pending = tryList(this.tmdb.suggestions(type, seed.tmdbId)).then(async result => {
        const picks = result.filter(sameKind);
        // Filtered, a row reads further: TMDB's next page of recommendations and its similar titles too.
        if (wide) picks.push(...(await tryList(this.tmdb.suggestions(type, seed.tmdbId, false, 2))).filter(sameKind));
        if (wide || picks.length < 8) picks.push(...(await tryList(this.tmdb.suggestions(type, seed.tmdbId, true))).filter(sameKind));
        return unique(picks);
      });
      lists.set(key, pending);
      return pending;
    };
    const pool: ExplorePool = {};
    await Promise.all((['movie', 'show'] as const).map(async kind => {
      const mine = history.filter(t => t.kind === kind);
      if (!mine.length) return;
      const {top:topSettings,because:becauseSettings} = settings[kind];
      // Each kind has its own random numbers, so the two kinds' reads finishing in either order give the same rows.
      const random = seededRandom(`${seed}:${kind}`);
      const seeds = mine.slice(0, wide ? WIDE_SEEDS : SEEDS);
      const seeds_ = seedScoring(topSettings);
      const seedLists = await Promise.all(seeds.map(async (seed, rank) => ({weight:seedWeight(seed,rank,now,seeds_),
        items:(await this.tmdb.withPremieres(topSettings,await suggestions(seed),now)).filter(candidate=>passesFilters(topSettings,candidate,now))})));
      const topSeasons = kind==='show'&&topSettings.active('newSeason')?await this.tmdb.returningSeasons(seedLists.flatMap(list=>list.items),now):undefined;
      if(topSeasons) for(const list of seedLists) list.items=list.items.map(c=>({...c,seasonPremiere:topSeasons.get(c.item.key)??c.seasonPremiere}));
      // Eras are per kind: someone may watch old movies and new shows.
      const taste: Taste = {genres:genreTaste(history, now, seeds_), era:eraTaste(mine, now, seeds_, eraStrength(topSettings))};
      const top = scoreCandidates(seedLists, taste, now, random, topSettings).slice(0, TOP_LIMIT);
      if (top.length) pool[kind === 'movie' ? 'top-movies' : 'top-shows'] = {title: kind === 'movie' ? 'Top Movie Picks for You' : 'Top Show Picks for You', items: top};
      // What the Top Picks row shows isn't suggested again just below it.
      const shown = new Set(top.slice(0, ROW_SHOWN).map(c => c.item.key));
      for (const seed of becauseOrder(mine, random)) {
        const items = (await this.tmdb.withPremieres(becauseSettings,(await suggestions(seed)).filter(c => !shown.has(c.item.key)),now))
          .filter(c => passesFilters(becauseSettings,c,now));
        if (items.length < BECAUSE_MIN) continue;
        const title = seed.title ?? await this.tmdb.title(kind === 'movie' ? 'movie' : 'tv', seed.tmdbId).catch(() => undefined);
        if (!title) continue;
        const becauseTaste: Taste = {genres:genreTaste(history, now), era:eraTaste(mine, now, undefined, eraStrength(becauseSettings))};
        const seasons=kind==='show'&&becauseSettings.active('newSeason')?await this.tmdb.returningSeasons(items,now):undefined;
        const candidates=seasons?items.map(c=>({...c,seasonPremiere:seasons.get(c.item.key)??c.seasonPremiere})):items;
        pool[kind === 'movie' ? 'because-movie' : 'because-show'] = {title: `Because You Watched ${title}`, items: scoreCandidates([{weight: 1, items:candidates}], becauseTaste, now, random, becauseSettings).slice(0, BECAUSE_LIMIT)};
        break;
      }
    }));
    // An outage should be retryable when there is nothing useful to display.
    if (!Object.keys(pool).length && reads > 0 && failures === reads) throw new AppError('CATALOG_UNAVAILABLE', 'Recommendations are temporarily unavailable.', 502);
    return {pool, partial};
  }
}
