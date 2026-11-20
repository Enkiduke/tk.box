// Explore's rows as data: where a row's titles come from, and the signals that filter, boost and order them.
// Shared by the server (which runs them, services/explore) and Admin › Explore (which edits them). No zod here: the
// server validates with its own schema built from these lists.
import {exploreGenres, type ExploreGenre} from './explore.js';

export type ExploreKind = 'movie' | 'show';
export type ExploreRowSource =
  // TMDB's catalog: by popularity, by rating or newest first; `streaming` limits it to the viewer's services and
  // `unreleased` keeps titles not out yet.
  | {type: 'tmdb-discover'; kind: ExploreKind | 'both'; sort: 'popularity' | 'rating' | 'newest'; streaming?: boolean; unreleased?: boolean}
  | {type: 'tmdb-trending'; kind: ExploreKind | 'both'; window: 'day' | 'week'}
  | {type: 'tmdb-upcoming'; kind: ExploreKind}
  // Each viewer's own: from their watch history. Only the built-in four exist.
  | {type: 'recommendations'; kind: ExploreKind; mode: 'top' | 'because'};
export type ExploreSourceType = ExploreRowSource['type'];

export type ExploreParamValue = number | string[];
export type ExploreSignalUse = {id: ExploreSignalId; on: boolean; params: Record<string, ExploreParamValue>};
// A TMDB row: built in (fixed source) or made in Admin › Explore. Signals left out are off with their defaults.
export type ExploreRowDef = {title: string; source: ExploreRowSource; signals: ExploreSignalUse[]};

type Unit = '%' | '±%' | 'days' | 'votes' | '/10' | 'positions' | 'titles' | 'year';
export type ExploreParam =
  | {id: string; label: string; unit?: Unit; min: number; max: number; step: number}
  | {id: string; label: string; list: 'genres' | 'languages'}
  // A switch, saved as 1 (on) or left out (off). `shows`: only for rows that have shows.
  | {id: string; label: string; toggle: true; shows?: true};
export type ExploreSignalKind = 'filter' | 'boost' | 'order';
export type ExploreSignalMeta = {
  label: string; kind: ExploreSignalKind;
  // A short hint, shown on hover.
  hint: string;
  params: ExploreParam[];
  // Its values when switched on for the first time.
  defaults: Record<string, ExploreParamValue>;
  // Values with no effect: a signal that is off runs with these.
  neutral: Record<string, ExploreParamValue>;
  // Boosts: the Low / Medium / High values of the first parameter.
  levels?: [number, number, number];
  // The sources it makes sense for.
  applies: (source: ExploreRowSource) => boolean;
};

const is = (...types: ExploreSourceType[]) => (s: ExploreRowSource) => types.includes(s.type);
const shows = (s: ExploreRowSource) => s.kind !== 'movie';
const top = (s: ExploreRowSource) => s.type === 'recommendations' && s.mode === 'top';
const pct = (id: string, label: string, max = 200): ExploreParam => ({id, label, unit:'%', min:0, max, step:1});
const days = (id: string, label: string, min = 1, max = 1095): ExploreParam => ({id, label, unit:'days', min, max, step:1});

