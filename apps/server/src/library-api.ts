import { createHash } from 'node:crypto';
import { RECHECK } from './services/download-health.js';
import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClientState, DownloadItem, DownloadsActivity, DownloadsGrab, DownloadsHistory, DownloadStats, DownloadsLive, DownloadsSeeding, InteractiveSearch, LibraryFileView, LibraryTitleView, LibrarySettingsView, MovieList, MovieSource, NamingPreview, PlexKey,
  LibraryBulkResult, PickProfile, PickRules, ShowList, ShowTitleView, TitleRequest, TitleView, TryRelease, WantedList } from '../../../packages/contracts/src/downloads.js';
import { viewer } from './modules/access.js';
import { AppError, requireThat } from './errors.js';
import { EARLY_COPIES, LADDER, isQuality, qualityOf, type Quality } from './lib/quality.js';
import { BOOLEAN_FIELDS, FLAGS, FORMAT_CATEGORIES, FORMAT_FIELDS, formatMatches, scoreFormats, type Format } from './lib/formats.js';
import type { QualityProfile } from './lib/profiles.js';
import { builtInProfile } from './lib/builtin-profiles.js';
import { decide } from './lib/pick-rules.js';
import { parsedFacts, showCounts } from './services/library.js';
import { parseRelease } from './lib/release-name.js';
import { movieFileName, movieFolder, videoCodecName } from './lib/naming.js';
import { IPT_FLOOR, seedingDecision } from './lib/seeding.js';
import { grabHistoryFacts } from './lib/grab-history.js';
import { downloadStats } from './lib/download-stats.js';
import { tmdbImage } from './providers/explore-images.js';
import type { TmdbTitles } from './providers/tmdb-titles.js';
import type { Grab, LibraryStore, LibraryTitle } from './persistence/library-store.js';
import { episodesLabel } from './services/wanted.js';
import type { DownloadersApi, Library } from './services/library.js';
import type { QueueApi } from './services/queue.js';
import type { PlexIndex } from './services/plex-index.js';

// Admin › Manage for movies (docs/ARR-REPLACEMENT.md, "Admin UI"; docs/PHASE-3.5.md): downloads, wanted, every movie,
// a title with its interactive search, pick rules (profiles and score rules) and the library settings with a naming
// preview. All admin.

// Sizes are MB a minute of runtime: 1000 is about 107 GB for a two-hour movie.
const MB_MIN_MAX = 1000, SCORE_MAX = 1000;
const version = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const id = z.object({ id: z.coerce.number().int().positive() }).strict();
const size = (max: number) => z.tuple([z.number().min(0).max(max), z.number().min(0).max(max)]).refine(([min, most]) => min < most, 'The smallest size must be under the largest.');
const score = z.number().int().min(-10 * SCORE_MAX).max(10 * SCORE_MAX);

// A profile as Admin sends it (docs/PROFILES.md, "The model"). Checked again against the ladder and the formats.
export const profileInput = z.object({
  name: z.string().trim().min(1).max(40),
  value: z.object({
    tiers: z.array(z.object({ qualities: z.array(z.string()).min(1).max(LADDER.length), size: size(MB_MIN_MAX).optional() }).strict()).min(1).max(20),
    preferred: z.number().int().min(1).max(20),
    scores: z.record(z.string().max(60), z.union([z.number().int().min(-SCORE_MAX).max(SCORE_MAX), z.literal('ban')])),
    minScore: score.optional(), upgradeUntil: score.optional(), upgradeStep: z.number().int().min(1).max(SCORE_MAX),
  }).strict(),
}).strict();
export function profileValue(input: z.infer<typeof profileInput>['value'], formats: readonly Format[]): QualityProfile {
  const seen = new Set<string>();
  for (const tier of input.tiers) for (const q of tier.qualities) {
    requireThat(isQuality(q), 'PROFILE_INVALID', `${q} isn’t a quality.`);
    requireThat(!seen.has(q), 'PROFILE_INVALID', `${q} is in two tiers.`);
    seen.add(q);
  }
  requireThat(input.preferred <= input.tiers.length, 'PROFILE_INVALID', 'More preferred tiers than tiers.');
  // Early copies are their own section (Admin › Quality's Early release): tiers of nothing else, after every other tier.
  const early = input.tiers.map(t => t.qualities.some(q => EARLY_COPIES.has(q as Quality)));
  requireThat(input.tiers.every((t, i) => !early[i] || t.qualities.every(q => EARLY_COPIES.has(q as Quality))), 'PROFILE_INVALID',
    'Early copies go in a tier of their own.');
  requireThat(early.every((e, i) => !e || early.slice(i).every(Boolean)) && early.slice(0, input.preferred).every(e => !e), 'PROFILE_INVALID',
    'Early copies go after the other tiers, and aren’t preferred.');
  requireThat(input.preferred >= 1, 'PROFILE_INVALID', 'Preferred needs a tier.');
  const names = new Set(formats.map(f => f.name));
  const unknown = Object.keys(input.scores).find(name => !names.has(name));
  requireThat(!unknown, 'PROFILE_INVALID', `No format is named ${unknown}.`);
  requireThat(input.minScore === undefined || input.upgradeUntil === undefined || input.minScore <= input.upgradeUntil, 'PROFILE_INVALID',
    'The minimum score must not be over the upgrade-until.');
  const scores = Object.fromEntries(formats.flatMap(f => input.scores[f.name] !== undefined && input.scores[f.name] !== 0 ? [[f.name, input.scores[f.name]!]] : []));
  return { tiers: input.tiers.map(t => ({ qualities: t.qualities as Quality[], ...(t.size ? { size: t.size } : {}) })), preferred: input.preferred, scores,
    ...(input.minScore !== undefined ? { minScore: input.minScore } : {}), ...(input.upgradeUntil !== undefined ? { upgradeUntil: input.upgradeUntil } : {}),
    upgradeStep: input.upgradeStep };
}

