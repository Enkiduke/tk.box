import { readFile } from 'node:fs/promises';
import type { CleanupSettings } from '../persistence/cleanup-store.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import type { PlexIndex } from './plex-index.js';
import type { CleanupRequest } from './requests.js';
import { LEAVING_SOON_SORT_TITLE, decide, groupRequests, summaryLines, type CleanupCandidate, type CleanupCollection, type CleanupFacts, type CleanupItem,
  type CleanupLevel, type CleanupPlan, type CleanupWatch } from './cleanup-rules.js';

// A TypeScript Clean Up run (docs/ARCHITECTURE-AUDIT.md, Phase M): gather the facts from their owners, decide
// (services/cleanup-rules.ts), then carry it out. No title or guid search: each request's title is found with the
// Plex index's `resolve`, and every Plex call names a rating key. Plex is written with the owner's grant.
export type CleanupPlex = Pick<PlexAdapter, 'serverIdentity' | 'itemCollections' | 'deleteMetadata' | 'sectionCollectionList' | 'collectionChildren' | 'createCollection'
  | 'addCollectionItems' | 'removeCollectionItem' | 'editSortTitle' | 'uploadPoster'>;
export type CleanupSources = {
  // tk.box's requests on the server (requests' `forCleanup`).
  requests(): Promise<CleanupRequest[]>;
  index: Pick<PlexIndex, 'resolve' | 'copy'>;
  // Watch history's `watches`, for this server.
  watches(serverId: string): CleanupWatch[];
  // The library's Keep, by TMDB id.
  kept(kind: 'movie' | 'show'): Set<number>;
  // Artwork's collections, by kind.
  collections(): CleanupCollection[];
  holds: Record<string, number>;
};
export type CleanupRunOptions = { settings: CleanupSettings; dryRun: boolean; serverId: string; grant: PlexGrant; plex: CleanupPlex; poster?: string;
  now?: number; say(level: CleanupLevel, message: string): void; canceled?(): boolean };
export type CleanupRunResult = { plan: CleanupPlan; code: number; items: CleanupPlan['items'] };
const READS = 4;

// The run's facts. Fails as a whole (nothing decided) when the libraries or the Plex server aren't the ones set.
export async function gatherFacts(sources: CleanupSources, options: Pick<CleanupRunOptions, 'settings' | 'dryRun' | 'serverId' | 'grant' | 'plex' | 'now'>): Promise<CleanupFacts> {
  const { settings, grant, plex } = options;
  // Watch history is kept per Plex server: this has to be that server.
  const machine = await plex.serverIdentity(grant.serverToken);
  if (machine !== options.serverId) throw new Error(`The watch history is for Plex server ${options.serverId}, not this one (${machine || 'unknown'})`);
  const sections = new Map(grant.libraries.map(l => [l.key, l]));
  for (const [keys, type] of [[settings.movieLibraries, 'movie'], [settings.tvLibraries, 'show']] as const) for (const key of keys) {
    const library = sections.get(key);
    if (!library) throw new Error(`Plex library ${key} is not on this server`);
    if (library.type !== type) throw new Error(`Plex library '${library.title}' must have type '${type}'`);
  }
  const requests = await sources.requests(), kept = { movie: sources.kept('movie'), show: sources.kept('show') };
  const candidates: CleanupCandidate[] = groupRequests(requests).map(group => {
    const first = group[0]!, kind = first.kind, show = kind === 'tv', tvdb = group.find(r => r.tvdb)?.tvdb ?? undefined;
    const candidate: CleanupCandidate = { kind, tmdb: first.tmdb, requests: group, keep: (show ? kept.show : kept.movie).has(first.tmdb) };
    const ids = sources.index.resolve({ kind: show ? 'show' : 'movie', tmdb: first.tmdb, ...(tvdb ? { tvdb } : {}) });
    const copies = (ids?.copies ?? []).map(c => ({ ...c, held: sources.index.copy(c.ratingKey) }));
    // The first copy in the chosen libraries, in their order, whose ids don't contradict the request's.
    const fits = (held: (typeof copies)[number]['held']) => !!held && (!held.tmdbId || held.tmdbId === first.tmdb) && (!tvdb || !held.tvdbId || held.tvdbId === tvdb);
    const chosen = (show ? settings.tvLibraries : settings.movieLibraries).flatMap(section => copies.filter(c => c.section === section && fits(c.held)))[0];
    if (!chosen?.held) return candidate;
    const held = chosen.held, item: CleanupItem = { ratingKey: chosen.ratingKey, section: chosen.section!, library: sections.get(chosen.section!)?.title ?? 'Unknown Library',
      ...(held.addedAt ? { addedAt: held.addedAt } : {}), watchKeys: copies.map(c => c.ratingKey) };
    if (show) item.seasons = [...(held.seasonItems ?? new Map<number, { ratingKey?: string; addedAt?: number }>())].map(([season, s]) => {
      // A season's date is its newest episode's (read for the shows the library follows), else Plex's date for the season.
      const latest = held.seasonLatest?.get(season) ?? s.addedAt;
      return { season, ...(s.ratingKey ? { ratingKey: s.ratingKey } : {}), ...(latest ? { addedAt: latest } : {}),
        watchKeys: copies.flatMap(c => { const key = c.held?.seasonItems?.get(season)?.ratingKey; return key ? [key] : []; }) };
    });
    candidate.item = item;
    return candidate;
  });
  // A title's collections are read only when they can protect it, by rating key, a few at a time.
  if (settings.exemptIfInCollection) {
    const pending = candidates.filter(c => c.item && !c.keep && (c.kind === 'movie' ? settings.movieLibraries : settings.tvLibraries).length).values();
    await Promise.all(Array.from({ length: READS }, async () => {
      for (const c of pending) await plex.itemCollections(grant.serverToken, c.item!.ratingKey).then(names => { c.item!.collections = names; },
        e => { c.item!.collectionsError = (e as Error).message; });
    }));
  }
  const { schedule: _, dryRun: __, ...rules } = settings;
  return { now: options.now ?? Date.now(), dryRun: options.dryRun, settings: rules, holds: sources.holds, collections: sources.collections(), candidates,
    processed: requests.length, watches: sources.watches(options.serverId) };
}

