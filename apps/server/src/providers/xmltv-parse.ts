import { Worker } from 'node:worker_threads';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';

// A parsed guide as the store saves it: the snapshot's JSON text, and its channel count for the import limit.
export type ParsedXmltv = { text: string; channels: number };

// The worker file next to this one: .js once built. Run from source it is .ts, and the worker registers tsx's loader
// itself before importing it (a worker doesn't get the main thread's tsx hooks).
const source = extname(fileURLToPath(import.meta.url)) === '.ts';
const workerFile = new URL(`./xmltv-worker${source ? '.ts' : '.js'}`, import.meta.url);
const startWorker = () => source
  ? new Worker(`import('tsx/esm/api').then(tsx => { tsx.register(); return import(${JSON.stringify(workerFile.href)}); })`, { eval: true })
  : new Worker(workerFile);

// Parses a downloaded XMLTV guide in a worker thread, so the server keeps answering requests while a large guide is
// read (about 400 ms for an 11 MB guide). One worker per refresh: refreshes are hours apart and at most four at once.
// Errors from parseXmltv come back as the same AppError; aborting stops the worker.
export function parseXmltvOffThread(bytes: Buffer, signal?: AbortSignal): Promise<ParsedXmltv> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = startWorker();
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort); void worker.terminate(); done();
    };
    const abort = () => finish(() => reject(signal!.reason));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (m: { ok: true; text: string; channels: number } | { ok: false; code: string; message: string; status: number }) =>
      finish(() => m.ok ? resolve({ text: m.text, channels: m.channels }) : reject(new AppError(m.code, m.message, m.status))));
    worker.once('error', error => finish(() => reject(error)));
    worker.once('exit', code => finish(() => reject(new Error(`XMLTV worker stopped (exit ${code}).`))));
    worker.postMessage(bytes);
  });
}
