import { Readable } from 'node:stream';
import { z } from 'zod';
import { defineModule } from './module.js';
import { authorize, session, viewer } from './access.js';
import { AppError, requireThat } from '../errors.js';
import { playbackObservation, quality } from '../../../../packages/contracts/src/index.js';
import { audioForLanguage, audioStreams, mediaMarkers, mediaTracks } from '../providers/plex.js';
import { byteRange, type LocalMedia, type LocalPart } from '../providers/local-media.js';
import { chooseRoute, qualityOptions } from '../streaming/policy.js';
import { PlaybackService } from '../services/playback.js';
import { VodTranscodes } from '../services/vod-transcode.js';
import { describeClient } from '../services/activity.js';
import type { ActivityApi } from './activity.js';
import { plexHistoryMedia } from '../persistence/history-store.js';
import type { PlaybackHistory } from '../services/playback-history.js';
import type { SubtitleService } from '../services/subtitles.js';
import type { IdentityService } from '../services/identity.js';

type Deps = {
  // Transcodes reauthorize their viewer with Plex while they run.
  identity: Pick<IdentityService, 'authenticateHash'>;
  // Admin › Activity and watch history, which every on-demand viewer reports to.
  activity: ActivityApi; history: PlaybackHistory; subtitles: SubtitleService; localMedia: LocalMedia;
};
type Params = { Params: { id: string } };
type Stream = { id: string; hash: string; abort: AbortController };