// Formats as Admin sends them: the whole ordered list. Labels go into file names ({[Custom Formats]}), so only letters,
// digits, spaces and + . -.
const conditionInput = z.object({
  field: z.enum(FORMAT_FIELDS), values: z.array(z.string().trim().min(1).max(200)).max(500),
  required: z.boolean().optional(), negate: z.boolean().optional(),
}).strict().superRefine((c, ctx) => {
  if (BOOLEAN_FIELDS.has(c.field)) return;
  if (!c.values.length) ctx.addIssue({ code: 'custom', message: `A ${c.field} condition needs a value.` });
  if (c.field === 'flag') for (const v of c.values) if (!(FLAGS as readonly string[]).includes(v.toLowerCase())) ctx.addIssue({ code: 'custom', message: `${v} isn’t a flag.` });
  if (c.field === 'title') for (const v of c.values) { try { new RegExp(v, 'i'); } catch { ctx.addIssue({ code: 'custom', message: `“${v}” isn’t a valid pattern` }); } }
});
export const formatInput = z.object({
  name: z.string().trim().min(1).max(60),
  label: z.string().trim().max(20).regex(/^[A-Za-z0-9 +.-]*$/, 'Labels take letters, digits, spaces and + . - only').optional(),
  category: z.enum(FORMAT_CATEGORIES), conditions: z.array(conditionInput).min(1).max(20),
  from: z.string().max(60).optional(),
}).strict();
const formatsInput = z.object({ expectedVersion: z.string().max(40), formats: z.array(formatInput).max(300) }).strict();
const tryInput = z.object({ release: z.string().trim().min(1).max(300), runtime: z.number().int().min(1).max(1000).optional(), size: z.number().int().min(0).max(1e13).optional() }).strict();

const root = z.string().trim().min(1).max(300).refine(p => isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'Use a full path');
export const settingsInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  roots: z.object({ movie: root.optional(), show: root.optional() }).strict().optional(),
  protocol: z.enum(['usenet-first', 'torrent-first']).optional(),
  rssMinutes: z.number().int().min(5).max(1440).optional(),
  defaultProfile: z.number().int().positive().optional(),
  // Validated again by librarySettings, which holds the IPTorrents floor (ratio 1, 14 days).
  seeding: z.object({ ratio: z.number().max(100), minDays: z.number().max(3650), maxDays: z.number().max(3650) }).strict()
    .refine(s => s.minDays <= s.maxDays, 'The minimum days must not be over the maximum.').optional(),
  budget: z.object({ movie: z.number().int().min(5).max(240), episode: z.number().int().min(5).max(240) }).strict().optional(),
}).strict();

// How long Queue says a download was swapped in for a slow one.
const SWAPPED_SHOWN = 10 * 60000;
// How many grabs Downloads › History lists.
const HISTORY_GRABS = 500;
// Downloads › History › Stats' period, as Activity's.
const statsPeriod = z.object({ days: z.enum(['7', '30', '90', '365', 'all']).default('30') }).strict();
const previewInput = z.object({ release: z.string().trim().min(1).max(300), tmdbId: z.number().int().positive().max(99999999).optional() }).strict();
// The name a release would get, from what its name says (an import reads the audio, HDR and codec from ffprobe instead).
export function namingPreview(store: Pick<LibraryStore, 'formats' | 'settings'>, input: z.infer<typeof previewInput>): NamingPreview {
  const parsed = parseRelease(input.release), quality = qualityOf(parsed);
  requireThat(quality, 'QUALITY_UNKNOWN', 'Its quality can’t be read from the name.');
  const movie = { title: parsed.title || 'Untitled', ...(parsed.year ? { year: parsed.year } : {}), tmdbId: input.tmdbId ?? 44115 };
  const { labels } = scoreFormats({ parsed, quality }, store.formats(), {});
  const hdr = parsed.hdr.map(h => h === 'HDR' ? 'HDR10' : h);
  const dynamicRange = [hdr.includes('DV') ? 'DV' : '', hdr.find(h => h !== 'DV') ?? ''].filter(Boolean).join(' ') || undefined;
  const audioCodec = parsed.audio.codec ? `${parsed.audio.codec}${parsed.audio.atmos ? ' Atmos' : ''}` : undefined;
  const videoCodec = videoCodecName(parsed, parsed.codec);
  const channels = parsed.audio.channels;
  const folder = movieFolder(movie);
  const file = `${movieFileName(movie, { quality, proper: parsed.proper, repack: parsed.repack, editions: parsed.editions, customFormats: labels,
    ...(dynamicRange ? { dynamicRange } : {}), ...(audioCodec ? { audioCodec } : {}), ...(channels ? { audioChannels: channels } : {}),
    ...(videoCodec ? { videoCodec } : {}), ...(parsed.group ? { group: parsed.group } : {}) })}.mkv`;
  return { quality, folder, file, path: `${store.settings().roots.movie.replace(/[\\/]+$/, '')}/${folder}/${file}` };
}

