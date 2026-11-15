import type { Db } from '../persistence/database.js';
import { prepared } from '../persistence/statements.js';
import { every, errorDetail, type Repeating } from '../lib/every.js';
import type { Jobs, JobStatus } from './jobs.js';

// What a handler says about its item. `retry` runs it again at `at`, or after the backoff; `fail` does too unless it is
// permanent. Either goes to `failed` once the item has used its max_attempts.
export type Outcome = { result: 'done' } | { result: 'retry'; at?: number } | { result: 'fail'; message: string; permanent: boolean };
export const done = (): Outcome => ({ result: 'done' });
export const retry = (at?: number): Outcome => at === undefined ? { result: 'retry' } : { result: 'retry', at };
export const fail = (message: string, permanent = false): Outcome => ({ result: 'fail', message, permanent });

export type QueueItem<P = unknown> = { id: number; kind: string; key: string; payload: P; attempts: number; maxAttempts: number; runAt: number; createdAt: number };
// `signal` aborts when the item is cancelled, its lease expires or the server stops; the outcome is then ignored.
// `renew` extends the lease (by the kind's lease, or `ms`); false once the item is no longer this handler's.
export type HandlerContext = { signal: AbortSignal; renew: (ms?: number) => boolean };
export type KindOptions<P> = {
  handler: (item: QueueItem<P>, context: HandlerContext) => Outcome | Promise<Outcome>;
  concurrency?: number; leaseMs?: number;
  // Admin › Schedule.
  label?: string; area?: string; section?: string;
  // Told when an item goes to `failed` (for a grab: blocklist it and pick the next release).
  onFailed?: (item: QueueItem<P>, error: string) => void;
};
export type EnqueueOptions = { runAt?: number; maxAttempts?: number };
export type QueueState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type QueueKindView = { kind: string; label: string; queued: number; running: number; failed: number };
export type QueueItemView = { id: number; kind: string; key: string; state: QueueState; runAt: number; attempts: number; maxAttempts: number; lastError?: string; createdAt: number; updatedAt: number };
export type QueueView = { kinds: QueueKindView[]; items: QueueItemView[] };
export type QueueApi = Pick<Queue, 'enqueue' | 'handle' | 'cancel' | 'view' | 'retry'>;

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const CONCURRENCY: Record<string, number> = { search: 2, send: 2, import: 1, unpack: 1, 'find-subtitles': 2 };
const LEASE: Record<string, number> = { search: 2 * MINUTE, import: 30 * MINUTE, unpack: 2 * HOUR };
const DEFAULT_CONCURRENCY = 4, DEFAULT_LEASE = 5 * MINUTE, DEFAULT_ATTEMPTS = 5;
const TICK_MS = 5000, LEASE_CHECK_MS = MINUTE, PRUNE_MS = DAY, KEEP_MS = 14 * DAY, BACKOFF_CAP = 6 * HOUR, LIST_LIMIT = 200;

// The wait before the next try once `tries` have failed: 1 min × 2^(earlier tries), so 1, 2, 4, 8… min, at most 6 h.
export const backoff = (tries: number) => Math.min(MINUTE * 2 ** Math.max(0, tries - 1), BACKOFF_CAP);

type Row = { id: number; kind: string; key: string; payload: string; state: QueueState; run_at: number; lease_until: number | null; attempts: number; max_attempts: number; last_error: string | null; created_at: number; updated_at: number };
type Kind = { options: KindOptions<unknown>; concurrency: number; leaseMs: number; busy: number };
// One claimed item in this process. `attempts` after the claim fences its writes: a row given back (lease expired,
// cancelled, server stopped) and claimed again has a higher count, so a late outcome changes nothing.
type Run = { kind: string; attempts: number; controller: AbortController };

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// The durable work queue (docs/ARR-REPLACEMENT.md, "The job queue"). One table, many kinds; each kind registers a
// handler with its concurrency and lease. A loop takes due items in run_at order, waking on enqueue and every 5 s.
// SQLite is the only state that matters: a restart picks up where the last process left off.
export class Queue {
  private kinds = new Map<string, Kind>();
  private running = new Map<number, Run>();
  private timers: Repeating[] = [];
  private started = false;
  private waking = false;
  private jobs?: Jobs;
  private now: () => number;
  private log: (message: string, detail: Record<string, unknown>) => void;

