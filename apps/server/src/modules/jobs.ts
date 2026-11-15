import { z } from 'zod';
import { defineModule } from './module.js';
import { viewer } from './access.js';

const jobId = z.object({ id: z.string().regex(/^[\w.:-]{1,160}$/) });

// Admin › Schedule: every background job the modules registered (services/jobs.ts), and running one now.
export const jobsModule = defineModule({
  name: 'jobs',
  access: 'admin',
  setup(routes, { jobs }) {
    routes.get('/api/v1/admin/jobs', async () => jobs.view());
    routes.post('/api/v1/admin/jobs/:id/run', async req => {
      const { grant } = viewer(req), { id } = jobId.parse(req.params);
      await jobs.run(id, { actor: grant.accountId, grant });
      return jobs.view();
    });
    return { api: undefined };
  }
});
