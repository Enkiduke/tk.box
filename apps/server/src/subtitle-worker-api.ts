import { createReadStream, promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SubtitleWorkerCreated, SubtitleWorkers } from '../../../packages/contracts/src/subtitles.js';
import { subtitleWorker, viewer } from './modules/access.js';
import { requireLive, requireThat } from './errors.js';
import type { SubtitleWorkerService } from './services/subtitle-worker.js';
import type { SubtitleWorkerStore } from './persistence/subtitle-worker-store.js';

// The PC worker's routes (docs/PHASE-5.md): its bearer token only, on the main listener only (never the Requests site,
// app.ts), rate-limited. Each job route refuses a job this worker doesn't hold.

const MAX_SRT = 2 * 1024 * 1024;
const params = z.object({ id: z.coerce.number().int().positive() }).strict();
const resultInput = z.object({ srt: z.string().min(1).max(MAX_SRT), model: z.string().trim().min(1).max(100) }).strict();
const failInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const nameInput = z.object({ name: z.string().trim().min(1).max(60) }).strict();

// Admin › Downloads › Subtitles › Workers: making a token (shown once), the list with last seen, and revoking one.
export function registerSubtitleWorkersAdmin(app: FastifyInstance, workers: SubtitleWorkerStore) {
  app.get('/api/v1/admin/subtitles/workers', async (): Promise<SubtitleWorkers> => ({ workers: workers.list() }));
  app.post('/api/v1/admin/subtitles/workers', { config: { access: 'admin', rateLimit: { max: 10, timeWindow: 60000 } } }, async (request): Promise<SubtitleWorkerCreated> => {
    requireLive('Making a worker token');
    const { worker, token } = workers.create(nameInput.parse(request.body).name, viewer(request).grant.accountId);
    return { worker: { ...worker, holding: 0 }, token };
  });
  app.post('/api/v1/admin/subtitles/workers/:id/revoke', async request => {
    requireLive('Revoking a worker token');
    requireThat(workers.revoke(params.parse(request.params).id, viewer(request).grant.accountId), 'NOT_FOUND', 'No such worker, or it was revoked already.', 404);
    return { ok: true };
  });
}

export function registerSubtitleWorker(app: FastifyInstance, service: SubtitleWorkerService) {
  const route = (max: number, extra: object = {}) => ({ config: { access: 'worker' as const, rateLimit: { max, timeWindow: 60000 } }, ...extra });
  const held = <T>(value: T | undefined) => { requireThat(value, 'JOB_NOT_HELD', 'This worker doesn’t hold that job.', 409); return value; };

  app.post('/api/v1/subtitle-worker/claim', route(30), async (request, reply) => {
    requireLive('The subtitle worker');
    const job = await service.claim(subtitleWorker(request).id);
    return job ?? reply.code(204).send();
  });
  app.get('/api/v1/subtitle-worker/jobs/:id/audio', route(20), async (request, reply) => {
    requireLive('The subtitle worker');
    const path = held(await service.audio(subtitleWorker(request).id, params.parse(request.params).id));
    const { size } = await fs.stat(path);
    return reply.type('audio/flac').header('Content-Length', size).send(createReadStream(path));
  });
  app.post('/api/v1/subtitle-worker/jobs/:id/heartbeat', route(60), async request => {
    requireLive('The subtitle worker');
    return { leaseUntil: held(service.heartbeat(subtitleWorker(request).id, params.parse(request.params).id)) };
  });
  app.post('/api/v1/subtitle-worker/jobs/:id/result', route(20, { bodyLimit: MAX_SRT * 2 }), async (request, reply) => {
    requireLive('The subtitle worker');
    const { srt, model } = resultInput.parse(request.body);
    const outcome = held(await service.result(subtitleWorker(request).id, params.parse(request.params).id, srt, model));
    return outcome.ok ? outcome : reply.code(422).send({ code: 'SUBTITLE_REJECTED', message: outcome.error, ...(outcome.state ? { state: outcome.state } : {}) });
  });
  app.post('/api/v1/subtitle-worker/jobs/:id/fail', route(20), async request => {
    requireLive('The subtitle worker');
    const { reason } = failInput.parse(request.body);
    return { state: held(await service.fail(subtitleWorker(request).id, params.parse(request.params).id, reason)) };
  });
}
