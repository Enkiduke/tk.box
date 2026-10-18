import { lookup } from 'node:dns/promises';
import { gunzipSync } from 'node:zlib';
import { isIP } from 'node:net';
import { AppError, requireThat } from '../errors.js';
import { ArtworkCache } from './artwork-cache.js';
import { exchangeSource, publicAddress, type SourceExchange } from './source-fetch.js';

const types: Record<string, string> = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/webp': 'image/webp', 'image/gif': 'image/gif' };
// Channel logos from the playlist, fetched server-side so the browser never sees provider URLs.
// Every hop must resolve only to public addresses; SVG is refused because it can carry script.
export class ChannelLogos {
  private cache = new ArtworkCache(24 * 1024 * 1024, 512, 6 * 3600000);
  private failed = new Map<string, number>();
  private pending = new Map<string, Promise<{ type: string; bytes: Buffer }>>();
  constructor(private resolve: (host: string) => Promise<{ address: string; family: number }[]> = host => lookup(host, { all: true, verbatim: true }), private exchange: SourceExchange = exchangeSource) {}
  get(url: string) {
    const cached = this.cache.get(url); if (cached) return Promise.resolve(cached);
    requireThat((this.failed.get(url) ?? 0) < Date.now(), 'LOGO_UNAVAILABLE', 'Logo unavailable.', 404);
    let work = this.pending.get(url);
    if (!work) {
      work = this.fetch(url).then(image => { this.cache.set(url, image); return image; }, e => { this.failed.set(url, Date.now() + 600000); throw e; }).finally(() => this.pending.delete(url));
      this.pending.set(url, work);
    }
    return work;
  }
  private async fetch(input: string) {
    const signal = AbortSignal.timeout(10000);
    let url = new URL(input);
    try {
      for (let hop = 0; hop <= 3; hop++) {
        requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'LOGO_UNAVAILABLE', 'Logo unavailable.', 404);
        const host = url.hostname.replace(/^\[|\]$/g, ''), records = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.resolve(host);
        requireThat(records.length && records.every(r => publicAddress(r.address)), 'LOGO_UNAVAILABLE', 'Logo unavailable.', 404);
        const response = await this.exchange(url, records[0]!, { 'user-agent': 'Mozilla/5.0', accept: 'image/*' }, signal);
        if ([301, 302, 303, 307, 308].includes(response.status) && typeof response.headers.location === 'string') { url = new URL(response.headers.location, url); continue; }
        const type = types[String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()];
        requireThat(response.status === 200 && response.complete && type && response.body.length > 0 && response.body.length <= 1024 * 1024, 'LOGO_UNAVAILABLE', 'Logo unavailable.', 404);
        const encoding = response.headers['content-encoding'];
        requireThat(!encoding || encoding === 'identity' || encoding === 'gzip', 'LOGO_UNAVAILABLE', 'Logo unavailable.', 404);
        return { type, bytes: encoding === 'gzip' ? gunzipSync(response.body, { maxOutputLength: 1024 * 1024 }) : response.body };
      }
    } catch (e) { if (e instanceof AppError) throw e; }
    throw new AppError('LOGO_UNAVAILABLE', 'Logo unavailable.', 404);
  }
}
