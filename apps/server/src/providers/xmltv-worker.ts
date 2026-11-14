import { parentPort } from 'node:worker_threads';
import { parseXmltv } from './iptv.js';
import { AppError } from '../errors.js';

// Worker side of parseXmltvOffThread: parses one downloaded guide and hands back the snapshot as JSON text, which is
// what the store seals. It never touches the database.
parentPort!.once('message', (bytes: Uint8Array) => {
  try {
    const parsed = parseXmltv(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    parentPort!.postMessage({ ok: true, text: JSON.stringify(parsed), channels: parsed.channels.length });
  } catch (e) {
    parentPort!.postMessage(e instanceof AppError
      ? { ok: false, code: e.code, message: e.message, status: e.status }
      : { ok: false, code: 'INVALID_XMLTV', message: 'XMLTV document could not be read.', status: 400 });
  }
});
