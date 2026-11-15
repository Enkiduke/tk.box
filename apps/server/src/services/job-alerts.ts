import type { JobList, JobView } from '../../../../packages/contracts/src/schedule.js';
import { ADMINS, type NewNotification, type Resolution } from '../persistence/notifications-store.js';

// Admin alerts from Admin › Schedule's job list (docs/NOTIFICATIONS.md), read every minute:
// - a failed job is an open condition (`job.<id>`), closed with "… is working again" once it runs fine;
// - a job held back (no Plex admin token, streams playing) for WAIT_MS is a warning (`job.waiting.<id>`), closed
//   quietly when it runs;
// - a run that finishes after Run now, or a Clean Up run, says so.
export type JobAlert = { post?: NewNotification; resolve?: { to: string; key: string; resolution?: Resolution } };
export const WAIT_MS = 3 * 3600000;
// Jobs whose scheduled runs are worth hearing about when they finish (they change the library).
const ANNOUNCED = new Set(['cleanup.run']);

type Seen = { state: JobView['state']; lastRun?: number; waitingSince?: number; failing: boolean; waitingAlert: boolean };

export class JobWatch {
  private seen = new Map<string, Seen>();
  private byHand = new Set<string>();
  // Admin › Schedule's Run now (or a module's own run button routed through Jobs.run).
  ranByHand(id: string) { this.byHand.add(id); }

  check(list: JobList): JobAlert[] {
    const alerts: JobAlert[] = [], now = list.now;
    for (const job of list.jobs) {
      const before = this.seen.get(job.id), link = `#admin?section=${job.section}`;
      const next: Seen = { state: job.state, ...(job.lastRun !== undefined ? { lastRun: job.lastRun } : {}), failing: before?.failing ?? false, waitingAlert: before?.waitingAlert ?? false };
      if (job.state === 'failed') {
        next.failing = true;
        alerts.push({ post: { to: ADMINS, kind: 'job.failed', tone: 'error', title: `${job.label} failed`, ...(job.note ? { detail: job.note } : {}), link, key: `job.${job.id}` } });
        this.byHand.delete(job.id);
      } else if (job.state === 'ok' && (next.failing || !before)) {
        // Unseen before (just started): a condition left open from before a restart closes if the job is fine now.
        next.failing = false;
        alerts.push({ resolve: { to: ADMINS, key: `job.${job.id}`, resolution: { title: `${job.label} is working again` } } });
      }
      if (job.state === 'waiting') {
        next.waitingSince = before?.state === 'waiting' ? before.waitingSince ?? now : now;
        if (!next.waitingAlert && now - next.waitingSince >= WAIT_MS) {
          next.waitingAlert = true;
          alerts.push({ post: { to: ADMINS, kind: 'job.waiting', tone: 'warning', title: `${job.label} is waiting`, ...(job.note ? { detail: job.note } : {}), link, key: `job.waiting.${job.id}` } });
        }
      } else if ((next.waitingAlert || !before) && job.state !== 'running') {
        next.waitingAlert = false;
        alerts.push({ resolve: { to: ADMINS, key: `job.waiting.${job.id}` } });
      }
      // Finished: a newer run that came out fine. The first look at a job only learns where it stands.
      const ran = before && job.lastRun !== undefined && job.lastRun !== before.lastRun && job.state === 'ok';
      if (ran && (this.byHand.has(job.id) || ANNOUNCED.has(job.id))) {
        alerts.push({ post: { to: ADMINS, kind: 'job.finished', tone: 'success', title: `${job.label} finished`, ...(job.note ? { detail: job.note } : {}), link } });
      }
      if (ran) this.byHand.delete(job.id);
      this.seen.set(job.id, next);
    }
    // Jobs that went away (a removed IPTV source) close their conditions.
    const live = new Set(list.jobs.map(j => j.id));
    for (const [id, seen] of this.seen) if (!live.has(id)) {
      if (seen.failing) alerts.push({ resolve: { to: ADMINS, key: `job.${id}` } });
      if (seen.waitingAlert) alerts.push({ resolve: { to: ADMINS, key: `job.waiting.${id}` } });
      this.seen.delete(id);
    }
    return alerts;
  }
}
