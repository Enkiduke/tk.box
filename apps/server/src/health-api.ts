import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { IptvStore } from './persistence/iptv-store.js';
import { HealthStore, healthPolicy } from './persistence/channel-health-store.js';
import type { ChannelHealth } from './services/channel-health.js';
import { AppError, requireThat } from './errors.js';

type Access = (req: FastifyRequest) => Promise<{ grant: { accountId: string } }>;
// Administrator-only. Responses carry verdicts and reason codes, never stream URIs or FFmpeg output.
export function registerChannelHealth(app: FastifyInstance, iptv: IptvStore, store: HealthStore, service: ChannelHealth, admin: Access) {
  const params = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
  const m3u = (id: string) => { requireThat(iptv.status(id).kind === 'm3u', 'INVALID_POLICY', 'Channel checks apply to M3U sources only.'); return id; };
  const view = (id: string) => ({ policy: store.policy(id), summary: store.summary(id), checking: service.active(id) });
  app.get('/api/v1/admin/iptv/sources/:id/health', async req => {
    await admin(req); const id = m3u(params(req.params)), health = store.forSource(id);
    return { ...view(id), channels: Object.fromEntries([...health].map(([channel, h]) => [channel, { ...h, checking: service.checking(channel) }])) };
  });
  app.put('/api/v1/admin/iptv/sources/:id/health', async req => {
    const { grant } = await admin(req), id = m3u(params(req.params)); store.setPolicy(grant.accountId, id, healthPolicy.parse(req.body)); service.pump(); return view(id);
  });
  app.post('/api/v1/admin/iptv/sources/:id/health/check', async req => {
    await admin(req); z.object({}).strict().parse(req.body); const id = m3u(params(req.params)); return { queued: service.queueSource(id), ...view(id) };
  });
  app.delete('/api/v1/admin/iptv/sources/:id/health/slates', async req => {
    const { grant } = await admin(req); z.object({}).strict().parse(req.body); const id = m3u(params(req.params)); store.clearSlates(grant.accountId, id); service.pump(); return view(id);
  });
  app.post('/api/v1/admin/iptv/channels/:id/health/check', async req => { await admin(req); z.object({}).strict().parse(req.body); service.queueChannel(params(req.params)); return { status: 'queued' }; });
  app.post('/api/v1/admin/iptv/channels/:id/health/slate', async req => {
    const { grant } = await admin(req); z.object({}).strict().parse(req.body); return store.markSlate(grant.accountId, params(req.params));
  });
  app.get('/api/v1/admin/iptv/channels/:id/health/thumbnail', async (req, reply) => {
    await admin(req); const path = service.thumbnail(params(req.params));
    const size = path ? await stat(path).then(s => s.size, () => 0) : 0;
    if (!path || !size) throw new AppError('THUMBNAIL_UNAVAILABLE', 'No picture was captured for this channel.', 404);
    return reply.type('image/jpeg').header('content-length', String(size)).send(createReadStream(path));
  });
}