// `titles`: TMDB details, cached (the library and the calendar read the same ones), for posters.
// Who asked for each title, and one title's requests newest first (its dialog's Requests tab): the requests module's
// reads, which it hands the library as it mounts (`readRequests`).
export type RequestReads = {
  requesters(kind: 'movie' | 'show'): Map<number, { name: string; at: number; status: string }[]>;
  titleHistory(kind: 'movie' | 'show', tmdbId: number): TitleRequest[];
};
// Where Admin › Manage learns why each title is there: who requested it (the requests module) and which collections
// downloaded a movie (the artwork engine's journals).
export type LibrarySources = {
  requests?: () => RequestReads | undefined;
  collections?: () => Map<number, string[]>;
};
type Deps = { store: LibraryStore; library: Library; queue: QueueApi; titles?: Pick<TmdbTitles, 'get'>; sources?: LibrarySources; downloaders?: Pick<DownloadersApi, 'live'>;
  // Where a title is on Plex (the title identity), for its dialog's History tab; none until Plex has been read.
  plexTitles?: Pick<PlexIndex, 'resolve'>; plexServer?: () => string | undefined };
// A movie's source: a request first, then collections, then the one-time import. A show's: a request, else the
// one-time import.
export function movieSource(title: { tmdbId: number; addedBy: string; kind?: 'movie' | 'show' }, requests: Map<number, { name: string; at: number; status: string }[]>,
  collections: Map<number, string[]>): MovieSource {
  const asked = requests.get(title.tmdbId);
  if (asked?.length) return { kind: 'request', requests: asked };
  if (title.kind === 'show') return title.addedBy === 'cutover' ? { kind: 'imported' } : { kind: 'other', by: title.addedBy };
  const owners = collections.get(title.tmdbId);
  if (owners?.length || title.addedBy === 'collections') return { kind: 'collection', collections: owners ?? [] };
  if (title.addedBy === 'cutover') return { kind: 'imported' };
  return { kind: 'other', by: title.addedBy };
}