export const exploreSignals = {
  // Filters
  minRating: {label:'Minimum rating', kind:'filter', hint:'TMDB audience rating.', params:[{id:'rating', label:'Rating', unit:'/10', min:0, max:10, step:0.1}],
    defaults:{rating:7}, neutral:{rating:0}, applies:() => true},
  minVotes: {label:'Minimum votes', kind:'filter', hint:'TMDB vote count.', params:[{id:'votes', label:'Votes', unit:'votes', min:0, max:10000, step:1}],
    defaults:{votes:50}, neutral:{votes:0}, applies:() => true},
  releasedWithin: {label:'Released within', kind:'filter', hint:'Only titles out within this many days.',
    params:[days('days', 'Days'), {id:'seasons', label:'Count new seasons', toggle:true, shows:true}],
    defaults:{days:180}, neutral:{days:0}, applies:is('tmdb-discover', 'tmdb-trending', 'recommendations')},
  upcomingWithin: {label:'Releases within', kind:'filter', hint:'How far ahead the row looks.', params:[days('days', 'Days')],
    defaults:{days:547}, neutral:{days:0}, applies:is('tmdb-upcoming')},
  genres: {label:'Genres', kind:'filter', hint:'Titles in any of these genres.', params:[{id:'genres', label:'Genres', list:'genres'}],
    defaults:{genres:[]}, neutral:{genres:[]}, applies:() => true},
  languages: {label:'Original language', kind:'filter', hint:'Titles in any of these languages.', params:[{id:'languages', label:'Languages', list:'languages'}],
    defaults:{languages:[]}, neutral:{languages:[]}, applies:() => true},
  years: {label:'Release years', kind:'filter', hint:'Titles released in this range.',
    params:[{id:'from', label:'From', unit:'year', min:1870, max:2100, step:1}, {id:'to', label:'To', unit:'year', min:1870, max:2100, step:1}],
    defaults:{from:1990, to:2029}, neutral:{from:1870, to:2100}, applies:() => true},
  // Boosts
  recentRelease: {label:'Recent release', kind:'boost', hint:'Lift titles released lately, fading over the period.',
    params:[pct('boost', 'Up to'), days('days', 'Fades over')], defaults:{boost:25, days:90}, neutral:{boost:0}, levels:[10, 25, 50],
    applies:is('tmdb-discover', 'tmdb-trending')},
  newSeason: {label:'New season', kind:'boost', hint:'Lift returning shows whose new season just started.',
    params:[pct('boost', 'Up to'), days('days', 'Fades over', 1, 365)], defaults:{boost:25, days:90}, neutral:{boost:0}, levels:[10, 25, 50],
    applies:s => shows(s) && is('tmdb-discover', 'tmdb-trending', 'recommendations')(s)},
  freshness: {label:'Freshness', kind:'boost', hint:'Lift newer titles: full for the first period, then fading.',
    params:[pct('boost', 'Up to'), days('fullDays', 'Full for', 0, 1824), days('endDays', 'Gone by', 1, 1825)],
    defaults:{boost:100, fullDays:182, endDays:1095}, neutral:{boost:0}, levels:[50, 100, 150], applies:is('recommendations')},
  popularity: {label:'TMDB popularity', kind:'boost', hint:'Lift titles with more engagement on TMDB.',
    params:[pct('strength', 'Up to')], defaults:{strength:25}, neutral:{strength:0}, levels:[10, 25, 50],
    applies:is('tmdb-discover', 'tmdb-trending', 'recommendations')},
  audience: {label:'Audience rating', kind:'boost', hint:'Raise well-rated titles and lower poorly rated ones; few votes count less.',
    params:[{id:'strength', label:'Range', unit:'±%', min:0, max:100, step:1}, {id:'priorVotes', label:'Half trust at', unit:'votes', min:1, max:10000, step:1}],
    defaults:{strength:25, priorVotes:200}, neutral:{strength:0}, levels:[15, 25, 40], applies:() => true},
  genreAffinity: {label:'Genre affinity', kind:'boost', hint:'Lift genres the viewer watches.', params:[pct('strength', 'Up to', 100)],
    defaults:{strength:40}, neutral:{strength:0}, levels:[20, 40, 70], applies:is('recommendations')},
  eraAffinity: {label:'Era affinity', kind:'boost', hint:'Raise release years near the viewer’s watching.',
    params:[{id:'strength', label:'Range', unit:'±%', min:0, max:100, step:1}], defaults:{strength:40}, neutral:{strength:0}, levels:[20, 40, 70],
    applies:is('recommendations')},
  matchPosition: {label:'Match position', kind:'boost', hint:'Titles higher on TMDB’s suggestion lists count more.',
    params:[{id:'decay', label:'Half weight at', unit:'positions', min:1, max:100, step:1}], defaults:{decay:8}, neutral:{decay:0}, applies:is('recommendations')},
  watchOrder: {label:'Watch order', kind:'boost', hint:'Recent watches count more than older ones in the list.',
    params:[{id:'retention', label:'Kept per step', unit:'%', min:1, max:100, step:1}], defaults:{retention:90}, neutral:{retention:100}, applies:top},
  watchRecency: {label:'Watch recency', kind:'boost', hint:'Older watches fade.', params:[days('halfLife', 'Half weight after', 1, 3650)],
    defaults:{halfLife:180}, neutral:{halfLife:0}, applies:top},
  watchFrequency: {label:'Watch frequency', kind:'boost', hint:'Titles watched more often count more.', params:[pct('strength', 'Up to')],
    defaults:{strength:100}, neutral:{strength:0}, levels:[50, 100, 150], applies:top},
  upcomingProximity: {label:'Release proximity', kind:'boost', hint:'Weight titles coming out soon.',
    params:[{id:'near', label:'Near term', unit:'%', min:0, max:300, step:0.5}, {id:'nearDays', label:'Near term ends', unit:'days', min:0, max:1094, step:1},
      {id:'mid', label:'Mid term', unit:'%', min:0, max:300, step:0.5}, {id:'midDays', label:'Mid term ends', unit:'days', min:1, max:1095, step:1}],
    defaults:{near:125, nearDays:44, mid:112.5, midDays:89}, neutral:{near:100, mid:100}, applies:is('tmdb-upcoming')},
  // Ordering
  variety: {label:'Variety', kind:'order', hint:'Space out one series’ entries and one genre.', params:[], defaults:{}, neutral:{}, applies:is('recommendations')},
  spread: {label:'Spread across watches', kind:'order', hint:'No one watched title supplies most of the row.',
    params:[{id:'shownCap', label:'Most in first 20', unit:'titles', min:1, max:20, step:1}, {id:'rowCap', label:'Most in row', unit:'titles', min:1, max:60, step:1}],
    defaults:{shownCap:5, rowCap:15}, neutral:{}, applies:top},
  shuffle: {label:'Daily shuffle', kind:'order', hint:'Vary the order a little each day.', params:[pct('strength', 'Up to', 100)],
    defaults:{strength:15}, neutral:{strength:0}, levels:[5, 15, 30], applies:is('recommendations')}
} satisfies Record<string, ExploreSignalMeta>;
export type ExploreSignalId = keyof typeof exploreSignals;
export const exploreSignalIds = Object.keys(exploreSignals) as ExploreSignalId[];
export const exploreSignal = (id: ExploreSignalId): ExploreSignalMeta => exploreSignals[id];
export const exploreSignalsFor = (source: ExploreRowSource) => exploreSignalIds.filter(id => exploreSignal(id).applies(source));