// A whole run: decide, delete what is due (a real run), update Leaving Soon, log the summary. Exit code 1 when a title
// failed or had no date, as the script's.
export async function runCleanup(sources: CleanupSources, options: CleanupRunOptions): Promise<CleanupRunResult> {
  const { settings, dryRun, say, grant, plex } = options;
  say('INFO', `Starting purge (${dryRun ? 'DRY RUN: nothing is deleted' : 'deleting for real'})`);
  const plan = decide(await gatherFacts(sources, options));
  for (const line of plan.log) say(line.level, line.message);
  for (const d of plan.deletes) {
    if (options.canceled?.()) { plan.items[d.item] = { ...plan.items[d.item]!, status: 'due' }; plan.complete = false; continue; }
    try {
      await plex.deleteMetadata(grant.serverToken, d.ratingKey);
      plan.counts.deleted++;
      say('WARNING', `Deleted ${d.season ? 'season ' : ''}'${d.label}' from Plex`);
    } catch (e) {
      say('ERROR', `Skipping '${d.label}' after failed deletion: ${(e as Error).message}`);
      plan.items[d.item] = { ...plan.items[d.item]!, status: 'error', rule: null, reason: `Skipped after an error: ${(e as Error).message}`, deletion_date: null };
      plan.counts.failed++; plan.complete = false;
    }
  }
  if (settings.leavingSoon.enabled && !dryRun && !options.canceled?.()) {
    if (!plan.complete) say('WARNING', 'Leaving Soon evaluation was incomplete: adding confirmed candidates and removing members confirmed as not leaving; members that couldn\'t be checked stay until a complete run');
    if (!await leavingSoonCollection(plex, grant, settings, plan, options.poster, say)) plan.counts.failed++;
  } else if (settings.leavingSoon.enabled) say('INFO', `DRY RUN: Leaving Soon collection was not modified (${plan.leaving.length} candidates)`);
  for (const line of summaryLines(plan, dryRun)) say('INFO', line);
  return { plan, items: plan.items, code: plan.counts.failed || plan.counts.skippedMissingAddedAt ? 1 : 0 };
}

// Leaving Soon in each chosen library: add the titles leaving soon.
// After a complete run every other member goes; after an incomplete one only members the run found not leaving.
// False when a library's collection couldn't be updated.
async function leavingSoonCollection(plex: CleanupPlex, grant: PlexGrant, settings: CleanupSettings, plan: CleanupPlan, posterPath: string | undefined,
  say: CleanupRunOptions['say']) {
  const token = grant.serverToken, name = settings.leavingSoon.name, complete = plan.complete;
  const removable = (key: string) => complete || plan.settled.has(key);
  let poster: Buffer | undefined;
  if (settings.leavingSoon.poster && posterPath) poster = await readFile(posterPath).catch(() => { say('WARNING', `Collection poster does not exist: ${posterPath}`); return undefined; });
  let ok = true;
  for (const section of [...new Set([...settings.movieLibraries, ...settings.tvLibraries])]) {
    try {
      const wanted = [...new Set(plan.leaving.filter(l => l.section === section).map(l => l.ratingKey))];
      const found = (await plex.sectionCollectionList(token, section)).filter(c => c.title.trim().toLowerCase() === name.trim().toLowerCase());
      if (found.some(c => c.smart)) throw new Error(`Collection '${name}' is smart and cannot be managed as a manual collection`);
      found.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.ratingKey.localeCompare(b.ratingKey));
      let collection = found[0]?.ratingKey;
      if (!wanted.length) {
        if (complete) for (const c of found) await plex.deleteMetadata(token, c.ratingKey);
        else if (collection) for (const key of (await plex.collectionChildren(token, collection)).filter(removable)) await plex.removeCollectionItem(token, collection, key);
        continue;
      }
      const kind = settings.movieLibraries.includes(section) ? 'movie' : 'show';
      if (!collection) collection = await plex.createCollection(token, section, name, kind, wanted);
      else {
        const current = new Set(await plex.collectionChildren(token, collection)), missing = wanted.filter(k => !current.has(k));
        if (missing.length) await plex.addCollectionItems(token, collection, missing);
        for (const key of current) if (!wanted.includes(key) && removable(key)) await plex.removeCollectionItem(token, collection, key);
      }
      if (complete) for (const duplicate of found.slice(1)) await plex.deleteMetadata(token, duplicate.ratingKey);
      await plex.editSortTitle(token, section, collection, LEAVING_SOON_SORT_TITLE);
      if (poster) await plex.uploadPoster(token, collection, poster);
    } catch (e) {
      say('ERROR', `Failed to update collection '${name}' in library ${section}: ${(e as Error).message}`);
      ok = false;
    }
  }
  return ok;
}
