import { describeSchedule, dueAt, nextRun, type JobList, type JobState, type JobView, type Schedule } from '../../../../packages/contracts/src/schedule.js';
import type { PlexGrant } from '../providers/plex.js';
import { AppError, requireThat } from '../errors.js';

// What a job says about itself. `waiting` is a run held back (no Plex admin token, streams playing, a review needed).
export type JobStatus = { lastRun?: number; note?: string; failed?: boolean; waiting?: boolean; running?: boolean };
// Who asked for a run now: their account for the audit, their grant (the owner's tokens, for an admin) for Plex.
export type JobRunner = { actor: string; grant: PlexGrant };
export type Job = {
  id: string; label: string; area: string; section: string;
  // When it runs on its own. Undefined: only when asked.
  schedule: () => { enabled: boolean; schedule: Schedule } | undefined;
  status: () => JobStatus;
  // When it next runs, where the owner knows better than its schedule (a backoff, a per-channel queue).
  next?: (now: number) => number | undefined;
  // Starts a run now. Long work keeps going after it returns; an error thrown here is shown to whoever asked.
  run?: (by: JobRunner) => unknown;
};

// How late a missed set-times run still counts as due (as the artwork and Clean Up schedules allow).
const LATE_MS = 2 * 3600000, HORIZON_MS = 26 * 3600000, MAX_UPCOMING = 100, ANSWER_MS = 1500;

// Every background job in one list, for Admin › Schedule. Modules register theirs at setup; each one keeps its own
// timer and rules (artwork waits for streams to end, IPTV backs off a failing source), and tells this list when it last
// ran and when it runs next. A job with nowhere to keep its state runs through `track`, which keeps it in memory.
export class Jobs {
  private sources: (() => Job[])[] = [];
  private kept = new Map<string, JobStatus>();
  constructor(private log: (message: string, detail: Record<string, unknown>) => void = () => {}) {}
  // Told of each Run now, so its finish can be announced (system-alerts).
  ranByHand?: (id: string) => void;
  add(...jobs: Job[]) { this.sources.push(() => jobs); }
  // Jobs that come and go, one per IPTV source say.
  addEach(jobs: () => Job[]) { this.sources.push(jobs); }
  all() { return this.sources.flatMap(source => { try { return source(); } catch (e) { this.log('jobs could not be listed', { error: (e as Error).message }); return []; } }); }
  // Runs `task` as job `id`, keeping when it ran and whether it failed. A run already going is joined, not repeated.
  private going = new Map<string, Promise<unknown>>();
  track<T>(id: string, task: () => T | Promise<T>): Promise<T> {
    const going = this.going.get(id);
    if (going) return going as Promise<T>;
    const at = Date.now();
    this.kept.set(id, { ...this.kept.get(id), running: true });
    const work = Promise.resolve().then(task).then(result => { this.kept.set(id, { lastRun: at }); return result; },
      error => { this.kept.set(id, { lastRun: at, failed: true, note: error instanceof Error ? error.message : String(error) }); throw error; })
      .finally(() => this.going.delete(id));
    this.going.set(id, work);
    return work;
  }
  tracked(id: string): JobStatus { return this.kept.get(id) ?? {}; }
  async run(id: string, by: JobRunner) {
    const job = this.all().find(j => j.id === id);
    requireThat(job, 'JOB_NOT_FOUND', 'That job no longer exists.', 404);
    requireThat(job.run, 'JOB_NOT_RUNNABLE', 'This job can’t be run by hand.', 409);
    this.log('job run by hand', { job: id, actor: by.actor });
    this.ranByHand?.(id);
    const result = job.run(by);
    // Errors that come quickly (already running, not set up) go back to whoever asked; later ones show in its status.
    if (result instanceof Promise) {
      result.catch(e => this.log('job failed', { job: id, error: e instanceof Error ? e.message : String(e) }));
      await Promise.race([result, new Promise(resolve => setTimeout(resolve, ANSWER_MS).unref())]);
    }
  }
  view(now = Date.now()): JobList {
    const until = now + HORIZON_MS;
    const jobs = this.all().map(job => {
      let status: JobStatus = {}, schedule: ReturnType<Job['schedule']>;
      try { status = job.status(); schedule = job.schedule(); }
      catch (e) { status = { failed: true, note: e instanceof AppError || e instanceof Error ? e.message : String(e) }; }
      const on = !!schedule?.enabled;
      const next = on ? upcomingFrom(job, schedule!.schedule, status.lastRun, now) : undefined;
      const upcoming: number[] = [];
      for (let at = next; at !== undefined && at <= until && upcoming.length < MAX_UPCOMING; at = nextRun(schedule!.schedule, at)) upcoming.push(at);
      const state: JobState = status.running ? 'running' : schedule && !on ? 'off' : status.failed ? 'failed' : status.waiting ? 'waiting' : status.lastRun === undefined ? 'never' : 'ok';
      const view: JobView = { id: job.id, label: job.label, area: job.area, section: job.section,
        schedule: schedule ? describeSchedule(schedule.schedule) : 'Manual only', state,
        ...(status.note ? { note: status.note } : {}), ...(status.lastRun !== undefined ? { lastRun: status.lastRun } : {}),
        ...(next !== undefined ? { nextRun: next } : {}), upcoming, canRun: !!job.run };
      return view;
    });
    return { now, until, jobs };
  }
}

// The job's own next time if it has one, else its schedule's: an every-N job N minutes after its last run, a set-times
// or cron job at its next time (or now, when one it missed lately is still waiting). Never before now.
function upcomingFrom(job: Job, schedule: Schedule, lastRun: number | undefined, now: number) {
  const own = job.next?.(now);
  if (own !== undefined) return Math.max(own, now);
  if (job.next) return undefined;
  if (schedule.kind === 'every') return lastRun === undefined ? now : Math.max(now, nextRun(schedule, lastRun)!);
  return dueAt(schedule, lastRun, now, LATE_MS) !== undefined ? now : nextRun(schedule, now);
}
