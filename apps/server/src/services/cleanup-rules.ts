import type { CleanupSettings } from '../persistence/cleanup-store.js';
import type { CleanupRequest } from './requests.js';
import { collectionKey } from './hidden-downloads.js';

// Clean Up's rules (docs/ARCHITECTURE-AUDIT.md, Phase M): what a run deletes, keeps, holds and lists as leaving soon,
// decided from facts tk.box already owns. Pure: no Plex, no clock, no store. The facts are gathered by
// services/cleanup-run.ts (requests' `forCleanup`, the Plex index's `resolve` and copies, watch history's `watches`,
// the library's Keep and Artwork's collections) and its actions carry the decisions out. Ported rule for rule from the
// old Python purge script, with the same rule names, reasons and status entries.

const DAY = 86400000;
export const LEAVING_SOON_SORT_TITLE = '!011_Leaving Soon';
export type CleanupStatus = 'due' | 'deleted' | 'leaving' | 'kept' | 'protected' | 'not_found' | 'error';
// Each title a run looked at (Clean Up › Status). `deletion_date` is the rule's own date and `held_until` a later one an
// administrator's hold keeps it until. `key` names its hold and `rating_key` its Plex item, for the poster.
export type CleanupTitle = { title: string; year: number | null; kind: 'movie' | 'show' | 'season'; library: string; status: CleanupStatus;
  rule: string | null; reason: string; deletion_date: string | null; held_until?: string | null; key?: string | null; rating_key?: string | null; show_rating_key?: string | null; holdable?: boolean };
// tk.box's own collections, by kind. A custom collection with a Shown from–to range is seasonal; any collection not
// listed is "other".
export type CleanupCollection = { name: string; library: string; kind: 'franchise' | 'streaming' | 'custom' | 'seasonal' };
// A watch date, by scope and Plex rating key; account is a Plex account id, or '' for anyone (watch history's `watches`).
// Saved dates may also carry the title's TMDB id.
export type CleanupWatch = { scope: 'movie' | 'show' | 'season'; ratingKey: string; account: string; at: number; tmdb?: number };

// The Plex item a title resolved to (the first copy in the chosen libraries, as the script picked it), with the keys
// its watches may be recorded under: every copy's rating key, and for saved dates its TMDB id.
export type CleanupSeason = { season: number; ratingKey?: string; addedAt?: number; watchKeys: string[] };
export type CleanupItem = { ratingKey: string; section: string; library: string; addedAt?: number; watchKeys: string[];
  seasons?: CleanupSeason[]; collections?: string[]; collectionsError?: string };
// One title: every request for it (shared media is due only once every request's time is up), whether the library
// keeps it, and its Plex item (none: not in the chosen libraries).
export type CleanupCandidate = { kind: 'movie' | 'tv'; tmdb: number; requests: CleanupRequest[]; keep: boolean; item?: CleanupItem };
export type CleanupFacts = {
  now: number; dryRun: boolean; settings: Omit<CleanupSettings, 'schedule' | 'dryRun'>;
  // Hold key → until (ms), from Clean Up › Status.
  holds: Record<string, number>;
  collections: CleanupCollection[]; candidates: CleanupCandidate[];
  // How many requests the candidates came from.
  processed: number; watches: CleanupWatch[];
};
export type CleanupLevel = 'INFO' | 'WARNING' | 'ERROR';
export type CleanupDelete = { item: number; ratingKey: string; label: string; season: boolean };
export type CleanupCounts = { processed: number; deleted: number; planned: number; failed: number; skippedMissingAddedAt: number; notFound: number; protected: number; kept: number };
export type CleanupPlan = {
  items: CleanupTitle[]; counts: CleanupCounts; complete: boolean;
  // A real run's deletions, in order (`item` is the status entry); none in a dry run.
  deletes: CleanupDelete[];
  // Whole titles leaving soon, for the collection, and the rating keys checked and found not leaving.
  leaving: { ratingKey: string; section: string }[]; settled: Set<string>;
  summaries: { delete: Record<string, string[]>; leaving: Record<string, string[]>; season: Record<string, string[]> };
  log: { level: CleanupLevel; message: string }[];
};
export type Rule = { name: 'Rule 1' | 'Rule 2' | 'Rule 3' | 'Rule 4'; at: number; reason: string };
// The latest watch by anyone, and by each requester and exempt user (undefined: hasn't watched).
export type WatchStatus = { any?: number; users: Map<number, number | undefined> };
type RuleSettings = Pick<CleanupSettings, 'daysAfterWatched' | 'daysAfterUnwatched' | 'daysAfterAnyWatchExempt' | 'daysAfterExemptWatch' | 'exemptUserIds'>;

