import { z } from 'zod';
import { RestrictedSourceFetcher } from './source-fetch.js';

// Standardized station logos from the community tv-logo/tv-logos repository, fetched at
// runtime (never vendored). Files are countries/<country>/<slug>-<cc>.png; only exact slug
// matches are used, because a confidently wrong logo is worse than the provider's own.
const repo = 'tv-logo/tv-logos', raw = `https://raw.githubusercontent.com/${repo}/main/`;
const tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string() })) });
export function logoSlug(name: string) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^[a-z]{2,3}\s*[:|]\s*/, '')          // "US: CNN"
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')            // "(D)", "[VIP]"
    .replace(/\+/g, ' plus ').replace(/&/g, ' and ')
    .replace(/\b(?:f?hd|uhd|4k|sd|hevc|h265|backup|east|feed)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
export function logoRegion(name: string, tvgId: string) {
  return (/^([A-Za-z]{2})\s*[:|]/.exec(name)?.[1] ?? /\.([a-z]{2})$/i.exec(tvgId)?.[1])?.toLowerCase();
}
export class LogoLibrary {
  private index?: { byRegion: Map<string, string>; anywhere: Map<string, string | null> };
  private loading?: Promise<void>;
  private loadedAt = 0;
  constructor(private fetcher: Pick<RestrictedSourceFetcher, 'fetch'> = new RestrictedSourceFetcher(), private ttlMs = 86400000, private retryMs = 3600000) {}
  async match(name: string, tvgId: string): Promise<string | undefined> {
    await this.load();
    const index = this.index, slug = logoSlug(name), region = logoRegion(name, tvgId);
    if (!index || !slug) return undefined;
    const path = region ? index.byRegion.get(`${region}:${slug}`) ?? index.byRegion.get(`${region}:${slug}-1`) : index.anywhere.get(slug) ?? undefined;
    return path ? raw + path.split('/').map(encodeURIComponent).join('/') : undefined;
  }
  private load() {
    if (Date.now() - this.loadedAt < (this.index ? this.ttlMs : this.retryMs)) return this.loading ?? Promise.resolve();
    this.loadedAt = Date.now();
    this.loading = this.fetcher.fetch({ url: `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, headers: { 'user-agent': 'tk.box', accept: 'application/vnd.github+json' }, allowInsecureHttp: false })
      .then(bytes => {
        const byRegion = new Map<string, string>(), anywhere = new Map<string, string | null>();
        for (const entry of tree.parse(JSON.parse(bytes.toString('utf8'))).tree) {
          // Top-level country files only; hd/ and obsolete/ variants are skipped.
          const m = /^countries\/[a-z0-9-]+\/([a-z0-9-]+)-([a-z]{2})\.png$/.exec(entry.path);
          if (entry.type !== 'blob' || !m) continue;
          byRegion.set(`${m[2]}:${m[1]}`, entry.path);
          anywhere.set(m[1]!, anywhere.has(m[1]!) ? null : entry.path); // ambiguous across countries
        }
        this.index = { byRegion, anywhere };
      }, () => {})
      .finally(() => { this.loading = undefined; });
    return this.loading;
  }
}
