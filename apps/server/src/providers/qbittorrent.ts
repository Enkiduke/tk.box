import { DownloaderError } from './sabnzbd.js';
import type { ClientCheck, DownloadStatus } from './download-status.js';
import type { ClientItem, ClientState, ClientSummary } from '../../../../packages/contracts/src/downloads.js';

// qBittorrent's WebUI API v2 (docs/ARR-REPLACEMENT.md, "Clients" › qBittorrent): authenticated by its API key, add a .torrent in tk-movies or tk-tv tagged tk.box, set its share limits as a backstop,
// read torrents/info as grab states with the seeding figures, and delete a torrent.

export const TAG = 'tk.box';
// Finished and seeding (or stopped after seeding): ready to import at progress 1. qBittorrent 5 says stopped for paused.
const SEEDING = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP']);
// Waiting on qBittorrent itself, not on peers: the no-progress clock doesn't run.
const WAITING = new Set(['queuedDL', 'pausedDL', 'stoppedDL', 'checkingDL', 'checkingUP', 'checkingResumeData', 'moving', 'allocating']);
const BROKEN = new Set(['error', 'missingFiles']);
const METADATA = new Set(['metaDL', 'forcedMetaDL']);

type Json = Record<string, unknown>;
const text = (v: unknown) => typeof v === 'string' ? v : undefined;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

// torrents/info: each tk.box torrent in tk.box's categories, as a grab state. The download id is the info hash.
export function torrentStatuses(json: unknown, categories: readonly string[]): DownloadStatus[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((t): DownloadStatus[] => {
    if (!t || typeof t !== 'object') return [];
    const row = t as Json, hash = text(row.hash)?.toLowerCase(), category = text(row.category) ?? '', state = text(row.state) ?? 'unknown';
    if (!hash || !categories.includes(category)) return [];
    const progress = Math.min(1, Math.max(0, num(row.progress) ?? 0)), size = num(row.size) ?? num(row.total_size);
    const contentPath = text(row.content_path), ratio = num(row.ratio), seeding = num(row.seeding_time);
    const left = num(row.amount_left), seeds = num(row.num_seeds), swarm = num(row.num_complete), availability = num(row.availability);
    const base: DownloadStatus = { downloader: 'qbittorrent', downloadId: hash, name: text(row.name) ?? hash, category, state: 'downloading', progress, torrentState: state,
      ...(size !== undefined && size > 0 ? { size } : {}), ...(contentPath ? { storage: contentPath } : {}),
      ...(ratio !== undefined ? { ratio: Math.max(0, ratio) } : {}), ...(seeding !== undefined ? { seedingSeconds: seeding } : {}),
      ...(left !== undefined && left >= 0 ? { left } : {}), ...(seeds !== undefined && seeds >= 0 ? { seeds } : {}), ...(swarm !== undefined && swarm >= 0 ? { swarmSeeds: swarm } : {}),
      // -1: not known yet.
      ...(availability !== undefined && availability >= 0 ? { availability } : {}), ...(METADATA.has(state) ? { metadata: true } : {}) };
    if (BROKEN.has(state)) return [{ ...base, state: 'failed', error: state === 'missingFiles' ? 'qBittorrent lost the torrent’s files.' : 'qBittorrent reports an error for the torrent.' }];
    if (SEEDING.has(state) && progress >= 1) return [{ ...base, state: 'importing' }];
    return [{ ...base, ...(WAITING.has(state) ? { waiting: true } : {}) }];
  });
}

// qBittorrent's states as tk.box words, with qBittorrent's own when it says more.
const LIVE: Record<string, [ClientState, string?]> = {
  downloading: ['downloading'], forcedDL: ['downloading', 'Forced'], metaDL: ['downloading', 'Fetching metadata'], forcedMetaDL: ['downloading', 'Fetching metadata'],
  stalledDL: ['stalled'], queuedDL: ['queued'], pausedDL: ['paused'], stoppedDL: ['paused'],
  checkingDL: ['checking'], checkingUP: ['checking'], checkingResumeData: ['checking', 'Checking resume data'], allocating: ['checking', 'Allocating'], moving: ['moving'],
  uploading: ['seeding'], forcedUP: ['seeding', 'Forced'], stalledUP: ['seeding', 'No peers'], queuedUP: ['seeding', 'Queued'],
  pausedUP: ['completed', 'Stopped'], stoppedUP: ['completed', 'Stopped'],
  error: ['failed'], missingFiles: ['failed'],
};
const ETA_NONE = 8640000;
const host = (url: string | undefined) => { if (!url) return undefined; try { return new URL(url).hostname.replace(/^(www|tracker|announce)\./, ''); } catch { return undefined; } };
const secs = (v: unknown) => { const n = num(v); return n !== undefined && n > 0 ? n * 1000 : undefined; };

