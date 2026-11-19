import { collectionKey } from '../hidden-downloads.js';

// The collections' rules that need no Plex or provider: the checks a definition must pass, seasonal schedules, how a
// list's titles are filtered and sorted, and the streaming services and smart collections tk.box keeps. The messages
// are shown on the Collections page as they are.
export { collectionKey };
export class CollectionError extends Error {}
const fail = (message: string): never => { throw new CollectionError(message); };

export type Member = { rating_key?: string; tmdb_id?: number; imdb_id?: string; title?: string; year?: number };
export type ListFilter = { year_from?: number; year_to?: number; min_rating?: number; max_rating?: number; languages?: string[]; exclude_genres?: string[]; exclude_certifications?: string[] };
export type ListSort = 'list' | 'rating' | 'oldest' | 'newest' | 'anniversary' | 'random';
export type Source = { url: string; limit?: number; refresh?: boolean; filter?: ListFilter; sort?: ListSort };
export type Visibility = Partial<Record<'home' | 'shared' | 'recommended', boolean>>;
export type Definition = { name: string; library: string; type: 'movie' | 'tv'; enabled?: boolean; schedule?: string; sync?: string; members?: Member[]; rules?: Rules;
  visibility?: Visibility; acquire?: boolean; cleanup?: 'keep' | 'remove-delete' | 'rotate'; hide_recent?: boolean; source?: Source; exclude?: Member[] };
export type Rules = { genres?: string[]; year_from?: number; year_to?: number; title_contains?: string };
export type Automatic = { name: string; library: string; kind?: 'franchise' | 'streaming'; enabled?: boolean; visibility?: Visibility; exclude?: string[] };

export const SOURCE_LIMIT = 50, SOURCE_REFRESH = true;
export const VISIBILITY = { home: 'promotedToOwnHome', shared: 'promotedToSharedHome', recommended: 'promotedToRecommended' } as const;
const LIST_SORTS: readonly ListSort[] = ['list', 'rating', 'oldest', 'newest', 'anniversary', 'random'];
// Genres and certifications name what's left out, so one a list gains later is in; languages name what's kept.
const LIST_FILTERS = new Set(['year_from', 'year_to', 'min_rating', 'max_rating', 'languages', 'exclude_genres', 'exclude_certifications']);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysOutside = (value: Record<string, unknown>, allowed: Iterable<string>) => { const ok = new Set(allowed); return Object.keys(value).some(k => !ok.has(k)); };

// Streaming services as Kometa's streaming default lists them: collection name, TMDb watch-provider IDs, and the network
// names TMDb uses for the service's own shows.
export const STREAMING: readonly (readonly [string, readonly number[], readonly string[]])[] = [
  ['Netflix', [8], ['Netflix']], ['Disney+', [337], ['Disney+']], ['Hulu', [15], ['Hulu']], ['Prime Video', [9], ['Prime Video', 'Amazon', 'Amazon Prime Video']],
  ['HBO Max', [1899], ['HBO Max', 'Max']], ['Apple TV', [350], ['Apple TV+', 'Apple TV']], ['Paramount+', [531, 1770], ['Paramount+', 'Paramount Plus']], ['Peacock', [387], ['Peacock']],
  ['discovery+', [510], ['discovery+']], ['Crunchyroll', [283], ['Crunchyroll']], ['AMC+', [528, 1854], ['AMC+']], ['BET+', [1759], ['BET+']], ['hayu', [223], ['hayu']],
  ['YouTube', [188], ['YouTube']], ['Tubi', [73], ['Tubi']]];
// Kometa's two "basic" chart collections, as Plex smart collections: library kind, name, Plex type, date field, days back.
export const CHARTS = [['movie', 'Newly Released', 1, 'originallyAvailableAt', 90], ['show', 'New Episodes', 4, 'episode.originallyAvailableAt', 7]] as const;

const networkKey = (name: unknown) => String(name ?? '').toLowerCase().replaceAll('+', 'plus').replace(/[^a-z0-9]/g, '');
// One TMDb show's streaming services (fetched with append_to_response=watch/providers): those it originally aired on
// ("originals") or streams on now, free or subscription, in `region` ("available").
export function streamingServices(data: Record<string, any>, mode: 'originals' | 'available', region: string) {
  if (mode === 'originals') {
    const networks = new Set(((data.networks ?? []) as { name?: string }[]).map(n => networkKey(n.name)));
    return STREAMING.filter(([, , aliases]) => aliases.some(a => networks.has(networkKey(a)))).map(([name]) => name);
  }
  const offers = data['watch/providers']?.results?.[region] ?? {};
  const ids = new Set<number>(['flatrate', 'free', 'ads'].flatMap(kind => ((offers[kind] ?? []) as { provider_id?: number }[]).map(p => p.provider_id!)));
  return STREAMING.filter(([, providers]) => providers.some(id => ids.has(id))).map(([name]) => name);
}
// A TMDb movie collection's name as its franchise collection is called: "Alien Collection" is "Alien".
export const franchiseName = (collection: { id: number; name?: string }) => (collection.name ?? '').replace(/\s+Collection$/, '').trim() || String(collection.id);