// A parameter's bounds, narrowed by its partner (near term before mid term, full freshness before it is gone).
const before: Record<string, string> = {nearDays:'midDays', fullDays:'endDays', from:'to'};
const after: Record<string, string> = {midDays:'nearDays', endDays:'fullDays', to:'from'};
export function exploreParamBounds(param: Extract<ExploreParam, {min: number}>, values: Record<string, ExploreParamValue>) {
  const gap = param.id === 'from' || param.id === 'to' ? 0 : 1;
  const upper = before[param.id] ? values[before[param.id]!] : undefined, lower = after[param.id] ? values[after[param.id]!] : undefined;
  return {min:typeof lower === 'number' ? Math.max(param.min, lower + gap) : param.min,
    max:typeof upper === 'number' ? Math.min(param.max, upper - gap) : param.max, step:param.step};
}

// A row's signal: on or off, with its values (the row's, or the signal's defaults).
export function signalUse(def: ExploreRowDef, id: ExploreSignalId): ExploreSignalUse {
  const found = def.signals.find(s => s.id === id), meta = exploreSignal(id);
  return {id, on:found?.on ?? false, params:{...meta.defaults, ...found?.params}};
}
// The values a signal runs with: its own when on, otherwise ones with no effect. Undefined when it isn't for this source.
export function signalValues(def: ExploreRowDef, id: ExploreSignalId): Record<string, ExploreParamValue> {
  const use = signalUse(def, id), meta = exploreSignal(id);
  if (!meta.applies(def.source)) return {...meta.defaults, ...meta.neutral};
  return use.on ? use.params : {...use.params, ...meta.neutral};
}
const same = (a: ExploreParamValue | undefined, b: ExploreParamValue | undefined) =>
  Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a ?? []) === JSON.stringify(b ?? []) : a === b;
