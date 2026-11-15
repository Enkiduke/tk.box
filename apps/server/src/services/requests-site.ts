import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config.js';
import { AppError, requireThat } from '../errors.js';

// Admin › Requests › Requests site: the port, and when tk.box has a public address, the site's own.
export type RequestsSiteSettings = { port: number | null; publicUrl: string | null };

const host = (config: Config) => config.APP_HOST.includes(':') ? `[${config.APP_HOST}]` : config.APP_HOST;
// The origin browsers use for the site, or undefined when it is off. Settings that can't work with this server's own
// address are refused: the site's cookies and origin check follow from it.
export function requestsSiteOrigin(config: Config, settings: RequestsSiteSettings): string | undefined {
  const { port, publicUrl } = settings;
  if (port === null) { requireThat(publicUrl === null, 'INVALID_SITE', 'Choose a port for the Requests site.'); return undefined; }
  requireThat(Number.isInteger(port) && port >= 1024 && port <= 65535, 'INVALID_SITE', 'Use a port from 1024 to 65535.');
  requireThat(port !== config.APP_PORT, 'INVALID_SITE', `Port ${port} is tk.box’s own. Choose another.`);
  if (!config.PUBLIC_BASE_URL) {
    requireThat(publicUrl === null, 'INVALID_SITE', 'A public address needs tk.box to have one too (PUBLIC_BASE_URL).');
    return `http://${host(config)}:${port}`;
  }
  requireThat(publicUrl, 'INVALID_SITE', 'Enter the site’s public address, like https://requests.example.com.');
  let url: URL;
  try { url = new URL(publicUrl); } catch { throw new AppError('INVALID_SITE', 'Enter an address like https://requests.example.com.'); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'INVALID_SITE', 'Use an https:// address with nothing after the name.');
  requireThat(url.origin !== new URL(config.PUBLIC_BASE_URL).origin, 'INVALID_SITE', 'Use a different address from tk.box’s own.');
  return url.origin;
}

// The Requests site's listener: a second server on the same app (app.ts), started, moved or stopped as its settings
// change, with no restart. Its requests are marked by the server they arrived on.
export class RequestsSite {
  origin: string | undefined;
  private servers: Server[] = [];
  private readonly requests = new WeakSet<IncomingMessage>();
  constructor(private config: Config, private handle: () => (req: IncomingMessage, res: ServerResponse) => void) {}
  has(req: IncomingMessage) { return this.requests.has(req); }
  // The port the site is listening on, or undefined when it is off.
  get port() { return (this.servers[0]?.address() as AddressInfo | null)?.port; }
  // A new port is bound before the old one closes, so a port that's taken leaves the site as it was.
  async apply(settings: RequestsSiteSettings) {
    const origin = requestsSiteOrigin(this.config, settings);
    if (settings.port === null) { this.origin = undefined; await this.close(); return; }
    if (this.servers.length && this.port === settings.port) { this.origin = origin; return; }
    // APP_HOST=localhost answers on both loopback addresses, as the main listener does.
    const hosts = this.config.APP_HOST === 'localhost' ? ['127.0.0.1', '::1'] : [this.config.APP_HOST], bound: Server[] = [];
    try { for (const host of hosts) bound.push(await listen(host, settings.port, (req, res) => { this.requests.add(req); this.handle()(req, res); })); }
    catch (e) { await Promise.all(bound.map(stop)); throw e; }
    const old = this.servers;
    this.servers = bound; this.origin = origin;
    await Promise.all(old.map(stop));
  }
  async close() { const old = this.servers; this.servers = []; await Promise.all(old.map(stop)); }
}
const listen = (host: string, port: number, handler: (req: IncomingMessage, res: ServerResponse) => void) => new Promise<Server>((resolve, reject) => {
  const server = createServer(handler);
  server.once('error', e => reject((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? new AppError('PORT_IN_USE', `Port ${port} is in use. Choose another.`, 409) : e));
  server.listen(port, host, () => resolve(server));
});
const stop = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
