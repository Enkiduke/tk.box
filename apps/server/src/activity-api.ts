import type { FastifyInstance } from 'fastify';
import { requireThat } from './errors.js';
import type { PlexAdapter, PlexGrant } from './providers/plex.js';
import type { IptvStore } from './persistence/iptv-store.js';
import type { LiveTv } from './services/live-tv.js';
import type { CustomTv } from './services/custom-tv.js';
import type { VodTranscodes } from './services/vod-transcode.js';
import { describeClient, isLocalAddress, type Activity, type StreamKind } from './services/activity.js';

type Admin = (req: { cookies: Record<string, string | undefined> }) => Promise<{ grant: PlexGrant }>;
type Title = { title: string; type: 'movie' | 'episode'; year?: number; show?: string; season?: number; episode?: number; durationMs: number; posterId: string };

// Admin › Activity, like Tautulli's: who is watching what, how it is delivered, and a way to end a stream.
export function registerActivity(app: FastifyInstance, activity: Activity, plex: PlexAdapter, admin: Admin, services: { live: LiveTv; customTv: CustomTv; iptv: IptvStore; transcodes: VodTranscodes },
  end: (s: { id: string; kind: StreamKind; hash: string }) => void) {
  const { live, customTv, iptv, transcodes } = services;
  // Titles are read with the administrator's grant, which reaches every library; a failed lookup just shows no title.
  const titles = new Map<string, Promise<Title | undefined>>();
  const title = (grant: PlexGrant, id: string | undefined) => {
    if (!id) return undefined;
    if (titles.size > 300) titles.clear();
    let found = titles.get(id);
    if (!found) {
      found = plex.metadata(grant, id).then(m => ({ title: m.title, type: m.type, year: m.year, show: m.grandparentTitle, season: m.parentIndex, episode: m.index, durationMs: m.duration,
        posterId: m.type === 'episode' ? m.grandparentRatingKey ?? m.ratingKey : m.ratingKey }), () => { titles.delete(id); return undefined; });
      titles.set(id, found);
    }
    return found;
  };
  // The guide's current program on an IPTV channel, when it has one.
  const program = (channelId: string, now: number) => {
    try {
      const p = iptv.guide(channelId, iptv.feedFor(channelId), now, now + 60000)[0]?.program;
      return p ? { title: p.title, start: p.start, end: p.end } : undefined;
    } catch { return undefined; }
  };
  app.get('/api/v1/admin/activity', async req => {
    const { grant } = await admin(req), now = Date.now();
    const streams = activity.list(s => s.kind === 'live' ? !!live.watching(s.id) : s.kind === 'custom' ? !!customTv.watching(s.id, now) : s.delivery === 'direct' || transcodes.has(s.id, s.hash), now);
    const rows = await Promise.all(streams.map(async s => {
      const base = { id: s.id, kind: s.kind, user: s.user ?? 'Plex user', accountId: s.accountId, client: describeClient(s.userAgent), ip: s.ip, local: isLocalAddress(s.ip),
        startedAt: s.started, quality: s.quality, target: s.target, rateKbps: s.rateKbps ?? 0, channel: s.channel, channelId: s.channelId };
      if (s.kind === 'vod') return { ...base, state: s.state, delivery: s.delivery, source: s.source, media: await title(grant, s.mediaId), positionMs: s.positionMs, durationMs: s.durationMs };
      if (s.kind === 'custom') {
        const w = customTv.watching(s.id, now)!, media = await title(grant, w.mediaId);
        return { ...base, state: w.state === 'PAUSED' ? 'paused' as const : 'playing' as const, delivery: w.delivery, source: w.source, behindLiveMs: w.behindLiveMs, media, positionMs: media ? w.mediaMs : undefined, durationMs: media?.durationMs };
      }
      const w = live.watching(s.id)!, p = program(s.channelId!, now);
      return { ...base, state: 'playing' as const, delivery: w.delivery, source: w.source, program: p?.title, positionMs: p ? now - p.start : undefined, durationMs: p ? p.end - p.start : undefined };
    }));
    const total = (list: typeof rows) => list.reduce((n, r) => n + r.rateKbps, 0);
    return { streams: rows, transcodes: rows.filter(r => r.delivery === 'transcode').length, bandwidthKbps: total(rows), wanBandwidthKbps: total(rows.filter(r => !r.local)) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/admin/activity/:id', async req => {
    await admin(req);
    const s = activity.get(req.params.id);
    requireThat(s, 'SESSION_NOT_FOUND', 'That stream has already ended.', 404);
    end(s); activity.close(s.id);
    return { status: 'stopped' };
  });
}
