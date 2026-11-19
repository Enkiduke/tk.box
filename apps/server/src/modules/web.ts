import { randomUUID } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { defineModule } from './module.js';

// The stored copy to send for a request's Accept-Encoding: brotli, then gzip, skipping any the browser refuses (q=0).
export function pickEncoding(accept: string | undefined, available: readonly Encoding[]): Encoding | undefined {
  const allowed = new Set<string>();
  for (const part of (accept ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(p => p.trim());
    const q = params.find(p => p.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) allowed.add(name);
  }
  return available.find(e => allowed.has(e));
}
type Encoding = 'br' | 'gzip';
const suffix: Record<Encoding, string> = { br: '.br', gzip: '.gz' };

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// The web app's built files and the health check, open to anyone. The Requests site gets the same files, except that
// its `/` is portal.html and the main app's index.html is not there.
export const webModule = defineModule({
  name: 'web',
  access: 'public',
  async setup(routes, { config }) {
    // `boot` changes on every start, so open players can tell the server restarted and reconnect.
    const boot = randomUUID();
    routes.get('/health', {config:{portal:true,rateLimit:{max:120,timeWindow:60000}}}, async () => ({ status: 'ok', boot }));
    // Register only the trusted build's actual public files; no user-supplied filesystem paths,
    // directory listing, symlink traversal, wildcard routing or media-cache mount.
    // Which compressed copies the build stored beside each file, read once at start.
    const copies = new Map<string, Encoding[]>();
    const stored = (file: string) => {let found = copies.get(file); if (!found) copies.set(file, found = (['br', 'gzip'] as const).filter(e => existsSync(file + suffix[e]))); return found;};
    const registerAssets = async (dir: string, prefix: string) => {
      for (const file of await readdir(dir, { withFileTypes: true })) {
        if (file.name.startsWith('.')) continue;
        const path = join(dir, file.name), url = `${prefix}/${file.name}`;
        if (file.isDirectory()) await registerAssets(path, url);
        else if (file.isFile() && types[extname(file.name)]) {
          // Vite emits content-hashed names under /assets, so those can be cached forever;
          // the HTML entry point is always revalidated so new builds are picked up.
          const caching = url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
          // A file the build stored compressed copies of (vite.config.ts) is sent from those; others are left to the
          // compress plugin. `Vary` keeps a shared cache from handing one browser another's encoding.
          const send = (file: string, req: FastifyRequest, reply: FastifyReply) => {
            reply.type(types[extname(file)]!).header('Cache-Control', caching);
            const available = stored(file);
            if (!available.length) return reply.send(createReadStream(file));
            const encoding = pickEncoding(req.headers['accept-encoding'], available);
            reply.header('Vary', 'Accept-Encoding');
            if (!encoding) return reply.send(createReadStream(file));
            return reply.header('Content-Encoding', encoding).send(createReadStream(file + suffix[encoding]));
          };
          const handler = async (req: FastifyRequest, reply: FastifyReply) => send(path, req, reply);
          // Bundles and styles have their own budget, so loading the app leaves the API budget for data.
          const options = (portal: boolean, files: string[]) => ({compress: files.every(f => stored(f).length) ? false as const : undefined, config:{portal,rateLimit:{max:120,timeWindow:60000}}});
          routes.get(url, options(url !== '/index.html', [path]), handler);
          if (url === '/index.html') {
            const portalPage = join(dir, 'portal.html');
            routes.get('/', options(existsSync(portalPage), [path, ...(existsSync(portalPage) ? [portalPage] : [])]), async (req: FastifyRequest, reply: FastifyReply) => send(req.portal ? portalPage : path, req, reply));
          }
        }
      }
    };
    if (existsSync(config.WEB_DIR)) await registerAssets(config.WEB_DIR, '');
    return { api: {} };
  }
});
