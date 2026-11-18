import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AppError } from '../errors.js';
import type { CleanupHold, CleanupKept, CleanupSettings, CleanupStore } from '../persistence/cleanup-store.js';
import type { PlexGrant } from '../providers/plex.js';
import { dueAt } from '../../../../packages/contracts/src/schedule.js';
import { WAITING } from './plex-background.js';
import { collectionKey } from './hidden-downloads.js';
import type { KeptCollections } from './artwork-engine.js';
import { every, errorDetail, type Repeating } from '../lib/every.js';
import type { CleanupRequest } from './requests.js';

// Admin › Server › Clean Up: runs the purge script (apps/cleanup/purge_requests.py) as its own Python process, one job at
// a time. tk.box writes the script's JSON config from its settings and passes the Plex token in the
// environment for that run only; they are redacted from the job output. The daily schedule reads Plex with the Plex
// admin token, like Artwork's, and waits while there is no working one.
type Paths = { python: string; script: string; poster: string; dataDir: string; plexUrl: string };
// Each title the last finished run looked at (Clean Up › Status); the script writes it with --status. `deletion_date` is
// the rule's own date and `held_until` a later one an administrator's hold keeps it until. `key` names its hold and
// `rating_key` its Plex item, for the poster.
export type CleanupTitle = { title: string; year: number | null; kind: 'movie' | 'show' | 'season'; library: string; status: 'due' | 'deleted' | 'leaving' | 'kept' | 'protected' | 'not_found' | 'error';
  rule: string | null; reason: string; deletion_date: string | null; held_until?: string | null; key?: string | null; rating_key?: string | null; show_rating_key?: string | null; holdable?: boolean };
export type CleanupTitles = { updated: string | null; dryRun: boolean; complete: boolean; items: CleanupTitle[] };
type Running = { id: number; child?: ChildProcess; lines: string[]; dropped: number; canceled: boolean; secrets: string[] };
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

// tk.box's own collections, by kind, so the script can tell which of a title's collections protect it. A custom
// collection with a Shown from–to range is seasonal; any collection not listed here is "other".
export type CleanupCollection = { name: string; library: string; kind: 'franchise' | 'streaming' | 'custom' | 'seasonal' };
export function cleanupCollections(kept: KeptCollections['collections'], definitions: Record<string, unknown>[] | null): CleanupCollection[] {
  const seasonal = new Set((definitions ?? []).filter(d => d.schedule && typeof d.name === 'string' && typeof d.library === 'string').map(d => `${d.library as string}:${collectionKey(d.name as string)}`));
  return kept.map(({ name, library, kind }) => ({ name, library, kind: kind === 'custom' && seasonal.has(`${library}:${collectionKey(name)}`) ? 'seasonal' : kind }));
}