export function registerLibraryAdmin(app: FastifyInstance, { store, library, queue, titles, sources = {}, downloaders, plexTitles, plexServer }: Deps) {
  const plexOf = (kind: 'movie' | 'show', tmdbId: number, tvdbId?: number): { plex?: PlexKey } => {
    const key = plexTitles?.resolve({ kind, tmdb: tmdbId, tvdb: tvdbId })?.ratingKey, server = plexServer?.();
    return key && server ? { plex: { server, key } } : {};
  };
  const requesters = (kind: 'movie' | 'show') => sources.requests?.()?.requesters(kind) ?? new Map<number, { name: string; at: number; status: string }[]>();
  const requestHistory = (kind: 'movie' | 'show', tmdbId: number) => sources.requests?.()?.titleHistory(kind, tmdbId) ?? [];
  const sourcesNow = () => { const requests = requesters('movie'), collections = sources.collections?.() ?? new Map();
    return (t: { tmdbId: number; addedBy: string }) => movieSource(t, requests, collections); };
  const showSourcesNow = () => { const requests = requesters('show');
    return (t: { tmdbId: number; addedBy: string }) => movieSource({ ...t, kind: 'show' }, requests, new Map()); };
  const admin = { config: { access: 'admin' as const } };
  const actor = (request: Parameters<typeof viewer>[0]) => viewer(request).grant.accountId;
  const titleName = new Map<number, { title: string; year?: number }>();
  const nameOf = (titleId: number) => {
    let name = titleName.get(titleId);
    if (!name) { const t = store.title(titleId); name = t ? { title: t.title, ...(t.year ? { year: t.year } : {}) } : { title: `Title ${titleId}` }; titleName.set(titleId, name); }
    return name;
  };
  // A show's episodes in a word (S02, S02E05), knowing each season's size; cached with the names.
  const seasonSizes = new Map<number, Map<number, number>>();
  const episodesOf = (titleId: number, refs: readonly (readonly [number, number])[]) => {
    if (!refs.length) return {};
    let sizes = seasonSizes.get(titleId);
    if (!sizes) { sizes = new Map(); for (const e of store.episodes(titleId)) sizes.set(e.season, (sizes.get(e.season) ?? 0) + 1); seasonSizes.set(titleId, sizes); }
    const known = sizes;
    return { episodes: episodesLabel(refs, s => known.get(s) ?? 0) };
  };
  const clearNames = () => { titleName.clear(); seasonSizes.clear(); };
  const grabView = (g: Grab): DownloadsGrab => ({ id: g.id, titleId: g.titleId, ...nameOf(g.titleId), ...episodesOf(g.titleId, g.episodes), releaseName: g.releaseName, indexer: g.indexer, protocol: g.protocol,
    ...(g.size !== undefined ? { size: g.size } : {}), quality: g.quality, score: g.score, upgrade: g.upgrade, state: g.state,
    ...(g.progress !== undefined ? { progress: g.progress } : {}), ...(g.error ? { error: g.error } : {}), ...(g.sentAt ? { sentAt: g.sentAt } : {}),
    ...(g.finishedAt ? { finishedAt: g.finishedAt } : {}), ...(g.importedAt ? { importedAt: g.importedAt } : {}) });
  // The title a queue item is for, from its key (movie:12, grab:88, file:5).
  const subjectOf = (key: string): number | undefined => {
    const [kind, raw] = key.split(':'), n = Number(raw);
    if (!Number.isInteger(n)) return undefined;
    return kind === 'movie' || kind === 'show' ? n : kind === 'grab' || kind === 'swap' ? store.grab(n)?.titleId : kind === 'file' ? store.file(n)?.titleId : undefined;
  };
  const pickRules = (): PickRules => {
    const formats = store.formats();
    return { profiles: store.profileRows().map(p => ({ ...p, value: p.value as PickProfile, version: version([p.name, p.value]) })), formats, formatsVersion: version(formats),
      ladder: [...LADDER], earlyCopies: LADDER.filter(q => EARLY_COPIES.has(q)), fields: [...FORMAT_FIELDS], flags: [...FLAGS], categories: [...FORMAT_CATEGORIES] };
  };
  const settingsView = (): LibrarySettingsView => ({ ...store.settings(), seedingFloor: { ...IPT_FLOOR } });
  const showView = (title: LibraryTitle): ShowTitleView => {
    const seasons = library.showDetail(title), byFile = store.fileEpisodes(title.id), { missing, cutoff, have, total, size, nextAir } = showCounts(seasons, Date.now());
    const files: LibraryFileView[] = store.files(title.id).map(f => ({ ...f, ...episodesOf(title.id, byFile.get(f.id) ?? []) }));
    return { kind: 'show', id: title.id, tmdbId: title.tmdbId, ...(title.tvdbId ? { tvdbId: title.tvdbId } : {}), title: title.title, ...(title.year ? { year: title.year } : {}),
      ...(title.released.status ? { status: title.released.status } : {}), profileId: title.profileId, keep: title.keep, monitor: title.monitor, monitored: title.monitor !== 'none',
      paused: title.paused, ...(title.pausedReason ? { pausedReason: title.pausedReason } : {}), wanted: { missing, cutoff }, have, total, size, ...(nextAir ? { nextAir } : {}), seasons, files,
      grabs: store.grabsFor(title.id, 50).map(grabView), profiles: store.profiles(), source: showSourcesNow()(title), addedAt: title.addedAt,
      requests: requestHistory('show', title.tmdbId), ...plexOf('show', title.tmdbId, title.tvdbId) };
  };
  const titleView = async (titleId: number): Promise<TitleView> => {
    const title = store.title(titleId);
    requireThat(title, 'NOT_FOUND', 'No such title in the library.', 404);
    titleName.delete(titleId); seasonSizes.delete(titleId);
    if (title.kind === 'show') return showView(title);
    const search = store.search(title.id, 'movie'), wanted = await library.titleWanted(title);
    return { kind: 'movie', id: title.id, tmdbId: title.tmdbId, ...(title.imdbId ? { imdbId: title.imdbId } : {}), title: title.title, ...(title.year ? { year: title.year } : {}),
      profileId: title.profileId, keep: title.keep, earlyCopies: title.earlyCopies, monitored: title.monitor !== 'none', paused: title.paused, ...(title.pausedReason ? { pausedReason: title.pausedReason } : {}),
      wanted, released: title.released, ...(search ? { nextAt: search.nextAt, ...(search.lastAt ? { lastAt: search.lastAt } : {}) } : {}), misses: search?.misses ?? 0,
      files: store.files(title.id), grabs: store.grabsFor(title.id, 20).map(grabView), profiles: store.profiles(), source: sourcesNow()(title), addedAt: title.addedAt,
      requests: requestHistory('movie', title.tmdbId), ...plexOf('movie', title.tmdbId) } satisfies LibraryTitleView;
  };

  const seedingView = (g: Grab): DownloadsSeeding => {
    const seen = g.seedingCheckedAt !== undefined && g.seedingSeconds !== undefined;
    const removeAt = seen ? seedingDecision({ ratio: g.ratio ?? 0, seedingSeconds: g.seedingSeconds! }, store.settings().seeding, g.seedingCheckedAt!).removeAt : undefined;
    return { ...grabView(g), ...(g.ratio !== undefined ? { ratio: g.ratio } : {}), ...(g.seedingSeconds !== undefined ? { seedingDays: g.seedingSeconds / 86400 } : {}),
      ...(g.seedingCheckedAt !== undefined ? { checkedAt: g.seedingCheckedAt } : {}), ...(removeAt !== undefined ? { removeAt } : {}) };
  };

  app.get('/api/v1/admin/library/activity', admin, async () => {
    clearNames();
    const view = queue.view(), labels = new Map(view.kinds.map(k => [k.kind, k.label]));
    return {
      open: store.activeGrabs().map(grabView), seeding: store.seedingGrabs().map(seedingView), failed: store.finishedGrabs(true, 30).map(grabView), history: store.finishedGrabs(false, 30).map(grabView),
      jobs: view.items.filter(i => i.state !== 'cancelled' && i.state !== 'done').map(i => {
        const titleId = subjectOf(i.key);
        return { id: i.id, kind: i.kind, label: labels.get(i.kind) ?? i.kind, ...(titleId ? { titleId, subject: nameOf(titleId).title } : {}),
          state: i.state as 'queued' | 'running' | 'failed', runAt: i.runAt, attempts: i.attempts, maxAttempts: i.maxAttempts,
          ...(i.lastError ? { lastError: i.lastError } : {}), updatedAt: i.updatedAt };
      }),
    } satisfies DownloadsActivity;
  });
  // Downloads › History: the grabs with the newest steps, each with all its steps (the page filters and pages them).
  app.get('/api/v1/admin/library/history', admin, async () => {
    clearNames();
    const rows = store.grabHistory(HISTORY_GRABS), facts = grabHistoryFacts(rows), byId = new Map(rows.map(r => [r.grab.id, r.grab]));
    const link = (id?: number) => { const g = id === undefined ? undefined : byId.get(id) ?? store.grab(id); return g ? { id: g.id, releaseName: g.releaseName } : undefined; };
    return { grabs: rows.map(({ grab, steps }) => {
      const f = facts.get(grab.id)!, from = link(grab.swappedFrom), by = link(f.replacedBy);
      return { ...grabView(grab), outcome: f.outcome, startedAt: f.startedAt, lastAt: f.lastAt, ...(f.endedAt !== undefined ? { endedAt: f.endedAt } : {}),
        ...(from ? { swappedFrom: from } : {}), ...(by ? { replacedBy: by } : {}), steps };
    }) } satisfies DownloadsHistory;
  });
  // Downloads › History › Stats: the grabs started in the last `days` days (or all of them).
  app.get('/api/v1/admin/library/stats', admin, async request => {
    const { days } = statsPeriod.parse(request.query);
    return downloadStats(store.grabsStartedSince(days === 'all' ? 0 : Date.now() - Number(days) * 86400000)) satisfies DownloadStats;
  });
  // Everything the downloaders hold, live, each matched to its tk.box grab and who asked for it; then the grabs under
  // way that no downloader lists (sending, or importing after SABnzbd let go).
  const sourceWord = (s: MovieSource): string | undefined => s.kind === 'request' ? `${s.requests[0]!.name}${s.requests.length > 1 ? ` +${s.requests.length - 1}` : ''}`
    : s.kind === 'collection' ? 'Collections' : s.kind === 'imported' ? 'Imported' : s.by || undefined;
  const grabStates: Partial<Record<DownloadsGrab['state'], [ClientState, string?]>> = { sending: ['queued', 'Sending'], downloading: ['downloading'], unpacking: ['unpacking'], importing: ['importing'] };
  app.get('/api/v1/admin/library/downloads', admin, async () => {
    clearNames();
    const live = downloaders?.live ? await downloaders.live() : { clients: [], items: [] };
    const grabs = store.grabsByDownload(live.items.map(i => i.id)), movies = sourcesNow(), shows = showSourcesNow();
    const about = (g: Grab) => {
      const t = store.title(g.titleId), seeding = g.state === 'seeding' ? seedingView(g).removeAt : undefined;
      const health = g.state !== 'downloading' ? {} : { ...(g.strikes && !g.onlySource ? { strikes: g.strikes } : {}),
        ...(g.onlySource ? { onlySource: true, nextCheckAt: (g.swapCheckedAt ?? g.onlySourceAt ?? Date.now()) + RECHECK } : {}),
        ...(g.swappedFrom !== undefined && g.sentAt !== undefined && Date.now() - g.sentAt < SWAPPED_SHOWN ? { swapped: true } : {}) };
      return { grab: { id: g.id, titleId: g.titleId, ...nameOf(g.titleId), ...episodesOf(g.titleId, g.episodes), quality: g.quality, state: g.state, upgrade: g.upgrade, indexer: g.indexer,
        ...(seeding !== undefined ? { removeAt: seeding } : {}), ...health }, ...(t && sourceWord((t.kind === 'show' ? shows : movies)(t)) ? { requestedBy: sourceWord((t.kind === 'show' ? shows : movies)(t))! } : {}) };
    };
    const items: DownloadItem[] = live.items.map(i => {
      const g = grabs.get(i.id), mine = g && g.downloader === i.downloader ? g : undefined;
      // A finished download tk.box is importing, or imported and let go: say so rather than the client's Completed.
      const state: ClientState = mine?.state === 'importing' && (i.state === 'completed' || i.state === 'seeding') && i.downloader === 'sabnzbd' ? 'importing' : i.state;
      return { ...i, state, key: `${i.downloader}:${i.id}`, ...(mine ? about(mine) : {}) };
    });
    const listed = new Set(items.filter(i => i.grab).map(i => i.grab!.id));
    // A downloader that didn't answer lists nothing: its grabs show as tk.box last saw them.
    for (const g of store.activeGrabs()) {
      if (listed.has(g.id)) continue;
      const [state, detail] = grabStates[g.state] ?? ['queued'];
      items.push({ key: `grab:${g.id}`, downloader: g.downloader === 'qbittorrent' ? 'qbittorrent' : 'sabnzbd', id: g.downloadId ?? '', name: g.releaseName, protocol: g.protocol,
        state, ...(detail ? { detail } : {}), progress: g.progress ?? (state === 'importing' ? 1 : 0), mine: true, ...(g.size !== undefined ? { size: g.size } : {}),
        ...(g.sentAt ? { addedAt: g.sentAt } : {}), ...(g.error ? { error: g.error } : {}), ...about(g) });
    }
    return { clients: live.clients, items } satisfies DownloadsLive;
  });
  app.post('/api/v1/admin/library/grabs/:id/retry', admin, async request => { library.retryGrab(id.parse(request.params).id); return { ok: true }; });
  app.post('/api/v1/admin/library/jobs/:id/retry', admin, async request => {
    requireThat(queue.retry(id.parse(request.params).id), 'JOB_NOT_RETRIED', 'That job isn’t failed, or the same work is already queued.', 409);
    return { ok: true };
  });

  app.get('/api/v1/admin/library/wanted', admin, async () => ({ items: await library.wantedList() }) satisfies WantedList);
  app.get('/api/v1/admin/library/movies', admin, async () => ({ items: library.movieList(sourcesNow()) }) satisfies MovieList);
  app.get('/api/v1/admin/library/shows', admin, async () => ({ items: library.showList(showSourcesNow()) }) satisfies ShowList);
  // A title's poster: a redirect to TMDB's, through the image proxy, from the cached details (for a show, the ones the
  // library reads). 404 without one.
  app.get('/api/v1/admin/library/titles/:id/poster', { config: { access: 'admin', rateLimit: { max: 1200, timeWindow: 60000 } } }, async (request, reply) => {
    const title = store.title(id.parse(request.params).id);
    requireThat(title && titles, 'NOT_FOUND', 'No poster.', 404);
    const details = await (title.kind === 'show' ? titles.get(`/tv/${title.tmdbId}`, { append_to_response: 'external_ids,alternative_titles' })
      : titles.get(`/movie/${title.tmdbId}`, { append_to_response: 'alternative_titles,release_dates,external_ids' })).catch(() => undefined) as
      { poster_path?: string | null } | undefined;
    const url = tmdbImage(details?.poster_path, 'w154');
    requireThat(url, 'NOT_FOUND', 'No poster.', 404);
    return reply.header('Cache-Control', 'private, max-age=86400').redirect(url);
  });
  app.get('/api/v1/admin/library/titles/:id', admin, async request => titleView(id.parse(request.params).id));
  app.put('/api/v1/admin/library/titles/:id', admin, async request => {
    const { id: titleId } = id.parse(request.params);
    const { profileId, keep, monitored, earlyCopies } = z.object({ profileId: z.number().int().positive().optional(), keep: z.boolean().optional(), monitored: z.boolean().optional(),
      earlyCopies: z.boolean().optional() }).strict().parse(request.body);
    const title = store.title(titleId);
    requireThat(title, 'NOT_FOUND', 'No such title in the library.', 404);
    if (profileId !== undefined) { requireThat(store.profile(profileId), 'PROFILE_NOT_FOUND', 'No such profile.', 404); library.setProfile(titleId, profileId); }
    if (keep !== undefined) library.keep(titleId, keep);
    if (monitored !== undefined) library.setMonitored(titleId, monitored);
    if (earlyCopies !== undefined) library.setEarlyCopies(titleId, earlyCopies);
    if (profileId !== undefined || keep !== undefined || earlyCopies !== undefined)
      store.audit('library_title_changed', { title: titleId, by: actor(request), ...(profileId !== undefined ? { profileId } : {}), ...(keep !== undefined ? { keep } : {}),
        ...(earlyCopies !== undefined ? { earlyCopies } : {}) });
    return titleView(titleId);
  });
  // Deleted from the library, with its folder on disk unless `files` is false.
  app.delete('/api/v1/admin/library/titles/:id', admin, async request => {
    const { files } = z.object({ files: z.boolean().default(true) }).strict().parse(request.body ?? {});
    clearNames();
    return await library.remove(id.parse(request.params).id, files);
  });
  // One of its files deleted from disk and the library.
  app.delete('/api/v1/admin/library/titles/:id/files/:fileId', admin, async request => {
    const { id: titleId, fileId } = z.object({ id: z.coerce.number().int().positive(), fileId: z.coerce.number().int().positive() }).strict().parse(request.params);
    return await library.removeFile(titleId, fileId);
  });
  // Quick edit: the same changes to many movies or shows at once.
  app.post('/api/v1/admin/library/titles/bulk', admin, async request => {
    const { ids, ...changes } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(10000), monitored: z.boolean().optional(), resume: z.literal(true).optional(),
      profileId: z.number().int().positive().optional(), keep: z.boolean().optional(), search: z.literal(true).optional() }).strict().parse(request.body);
    return await library.bulkEdit(ids, changes, actor(request)) satisfies LibraryBulkResult;
  });
  // A show's season switched on or off, with its episodes.
  app.put('/api/v1/admin/library/titles/:id/seasons/:season', admin, async request => {
    const { id: titleId, season } = z.object({ id: z.coerce.number().int().positive(), season: z.coerce.number().int().positive().max(999) }).strict().parse(request.params);
    const { monitored } = z.object({ monitored: z.boolean() }).strict().parse(request.body);
    library.monitorSeason(titleId, season, monitored);
    return titleView(titleId);
  });
  // A show's season (S02) or episode (S02E05); movies take none.
  const scopeBody = z.object({ scope: z.string().regex(/^S\d{2,}(E\d{2,})?$/).optional() }).strict();
  app.post('/api/v1/admin/library/titles/:id/search', admin, async request => {
    library.searchNow(id.parse(request.params).id, scopeBody.parse(request.body ?? {}).scope); return { ok: true };
  });
  app.post('/api/v1/admin/library/titles/:id/pause', admin, async request => {
    const { id: titleId } = id.parse(request.params), { paused } = z.object({ paused: z.boolean() }).strict().parse(request.body);
    library.setPaused(titleId, paused);
    return titleView(titleId);
  });
  app.post('/api/v1/admin/library/titles/:id/interactive', { config: { access: 'admin', rateLimit: { max: 20, timeWindow: 60000 } } },
    async request => await library.interactive(id.parse(request.params).id, undefined, scopeBody.parse(request.body ?? {}).scope) satisfies InteractiveSearch);
  app.post('/api/v1/admin/library/titles/:id/grab', admin, async request => {
    const { guid, scope } = z.object({ guid: z.string().min(1).max(500) }).merge(scopeBody).strict().parse(request.body);
    clearNames();
    return grabView(library.grabRelease(id.parse(request.params).id, guid, scope));
  });

  app.get('/api/v1/admin/library/rules', admin, async () => pickRules());
  app.post('/api/v1/admin/library/profiles', admin, async request => {
    const { name, value } = profileInput.parse(request.body), profile = profileValue(value, store.formats());
    requireThat(!store.profileNamed(name), 'PROFILE_EXISTS', `A profile named ${name} already exists.`, 409);
    const profileId = store.insertProfile(name, profile);
    store.audit('pick_profile_created', { id: profileId, name, by: actor(request) });
    return pickRules();
  });
  app.put('/api/v1/admin/library/profiles/:id', admin, async request => {
    const { id: profileId } = id.parse(request.params);
    const { expectedVersion, name, value } = profileInput.extend({ expectedVersion: z.string().max(40) }).strict().parse(request.body);
    const profile = profileValue(value, store.formats());
    store.db.transaction(() => {
      const current = store.profileRows().find(p => p.id === profileId);
      requireThat(current, 'PROFILE_NOT_FOUND', 'No such profile.', 404);
      requireThat(version([current.name, current.value]) === expectedVersion, 'REVISION_CONFLICT', 'The profile changed. Reload and retry.', 409);
      const named = store.profileNamed(name);
      requireThat(!named || named.id === profileId, 'PROFILE_EXISTS', `A profile named ${name} already exists.`, 409);
      store.updateProfile(profileId, name, profile);
      store.audit('pick_profile_changed', { id: profileId, name, by: actor(request) });
    })();
    return pickRules();
  });
  app.delete('/api/v1/admin/library/profiles/:id', admin, async request => {
    const { id: profileId } = id.parse(request.params);
    store.db.transaction(() => {
      const current = store.profileRows().find(p => p.id === profileId);
      requireThat(current, 'PROFILE_NOT_FOUND', 'No such profile.', 404);
      requireThat(store.settings().defaultProfile !== profileId, 'PROFILE_DEFAULT', 'The default profile can’t be deleted.', 409);
      requireThat(!current.used, 'PROFILE_IN_USE', `${current.used} title${current.used === 1 ? ' uses' : 's use'} ${current.name}.`, 409);
      store.deleteProfile(profileId);
      store.audit('pick_profile_deleted', { id: profileId, name: current.name, by: actor(request) });
    })();
    return pickRules();
  });
  // A built-in profile back as it shipped, keeping its name; points for formats since deleted are left out.
  app.post('/api/v1/admin/library/profiles/:id/reset', admin, async request => {
    const { id: profileId } = id.parse(request.params), { expectedVersion } = z.object({ expectedVersion: z.string().max(40) }).strict().parse(request.body);
    store.db.transaction(() => {
      const current = store.profileRows().find(p => p.id === profileId);
      requireThat(current, 'PROFILE_NOT_FOUND', 'No such profile.', 404);
      requireThat(version([current.name, current.value]) === expectedVersion, 'REVISION_CONFLICT', 'The profile changed. Reload and retry.', 409);
      const built = current.builtIn ? builtInProfile(current.builtIn) : undefined;
      requireThat(built, 'PROFILE_NOT_BUILT_IN', `${current.name} isn’t a built-in profile.`, 409);
      const names = new Set(store.formats().map(f => f.name));
      store.updateProfile(profileId, current.name, { ...built.profile, scores: Object.fromEntries(Object.entries(built.profile.scores).filter(([n]) => names.has(n))) });
      store.audit('pick_profile_reset', { id: profileId, name: current.name, by: actor(request) });
    })();
    return pickRules();
  });
  // The formats, as one ordered list. Profiles keep their points for a renamed format (`from`) and lose them for a
  // removed one.
  app.put('/api/v1/admin/library/formats', admin, async request => {
    const { expectedVersion, formats } = formatsInput.parse(request.body);
    const names = new Set<string>();
    for (const f of formats) {
      requireThat(!names.has(f.name.toLowerCase()), 'FORMAT_EXISTS', `Two formats are named ${f.name}.`, 409);
      names.add(f.name.toLowerCase());
    }
    const saved: Format[] = formats.map(({ from: _, ...f }) => ({ name: f.name, ...(f.label ? { label: f.label } : {}), category: f.category,
      conditions: f.conditions.map(c => ({ field: c.field, values: BOOLEAN_FIELDS.has(c.field) ? [] : c.values, ...(c.required ? { required: true } : {}), ...(c.negate ? { negate: true } : {}) })) }));
    store.db.transaction(() => {
      requireThat(version(store.formats()) === expectedVersion, 'REVISION_CONFLICT', 'The formats changed. Reload and retry.', 409);
      store.replaceFormats(saved);
      for (const p of store.profileRows()) {
        const scores = Object.fromEntries(formats.flatMap(f => { const points = p.value.scores[f.from ?? f.name]; return points === undefined ? [] : [[f.name, points]]; }));
        if (JSON.stringify(scores) !== JSON.stringify(p.value.scores)) store.updateProfile(p.id, p.name, { ...p.value, scores });
      }
      store.audit('formats_changed', { count: saved.length, by: actor(request) });
    })();
    return pickRules();
  });
  // Try a release: what each profile would do with it, as if it were a search result for the title its name gives.
  app.post('/api/v1/admin/library/try', admin, async request => {
    const input = tryInput.parse(request.body), parsed = parseRelease(input.release), quality = qualityOf(parsed);
    const formats = store.formats(), settings = store.settings(), now = Date.now();
    const candidate = { name: input.release, indexer: 'try', guid: 'try', protocol: 'usenet' as const, ...(input.size !== undefined ? { size: input.size } : {}) };
    const want = { kind: 'movie' as const, title: { title: parsed.title || input.release, ...(parsed.year ? { year: parsed.year } : {}) }, ...(input.runtime ? { runtime: input.runtime } : {}) };
    return {
      parsed: parsedFacts(parsed), formats: formats.filter(f => formatMatches(f, { parsed, ...(quality ? { quality } : {}) })).map(f => f.name),
      profiles: store.profileRows().map(p => {
        const d = decide(candidate, want, { profile: p.value, formats, settings: { earlyCopies: true, protocol: settings.protocol, properDays: settings.properDays }, now });
        return { id: p.id, name: p.name, ...(d.quality ? { quality: d.quality } : {}), ...(d.tier !== undefined ? { tier: d.tier } : {}),
          preferred: d.tier !== undefined && d.tier < p.value.preferred, score: d.score, accepted: d.accepted, scoreParts: d.scoreParts, rejections: d.rejections };
      }),
    } satisfies TryRelease;
  });

  app.get('/api/v1/admin/library/settings', admin, async () => settingsView());
  app.put('/api/v1/admin/library/settings', admin, async request => {
    const { expectedRevision, roots, ...patch } = settingsInput.parse(request.body);
    if (patch.defaultProfile !== undefined) requireThat(store.profile(patch.defaultProfile), 'PROFILE_NOT_FOUND', 'No such profile.', 404);
    const current = store.settings();
    // A root's new value applies to titles added from now on; each title keeps the root it was added under.
    const trim = (path: string) => path.replace(/[\\/]+$/, '');
    const saved = store.updateSettings(actor(request), expectedRevision, { ...patch, ...(roots ? { roots: { movie: trim(roots.movie ?? current.roots.movie),
      show: trim(roots.show ?? current.roots.show) } } : {}) });
    requireThat(saved, 'REVISION_CONFLICT', 'Library settings changed. Reload and retry.', 409);
    return settingsView();
  });
  app.post('/api/v1/admin/library/naming/preview', admin, async request => namingPreview(store, previewInput.parse(request.body)));
}