  constructor(private db: Db, options: { jobs?: Jobs; now?: () => number; log?: (message: string, detail: Record<string, unknown>) => void } = {}) {
    this.jobs = options.jobs;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  // One open item per (kind, key): enqueueing one that is already queued or running does nothing and returns its id.
  enqueue(kind: string, key: string, payload: unknown = {}, options: EnqueueOptions = {}): { id: number; added: boolean } {
    const now = this.now(), maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a whole number of at least 1.');
    const added = prepared(this.db, `INSERT INTO queue_items(kind, key, payload, state, run_at, max_attempts, created_at, updated_at)
      VALUES(?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`)
      .get(kind, key, JSON.stringify(payload), options.runAt ?? now, maxAttempts, now, now) as { id: number } | undefined;
    if (added) { this.wake(); return { id: added.id, added: true }; }
    const open = prepared(this.db, `SELECT id FROM queue_items WHERE kind = ? AND key = ? AND state IN ('queued','running')`).get(kind, key) as { id: number };
    return { id: open.id, added: false };
  }

  // Registers the handler for `kind`, and its Admin › Schedule entry.
  handle<P>(kind: string, options: KindOptions<P>) {
    if (this.kinds.has(kind)) throw new Error(`Queue kind ${kind} already has a handler.`);
    const concurrency = options.concurrency ?? CONCURRENCY[kind] ?? DEFAULT_CONCURRENCY, leaseMs = options.leaseMs ?? LEASE[kind] ?? DEFAULT_LEASE;
    if (!(concurrency >= 1) || !(leaseMs > 0)) throw new Error(`Queue kind ${kind}: concurrency and lease must be positive.`);
    this.kinds.set(kind, { options: options as KindOptions<unknown>, concurrency, leaseMs, busy: 0 });
    this.jobs?.add({ id: `queue.${kind}`, label: options.label ?? kind, area: options.area ?? 'Queue', section: options.section ?? 'downloads',
      schedule: () => undefined, status: () => this.status(kind) });
    this.wake();
  }

  // Cancels the open item for (kind, key); a running one has its signal aborted. False when there was none.
  cancel(kind: string, key: string) {
    const open = prepared(this.db, `SELECT id FROM queue_items WHERE kind = ? AND key = ? AND state IN ('queued','running')`).get(kind, key) as { id: number } | undefined;
    if (!open) return false;
    prepared(this.db, `UPDATE queue_items SET state = 'cancelled', lease_until = NULL, updated_at = ? WHERE id = ?`).run(this.now(), open.id);
    this.release(open.id, 'cancelled');
    this.wake();
    return true;
  }

  // A failed item runs again now, with its tries counted afresh (Admin › Downloads › Activity). False when it isn't
  // failed, or another item for its (kind, key) is already open.
  retry(id: number) {
    const now = this.now();
    const changed = prepared(this.db, `UPDATE queue_items SET state = 'queued', attempts = 0, run_at = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND state = 'failed' AND NOT EXISTS (SELECT 1 FROM queue_items o WHERE o.kind = queue_items.kind AND o.key = queue_items.key
        AND o.state IN ('queued','running'))`).run(now, now, id).changes > 0;
    if (changed) this.wake();
    return changed;
  }

  // Each kind's counts, and the open and failed items, newest first.
  view(): QueueView {
    const counts = new Map<string, QueueKindView>();
    const of = (kind: string) => {
      let view = counts.get(kind);
      if (!view) counts.set(kind, view = { kind, label: this.kinds.get(kind)?.options.label ?? kind, queued: 0, running: 0, failed: 0 });
      return view;
    };
    for (const kind of this.kinds.keys()) of(kind);
    const rows = prepared(this.db, `SELECT kind, state, COUNT(*) AS n FROM queue_items WHERE state IN ('queued','running','failed') GROUP BY kind, state`).all() as { kind: string; state: 'queued' | 'running' | 'failed'; n: number }[];
    for (const { kind, state, n } of rows) of(kind)[state] = n;
    const items = (prepared(this.db, `SELECT * FROM queue_items WHERE state IN ('queued','running','failed') ORDER BY updated_at DESC, id DESC LIMIT ?`).all(LIST_LIMIT) as Row[])
      .map(r => ({ id: r.id, kind: r.kind, key: r.key, state: r.state, runAt: r.run_at, attempts: r.attempts, maxAttempts: r.max_attempts,
        ...(r.last_error ? { lastError: r.last_error } : {}), createdAt: r.created_at, updatedAt: r.updated_at }));
    return { kinds: [...counts.values()].sort((a, b) => a.kind.localeCompare(b.kind)), items };
  }

  // On start, running items whose lease has expired go back to queued (the last process stopped mid-item).
  start() {
    if (this.started) return;
    this.started = true;
    this.guard('queue lease check failed', () => this.expireLeases());
    this.guard('queue prune failed', () => this.prune());
    this.timers.push(
      every(TICK_MS, () => { this.fill(); }, e => this.log('queue loop failed', errorDetail(e))),
      every(LEASE_CHECK_MS, () => { this.expireLeases(); }, e => this.log('queue lease check failed', errorDetail(e))),
      every(PRUNE_MS, () => { this.prune(); }, e => this.log('queue prune failed', errorDetail(e))));
    this.wake();
  }

  // Aborts what is running and gives it back to queued at once, not counting the try, so the next start picks it up.
  stop() {
    this.started = false;
    for (const timer of this.timers.splice(0)) timer.stop();
    for (const [id, run] of [...this.running]) {
      this.guard('queue stop failed', () => prepared(this.db, `UPDATE queue_items SET state = 'queued', lease_until = NULL, attempts = attempts - 1, updated_at = ?
        WHERE id = ? AND state = 'running' AND attempts = ?`).run(this.now(), id, run.attempts));
      this.release(id, 'stopped');
    }
  }

  // Claims what is due for each kind with a free slot, and resolves once those handlers have finished (for tests; the
  // loop doesn't wait).
  async tick() { await Promise.all(this.fill()); }

  // Running items whose lease has expired go back to queued (or to failed, when they have used their tries). A handler
  // still going here has its signal aborted, and its slot is freed so a stuck handler can't block its kind.
  expireLeases() {
    const now = this.now();
    const expired = prepared(this.db, `SELECT * FROM queue_items WHERE state = 'running' AND (lease_until IS NULL OR lease_until < ?)`).all(now) as Row[];
    for (const row of expired) {
      this.release(row.id, 'lease expired');
      if (row.attempts >= row.max_attempts) this.failed(row, row.attempts, 'The lease expired.', now);
      else prepared(this.db, `UPDATE queue_items SET state = 'queued', lease_until = NULL, run_at = ?, last_error = 'The lease expired.', updated_at = ?
        WHERE id = ? AND state = 'running' AND attempts = ?`).run(now, now, row.id, row.attempts);
    }
    if (expired.length) { this.log('queue leases expired', { items: expired.map(r => r.id) }); this.wake(); }
    return expired.length;
  }

  // Finished items (done, failed, cancelled) older than 14 days.
  prune() {
    return prepared(this.db, `DELETE FROM queue_items WHERE state IN ('done','failed','cancelled') AND updated_at < ?`).run(this.now() - KEEP_MS).changes;
  }

  private status(kind: string): JobStatus {
    const counts = { queued: 0, running: 0, failed: 0 };
    for (const { state, n } of prepared(this.db, `SELECT state, COUNT(*) AS n FROM queue_items WHERE kind = ? AND state IN ('queued','running','failed') GROUP BY state`)
      .all(kind) as { state: keyof typeof counts; n: number }[]) counts[state] = n;
    const { queued, running, failed } = counts;
    const last = prepared(this.db, `SELECT state, updated_at, last_error FROM queue_items WHERE kind = ? AND state IN ('done','failed') ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get(kind) as { state: 'done' | 'failed'; updated_at: number; last_error: string | null } | undefined;
    return { note: `${queued} queued · ${running} running · ${failed} failed`, running: running > 0,
      ...(last ? { lastRun: last.updated_at, failed: last.state === 'failed' } : {}) };
  }

  private wake() {
    if (!this.started || this.waking) return;
    this.waking = true;
    setImmediate(() => { this.waking = false; if (this.started) this.guard('queue loop failed', () => this.fill()); });
  }

  private fill() {
    const now = this.now(), runs: Promise<void>[] = [];
    for (const [kind, k] of this.kinds) {
      const free = k.concurrency - k.busy;
      if (free <= 0) continue;
      const due = prepared(this.db, `SELECT * FROM queue_items WHERE state = 'queued' AND kind = ? AND run_at <= ? ORDER BY run_at, id LIMIT ?`).all(kind, now, free) as Row[];
      for (const row of due) { const run = this.claim(row, kind, k, now); if (run) runs.push(run); }
    }
    return runs;
  }

  private claim(row: Row, kind: string, k: Kind, now: number) {
    const claimed = prepared(this.db, `UPDATE queue_items SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
      WHERE id = ? AND state = 'queued' RETURNING attempts`).get(now + k.leaseMs, now, row.id) as { attempts: number } | undefined;
    if (!claimed) return undefined;
    const run: Run = { kind, attempts: claimed.attempts, controller: new AbortController() };
    this.running.set(row.id, run); k.busy++;
    const renew = (ms = k.leaseMs) => {
      if (this.running.get(row.id) !== run) return false;
      const at = this.now();
      return prepared(this.db, `UPDATE queue_items SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'running' AND attempts = ?`)
        .run(at + ms, at, row.id, run.attempts).changes > 0;
    };
    let item: QueueItem | undefined;
    return Promise.resolve()
      .then(() => {
        item = { id: row.id, kind, key: row.key, payload: JSON.parse(row.payload) as unknown, attempts: run.attempts, maxAttempts: row.max_attempts, runAt: row.run_at, createdAt: row.created_at };
        return k.options.handler(item, { signal: run.controller.signal, renew });
      })
      .catch((e: unknown): Outcome => fail(message(e)))
      .then(outcome => this.finish(row, run, k, item, outcome))
      .catch(e => this.log('queue item could not be finished', { id: row.id, kind, ...errorDetail(e) }));
  }

  private finish(row: Row, run: Run, k: Kind, item: QueueItem | undefined, outcome: Outcome) {
    // Given back (cancelled, lease expired, server stopped): the row is no longer this handler's.
    if (this.running.get(row.id) !== run) return;
    this.running.delete(row.id); k.busy--;
    const now = this.now(), attempts = run.attempts;
    if (outcome.result === 'done') {
      prepared(this.db, `UPDATE queue_items SET state = 'done', lease_until = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND state = 'running' AND attempts = ?`)
        .run(now, row.id, attempts);
    } else {
      const error = outcome.result === 'fail' ? outcome.message : null;
      if ((outcome.result === 'fail' && outcome.permanent) || attempts >= row.max_attempts) this.failed(row, attempts, error ?? `Gave up after ${attempts} tries.`, now, item);
      else prepared(this.db, `UPDATE queue_items SET state = 'queued', lease_until = NULL, run_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running' AND attempts = ?`)
        .run(outcome.result === 'retry' && outcome.at !== undefined ? outcome.at : now + backoff(attempts), error, now, row.id, attempts);
    }
    this.wake();
  }

  private failed(row: Row, attempts: number, error: string, now: number, item?: QueueItem) {
    const changed = prepared(this.db, `UPDATE queue_items SET state = 'failed', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running' AND attempts = ?`)
      .run(error, now, row.id, attempts).changes;
    const onFailed = this.kinds.get(row.kind)?.options.onFailed;
    if (!changed || !onFailed) return;
    this.guard('queue failure handler failed', () => {
      let payload: unknown = {};
      try { payload = JSON.parse(row.payload); } catch { /* told with an empty payload */ }
      onFailed(item ?? { id: row.id, kind: row.kind, key: row.key, payload, attempts, maxAttempts: row.max_attempts, runAt: row.run_at, createdAt: row.created_at }, error);
    }, { id: row.id, kind: row.kind });
  }

  // Forgets a run here (its slot is free and its outcome will be ignored) and aborts its handler.
  private release(id: number, reason: string) {
    const run = this.running.get(id);
    if (!run) return;
    this.running.delete(id);
    const k = this.kinds.get(run.kind);
    if (k) k.busy--;
    run.controller.abort(new Error(`Queue item ${reason}.`));
  }

  private guard(what: string, task: () => unknown, detail: Record<string, unknown> = {}) {
    try { task(); } catch (e) { this.log(what, { ...detail, ...errorDetail(e) }); }
  }
}
