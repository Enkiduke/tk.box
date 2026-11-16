import { defineModule } from './module.js';
import { preview } from '../errors.js';
import { queueMigrations } from './migrations/queue.js';
import { Queue, type QueueApi } from '../services/queue.js';

// The durable work queue (services/queue.ts, docs/ARR-REPLACEMENT.md). No routes of its own: each kind shows in
// Admin › Schedule through `jobs`. Modules mounted after it take its API as a dep to enqueue and handle work.
export const queueModule = defineModule({
  name: 'queue',
  migrations: queueMigrations,
  setup(_routes, { db, jobs, log }) {
    const queue = new Queue(db, { jobs, log: (message, detail) => log.warn(message, detail) });
    const api: QueueApi = queue;
    return { api, start() { if (!preview()) queue.start(); }, stop() { queue.stop(); } };
  }
});
