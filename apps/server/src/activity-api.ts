import type { PlexSession } from './providers/plex.js';

// A title as Admin › Activity shows it.
export type Title = { title: string; type: string; year?: number; show?: string; album?: string; season?: number; episode?: number; durationMs?: number; posterId?: string };
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