// sync/maindata: every torrent qBittorrent has (any category), and its transfer figures. `mine`: in a tk.box category
// or tagged tk.box.
export function liveTorrents(json: unknown, categories: readonly string[]): { summary: ClientSummary; items: ClientItem[] } {
  const data = (json && typeof json === 'object' ? json : {}) as Json;
  const server = (data.server_state && typeof data.server_state === 'object' ? data.server_state : {}) as Json;
  const torrents = data.torrents && typeof data.torrents === 'object' ? Object.entries(data.torrents as Json) : [];
  const items = torrents.flatMap(([hash, t]): ClientItem[] => {
    if (!t || typeof t !== 'object') return [];
    const row = t as Json, raw = text(row.state) ?? 'unknown', [state, detail] = LIVE[raw] ?? ['queued', raw];
    const category = text(row.category) ?? '', tags = (text(row.tags) ?? '').split(',').map(x => x.trim());
    const progress = Math.min(1, Math.max(0, num(row.progress) ?? 0)), size = num(row.size) || num(row.total_size), left = num(row.amount_left);
    const eta = num(row.eta), position = num(row.priority), down = num(row.dlspeed), up = num(row.upspeed);
    const error = state === 'failed' ? raw === 'missingFiles' ? 'qBittorrent lost the torrent’s files.' : 'qBittorrent reports an error for the torrent.' : undefined;
    const item: ClientItem = { downloader: 'qbittorrent', id: hash.toLowerCase(), name: text(row.name) ?? hash, protocol: 'torrent', state, progress,
      mine: categories.includes(category) || tags.includes(TAG),
      ...(detail ? { detail } : {}), ...(size ? { size } : {}), ...(left !== undefined && progress < 1 ? { left } : {}),
      ...(down ? { down } : {}), ...(up ? { up } : {}), ...(eta !== undefined && eta > 0 && eta < ETA_NONE && progress < 1 ? { eta } : {}),
      ...(position !== undefined && position > 0 && progress < 1 ? { position } : {}),
      ...(num(row.num_seeds) !== undefined ? { seeds: num(row.num_seeds)! } : {}), ...(num(row.num_complete) !== undefined ? { seedsTotal: Math.max(0, num(row.num_complete)!) } : {}),
      ...(num(row.num_leechs) !== undefined ? { peers: num(row.num_leechs)! } : {}), ...(num(row.num_incomplete) !== undefined ? { peersTotal: Math.max(0, num(row.num_incomplete)!) } : {}),
      ...(num(row.ratio) !== undefined ? { ratio: Math.max(0, num(row.ratio)!) } : {}), ...(num(row.seeding_time) ? { seedingSeconds: num(row.seeding_time)! } : {}),
      ...(host(text(row.tracker)) ? { tracker: host(text(row.tracker))! } : {}), ...(category ? { category } : {}),
      ...(secs(row.added_on) ? { addedAt: secs(row.added_on)! } : {}), ...(progress >= 1 && secs(row.completion_on) ? { finishedAt: secs(row.completion_on)! } : {}),
      ...(error ? { error } : {}) };
    return [item];
  });
  const free = num(server.free_space_on_disk);
  return { summary: { name: 'qbittorrent', down: num(server.dl_info_speed) ?? 0, up: num(server.up_info_speed) ?? 0, ...(free !== undefined ? { free } : {}) }, items };
}

// The no-progress clock: it starts again whenever progress moves or qBittorrent itself holds the torrent (queued,
// paused, checking). `progressAt` is when progress last moved (the send, at first); an Only source download that
// hasn't moved for two hours fails (docs/STALLS.md, "Ceiling").
export function stallClock(previous: { progress?: number; progressAt?: number }, status: Pick<DownloadStatus, 'progress' | 'waiting'>, now: number) {
  const moved = (status.progress ?? 0) > (previous.progress ?? 0) + 1e-6;
  const progressAt = status.waiting || moved || previous.progressAt === undefined ? now : previous.progressAt;
  return { progressAt, stalledMs: now - progressAt };
}

export class Qbittorrent {
  // qBittorrent 5.2+'s WebUI API key, sent as a Bearer token. No key: "Bypass authentication" (localhost or a
  // whitelisted subnet) lets requests through without one.
  constructor(private url: string, private apiKey: string | undefined, private transport: typeof fetch = fetch, private timeoutMs = 30000) {}