// A watch date, by scope and Plex rating key; account is a Plex account id, or '' for anyone (watch history's `watches`).
export type CleanupWatch = { scope: 'movie' | 'show' | 'season'; ratingKey: string; account: string; at: number };
// Each movie's, show's and season's latest watch by anyone and by each of `users` (Plex account ids), from watch
// history (tk.box's own and the saved dates, account '' is anyone), the later of each.
type WatchScope = CleanupWatch['scope'];
export type CleanupWatches = { server_id: string } & Record<WatchScope, Record<string, { any: string; users: Record<string, string> }>>;
export function cleanupWatches(serverId: string, rows: CleanupWatch[], users: Set<string>): CleanupWatches {
  const latest: Record<WatchScope, Record<string, { any: number; users: Record<string, number> }>> = { movie: {}, show: {}, season: {} };
  for (const { scope, ratingKey, account, at } of rows) {
    const entry = latest[scope][ratingKey] ??= { any: at, users: {} };
    entry.any = Math.max(entry.any, at);
    if (account && users.has(account)) entry.users[account] = Math.max(entry.users[account] ?? at, at);
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const out = (scope: WatchScope) => Object.fromEntries(Object.entries(latest[scope]).map(([key, e]) =>
    [key, { any: iso(e.any), users: Object.fromEntries(Object.entries(e.users).map(([user, at]) => [user, iso(at)])) }]));
  return { server_id: serverId, movie: out('movie'), show: out('show'), season: out('season') };
}
// Movies and shows are tk.box's own: a run deletes them from Plex only (tk.box then forgets them; a show whole or
// season by season), and a title is kept by the library's Keep (library_titles.keep), sent as each of its requests'
// `keep`. `kept` holds those movies' TMDB ids, `shows.kept` those shows'.
export type CleanupMovies = { kept: Set<number>; shows: { kept: Set<number> } };
// The script's config: everything but the keys, which it reads from the environment.
export function cleanupConfig(settings: CleanupSettings, paths: Pick<Paths, 'plexUrl' | 'poster'>, holds: Record<string, CleanupHold> = {}, collections: CleanupCollection[] = [], requests: CleanupRequest[] = [], watches?: CleanupWatches,
  movies: CleanupMovies = { kept: new Set(), shows: { kept: new Set() } }) {
  return {
    plex: { url: paths.plexUrl },
    movie_libraries: settings.movieLibraries, tv_libraries: settings.tvLibraries, dry_run: settings.dryRun,
    days_after_watched: settings.daysAfterWatched, days_after_unwatched: settings.daysAfterUnwatched,
    days_after_any_watch_exempt: settings.daysAfterAnyWatchExempt, days_after_exempt_watch: settings.daysAfterExemptWatch,
    exempt_user_ids: settings.exemptUserIds, exempt_if_in_collection: settings.exemptIfInCollection,
    protecting_collection_kinds: Object.entries(settings.collectionKinds).filter(([, on]) => on).map(([kind]) => kind), tkbox_collections: collections,
    enable_season_retention: settings.seasons.enabled, protect_latest_season: settings.seasons.protectLatest, protect_specials_season: settings.seasons.protectSpecials,
    create_leaving_soon_collection: settings.leavingSoon.enabled, leaving_soon_name: settings.leavingSoon.name, leaving_soon_days: settings.leavingSoon.days,
    leaving_soon_poster: settings.leavingSoon.poster ? paths.poster : '', http_timeout_seconds: 30,
    holds: Object.fromEntries(Object.entries(holds).map(([key, hold]) => [key, new Date(hold.until).toISOString()])),
    // The titles a run looks at: tk.box's requests now on the server.
    requests: requests.map(r => (r.kind === 'movie' ? movies.kept : movies.shows.kept).has(r.tmdb) ? { ...r, keep: true } : r),
    // Each title's latest watches; the script refuses to run without them.
    ...(watches ? { watches } : {})
  };
}
// What has to be set before a run can start, in the words the page shows. The script checks it again.
export function cleanupMissing(settings: CleanupSettings) {
  const missing: string[] = [];
  if (!settings.movieLibraries.length && !settings.tvLibraries.length) missing.push('Choose at least one movie or TV library.');
  return missing;
}
// Only what Python needs, plus this run's credentials; never the server's own environment.
function childEnv(secrets: Record<string, string | undefined> = {}) {
  const pass = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'VIRTUAL_ENV', 'TKBOX_READ_ONLY'];
  const env: NodeJS.ProcessEnv = Object.fromEntries(pass.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' });
  for (const [name, value] of Object.entries(secrets)) if (value) env[name] = value;
  return env;
}
const redact = (line: string, secrets: string[]) => secrets.reduce((text, secret) => secret.length >= 6 ? text.replaceAll(secret, '•••') : text, line);

export class CleanupEngine {
  private queue: { id: number; args: string[]; token: string }[] = [];
  private current?: Running;
  private known?: { at: number; ready: boolean; version?: string; error?: string };
  private checking?: Promise<NonNullable<CleanupEngine['known']>>;
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
  // Whether Python and the script's packages are installed. Asked again at most once a minute unless forced.
  status(force = false) {
    if (!force && this.known && Date.now() - this.known.at < 60000) return Promise.resolve(this.known);
    this.checking ??= this.capture(['-c', 'import sys, plexapi, requests; print(sys.version.split()[0])'], 20000)
      .then(r => ({ at: Date.now(), ready: r.code === 0, ...(r.code === 0 ? { version: r.output.trim() } : { error: r.output.trim().split('\n').at(-1) || 'Python could not be started.' }) }))
      .then(known => { this.known = known; return known; }).finally(() => { this.checking = undefined; });
    return this.checking;
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
    this.current.canceled = true; this.current.child?.kill();
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
  private lastRun(): CleanupTitles {
    try {
      const file = JSON.parse(readFileSync(join(this.workDir, 'status.json'), 'utf8')) as { updated?: unknown; dry_run?: unknown; complete?: unknown; items?: unknown };
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
  close() { this.timer?.stop(); this.queue = []; if (this.current) { this.current.canceled = true; this.current.child?.kill(); } }
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
    const secrets = { PLEX_TOKEN: job.token };
    const running: Running = this.current = { id: job.id, lines: [], dropped: 0, canceled: false, secrets: Object.values(secrets).filter((v): v is string => !!v) };
    const say = (line: string) => { running.lines.push(redact(line, running.secrets)); if (running.lines.length > MAX_LINES) { running.lines.splice(0, 1000); running.dropped += 1000; } };
    let code: number | null = null;
    const started = Date.now();
    try {
      this.store.jobStarted(job.id);
      const engine = await this.status();
      if (!engine.ready) throw new Error(`The clean up script is not set up: ${engine.error}`);
      const requests = await this.requests();
      const file = this.writeConfig(settings, requests);
      say(`> purge_requests ${job.args.join(' ')}`.trim());
      if (!requests.length) say('No requested titles on Plex in tk.box. Check Admin › Requests for the request inventory.');
      const child = running.child = spawn(this.paths.python, [this.paths.script, file, '--status', join(this.workDir, 'status.json'), ...job.args], { cwd: this.workDir, env: childEnv(secrets), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream, crlfDelay: Infinity }).on('line', say);
      code = await done;
    } catch (e) { say(`ERROR: ${(e as Error).message}`); }
    const status = running.canceled ? 'canceled' : code === 0 ? 'succeeded' : 'failed';
    if (running.canceled) say('Canceled.');
    this.store.jobFinished(job.id, status, code, running.lines.slice(-SAVED_LINES).join('\n'));
    this.log('clean up job finished', { jobId: job.id, status, code });
    // Even a failed run may have deleted some titles first; the status file lists those it did. One left from an
    // earlier run (this one stopped before writing its own) is not read.
    if (!running.canceled && !job.args.includes('--dry-run') && !settings.dryRun) this.reportDeleted(started);
    this.current = undefined; this.store.pruneJobs(); this.finished?.(); void this.next();
  }
  // Written whole and then moved into place, so the script never reads a half-written config.
  private writeConfig(settings: CleanupSettings, requests: CleanupRequest[]) {
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    const file = join(this.workDir, 'config.json'), temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    const serverId = this.serverId();
    const users = new Set([...settings.exemptUserIds, ...requests.flatMap(r => r.requester_plex_id === null ? [] : [r.requester_plex_id])].map(String));
    const watches = serverId ? cleanupWatches(serverId, this.watches(serverId), users) : undefined;
    const { kept, shows } = this.movies();
    writeFileSync(temporary, JSON.stringify(cleanupConfig(settings, this.paths, this.store.holds(), this.collections(), requests, watches, { kept, shows }), null, 2), { mode: 0o600 });
    renameSync(temporary, file);
    return file;
  }
  private capture(args: string[], timeoutMs: number) {
    return new Promise<{ code: number | null; output: string }>(resolve => {
      let output = '';
      const child = spawn(this.paths.python, args, { cwd: this.paths.dataDir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
      const add = (chunk: Buffer) => { if (output.length < 65536) output += chunk.toString('utf8'); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      child.once('error', e => resolve({ code: null, output: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${this.paths.python} was not found. Set PYTHON_PATH.` : e.message }));
      child.once('close', code => resolve({ code, output }));
    });
  }
}