// On, and with a value that does something.
export function signalActive(def: ExploreRowDef, id: ExploreSignalId) {
  const use = signalUse(def, id), meta = exploreSignal(id);
  if (!use.on || !meta.applies(def.source)) return false;
  const neutral = Object.entries(meta.neutral);
  return !neutral.length || neutral.some(([key, value]) => !same(use.params[key], value));
}
export const num = (values: Record<string, ExploreParamValue>, key: string) => {const v = values[key]; return typeof v === 'number' ? v : 0;};
export const list = (values: Record<string, ExploreParamValue>, key: string) => {const v = values[key]; return Array.isArray(v) ? v : [];};
// A boost's level: Off, Low, Medium, High, or Custom when its values match none.
export function signalLevel(use: ExploreSignalUse): 'off' | 'low' | 'medium' | 'high' | 'custom' {
  const meta = exploreSignal(use.id);
  if (!use.on) return 'off';
  const first = meta.params[0], at = first && meta.levels ? meta.levels.indexOf(num(use.params, first.id)) : -1;
  const rest = meta.params.slice(1).every(p => same(use.params[p.id], meta.defaults[p.id]));
  return at >= 0 && rest ? (['low', 'medium', 'high'] as const)[at]! : 'custom';
}
export function withLevel(use: ExploreSignalUse, level: 'off' | 'low' | 'medium' | 'high'): ExploreSignalUse {
  const meta = exploreSignal(use.id);
  if (level === 'off') return {...use, on:false};
  const first = meta.params[0]!;
  return {id:use.id, on:true, params:{...meta.defaults, [first.id]:meta.levels![['low', 'medium', 'high'].indexOf(level)]!}};
}
// A row with one signal changed. Signals equal to off-with-defaults are left out, so a row stays short.
export function setSignal(def: ExploreRowDef, use: ExploreSignalUse): ExploreRowDef {
  const meta = exploreSignal(use.id), plain = !use.on && Object.entries(meta.defaults).every(([k, v]) => same(use.params[k], v));
  const signals = def.signals.filter(s => s.id !== use.id);
  return {...def, signals:plain ? signals : [...signals, use].sort((a, b) => exploreSignalIds.indexOf(a.id) - exploreSignalIds.indexOf(b.id))};
}

// Signals in the registry's order, so equal rows compare equal.
export const normalizeRowDef = (def: ExploreRowDef): ExploreRowDef =>
  ({...def, signals:[...def.signals].sort((a, b) => exploreSignalIds.indexOf(a.id) - exploreSignalIds.indexOf(b.id))});
export const sameRowDef = (a: ExploreRowDef, b: ExploreRowDef) => JSON.stringify(normalizeRowDef(a)) === JSON.stringify(normalizeRowDef(b));

const signal = (id: ExploreSignalId, params: Record<string, ExploreParamValue> = {}): ExploreSignalUse =>
  ({id, on:true, params:{...exploreSignal(id).defaults, ...params}});
const personal = (kind: ExploreKind, mode: 'top' | 'because'): ExploreRowDef => normalizeRowDef({
  title:mode === 'top' ? `Top ${kind === 'movie' ? 'Movie' : 'Show'} Picks for You` : `Because You Watched · ${kind === 'movie' ? 'Movie' : 'Show'}`,
  source:{type:'recommendations', kind, mode},
  signals:[signal('audience', {strength:40}), signal('freshness'), signal('genreAffinity'), signal('eraAffinity'), signal('matchPosition'),
    ...(mode === 'top' ? [signal('watchOrder'), signal('watchRecency'), signal('watchFrequency')] : []),
    signal('variety'), ...(mode === 'top' ? [signal('spread')] : []), signal('shuffle')]
});
const upcoming = (kind: ExploreKind): ExploreRowDef => ({title:`Upcoming ${kind === 'movie' ? 'Movies' : 'Shows'}`, source:{type:'tmdb-upcoming', kind},
  signals:[signal('upcomingWithin'), signal('upcomingProximity')]});
