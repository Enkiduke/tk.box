import { ArtworkCache } from './artwork-cache.js';
import { AppError, requireThat } from '../errors.js';

// Explore artwork comes from TMDB, Plex's metadata hosts and Trakt. The page may load images only from this server,
// so they are proxied, and only from these hosts.
const allowed = (host: string) => host === 'image.tmdb.org' || host === 'flagcdn.com' || host.endsWith('.plex.tv') || host === 'plex.tv' || host.endsWith('.trakt.tv');
export const imagePath = (url: string | undefined) => {
  if (!url) return undefined;
  try { const u = new URL(url); return u.protocol === 'https:' && allowed(u.hostname) ? `/api/v1/explore/image?u=${encodeURIComponent(u.href)}` : undefined; } catch { return undefined; }
};
// A country's flag, by ISO 3166-1 code; Windows draws flag emoji as letters.
export const flagImage = (code: string | undefined) => code && /^[A-Za-z]{2}$/.test(code) ? imagePath(`https://flagcdn.com/w40/${code.toLowerCase()}.png`) : undefined;
export const tmdbImage = (path: string | null | undefined, size: string) => path && /^\/[\w.-]+$/.test(path) ? imagePath(`https://image.tmdb.org/t/p/${size}${path}`) : undefined;
// Plex's own photo resizer, as Plex Web uses it for Discover artwork.
export const plexPhoto = (url: string | undefined, width: number, height: number) => {
  if (!url || !/^https:\/\//.test(url)) return undefined;
  const q = new URLSearchParams({ width: String(width), height: String(height), minSize: '1', upscale: '1', url });
  return imagePath(`https://images.plex.tv/photo?${q}`);
};

export class ExploreImages {
  private cache = new ArtworkCache(48 * 1024 * 1024, 600, 3600000);
  private pending = new Map<string, Promise<{ bytes: Buffer; type: string }>>();
  constructor(private transport: typeof fetch = fetch) {}
  get(raw: string) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new AppError('INVALID_IMAGE', 'Invalid image address.'); }
    requireThat(url.protocol === 'https:' && allowed(url.hostname) && !url.username && !url.password, 'INVALID_IMAGE', 'Images are only loaded from catalog hosts.');
    const hit = this.cache.get(url.href); if (hit) return Promise.resolve(hit);
    let pending = this.pending.get(url.href);
    if (!pending) {
      pending = this.load(url).then(image => { this.cache.set(url.href, image); return image; }).finally(() => this.pending.delete(url.href));
      this.pending.set(url.href, pending);
    }
    return pending;
  }
  private async load(url: URL) {
    let response: Response;
    try { response = await this.transport(url, { redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new AppError('ARTWORK_UNAVAILABLE', 'Artwork could not be loaded.', 502); }
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok || !type || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) { await response.body?.cancel(); throw new AppError('ARTWORK_NOT_FOUND', 'Artwork is unavailable.', 404); }
    const reader = response.body?.getReader(); requireThat(reader, 'ARTWORK_NOT_FOUND', 'Artwork is unavailable.', 404);
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; requireThat(size <= 6 * 1024 * 1024, 'ARTWORK_LIMIT', 'Artwork exceeded its size limit.', 502); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    requireThat(size > 0, 'ARTWORK_NOT_FOUND', 'Artwork is unavailable.', 404);
    return { bytes: Buffer.concat(chunks), type };
  }
}
