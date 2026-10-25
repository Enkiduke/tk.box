import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from './database.js';
import type { Vault } from '../security/vault.js';
import { AppError } from '../errors.js';

// Artwork's settings, layouts and job history. The engine (apps/artwork/overlayrr.py) reads none of this directly:
// before each run tk.box writes it out as the engine's JSON config (artworkConfig). Provider keys are sealed.
export const layoutName = z.string().regex(/^[\w-]{1,40}$/, 'Use letters, numbers, dashes or underscores (up to 40)');
const libraryId = z.string().regex(/^\d{1,10}$/);
const daily = z.object({ enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict();
const everyFew = z.object({ enabled: z.boolean(), minutes: z.number().int().min(5).max(1440) }).strict();
const label = z.string().max(60).refine(value => ![...value].some(c => c.charCodeAt(0) < 32), 'No control characters');
export const artworkSettings = z.object({
  libraries: z.array(libraryId).max(50),
  upload: z.boolean(), uploadLogo: z.boolean(),
  includeSeasons: z.boolean(), includeEpisodes: z.boolean(), includeCollections: z.boolean(),
  missingArt: z.enum(['stock', 'skip']),
  quality: z.number().int().min(50).max(100), workers: z.number().int().min(1).max(8),
  language: z.string().regex(/^[a-z]{2}$/),
  completionLabel: label,
  defaultLayout: layoutName,
  layoutByLibrary: z.record(libraryId, layoutName),
  layoutByType: z.object({ movie: layoutName, tv: layoutName, custom: layoutName, collection: layoutName, streaming: layoutName, chart: layoutName }).partial(),
  schedules: z.object({
    // Each day at a server-local time: --changed-only. Collections have their own schedules.
    scrub: daily,
    // Titles newly added to the chosen libraries, checked when Plex says it added some and every N minutes besides
    // (in place of a Tautulli hook).
    added: everyFew
  }).strict()
}).strict();
export type ArtworkSettings = z.infer<typeof artworkSettings>;
export type ScheduleName = keyof ArtworkSettings['schedules'];
export type CollectionScheduleName = keyof ArtworkCollections['schedules'];
const key = z.string().trim().max(200).regex(/^[\w-]*$/);
// Omitted keeps a saved key; an empty string removes it.
export const artworkSettingsInput = artworkSettings.extend({ tmdbKey: key.optional(), tvdbKey: key.optional(), fanartKey: key.optional(), mdblistKey: key.optional() }).strict();
export type ArtworkSettingsInput = z.infer<typeof artworkSettingsInput>;
export const layoutValue = z.record(z.string().regex(/^[a-z_]{1,60}$/), z.unknown()).refine(value => JSON.stringify(value).length <= 40000, 'Layout is too large');
export type ArtworkKeys = { tmdb?: string; tvdb?: string; fanart?: string; mdblist?: string };
const keyNames = ['tmdb', 'tvdb', 'fanart', 'mdblist'] as const;
// Collection schedules saved with the artwork settings, before collections had their own.
type OldSchedules = { seasonal?: z.infer<typeof daily>; collections?: z.infer<typeof daily> };
type Stored = ArtworkSettings & { keys: Partial<Record<typeof keyNames[number], string>>; schedules: Partial<ArtworkSettings['schedules']> & OldSchedules };
// Collections: custom and seasonal definitions in the engine's own format (it validates them), how franchise, streaming and
// chart collections are kept in step, and the Radarr that seasonal collections may download missing movies with.
const origin = z.string().trim().max(300).refine(value => { if (!value) return true; try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }, 'Use an http(s) address').transform(value => value.replace(/\/+$/, ''));
export const artworkCollections = z.object({
  // null until first saved: the engine then offers its seasonal presets, all off.
  definitions: z.array(z.record(z.string(), z.unknown())).max(300).nullable(),
  // The franchise and streaming collections set apart from how they're made: turned off, where they show in Plex, or titles taken out.
  automatic: z.array(z.object({ name: z.string().trim().min(1).max(200), library: z.string().trim().min(1).max(200), kind: z.enum(['franchise', 'streaming']), enabled: z.boolean().optional(),
    visibility: z.object({ home: z.boolean(), shared: z.boolean(), recommended: z.boolean() }).partial().strict().optional(),
    // Titles taken out of it, by Plex ID.
    exclude: z.array(z.string().regex(/^\d{1,10}$/)).max(2000).optional() }).strict()).max(3000).default([]),
  franchise: z.object({ sync: z.boolean(), franchises: z.boolean(), minItems: z.number().int().min(1).max(50), mode: z.enum(['sync', 'append']), streaming: z.enum(['off', 'originals', 'available']),
    region: z.string().regex(/^[A-Z]{2}$/), recent: z.boolean(), recentMovieDays: z.number().int().min(1).max(3650), recentEpisodeDays: z.number().int().min(1).max(3650) }).strict(),
  radarr: z.object({ url: origin, rootFolder: z.string().trim().max(300), qualityProfileId: z.number().int().min(0).max(100000), search: z.boolean() }).strict(),
  // Each day at a server-local time: the custom and seasonal collections, then every collection. Titles newly added to
  // the libraries the custom collections use join the ones they match, checked when Plex adds some and every N minutes.
  schedules: z.object({ custom: daily, all: daily, added: everyFew }).strict()
}).strict().refine(value => JSON.stringify(value).length <= 400000, 'Too many collections');
export type ArtworkCollections = z.infer<typeof artworkCollections>;
export const artworkCollectionsInput = z.object({ value: artworkCollections, radarrKey: key.optional(), expectedRevision: z.number().int().nonnegative() }).strict();
const collectionDefaults: ArtworkCollections = { definitions: null, automatic: [],
  franchise: { sync: false, franchises: true, minItems: 2, mode: 'sync', streaming: 'off', region: 'US', recent: false, recentMovieDays: 90, recentEpisodeDays: 7 },
  radarr: { url: '', rootFolder: '', qualityProfileId: 0, search: true },
  schedules: { custom: { enabled: false, time: '04:15' }, all: { enabled: false, time: '04:30' }, added: { enabled: false, minutes: 60 } } };
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type JobRow = { id: number; label: string; args: string[]; script: 'artwork' | 'collections'; actor: string; status: JobStatus; createdAt: number; startedAt: number | null; finishedAt: number | null; exitCode: number | null };

// Everything starts local-only: nothing is sent to Plex until an administrator turns uploads on. The tk-* layouts
// (apps/artwork/defaults.json) are used by kind of title until a library is given its own.
const defaults: ArtworkSettings = { libraries: [], upload: false, uploadLogo: true, includeSeasons: true, includeEpisodes: false, includeCollections: false,
  missingArt: 'stock', quality: 95, workers: 2, language: 'en', completionLabel: 'Overlayrr', defaultLayout: 'tk-movies', layoutByLibrary: {},
  layoutByType: { movie: 'tk-movies', tv: 'tk-tv', custom: 'tk-custom', collection: 'tk-collections', streaming: 'tk-streaming', chart: 'tk-charts' },
  schedules: { scrub: { enabled: false, time: '04:00' }, added: { enabled: false, minutes: 60 } } };

// The layouts seeded before the tk-* set (Overlayrr's example config), and the tk-* layout each one's uses move to.
const RETIRED: Record<string, string> = { 'overlayrr-main': 'tk-movies', 'tk-movies': 'tk-movies', 'tk-tv': 'tk-tv', 'collection-tmdb': 'tk-collections',
  'streaming-collection': 'tk-streaming', 'chart-collection': 'tk-charts' };
const SEED_VERSION = 2;

export class ArtworkStore {
  constructor(private db: Db, private vault: Vault, seedFile?: string) { if (seedFile) { this.seed(seedFile); this.customLogos(seedFile); } this.moveSchedules(); }
  // tk-custom drew a custom collection's title as layout text, over any logo picked for it. It draws a logo now, the
  // title made into one by default, so a saved tk-custom still drawing that text gets the bundled logo settings, once.
  private customLogos(file: string, now = Date.now()) {
    if (this.state<boolean>('layouts:custom-logo')) return;
    const row = this.db.prepare('SELECT revision,value FROM artwork_layouts WHERE name=?').get('tk-custom') as { revision: number; value: string } | undefined;
    const value = row && JSON.parse(row.value) as Record<string, unknown>;
    this.db.transaction(() => {
      if (row && value?.logo_mode === 'none' && value.custom_text === '{title_lines}') {
        const seed = (JSON.parse(readFileSync(file, 'utf8')) as { layouts: Record<string, Record<string, unknown>> }).layouts['tk-custom'];
        const kept = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'logo_mode' && !key.startsWith('text_') && !['custom_text', 'font_size', 'letter_spacing', 'position_x', 'position_y'].includes(key)));
        this.db.prepare('UPDATE artwork_layouts SET revision=?,value=?,updated_at=? WHERE name=?').run(row.revision + 1, JSON.stringify({ ...kept, ...seed }), now, 'tk-custom');
      }
      this.setState('layouts:custom-logo', true);
    })();
  }
  // Collection schedules were kept with the artwork settings until collections had their own, and new titles joined
  // their custom collections with artwork's newly added check. They move over once, keeping what was set.
  private moveSchedules() {
    const row = this.db.prepare('SELECT value FROM artwork_settings WHERE id=1').get() as { value: string } | undefined;
    const settings = row && JSON.parse(row.value) as Stored;
    if (!settings?.schedules || !('seasonal' in settings.schedules || 'collections' in settings.schedules)) return;
    this.db.transaction(() => {
      const { revision, value } = this.storedCollections(), old = settings.schedules, base = collectionDefaults.schedules;
      const custom = !!value.definitions?.some(d => d.enabled !== false);
      value.schedules = { custom: old.seasonal ?? base.custom, all: old.collections ?? base.all, added: custom && old.added ? old.added : base.added };
      this.db.prepare('INSERT INTO artwork_collections VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify(value));
      const { seasonal: _, collections: __, ...kept } = old;
      this.db.prepare('UPDATE artwork_settings SET value=? WHERE id=1').run(JSON.stringify({ ...settings, schedules: kept }));
    })();
  }
  // The bundled layouts become the starting set. A database seeded with the earlier set has those replaced by the tk-*
  // layouts, and settings that named them point at their tk-* replacements; layouts made here are kept.
  private seed(file: string, now = Date.now()) {
    if ((this.state<number>('layouts:seed') ?? 0) >= SEED_VERSION) return;
    const seed = JSON.parse(readFileSync(file, 'utf8')) as { layouts: Record<string, Record<string, unknown>> };
    this.db.transaction(() => {
      const remove = this.db.prepare('DELETE FROM artwork_layouts WHERE name=?'), insert = this.db.prepare('INSERT OR REPLACE INTO artwork_layouts VALUES(?,1,?,?)');
      for (const name of Object.keys(RETIRED)) remove.run(name);
      for (const [name, value] of Object.entries(seed.layouts)) insert.run(name, JSON.stringify(value), now);
      const row = this.db.prepare('SELECT value FROM artwork_settings WHERE id=1').get() as { value: string } | undefined;
      if (row) {
        const value = JSON.parse(row.value) as Stored, move = (name: string) => RETIRED[name] ?? name;
        value.defaultLayout = move(value.defaultLayout);
        value.layoutByLibrary = Object.fromEntries(Object.entries(value.layoutByLibrary ?? {}).map(([id, name]) => [id, move(name)]));
        value.layoutByType = { ...defaults.layoutByType, ...Object.fromEntries(Object.entries(value.layoutByType ?? {}).map(([kind, name]) => [kind, move(name as string)])) };
        this.db.prepare('UPDATE artwork_settings SET value=? WHERE id=1').run(JSON.stringify(value));
      }
      this.setState('layouts:seed', SEED_VERSION);
    })();
  }
  private stored() {
    const row = this.db.prepare('SELECT revision,value FROM artwork_settings WHERE id=1').get() as { revision: number; value: string } | undefined;
    // Settings saved before a field existed read as its default.
    return { revision: row?.revision ?? 0, value: { ...defaults, keys: {}, ...(row ? JSON.parse(row.value) as Partial<Stored> : {}) } as Stored };
  }
  settings() {
    const { revision, value: { keys: _, schedules, ...settings } } = this.stored();
    return { revision, ...settings, schedules: { scrub: schedules.scrub ?? defaults.schedules.scrub, added: schedules.added ?? defaults.schedules.added } };
  }
  // What the Admin page shows: whether each key is saved, never the key itself.
  view() { const { keys } = this.stored().value; return { ...this.settings(), keysSet: Object.fromEntries(keyNames.map(k => [k, !!keys[k]])) as Record<typeof keyNames[number], boolean> }; }
  keys(): ArtworkKeys { const { keys } = this.stored().value; return Object.fromEntries(keyNames.flatMap(k => keys[k] ? [[k, this.vault.open(keys[k]!, `artwork:${k}-key`)]] : [])); }
  // `check` validates the settings with the layouts they name (the engine's own check) before anything is saved.
  async update(actor: string, expectedRevision: number, input: ArtworkSettingsInput, check: (settings: ArtworkSettings) => Promise<void>, now = Date.now()) {
    const { tmdbKey, tvdbKey, fanartKey, mdblistKey, ...settings } = artworkSettingsInput.parse(input);
    const names = new Set(this.layoutNames());
    for (const name of [settings.defaultLayout, ...Object.values(settings.layoutByLibrary), ...Object.values(settings.layoutByType)])
      if (!names.has(name)) throw new AppError('LAYOUT_NOT_FOUND', `There is no layout named ${name}.`, 422);
    await check(settings);
    return this.db.transaction(() => {
      const { revision, value } = this.stored();
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      const keys = { ...value.keys };
      for (const [name, given] of [['tmdb', tmdbKey], ['tvdb', tvdbKey], ['fanart', fanartKey], ['mdblist', mdblistKey]] as const) {
        if (given === undefined) continue;
        if (given) keys[name] = this.vault.seal(given, `artwork:${name}-key`); else delete keys[name];
      }
      this.db.prepare('INSERT INTO artwork_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify({ ...settings, keys }));
      this.audit(actor, 'artwork_settings_changed', { ...settings, keysSet: Object.keys(keys) }, now);
      return this.view();
    })();
  }
  private storedCollections() {
    const row = this.db.prepare('SELECT revision,value FROM artwork_collections WHERE id=1').get() as { revision: number; value: string } | undefined;
    const value = row ? JSON.parse(row.value) as ArtworkCollections & { radarrKey?: string } : { ...collectionDefaults };
    // Collections saved before an option existed read it as its default.
    value.franchise = { ...collectionDefaults.franchise, ...value.franchise };
    value.schedules ??= collectionDefaults.schedules;
    value.automatic ??= [];
    return { revision: row?.revision ?? 0, value };
  }
  collections() { const { revision, value: { radarrKey, ...value } } = this.storedCollections(); return { revision, ...value, radarrKeySet: !!radarrKey }; }
  // For the engine's config: the Radarr key opened, for the run's environment.
  collectionsConfig() { const { value: { radarrKey, ...value } } = this.storedCollections(); return { ...value, radarrKey: radarrKey ? this.vault.open(radarrKey, 'artwork:radarr-key') : undefined }; }
  async updateCollections(actor: string, input: z.input<typeof artworkCollectionsInput>, check: (value: ArtworkCollections & { radarrKey?: string }) => Promise<void>, now = Date.now()) {
    const { value, radarrKey, expectedRevision } = artworkCollectionsInput.parse(input);
    const current = this.collectionsConfig();
    await check({ ...value, radarrKey: radarrKey === undefined ? current.radarrKey : radarrKey || undefined });
    return this.db.transaction(() => {
      const { revision, value: stored } = this.storedCollections();
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Collections changed. Reload and retry.', 409);
      const sealed = radarrKey === undefined ? stored.radarrKey : radarrKey ? this.vault.seal(radarrKey, 'artwork:radarr-key') : undefined;
      this.db.prepare('INSERT INTO artwork_collections VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify({ ...value, ...(sealed ? { radarrKey: sealed } : {}) }));
      this.audit(actor, 'artwork_collections_changed', { definitions: value.definitions?.length ?? null, franchise: value.franchise, radarr: !!value.radarr.url, schedules: value.schedules }, now);
      return this.collections();
    })();
  }
  // Small values the schedules keep between runs.
  state<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM artwork_state WHERE key=?').get(key) as { value: string } | undefined; return row && JSON.parse(row.value) as T; }
  setState(key: string, value: unknown) { this.db.prepare('INSERT INTO artwork_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  layoutNames() { return (this.db.prepare('SELECT name FROM artwork_layouts ORDER BY name').all() as { name: string }[]).map(r => r.name); }
  layouts() {
    return Object.fromEntries((this.db.prepare('SELECT name,value FROM artwork_layouts ORDER BY name').all() as { name: string; value: string }[]).map(r => [r.name, JSON.parse(r.value) as Record<string, unknown>]));
  }
  layout(name: string) {
    const row = this.db.prepare('SELECT revision,value,updated_at FROM artwork_layouts WHERE name=?').get(name) as { revision: number; value: string; updated_at: number } | undefined;
    if (!row) throw new AppError('LAYOUT_NOT_FOUND', 'That layout does not exist.', 404);
    return { name, revision: row.revision, updatedAt: row.updated_at, value: JSON.parse(row.value) as Record<string, unknown> };
  }
  // expectedRevision 0 creates the layout; `check` runs the engine's validation with the change applied.
  async saveLayout(actor: string, name: string, expectedRevision: number, value: Record<string, unknown>, check: (layouts: Record<string, Record<string, unknown>>) => Promise<void>, now = Date.now()) {
    layoutName.parse(name); const valid = layoutValue.parse(value);
    await check({ ...this.layouts(), [name]: valid });
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT revision FROM artwork_layouts WHERE name=?').get(name) as { revision: number } | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) throw new AppError('REVISION_CONFLICT', expectedRevision ? 'Layout changed. Reload and retry.' : 'A layout with that name already exists.', 409);
      this.db.prepare('INSERT INTO artwork_layouts VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at')
        .run(name, expectedRevision + 1, JSON.stringify(valid), now);
      this.audit(actor, expectedRevision ? 'artwork_layout_changed' : 'artwork_layout_created', { name }, now);
      return this.layout(name);
    })();
  }
  removeLayout(actor: string, name: string, now = Date.now()) {
    const s = this.settings();
    if ([s.defaultLayout, ...Object.values(s.layoutByLibrary), ...Object.values(s.layoutByType)].includes(name)) throw new AppError('LAYOUT_IN_USE', 'Choose another layout where this one is used first.', 409);
    if (!this.db.prepare('DELETE FROM artwork_layouts WHERE name=?').run(name).changes) throw new AppError('LAYOUT_NOT_FOUND', 'That layout does not exist.', 404);
    this.audit(actor, 'artwork_layout_removed', { name }, now);
  }
  addJob(actor: string, label: string, args: string[], now = Date.now()) {
    return Number(this.db.prepare("INSERT INTO artwork_jobs(label,args,actor,status,created_at) VALUES(?,?,?,'queued',?)").run(label, JSON.stringify(args), actor, now).lastInsertRowid);
  }
  jobStarted(id: number, now = Date.now()) { this.db.prepare("UPDATE artwork_jobs SET status='running',started_at=? WHERE id=?").run(now, id); }
  jobFinished(id: number, status: Exclude<JobStatus, 'queued' | 'running'>, exitCode: number | null, output: string, now = Date.now()) {
    this.db.prepare('UPDATE artwork_jobs SET status=?,exit_code=?,output=?,finished_at=? WHERE id=?').run(status, exitCode, output, now, id);
  }
  // Jobs a restart interrupted never resume on their own.
  abandonJobs(now = Date.now()) { this.db.prepare("UPDATE artwork_jobs SET status='canceled',finished_at=?,output=output||? WHERE status IN ('queued','running')").run(now, '\n[tk.box restarted; this job was stopped]'); }
  // The latest jobs, or the latest of one engine's (the history is pruned to a few hundred, so filtering here is cheap).
  jobs(limit = 30, script?: JobRow['script']) {
    const rows = (this.db.prepare('SELECT id,label,args,actor,status,created_at,started_at,finished_at,exit_code FROM artwork_jobs ORDER BY id DESC LIMIT ?').all(script ? 1000 : limit) as Record<string, unknown>[]).map(job);
    return script ? rows.filter(r => r.script === script).slice(0, limit) : rows;
  }
  job(id: number) {
    const row = this.db.prepare('SELECT id,label,args,actor,status,created_at,started_at,finished_at,exit_code,output FROM artwork_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError('JOB_NOT_FOUND', 'That job does not exist.', 404);
    return { ...job(row), output: row.output as string };
  }
  // Keeps the history short; the output of old jobs is not worth the space.
  pruneJobs(keep = 200) { this.db.prepare('DELETE FROM artwork_jobs WHERE id NOT IN (SELECT id FROM artwork_jobs ORDER BY id DESC LIMIT ?)').run(keep); }
  private audit(actor: string, event: string, detail: unknown, now: number) { this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, event, now, JSON.stringify(detail)); }
}
// The collections engine's commands; every artwork engine job starts with an option (or has none).
const COLLECTION_COMMANDS = new Set(['all', 'custom', 'added']);
const job = (r: Record<string, unknown>): JobRow => {
  const args = JSON.parse(r.args as string) as string[];
  return { id: r.id as number, label: r.label as string, args, script: COLLECTION_COMMANDS.has(args[0] ?? '') ? 'collections' : 'artwork', actor: r.actor as string, status: r.status as JobStatus,
    createdAt: r.created_at as number, startedAt: r.started_at as number | null, finishedAt: r.finished_at as number | null, exitCode: r.exit_code as number | null };
};
