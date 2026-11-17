import { open } from 'node:fs/promises';

// OpenSubtitles.com's REST API (docs/ARR-REPLACEMENT.md, "Subtitles" › OpenSubtitles.com; docs/PHASE-4.md): the
// moviehash, login, search, download, and the pick order. English only. Every call carries the API key and a
// User-Agent; search and download carry the token from login, which is kept until it expires (24 hours) and fetched
// again on a 401. Calls are paced at 2 a second, as the API asks. Login answers with the host to use (VIP accounts
// get vip-api.opensubtitles.com), which every later call goes to.

export const OPENSUBTITLES_API = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'tk.box v0.0.1';
const TOKEN_MS = 23 * 3600 * 1000, PACE_MS = 500, HASH_CHUNK = 65536;

// ---- the moviehash ----

// OpenSubtitles' hash: the file size plus every little-endian 64-bit word of the first and last 64 KiB, modulo 2^64,
// as 16 hex digits. Undefined for a file under 128 KiB (no video is that small, and the halves would overlap).
export function movieHash(size: number, head: Buffer, tail: Buffer): string | undefined {
  if (size < HASH_CHUNK * 2 || head.length !== HASH_CHUNK || tail.length !== HASH_CHUNK) return undefined;
  const MASK = (1n << 64n) - 1n;
  let sum = BigInt(size);
  for (const chunk of [head, tail]) for (let i = 0; i < HASH_CHUNK; i += 8) sum = (sum + chunk.readBigUInt64LE(i)) & MASK;
  return sum.toString(16).padStart(16, '0');
}

export async function movieHashOf(path: string): Promise<string | undefined> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size < HASH_CHUNK * 2) return undefined;
    const head = Buffer.alloc(HASH_CHUNK), tail = Buffer.alloc(HASH_CHUNK);
    await file.read(head, 0, HASH_CHUNK, 0);
    await file.read(tail, 0, HASH_CHUNK, size - HASH_CHUNK);
    return movieHash(size, head, tail);
  } finally { await file.close(); }
}

// ---- search answers and the pick ----

export type SubtitleHit = {
  fileId: number; subtitleId: string; release?: string; downloads: number;
  hashMatch: boolean; hearingImpaired: boolean; trusted: boolean;
  season?: number; episode?: number;
};
export type Wanted = { kind: 'movie'; tmdbId: number } | { kind: 'episode'; showTmdbId: number; season: number; episode: number };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

// The usable English hits of a /subtitles answer: one file each (no CD1/CD2 sets), not machine- or AI-translated, not
// forced-only (foreign_parts_only, which doesn't count as English; docs/PHASE-4.md), and for an episode, the episode
// asked for when the answer says which it is.
export function parseHits(body: unknown, wanted?: Wanted): SubtitleHit[] {
  const data = Array.isArray(obj(body).data) ? obj(body).data as unknown[] : [];
  const hits: SubtitleHit[] = [];
  for (const item of data) {
    const a = obj(obj(item).attributes), files = Array.isArray(a.files) ? a.files as unknown[] : [];
    if (String(a.language ?? '').toLowerCase() !== 'en' || files.length !== 1) continue;
    if (a.machine_translated === true || a.ai_translated === true || a.foreign_parts_only === true) continue;
    const fileId = num(obj(files[0]).file_id);
    if (!fileId) continue;
    const feature = obj(a.feature_details), season = num(feature.season_number), episode = num(feature.episode_number);
    if (wanted?.kind === 'episode' && ((season !== undefined && season !== wanted.season) || (episode !== undefined && episode !== wanted.episode))) continue;
    hits.push({
      fileId, subtitleId: String(obj(item).id ?? a.subtitle_id ?? fileId), downloads: num(a.download_count) ?? 0,
      hashMatch: a.moviehash_match === true, hearingImpaired: a.hearing_impaired === true, trusted: a.from_trusted === true,
      ...(typeof a.release === 'string' && a.release ? { release: a.release } : {}),
      ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}),
    });
  }
  return hits;
}

