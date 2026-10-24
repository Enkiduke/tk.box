import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import { publicAddress } from '../providers/source-fetch.js';

type Address = { address: string; family: number };
const hopByHop = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const forward = (headers: IncomingHttpHeaders) => Object.fromEntries(Object.entries(headers).filter(([name]) => !hopByHop.includes(name.toLowerCase())));

// IPTV streams are read by FFmpeg through this loopback proxy (its http_proxy variable) unless the source's administrator allowed
// local-network streams. Every connection FFmpeg makes, redirects, HLS variant playlists, keys and segments included,
// is resolved here and must reach public addresses only, at the very address that was checked. HTTPS is tunnelled with
// CONNECT, so TLS stays FFmpeg's, end to end. It reaches nothing a process on this host couldn't reach directly, so it
// takes no key. Redirects are never followed here; FFmpeg follows them, through the proxy again.
export class StreamGuard {
  private server?: Promise<{ server: Server; port: number }>;
  private sockets = new Set<Socket>();
  constructor(private resolve: (host: string) => Promise<Address[]> = host => lookup(host, { all: true, verbatim: true }), private allowed: (address: string) => boolean = publicAddress) {}
  // The proxy address for FFmpeg's -http_proxy option.
  async url() { const { port } = await this.listen(); return `http://127.0.0.1:${port}`; }
  close() {
    for (const socket of this.sockets) socket.destroy();
    void this.server?.then(({ server }) => server.close()); this.server = undefined;
  }
  // The address to connect to: the host's, only when every address it resolves to is allowed.
  async address(host: string): Promise<Address> {
    const name = host.replace(/^\[|\]$/g, ''), family = isIP(name);
    const records = family ? [{ address: name, family }] : await this.resolve(name);
    if (!records.length || !records.every(r => this.allowed(r.address))) throw new Error('STREAM_ADDRESS_REJECTED');
    return records[0]!;
  }
  private track(socket: Socket) { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); return socket; }
  private listen() {
    this.server ??= new Promise((done, fail) => {
      const server = createServer((req, res) => {
        // Plain HTTP arrives in absolute form: GET http://host/path.
        let url: URL | undefined;
        try { url = new URL(req.url ?? ''); } catch { /* origin-form: not a proxy request */ }
        if (!url || url.protocol !== 'http:' || url.username || url.password || !['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(400).end(); return; }
        const target = url;
        this.address(target.hostname).then(address => {
          const upstream = httpRequest(target, { method: req.method, headers: forward(req.headers), agent: false,
            lookup: (_host, _options, callback) => callback(null, [{ address: address.address, family: address.family }]) }, response => {
            res.writeHead(response.statusCode ?? 502, forward(response.headers));
            response.on('error', () => res.destroy()).pipe(res);
          });
          upstream.setTimeout(30000, () => upstream.destroy());
          upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
          res.once('close', () => upstream.destroy());
          upstream.end();
        }, () => { res.writeHead(403).end(); });
      });
      // HTTPS: CONNECT host:port, then a raw tunnel to the checked address.
      server.on('connect', (req, client: Socket, head: Buffer) => {
        this.track(client);
        // host:port, parsed directly: URL would drop a default port.
        const target = /^(\[[\da-f:.]+\]|[\w.-]+):(\d{1,5})$/i.exec(req.url ?? ''), port = Number(target?.[2]);
        if (!target || !port || port > 65535) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        this.address(target[1]!).then(address => {
          const upstream = this.track(connect({ host: address.address, port, family: address.family }));
          upstream.setTimeout(30000, () => upstream.destroy());
          upstream.once('connect', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(client); client.pipe(upstream);
          });
          upstream.on('error', () => { if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
          upstream.on('close', () => client.destroy());
          client.on('error', () => upstream.destroy()).on('close', () => upstream.destroy());
        }, () => { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
      });
      server.on('error', fail);
      server.listen(0, '127.0.0.1', () => { server.unref(); done({ server, port: (server.address() as AddressInfo).port }); });
    });
    return this.server;
  }
}

// FFmpeg's environment for one stream: through the guard when there is one. The variable, unlike -http_proxy, reaches
// FFmpeg's TLS layer too (HTTPS is tunnelled through httpproxy) and every HLS request. no_proxy would bypass the proxy for
// matching hosts, so FFmpeg runs without it. Names are matched in any case, as Windows does.
export const protocols = (proxy: string | undefined) => proxy ? 'http,https,tcp,tls,crypto,httpproxy' : 'http,https,tcp,tls,crypto';
export function ffmpegEnv(proxy: string | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'no_proxy' && (!proxy || name.toLowerCase() !== 'http_proxy')));
  return proxy ? { ...kept, http_proxy: proxy } : kept;
}
