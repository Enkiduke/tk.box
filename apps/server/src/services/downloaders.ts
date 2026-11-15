import { z } from 'zod';
import type { Db } from '../persistence/database.js';
import type { Vault } from '../security/vault.js';
import { prepared } from '../persistence/statements.js';
import { AppError, requireWritable } from '../errors.js';
import { DownloaderError, Sabnzbd, statuses, type DownloadStatus } from '../providers/sabnzbd.js';
import { Qbittorrent, torrentStatuses, type QbitLogin } from '../providers/qbittorrent.js';

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
// Omitted keeps a saved key (or qBittorrent username, password); an empty string removes it.
export const downloaderInput = z.object({
  url: origin,
  key: z.string().trim().max(200).regex(/^[\w-]*$/).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
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
  // One qBittorrent client per saved address and login, so its SID cookie is kept between calls.
  private qbitClient?: { key: string; client: Qbittorrent };
  constructor(private db: Db, private vault: Vault, private transport: typeof fetch = fetch) {}

  private row(name: DownloaderName) { return prepared(this.db, 'SELECT * FROM downloaders WHERE name = ?').get(name) as Row | undefined; }
  private settingsOf(row: Row | undefined): DownloaderSettings { return downloaderSettings.parse(row ? JSON.parse(row.settings) : {}); }
  private qbitLogin(row: Row | undefined): Partial<QbitLogin> {
    if (!row?.sealed_secret || row.name !== 'qbittorrent') return {};
    try { return JSON.parse(this.vault.open(row.sealed_secret, secretContext('qbittorrent'))) as Partial<QbitLogin>; } catch { return {}; }
  }
  private sabnzbd(): { client: Sabnzbd; settings: DownloaderSettings } | undefined {
    const row = this.row('sabnzbd');
    if (!row?.url || !row.sealed_secret) return undefined;
    return { client: new Sabnzbd(row.url, this.vault.open(row.sealed_secret, secretContext('sabnzbd')), this.transport), settings: this.settingsOf(row) };
  }
  // qBittorrent needs an address; a login is optional (its "bypass for localhost" needs none).
  private qbittorrent(): { client: Qbittorrent; settings: DownloaderSettings } | undefined {
    const row = this.row('qbittorrent');
    if (!row?.url) return undefined;
    const key = `${row.url}\n${row.sealed_secret ?? ''}`;
    if (this.qbitClient?.key !== key) {
      const login = this.qbitLogin(row);
      this.qbitClient = { key, client: new Qbittorrent(row.url, { username: login.username ?? '', password: login.password ?? '' }, this.transport) };
    }
    return { client: this.qbitClient.client, settings: this.settingsOf(row) };
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

  // What Admin shows: never the secret itself (qBittorrent's username isn't secret, so it is shown).
  view() {
    return downloaderNames.map(name => {
      const row = this.row(name);
      const login = name === 'qbittorrent' ? this.qbitLogin(row) : undefined;
      return { name, url: row?.url ?? '', secretSet: !!row?.sealed_secret, settings: this.settingsOf(row),
        ...(login ? { qbittorrent: { username: login.username ?? '', passwordSet: !!login.password } } : {}) };
    });
  }

  configure(actor: string, name: DownloaderName, input: z.input<typeof downloaderInput>, now = Date.now()) {
    const { url, key, username, password, settings } = downloaderInput.parse(input);
    if (name === 'sabnzbd' && (username !== undefined || password !== undefined)) throw new AppError('DOWNLOADER_INVALID', 'SABnzbd takes an API key only.', 400);
    if (name === 'qbittorrent' && key !== undefined) throw new AppError('DOWNLOADER_INVALID', 'qBittorrent takes a username and password.', 400);
    if (name === 'qbittorrent' && settings?.priority !== undefined) throw new AppError('DOWNLOADER_INVALID', 'Priority is SABnzbd’s.', 400);
    this.db.transaction(() => {
      const row = this.row(name);
      const merged = downloaderSettings.parse({ ...this.settingsOf(row), ...settings });
      let sealed: string | null;
      if (name === 'qbittorrent') {
        const next: Partial<QbitLogin> = { ...this.qbitLogin(row) };
        for (const [field, value] of [['username', username], ['password', password]] as const) {
          if (value === undefined) continue;
          if (value) next[field] = value; else delete next[field];
        }
        sealed = Object.keys(next).length ? this.vault.seal(JSON.stringify(next), secretContext(name)) : null;
      } else sealed = key === undefined ? row?.sealed_secret ?? null : key ? this.vault.seal(key, secretContext(name)) : null;
      prepared(this.db, `INSERT INTO downloaders(name, url, sealed_secret, settings) VALUES(?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET url = excluded.url, sealed_secret = excluded.sealed_secret, settings = excluded.settings`)
        .run(name, url, sealed, JSON.stringify(merged));
      prepared(this.db, 'INSERT INTO audit(actor, event, at, detail) VALUES(?, ?, ?, ?)')
        .run(actor, 'downloader_changed', now, JSON.stringify({ name, url, secretSet: !!sealed, settings: merged }));
    })();
    return this.view().find(v => v.name === name)!;
  }

  // Admin's Test. SABnzbd: its version, then its queue, which needs the key. qBittorrent: sign in, its version, then
  // tk.box's torrents.
  async test(name: DownloaderName) {
    const { client } = this.required(name);
    try {
      if (client instanceof Qbittorrent) {
        await client.signIn();
        const version = await client.version(), list = await client.info();
        return { ok: true as const, detail: `qBittorrent ${version} signed tk.box in; it has ${Array.isArray(list) ? list.length : 0} tk.box torrents.` };
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