export function collectionActive(schedule: unknown, today = new Date()) {
  if (!schedule) return true;
  if (typeof schedule !== 'string' || !/^\d{2}\/\d{2}-\d{2}\/\d{2}$/.test(schedule)) fail('Collection schedule must be MM/DD-MM/DD');
  const [start, end] = (schedule as string).split('-').map(part => part.split('/').map(Number) as [number, number]) as [[number, number], [number, number]];
  for (const [month, day] of [start, end]) { const d = new Date(2000, month - 1, day); if (d.getMonth() !== month - 1 || d.getDate() !== day) fail(month < 1 || month > 12 ? 'month must be in 1..12' : 'day is out of range for month'); }
  const current = (today.getMonth() + 1) * 100 + today.getDate(), from = start[0] * 100 + start[1], to = end[0] * 100 + end[1];
  return from <= to ? from <= current && current <= to : current >= from || current <= to;
}

// A source's filter and sort, checked: {} when it keeps the list as it is (no filter, list order).
export function sourceChoice(source: { filter?: unknown; sort?: unknown }): { filter?: ListFilter; sort?: ListSort } {
  const found = (source.filter ?? {}) as Record<string, unknown>, sort = (source.sort ?? 'list') as ListSort;
  if (!isRecord(found) || keysOutside(found, LIST_FILTERS)) fail('A list filter supports ' + [...LIST_FILTERS].sort().join(', '));
  if (!LIST_SORTS.includes(sort)) fail('A list sort is one of ' + LIST_SORTS.join(', '));
  for (const key of ['year_from', 'year_to']) if (key in found && (!isInt(found[key]) || (found[key] as number) < 0 || (found[key] as number) > 9999)) fail(`Filter ${key} must be a year`);
  for (const key of ['min_rating', 'max_rating']) if (key in found && (typeof found[key] !== 'number' || (found[key] as number) < 0 || (found[key] as number) > 10)) fail(`Filter ${key} must be from 0 to 10`);
  for (const key of ['languages', 'exclude_genres', 'exclude_certifications'])
    if (key in found && (!Array.isArray(found[key]) || (found[key] as unknown[]).some(v => typeof v !== 'string' || !v.trim()))) fail(`Filter ${key} must be a list of names`);
  if (((found.year_from as number) ?? 0) > ((found.year_to as number) ?? 9999)) fail('Filter year_from must not exceed year_to');
  if (((found.min_rating as number) ?? 0) > ((found.max_rating as number) ?? 10)) fail('Filter min_rating must not exceed max_rating');
  const kept = Object.fromEntries(Object.entries(found).filter(([, v]) => !(Array.isArray(v) && !v.length))) as ListFilter;
  return { ...(Object.keys(kept).length ? { filter: kept } : {}), ...(sort !== 'list' ? { sort } : {}) };
}

export const roundAnniversary = (age: number) => age > 0 && (age % 10 === 0 || age % 25 === 0);
// The ISO year and week, as "2026-43" (list-choice.ts's isoWeek): "random" keeps one order all week.
export function isoWeek(day: Date) {
  const t = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())), weekday = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - weekday);
  const year = t.getUTCFullYear(), week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}
// FNV-1a of the week and a member, the order "random" sorts by. The editor sorts by the same (list-choice.ts).
export function weekHash(week: string, member: Member) {
  const text = week + '|' + Object.keys(member).sort().map(k => `${k}=${member[k as keyof Member]}`).join('&');
  let value = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value;
}
export const sameMember = (a: Member, b: Member) => { const keys = Object.keys(a) as (keyof Member)[]; return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]); };

