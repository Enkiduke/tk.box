import { randomUUID } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyReply } from 'fastify';
import { defineModule } from './module.js';

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// The web app's built files and the health check, open to anyone.
export const webModule = defineModule({
  name: 'web',
  access: 'public',
  async setup(routes, { config }) {
    // `boot` changes on every start, so open players can tell the server restarted and reconnect.
    const boot = randomUUID();
    routes.get('/health', {config:{rateLimit:{max:120,timeWindow:60000}}}, async () => ({ status: 'ok', boot }));
    // Register only the trusted build's actual public files; no user-supplied filesystem paths,
    // directory listing, symlink traversal, wildcard routing or media-cache mount.
    const registerAssets = async (dir: string, prefix: string) => {
      for (const file of await readdir(dir, { withFileTypes: true })) {
        if (file.name.startsWith('.')) continue;
        const path = join(dir, file.name), url = `${prefix}/${file.name}`;
        if (file.isDirectory()) await registerAssets(path, url);
        else if (file.isFile() && types[extname(file.name)]) {
          // Vite emits content-hashed names under /assets, so those can be cached forever;
          // the HTML entry point is always revalidated so new builds are picked up.
          const caching = url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
          const handler = async (_req: unknown, reply: FastifyReply) => reply.type(types[extname(file.name)]!).header('Cache-Control', caching).send(createReadStream(path));
          // Bundles and styles have their own budget, so loading the app leaves the API budget for data.
          const options = {config:{rateLimit:{max:120,timeWindow:60000}}};
          routes.get(url, options, handler); if (url === '/index.html') routes.get('/', options, handler);
        }
      }
    };
    if (existsSync(config.WEB_DIR)) await registerAssets(config.WEB_DIR, '');
    return { api: {} };
  }
});
