import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

// Runs the artwork engine's jobs in one Python process (`artwork_engine.py <config> --batch`), one after another, so a push
// or a newly-added check that queues a job per title loads Python and the engine once instead of once per title (about
// a second each: Python's start-up and a new connection to Plex). It is separate from the interactive worker (artwork-worker.ts), so a long job never holds up the Titles
// and Layouts pages. ArtworkEngine still queues, orders, logs and cancels each job as before; this only replaces
// spawning a process for each. The process starts with the first job, is started again when the credentials change,
// stops after a while with nothing to run or after many jobs (so memory a big run took is handed back), and is ended
// to cancel a job.
const DONE = '\x1eDONE ';
export type BatchOptions = { python: string; script: string; config: string; cwd: string; idleMs?: number; maxJobs?: number };
// A job belongs to the process it was sent to: an older process ending (after new credentials) leaves it alone.
type Job = { child: ChildProcessWithoutNullStreams; say: (line: string) => void; resolve: (code: number | null) => void; reject: (error: Error) => void };

export class ArtworkBatch {
  private child?: ChildProcessWithoutNullStreams;
  private fingerprint = '';
  private job?: Job;
  private jobs = 0;
  private idle?: NodeJS.Timeout;
  constructor(private options: BatchOptions) {}
  // Runs one job's options (no config path; the batch's own config is read again for each job) with this environment.
  // `fingerprint` names the credentials in `env`: a different one starts a new process.
  run(args: string[], env: NodeJS.ProcessEnv, fingerprint: string, say: (line: string) => void) {
    if (this.job) return Promise.reject(new Error('An artwork job is already running.'));
    clearTimeout(this.idle);
    if (this.child && this.fingerprint !== fingerprint) this.stop();
    const child = this.child ?? this.start(env, fingerprint);
    return new Promise<number | null>((resolve, reject) => {
      this.job = { child, say, resolve, reject };
      child.stdin.write(JSON.stringify({ args }) + '\n');
    });
  }
  // Ends the running job (and the process running it); its run() resolves with null.
  cancel() { if (this.job) this.child?.kill(); }
  close() { clearTimeout(this.idle); this.child?.kill(); this.child = undefined; }
  private start(env: NodeJS.ProcessEnv, fingerprint: string) {
    const { python, script, config, cwd } = this.options;
    const child = spawn(python, [script, config, '--batch'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child; this.fingerprint = fingerprint; this.jobs = 0;
    child.stdin.on('error', () => {});  // It stopped while being written to: its 'close' ends the job
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      if (!line.startsWith(DONE)) { this.mine(child)?.say(line); return; }
      let code: number | null = null;
      try { const value = (JSON.parse(line.slice(DONE.length)) as { code?: unknown }).code; code = typeof value === 'number' ? value : null; } catch { /* null: failed */ }
      this.finish(child, job => job.resolve(code));
      if (this.child !== child) return;
      if (++this.jobs >= (this.options.maxJobs ?? 200)) this.stop();
      else { this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 120000); this.idle.unref(); }
    });
    // Only what Python itself prints before or past the engine (the engine sends its own warnings to stdout).
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', line => this.mine(child)?.say(line));
    child.once('error', error => { if (this.child === child) this.child = undefined; this.finish(child, job => job.reject(error)); });
    child.once('close', code => {
      if (this.child === child) this.child = undefined;
      this.finish(child, job => job.resolve(code === 0 ? null : code));
    });
    return child;
  }
  private mine(child: ChildProcessWithoutNullStreams) { return this.job?.child === child ? this.job : undefined; }
  private finish(child: ChildProcessWithoutNullStreams, end: (job: Job) => void) { const job = this.mine(child); if (job) { this.job = undefined; end(job); } }
  private stop() {
    clearTimeout(this.idle);
    const child = this.child; this.child = undefined; this.fingerprint = '';
    if (child) { child.stdin.end(); setTimeout(() => child.kill(), 5000).unref(); }
  }
}