// tk.box's own rows, in their default order. Their ids are kept for each viewer's hidden rows.
export const builtInRows = {
  'popular-movies': {title:'Popular Movies', source:{type:'tmdb-discover', kind:'movie', sort:'popularity'}, signals:[]},
  'popular-shows': {title:'Popular Shows', source:{type:'tmdb-discover', kind:'show', sort:'popularity'}, signals:[]},
  'top-movies': personal('movie', 'top'),
  'top-shows': personal('show', 'top'),
  trending: {title:'Trending Now', source:{type:'tmdb-trending', kind:'both', window:'week'}, signals:[]},
  'because-movie': personal('movie', 'because'),
  'popular-streaming': {title:'Popular on Streaming', source:{type:'tmdb-discover', kind:'both', sort:'popularity', streaming:true, unreleased:true}, signals:[]},
  'because-show': personal('show', 'because'),
  'recent-streaming': {title:'Recently Released on Streaming', source:{type:'tmdb-discover', kind:'both', sort:'newest', streaming:true},
    signals:[signal('releasedWithin', {days:180})]},
  acclaimed: {title:'Critically Acclaimed New Releases', source:{type:'tmdb-discover', kind:'both', sort:'rating'},
    signals:[signal('minRating', {rating:7.2}), signal('minVotes', {votes:50}), signal('releasedWithin', {days:365})]},
  'upcoming-movies': upcoming('movie'),
  'upcoming-shows': upcoming('show')
} satisfies Record<string, ExploreRowDef>;
export type BuiltInRow = keyof typeof builtInRows;
export const builtInRowIds = Object.keys(builtInRows) as BuiltInRow[];
export const isBuiltInRow = (id: string): id is BuiltInRow => Object.hasOwn(builtInRows, id);

// How a row is listed: its icon, and whether it is each viewer's own or has a streaming-service picker.
export function rowIcon(source: ExploreRowSource) {
  if (source.type === 'recommendations') return source.mode === 'top' ? (source.kind === 'movie' ? 'movies' : 'shows') : 'star';
  if (source.type === 'tmdb-upcoming') return 'calendar';
  if (source.type === 'tmdb-trending') return 'star';
  if (source.streaming) return 'play';
  return source.kind === 'movie' ? 'movies' : source.kind === 'show' ? 'shows' : 'explore';
}
export function sourceLabel(source: ExploreRowSource) {
  const kind = source.kind === 'movie' ? 'Movies' : source.kind === 'show' ? 'Shows' : 'Movies and shows';
  switch (source.type) {
    case 'tmdb-discover': return `TMDB · ${source.streaming ? 'streaming · ' : ''}${{popularity:'popular', rating:'top rated', newest:'newest'}[source.sort]} · ${kind}`;
    case 'tmdb-trending': return `TMDB · trending ${source.window === 'day' ? 'today' : 'this week'} · ${kind}`;
    case 'tmdb-upcoming': return `TMDB · upcoming · ${kind}`;
    case 'recommendations': return `Watch history · ${source.mode === 'top' ? 'top picks' : 'because you watched'} · ${kind}`;
  }
}

// One row on Explore, in order: `key` is `tmdb:<id>` or `plex:<shelf>`, as each viewer's hidden rows name it.
export type ExploreRowView = {key: string; source: 'plex' | 'tmdb'; id: string; title: string; icon: string; personal?: boolean; streaming?: boolean};
export type ExploreRows = {rows: ExploreRowView[]; failed: ('plex' | 'tmdb')[]};
// Admin › Explore: every row, shown or not. `definition` and `revision` are TMDB rows'; `defaults` a built-in's own.
export type ExploreAdminRow = ExploreRowView & {shown: boolean; builtIn: boolean; customized: boolean; missing?: boolean; unavailable?: boolean;
  definition?: ExploreRowDef; defaults?: ExploreRowDef; revision?: number};
export type ExploreAdminRows = {rows: ExploreAdminRow[]; tmdbConfigured: boolean; plexError?: string};
export const exploreLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'cn', 'hi', 'ta', 'te', 'ml', 'ru', 'sv', 'da', 'no', 'fi', 'nl', 'pl', 'tr', 'th', 'ar', 'he', 'id', 'tl'];
export const isExploreGenre = (g: string): g is ExploreGenre => (exploreGenres as readonly string[]).includes(g);