  private endpoint(path: string) { return `${this.url.replace(/\/+$/, '')}/api/v2/${path}`; }
  private async fetch(path: string, init: { method?: string; body?: FormData | URLSearchParams } = {}) {
    const headers: Record<string, string> = { 'User-Agent': 'tk.box/0.0.1', Referer: this.url.replace(/\/+$/, '') + '/' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      return await this.transport(this.endpoint(path), { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, ...(init.body ? { body: init.body } : {}),
        redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new DownloaderError('unreachable', 'qBittorrent could not be reached.'); }
  }

  private async call(path: string, init: { method?: string; body?: FormData | URLSearchParams } = {}): Promise<string> {
    const response = await this.fetch(path, init);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new DownloaderError('auth', this.apiKey ? 'qBittorrent refused the API key (it needs qBittorrent 5.2 or later).' : 'qBittorrent wants an API key: make one in its WebUI settings.');
    }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new DownloaderError('other', 'qBittorrent redirected the request. Check its address.'); }
    const body = await response.text();
    if (body.length > 32 * 1024 * 1024) throw new DownloaderError('other', 'qBittorrent sent too much data.');
    if (response.status >= 400) throw new DownloaderError('other', `qBittorrent answered ${response.status}${body.trim() ? `: ${body.trim().slice(0, 200)}` : ''}.`);
    return body;
  }
  private async json(path: string): Promise<unknown> {
    const body = await this.call(path);
    try { return JSON.parse(body); } catch { throw new DownloaderError('other', 'qBittorrent answered without JSON.'); }
  }

  async version() { return (await this.call('app/version')).trim(); }
  // tk.box's torrents only (the tk.box tag).
  info() { return this.json(`torrents/info?tag=${encodeURIComponent(TAG)}`); }
  // Every torrent and the transfer figures, for Admin's live queue.
  mainData() { return this.json('sync/maindata'); }

  // Whether qBittorrent is connected and its alternative speed limits are off (docs/STALLS.md, "Making sure it's a
  // dud"): two small calls, made only when a download looks dead or slow. Firewalled still downloads, so it counts
  // as connected.
  async check(): Promise<ClientCheck> {
    const [transfer, mode] = await Promise.all([this.json('transfer/info'), this.call('transfer/speedLimitsMode')]);
    const status = transfer && typeof transfer === 'object' ? text((transfer as Json).connection_status) : undefined;
    return { connected: status !== 'disconnected', throttled: mode.trim() === '1' };
  }
  // Asks the trackers for fresh peers now, rather than at the tracker's next interval.
  async reannounce(infoHash: string) {
    await this.call('torrents/reannounce', { body: new URLSearchParams({ hashes: infoHash }) });
  }

  // The category is made first when qBittorrent doesn't have it (with qBittorrent's default save path).
  private async ensureCategory(category: string) {
    const categories = await this.json('torrents/categories');
    if (categories && typeof categories === 'object' && category in (categories as Json)) return;
    await this.call('torrents/createCategory', { body: new URLSearchParams({ category, savePath: '' }) }).catch(e => {
      // 409: someone made it in between.
      if (!(e instanceof DownloaderError && /409/.test(e.message))) throw e;
    });
  }

  // torrents/add with the file, the category and the tk.box tag. "Fails." also comes for a torrent qBittorrent already
  // has; that is fine when it lists the hash.
  async add(file: Buffer, name: string, category: string, infoHash: string) {
    await this.ensureCategory(category);
    const form = new FormData();
    form.append('torrents', new Blob([new Uint8Array(file)], { type: 'application/x-bittorrent' }), name.endsWith('.torrent') ? name : `${name}.torrent`);
    form.append('category', category);
    form.append('tags', TAG);
    const body = (await this.call('torrents/add', { body: form })).trim();
    if (body === 'Ok.') return;
    const listed = await this.json(`torrents/info?hashes=${infoHash}`);
    if (Array.isArray(listed) && listed.length) return;
    throw new DownloaderError('other', `qBittorrent didn’t take the torrent${body ? ` (${body})` : ''}.`);
  }

  // The backstop qBittorrent enforces while tk.box is down: it pauses (never deletes) after this long seeding. No ratio
  // limit: a ratio limit alone would pause it before the minimum seeding time.
  async setShareLimits(infoHash: string, seedingMinutes: number) {
    await this.call('torrents/setShareLimits', { body: new URLSearchParams({ hashes: infoHash, ratioLimit: '-1', seedingTimeLimit: String(Math.round(seedingMinutes)), inactiveSeedingTimeLimit: '-2' }) });
  }

  async delete(infoHash: string, deleteFiles: boolean) {
    await this.call('torrents/delete', { body: new URLSearchParams({ hashes: infoHash, deleteFiles: deleteFiles ? 'true' : 'false' }) });
  }
}
