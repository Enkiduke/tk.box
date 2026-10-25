import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AppError } from '../errors.js';
import type { ArtworkCollections, ArtworkKeys, ArtworkSettings, ArtworkStore } from '../persistence/artwork-store.js';

// Runs the artwork engine (apps/artwork/overlayrr.py) and the collections engine (apps/artwork/plex_collections.py) as
// their own Python processes: tk.box writes their shared JSON config from the database, passes credentials in the
// environment, and streams the output into the job history. The rendering happens entirely in those processes (which
// lower their own CPU priority), so the server's event loop and the streaming paths never do image work. One job runs
// at a time, whichever script it is; the rest wait in order.
export type ArtworkLibrary = { key: string; title: string; type: string };
export type ArtworkRun = { token: string; libraries: ArtworkLibrary[] };
type Paths = { python: string; script: string; collectionsScript: string; dataDir: string; cacheDir: string; plexUrl: string };
export type EngineScript = 'artwork' | 'collections';
// What the last applying collections run kept: every franchise and streaming collection that qualifies (off: turned off
// in tk.box, so not in Plex) and every custom one that's on, with its Plex ID once it's in Plex.
export type KeptCollections = { updated: string | null; collections: { name: string; library: string; kind: 'franchise' | 'streaming' | 'custom'; items: number; rating_key?: string; off?: boolean }[] };
type Running = { id: number; child?: ChildProcess; lines: string[]; dropped: number; canceled: boolean; secrets: string[] };
type Inputs = { settings: ArtworkSettings; layouts: Record<string, Record<string, unknown>>; collections?: ArtworkCollections };
const MAX_LINES = 5000, SAVED_LINES = 2000;

// The engine's config for one run. Library titles come from the signed-in administrator's view of Plex, because the
// engine matches its per-library layouts by title. Credentials are never written into it.
export function artworkConfig(settings: ArtworkSettings, layouts: Record<string, Record<string, unknown>>, libraries: ArtworkLibrary[], paths: Pick<Paths, 'plexUrl' | 'cacheDir'>, collections?: ArtworkCollections) {
  const title = (id: string) => libraries.find(l => l.key === id)?.title, f = collections?.franchise, radarr = collections?.radarr;
  return {
    plex: { url: paths.plexUrl, libraries: settings.libraries, upload: settings.upload, upload_logo: settings.uploadLogo, include_seasons: settings.includeSeasons,
      include_episodes: settings.includeEpisodes, include_collections: settings.includeCollections, completion_label: settings.completionLabel,
      ...(f ? { sync_collections: f.sync, franchise_collections: f.franchises, collection_min_items: f.minItems, collection_sync: f.mode, collection_streaming: f.streaming, collection_region: f.region,
        recent_collections: f.recent, recent_movie_days: f.recentMovieDays, recent_episode_days: f.recentEpisodeDays } : {}) },
    assets_dir: 'assets', cache_dir: paths.cacheDir, workers: settings.workers, quality: settings.quality, language: settings.language,
    missing_art: settings.missingArt, overlay_marker: true, default_layout: settings.defaultLayout,
    layout_by_library: Object.fromEntries(Object.entries(settings.layoutByLibrary).flatMap(([id, layout]) => { const name = title(id); return name ? [[name, layout]] : []; })),
    ...(Object.keys(settings.layoutByType).length ? { layout_by_type: settings.layoutByType } : {}),
    layouts,
    ...(collections?.definitions ? { collections: collections.definitions } : {}),
    ...(collections?.automatic?.length ? { automatic_collections: collections.automatic } : {}),
    // The key itself arrives in the environment; the engine reads ${RADARR_API_KEY} from there.
    ...(radarr?.url ? { radarr: { url: radarr.url, api_key: '${RADARR_API_KEY}', root_folder: radarr.rootFolder, search: radarr.search,
      ...(radarr.qualityProfileId ? { quality_profile_id: radarr.qualityProfileId } : {}) } } : {})
  };
}
export type EngineSecrets = ArtworkKeys & { radarr?: string; traktClientId?: string };
// Only what Python needs, plus the credentials for this run; never the server's own environment.
export function childEnv(run: ArtworkRun | undefined, keys: EngineSecrets) {
  const pass = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'VIRTUAL_ENV'];
  const env: NodeJS.ProcessEnv = Object.fromEntries(pass.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' });
  if (run) env.PLEX_TOKEN = run.token;
  for (const [name, variable] of [['tmdb', 'TMDB_API_KEY'], ['tvdb', 'TVDB_API_KEY'], ['fanart', 'FANART_API_KEY'], ['mdblist', 'MDBLIST_API_KEY'],
    ['radarr', 'RADARR_API_KEY'], ['traktClientId', 'TRAKT_CLIENT_ID']] as const) if (keys[name]) env[variable] = keys[name];
  return env;
}
const redact = (line: string, secrets: string[]) => secrets.reduce((text, secret) => secret.length >= 6 ? text.replaceAll(secret, '•••') : text, line);

