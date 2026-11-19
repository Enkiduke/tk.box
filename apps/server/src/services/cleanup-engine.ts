import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, readOnly } from '../errors.js';
import type { CleanupHold, CleanupKept, CleanupSettings, CleanupStore } from '../persistence/cleanup-store.js';
import type { PlexGrant } from '../providers/plex.js';
import { dueAt } from '../../../../packages/contracts/src/schedule.js';
import { WAITING } from './plex-background.js';
import { collectionKey } from './hidden-downloads.js';
import type { KeptCollections } from './artwork-engine.js';
import { every, errorDetail, type Repeating } from '../lib/every.js';
import type { CleanupRequest } from './requests.js';
import type { PlexIndex } from './plex-index.js';
import type { CleanupCollection, CleanupLevel, CleanupTitle, CleanupWatch } from './cleanup-rules.js';
import { runCleanup, type CleanupPlex } from './cleanup-run.js';
export type { CleanupCollection, CleanupTitle, CleanupWatch } from './cleanup-rules.js';

// Admin › Server › Clean Up, one job at a time. A run decides in TypeScript (services/cleanup-rules.ts) and acts with
// the owner's grant (services/cleanup-run.ts). The daily schedule waits while there is no working Plex admin token.
type Paths = { poster: string; dataDir: string };
// Each title the last finished run looked at (Clean Up › Status), written as status.json.
export type CleanupTitles = { updated: string | null; dryRun: boolean; complete: boolean; items: CleanupTitle[] };
type Running = { id: number; lines: string[]; dropped: number; canceled: boolean };
const MAX_LINES = 5000, SAVED_LINES = 2000, LATE_MS = 2 * 3600000, DAY = 86400000;
// Only titles still waiting on a date can be held; the rest are gone, protected or were never checked.
const waiting = new Set<CleanupTitle['status']>(['due', 'leaving', 'kept']);
const ruleDays: Record<string, keyof CleanupSettings> = { 'Rule 1': 'daysAfterWatched', 'Rule 2': 'daysAfterUnwatched', 'Rule 3': 'daysAfterAnyWatchExempt', 'Rule 4': 'daysAfterExemptWatch' };

// The last run's titles with today's holds: a title whose hold changed since that run is shown as the next run will
// see it. The others are left as that run found them.
export function withHolds(view: CleanupTitles, holds: Record<string, CleanupHold>, leavingDays: number, now = Date.now()): CleanupTitles {
  return { ...view, items: view.items.map(item => {
    const holdable = !!item.key && !!item.deletion_date && waiting.has(item.status);
    if (!holdable) return { ...item, holdable };
    const natural = Date.parse(item.deletion_date!), until = holds[item.key!]?.until, held = until !== undefined && until > natural ? until : null;
    const before = item.held_until ? Date.parse(item.held_until) : null;
    if (held === before) return { ...item, holdable };
    const at = held ?? natural;
    return { ...item, holdable, held_until: held === null ? null : new Date(held).toISOString(), status: at <= now ? 'due' : at <= now + leavingDays * DAY ? 'leaving' : 'kept' };
  }) };
}
// A hold key's title as a whole: a season's key names its show.
export const titleKey = (key: string) => key.split(':').slice(0, 2).join(':');
// Titles kept since the run the view is from show as protected, with their seasons; a later run sees the tag itself.
export function withKept(view: CleanupTitles, kept: Record<string, CleanupKept>): CleanupTitles {
  const since = view.updated ? Date.parse(view.updated) : 0;
  return { ...view, items: view.items.map(item => {
    const keep = item.key && waiting.has(item.status) ? kept[titleKey(item.key)] : undefined;
    return keep && keep.at > since ? { ...item, status: 'protected', reason: `Tagged ${keep.tag}`, holdable: false, held_until: null } : item;
  }) };
}
// Start over: the title's rule over again from today. Returns the date to hold it until.
export function holdUntil(item: CleanupTitle, settings: CleanupSettings, now = Date.now()) {
  const setting = item.rule ? ruleDays[item.rule] : undefined;
  if (!setting) throw new AppError('CLEANUP_NO_RULE', 'This title has no retention rule to start over.', 409);
  return now + (settings[setting] as number) * DAY;
}

// tk.box's own collections, by kind, so a run can tell which of a title's collections protect it. A custom
// collection with a Shown from–to range is seasonal; any collection not listed here is "other".
export function cleanupCollections(kept: KeptCollections['collections'], definitions: Record<string, unknown>[] | null): CleanupCollection[] {
  const seasonal = new Set((definitions ?? []).filter(d => d.schedule && typeof d.name === 'string' && typeof d.library === 'string').map(d => `${d.library as string}:${collectionKey(d.name as string)}`));
  return kept.map(({ name, library, kind }) => ({ name, library, kind: kind === 'custom' && seasonal.has(`${library}:${collectionKey(name)}`) ? 'seasonal' : kind }));
}

