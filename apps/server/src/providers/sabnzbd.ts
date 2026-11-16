// SABnzbd's API (docs/ARR-REPLACEMENT.md, "Clients" › SABnzbd): send an NZB as a file, read the queue and history as
// grab states, and delete a job with its folder after import. SABnzbd's own repair and unpack stay on.

import type { DownloadState, DownloadStatus } from './download-status.js';
export type { DownloadState, DownloadStatus } from './download-status.js';
import type { ClientItem, ClientState, ClientSummary } from '../../../../packages/contracts/src/downloads.js';

export class DownloaderError extends Error {
  constructor(public kind: 'auth' | 'unreachable' | 'other', message: string) { super(message); }
}

type Json = Record<string, unknown>;
const text = (v: unknown) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const slots = (json: unknown, list: 'queue' | 'history') => {
  const section = json && typeof json === 'object' ? (json as Json)[list] : undefined;
  const value = section && typeof section === 'object' ? (section as Json).slots : undefined;
  return Array.isArray(value) ? value.filter((s): s is Json => !!s && typeof s === 'object') : [];
};

// Post-processing: verifying, repairing, unpacking and moving are SABnzbd's own work before the folder is ready.
const POST = new Set(['queued', 'quickcheck', 'verifying', 'repairing', 'fetching', 'extracting', 'moving', 'running', 'checking']);

// mode=queue: every job still downloading (or paused, or waiting), with its progress.
export function queueStatuses(json: unknown, categories: readonly string[]): DownloadStatus[] {
  return slots(json, 'queue').flatMap(slot => {
    const id = text(slot.nzo_id), category = text(slot.cat) ?? '';
    if (!id || !categories.includes(category)) return [];
    const status = (text(slot.status) ?? '').toLowerCase();
    const mb = num(slot.mb), left = num(slot.mbleft), percent = num(slot.percentage);
    const progress = percent !== undefined ? clamp(percent / 100) : mb && left !== undefined ? clamp(1 - left / mb) : undefined;
    const state: DownloadState = ['extracting', 'moving', 'running', 'verifying', 'repairing', 'quickcheck'].includes(status) ? 'unpacking' : 'downloading';
    return [{ downloader: 'sabnzbd' as const, downloadId: id, name: text(slot.filename) ?? id, category, state,
      ...(progress !== undefined ? { progress } : {}), ...(mb !== undefined ? { size: Math.round(mb * 1024 * 1024) } : {}) }];
  });
}

// mode=history: Completed (ready to import, from `storage`), Failed (with `fail_message`), or still post-processing.
export function historyStatuses(json: unknown, categories: readonly string[]): DownloadStatus[] {
  return slots(json, 'history').flatMap((slot): DownloadStatus[] => {
    const id = text(slot.nzo_id), category = text(slot.category) ?? '';
    if (!id || !categories.includes(category)) return [];
    const status = (text(slot.status) ?? '').toLowerCase(), bytes = num(slot.bytes), storage = text(slot.storage), error = text(slot.fail_message);
    const base = { downloader: 'sabnzbd' as const, downloadId: id, name: text(slot.name) ?? id, category, ...(bytes ? { size: bytes } : {}) };
    if (status === 'completed') return [{ ...base, state: 'importing' as const, progress: 1, ...(storage ? { storage } : {}) }];
    if (status === 'failed') return [{ ...base, state: 'failed' as const, error: error || 'SABnzbd marked the download failed.' }];
    if (POST.has(status)) return [{ ...base, state: 'unpacking' as const, progress: 1 }];
    return [];
  });
}

// Queue and history together; a job in both (moving from one to the other) is taken from the history.
export function statuses(queue: unknown, history: unknown, categories: readonly string[]): DownloadStatus[] {
  const byId = new Map<string, DownloadStatus>();
  for (const s of queueStatuses(queue, categories)) byId.set(s.downloadId, s);
  for (const s of historyStatuses(history, categories)) byId.set(s.downloadId, s);
  return [...byId.values()];
}

// "1:02:03" or "2:01:02:03" (days first) as seconds.
const clock = (v: unknown) => {
  const parts = (text(v) ?? '').split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return undefined;
  const days = parts.length === 4 ? parts.shift()! : 0;
  const s = days * 86400 + parts.reduce((total, n) => total * 60 + n, 0);
  return s > 0 ? s : undefined;
};
const word = (s: string) => s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s;
const QUEUE_LIVE: Record<string, [ClientState, string?]> = {
  downloading: ['downloading'], queued: ['queued'], paused: ['paused'], checking: ['checking'],
  grabbing: ['queued', 'Grabbing'], fetching: ['queued', 'Fetching'], propagating: ['queued', 'Propagating'],
};

