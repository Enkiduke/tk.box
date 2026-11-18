import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './database.js';
import { prepared } from './statements.js';

// The PC workers and their side of `subtitle_jobs` (docs/PHASE-5.md): tokens, and claiming, keeping, finishing and
// failing a job. A job is the worker's once OpenSubtitles had nothing for its video ('queued').

export const LEASE_MS = 30 * 60000, MAX_ATTEMPTS = 3;
const TOKEN_PREFIX = 'tkw_';

export type SubtitleWorker = { id: number; name: string; createdAt: number; lastSeenAt?: number; revokedAt?: number };
// Admin › Downloads › Subtitles › Workers: with how many jobs it holds now.
export type SubtitleWorkerRow = SubtitleWorker & { holding: number };
export type ClaimedJob = { id: number; path: string; language: string; leaseUntil: number; attempts: number };

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

type WorkerRow = { id: number; name: string; created_at: number; last_seen_at: number | null; revoked_at: number | null };
const worker = (r: WorkerRow): SubtitleWorker => ({ id: r.id, name: r.name, createdAt: r.created_at,
  ...(r.last_seen_at !== null ? { lastSeenAt: r.last_seen_at } : {}), ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}) });

export class SubtitleWorkerStore {
  constructor(readonly db: Db, private now: () => number = Date.now) {}

  // ---- tokens ----

  // A new worker; the token is returned this once, and only its hash is kept.
  create(name: string, actor = 'tk.box'): { worker: SubtitleWorker; token: string } {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url'), at = this.now();
    return this.db.transaction(() => {
      const id = Number(prepared(this.db, 'INSERT INTO subtitle_workers(name, token_hash, created_at) VALUES(?, ?, ?)').run(name, hashToken(token), at).lastInsertRowid);
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)').run(actor, 'subtitle_worker_created', at, JSON.stringify({ id, name }));
      return { worker: { id, name, createdAt: at }, token };
    })();
  }
  // The worker a bearer token belongs to, unless it's revoked; its last-seen time is updated.
  authenticate(token: string | undefined): SubtitleWorker | undefined {
    if (!token?.startsWith(TOKEN_PREFIX) || token.length > 200) return undefined;
    const row = prepared(this.db, 'SELECT * FROM subtitle_workers WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token)) as WorkerRow | undefined;
    if (!row) return undefined;
    const at = this.now();
    prepared(this.db, 'UPDATE subtitle_workers SET last_seen_at = ? WHERE id = ?').run(at, row.id);
    return worker({ ...row, last_seen_at: at });
  }
  list(): SubtitleWorkerRow[] {
    return (prepared(this.db, `SELECT w.*, (SELECT count(*) FROM subtitle_jobs j WHERE j.state = 'claimed' AND j.worker_id = w.id) AS holding
      FROM subtitle_workers w ORDER BY w.revoked_at IS NOT NULL, w.created_at DESC`).all() as (WorkerRow & { holding: number })[]).map(r => ({ ...worker(r), holding: r.holding }));
  }
  // Revoked at once; the jobs it held go back to the queue without using an attempt.
  revoke(id: number, actor = 'tk.box') {
    return this.db.transaction(() => {
      const changed = prepared(this.db, 'UPDATE subtitle_workers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this.now(), id).changes > 0;
      if (changed) {
        prepared(this.db, "UPDATE subtitle_jobs SET state = 'queued', worker_id = NULL, lease_until = NULL WHERE state = 'claimed' AND worker_id = ?").run(id);
        prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)').run(actor, 'subtitle_worker_revoked', this.now(), JSON.stringify({ id }));
      }
      return changed;
    })();
  }

  // ---- jobs ----

  // Claimed jobs whose lease ran out (the worker stopped answering) count an attempt and go back to the queue, or are
  // failed after the third. Returns their ids, so their audio can be removed.
  expire(now = this.now()): number[] {
    return this.db.transaction(() => {
      const rows = prepared(this.db, "SELECT id FROM subtitle_jobs WHERE state = 'claimed' AND lease_until < ?").all(now) as { id: number }[];
      prepared(this.db, `UPDATE subtitle_jobs SET attempts = attempts + 1, worker_id = NULL, lease_until = NULL,
        error = 'The worker stopped answering.', state = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
        done_at = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN ? ELSE NULL END
        WHERE state = 'claimed' AND lease_until < ?`).run(now, now);
      return rows.map(r => r.id);
    })();
  }
  // The next due job for a video the library still has, newest import first, leased to this worker. `importedAt` is the
  // library's answer for a path: when its file was imported, or undefined once the library no longer has it.
  claim(workerId: number, importedAt: (path: string) => number | undefined): ClaimedJob | undefined {
    return this.db.transaction(() => {
      const now = this.now();
      let row: Omit<ClaimedJob, 'leaseUntil'> | undefined, best = -Infinity;
      for (const job of prepared(this.db, `SELECT id, path, language, attempts FROM subtitle_jobs WHERE state = 'queued' AND not_before <= ? ORDER BY id`).all(now) as Omit<ClaimedJob, 'leaseUntil'>[]) {
        const at = importedAt(job.path);
        if (at !== undefined && at > best) { row = job; best = at; }
      }
      if (!row) return undefined;
      const leaseUntil = now + LEASE_MS;
      prepared(this.db, "UPDATE subtitle_jobs SET state = 'claimed', worker_id = ?, lease_until = ? WHERE id = ?").run(workerId, leaseUntil, row.id);
      return { ...row, leaseUntil };
    })();
  }
  // The job, if this worker holds it. A lease that ran out but wasn't taken back yet still counts.
  held(jobId: number, workerId: number): ClaimedJob | undefined {
    return prepared(this.db, `SELECT id, path, language, lease_until AS leaseUntil, attempts FROM subtitle_jobs WHERE id = ? AND state = 'claimed' AND worker_id = ?`)
      .get(jobId, workerId) as ClaimedJob | undefined;
  }
  // The lease runs another 30 minutes from now.
  heartbeat(jobId: number, workerId: number): number | undefined {
    const leaseUntil = this.now() + LEASE_MS;
    return prepared(this.db, "UPDATE subtitle_jobs SET lease_until = ? WHERE id = ? AND state = 'claimed' AND worker_id = ?").run(leaseUntil, jobId, workerId).changes ? leaseUntil : undefined;
  }
  // The worker couldn't make it, or what it sent failed the checks: an attempt; queued again, or failed after the third.
  fail(jobId: number, workerId: number, reason: string): 'queued' | 'failed' | undefined {
    return this.db.transaction(() => {
      const job = this.held(jobId, workerId);
      if (!job) return undefined;
      const state = job.attempts + 1 >= MAX_ATTEMPTS ? 'failed' as const : 'queued' as const;
      prepared(this.db, `UPDATE subtitle_jobs SET attempts = attempts + 1, worker_id = NULL, lease_until = NULL, error = ?, state = ?, done_at = ? WHERE id = ?`)
        .run(reason.slice(0, 500), state, state === 'failed' ? this.now() : null, jobId);
      return state;
    })();
  }
  // Every job id still claimed, so the audio of any other can be removed.
  claimedIds() { return new Set((prepared(this.db, "SELECT id FROM subtitle_jobs WHERE state = 'claimed'").all() as { id: number }[]).map(r => r.id)); }
}
