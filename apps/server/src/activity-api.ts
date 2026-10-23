import type { FastifyInstance } from 'fastify';
import { requireThat } from './errors.js';
import type { PlexAdapter, PlexGrant, PlexSession } from './providers/plex.js';
import type { IptvStore } from './persistence/iptv-store.js';
import type { LiveTv } from './services/live-tv.js';
import type { CustomTv } from './services/custom-tv.js';
import type { VodTranscodes } from './services/vod-transcode.js';
import { describeClient, isLocalAddress, PlexFreshness, type Activity, type StreamKind } from './services/activity.js';

type Admin = (req: { cookies: Record<string, string | undefined> }) => Promise<{ grant: PlexGrant }>;
type Title = { title: string; type: string; year?: number; show?: string; album?: string; season?: number; episode?: number; durationMs?: number; posterId?: string };
const upper = (c?: string) => c?.toUpperCase();
const resolution = (height?: number, named?: string) => named ? (/^\d+$/.test(named) ? `${named}p` : named.toUpperCase()) : height ? `${height}p` : undefined;
// One of Plex's own sessions (any Plex app, not tk.box) as an activity row, described the way Tautulli does.
export function plexRow(m: PlexSession, now = Date.now()) {
  const t = m.TranscodeSession, media = m.Media?.[0], local = m.Session?.location ? m.Session.location === 'lan' : !!m.Player?.local;
  const delivery = t?.videoDecision === 'transcode' ? 'transcode' as const : t ? 'remux' as const : 'direct' as const;
  const sourceVideo = [upper(t?.sourceVideoCodec ?? media?.videoCodec), resolution(media?.height, media?.videoResolution)].filter(Boolean).join(' ');
  const video = !sourceVideo ? undefined : delivery === 'transcode' ? `Transcode (${sourceVideo} → ${[upper(t?.videoCodec), t?.height ? `${t.height}p` : undefined].filter(Boolean).join(' ')})`
    : t?.videoDecision === 'copy' ? `Direct stream (${sourceVideo})` : `Direct play (${sourceVideo})`;
  const sourceAudio = upper(t?.sourceAudioCodec ?? media?.audioCodec);
  const audio = !sourceAudio ? undefined : t?.audioDecision === 'transcode' ? `Transcode (${sourceAudio} → ${upper(t.audioCodec)})` : `${t ? 'Direct stream' : 'Direct play'} (${sourceAudio})`;
  const type = m.type ?? 'video', posterId = type === 'episode' ? m.grandparentRatingKey ?? m.ratingKey : type === 'track' ? m.parentRatingKey ?? m.ratingKey : m.ratingKey;
  return {
    id: `plex:${m.Session?.id ?? m.ratingKey ?? now}`, kind: 'plex' as const, user: m.User?.title || 'Plex user', accountId: m.User?.id,
    client: [m.Player?.product, m.Player?.title || m.Player?.platform].filter(Boolean).join(' · ') || 'Plex app',
    ip: (local ? m.Player?.address : m.Player?.remotePublicAddress || m.Player?.address) ?? '', local,
    state: m.Player?.state === 'paused' ? 'paused' as const : m.Player?.state === 'buffering' ? 'buffering' as const : 'playing' as const,
    delivery, video, audio, speed: t?.speed, rateKbps: m.Session?.bandwidth ?? 0, canStop: !!m.Session?.id, live: !!m.live,
    source: { videoCodec: t?.sourceVideoCodec ?? media?.videoCodec, audioCodec: t?.sourceAudioCodec ?? media?.audioCodec, height: media?.height, width: media?.width, container: t?.sourceContainer ?? media?.container, bitrateKbps: media?.bitrate },
    media: m.title ? { title: m.title, type, year: m.year, show: m.grandparentTitle, album: m.parentTitle, season: m.parentIndex, episode: m.index, durationMs: m.duration, posterId } satisfies Title : undefined,
    positionMs: m.live ? undefined : m.viewOffset, durationMs: m.live ? undefined : m.duration
  };
}

// Admin › Activity, like Tautulli's: who is watching what, how it is delivered, and a way to end a stream.
export function registerActivity(app: FastifyInstance, activity: Activity, plex: PlexAdapter, admin: Admin, services: { live: LiveTv; customTv: CustomTv; iptv: IptvStore; transcodes: VodTranscodes },
  end: (s: { id: string; kind: StreamKind; hash: string }) => void) {
  const { live, customTv, iptv, transcodes } = services;
  // Titles are read with the administrator's grant, which reaches every library; a failed lookup just shows no title.
  const titles = new Map<string, Promise<Title | undefined>>(), fresh = new PlexFreshness();
  const title = (grant: PlexGrant, id: string | undefined) => {
    if (!id) return undefined;
    if (titles.size > 300) titles.clear();
    let found = titles.get(id);
    if (!found) {
      found = plex.metadata(grant, id).then((m): Title => ({ title: m.title, type: m.type, year: m.year, show: m.grandparentTitle, season: m.parentIndex, episode: m.index, durationMs: m.duration,
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
    // Plex's own apps, read live from Plex; when Plex can't be reached, tk.box's streams still show.
    let plexError: string | undefined, others: ReturnType<typeof plexRow>[] = [];
    try { others = fresh.filter((await plex.sessions(grant)).map(m => plexRow(m, now)), now); } catch { plexError = 'Plex’s own streams couldn’t be read. Only tk.box streams are shown.'; }
    const all = [...rows.map(r => ({ ...r, canStop: true })), ...others], total = (list: typeof all) => list.reduce((n, r) => n + r.rateKbps, 0);
    return { streams: all, transcodes: all.filter(r => r.delivery === 'transcode').length, bandwidthKbps: total(all), wanBandwidthKbps: total(all.filter(r => !r.local)), plexError };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/admin/activity/:id', async req => {
    const { grant } = await admin(req);
    if (req.params.id.startsWith('plex:')) {
      const id = req.params.id.slice(5);
      requireThat(/^[\w-]{1,100}$/.test(id), 'SESSION_NOT_FOUND', 'That stream has already ended.', 404);
      await plex.terminateSession(grant, id, 'This stream was stopped by the server administrator.');
      return { status: 'stopped' };
    }
    const s = activity.get(req.params.id);
    requireThat(s, 'SESSION_NOT_FOUND', 'That stream has already ended.', 404);
    end(s); activity.close(s.id);
    return { status: 'stopped' };
  });
}
