import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DownloadsActivity, DownloadsGrab, DownloadsSeeding, InteractiveSearch, LibraryTitleView, LibrarySettingsView, MovieList, NamingPreview, PickProfile,
  PickRules, WantedList } from '../../../packages/contracts/src/downloads.js';
import { viewer } from './modules/access.js';
import { AppError, requireThat } from './errors.js';
import { EARLY_COPIES, LADDER, isQuality, qualityOf, scoreRelease, type Profile, type Quality, type ScoreRule } from './lib/quality.js';
import { parseRelease } from './lib/release-name.js';
import { movieFileName, movieFolder, videoCodecName } from './lib/naming.js';
import { IPT_FLOOR, seedingDecision } from './lib/seeding.js';
import { tmdbImage } from './providers/explore-images.js';
import type { TmdbTitles } from './providers/tmdb-titles.js';
import type { Grab, LibraryStore } from './persistence/library-store.js';
import type { Library } from './services/library.js';
import type { QueueApi } from './services/queue.js';

// Admin › Manage for movies (docs/ARR-REPLACEMENT.md, "Admin UI"; docs/PHASE-3.5.md): downloads, wanted, every movie,
// a title with its interactive search, pick rules (profiles and score rules) and the library settings with a naming
// preview. All admin.

const GB_MAX = 500;
const version = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const id = z.object({ id: z.coerce.number().int().positive() }).strict();
const size = (max: number) => z.tuple([z.number().min(0).max(max), z.number().min(0).max(max)]).refine(([min, most]) => min < most, 'The smallest size must be under the largest.');

// A profile as Admin sends it: any order, unknown rungs refused. Saved in the ladder's fixed order with every rung.
export const profileInput = z.object({
  name: z.string().trim().min(1).max(40),
  value: z.object({
    qualities: z.array(z.object({ name: z.string(), allowed: z.boolean() }).strict()).max(LADDER.length),
    cutoff: z.string(), movieSize: size(GB_MAX), episodeSize: size(GB_MAX),
  }).strict(),
}).strict();
export function profileValue(input: z.infer<typeof profileInput>['value']): Profile {
  const unknown = input.qualities.find(q => !isQuality(q.name));
  if (unknown) throw new AppError('PROFILE_INVALID', `${unknown.name} isn’t a quality.`);
  const allowed = new Set(input.qualities.filter(q => q.allowed).map(q => q.name));
  requireThat([...allowed].some(q => !EARLY_COPIES.has(q as Quality)), 'PROFILE_INVALID', 'Allow at least one quality besides the early copies.');
  requireThat(isQuality(input.cutoff), 'PROFILE_INVALID', `${input.cutoff} isn’t a quality.`);
  requireThat(allowed.has(input.cutoff) && !EARLY_COPIES.has(input.cutoff), 'PROFILE_INVALID', 'The cutoff must be one of the allowed qualities, and not an early copy.');
  return { qualities: LADDER.map(name => ({ name, allowed: allowed.has(name) })), cutoff: input.cutoff, movieSize: input.movieSize, episodeSize: input.episodeSize };
}

const FIELDS = ['codec', 'hdr', 'edition', 'group', 'language', 'flag', 'source', 'resolution'];
// Labels go into file names ({[Custom Formats]}), so only letters, digits, spaces and + . -.
export const ruleInput = z.object({
  name: z.string().trim().min(1).max(60),
  label: z.string().trim().max(20).regex(/^[A-Za-z0-9 +.-]*$/, 'Labels take letters, digits, spaces and + . - only').optional(),
  pattern: z.string().trim().min(1).max(200).superRefine((pattern, ctx) => {
    const field = /^([a-z]+):(.+)$/i.exec(pattern);
    if (field && FIELDS.includes(field[1]!.toLowerCase())) return;
    try { new RegExp(pattern, 'i'); } catch { ctx.addIssue({ code: 'custom', message: `“${pattern}” isn’t a valid pattern` }); }
  }),
  points: z.number().int().min(-1000).max(1000), ban: z.boolean(), applies: z.enum(['movie', 'show', 'both']),
}).strict();
const rulesInput = z.object({ expectedVersion: z.string().max(40), rules: z.array(ruleInput).max(100) }).strict();
const rulesOf = (rules: ScoreRule[]) => rules.map(r => ({ ...r, points: r.ban ? 0 : r.points }));