export type Details = { year: number | null; rating: number | null; language: string | null; genres: string[]; certification: string | null };
export type ListRow = { title: string; year: string; member: Member; details?: Details | null };
// The rows a filtered, sorted list keeps (at most `limit`; their details come off), and the rest with why. Titles in
// `exclude` are taken out first, so they don't use up the limit. Sorting is stable, so ties keep the list's order;
// "random" is the same all week, so a nightly run doesn't swap titles.
export function chooseTitles(rows: ListRow[], choose: { filter?: ListFilter; sort?: ListSort }, limit: number, today = new Date(), exclude: Member[] = []) {
  const f = choose.filter ?? {}, sort = choose.sort ?? 'list', kept: ListRow[] = [], left: { title: string; year: string; why: string }[] = [];
  const fold = (names: string[]) => new Set(names.map(n => n.trim().toLowerCase()));
  const filtered = Object.keys(f).length > 0;
  for (const row of rows) {
    if (exclude.some(m => sameMember(m, row.member))) continue;
    const d = row.details;
    let why: string | undefined;
    if (!d) why = filtered ? 'no TMDb details' : undefined;
    else if ((f.year_from !== undefined || f.year_to !== undefined) && !d.year) why = 'no release year';
    else if (d.year && d.year < (f.year_from ?? 0)) why = `released before ${f.year_from}`;
    else if (d.year && d.year > (f.year_to ?? 9999)) why = `released after ${f.year_to}`;
    else if (f.min_rating !== undefined && (d.rating ?? 0) < f.min_rating) why = `rated below ${f.min_rating} on TMDb`;
    else if (f.max_rating !== undefined && (d.rating ?? 0) > f.max_rating) why = `rated above ${f.max_rating} on TMDb`;
    else if (f.languages?.length && !fold(f.languages).has((d.language ?? '').toLowerCase())) why = 'in a language left out';
    else if ([...fold(f.exclude_genres ?? [])].some(g => fold(d.genres).has(g))) why = 'in a genre left out';
    else if (fold(f.exclude_certifications ?? []).has((d.certification || 'NR').toLowerCase())) why = `rated ${d.certification || 'NR'}`;
    if (why) left.push({ title: row.title, year: row.year, why }); else kept.push(row);
  }
  const year = (r: ListRow) => r.details?.year ?? null, week = isoWeek(today);
  const keys: Partial<Record<ListSort, (r: ListRow) => number>> = {
    rating: r => -(r.details?.rating ?? 0), oldest: r => year(r) || 9999, newest: r => -(year(r) || 0),
    anniversary: r => { const y = year(r); return y && roundAnniversary(today.getFullYear() - y) ? 0 : 1; }, random: r => weekHash(week, r.member) };
  const key = keys[sort];
  if (key) kept.sort((a, b) => key(a) - key(b));
  left.push(...kept.slice(limit).map(r => ({ title: r.title, year: r.year, why: 'beyond the collection size' })));
  return { kept: kept.slice(0, limit).map(({ details: _, ...row }) => row), left };
}

