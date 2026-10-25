import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AppError } from '../errors.js';
import { childEnv, type ArtworkEngine, type ArtworkRun } from './artwork-engine.js';

// The artwork engine's interactive side (`artwork_engine.py --worker`): one long-lived Python process that answers the Admin ›
// Artwork pages (titles, picks, previews, layout previews) as JSON lines. It starts when an administrator opens those
// pages (their settings start it ahead of the first click), restarts when the credentials it was given change, and stops
// after a while unused. Like jobs, it is its own process, so rendering previews never runs on the server's event loop.
type Reply = { id?: number; result?: unknown; error?: string; ready?: boolean };
// `boxes` (layout previews only): where each layer of the layout editor was drawn, in the image's pixels.
export type WorkerImage = { image: string; type: string; note?: string; boxes?: unknown };
const IDLE_MS = 30 * 60000;

export class ArtworkWorker {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<ChildProcessWithoutNullStreams>;
  private fingerprint = '';
  private pending = new Map<number, { child: ChildProcessWithoutNullStreams; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private next = 1;
  private idle?: NodeJS.Timeout;
  constructor(private engine: ArtworkEngine, private log: (message: string, detail: Record<string, unknown>) => void = () => {}) {}
  async request<T>(run: ArtworkRun, method: string, params: Record<string, unknown> = {}, timeoutMs = 90000): Promise<T> {
    const child = await this.ready(run), id = this.next++;
    this.touch();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError('ARTWORK_WORKER_TIMEOUT', 'The artwork engine took too long to answer.', 504)); }, timeoutMs);
      this.pending.set(id, { child, resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async image(run: ArtworkRun, method: string, params: Record<string, unknown>) {
    const { image, type, note, boxes } = await this.request<WorkerImage>(run, method, params);
    return { bytes: Buffer.from(image, 'base64'), type, ...(note ? { note } : {}), ...(boxes ? { boxes } : {}) };
  }
  // Start it now, so the page's first request doesn't wait for Python to load.
  warm(run: ArtworkRun) { void this.ready(run).then(() => this.touch(), () => {}); }
  // Settings, layouts or collections changed: write the config again; the worker reads it again when it sees it changed.
  refresh(run: ArtworkRun) { this.engine.refreshConfig(run.libraries); }
  close() { clearTimeout(this.idle); this.stop(); }
  private touch() { clearTimeout(this.idle); this.idle = setTimeout(() => this.stop(), IDLE_MS); this.idle.unref(); }
  private stop() {
    const child = this.child; this.child = undefined; this.fingerprint = '';
    if (child) { child.stdin.end(); setTimeout(() => child.kill(), 5000).unref(); }
  }
  private async ready(run: ArtworkRun) {
    const secrets = this.engine.secrets(), fingerprint = createHash('sha256').update(JSON.stringify([run.token, secrets])).digest('hex');
    if (this.child && this.fingerprint === fingerprint) return this.child;
    if (this.starting && this.fingerprint === fingerprint) return this.starting;
    this.stop(); this.fingerprint = fingerprint;
    const status = await this.engine.status();
    if (!status.ready) throw new AppError('ARTWORK_ENGINE_UNAVAILABLE', `The artwork engine is not set up: ${status.error}`, 503);
    this.starting = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      const config = this.engine.refreshConfig(run.libraries);
      const child = spawn(this.engine.paths.python, [this.engine.paths.script, config, '--worker'], { cwd: this.engine.workDir, env: childEnv(run, secrets), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let started = false;
      const fail = (message: string) => { if (!started) { started = true; reject(new AppError('ARTWORK_WORKER_FAILED', message, 503)); } };
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
        let reply: Reply; try { reply = JSON.parse(line) as Reply; } catch { return; }
        if (!started && 'ready' in reply) { if (reply.ready) { started = true; resolve(child); } else fail(reply.error ?? 'The artwork engine could not start.'); return; }
        const waiting = reply.id === undefined ? undefined : this.pending.get(reply.id);
        if (!waiting || reply.id === undefined) return;
        this.pending.delete(reply.id); clearTimeout(waiting.timer);
        if (reply.error !== undefined) waiting.reject(new AppError('ARTWORK_REQUEST_FAILED', reply.error, 422)); else waiting.resolve(reply.result);
      });
      // Its log is the engine's warnings; keep the last few lines for when it fails to start.
      const recent: string[] = [];
      createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', line => { recent.push(line); if (recent.length > 20) recent.shift(); });
      child.once('error', e => fail(e.message));
      child.once('close', code => {
        fail(recent.at(-1) || `The artwork engine stopped (exit code ${code}).`);
        if (this.child === child) { this.child = undefined; this.fingerprint = ''; }
        if (code) this.log('artwork worker stopped', { code, last: recent.at(-1) });
        for (const [id, waiting] of this.pending) { if (waiting.child !== child) continue; this.pending.delete(id); clearTimeout(waiting.timer); waiting.reject(new AppError('ARTWORK_WORKER_STOPPED', 'The artwork engine stopped. Try again.', 503)); }
      });
    });
    try { this.child = await this.starting; return this.child; }
    finally { this.starting = undefined; }
  }
}
