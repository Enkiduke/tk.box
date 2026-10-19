import { randomUUID } from 'node:crypto';
import { transcodeRoot, type PlexAdapter, type PlexGrant, type PlexMetadata, type TranscodeProfile } from '../providers/plex.js';
import type { EncoderBudget, Route } from '../streaming/policy.js';
import { AppError, requireThat } from '../errors.js';

type Active = { id: string; hash: string; ratingKey: string; plexSession: string; params: URLSearchParams; grant: PlexGrant; seen: number; release: () => void; checking: boolean; kind: 'remux' | 'cpu' };
export type ActiveTranscode = Pick<Active, 'id' | 'hash' | 'ratingKey'>;
export type TranscodeResult = { kind: 'playlist'; body: string } | { kind: 'media'; response: Response };

// Plex VOD delivery for media the browser cannot direct play (TRANSCODE-06):
// Plex's own universal transcoder produces HLS, and tk.box proxies it so the
// server token never reaches the browser (PLAY-04). Remux sessions must stay
// video stream copy; CPU sessions hold one shared encoder permit until stopped.
export class VodTranscodes {
  private active = new Map<string, Active>();
  private timer: NodeJS.Timeout;
  constructor(private plex: PlexAdapter, private budget: EncoderBudget, private revalidate: (a: ActiveTranscode) => Promise<PlexGrant>, private idleMs = 300000, intervalMs = 15000) {
    this.timer = setInterval(() => void this.sweep(), intervalMs); this.timer.unref();
  }
  // `audio` names the stream to deliver when it is not the media's default track.
  async start(id: string, hash: string, grant: PlexGrant, item: PlexMetadata, route: Route, audio?: { id: string; codec?: string }) {
    requireThat(route.kind !== 'direct', 'INVALID_ROUTE', 'Direct playback does not use the transcoder.');
    const source = item.Media[0]!, audioCodec = audio?.codec ?? source.audioCodec;
    // AAC first so any audio conversion targets it; a compatible source codec may still be copied.
    const profile: TranscodeProfile = route.kind === 'remux'
      ? { videoCodecs: [source.videoCodec], audioCodecs: [...new Set(['aac', ...(route.audioEncode || !audioCodec ? [] : [audioCodec])])] }
      : { videoCodecs: ['h264'], audioCodecs: ['aac'], ...(route.maxHeight ? { maxHeight: route.maxHeight } : {}), ...(route.maxBitrateKbps ? { maxBitrateKbps: route.maxBitrateKbps } : {}) };
    // Atomic admission before any asynchronous Plex work; no queue (PLAY-27).
    let release = route.kind === 'cpu' ? this.budget.reserve(`plex-vod:${id}`) : () => {};
    const plexSession = randomUUID(), params = this.plex.transcodeParams(item.ratingKey, plexSession, profile, audio?.id);
    try {
      const decision = await this.plex.transcodeDecision(grant, params);
      // Never let Plex start an untracked video encode on a copy-only route.
      requireThat(route.kind === 'cpu' || decision.video === 'copy', 'PLEX_TRANSCODE_REFUSED', 'Plex would need to re-encode this video, which is not permitted for this title.', 422);
      // A transcoder that ignored the chosen track would silently play the wrong language.
      requireThat(!audio || !decision.audioStreamId || decision.audioStreamId === audio.id, 'AUDIO_SELECTION_FAILED', 'Plex did not switch to the chosen audio track.', 502);
      if (decision.video === 'copy') { release(); release = () => {}; }
    } catch (e) { release(); throw e; }
    this.active.set(id, { id, hash, ratingKey: item.ratingKey, plexSession, params, grant, seen: Date.now(), release, checking: false, kind: route.kind });
  }
  has(id: string, hash: string) { return this.active.get(id)?.hash === hash; }
  touch(id: string, hash: string, grant?: PlexGrant) {
    const a = this.active.get(id);
    if (a?.hash === hash) { a.seen = Date.now(); if (grant) a.grant = grant; }
  }
  async fetch(id: string, hash: string, rel: string, query: string, signal?: AbortSignal): Promise<TranscodeResult> {
    const a = this.active.get(id);
    requireThat(a?.hash === hash, 'SESSION_NOT_FOUND', 'Playback session is unavailable.', 404);
    a.seen = Date.now();
    let path: string;
    if (rel === 'start.m3u8') path = `${transcodeRoot}start.m3u8?${a.params}`;
    else {
      const prefix = `session/${a.plexSession}/`, parts = rel.slice(prefix.length).split('/');
      requireThat(rel.startsWith(prefix) && parts.every(p => /^[\w.-]+$/.test(p) && p !== '.' && p !== '..'), 'INVALID_MEDIA', 'Unsupported stream path.', 400);
      const q = new URLSearchParams(query); for (const k of [...q.keys()]) if (k.toLowerCase() === 'x-plex-token') q.delete(k);
      path = `${transcodeRoot}${rel}${q.size ? `?${q}` : ''}`;
    }
    const { response, url } = await this.plex.transcodeResource(a.grant, path, signal);
    if (!/mpegurl/i.test(response.headers.get('content-type') ?? '') && !url.pathname.endsWith('.m3u8')) return { kind: 'media', response };
    const text = await response.text();
    requireThat(text.length <= 8 * 1024 * 1024 && text.startsWith('#EXTM3U'), 'PLEX_STREAM_FAILED', 'Plex returned an invalid stream playlist.', 502);
    return { kind: 'playlist', body: this.rewrite(text, url, a) };
  }
  // Rewrite every playlist reference to this session's proxy path, refusing anything outside it.
  private rewrite(text: string, from: URL, a: Active) {
    const base = `${transcodeRoot}session/${a.plexSession}/`;
    const map = (uri: string) => {
      const target = new URL(uri, from);
      requireThat(target.origin === from.origin && target.pathname.startsWith(base), 'PLEX_STREAM_FAILED', 'Plex returned an unexpected stream reference.', 502);
      target.searchParams.delete('X-Plex-Token');
      return `/api/v1/playback/sessions/${a.id}/hls/${target.pathname.slice(transcodeRoot.length)}${target.search}`;
    };
    return text.split(/\r?\n/).map(line => {
      const value = line.trim();
      if (!value) return line;
      return value.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${map(uri)}"`) : map(value);
    }).join('\n');
  }
  stop(id: string) {
    const a = this.active.get(id); if (!a) return;
    this.active.delete(id); a.release();
    void this.plex.transcodeControl(a.grant, 'stop', a.plexSession).catch(() => {});
  }
  stopWhere(matches: (a: ActiveTranscode) => boolean) { for (const a of [...this.active.values()]) if (matches(a)) this.stop(a.id); }
  close() { clearInterval(this.timer); this.stopWhere(() => true); }
  get count() { return this.active.size; }
  // Periodic authorization recheck and Plex keepalive; abandoned sessions are released.
  async sweep(now = Date.now()) {
    await Promise.all([...this.active.values()].map(async a => {
      if (now - a.seen > this.idleMs) { this.stop(a.id); return; }
      if (a.checking) return; a.checking = true;
      try {
        a.grant = await this.revalidate(a);
        await this.plex.transcodeControl(a.grant, 'ping', a.plexSession).catch(() => {});
      } catch (e) {
        // Access loss ends delivery; a transient Plex outage is retried next sweep.
        if (e instanceof AppError && [401, 403, 404].includes(e.status)) this.stop(a.id);
      } finally { a.checking = false; }
    }));
  }
}
