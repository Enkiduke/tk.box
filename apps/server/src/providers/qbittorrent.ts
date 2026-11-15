import { DownloaderError } from './sabnzbd.js';
import type { DownloadStatus } from './download-status.js';

// qBittorrent's WebUI API v2 (docs/ARR-REPLACEMENT.md, "Clients" › qBittorrent): sign in once and keep the SID cookie
// (signing in again on a 403), add a .torrent in tk-movies or tk-tv tagged tk.box, set its share limits as a backstop,
// read torrents/info as grab states with the seeding figures, and delete a torrent.

export const TAG = 'tk.box';
// Finished and seeding (or stopped after seeding): ready to import at progress 1. qBittorrent 5 says stopped for paused.
const SEEDING = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP']);
// Waiting on qBittorrent itself, not on peers: the no-progress clock doesn't run.
const WAITING = new Set(['queuedDL', 'pausedDL', 'stoppedDL', 'checkingDL', 'checkingUP', 'checkingResumeData', 'moving', 'allocating']);
const BROKEN = new Set(['error', 'missingFiles']);

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
    const base: DownloadStatus = { downloader: 'qbittorrent', downloadId: hash, name: text(row.name) ?? hash, category, state: 'downloading', progress, torrentState: state,
      ...(size !== undefined && size > 0 ? { size } : {}), ...(contentPath ? { storage: contentPath } : {}),
      ...(ratio !== undefined ? { ratio: Math.max(0, ratio) } : {}), ...(seeding !== undefined ? { seedingSeconds: seeding } : {}) };
    if (BROKEN.has(state)) return [{ ...base, state: 'failed', error: state === 'missingFiles' ? 'qBittorrent lost the torrent’s files.' : 'qBittorrent reports an error for the torrent.' }];
    if (SEEDING.has(state) && progress >= 1) return [{ ...base, state: 'importing' }];
    return [{ ...base, ...(WAITING.has(state) ? { waiting: true } : {}) }];
  });
}

// The no-progress clock (the stalled rule): it starts again whenever progress moves or qBittorrent itself holds the
// torrent (queued, paused, checking). `progressAt` is when progress last moved (the send, at first).
export function stallClock(previous: { progress?: number; progressAt?: number }, status: Pick<DownloadStatus, 'progress' | 'waiting'>, now: number) {
  const moved = (status.progress ?? 0) > (previous.progress ?? 0) + 1e-6;
  const progressAt = status.waiting || moved || previous.progressAt === undefined ? now : previous.progressAt;
  return { progressAt, stalledMs: now - progressAt };
}

export type QbitLogin = { username: string; password: string };

export class Qbittorrent {
  private sid?: string;
  private signed = false;
  constructor(private url: string, private login: QbitLogin, private transport: typeof fetch = fetch, private timeoutMs = 30000) {}

  private endpoint(path: string) { return `${this.url.replace(/\/+$/, '')}/api/v2/${path}`; }
  private async fetch(path: string, init: { method?: string; body?: FormData | URLSearchParams; sid?: boolean } = {}) {
    const headers: Record<string, string> = { 'User-Agent': 'tk.box/0.0.1', Referer: this.url.replace(/\/+$/, '') + '/' };
    if (init.sid !== false && this.sid) headers.Cookie = `SID=${this.sid}`;
    try {
      return await this.transport(this.endpoint(path), { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, ...(init.body ? { body: init.body } : {}),
        redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new DownloaderError('unreachable', 'qBittorrent could not be reached.'); }
  }

  // auth/login: "Ok." and an SID cookie, or "Fails." for a wrong login; a 403 means too many failed logins.
  async signIn() {
    const response = await this.fetch('auth/login', { body: new URLSearchParams({ username: this.login.username, password: this.login.password }), sid: false });
    const body = (await response.text()).trim();
    if (response.status === 403) throw new DownloaderError('auth', 'qBittorrent refused the login: too many failed attempts, so it has banned this address for a while.');
    const cookie = response.headers.get('set-cookie') ?? '';
    const sid = /(?:^|[;,\s])SID=([^;,\s]+)/.exec(cookie)?.[1];
    if (body !== 'Ok.' && !sid) throw new DownloaderError('auth', body === 'Fails.' ? 'qBittorrent refused the username or password.' : `qBittorrent answered ${response.status} to the login.`);
    // With "Bypass authentication for localhost" qBittorrent sends no cookie: requests then work without one.
    this.sid = sid;
    this.signed = true;
  }

  // A call with the SID; a 403 (the session expired or was never made) signs in again and tries once more.
  private async call(path: string, init: { method?: string; body?: FormData | URLSearchParams } = {}): Promise<string> {
    if (!this.signed) await this.signIn();
    let response = await this.fetch(path, init);
    if (response.status === 403) {
      await response.body?.cancel();
      await this.signIn();
      response = await this.fetch(path, init);
    }
    if (response.status === 403) { await response.body?.cancel(); throw new DownloaderError('auth', 'qBittorrent refused tk.box after signing in again.'); }
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
