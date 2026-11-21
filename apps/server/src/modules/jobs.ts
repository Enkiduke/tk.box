import { z } from 'zod';
import { defineModule } from './module.js';
import { viewer } from './access.js';
import { jobsMigrations } from './migrations/jobs.js';
import { AppError } from '../errors.js';
import type { Db } from '../persistence/database.js';

const jobId = z.object({ id: z.string().regex(/^[\w.:-]{1,160}$/) });
const validZone = (zone: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } };
const zoneBody = z.object({ timeZone: z.string().min(1).max(64).refine(validZone, 'Use an IANA time zone') });

// The time zone schedules run in (Admin › Schedule), kept in the database and set as the server's own (process.env.TZ),
// so every set time (artwork's 04:00, Clean Up's) and the artwork engine it starts run on the admin's clock, not the
// server's (often UTC). Unset: the server's zone.
function savedZone(db: Db) {
  const row = db.prepare('SELECT value FROM jobs_settings WHERE id=1').get() as { value: string } | undefined;
  const zone = row ? (JSON.parse(row.value) as { timeZone?: string }).timeZone : undefined;
  return zone && validZone(zone) ? zone : undefined;
}

// Admin › Schedule: every background job the modules registered (services/jobs.ts), running one now, and the time
// zone they run in.
export const jobsModule = defineModule({
  name: 'jobs',
  access: 'admin',
  migrations: jobsMigrations,
  setup(routes, { db, jobs, log }) {
    const zone = savedZone(db);
    if (zone) process.env.TZ = zone;
    routes.get('/api/v1/admin/jobs', async () => jobs.view());
    routes.post('/api/v1/admin/jobs/:id/run', async req => {
      const { grant } = viewer(req), { id } = jobId.parse(req.params);
      await jobs.run(id, { actor: grant.accountId, grant });
      return jobs.view();
    });
    routes.put('/api/v1/admin/jobs/time-zone', async req => {
      const parsed = zoneBody.safeParse(req.body);
      if (!parsed.success) throw new AppError('INVALID_TIME_ZONE', 'Choose a time zone from the list.', 400);
      const { timeZone } = parsed.data, { grant } = viewer(req);
      db.prepare('INSERT INTO jobs_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify({ timeZone }));
      process.env.TZ = timeZone;
      log.info('schedule time zone changed', { timeZone, actor: grant.accountId });
      return jobs.view();
    });
    return { api: undefined };
  }
});