// mode=queue and mode=history: every job SABnzbd has (any category), and its speed and free space. The speed is
// SABnzbd's own, given to the job it is downloading.
export function liveJobs(queue: unknown, history: unknown, categories: readonly string[]): { summary: ClientSummary; items: ClientItem[] } {
  const q = (queue && typeof queue === 'object' ? (queue as Json).queue : undefined) as Json | undefined ?? {};
  const speed = Math.round((num(q.kbpersec) ?? 0) * 1024), paused = q.paused === true || text(q.status)?.toLowerCase() === 'paused';
  let speedGiven = false;
  const items: ClientItem[] = [];
  for (const slot of slots(queue, 'queue')) {
    const id = text(slot.nzo_id);
    if (!id) continue;
    const raw = (text(slot.status) ?? '').toLowerCase(), category = text(slot.cat) ?? '';
    let [state, detail] = QUEUE_LIVE[raw] ?? ['queued', word(raw)] as [ClientState, string?];
    if (paused && state === 'queued') [state, detail] = ['paused', 'SABnzbd is paused'];
    const mb = num(slot.mb), left = num(slot.mbleft), percent = num(slot.percentage);
    const progress = percent !== undefined ? clamp(percent / 100) : mb && left !== undefined ? clamp(1 - left / mb) : 0;
    const down = state === 'downloading' && !speedGiven && speed ? speed : undefined;
    if (down) speedGiven = true;
    const eta = state === 'downloading' ? clock(slot.timeleft) : undefined, position = num(slot.index);
    items.push({ downloader: 'sabnzbd', id, name: text(slot.filename) ?? id, protocol: 'usenet', state, progress, mine: categories.includes(category),
      ...(detail ? { detail } : {}), ...(mb ? { size: Math.round(mb * 1024 * 1024) } : {}), ...(left !== undefined ? { left: Math.round(left * 1024 * 1024) } : {}),
      ...(down ? { down } : {}), ...(eta ? { eta } : {}), ...(position !== undefined && state !== 'downloading' ? { position: position + 1 } : {}),
      ...(category && category !== '*' ? { category } : {}) });
  }
  for (const slot of slots(history, 'history')) {
    const id = text(slot.nzo_id);
    if (!id || items.some(i => i.id === id)) continue;
    const raw = (text(slot.status) ?? '').toLowerCase(), category = text(slot.category) ?? '', bytes = num(slot.bytes), done = num(slot.completed);
    const state: ClientState = raw === 'completed' ? 'completed' : raw === 'failed' ? 'failed' : POST.has(raw) ? 'unpacking' : 'queued';
    const detail = state === 'unpacking' || state === 'queued' ? word(raw) : undefined, error = state === 'failed' ? text(slot.fail_message) || 'SABnzbd marked the download failed.' : undefined;
    items.push({ downloader: 'sabnzbd', id, name: text(slot.name) ?? id, protocol: 'usenet', state, progress: 1, mine: categories.includes(category),
      ...(detail ? { detail } : {}), ...(bytes ? { size: bytes } : {}), ...(category && category !== '*' ? { category } : {}),
      ...(done && state !== 'unpacking' ? { finishedAt: done * 1000 } : {}), ...(error ? { error } : {}) });
  }
  const free = num(q.diskspace1);
  return { summary: { name: 'sabnzbd', down: speed, up: 0, paused, ...(free !== undefined ? { free: Math.round(free * 1024 ** 3) } : {}) }, items };
}

export class Sabnzbd {
  constructor(private url: string, private key: string, private transport: typeof fetch = fetch, private timeoutMs = 30000) {}

  private async call(params: Record<string, string>, body?: FormData): Promise<Json> {
    const url = new URL(`${this.url.replace(/\/+$/, '')}/api`);
    for (const [k, v] of Object.entries({ ...params, output: 'json' })) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.key);
    let response: Response;
    try {
      response = await this.transport(url, { method: body ? 'POST' : 'GET', headers: { 'User-Agent': 'tk.box/0.0.1', Accept: 'application/json' },
        ...(body ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new DownloaderError('unreachable', 'SABnzbd could not be reached.'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new DownloaderError('other', 'SABnzbd redirected the request. Check its address.'); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new DownloaderError('auth', 'SABnzbd refused the API key.'); }
    const raw = await response.text();
    if (raw.length > 32 * 1024 * 1024) throw new DownloaderError('other', 'SABnzbd sent too much data.');
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new DownloaderError('other', `SABnzbd answered ${response.status} without JSON.`); }
    const data = (json && typeof json === 'object' ? json : {}) as Json;
    const error = text(data.error);
    if (data.status === false || error) {
      const message = error ?? 'SABnzbd refused the request.';
      throw new DownloaderError(/api key/i.test(message) ? 'auth' : 'other', `SABnzbd: ${message}`);
    }
    if (response.status >= 400) throw new DownloaderError('other', `SABnzbd answered ${response.status}.`);
    return data;
  }

  // mode=addfile with the NZB as a file. Returns nzo_ids[0], the grab's download_id.
  async addFile(file: Buffer, name: string, category: string, priority?: number) {
    const form = new FormData();
    form.append('name', new Blob([new Uint8Array(file)], { type: 'application/x-nzb' }), name.endsWith('.nzb') ? name : `${name}.nzb`);
    const data = await this.call({ mode: 'addfile', cat: category, nzbname: name.replace(/\.nzb$/i, ''), ...(priority !== undefined ? { priority: String(priority) } : {}) }, form);
    const id = Array.isArray(data.nzo_ids) ? text(data.nzo_ids[0]) : undefined;
    if (!id) throw new DownloaderError('other', 'SABnzbd took the NZB but gave no job id.');
    return id;
  }

  queue() { return this.call({ mode: 'queue', limit: '500' }); }
  history(limit = 500) { return this.call({ mode: 'history', limit: String(limit) }); }

  // After import: the history job and its folder go (the library file was moved out). A job still in the queue (a
  // cancelled grab) is deleted there too.
  async delete(id: string) {
    await this.call({ mode: 'queue', name: 'delete', value: id, del_files: '1' }).catch(e => { if (!(e instanceof DownloaderError) || e.kind !== 'other') throw e; });
    await this.call({ mode: 'history', name: 'delete', value: id, del_files: '1' });
  }

  // Version check for Admin's Test (phase 1c).
  async version() { return text((await this.call({ mode: 'version' })).version); }
}