// On-demand playback of Plex titles: direct file delivery (from disk in same-host mode, else proxied from Plex) or a
// Plex transcoder HLS proxy, plus subtitles, progress and stopping.
export const vodPlaybackModule = defineModule({
  name: 'vod-playback',
  setup(routes, { config, db, plex, bus, budget }, { identity, activity: { activity, source }, history, subtitles, localMedia }: Deps) {
    const playback = new PlaybackService(db, plex);
    const transcodes = new VodTranscodes(plex, budget, async a => {
      const { grant } = await identity.authenticateHash(a.hash); await plex.metadata(grant, a.ratingKey); playback.owned(a.id, a.hash); return grant;
    });
    // Open direct file deliveries, so stopping a session or signing out cuts them.
    const streams = new Set<Stream>();
    const stopStreams = (matches: (s: { id: string; hash: string }) => boolean) => { for (const s of streams) if (matches(s)) s.abort.abort(); };
    const caps = z.object({ videoCodecs: z.array(z.string().max(40)).max(20), audioCodecs: z.array(z.string().max(40)).max(20), containers: z.array(z.string().max(40)).max(20) }).strict();
    routes.post('/api/v1/playback/sessions', { config: { access: 'viewer', rateLimit: { max: 20, timeWindow: 60000 } } }, async req => {
      // startAtMs with audioStreamId or quality restarts a title at the current position with another track or quality.
      // audioLanguage is the viewer's preferred language, used when no track is named.
      const input = z.object({ mode: z.literal('plex_vod'), ratingKey: z.string().regex(/^\d+$/), capabilities: caps, startFrom: z.enum(['resume', 'beginning']).default('resume'),
        startAtMs: z.number().int().nonnegative().optional(), previousDeliveryId: z.string().regex(/^[\w-]{43}$/).optional(),
        audioStreamId: z.string().regex(/^\d+$/).max(20).optional(), audioLanguage: z.string().regex(/^[a-z]{2,3}$/i).optional(), quality: quality.default('auto') }).strict().parse(req.body);
      const { hash, grant } = viewer(req), item = await plex.metadata(grant, input.ratingKey, { markers: true }), media = item.Media[0];
      requireThat(media, 'SOURCE_INCOMPATIBLE', 'No playable media.', 422);
      const video = media.Part[0]?.Stream?.find(s => s.streamType === 1), { audio, fileDefault, plexSelected } = audioStreams(item);
      const requested = input.audioStreamId !== undefined ? audio.find(s => s.id === input.audioStreamId) : input.audioLanguage ? audioForLanguage(item, input.audioLanguage) : undefined;
      requireThat(input.audioStreamId === undefined || requested, 'INVALID_AUDIO', 'Audio track is not part of this media.');
      // Browsers play only the file's default audio, so any other track needs Plex HLS.
      const target = requested ?? plexSelected ?? fileDefault, otherTrack = !!target && target.id !== fileDefault?.id;
      const sourceVideo = { codec: media.videoCodec, width: media.width, height: media.height, container: media.container, audioCodec: target?.codec ?? media.audioCodec, bitDepth: video?.bitDepth, bitrateKbps: media.bitrate };
      const route = chooseRoute(sourceVideo, input.capabilities, input.quality, false, !otherTrack);
      const startOffsetMs = Math.max(0, Math.min(input.startAtMs ?? (input.startFrom === 'beginning' ? 0 : item.viewOffset ?? 0), item.duration));
      // Track and source details let the player offer subtitles and describe the stream; markers let it skip intros and credits.
      const playing = route.kind === 'direct' ? fileDefault : target;
      const details = { tracks: mediaTracks(item, playing?.id), markers: mediaMarkers(item), source: { videoCodec: media.videoCodec, audioCodec: playing?.codec ?? media.audioCodec, width: media.width, height: media.height, container: media.container, bitrateKbps: media.bitrate },
        quality: input.quality, qualityOptions: qualityOptions(sourceVideo, input.capabilities, false, !otherTrack) };
      const watching = (created: { id: string; delivery: 'direct' | 'remux' | 'transcode' }, decision?: { video?: string; audio?: string }) => {
        const browser = { ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 400) };
        activity.open({ id: created.id, kind: 'vod', hash, accountId: grant.accountId, user: grant.name, delivery: created.delivery, ...browser,
          mediaId: item.ratingKey, positionMs: startOffsetMs, durationMs: item.duration, quality: input.quality, source: details.source,
          ...(route.kind === 'cpu' ? { target: { maxHeight: route.maxHeight, maxBitrateKbps: route.maxBitrateKbps } } : {}) });
        if (config.PLEX_MACHINE_ID) history.open({ id: created.id, owner: hash, accountId: grant.accountId, accountName: grant.name,
          client: describeClient(browser.userAgent), media: plexHistoryMedia(config.PLEX_MACHINE_ID, item),
          stream: { delivery: decision?.video === 'copy' ? 'remux' : created.delivery, video: decision?.video, audio: decision?.audio,
            sourceHeight: media.height, sourceWidth: media.width, maxHeight: route.kind === 'cpu' ? route.maxHeight : undefined }
        }, input.previousDeliveryId);
      };
      if (route.kind === 'direct') { const created = playback.createVod(hash, input.ratingKey, startOffsetMs); watching(created); return { ...created, ...details }; }
      if (requested && requested.id !== plexSelected?.id) await plex.selectAudioStream(grant, item, requested.id);
      const created = playback.createVod(hash, input.ratingKey, startOffsetMs, route.kind === 'remux' ? 'remux' : 'transcode');
      try {
        const decision = await transcodes.start(created.id, hash, grant, item, route, requested || otherTrack ? { id: target!.id, codec: target!.codec } : undefined);
        watching(created, decision);
      } catch (e) { playback.stop(created.id, hash); throw e; }
      return { ...created, ...details };
    });
    // Plex transcoder HLS proxy. Playlists reauthorize fully; segments use the
    // local session check plus the transcoder's periodic Plex reauthorization.
    routes.get<{ Params: { id: string; '*': string } }>('/api/v1/playback/sessions/:id/hls/*', { config: { access: 'session', rateLimit: { max: 1200, timeWindow: 60000 } } }, async (req, reply) => {
      const rel = req.params['*'], playlist = rel.endsWith('.m3u8');
      const hash = playlist ? (await authorize(req, 'viewer')).hash : session(req);
      playback.owned(req.params.id, hash);
      const abort = new AbortController(); reply.raw.once('close', () => abort.abort());
      const result = await transcodes.fetch(req.params.id, hash, rel, req.url.split('?')[1] ?? '', abort.signal);
      if (result.kind === 'playlist') { activity.touch(req.params.id, result.body.length); return reply.type('application/vnd.apple.mpegurl').send(result.body); }
      const { response } = result;
      activity.touch(req.params.id, Number(response.headers.get('content-length')) || 0);
      reply.code(response.status);
      for (const h of ['content-type', 'content-length']) if (response.headers.has(h)) reply.header(h, response.headers.get(h)!);
      return reply.send(response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : null);
    });
    // Every seek is a new range request, so the file route gets the stream routes' allowance, not the API's.
    routes.get<Params>('/api/v1/playback/sessions/:id/file', { config: { access: 'viewer', rateLimit: { max: 1200, timeWindow: 60000 } } }, async (req, reply) => {
      const { hash, grant } = viewer(req), session = playback.owned(req.params.id, hash);
      requireThat(session.mode === 'plex_vod', 'INVALID_MODE', 'This endpoint only serves on-demand media.', 403);
      if (req.headers.range) requireThat(/^bytes=\d*-\d*$/.test(req.headers.range), 'INVALID_RANGE', 'Only a single byte range is supported.');
      const item = await plex.metadata(grant, session.rating_key), running: Stream = { id: session.id, hash, abort: new AbortController() };
      activity.touch(session.id);
      requireThat([...streams].filter(s => s.hash === hash).length < 20, 'STREAM_LIMIT', 'Too many open media requests.', 429);
      streams.add(running);
      // Access loss ends delivery; a slow or briefly unreachable Plex does not cut the stream mid-play.
      const timer = setInterval(() => { void authorize(req, 'viewer').then(a => plex.metadata(a.grant, session.rating_key)).then(() => playback.owned(session.id, hash)).catch(e => { if (e instanceof AppError && [401, 403, 404].includes(e.status)) running.abort.abort(); }); }, 15000); timer.unref();
      const cleanup = () => { clearInterval(timer); running.abort.abort(); streams.delete(running); };
      reply.raw.once('close', cleanup);
      // Same-host mode: serve the authorized part from disk, else proxy Plex below.
      let local: LocalPart | undefined;
      try { local = await localMedia.open(grant, item); } catch (e) { cleanup(); throw e; }
      if (local) {
        const range = byteRange(req.headers.range, local.size);
        reply.header('accept-ranges', 'bytes');
        if (range === 'unsatisfiable') { await local.handle.close(); return reply.code(416).header('content-range', `bytes */${local.size}`).send(); }
        const { start, end } = range ?? { start: 0, end: local.size - 1 };
        reply.code(range ? 206 : 200).type(local.type).header('content-length', String(end - start + 1));
        if (range) reply.header('content-range', `bytes ${start}-${end}/${local.size}`);
        if (end < start) { await local.handle.close(); return reply.send(Buffer.alloc(0)); }
        const body = local.handle.createReadStream({ start, end, autoClose: true });
        if (running.abort.signal.aborted) body.destroy(); else running.abort.signal.addEventListener('abort', () => body.destroy(), { once: true });
        return reply.send(body);
      }
      let response: Response;
      try { response = await plex.directPart(grant, item, req.headers.range, running.abort.signal); } catch (e) { cleanup(); throw e; }
      reply.code(response.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers.has(h)) reply.header(h, response.headers.get(h)!);
      return reply.send(response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : null);
    });
    routes.get<{ Params: { id: string; stream: string } }>('/api/v1/playback/sessions/:id/subtitles/:stream', { config: { access: 'viewer' } }, async (req, reply) => {
      requireThat(/^\d+$/.test(req.params.stream), 'INVALID_MEDIA', 'Invalid subtitle identifier.');
      const { hash, grant } = viewer(req), session = playback.owned(req.params.id, hash);
      requireThat(session.mode === 'plex_vod', 'INVALID_MODE', 'Subtitles are only available for on-demand media.', 403);
      const item = await plex.metadata(grant, session.rating_key);
      return reply.type('text/vtt; charset=utf-8').send(await subtitles.webvtt(grant, item, req.params.stream));
    });
    // Watch-history observations use the local session check; position and state updates reauthorize fully.
    routes.patch<Params>('/api/v1/playback/sessions/:id/progress', { config: { access: 'session' } }, async req => {
      const input = z.union([
        z.object({ timeMs: z.number().int().nonnegative(), state: z.enum(['playing', 'paused', 'stopped']), observation: playbackObservation.optional() }).strict(),
        z.object({ observation: playbackObservation }).strict()
      ]).parse(req.body);
      const { id } = req.params;
      if (input.observation) {
        const owner = session(req);
        const owned = playback.owned(id, owner);
        requireThat(owned.mode === 'plex_vod', 'HISTORY_WRITE_FORBIDDEN', 'Only on-demand playback can report this progress.', 403);
        history.observe(id, owner, input.observation);
      }
      if ('state' in input) {
        const { hash, grant } = await authorize(req, 'viewer');
        await playback.progress(id, hash, grant, input.timeMs, input.state);
        activity.progress(id, hash, input.timeMs, input.state);
        transcodes.touch(id, hash, grant);
      }
      return { status: 'synchronized' };
    });
    // Ends one session's delivery: its transcode and any open file requests.
    const endDelivery = (id: string, hash: string) => {
      if (transcodes.has(id, hash)) transcodes.stop(id);
      stopStreams(s => s.id === id && s.hash === hash);
    };
    routes.delete<Params>('/api/v1/playback/sessions/:id', { config: { access: 'viewer' } }, async req => {
      const { hash } = viewer(req), { id } = req.params;
      const replacing = z.object({ replacing: z.boolean().optional() }).parse(req.body ?? {}).replacing;
      playback.stop(id, hash);
      history.end(id, replacing ? 'replacing' : 'stopped');
      endDelivery(id, hash); activity.close(id);
      return { status: 'stopped' };
    });
    // Admin › Activity: a transcode that ended is no longer listed; direct play lasts as long as the player checks in.
    source('vod', {
      delivering: s => s.delivery === 'direct' || transcodes.has(s.id, s.hash),
      describe: async (s, _now, title) => ({ state: s.state, delivery: s.delivery, source: s.source, media: await title(s.mediaId), positionMs: s.positionMs, durationMs: s.durationMs }),
      stop: s => {
        try { playback.stop(s.id, s.hash); } catch { /* already ended */ }
        endDelivery(s.id, s.hash);
      }
    });
    // Sign-out: every delivery the browser session had open.
    bus.on('session.signed-out', ({ hash }) => { stopStreams(s => s.hash === hash); transcodes.stopWhere(t => t.hash === hash); });
    return {
      api: {},
      stop: () => { stopStreams(() => true); transcodes.close(); }
    };
  }
});
