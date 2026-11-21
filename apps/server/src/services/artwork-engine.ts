import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, requireThat } from '../errors.js';
import type { ArtworkCollections, ArtworkSettings, ArtworkStore } from '../persistence/artwork-store.js';
import type { ProviderKeys } from '../persistence/service-keys.js';
import { collectionsByMovie, hiddenDownloads } from './hidden-downloads.js';
import type { CollectionsStore, KeptCollections } from '../persistence/collections-store.js';
import type { CollectionsRunner } from './collections/runner.js';
import { SEASONAL_PRESETS } from './collections/presets.js';
import { ArtworkBatch } from './artwork-batch.js';
import type { ShowAirings } from './wanted.js';

// Runs Artwork's jobs, one at a time, in order, whichever engine they are for. The artwork engine
// (apps/artwork/artwork_engine.py) runs in its own Python process, which runs one job after another (artwork-batch.ts):
// before each job tk.box writes its JSON config from the database; credentials go in the process's environment, and
// each job's output streams into its own history. The rendering happens entirely in that
// process (which lowers its own CPU priority), so the server's event loop and the streaming paths never do image work.
// The collections engine (services/collections) runs in the server: it only talks to Plex and the providers.
export type ArtworkLibrary = { key: string; title: string; type: string };
export type ArtworkRun = { token: string; libraries: ArtworkLibrary[] };
type Paths = { python: string; script: string; dataDir: string; cacheDir: string; plexUrl: string };
export type EngineScript = 'artwork' | 'collections';
// What the last applying collections run kept: every franchise and streaming collection that qualifies (off: turned off
// in tk.box, so not in Plex) and every custom one that's on, with its Plex ID once it's in Plex.
export type { KeptCollections };
type Running = { id: number; batch?: true; abort?: AbortController; lines: string[]; dropped: number; canceled: boolean; secrets: string[] };
type Inputs = { settings: ArtworkSettings; layouts: Record<string, Record<string, unknown>>; collections?: ArtworkCollections };
type EngineStatus = { at: number } & ({ ready: true; version: string } | { ready: false; error: string; interrupted?: true });
// The long-lived worker process (artwork-worker.ts), which answers the artwork engine's checks too.
type Worker = { request<T>(run: ArtworkRun, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> };
const MAX_LINES = 5000, SAVED_LINES = 2000;

// The engine's config for one run. Library titles come from the signed-in administrator's view of Plex, because the
// engine matches its per-library layouts by title. Credentials are never written into it.
// `airings`: the library's shows' last and next episodes and season starts, by TMDB id (wanted.ts showAirings), which
// the engine's status banners use over TMDB's.
export function artworkConfig(settings: ArtworkSettings, layouts: Record<string, Record<string, unknown>>, libraries: ArtworkLibrary[], paths: Pick<Paths, 'plexUrl' | 'cacheDir'>, collections?: ArtworkCollections,
  airings?: Record<string, ShowAirings>) {
  const title = (id: string) => libraries.find(l => l.key === id)?.title, f = collections?.franchise;
  return {
    plex: { url: paths.plexUrl, libraries: settings.libraries, upload: settings.upload, upload_logo: settings.uploadLogo, include_seasons: settings.includeSeasons,
      include_episodes: settings.includeEpisodes, include_collections: settings.includeCollections, completion_label: settings.completionLabel,
      // The streaming logo a show's poster uses ("available") is where it streams in the collections' region.
      ...(f ? { collection_region: f.region } : {}) },
    assets_dir: 'assets', cache_dir: paths.cacheDir, workers: settings.workers, quality: settings.quality, language: settings.language,
    missing_art: settings.missingArt, overlay_marker: true, default_layout: settings.defaultLayout,
    layout_by_library: Object.fromEntries(Object.entries(settings.layoutByLibrary).flatMap(([id, layout]) => { const name = title(id); return name ? [[name, layout]] : []; })),
    ...(Object.keys(settings.layoutByType).length ? { layout_by_type: settings.layoutByType } : {}),
    layouts,
    // Which collections are custom ones, for their posters.
    ...(collections?.definitions ? { collections: collections.definitions } : {}),
    ...(airings && Object.keys(airings).length ? { airings } : {})
  };
}
// The engine's provider keys, from Admin › Connections (service keys).
export type EngineSecrets = ProviderKeys;
// Only what Python needs, plus the credentials for this run; never the server's own environment.
export function childEnv(run: ArtworkRun | undefined, keys: EngineSecrets) {
  const pass = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'VIRTUAL_ENV', 'TKBOX_READ_ONLY'];
  const env: NodeJS.ProcessEnv = Object.fromEntries(pass.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' });
  // Match artwork_engine.py's defaults when the dependency check imports NumPy directly.
  Object.assign(env, { OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' });
  if (run) env.PLEX_TOKEN = run.token;
  for (const [name, variable] of [['tmdb', 'TMDB_API_KEY'], ['tvdb', 'TVDB_API_KEY'], ['fanart', 'FANART_API_KEY']] as const)
    if (keys[name]) env[variable] = keys[name];
  return env;
}
// Ends an in-server job's step early, past the Python process's.
class Done extends Error {}
const redact = (line: string, secrets: string[]) => secrets.reduce((text, secret) => secret.length >= 6 ? text.replaceAll(secret, '•••') : text, line);

export class ArtworkEngine {
  private queue: { id: number; script: EngineScript; args: string[]; run: ArtworkRun; done?: () => void }[] = [];
  private current?: Running & { script: EngineScript; args: string[] };
  private known?: EngineStatus;
  private checking?: Promise<EngineStatus>;
  private worker?: Worker;
  private collections?: CollectionsRunner;
  private collectionsStore?: CollectionsStore;
  private batch: ArtworkBatch;
  readonly workDir: string;
  // Called after each job that ran, whatever its outcome: even a failed or canceled one may have changed some art in Plex.
  finished?: () => void;
  constructor(private store: ArtworkStore, readonly paths: Paths, private log: (message: string, detail: Record<string, unknown>) => void = () => {}, private keys: () => EngineSecrets = () => ({})) {
    this.workDir = join(paths.dataDir, 'artwork');
    this.batch = new ArtworkBatch({ python: paths.python, script: paths.script, config: join(this.workDir, 'config.json'), cwd: this.workDir });
    store.abandonJobs();
    this.renameFiles();
  }
  // The engine's files once carried its former name: each title's details and the collections journal move to their
  // current names, once, before any job or the worker reads them.
  private renameFiles() {
    if (this.store.state<boolean>('files:renamed')) return;
    try {
      const walk = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name === '.overlayrr.json' && !existsSync(join(folder, '.artwork.json'))) renameSync(path, join(folder, '.artwork.json'));
        }
      };
      if (existsSync(join(this.workDir, 'assets'))) walk(join(this.workDir, 'assets'));
      const journal = join(this.workDir, 'collections-state.json');
      if (existsSync(join(this.workDir, 'overlayrr-collections.json')) && !existsSync(journal)) renameSync(join(this.workDir, 'overlayrr-collections.json'), journal);
      rmSync(join(this.workDir, '.overlayrr.lock'), { force: true });
      this.store.setState('files:renamed', true);
    } catch (e) { this.log('artwork files could not be renamed; trying again at the next start', { error: (e as Error).message }); }
  }
  useWorker(worker: Worker) { this.worker = worker; }
  useCollections(runner: CollectionsRunner, store: CollectionsStore) { this.collections = runner; this.collectionsStore = store; }
  // The library's show airings for the status banners: the library module mounts after this one and hands them over.
  private airings?: () => Record<string, ShowAirings>;
  useAirings(read: () => Record<string, ShowAirings>) { this.airings = read; }
  secrets(): EngineSecrets { return this.keys(); }
  // Cache the dependency check for a minute. An interrupted check can be tried again on the next request.
  status(force = false) {
    if (!force && this.known && Date.now() - this.known.at < 60000) return Promise.resolve(this.known);
    this.checking ??= this.checkPython().then(status => {
      this.known = !status.ready && status.interrupted ? undefined : status;
      return status;
    }).finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async checkPython(): Promise<EngineStatus> {
    const args = ['-c', 'import sys, PIL, numpy, requests; print(sys.version.split()[0])'];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { code, signal, output } = await this.capture(args, 20000);
      if (code === 0) return { at: Date.now(), ready: true, version: output.trim() };
      const error = output.trim().split('\n').at(-1) || 'Python could not be started.';
      // Python can report Ctrl+C as a signal, an exit status, or the last line of a traceback.
      if (signal === 'SIGINT' || code === 130 || /^KeyboardInterrupt(?::|$)/.test(error)) continue;
      return { at: Date.now(), ready: false, error };
    }
    return { at: Date.now(), ready: false, interrupted: true, error: 'The Python dependency check was interrupted twice.' };
  }
  // Both engines' own validation of what is about to be saved (on top of what is saved now): the collections' here, the
  // artwork engine's asked of the worker. Until Python is set up only the database's own checks apply to the artwork side
  // (settings can be saved first); it checks everything again when a job runs.
  async check(changes: Partial<Inputs>, run: ArtworkRun) {
    if (changes.collections) { this.collections?.validate(changes.collections); if (!changes.settings && !changes.layouts) return; }
    if (!this.worker || !(await this.status()).ready) return;
    const file = this.writeConfig(run.libraries, `check-${randomUUID()}.json`, changes);
    try { await this.worker.request(run, 'check', { config: file }, 30000); }
    catch (e) { throw (e as AppError).code === 'ARTWORK_REQUEST_FAILED' ? new AppError('ARTWORK_CONFIG_INVALID', (e as Error).message || 'The artwork engine rejected these settings.', 422) : e; }
    finally { rmSync(file, { force: true }); }
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
  // A Discover answer from the collections engine, with this run's credentials. Partly owned and Universes read the
  // Discover index the collections jobs keep, so none of them waits on TMDb or a list.
  async discover(run: ArtworkRun, input: Record<string, unknown>) {
    requireThat(this.collections, 'ARTWORK_ENGINE_UNAVAILABLE', 'The collections engine is not set up.', 503);
    return this.collections.discover(run, input);
  }
  // The seasonal presets used until collections are first saved.
  defaultCollections() { return SEASONAL_PRESETS; }
  cancel(id: number) {
    const waiting = this.queue.findIndex(j => j.id === id);
    if (waiting >= 0) { this.queue.splice(waiting, 1); this.store.jobFinished(id, 'canceled', null, 'Canceled before it started.'); return; }
    if (this.current?.id !== id) throw new AppError('JOB_NOT_RUNNING', 'That job has already finished.', 409);
    this.current.canceled = true; if (this.current.batch) this.batch.cancel(); this.current.abort?.abort();
  }
  // A job's state, with the running job's output from line `since` on (line numbers keep counting as old lines drop).
  job(id: number, since = 0) {
    const job = this.store.job(id), live = this.current?.id === id ? this.current : undefined;
    if (!live) { const lines = job.output ? job.output.split('\n') : []; return { ...job, output: undefined, lines: lines.slice(since), next: lines.length }; }
    const from = Math.max(since - live.dropped, 0);
    return { ...job, output: undefined, lines: live.lines.slice(from), next: live.dropped + live.lines.length };
  }
  busy() { return this.current ? { running: this.current.id, queued: this.queue.length } : { running: null, queued: this.queue.length }; }
  close() { this.queue = []; if (this.current) { this.current.canceled = true; this.current.abort?.abort(); } this.batch.close(); }
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
  // The collections the last applying run kept.
  keptCollections(): KeptCollections { return this.collectionsStore?.kept() ?? { updated: null, collections: [] }; }
  // The journal of downloads, in the shape both journals had ({movies: {tmdb id: {owners}}}).
  private journal() { return { movies: Object.fromEntries([...(this.collectionsStore?.downloads() ?? new Map<number, string[]>())].map(([id, owners]) => [String(id), { owners }])) }; }
  // Which collections downloaded each movie (Admin › Manage › Movies' source), from tk.box's journal and the older file
  // from before tk.box added them itself (collections-state.json, read only).
  collectionMovies() {
    const older = (() => { try { return JSON.parse(readFileSync(join(this.workDir, 'collections-state.json'), 'utf8')) as unknown; } catch { return null; } })();
    return collectionsByMovie([this.journal(), older], this.store.collections().definitions);
  }
  // The movies collections downloaded that stay off Recently added.
  hiddenFromRecent() { return hiddenDownloads(this.journal(), this.store.collections().definitions); }
  // The config the worker reads, written again whenever settings, layouts or collections change.
  refreshConfig(libraries: ArtworkLibrary[]) { return this.writeConfig(libraries, 'config.json'); }
  private async next() {
    if (this.current) return;
    const job = this.queue.shift(); if (!job) return;
    const keys = this.secrets();
    const running = this.current = { id: job.id, script: job.script, args: job.args, lines: [] as string[], dropped: 0, canceled: false, secrets: [job.run.token, ...Object.values(keys).filter((v): v is string => !!v)] } as Running & { script: EngineScript; args: string[] };
    const created: { name: string; key: string }[] = [];
    const say = (line: string) => {
      running.lines.push(redact(line, running.secrets)); if (running.lines.length > MAX_LINES) { running.lines.splice(0, 1000); running.dropped += 1000; }
    };
    let code: number | null = null;
    try {
      this.store.jobStarted(job.id);
      if (job.script === 'collections') {
        requireThat(this.collections, 'ARTWORK_ENGINE_UNAVAILABLE', 'The collections engine is not set up.', 503);
        say(`> collections ${job.args.join(' ')}`);
        running.abort = new AbortController();
        code = await this.collections.job({ args: job.args, run: job.run, say, signal: running.abort.signal, created: (name, key) => created.push({ name, key }) });
        throw new Done();
      }
      const engine = await this.status();
      if (!engine.ready) throw new Error(`Artwork engine unavailable. ${engine.error}`);
      this.writeConfig(job.run.libraries, 'config.json');
      say(`> artwork_engine ${job.args.join(' ')}`);
      running.batch = true;
      code = await this.batch.run(job.args, childEnv(job.run, keys), createHash('sha256').update(JSON.stringify([job.run.token, keys])).digest('hex'), say);
    } catch (e) { if (!(e instanceof Done) && !running.canceled) say(`ERROR: ${(e as Error).message}`); }
    const status = running.canceled ? 'canceled' : code === 0 ? 'succeeded' : 'failed';
    if (running.canceled) say('Canceled.');
    if (status === 'succeeded') try { job.done?.(); } catch (e) { this.log('artwork job follow-up failed', { jobId: job.id, error: (e as Error).message }); }
    this.store.jobFinished(job.id, status, code, running.lines.slice(-SAVED_LINES).join('\n'));
    this.log('artwork job finished', { jobId: job.id, status, code });
    // Collections it made are in Plex even if the run failed later on, so they get their posters either way.
    this.postersFor(created, job.id, job.run);
    this.current = undefined; this.store.pruneJobs(); this.finished?.(); void this.next();
  }
  // The movies the last collections run wants tk.box's library to add, and those its seasonal and rotating
  // collections let go. Taken once.
  takeAcquisitions(): { add: number[]; remove: number[] } { return this.collectionsStore?.takeAcquisitions() ?? { add: [], remove: [] }; }
  // Written whole and then moved into place, so the engine never reads a half-written config.
  private writeConfig(libraries: ArtworkLibrary[], name: string, changes: Partial<Inputs> = {}) {
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    const collections = this.store.collectionsConfig();
    const inputs: Inputs = { settings: this.store.settings(), layouts: this.store.layouts(), collections, ...changes };
    const file = join(this.workDir, name), temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    let airings: Record<string, ShowAirings> | undefined;
    try { airings = this.airings?.(); } catch (e) { this.log('artwork: the library’s air days could not be read', { error: (e as Error).message }); }
    writeFileSync(temporary, JSON.stringify(artworkConfig(inputs.settings, inputs.layouts, libraries, { plexUrl: this.paths.plexUrl, cacheDir: join(this.paths.cacheDir, 'artwork') }, inputs.collections, airings), null, 2), { mode: 0o600 });
    renameSync(temporary, file);
    return file;
  }
  // A short run with no credentials (whether Python and its packages are installed); `output` is everything it printed.
  private capture(args: string[], timeoutMs: number) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(resolve => {
      let output = '';
      const child = spawn(this.paths.python, args, { cwd: this.paths.dataDir, env: childEnv(undefined, {}), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
      const add = (chunk: Buffer) => { if (output.length < 65536) output += chunk.toString('utf8'); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      child.once('error', e => resolve({ code: null, signal: null, output: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${this.paths.python} was not found. Set PYTHON_PATH.` : e.message }));
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    });
  }
}