class MissingAddedAt extends Error {}
const iso = (ms: number) => new Date(ms).toISOString();
const date = (ms: number) => iso(ms).slice(0, 10);

export function retentionRule(addedAt: number, requester: number | null, watch: WatchStatus, settings: RuleSettings): Rule {
  // A request with no Plex requester (an old local account) is never exempt and has no watches of its own.
  const exempt = new Set(settings.exemptUserIds);
  let anchor: number, days: number, name: Rule['name'], reason: string;
  if (requester !== null && exempt.has(requester)) {
    const dates = settings.exemptUserIds.map(id => watch.users.get(id)).filter((at): at is number => at !== undefined);
    if (dates.length) {
      anchor = Math.max(...dates); days = settings.daysAfterExemptWatch; name = 'Rule 4';
      reason = `Exempt request, last exempt-user watch on ${date(anchor)}`;
    } else {
      anchor = watch.any ?? addedAt; days = settings.daysAfterAnyWatchExempt; name = 'Rule 3';
      reason = `Exempt request without exempt-user watches, anchored to ${date(anchor)}`;
    }
  } else if (requester !== null && watch.users.get(requester) !== undefined) {
    if (watch.any === undefined) throw new Error('Requestor watch exists without global watch history');
    anchor = watch.any; days = settings.daysAfterWatched; name = 'Rule 1';
    reason = `Non-exempt requestor watched it, last watch by anyone on ${date(anchor)}`;
  } else {
    // Anyone else's watch keeps it too, for as long as the requester's own watch would.
    const deadline = addedAt + settings.daysAfterUnwatched * DAY, last = watch.any;
    if (last !== undefined && last + settings.daysAfterWatched * DAY > deadline)
      return { name: 'Rule 2', at: last + settings.daysAfterWatched * DAY,
        reason: `Non-exempt requestor has not watched it; last watch by anyone on ${date(last)}; retention=${settings.daysAfterWatched} days after that watch` };
    anchor = addedAt; days = settings.daysAfterUnwatched; name = 'Rule 2';
    reason = `Non-exempt requestor has not watched it since added on ${date(anchor)}`;
  }
  return { name, at: anchor + days * DAY, reason: `${reason}; retention=${days} days` };
}
// Shared media is due only after every request's deadline; the first of equal dates wins.
export function ruleForRequests(requests: { addedAt: number; requester: number | null }[], watch: WatchStatus, settings: RuleSettings, seasonAddedAt?: number) {
  return requests.map(r => retentionRule(seasonAddedAt ?? r.addedAt, r.requester, watch, settings)).reduce((a, b) => b.at > a.at ? b : a);
}
// How tk.box names a title's hold: movie:<tmdb>, tv:<tmdb> or tv:<tmdb>:<season>.
export const holdKey = (kind: 'movie' | 'tv', tmdb: number, season?: number) => `${kind}:${tmdb}${season === undefined ? '' : `:${season}`}`;
// The date an administrator's hold keeps the title until, when it is later than the rule's own date.
export const heldUntil = (rule: Rule, holds: Record<string, number>, key: string) => { const until = holds[key]; return until !== undefined && until > rule.at ? until : undefined; };
export const daysRemaining = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / DAY));
export const leavingSoon = (at: number, now: number, days: number) => now < at && at <= now + days * DAY;

