import { z } from 'zod';
import type { Db } from '../persistence/database.js';
import type { Vault } from '../security/vault.js';
import { prepared } from '../persistence/statements.js';
import { AppError, requireWritable } from '../errors.js';
import { DownloaderError, Sabnzbd, liveJobs, statuses, type DownloadStatus } from '../providers/sabnzbd.js';
import { Qbittorrent, liveTorrents, torrentStatuses } from '../providers/qbittorrent.js';
import type { ClientItem, DownloaderLive } from '../../../../packages/contracts/src/downloads.js';

// The downloaders (docs/ARR-REPLACEMENT.md, "Clients"): their addresses, sealed secrets and categories. SABnzbd for
// Usenet (phase 1) and qBittorrent for torrents (phase 3).

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
// Omitted keeps a saved API key; an empty string removes it.
export const downloaderInput = z.object({
  url: origin,
  key: z.string().trim().max(200).regex(/^[\w-]*$/).optional(),
  settings: downloaderSettings.partial().optional(),
}).strict();

// What send takes: the release's file (an NZB, or a .torrent with its info hash) and whether it is a movie or a show,
// which picks the category. `seedingMinutes` is qBittorrent's backstop share limit.
export type Download = { kind: 'movie' | 'show'; protocol: 'usenet' | 'torrent'; name: string; file: Buffer; infoHash?: string; seedingMinutes?: number };
export type Sent = { downloader: DownloaderName; downloadId: string; warning?: string };
export type GrabRef = { downloader: DownloaderName | string; downloadId: string };
export type RemoveOptions = { deleteFiles?: boolean };

