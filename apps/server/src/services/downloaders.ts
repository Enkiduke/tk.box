import { z } from 'zod';
import type { Db } from '../persistence/database.js';
import type { Vault } from '../security/vault.js';
import { prepared } from '../persistence/statements.js';
import { AppError, requireWritable } from '../errors.js';
import { DownloaderError, Sabnzbd, statuses, type DownloadStatus } from '../providers/sabnzbd.js';

// The downloaders (docs/ARR-REPLACEMENT.md, "Clients"): their addresses, sealed secrets and categories. Phase 1 has
// SABnzbd only; qBittorrent comes with phase 3.

export const downloaderNames = ['sabnzbd', 'qbittorrent'] as const;
export type DownloaderName = typeof downloaderNames[number];

const category = z.string().trim().min(1).max(60).regex(/^[\w.-]+$/);
export const downloaderSettings = z.object({
  categories: z.object({ movie: category.default('tk-movies'), show: category.default('tk-tv') }).strict().default({ movie: 'tk-movies', show: 'tk-tv' }),
  // SABnzbd's priority: -1 low, 0 normal, 1 high, 2 force. Unset keeps the category's own.
  priority: z.number().int().min(-1).max(2).optional(),
}).strict();
export type DownloaderSettings = z.infer<typeof downloaderSettings>;
const origin = z.string().trim().max(300).refine(value => { if (!value) return true; try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }, 'Use an http(s) address').transform(value => value.replace(/\/+$/, ''));
// Omitted keeps a saved key; an empty string removes it.
export const downloaderInput = z.object({ url: origin, key: z.string().trim().max(200).regex(/^[\w-]*$/).optional(), settings: downloaderSettings.partial().optional() }).strict();

// What send takes: the release's file (an NZB here) and whether it is a movie or a show, which picks the category.
export type Download = { kind: 'movie' | 'show'; protocol: 'usenet'; name: string; file: Buffer };
export type Sent = { downloader: DownloaderName; downloadId: string };
export type GrabRef = { downloader: DownloaderName; downloadId: string };

type Row = { name: DownloaderName; url: string; sealed_secret: string | null; settings: string };
const secretContext = (name: DownloaderName) => `downloaders:${name}-secret`;

export class Downloaders {
  constructor(private db: Db, private vault: Vault, private transport: typeof fetch = fetch) {}

  private row(name: DownloaderName) { return prepared(this.db, 'SELECT * FROM downloaders WHERE name = ?').get(name) as Row | undefined; }
  private settingsOf(row: Row | undefined): DownloaderSettings { return downloaderSettings.parse(row ? JSON.parse(row.settings) : {}); }
  private sabnzbd(): { client: Sabnzbd; settings: DownloaderSettings } | undefined {
    const row = this.row('sabnzbd');
    if (!row?.url || !row.sealed_secret) return undefined;
    return { client: new Sabnzbd(row.url, this.vault.open(row.sealed_secret, secretContext('sabnzbd')), this.transport), settings: this.settingsOf(row) };
  }
  private required() {
    const sab = this.sabnzbd();
    if (!sab) throw new AppError('DOWNLOADER_MISSING', 'Connect SABnzbd in Admin › Downloads.', 409);
    return sab;
  }
  private failure(e: unknown): never {
    if (e instanceof DownloaderError) throw new AppError(e.kind === 'auth' ? 'DOWNLOADER_AUTH' : 'DOWNLOADER_FAILED', e.message, 502, e.kind !== 'auth');
    throw e;
  }

  // What Admin shows (phase 1c): never the secret itself.
  view() {
    return downloaderNames.map(name => { const row = this.row(name); return { name, url: row?.url ?? '', secretSet: !!row?.sealed_secret, settings: this.settingsOf(row) }; });
  }

  configure(actor: string, name: DownloaderName, input: z.input<typeof downloaderInput>, now = Date.now()) {
    if (name !== 'sabnzbd') throw new AppError('DOWNLOADER_UNSUPPORTED', 'qBittorrent comes with phase 3.', 409);
    const { url, key, settings } = downloaderInput.parse(input);
    this.db.transaction(() => {
      const row = this.row(name);
      const merged = downloaderSettings.parse({ ...this.settingsOf(row), ...settings });
      const sealed = key === undefined ? row?.sealed_secret ?? null : key ? this.vault.seal(key, secretContext(name)) : null;
      prepared(this.db, `INSERT INTO downloaders(name, url, sealed_secret, settings) VALUES(?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET url = excluded.url, sealed_secret = excluded.sealed_secret, settings = excluded.settings`)
        .run(name, url, sealed, JSON.stringify(merged));
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)')
        .run(actor, 'downloader_changed', now, JSON.stringify({ name, url, secretSet: !!sealed, settings: merged }));
    })();
    return this.view().find(v => v.name === name)!;
  }

  // Admin's Test: SABnzbd's version, then its queue, which needs the key.
  async test(name: DownloaderName) {
    if (name !== 'sabnzbd') throw new AppError('DOWNLOADER_UNSUPPORTED', 'qBittorrent comes with phase 3.', 409);
    const { client } = this.required();
    try {
      const version = await client.version();
      await client.queue();
      return { ok: true as const, detail: version ? `SABnzbd ${version} accepted the key.` : 'SABnzbd accepted the key.' };
    } catch (e) {
      if (e instanceof DownloaderError) throw new AppError('DOWNLOADER_TEST_FAILED', e.message, 502);
      throw e;
    }
  }

  // Sends a Usenet release to SABnzbd (mode=addfile) in tk-movies or tk-tv. The answer's nzo id is the grab's download_id.
  async send(download: Download): Promise<Sent> {
    requireWritable();
    if (download.protocol !== 'usenet') throw new AppError('DOWNLOADER_UNSUPPORTED', 'Torrents come with phase 3.', 409);
    const { client, settings } = this.required();
    try {
      const downloadId = await client.addFile(download.file, download.name, settings.categories[download.kind], settings.priority);
      return { downloader: 'sabnzbd', downloadId };
    } catch (e) { return this.failure(e); }
  }

  // Every tk.box job SABnzbd has (its categories only), as grab states. Empty when SABnzbd isn't connected.
  async status(): Promise<DownloadStatus[]> {
    const sab = this.sabnzbd();
    if (!sab) return [];
    const categories = Object.values(sab.settings.categories);
    try {
      const [queue, history] = await Promise.all([sab.client.queue(), sab.client.history()]);
      return statuses(queue, history, categories);
    } catch (e) { return this.failure(e); }
  }

  // After import (or for a cancelled grab): the job and its folder are deleted.
  async remove(grab: GrabRef) {
    requireWritable();
    if (grab.downloader !== 'sabnzbd') throw new AppError('DOWNLOADER_UNSUPPORTED', 'Torrents come with phase 3.', 409);
    const { client } = this.required();
    try { await client.delete(grab.downloadId); } catch (e) { this.failure(e); }
  }
}