// Each movie's, show's and season's watches, by rating key and (saved dates) TMDB id.
export class WatchIndex {
  private byKey = new Map<string, CleanupWatch[]>();
  private byTmdb = new Map<string, CleanupWatch[]>();
  constructor(rows: CleanupWatch[], private exempt: number[]) {
    for (const row of rows) {
      (this.byKey.get(`${row.scope}:${row.ratingKey}`) ?? this.byKey.set(`${row.scope}:${row.ratingKey}`, []).get(`${row.scope}:${row.ratingKey}`)!).push(row);
      if (row.tmdb && row.scope !== 'season') (this.byTmdb.get(`${row.scope}:${row.tmdb}`) ?? this.byTmdb.set(`${row.scope}:${row.tmdb}`, []).get(`${row.scope}:${row.tmdb}`)!).push(row);
    }
  }
  // The latest watch by anyone, and by each of `requesters` and the exempt users, of any of `keys` (or, for a movie or
  // show, a saved date with its TMDB id).
  status(scope: CleanupWatch['scope'], keys: string[], requesters: Iterable<number>, tmdb?: number): WatchStatus {
    const rows = new Set<CleanupWatch>();
    for (const key of keys) for (const row of this.byKey.get(`${scope}:${key}`) ?? []) rows.add(row);
    if (tmdb !== undefined && scope !== 'season') for (const row of this.byTmdb.get(`${scope}:${tmdb}`) ?? []) rows.add(row);
    let any: number | undefined;
    const users = new Map<number, number | undefined>([...new Set([...requesters, ...this.exempt])].sort((a, b) => a - b).map(id => [id, undefined]));
    for (const row of rows) {
      any = Math.max(any ?? row.at, row.at);
      const id = Number(row.account);
      if (row.account && users.has(id)) users.set(id, Math.max(users.get(id) ?? row.at, row.at));
    }
    return { any, users };
  }
}

// The title's collections that protect it: tk.box's own when their kind is on, any other when "other" is. Leaving Soon
// never does. Names compare as the collections engine compares them.
export function protectingCollections(names: string[], library: string, settings: Pick<CleanupSettings, 'collectionKinds' | 'leavingSoon'>, ours: CleanupCollection[]) {
  const kinds = new Map(ours.map(c => [`${c.library.trim().toLowerCase()}:${collectionKey(c.name)}`, c.kind]));
  const leaving = settings.leavingSoon.name.trim().toLowerCase(), lib = library.trim().toLowerCase();
  return [...new Set(names)].filter(name => name && name.trim().toLowerCase() !== leaving && settings.collectionKinds[kinds.get(`${lib}:${collectionKey(name)}`) ?? 'other']).sort();
}

// Group a run's requests by title, keeping the order they came in.
export function groupRequests(requests: CleanupRequest[]) {
  const groups = new Map<string, CleanupRequest[]>();
  for (const r of requests) { const key = `${r.kind}:${r.tmdb}`; (groups.get(key) ?? groups.set(key, []).get(key)!).push(r); }
  return [...groups.values()];
}