const root = z.string().trim().min(1).max(300).refine(p => isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'Use a full path');
export const settingsInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  roots: z.object({ movie: root }).strict().optional(),
  earlyCopies: z.boolean().optional(),
  protocol: z.enum(['usenet-first', 'torrent-first']).optional(),
  defaultProfile: z.number().int().positive().optional(),
  // Validated again by librarySettings, which holds the IPTorrents floor (ratio 1, 14 days).
  seeding: z.object({ ratio: z.number().max(100), minDays: z.number().max(3650), maxDays: z.number().max(3650) }).strict()
    .refine(s => s.minDays <= s.maxDays, 'The minimum days must not be over the maximum.').optional(),
}).strict();

const previewInput = z.object({ release: z.string().trim().min(1).max(300), tmdbId: z.number().int().positive().max(99999999).optional() }).strict();
// The name a release would get, from what its name says (an import reads the audio, HDR and codec from ffprobe instead).
export function namingPreview(store: Pick<LibraryStore, 'rules' | 'settings'>, input: z.infer<typeof previewInput>): NamingPreview {
  const parsed = parseRelease(input.release), quality = qualityOf(parsed);
  requireThat(quality, 'QUALITY_UNKNOWN', 'Its quality can’t be read from the name.');
  const movie = { title: parsed.title || 'Untitled', ...(parsed.year ? { year: parsed.year } : {}), tmdbId: input.tmdbId ?? 44115 };
  const { labels } = scoreRelease({ parsed }, store.rules(), 'movie');
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
type Deps = { store: LibraryStore; library: Library; queue: QueueApi; titles?: Pick<TmdbTitles, 'get'> };

export function registerLibraryAdmin(app: FastifyInstance, { store, library, queue, titles }: Deps) {
  const admin = { config: { access: 'admin' as const } };
  const actor = (request: Parameters<typeof viewer>[0]) => viewer(request).grant.accountId;
  const titleName = new Map<number, { title: string; year?: number }>();
  const nameOf = (titleId: number) => {
    let name = titleName.get(titleId);
    if (!name) { const t = store.title(titleId); name = t ? { title: t.title, ...(t.year ? { year: t.year } : {}) } : { title: `Title ${titleId}` }; titleName.set(titleId, name); }
    return name;
  };
  const grabView = (g: Grab): DownloadsGrab => ({ id: g.id, titleId: g.titleId, ...nameOf(g.titleId), releaseName: g.releaseName, indexer: g.indexer, protocol: g.protocol,
    ...(g.size !== undefined ? { size: g.size } : {}), quality: g.quality, score: g.score, upgrade: g.upgrade, state: g.state,
    ...(g.progress !== undefined ? { progress: g.progress } : {}), ...(g.error ? { error: g.error } : {}), ...(g.sentAt ? { sentAt: g.sentAt } : {}),
    ...(g.finishedAt ? { finishedAt: g.finishedAt } : {}), ...(g.importedAt ? { importedAt: g.importedAt } : {}) });
  // The title a queue item is for, from its key (movie:12, grab:88, file:5).
  const subjectOf = (key: string): number | undefined => {
    const [kind, raw] = key.split(':'), n = Number(raw);
    if (!Number.isInteger(n)) return undefined;
    return kind === 'movie' ? n : kind === 'grab' ? store.grab(n)?.titleId : kind === 'file' ? store.file(n)?.titleId : undefined;
  };
  const pickRules = (): PickRules => {
    const rules = rulesOf(store.rules());
    return { profiles: store.profileRows().map(p => ({ ...p, value: p.value as PickProfile, version: version([p.name, p.value]) })), rules, rulesVersion: version(rules),
      ladder: [...LADDER], earlyCopies: LADDER.filter(q => EARLY_COPIES.has(q)) };
  };
  const settingsView = (): LibrarySettingsView => ({ ...store.settings(), seedingFloor: { ...IPT_FLOOR } });
  const titleView = async (titleId: number): Promise<LibraryTitleView> => {
    const title = store.title(titleId);
    requireThat(title && title.kind === 'movie', 'NOT_FOUND', 'No such movie in the library.', 404);
    titleName.delete(titleId);
    const search = store.search(title.id, 'movie'), wanted = await library.titleWanted(title);
    return { id: title.id, tmdbId: title.tmdbId, ...(title.imdbId ? { imdbId: title.imdbId } : {}), title: title.title, ...(title.year ? { year: title.year } : {}),
      profileId: title.profileId, keep: title.keep, monitored: title.monitor !== 'none', paused: title.paused, ...(title.pausedReason ? { pausedReason: title.pausedReason } : {}),
      wanted, released: title.released, ...(search ? { nextAt: search.nextAt, ...(search.lastAt ? { lastAt: search.lastAt } : {}) } : {}), misses: search?.misses ?? 0,
      files: store.files(title.id), grabs: store.grabsFor(title.id, 20).map(grabView), profiles: store.profiles() };
  };

  const seedingView = (g: Grab): DownloadsSeeding => {
    const seen = g.seedingCheckedAt !== undefined && g.seedingSeconds !== undefined;
    const removeAt = seen ? seedingDecision({ ratio: g.ratio ?? 0, seedingSeconds: g.seedingSeconds! }, store.settings().seeding, g.seedingCheckedAt!).removeAt : undefined;
    return { ...grabView(g), ...(g.ratio !== undefined ? { ratio: g.ratio } : {}), ...(g.seedingSeconds !== undefined ? { seedingDays: g.seedingSeconds / 86400 } : {}),
      ...(g.seedingCheckedAt !== undefined ? { checkedAt: g.seedingCheckedAt } : {}), ...(removeAt !== undefined ? { removeAt } : {}) };
  };

  app.get('/api/v1/admin/library/activity', admin, async () => {
    titleName.clear();
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
  app.post('/api/v1/admin/library/grabs/:id/retry', admin, async request => { library.retryGrab(id.parse(request.params).id); return { ok: true }; });
  app.post('/api/v1/admin/library/jobs/:id/retry', admin, async request => {
    requireThat(queue.retry(id.parse(request.params).id), 'JOB_NOT_RETRIED', 'That job isn’t failed, or the same work is already queued.', 409);
    return { ok: true };
  });

  app.get('/api/v1/admin/library/wanted', admin, async () => ({ items: await library.wantedList() }) satisfies WantedList);
  app.get('/api/v1/admin/library/movies', admin, async () => ({ items: library.movieList() }) satisfies MovieList);
  // A movie's poster: a redirect to TMDB's, through the image proxy, from the cached details. 404 without one.
  app.get('/api/v1/admin/library/titles/:id/poster', { config: { access: 'admin', rateLimit: { max: 1200, timeWindow: 60000 } } }, async (request, reply) => {
    const title = store.title(id.parse(request.params).id);
    requireThat(title && titles, 'NOT_FOUND', 'No poster.', 404);
    const details = await titles.get(`/movie/${title.tmdbId}`, { append_to_response: 'alternative_titles,release_dates,external_ids' }).catch(() => undefined) as
      { poster_path?: string | null } | undefined;
    const url = tmdbImage(details?.poster_path, 'w154');
    requireThat(url, 'NOT_FOUND', 'No poster.', 404);
    return reply.header('Cache-Control', 'private, max-age=86400').redirect(url);
  });
  app.get('/api/v1/admin/library/titles/:id', admin, async request => titleView(id.parse(request.params).id));
  app.put('/api/v1/admin/library/titles/:id', admin, async request => {
    const { id: titleId } = id.parse(request.params);
    const { profileId, keep } = z.object({ profileId: z.number().int().positive().optional(), keep: z.boolean().optional() }).strict().parse(request.body);
    const title = store.title(titleId);
    requireThat(title && title.kind === 'movie', 'NOT_FOUND', 'No such movie in the library.', 404);
    if (profileId !== undefined) { requireThat(store.profile(profileId), 'PROFILE_NOT_FOUND', 'No such profile.', 404); store.setProfile(titleId, profileId); }
    if (keep !== undefined) library.keep(titleId, keep);
    store.audit('library_title_changed', { title: titleId, by: actor(request), ...(profileId !== undefined ? { profileId } : {}), ...(keep !== undefined ? { keep } : {}) });
    return titleView(titleId);
  });
  app.post('/api/v1/admin/library/titles/:id/search', admin, async request => { library.searchNow(id.parse(request.params).id); return { ok: true }; });
  app.post('/api/v1/admin/library/titles/:id/pause', admin, async request => {
    const { id: titleId } = id.parse(request.params), { paused } = z.object({ paused: z.boolean() }).strict().parse(request.body);
    library.setPaused(titleId, paused);
    return titleView(titleId);
  });
  app.post('/api/v1/admin/library/titles/:id/interactive', { config: { access: 'admin', rateLimit: { max: 20, timeWindow: 60000 } } },
    async request => await library.interactive(id.parse(request.params).id) satisfies InteractiveSearch);
  app.post('/api/v1/admin/library/titles/:id/grab', admin, async request => {
    const { guid } = z.object({ guid: z.string().min(1).max(500) }).strict().parse(request.body);
    titleName.clear();
    return grabView(library.grabRelease(id.parse(request.params).id, guid));
  });

  app.get('/api/v1/admin/library/rules', admin, async () => pickRules());
  app.post('/api/v1/admin/library/profiles', admin, async request => {
    const { name, value } = profileInput.parse(request.body), profile = profileValue(value);
    requireThat(!store.profileNamed(name), 'PROFILE_EXISTS', `A profile named ${name} already exists.`, 409);
    const profileId = store.insertProfile(name, profile);
    store.audit('pick_profile_created', { id: profileId, name, by: actor(request) });
    return pickRules();
  });
  app.put('/api/v1/admin/library/profiles/:id', admin, async request => {
    const { id: profileId } = id.parse(request.params);
    const { expectedVersion, name, value } = profileInput.extend({ expectedVersion: z.string().max(40) }).strict().parse(request.body);
    const profile = profileValue(value);
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
  app.put('/api/v1/admin/library/rules', admin, async request => {
    const { expectedVersion, rules } = rulesInput.parse(request.body);
    store.db.transaction(() => {
      requireThat(version(rulesOf(store.rules())) === expectedVersion, 'REVISION_CONFLICT', 'The score rules changed. Reload and retry.', 409);
      store.replaceRules(rules.map(r => ({ name: r.name, ...(r.label ? { label: r.label } : {}), pattern: r.pattern, points: r.ban ? 0 : r.points, ban: r.ban, applies: r.applies })));
      store.audit('score_rules_changed', { count: rules.length, by: actor(request) });
    })();
    return pickRules();
  });

  app.get('/api/v1/admin/library/settings', admin, async () => settingsView());
  app.put('/api/v1/admin/library/settings', admin, async request => {
    const { expectedRevision, roots, ...patch } = settingsInput.parse(request.body);
    if (patch.defaultProfile !== undefined) requireThat(store.profile(patch.defaultProfile), 'PROFILE_NOT_FOUND', 'No such profile.', 404);
    const current = store.settings();
    const saved = store.updateSettings(actor(request), expectedRevision, { ...patch, ...(roots ? { roots: { ...current.roots, movie: roots.movie.replace(/[\\/]+$/, '') } } : {}) });
    requireThat(saved, 'REVISION_CONFLICT', 'Library settings changed. Reload and retry.', 409);
    return settingsView();
  });
  app.post('/api/v1/admin/library/naming/preview', admin, async request => namingPreview(store, previewInput.parse(request.body)));
}