type Row = { name: DownloaderName; url: string; sealed_secret: string | null; settings: string };
const secretContext = (name: DownloaderName) => `downloaders:${name}-secret`;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export class Downloaders {
  constructor(private db: Db, private vault: Vault, private transport: typeof fetch = fetch) {}

  private row(name: DownloaderName) { return prepared(this.db, 'SELECT * FROM downloaders WHERE name = ?').get(name) as Row | undefined; }
  private settingsOf(row: Row | undefined): DownloaderSettings { return downloaderSettings.parse(row ? JSON.parse(row.settings) : {}); }
  // The sealed API key. A qBittorrent login saved before API keys ({username, password} JSON) counts as none.
  private key(row: Row | undefined) {
    if (!row?.sealed_secret) return undefined;
    try { const key = this.vault.open(row.sealed_secret, secretContext(row.name)); return key.startsWith('{') ? undefined : key; } catch { return undefined; }
  }
  private sabnzbd(): { client: Sabnzbd; settings: DownloaderSettings } | undefined {
    const row = this.row('sabnzbd'), key = this.key(row);
    if (!row?.url || !key) return undefined;
    return { client: new Sabnzbd(row.url, key, this.transport), settings: this.settingsOf(row) };
  }
  // qBittorrent needs an address; a key is optional (its "bypass authentication" needs none).
  private qbittorrent(): { client: Qbittorrent; settings: DownloaderSettings } | undefined {
    const row = this.row('qbittorrent');
    if (!row?.url) return undefined;
    return { client: new Qbittorrent(row.url, this.key(row), this.transport), settings: this.settingsOf(row) };
  }
  private required(name: DownloaderName) {
    const client = name === 'sabnzbd' ? this.sabnzbd() : this.qbittorrent();
    if (!client) throw new AppError('DOWNLOADER_MISSING', `Connect ${name === 'sabnzbd' ? 'SABnzbd' : 'qBittorrent'} in Admin › Connections.`, 409);
    return client;
  }
  private failure(e: unknown): never {
    if (e instanceof DownloaderError) throw new AppError(e.kind === 'auth' ? 'DOWNLOADER_AUTH' : 'DOWNLOADER_FAILED', e.message, 502, e.kind !== 'auth');
    throw e;
  }

  // What Admin shows: never the secret itself.
  view() {
    return downloaderNames.map(name => {
      const row = this.row(name);
      return { name, url: row?.url ?? '', secretSet: !!this.key(row), settings: this.settingsOf(row) };
    });
  }

  configure(actor: string, name: DownloaderName, input: z.input<typeof downloaderInput>, now = Date.now()) {
    const { url, key, settings } = downloaderInput.parse(input);
    if (name === 'qbittorrent' && settings?.priority !== undefined) throw new AppError('DOWNLOADER_INVALID', 'Priority is SABnzbd’s.', 400);
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

  // Admin's Test. SABnzbd: its version, then its queue, which needs the key. qBittorrent: its version, then tk.box's
  // torrents.
  async test(name: DownloaderName) {
    const { client } = this.required(name);
    try {
      if (client instanceof Qbittorrent) {
        const version = await client.version(), list = await client.info();
        return { ok: true as const, detail: `qBittorrent ${version} accepted tk.box; it has ${Array.isArray(list) ? list.length : 0} tk.box torrents.` };
      }
      const version = await client.version();
      await client.queue();
      return { ok: true as const, detail: version ? `SABnzbd ${version} accepted the key.` : 'SABnzbd accepted the key.' };
    } catch (e) {
      if (e instanceof DownloaderError) throw new AppError('DOWNLOADER_TEST_FAILED', e.message, 502);
      throw e;
    }
  }

  // Usenet goes to SABnzbd (mode=addfile); the nzo id is the grab's download_id. A torrent goes to qBittorrent
  // (torrents/add, tagged tk.box) with its seeding backstop; its info hash is the download_id.
  async send(download: Download): Promise<Sent> {
    requireWritable();
    if (download.protocol === 'torrent') {
      if (!download.infoHash) throw new AppError('TORRENT_HASH_MISSING', 'The torrent’s info hash wasn’t read.', 400);
      const { client, settings } = this.required('qbittorrent') as { client: Qbittorrent; settings: DownloaderSettings }, hash = download.infoHash.toLowerCase();
      try { await client.add(download.file, download.name, settings.categories[download.kind], hash); } catch (e) { return this.failure(e); }
      let warning: string | undefined;
      if (download.seedingMinutes) await client.setShareLimits(hash, download.seedingMinutes).catch(e => { warning = `qBittorrent’s share limit wasn’t set: ${errorText(e)}`; });
      return { downloader: 'qbittorrent', downloadId: hash, ...(warning ? { warning } : {}) };
    }
    const { client, settings } = this.required('sabnzbd') as { client: Sabnzbd; settings: DownloaderSettings };
    try {
      const downloadId = await client.addFile(download.file, download.name, settings.categories[download.kind], settings.priority);
      return { downloader: 'sabnzbd', downloadId };
    } catch (e) { return this.failure(e); }
  }

  // Every tk.box download a downloader has (its categories only), as grab states: one downloader's, or every
  // connected one's. Empty for one that isn't connected.
  async status(name?: DownloaderName): Promise<DownloadStatus[]> {
    const out: DownloadStatus[] = [];
    if (!name || name === 'sabnzbd') {
      const sab = this.sabnzbd();
      if (sab) {
        const categories = Object.values(sab.settings.categories);
        try {
          const [queue, history] = await Promise.all([sab.client.queue(), sab.client.history()]);
          out.push(...statuses(queue, history, categories));
        } catch (e) { return this.failure(e); }
      }
    }
    if (!name || name === 'qbittorrent') {
      const qbit = this.qbittorrent();
      if (qbit) {
        try { out.push(...torrentStatuses(await qbit.client.info(), Object.values(qbit.settings.categories))); } catch (e) { return this.failure(e); }
      }
    }
    return out;
  }

  // Admin's live queue: everything each connected downloader has, any category, with its speeds and free space. One
  // that fails is listed with its error and no items; one that isn't connected isn't listed.
  async live(): Promise<{ clients: DownloaderLive[]; items: ClientItem[] }> {
    const sab = this.sabnzbd(), qbit = this.qbittorrent();
    const read = async (name: DownloaderName, run: () => Promise<{ summary: DownloaderLive; items: ClientItem[] }>) => {
      try { return await run(); } catch (e) { return { summary: { name, down: 0, up: 0, error: errorText(e) } as DownloaderLive, items: [] as ClientItem[] }; }
    };
    const reads = await Promise.all([
      ...(sab ? [read('sabnzbd', async () => { const [queue, history] = await Promise.all([sab.client.queue(), sab.client.history(100)]);
        return liveJobs(queue, history, Object.values(sab.settings.categories)); })] : []),
      ...(qbit ? [read('qbittorrent', async () => liveTorrents(await qbit.client.mainData(), Object.values(qbit.settings.categories)))] : []),
    ]);
    return { clients: reads.map(r => r.summary), items: reads.flatMap(r => r.items) };
  }

  // SABnzbd: the job and its folder are deleted (after import, or for a cancelled grab). qBittorrent: the torrent goes,
  // with its downloaded files unless deleteFiles is false; a library copy is a hardlink or a copy, so it stays.
  async remove(grab: GrabRef, options: RemoveOptions = {}) {
    requireWritable();
    if (grab.downloader === 'qbittorrent') {
      const { client } = this.required('qbittorrent') as { client: Qbittorrent };
      try { await client.delete(grab.downloadId, options.deleteFiles ?? true); } catch (e) { this.failure(e); }
      return;
    }
    const { client } = this.required('sabnzbd') as { client: Sabnzbd };
    try { await client.delete(grab.downloadId); } catch (e) { this.failure(e); }
  }
}