// What a run does with each candidate. Errors in one title are that title's (listed as error, the run incomplete).
export function decide(facts: CleanupFacts): CleanupPlan {
  const { now, dryRun, settings } = facts;
  const plan: CleanupPlan = { items: [], complete: true, deletes: [], leaving: [], settled: new Set(), summaries: { delete: {}, leaving: {}, season: {} }, log: [],
    counts: { processed: facts.processed, deleted: 0, planned: 0, failed: 0, skippedMissingAddedAt: 0, notFound: 0, protected: 0, kept: 0 } };
  const log = (level: CleanupLevel, message: string) => plan.log.push({ level, message });
  const watches = new WatchIndex(facts.watches, settings.exemptUserIds);
  const entry = (summary: Record<string, string[]>, library: string, line: string) => (summary[library] ??= []).push(line);
  const status = (item: Omit<CleanupTitle, 'year' | 'rule' | 'reason' | 'deletion_date' | 'held_until'> & { year?: number | null; rule?: Rule; reason?: string; held?: number }) => {
    const { rule, held, reason, year, ...rest } = item;
    plan.items.push({ ...rest, year: rest.kind === 'season' ? null : year ?? null, rule: rule?.name ?? null, reason: rule ? rule.reason : reason ?? '',
      deletion_date: rule ? iso(rule.at) : null, held_until: held === undefined ? null : iso(held), key: rest.key ?? null, rating_key: rest.rating_key ?? null, show_rating_key: rest.show_rating_key ?? null });
    return plan.items.length - 1;
  };
  log('INFO', `Processing ${facts.processed} requests across ${facts.candidates.length} media items`);
  const seen = new Set<string>();
  for (const candidate of facts.candidates) {
    const { kind, tmdb, item } = candidate, first = candidate.requests[0]!, title = first.title || 'Unknown Title', year = first.year;
    const wholeKind = kind === 'movie' ? 'movie' as const : 'show' as const, hold = holdKey(kind, tmdb);
    try {
      const tvdbs = new Set(candidate.requests.flatMap(r => r.tvdb ? [r.tvdb] : []));
      if (tvdbs.size > 1) throw new Error('Requests for the same media contain conflicting TVDB IDs');
      if (!(kind === 'movie' ? settings.movieLibraries : settings.tvLibraries).length) { plan.counts.kept++; continue; }
      if (!item) {
        log('WARNING', `Plex item not found: ${title} TMDB=${tmdb} TVDB=${[...tvdbs][0] ?? 'None'}`);
        plan.counts.notFound++; plan.complete = false;
        status({ title, kind: wholeKind, library: '', status: 'not_found', reason: 'Not found in the chosen Plex libraries', key: hold });
        continue;
      }
      if (seen.has(`${item.section}:${item.ratingKey}`)) throw new Error('Different media IDs resolved to the same Plex item; refusing repeated processing');
      seen.add(`${item.section}:${item.ratingKey}`);
      log('INFO', `Processing '${title}' for request IDs [${candidate.requests.map(r => r.id).join(', ')}]`);
      const base = { title, year, kind: wholeKind, library: item.library, key: hold, rating_key: item.ratingKey };
      // Movies and shows are tk.box's own: kept by its Keep, deleted from Plex only.
      if (candidate.keep) {
        log('INFO', `Keeping '${title}': kept in tk.box`);
        plan.counts.protected++; plan.settled.add(item.ratingKey);
        status({ ...base, status: 'protected', reason: 'Kept in tk.box' });
        continue;
      }
      if (settings.exemptIfInCollection) {
        if (item.collectionsError !== undefined) throw new Error(item.collectionsError);
        const protecting = protectingCollections(item.collections ?? [], item.library, settings, facts.collections);
        if (protecting.length) {
          log('INFO', `Keeping '${title}': protected by collections ${protecting.join(', ')}`);
          plan.counts.protected++; plan.settled.add(item.ratingKey);
          status({ ...base, status: 'protected', reason: `In ${protecting.join(', ')}` });
          continue;
        }
      }
      const requesters = candidate.requests.flatMap(r => r.requester_plex_id === null ? [] : [r.requester_plex_id]);
      if (kind === 'tv' && settings.seasons.enabled && seasons(candidate, item, requesters)) {
        // Season by season, the show itself never belongs in the collection.
        plan.settled.add(item.ratingKey);
        continue;
      }
      // Requests missing their available date use Plex's added date.
      const missing = candidate.requests.filter(r => !r.available_at);
      if (missing.length) {
        if (item.addedAt === undefined) throw new MissingAddedAt('The available date is missing and Plex has no added date: Missing Plex addedAt date');
        log('WARNING', `Using Plex addedAt=${iso(item.addedAt)} for '${title}' (Plex ratingKey=${item.ratingKey}, request IDs [${missing.map(r => r.id).join(', ')}]) because the available date is missing`);
      }
      const asked = candidate.requests.map(r => ({ addedAt: r.available_at ? Date.parse(r.available_at) : item.addedAt!, requester: r.requester_plex_id }));
      const rule = ruleForRequests(asked, watches.status(wholeKind, item.watchKeys, requesters, tmdb), settings);
      const held = heldUntil(rule, facts.holds, hold), due = held ?? rule.at;
      if (held !== undefined) log('INFO', `Keeping '${title}' until at least ${iso(held)}: held by an administrator`);
      if (now >= due) {
        log('WARNING', `DELETE Candidate: '${title}'. ${rule.name}: ${rule.reason}`);
        entry(plan.summaries.delete, item.library, `${title} [${rule.name}]`);
        if (dryRun) { log('WARNING', `DRY RUN: Would delete '${title}' from Plex`); plan.counts.planned++; }
        const at = status({ ...base, status: dryRun ? 'due' : 'deleted', rule });
        if (!dryRun) plan.deletes.push({ item: at, ratingKey: item.ratingKey, label: title, season: false });
      } else {
        plan.counts.kept++;
        const remaining = daysRemaining(due, now), leaving = leavingSoon(due, now, settings.leavingSoon.days);
        if (leaving) { plan.leaving.push({ ratingKey: item.ratingKey, section: item.section }); entry(plan.summaries.leaving, item.library, `${title} in ${remaining} days [${rule.name}]`); }
        else plan.settled.add(item.ratingKey);
        status({ ...base, status: leaving ? 'leaving' : 'kept', rule, ...(held !== undefined ? { held } : {}) });
        log('INFO', dryRun ? `DRY RUN Foresight: '${title}' in ${remaining} days (${rule.name}: ${rule.reason})` : `Keeping '${title}' until ${iso(due)} (${rule.name})`);
      }
    } catch (e) {
      const missing = e instanceof MissingAddedAt;
      if (missing) { log('WARNING', `Skipping ${kind} TMDB=${tmdb} (request IDs [${candidate.requests.map(r => r.id).join(', ')}]): ${(e as Error).message}; retaining media`); plan.counts.skippedMissingAddedAt++; }
      else { log('ERROR', `Skipping ${kind} TMDB=${tmdb} after failed evaluation or deletion: ${(e as Error).message}`); plan.counts.failed++; }
      plan.complete = false;
      status({ title: first.title || `TMDB ${tmdb}`, year, kind: wholeKind, library: item?.library ?? '', status: 'error', reason: missing ? (e as Error).message : `Skipped after an error: ${(e as Error).message}`,
        key: hold, rating_key: item?.ratingKey ?? null });
    }
  }
  return plan;

  // Season by season. False: the show goes as a whole instead (only its
  // first season is left). A season goes from Plex only; tk.box forgets it after the run.
  function seasons(candidate: CleanupCandidate, show: CleanupItem, requesters: number[]) {
    const list = show.seasons ?? [], title = candidate.requests[0]!.title || 'Unknown Title';
    // Failure must never fall back to deleting the show.
    if (!list.length || list.some(s => !Number.isInteger(s.season) || s.season < 0)) throw new Error('Plex returned an empty or invalid season list');
    const normal = list.filter(s => s.season > 0);
    // Earlier seasons may already have been purged. A lone later season keeps its protections instead of falling
    // through to whole-show deletion.
    if (normal.length <= 1 && !normal.some(s => s.season > 1)) return false;
    const latest = Math.max(...normal.map(s => s.season)), eligible: CleanupSeason[] = [];
    const name = (s: CleanupSeason) => `${title} - ${s.season === 0 ? 'Specials' : `Season ${s.season}`}`;
    for (const season of [...list].sort((a, b) => a.season - b.season)) {
      if ((settings.seasons.protectSpecials && season.season === 0) || (settings.seasons.protectLatest && season.season === latest)) {
        plan.counts.protected++;
        log('INFO', `Keeping protected season '${name(season)}'`);
        status({ title: name(season), kind: 'season', library: show.library, status: 'protected', reason: season.season === 0 ? 'Specials' : 'Latest season',
          key: holdKey('tv', candidate.tmdb, season.season), rating_key: season.ratingKey ?? null, show_rating_key: show.ratingKey });
      } else eligible.push(season);
    }
    const asked = candidate.requests.map(r => ({ addedAt: 0, requester: r.requester_plex_id }));
    for (const season of eligible) {
      const label = name(season), hold = holdKey('tv', candidate.tmdb, season.season);
      const base = { title: label, kind: 'season' as const, library: show.library, key: hold, rating_key: season.ratingKey ?? null, show_rating_key: show.ratingKey };
      try {
        // Missing dates must not let a recently added episode go unprotected.
        if (season.addedAt === undefined) throw new Error('Season has no episodes to derive an addedAt date');
        const rule = ruleForRequests(asked, watches.status('season', season.watchKeys, requesters), settings, season.addedAt);
        const held = heldUntil(rule, facts.holds, hold), due = held ?? rule.at;
        if (now >= due) {
          log('WARNING', `DELETE Candidate: '${label}'. ${rule.name}: ${rule.reason}`);
          entry(plan.summaries.delete, show.library, `${label} [${rule.name}]`);
          if (dryRun) { log('WARNING', `DRY RUN: Would delete season '${label}' from Plex`); plan.counts.planned++; }
          if (!dryRun && !season.ratingKey) throw new Error('Plex gave this season no rating key');
          const at = status({ ...base, status: dryRun ? 'due' : 'deleted', rule });
          if (!dryRun) plan.deletes.push({ item: at, ratingKey: season.ratingKey!, label, season: true });
        } else {
          const remaining = daysRemaining(due, now), leaving = leavingSoon(due, now, settings.leavingSoon.days);
          if (leaving) entry(plan.summaries.season, show.library, `${label} in ${remaining} days [${rule.name}]`);
          status({ ...base, status: leaving ? 'leaving' : 'kept', rule, ...(held !== undefined ? { held } : {}) });
          log('INFO', dryRun ? `DRY RUN Foresight: '${label}' in ${remaining} days (${rule.name}: ${rule.reason})` : `Keeping season '${label}' until ${iso(due)} (${rule.name})`);
          plan.counts.kept++;
        }
      } catch (e) {
        log('ERROR', `Skipping season '${label}' after failed evaluation or deletion: ${(e as Error).message}`);
        status({ ...base, status: 'error', reason: `Skipped after an error: ${(e as Error).message}` });
        plan.counts.failed++; plan.complete = false;
      }
    }
    return true;
  }
}

// The run's summary, as the script logged it.
export function summaryLines(plan: Pick<CleanupPlan, 'counts' | 'summaries'>, dryRun: boolean) {
  const c = plan.counts, lines = [`Summary: Processed=${c.processed}, Deleted=${c.deleted}, DryRun=${c.planned}, Failed=${c.failed}, Skipped(Missing AddedAt)=${c.skippedMissingAddedAt}, NotFound=${c.notFound}, Protected=${c.protected}, Kept=${c.kept}`];
  const section = (title: string, summary: Record<string, string[]>) => {
    const names = Object.keys(summary).sort();
    lines.push(`${title}:${names.length ? '' : ' none'}`);
    for (const name of names) { lines.push(`  ${name} (${summary[name]!.length}):`); for (const e of summary[name]!) lines.push(`    - ${e}`); }
  };
  section(`Delete Candidates By Library${dryRun ? ' (DRY RUN)' : ''}`, plan.summaries.delete);
  section('Leaving Soon Candidates By Library', plan.summaries.leaving);
  section('Season-Level Upcoming Deletions By Library (not added to collection)', plan.summaries.season);
  return lines;
}
