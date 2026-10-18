import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { opaque } from '../security/vault.js';
import type { PlexAdapter, PlexGrant, PlexMetadata } from './plex.js';

// A loopback-only byte server for FFmpeg when a part isn't on this host's disk. FFmpeg reads
// http://127.0.0.1:<port>/p/<random key> with ranges; Node fetches the part from Plex with the token,
// so the token never appears in FFmpeg's arguments or the process list. Keys exist only while a program plays.
export class PartProxy {
  private parts = new Map<string, { grant: PlexGrant; item: PlexMetadata }>();
  private server?: Promise<{ server: Server; port: number }>;
  constructor(private plex: PlexAdapter) {}
  async url(grant: PlexGrant, item: PlexMetadata) {
    const { port } = await this.listen(), key = opaque();
    this.parts.set(key, { grant, item });
    return { url: `http://127.0.0.1:${port}/p/${key}`, release: () => { this.parts.delete(key); } };
  }
  close() { void this.server?.then(({ server }) => server.close()); this.server = undefined; this.parts.clear(); }
  private listen() {
    this.server ??= new Promise((done, fail) => {
      const server = createServer((req, res) => {
        const part = req.method === 'GET' || req.method === 'HEAD' ? this.parts.get(/^\/p\/([\w-]+)$/.exec(req.url ?? '')?.[1] ?? '') : undefined;
        const range = req.headers.range;
        if (!part || (range && !/^bytes=\d*-\d*$/.test(range))) { res.writeHead(404).end(); return; }
        const abort = new AbortController(); res.once('close', () => abort.abort());
        this.plex.directPart(part.grant, part.item, range, abort.signal).then(response => {
          const headers: Record<string, string> = {};
          for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = response.headers.get(h); if (v) headers[h] = v; }
          res.writeHead(response.status, headers);
          if (req.method === 'HEAD' || !response.body) { void response.body?.cancel(); res.end(); return; }
          Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
        }, () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      });
      server.on('error', fail);
      server.listen(0, '127.0.0.1', () => { server.unref(); done({ server, port: (server.address() as AddressInfo).port }); });
    });
    return this.server;
  }
}