export class ArtworkEngine {
  private queue: { id: number; script: EngineScript; args: string[]; run: ArtworkRun; done?: () => void }[] = [];
  private current?: Running & { script: EngineScript; args: string[] };
  private known?: { at: number; ready: boolean; version?: string; error?: string };
  private checking?: Promise<NonNullable<ArtworkEngine['known']>>;
  readonly workDir: string;
  // Called after each job that ran, whatever its outcome: even a failed or canceled one may have changed some art in Plex.
  finished?: () => void;
  // `traktClientId` is Explore's Trakt app, which the collection providers can also use.
  constructor(private store: ArtworkStore, readonly paths: Paths, private log: (message: string, detail: Record<string, unknown>) => void = () => {}, private traktClientId: () => string | undefined = () => undefined) {
    this.workDir = join(paths.dataDir, 'artwork');
    store.abandonJobs();
  }
  secrets(): EngineSecrets { const radarr = this.store.collectionsConfig().radarrKey, trakt = this.traktClientId(); return { ...this.store.keys(), ...(radarr ? { radarr } : {}), ...(trakt ? { traktClientId: trakt } : {}) }; }
  // Whether Python and the engine's packages are installed. Asked again at most once a minute unless forced.
  status(force = false) {
    if (!force && this.known && Date.now() - this.known.at < 60000) return Promise.resolve(this.known);
    this.checking ??= this.capture(['-c', 'import sys, PIL, numpy, requests, yaml; print(sys.version.split()[0])'], 20000)
      .then(r => ({ at: Date.now(), ready: r.code === 0, ...(r.code === 0 ? { version: r.output.trim() } : { error: r.output.trim().split('\n').at(-1) || 'Python could not be started.' }) }))
      .then(known => { this.known = known; return known; }).finally(() => { this.checking = undefined; });
    return this.checking;
  }
  // Both engines' own validation of what is about to be saved (on top of what is saved now). Until Python is set up only
  // the database's own checks apply (settings can be saved first); the engines check everything again when a job runs.
  async check(changes: Partial<Inputs>, libraries: ArtworkLibrary[]) {
    if (!(await this.status()).ready) return;
    const file = this.writeConfig(libraries, `check-${randomUUID()}.json`, changes);
    try {
      const results = await Promise.all([[this.paths.script, file, '--check'], [this.paths.collectionsScript, file, 'check']].map(args => this.capture(args, 30000)));
      const failed = results.find(r => r.code !== 0);
      if (failed) throw new AppError('ARTWORK_CONFIG_INVALID', failed.output.trim().replace(/^ERROR:\s*/m, '').split('\n').at(-1) || 'The artwork engine rejected these settings.', 422);
    } finally { rmSync(file, { force: true }); }
  }
  // `done` runs once the job succeeds (a push clears its title's "not pushed" mark with it). An artwork run over every
  // title, or one for a newly added title, has the collections engine go first when there is collection work for it, so
  // collections made now get their posters in the same pass.
  enqueue(actor: string, label: string, args: string[], run: ArtworkRun, options: { done?: () => void; script?: EngineScript } = {}) {
    const script = options.script ?? 'artwork';
    if (script === 'artwork') for (const before of this.collectionsFirst(args)) if (!this.pending(before.args, 'collections')) this.add(actor, before.label, before.args, run, 'collections');
    return this.add(actor, label, args, run, script, options.done);
  }
  // Whether a job with these arguments is waiting or running, so a schedule never queues the same work twice.
  pending(args: string[], script: EngineScript = 'artwork') {
    const same = (job: { script: EngineScript; args: string[] }) => job.script === script && job.args.join('\0') === args.join('\0');
    return (!!this.current && same(this.current)) || this.queue.some(same);
  }
  // A Discover request or the seasonal presets: a short collections-engine run with this run's credentials, JSON in and out.
  async collections<T>(run: ArtworkRun, command: 'discover' | 'defaults', input: Record<string, unknown> = {}): Promise<T> {
    const engine = await this.status();
    if (!engine.ready) throw new AppError('ARTWORK_ENGINE_UNAVAILABLE', `The artwork engine is not set up: ${engine.error}`, 503);
    const file = this.writeConfig(run.libraries, 'config.json');
    const result = await this.capture([this.paths.collectionsScript, file, command], 90000, { env: childEnv(run, this.secrets()), cwd: this.workDir, input: JSON.stringify(input) });
    if (result.code !== 0) throw new AppError('ARTWORK_REQUEST_FAILED', result.errors.trim().replace(/^ERROR:\s*/m, '').split('\n').at(-1) || 'The collections engine could not answer.', 422);
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as T;
  }
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
  busy() { return this.current ? { running: this.current.id, queued: this.queue.length } : { running: null, queued: this.queue.length }; }
  close() { this.queue = []; if (this.current) { this.current.canceled = true; this.current.child?.kill(); } }
  private add(actor: string, label: string, args: string[], run: ArtworkRun, script: EngineScript, done?: () => void) {
    const id = this.store.addJob(actor, label, args);
    this.queue.push({ id, script, args, run, ...(done ? { done } : {}) }); void this.next();
    return this.store.job(id);
  }
  // The collections job an artwork job needs first, when results go to Plex: every collection before a run over every
  // title, when franchise collections are kept in sync. Newly added titles join their collections on the collections'
  // own schedule.
  private collectionsFirst(args: string[]): { label: string; args: string[] }[] {
    if (!this.store.settings().upload || args.includes('--item')) return [];
    return this.store.collectionsConfig().franchise.sync ? [{ label: 'Every collection: apply', args: ['all', 'apply'] }] : [];
  }
  // A poster for each collection a collections run just made, so it doesn't wait for the next artwork run. Only when
  // Collection posters is on, and not when an artwork run over every title is already queued (it makes them anyway).
  private postersFor(created: { name: string; key: string }[], from: number, run: ArtworkRun) {
    if (!created.length || !this.store.settings().includeCollections || this.queue.some(j => j.script === 'artwork' && !j.args.includes('--item'))) return;
    const actor = this.store.job(from).actor;
    for (const { name, key } of created) {
      const args = ['--item', key, '--changed-only'];
      if (!this.pending(args)) this.add(actor, `Poster for new collection: ${name}`, args, run, 'artwork');
    }
  }
  // The collections the last applying run kept (the collections engine writes this file).
  keptCollections(): KeptCollections {
    try {
      const file = JSON.parse(readFileSync(join(this.workDir, 'kept_collections.json'), 'utf8')) as Partial<KeptCollections>;
      return { updated: typeof file.updated === 'string' ? file.updated : null, collections: Array.isArray(file.collections) ? file.collections : [] };
    } catch { return { updated: null, collections: [] }; }
  }
  // The config the worker reads, written again whenever settings, layouts or collections change.
  refreshConfig(libraries: ArtworkLibrary[]) { return this.writeConfig(libraries, 'config.json'); }
  private async next() {
    if (this.current) return;
    const job = this.queue.shift(); if (!job) return;
    const keys = this.secrets();
    const running = this.current = { id: job.id, script: job.script, args: job.args, lines: [] as string[], dropped: 0, canceled: false, secrets: [job.run.token, ...Object.values(keys).filter((v): v is string => !!v)] } as Running & { script: EngineScript; args: string[] };
    const created: { name: string; key: string }[] = [];
    const say = (line: string) => {
      const made = job.script === 'collections' ? /^CREATED (.+): Plex ID (\d{1,10})$/.exec(line) : null;
      if (made) created.push({ name: made[1]!, key: made[2]! });
      running.lines.push(redact(line, running.secrets)); if (running.lines.length > MAX_LINES) { running.lines.splice(0, 1000); running.dropped += 1000; }
    };
    let code: number | null = null;
    try {
      this.store.jobStarted(job.id);
      const engine = await this.status();
      if (!engine.ready) throw new Error(`The artwork engine is not set up: ${engine.error}`);
      const file = this.writeConfig(job.run.libraries, 'config.json');
      const collections = job.script === 'collections';
      say(`> ${collections ? 'plex_collections' : 'overlayrr'} ${job.args.join(' ')}`);
      const child = running.child = spawn(this.paths.python, [collections ? this.paths.collectionsScript : this.paths.script, file, ...job.args], { cwd: this.workDir, env: childEnv(job.run, keys), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream, crlfDelay: Infinity }).on('line', say);
      code = await done;
    } catch (e) { say(`ERROR: ${(e as Error).message}`); }
    const status = running.canceled ? 'canceled' : code === 0 ? 'succeeded' : 'failed';
    if (running.canceled) say('Canceled.');
    if (status === 'succeeded') try { job.done?.(); } catch (e) { this.log('artwork job follow-up failed', { jobId: job.id, error: (e as Error).message }); }
    this.store.jobFinished(job.id, status, code, running.lines.slice(-SAVED_LINES).join('\n'));
    this.log('artwork job finished', { jobId: job.id, status, code });
    // Collections it made are in Plex even if the run failed later on, so they get their posters either way.
    this.postersFor(created, job.id, job.run);
    this.current = undefined; this.store.pruneJobs(); this.finished?.(); void this.next();
  }
  // Written whole and then moved into place, so the engine never reads a half-written config.
  private writeConfig(libraries: ArtworkLibrary[], name: string, changes: Partial<Inputs> = {}) {
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    const { radarrKey: _, ...collections } = this.store.collectionsConfig();
    const inputs: Inputs = { settings: this.store.settings(), layouts: this.store.layouts(), collections, ...changes };
    const file = join(this.workDir, name), temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temporary, JSON.stringify(artworkConfig(inputs.settings, inputs.layouts, libraries, { plexUrl: this.paths.plexUrl, cacheDir: join(this.paths.cacheDir, 'artwork') }, inputs.collections), null, 2), { mode: 0o600 });
    renameSync(temporary, file);
    return file;
  }
  // Short runs: checks, with no credentials, and the collections engine's answers, given `input` on stdin. `output` is
  // everything the run printed; `stdout` and `errors` keep the two apart, for an answer and its failure.
  private capture(args: string[], timeoutMs: number, options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {}) {
    return new Promise<{ code: number | null; output: string; stdout: string; errors: string }>(resolve => {
      let output = '', stdout = '', errors = '';
      const limit = options.input === undefined ? 65536 : 8 * 1024 * 1024;
      const child = spawn(this.paths.python, args, { cwd: options.cwd ?? this.paths.dataDir, env: options.env ?? childEnv(undefined, {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
      const add = (chunk: Buffer, error: boolean) => {
        const text = chunk.toString('utf8');
        if (output.length < 65536) output += text;
        if (error) { if (errors.length < 65536) errors += text; } else if (stdout.length < limit) stdout += text;
      };
      child.stdout.on('data', (chunk: Buffer) => add(chunk, false)); child.stderr.on('data', (chunk: Buffer) => add(chunk, true));
      child.stdin.on('error', () => {}); child.stdin.end(options.input ?? '');
      child.once('error', e => { const message = (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${this.paths.python} was not found. Set PYTHON_PATH.` : e.message; resolve({ code: null, output: message, stdout: '', errors: message }); });
      child.once('close', code => resolve({ code, output, stdout, errors }));
    });
  }
}