// Movies and shows are tk.box's own: a run deletes them from Plex only (tk.box then forgets them; a show whole or
// season by season), and a title is kept by the library's Keep (library_titles.keep). `kept` holds those movies' TMDB
// ids, `shows.kept` those shows'.
export type CleanupMovies = { kept: Set<number>; shows: { kept: Set<number> } };
// What has to be set before a run can start, in the words the page shows. The run checks it again.
export function cleanupMissing(settings: CleanupSettings) {
  const missing: string[] = [];
  if (!settings.movieLibraries.length && !settings.tvLibraries.length) missing.push('Choose at least one movie or TV library.');
  return missing;
}
// Log lines: local time, level, message.
const logLine = (level: CleanupLevel, message: string, at = new Date()) => `${[at.getHours(), at.getMinutes(), at.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')} ${level} ${message}`;

export class CleanupEngine {
  private queue: { id: number; args: string[]; token: string }[] = [];
  private current?: Running;
  private timer?: Repeating;
  private ticking = false;
  readonly workDir: string;
  // Called after each job that ran: it may have removed titles or changed their posters in Plex.
  finished?: () => void;
  // tk.box's own collections, read as each run starts.
  collections: () => CleanupCollection[] = () => [];
  // tk.box's requests on the server, read as each run starts.
  requests: () => Promise<CleanupRequest[]> = async () => [];
  // Told the whole titles a real run deleted, so their requests are removed, and the seasons it deleted (tk.box's
  // shows: the library forgets them).
  deleted?: (titles: { kind: 'movie' | 'show'; tmdb: number }[], seasons: { tmdb: number; season: number }[]) => void;
  // Movies and shows are kept by the library's own flag (`keep` returns false when the library doesn't have the title).
  movies: () => CleanupMovies & { keep(tmdbId: number, kind?: 'movie' | 'show'): boolean } = () => ({ kept: new Set(), shows: { kept: new Set() }, keep: () => false });
  // This Plex server's id, and its watches (watch history's, the saved dates included), read as each run starts.
  serverId: () => string | undefined = () => undefined;
  watches: (serverId: string) => CleanupWatch[] = () => [];
  // A run's title identity and Plex calls (the plex-index module's index, the Plex adapter).
  plexIndex?: Pick<PlexIndex, 'resolve' | 'copy'>;
  plex?: CleanupPlex;
  constructor(private store: CleanupStore, readonly paths: Paths, private adminGrant: () => Promise<PlexGrant | undefined>,
    private log: (message: string, detail: Record<string, unknown>) => void = () => {}) {
    this.workDir = join(paths.dataDir, 'cleanup');
    store.abandonJobs();
  }
  // Watch history is kept per Plex server, so a run needs this one's id.
  missing() {
    const missing = cleanupMissing(this.store.settings());
    if (!this.serverId()) missing.push('Set PLEX_MACHINE_ID: watch history is kept per Plex server.');
    return missing;
  }
  // Ready to run unless the Plex index or the owner's grant is missing.
  async status(): Promise<{ ready: boolean; error?: string }> {
    if (!this.plexIndex || !this.plex) return { ready: false, error: 'Clean Up has no Plex index.' };
    if (!await this.adminGrant().catch(() => undefined)) return { ready: false, error: 'No Plex admin token in Admin › Connections.' };
    return { ready: true };
  }
  // A preview always runs with --dry-run; a run follows the Preview only setting.
  enqueue(actor: string, preview: boolean, token: string, scheduled = false) {
    const dry = preview || this.store.settings().dryRun;
    const label = `${scheduled ? 'Scheduled: ' : ''}${dry ? 'Preview: what would be deleted' : 'Clean up: delete what is due'}`, args = preview ? ['--dry-run'] : [];
    const missing = this.missing();
    if (missing.length) throw new AppError('CLEANUP_NOT_READY', missing[0]!, 409);
    if (this.pending()) throw new AppError('CLEANUP_BUSY', 'A clean up is already running or waiting.', 409);
    const id = this.store.addJob(actor, label, args);
    this.queue.push({ id, args, token }); void this.next();
    return this.store.job(id);
  }
  pending() { return !!this.current || this.queue.length > 0; }
  cancel(id: number) {
    const waiting = this.queue.findIndex(j => j.id === id);
    if (waiting >= 0) { this.queue.splice(waiting, 1); this.store.jobFinished(id, 'canceled', null, 'Canceled before it started.'); return; }
    if (this.current?.id !== id) throw new AppError('JOB_NOT_RUNNING', 'That job has already finished.', 409);
    this.current.canceled = true;
  }
  // A job's state, with the running job's output from line `since` on (line numbers keep counting as old lines drop).
  job(id: number, since = 0) {
    const job = this.store.job(id), live = this.current?.id === id ? this.current : undefined;
    if (!live) { const lines = job.output ? job.output.split('\n') : []; return { ...job, output: undefined, lines: lines.slice(since), next: lines.length }; }
    const from = Math.max(since - live.dropped, 0);
    return { ...job, output: undefined, lines: live.lines.slice(from), next: live.dropped + live.lines.length };
  }
  titles(): CleanupTitles { return withKept(withHolds(this.lastRun(), this.store.holds(), this.store.settings().leavingSoon.days), this.store.kept()); }
  // Keep: a movie, or the whole show (from any of its seasons), by the library's own Keep.
  async keep(actor: string, key: string) {
    const item = this.titles().items.find(i => i.key === key);
    if (!item?.key || !waiting.has(item.status)) throw new AppError('CLEANUP_NOT_KEEPABLE', 'Only titles waiting to leave can be kept. Run a preview to refresh the list.', 409);
    const movies = this.movies(), [wholeKind, wholeId] = titleKey(item.key).split(':');
    if (wholeKind === 'movie') {
      if (!movies.keep(Number(wholeId))) throw new AppError('CLEANUP_NOT_IN_LIBRARY', 'tk.box’s library doesn’t have this movie, so it can’t be kept there.', 409);
      this.store.setKept(actor, titleKey(item.key), 'Keep');
      return { tag: 'Keep', ...this.titles() };
    }
    if (!movies.keep(Number(wholeId), 'show')) throw new AppError('CLEANUP_NOT_IN_LIBRARY', 'tk.box’s library doesn’t have this show, so it can’t be kept there.', 409);
    this.store.setKept(actor, titleKey(item.key), 'Keep');
    return { tag: 'Keep', ...this.titles() };
  }
  // Holds take effect at the next run; a run already going keeps the holds it started with.
  hold(actor: string, key: string, action: { action: 'reset' } | { action: 'clear' }) {
    const item = this.titles().items.find(i => i.key === key);
    if (!item?.holdable) throw new AppError('CLEANUP_NOT_HOLDABLE', 'Only titles waiting to leave can be started over. Run a preview to refresh the list.', 409);
    this.store.setHold(actor, key, action.action === 'clear' ? null : holdUntil(item, this.store.settings()));
    return this.titles();
  }
  private reportDeleted(since: number) {
    const run = this.lastRun();
    if (run.dryRun || !run.updated || Date.parse(run.updated) < since) return;
    const titles = run.items.flatMap(i => i.status === 'deleted' && i.kind !== 'season' && i.key && /^(movie|tv):\d+$/.test(i.key)
      ? [{ kind: i.key.startsWith('movie:') ? 'movie' as const : 'show' as const, tmdb: Number(i.key.split(':')[1]) }] : []);
    const seasons = run.items.flatMap(i => i.status === 'deleted' && i.kind === 'season' && i.key && /^tv:\d+:\d+$/.test(i.key)
      ? [{ tmdb: Number(i.key.split(':')[1]), season: Number(i.key.split(':')[2]) }] : []);
    if (titles.length || seasons.length) try { this.deleted?.(titles, seasons); } catch (e) { this.log('clean up: could not mark requests removed', errorDetail(e)); }
  }
  private lastRun(name = 'status.json'): CleanupTitles {
    try {
      const file = JSON.parse(readFileSync(join(this.workDir, name), 'utf8')) as { updated?: unknown; dry_run?: unknown; complete?: unknown; items?: unknown };
      return { updated: typeof file.updated === 'string' ? file.updated : null, dryRun: file.dry_run !== false, complete: file.complete !== false, items: Array.isArray(file.items) ? file.items as CleanupTitle[] : [] };
    } catch { return { updated: null, dryRun: true, complete: true, items: [] }; }
  }
  scheduleState() { return this.store.state<{ lastRun?: number; note?: string }>('schedule') ?? {}; }
  // The scheduled run, now (Admin › Schedule): it counts as the schedule's last run.
  runNow(actor: string, token: string) {
    const job = this.enqueue(actor, false, token);
    this.store.setState('schedule', { lastRun: Date.now(), note: 'Queued.' });
    return job;
  }
  start() { this.timer = every(60000, () => this.tick(), e => this.log('clean up schedule failed', errorDetail(e))); }
  close() { this.timer?.stop(); this.queue = []; if (this.current) this.current.canceled = true; }
  // On its schedule (server local time), or up to two hours late if tk.box was down then.
  async tick(now = new Date()) {
    if (this.ticking) return; this.ticking = true;
    try {
      const { schedule } = this.store.settings();
      if (!schedule.enabled) return;
      if (dueAt(schedule.schedule, this.scheduleState().lastRun, now.getTime(), LATE_MS) === undefined) return;
      const grant = await this.adminGrant().catch(() => undefined);
      if (!grant) { this.store.setState('schedule', { ...this.scheduleState(), note: WAITING }); return; }
      let note = 'Queued.';
      try { this.enqueue('system:schedule', false, grant.serverToken, true); } catch (e) { note = `Skipped: ${(e as Error).message}`; }
      this.store.setState('schedule', { lastRun: now.getTime(), note });
    } catch (e) { this.log('clean up schedule failed', { error: (e as Error).message }); }
    finally { this.ticking = false; }
  }
  private async next() {
    if (this.current) return;
    const job = this.queue.shift(); if (!job) return;
    const settings = this.store.settings();
    const running: Running = this.current = { id: job.id, lines: [], dropped: 0, canceled: false };
    const say = (line: string) => { running.lines.push(line); if (running.lines.length > MAX_LINES) { running.lines.splice(0, 1000); running.dropped += 1000; } };
    const preview = job.args.includes('--dry-run'), dryRun = preview || settings.dryRun || readOnly();
    let code: number | null = null, wrote = false;
    const started = Date.now();
    try {
      this.store.jobStarted(job.id);
      const engine = await this.status();
      if (!engine.ready) throw new Error(engine.error);
      const requests = await this.requests();
      if (!running.canceled) ({ code, wrote } = await this.runTypescript(running, settings, requests, preview, dryRun, say));
    } catch (e) { say(`ERROR: ${(e as Error).message}`); }
    const status = running.canceled ? 'canceled' : code === 0 ? 'succeeded' : 'failed';
    if (running.canceled) say('Canceled.');
    this.store.jobFinished(job.id, status, code, running.lines.slice(-SAVED_LINES).join('\n'));
    this.log('clean up job finished', { jobId: job.id, status, code });
    // Even a failed run may have deleted some titles first; the status file lists those it did. One left from an
    // earlier run (this one stopped before writing its own) is not read. A run writes its file even when canceled,
    // listing only what it did delete.
    if ((wrote || !running.canceled) && !dryRun) this.reportDeleted(started);
    this.current = undefined; this.store.pruneJobs(); this.finished?.(); void this.next();
  }
  // A run, with the owner's grant. Writes status.json (`wrote`) once it has decided.
  private async runTypescript(running: Running, settings: CleanupSettings, requests: CleanupRequest[], preview: boolean, dryRun: boolean, say: (line: string) => void) {
    say(`> clean up${preview ? ' --dry-run' : dryRun ? ' (Preview only)' : ''}`);
    if (!requests.length) say('No requested titles on Plex in tk.box. Check Admin › Requests for the request inventory.');
    const serverId = this.serverId(), grant = await this.adminGrant().catch(() => undefined);
    if (!serverId) throw new Error('Set PLEX_MACHINE_ID: watch history is kept per Plex server.');
    if (!grant) throw new Error('No Plex admin token in Admin › Connections.');
    if (!this.plexIndex || !this.plex) throw new Error('Clean Up has no Plex index.');
    const holds = Object.fromEntries(Object.entries(this.store.holds()).map(([key, hold]) => [key, hold.until]));
    const { kept, shows } = this.movies();
    const result = await runCleanup({ requests: async () => requests, index: this.plexIndex, watches: id => this.watches(id),
      kept: kind => kind === 'movie' ? kept : shows.kept, collections: () => this.collections(), holds },
    { settings, dryRun, serverId, grant, plex: this.plex, ...(settings.leavingSoon.poster ? { poster: this.paths.poster } : {}),
      say: (level, message) => say(logLine(level, message)), canceled: () => running.canceled });
    this.writeStatus('status.json', { dry_run: dryRun, complete: result.plan.complete, items: result.items });
    return { code: result.code, wrote: true };
  }
  private writeStatus(name: string, data: { dry_run: boolean; complete: boolean; items: CleanupTitle[] }) {
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    const file = join(this.workDir, name), temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temporary, JSON.stringify({ updated: new Date().toISOString(), ...data }), { mode: 0o600 });
    renameSync(temporary, file);
  }
}