// The pick order (ARR-REPLACEMENT.md): a hash match; then not hearing-impaired, unless preferHearingImpaired (a
// setting) or that's all there is; then trusted uploaders; then the most downloads. Undefined when there's nothing.
export function pickSubtitle(hits: readonly SubtitleHit[], preferHearingImpaired = false): SubtitleHit | undefined {
  const rank = (h: SubtitleHit) => [h.hashMatch ? 0 : 1, h.hearingImpaired === preferHearingImpaired ? 0 : 1, h.trusted ? 0 : 1, -h.downloads];
  return [...hits].sort((x, y) => {
    const a = rank(x), b = rank(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return x.fileId - y.fileId;
  })[0];
}

// The sidecar's name for a video: `<video name>.en.srt`, or `.en.sdh.srt` for a hearing-impaired one.
export const sidecarPath = (videoPath: string, hearingImpaired: boolean) =>
  videoPath.replace(/\.[^./\\]+$/, '') + (hearingImpaired ? '.en.sdh.srt' : '.en.srt');

// ---- the client ----

// Why a call failed. `auth`: the key or login was refused. `quota`: the account's downloads for the day are used up
// (`resetAt` from the answer). `rate`: a 429. `other`: the rest.
export class OpenSubtitlesError extends Error {
  constructor(public kind: 'auth' | 'quota' | 'rate' | 'other', message: string, public resetAt?: number) { super(message); }
}

export type Login = { apiKey: string; username: string; password: string };
export type Download = { link: string; fileName?: string; remaining?: number; resetAt?: number };
export type Account = { level?: string; vip: boolean; allowedDownloads?: number; remaining?: number };
type Session = { token: string; base: string; until: number; account: Account };

export class OpenSubtitles {
  private session: Session | undefined;
  private last = 0;
  constructor(private login: Login, private transport: typeof fetch = fetch,
    private options: { base?: string; now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}) {}

  private now() { return this.options.now?.() ?? Date.now(); }
  private async pace() {
    const wait = this.last + PACE_MS - this.now();
    if (wait > 0) await (this.options.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(wait);
    this.last = this.now();
  }

  private async call(base: string, path: string, init: { method?: 'GET' | 'POST'; body?: unknown; token?: string; query?: Record<string, string | number> }, signal?: AbortSignal): Promise<Json> {
    await this.pace();
    const url = new URL(base.replace(/\/+$/, '') + path);
    // The API redirects unless parameters are lower-case and sorted.
    for (const [k, v] of Object.entries(init.query ?? {}).sort(([a], [b]) => a.localeCompare(b))) url.searchParams.set(k, String(v).toLowerCase());
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30000);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: init.method ?? 'GET', redirect: 'follow', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Api-Key': this.login.apiKey, 'User-Agent': USER_AGENT, Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new OpenSubtitlesError('other', 'OpenSubtitles could not be reached.');
    }
    const text = await response.text();
    let body: Json = {};
    try { body = obj(JSON.parse(text)); } catch { /* not JSON */ }
    const message = typeof body.message === 'string' ? body.message : typeof body.errors === 'object' ? JSON.stringify(body.errors) : '';
    if (response.status === 429) throw new OpenSubtitlesError('rate', 'OpenSubtitles answered 429 (too many requests).');
    if (response.status === 401 || response.status === 403) throw new OpenSubtitlesError('auth', `OpenSubtitles refused the ${init.token ? 'token' : 'API key or login'} (${response.status})${message ? `: ${message}` : ''}.`);
    if (response.status === 406) throw new OpenSubtitlesError('quota', message || 'OpenSubtitles: no downloads left today.', resetOf(body));
    if (response.status >= 400) throw new OpenSubtitlesError('other', `OpenSubtitles answered ${response.status}${message ? `: ${message}` : ''}.`);
    return body;
  }

  private async signIn(signal?: AbortSignal): Promise<Session> {
    if (this.session && this.session.until > this.now()) return this.session;
    const body = await this.call(this.options.base ?? OPENSUBTITLES_API, '/login', { method: 'POST', body: { username: this.login.username, password: this.login.password } }, signal);
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) throw new OpenSubtitlesError('auth', 'OpenSubtitles sent no token.');
    const user = obj(body.user), host = typeof body.base_url === 'string' && /^[a-z0-9.-]+\.opensubtitles\.com$/i.test(body.base_url) ? body.base_url : undefined;
    const account: Account = { vip: user.vip === true, ...(typeof user.level === 'string' ? { level: user.level } : {}),
      ...(num(user.allowed_downloads) !== undefined ? { allowedDownloads: num(user.allowed_downloads)! } : {}),
      ...(num(user.remaining_downloads) !== undefined ? { remaining: num(user.remaining_downloads)! } : {}) };
    return this.session = { token, base: host && !this.options.base ? `https://${host}/api/v1` : this.options.base ?? OPENSUBTITLES_API, until: this.now() + TOKEN_MS, account };
  }

  // A call with the token, signing in again once if the token was refused.
  private async authed(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string | number> }, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      const session = await this.signIn(signal);
      try { return await this.call(session.base, path, { ...init, token: session.token }, signal); } catch (e) {
        if (attempt === 0 && e instanceof OpenSubtitlesError && e.kind === 'auth') { this.session = undefined; continue; }
        throw e;
      }
    }
  }

  // Test: signs in, and says what the account is.
  async account(signal?: AbortSignal): Promise<Account> {
    this.session = undefined;
    return (await this.signIn(signal)).account;
  }

  // English subtitles for a movie or an episode, with the video's hash when it has one.
  async search(wanted: Wanted, hash: string | undefined, signal?: AbortSignal): Promise<SubtitleHit[]> {
    const query: Record<string, string | number> = { languages: 'en', ...(hash ? { moviehash: hash } : {}),
      ...(wanted.kind === 'movie' ? { tmdb_id: wanted.tmdbId } : { parent_tmdb_id: wanted.showTmdbId, season_number: wanted.season, episode_number: wanted.episode }) };
    return parseHits(await this.authed('/subtitles', { query }, signal), wanted);
  }

  // A short-lived link for one subtitle file; counts against the account's downloads.
  async download(fileId: number, signal?: AbortSignal): Promise<Download> {
    const body = await this.authed('/download', { method: 'POST', body: { file_id: fileId, sub_format: 'srt' } }, signal);
    if (typeof body.link !== 'string' || !/^https:\/\//.test(body.link)) throw new OpenSubtitlesError('other', 'OpenSubtitles sent no download link.');
    const remaining = num(body.remaining), resetAt = resetOf(body);
    return { link: body.link, ...(typeof body.file_name === 'string' ? { fileName: body.file_name } : {}),
      ...(remaining !== undefined ? { remaining } : {}), ...(resetAt !== undefined ? { resetAt } : {}) };
  }

  // The subtitle text behind a download link (at most 2 MB).
  async fetchText(link: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30000);
    let response: Response;
    try { response = await this.transport(link, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch (e) { if (signal?.aborted) throw e; throw new OpenSubtitlesError('other', 'The subtitle file could not be fetched.'); }
    if (!response.ok) throw new OpenSubtitlesError('other', `The subtitle file answered ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new OpenSubtitlesError('other', 'The subtitle file is over 2 MB.');
    return bytes.toString('utf8').replace(/^﻿/, '');
  }
}

function resetOf(body: Json): number | undefined {
  const at = typeof body.reset_time_utc === 'string' ? Date.parse(body.reset_time_utc) : NaN;
  return Number.isFinite(at) ? at : undefined;
}