// The checks every saved definition passes (and a run checks again). `checkSource` is the list URL rule (sources.ts).
export function validateCollections(definitions: unknown, checkSource: (url: unknown) => unknown): Definition[] {
  if (!Array.isArray(definitions)) fail('collections must be a list');
  const seen = new Set<string>();
  for (const entry of definitions as Record<string, any>[]) {
    if (!isRecord(entry) || keysOutside(entry, ['name', 'library', 'type', 'enabled', 'schedule', 'sync', 'members', 'rules', 'visibility', 'acquire', 'cleanup', 'hide_recent', 'source', 'exclude']))
      fail('Each collection must be a mapping with supported collection settings');
    for (const field of ['name', 'library']) {
      const value = entry[field];
      if (typeof value !== 'string' || !value.trim() || [...value].some(c => c.charCodeAt(0) < 32)) fail(`Collection ${field} must be nonempty text`);
    }
    const identity = `${entry.library}\0${collectionKey(entry.name)}`;
    if (!collectionKey(entry.name) || seen.has(identity)) fail('Collection names must be unique within each library');
    seen.add(identity);
    if (entry.type !== 'movie' && entry.type !== 'tv') fail('Collection type must be movie or tv');
    for (const field of ['enabled', 'acquire', 'hide_recent']) if (field in entry && typeof entry[field] !== 'boolean') fail(`Collection ${field} must be true or false`);
    if (!['sync', 'append'].includes(entry.sync ?? 'append')) fail('Collection sync must be sync or append');
    collectionActive(entry.schedule);
    const source = entry.source;
    if (source !== undefined && source !== null) {
      if (!isRecord(source) || keysOutside(source, ['url', 'limit', 'refresh', 'filter', 'sort'])) fail('Collection source supports url, limit, refresh, filter and sort');
      sourceChoice(source);
      checkSource(source.url);
      const limit = source.limit ?? SOURCE_LIMIT;
      if (!isInt(limit) || limit < 1 || limit > 250) fail('Source limit must be an integer from 1 to 250');
      if ('refresh' in source && typeof source.refresh !== 'boolean') fail('Source refresh must be true or false');
    }
    const members = entry.members ?? [], rules = entry.rules ?? {}, exclude = entry.exclude ?? [];
    if (!Array.isArray(members) || !Array.isArray(exclude) || !isRecord(rules)) fail('Collection members and exclude must be lists and rules must be a mapping');
    for (const member of [...members, ...exclude]) {
      if (!isRecord(member) || !Object.keys(member).length || keysOutside(member, ['rating_key', 'tmdb_id', 'imdb_id', 'title', 'year'])) fail('Collection members use rating_key, tmdb_id, imdb_id, or title and optional year');
      if (['rating_key', 'tmdb_id', 'imdb_id', 'title'].filter(k => k in member).length !== 1 || ('year' in member && !('title' in member))) fail('Use exactly one identifier per collection member');
      for (const [key, value] of Object.entries(member)) {
        if (key === 'year' || key === 'tmdb_id') { if (!isInt(value) || value < 1) fail(`Member ${key} must be a positive integer`); }
        else if (typeof value !== 'string' || !value.trim() || (key === 'rating_key' && !/^\d+$/.test(value)) || (key === 'imdb_id' && !/^tt\d+$/.test(value))) fail(`Invalid member ${key}`);
      }
    }
    if (keysOutside(rules, ['genres', 'year_from', 'year_to', 'title_contains'])) fail('Rules support genres, year_from, year_to and title_contains');
    if ('genres' in rules && (!Array.isArray(rules.genres) || !rules.genres.length || rules.genres.some((g: unknown) => typeof g !== 'string' || !g.trim()))) fail('genres must be a nonempty list of names');
    for (const key of ['year_from', 'year_to']) if (key in rules && (!isInt(rules[key]) || rules[key] < 1 || rules[key] > 9999)) fail(`${key} must be a year`);
    if ((rules.year_from ?? 1) > (rules.year_to ?? 9999)) fail('year_from must not exceed year_to');
    if ('title_contains' in rules && (typeof rules.title_contains !== 'string' || !rules.title_contains.trim())) fail('title_contains must be nonempty text');
    // A collection that is off may still be a draft; it needs something to hold only once it is on.
    const enabled = entry.enabled ?? true;
    if (enabled && !members.length && !Object.keys(rules).length && !source) fail(`${entry.name} needs titles, a list or a rule before it can be turned on`);
    const visibility = entry.visibility ?? {};
    if (!isRecord(visibility) || keysOutside(visibility, ['home', 'shared', 'recommended']) || Object.values(visibility).some(v => typeof v !== 'boolean')) fail('visibility accepts home, shared and recommended booleans');
    if (!['keep', 'remove-delete', 'rotate'].includes(entry.cleanup ?? 'keep')) fail('Collection cleanup must be keep, remove-delete or rotate');
    if (entry.acquire && entry.type !== 'movie') fail(`${entry.name}: only movie collections can download`);
    if (enabled && entry.acquire && !(source || members.some((m: Member) => 'tmdb_id' in m))) fail(`${entry.name}: downloads need titles with TMDb IDs (tmdb:123) or a list`);
    if (entry.cleanup === 'remove-delete' && (!entry.schedule || !entry.acquire)) fail('remove-delete requires a seasonal collection with acquire: true');
    // Rotating deletes what leaves the list, so the list must be read on every run.
    if (entry.cleanup === 'rotate' && (!entry.acquire || !source || !(source.refresh ?? SOURCE_REFRESH))) fail('rotate requires acquire: true and a list that is refreshed on every run');
  }
  return definitions as Definition[];
}

// {library\0collection key: setting} for the franchise and streaming collections the admin turned off or set where
// they show; the rest are kept as they are made.
export function validateAutomatic(settings: unknown) {
  if (!Array.isArray(settings)) fail('Automatic collections must be a list');
  const found = new Map<string, Automatic>();
  for (const entry of settings as Record<string, any>[]) {
    if (!isRecord(entry) || keysOutside(entry, ['name', 'library', 'kind', 'enabled', 'visibility', 'exclude'])) fail('Each automatic collection setting supports name, library, kind, enabled, visibility and exclude');
    const exclude = entry.exclude ?? [];
    if (!Array.isArray(exclude) || exclude.some((k: unknown) => typeof k !== 'string' || !/^\d+$/.test(k))) fail('An automatic collection’s exclude is a list of Plex IDs');
    if (!['name', 'library'].every(k => typeof entry[k] === 'string' && entry[k].trim())) fail('Automatic collection settings need a name and a library');
    if (!['franchise', 'streaming'].includes(entry.kind ?? 'franchise') || typeof (entry.enabled ?? true) !== 'boolean') fail('Automatic collection kind must be franchise or streaming, and enabled true or false');
    const visibility = entry.visibility ?? {};
    if (!isRecord(visibility) || keysOutside(visibility, Object.keys(VISIBILITY)) || Object.values(visibility).some(v => typeof v !== 'boolean')) fail('visibility accepts home, shared and recommended booleans');
    found.set(`${entry.library}\0${collectionKey(entry.name)}`, entry as Automatic);
  }
  return found;
}
