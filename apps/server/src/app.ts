import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { existsSync, createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolve, join, extname } from 'node:path';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './persistence/database.js';
import { SettingsStore } from './persistence/database.js';
import { PlexAdapter, audioStreams, mediaMarkers, mediaTracks } from './providers/plex.js';
import { LocalMedia, byteRange, type LocalPart } from './providers/local-media.js';
import { IdentityService } from './services/identity.js';
import { PlaybackService } from './services/playback.js';
import { VodTranscodes } from './services/vod-transcode.js';
import { SubtitleService } from './services/subtitles.js';
import { AppError, requireThat } from './errors.js';
import { Vault } from './security/vault.js';
import { playbackSettings, quality } from '../../../packages/contracts/src/index.js';
import { chooseRoute, qualityOptions, EncoderBudget } from './streaming/policy.js';
import { IptvStore } from './persistence/iptv-store.js';
import { SourceRefresh } from './services/source-refresh.js';
import { registerIptv } from './iptv-api.js';
import { registerCatalog } from './catalog-api.js';
import { ClientEvents, registerEvents } from './events-api.js';
import { registerExplore } from './explore-api.js';
import { ExploreStore } from './persistence/explore-store.js';
import { LiveTv } from './services/live-tv.js';
import { HealthStore } from './persistence/channel-health-store.js';
import { ChannelHealth } from './services/channel-health.js';
import { registerChannelHealth } from './health-api.js';
import { IptvSettingsStore, iptvSettings } from './persistence/iptv-settings.js';
import { ProviderConnections } from './streaming/provider-connections.js';
import { SportsStore } from './persistence/sports-store.js';
import { ServiceKeys, serviceKeysInput } from './persistence/service-keys.js';
import { PlexBackground } from './services/plex-background.js';
import { SportsSchedule } from './services/sports-schedule.js';
import { DEFAULT_ESPN, DEFAULT_TSDB } from './providers/sports-feeds.js';
import { registerSports } from './sports-api.js';
import { CustomChannelStore } from './persistence/custom-channels.js';
import { registerCustomChannels } from './custom-api.js';
import { CustomTv } from './services/custom-tv.js';
import { PartProxy } from './providers/part-proxy.js';
import { EpisodeSync } from './services/episode-sync.js';
import { ArtworkStore } from './persistence/artwork-store.js';
import { ArtworkEngine } from './services/artwork-engine.js';
import { ArtworkWorker } from './services/artwork-worker.js';
import { ArtworkSchedule } from './services/artwork-schedule.js';
import { registerArtwork } from './artwork-api.js';
import { CleanupStore } from './persistence/cleanup-store.js';
import { CleanupEngine, type CleanupServices } from './services/cleanup-engine.js';
import { registerCleanup } from './cleanup-api.js';

export async function buildApp(config: Config, db: Db, vault: Vault, plex: PlexAdapter, logging = true, cookieNamespace = 'tk.box') {
  const app = Fastify({ logger: logging ? {level: 'info'} : false, logController: new LogController({disableRequestLogging: true}), bodyLimit: 65536, trustProxy: config.trustedProxies.length ? config.trustedProxies : false });
  const identity = new IdentityService(db, vault, plex), playback = new PlaybackService(db, plex), settings = new SettingsStore(db);
  const budget = new EncoderBudget(() => settings.get().maxConcurrentCpuVideoTranscodes);
  const transcodes = new VodTranscodes(plex, budget, async a => {
    const {grant} = await identity.authenticateHash(a.hash); await plex.metadata(grant, a.ratingKey); playback.owned(a.id, a.hash); return grant;
  });
  const localMedia = new LocalMedia(config.localMedia), subtitles = new SubtitleService(plex, config.FFMPEG_PATH, config.CACHE_DIR, localMedia);
  await app.register(cookie); await app.register(rateLimit, {max: 120, timeWindow: 60000});
  // Cookie scope does not include the port. Development harnesses on another
  // loopback port must use their own namespace to preserve real app sessions.
  const sessionCookie = config.secureCookies ? `__Host-${cookieNamespace}` : `${cookieNamespace}_local`, linkCookie = `${cookieNamespace}_link`;
  const cookieOpts = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/' };
  // Preserve existing browser sessions and in-progress Plex links during the rebrand.
  const legacyNamespace = cookieNamespace.replace(/^tk\.box(?=_|$)/, 'enki');
  const legacyCookies = legacyNamespace === cookieNamespace ? [] : [
    {old: config.secureCookies ? `__Host-${legacyNamespace}` : `${legacyNamespace}_local`, current: sessionCookie, maxAge: 43200},
    {old: `${legacyNamespace}_link`, current: linkCookie, maxAge: 600}
  ];
  const streams = new Set<{id: string; hash: string; abort: AbortController}>();
  const stopStreams = (matches: (s: {id: string; hash: string}) => boolean) => {for (const s of streams) if (matches(s)) s.abort.abort();};
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    // blob: images are ones the page made itself (the artwork layout editor's previews); data: stays blocked.
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      requireThat(req.headers.origin === config.browserOrigin, 'CSRF_REJECTED', 'Request origin is not permitted.', 403);
      requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 'INVALID_CONTENT_TYPE', 'Use application/json.', 415);
    }
    for (const migration of legacyCookies) {
      const value = req.cookies[migration.old];
      if (!value) continue;
      if (!req.cookies[migration.current]) {
        req.cookies[migration.current] = value;
        reply.setCookie(migration.current, value, {...cookieOpts, maxAge: migration.maxAge});
      }
      reply.clearCookie(migration.old, cookieOpts);
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const status = (error as {statusCode?: number}).statusCode;
    const e = error instanceof AppError ? error : error instanceof ZodError ? new AppError('VALIDATION_FAILED', 'Request contains invalid or missing values.') : [400,413,415,429].includes(status ?? 0) ? new AppError(status === 429 ? 'RATE_LIMITED' : 'INVALID_REQUEST', status === 429 ? 'Request rate limit reached.' : 'Request could not be accepted.', status) : new AppError('INTERNAL_ERROR', 'Request could not be completed.', 500);
    // Deliberately exclude raw request URLs, upstream data, exception messages and token headers.
    app.log.warn({code: e.code, requestId: req.id}, 'request rejected');
    reply.code(e.status).send({code: e.code, message: e.message, retryable: e.retryable});
  });
  const auth = (req: {cookies: Record<string, string | undefined>}) => identity.authenticate(req.cookies[sessionCookie]);
  const admin = async (req: {cookies: Record<string, string | undefined>}) => { const a = await auth(req); requireThat(a.grant.role === 'admin', 'FORBIDDEN', 'Administrator access required.', 403); return a; };
  const iptv = new IptvStore(db,vault);
  const refresh = new SourceRefresh(iptv), custom = new CustomChannelStore(db);
  registerIptv(app,iptv,refresh,auth,admin,undefined,undefined,custom,async (req,id,kind) => plex.artwork((await auth(req)).grant,id,kind));
  // Background work reads Plex with the owner's Plex token from Admin › Connections.
  const serviceKeys = new ServiceKeys(db, vault), background = new PlexBackground(serviceKeys, plex, (message, detail) => app.log.warn(detail, message));
  const episodes = new EpisodeSync(custom, plex, () => background.grant(), (message, detail) => app.log.info(detail, message));
  registerCustomChannels(app,custom,plex,admin,episodes);
  app.addHook('onReady', async () => { episodes.start(); });
  const live = new LiveTv(iptv, budget, config.CACHE_DIR, config.FFMPEG_PATH, config.FFPROBE_PATH, (message, detail) => app.log.warn(detail, message));
  // Channel checks hide channels that fail to play or show a provider's offline screen.
  const healthStore = new HealthStore(db), health = new ChannelHealth(iptv, healthStore, config.CACHE_DIR, config.FFMPEG_PATH, (message, detail) => app.log.info(detail, message));
  // Every viewer and check, on any source, draws from one server-wide connection limit; viewers always come first.
  const iptvConfig = new IptvSettingsStore(db), connections = new ProviderConnections(() => iptvConfig.get().maxConnections);
  live.connections = connections; health.connections = connections;
  app.get('/api/v1/admin/iptv/settings', async req => { await admin(req); return {...iptvConfig.get(), connections: connections.usage()}; });
  app.put('/api/v1/admin/iptv/settings', async req => {
    const {grant} = await admin(req), {expectedRevision, ...value} = iptvSettings.extend({expectedRevision: z.number().int().nonnegative()}).strict().parse(req.body);
    const saved = iptvConfig.update(grant.accountId, expectedRevision, value); health.pump(); return {...saved, connections: connections.usage()};
  });
  health.relays = {live: id => live.isLive(id)};
  live.observer = {tuned: id => health.tuned(id), tuneFailed: id => health.tuneFailed(id)};
  registerChannelHealth(app, iptv, healthStore, health, admin);
  // Sports events: event-driven sources show a channel only while the event it names is on.
  const list = (value: string | undefined, fallback: string[]) => { const items = (value ?? '').split(',').map(s => s.trim()).filter(Boolean); return items.length ? items : fallback; };
  // Without a saved TheSportsDB key, its free public key ('123') is used.
  const sportsStore = new SportsStore(db, id => iptv.relist(id)), sports = new SportsSchedule(iptv, sportsStore, healthStore, () => health.pump(),
    {espn: list(config.SPORTS_ESPN_LEAGUES, DEFAULT_ESPN), tsdb: list(config.SPORTS_TSDB_LEAGUES, DEFAULT_TSDB), tsdbKey: () => serviceKeys.get('thesportsdb') ?? '123', zone: config.SPORTS_NAME_TIMEZONE ?? 'America/New_York', nameHours: 3, tickMs: 60000},
    (message, detail) => app.log.info(detail, message));
  registerSports(app, iptv, sportsStore, sports, admin);
  // Admin › Connections: keys no feature's own settings hold. A new TheSportsDB key is used from the next download on,
  // a new Plex admin token from the next background task.
  app.get('/api/v1/admin/keys', async req => { await admin(req); return serviceKeys.view(); });
  // A Plex admin token is saved only once Plex vouches for it as the server owner's.
  app.put('/api/v1/admin/keys', async req => {
    const {grant} = await admin(req), input = serviceKeysInput.parse(req.body);
    if (input.plex) await background.check(input.plex).catch((e: AppError) => { throw e.code === 'PLEX_TOKEN_NOT_OWNER' || e.code === 'PLEX_UNAVAILABLE' ? e : new AppError('PLEX_TOKEN_REJECTED', 'Plex didn’t accept that token.', 400); });
    const saved = serviceKeys.update(grant.accountId, input); sports.invalidate(); background.invalidate(); return saved;
  });
  refresh.published = () => sports.invalidate();
  app.addHook('onReady', async () => { void sports.tick(); });
  // Custom channels share the live session routes; their sessions belong to CustomTv.
  const parts = new PartProxy(plex), customTv = new CustomTv(custom, plex, localMedia, parts, budget, config.CACHE_DIR, () => settings.get().pauseRetentionMinutes * 60000, config.SEGMENT_CACHE_MAX_BYTES,
    config.FFMPEG_PATH, (message, detail) => app.log.warn(detail, message));
  // Pause, Resume and Go Live exist only on custom channels; IPTV stays strictly live.
  const timeshift = <T>(id: string, run: () => T) => { requireThat(customTv.has(id), 'NOT_SUPPORTED', 'Only Plex channels can be paused.', 409); return run(); };
  app.get<{Params: {id: string}}>('/api/v1/live/sessions/:id/state', async req => { const {hash} = await auth(req); return timeshift(req.params.id, () => customTv.state(req.params.id, hash)); });
  app.post<{Params: {id: string}}>('/api/v1/live/sessions/:id/pause', async req => {
    const {hash} = await auth(req), input = z.object({displayedUtc: z.number().finite()}).strict().parse(req.body);
    return timeshift(req.params.id, () => customTv.pause(req.params.id, hash, input.displayedUtc));
  });
  app.post<{Params: {id: string}}>('/api/v1/live/sessions/:id/resume', async req => { const {hash} = await auth(req); z.object({}).strict().parse(req.body); return timeshift(req.params.id, () => customTv.resume(req.params.id, hash)); });
  app.post<{Params: {id: string}}>('/api/v1/live/sessions/:id/go-live', async req => { const {hash} = await auth(req); z.object({}).strict().parse(req.body); return timeshift(req.params.id, () => customTv.goLive(req.params.id, hash)); });
  // Custom channels are Plex media, so they offer each program's subtitles; IPTV has none.
  app.get<{Params: {id: string}}>('/api/v1/live/sessions/:id/programs', async req => {
    const {hash} = await auth(req); requireThat(customTv.has(req.params.id), 'NOT_SUPPORTED', 'Only Plex channels have subtitles.', 409);
    return {programs: customTv.airings(req.params.id, hash)};
  });
  app.get<{Params: {id: string; airing: string; stream: string}}>('/api/v1/live/sessions/:id/subtitles/:airing/:stream', async (req, reply) => {
    requireThat(/^\d+$/.test(req.params.stream) && /^[\w-]{1,32}$/.test(req.params.airing), 'INVALID_MEDIA', 'Invalid subtitle identifier.');
    const {hash, grant} = await auth(req); requireThat(customTv.has(req.params.id), 'NOT_SUPPORTED', 'Only Plex channels have subtitles.', 409);
    const item = await plex.metadata(grant, customTv.airingMedia(req.params.id, hash, req.params.airing));
    return reply.type('text/vtt; charset=utf-8').send(await subtitles.webvtt(grant, item, req.params.stream));
  });
  app.post('/api/v1/live/sessions', {config: {rateLimit: {max: 30, timeWindow: 60000}}}, async req => {
    const input = z.object({channelId: z.string().uuid()}).strict().parse(req.body), {hash, grant} = await auth(req);
    return custom.exists(input.channelId) ? customTv.start(hash, grant, input.channelId) : live.start(hash, input.channelId);
  });
  // Playlists reauthorize fully, like VOD; segments use the local session check.
  app.get<{Params: {id: string; file: string}}>('/api/v1/live/sessions/:id/:file', {config: {rateLimit: {max: 1200, timeWindow: 60000}}}, async (req, reply) => {
    const service = customTv.has(req.params.id) ? customTv : undefined;
    if (req.params.file === 'index.m3u8') { const {hash, grant} = await auth(req); return reply.type('application/vnd.apple.mpegurl').send(await (service ? service.playlist(req.params.id, hash, grant) : live.playlist(req.params.id, hash))); }
    const segment = await (service ?? live).segment(req.params.id, identity.session(req.cookies[sessionCookie]), req.params.file);
    return reply.type('video/mp2t').header('content-length', String(segment.size)).send(segment.body);
  });
  app.delete<{Params: {id: string}}>('/api/v1/live/sessions/:id', async req => { const {hash} = await auth(req); live.stop(req.params.id, hash); customTv.stop(req.params.id, hash); return {status: 'stopped'}; });
  registerCatalog(app,plex,auth);
  // Open pages hear when artwork or cleanup jobs change the library, and reload what they show.
  const events = new ClientEvents();
  registerEvents(app, events, auth);
  const exploreStore = new ExploreStore(db, vault);
  registerExplore(app, plex, exploreStore, auth, admin, hash => identity.accountToken(hash));
  // Artwork: the engine runs as a separate Python process, apart from every playback path.
  const artworkStore = new ArtworkStore(db, vault, resolve('apps/artwork/defaults.json'));
  const artwork = new ArtworkEngine(artworkStore, {python: config.PYTHON_PATH, script: resolve('apps/artwork/overlayrr.py'), collectionsScript: resolve('apps/artwork/plex_collections.py'), dataDir: config.DATA_DIR, cacheDir: config.CACHE_DIR, plexUrl: config.PLEX_URL},
    (message, detail) => app.log.info(detail, message), () => exploreStore.view().traktClientId || undefined);
  const artworkWorker = new ArtworkWorker(artwork, (message, detail) => app.log.warn(detail, message));
  const artworkSchedule = new ArtworkSchedule(artworkStore, artwork, plex, () => background.grant(), (message, detail) => app.log.warn(detail, message));
  registerArtwork(app, artworkStore, artwork, artworkWorker, artworkSchedule, admin);
  artwork.finished = () => events.publish('library');
  app.addHook('onReady', async () => { artworkSchedule.start(); });
  app.addHook('onClose', async () => { artworkSchedule.close(); artworkWorker.close(); artwork.close(); });
  // Clean Up: the purge script runs as a separate Python process too. Seerr is Explore's connection, Radarr is Collections'.
  const cleanupStore = new CleanupStore(db, vault);
  const cleanupServices = (): CleanupServices => {
    const {radarr, radarrKey} = artworkStore.collectionsConfig(), own = cleanupStore.connections();
    return {seerr: exploreStore.seerr(), radarr: {url: radarr.url, key: radarrKey}, tautulli: {url: own.tautulliUrl, key: own.tautulliKey}, sonarr: {url: own.sonarrUrl, key: own.sonarrKey}};
  };
  const cleanup = new CleanupEngine(cleanupStore, {python: config.PYTHON_PATH, script: resolve('apps/cleanup/purge_requests.py'), poster: resolve('apps/cleanup/leaving-soon.png'), dataDir: config.DATA_DIR, plexUrl: config.PLEX_URL},
    cleanupServices, () => background.grant(), (message, detail) => app.log.info(detail, message));
  registerCleanup(app, cleanupStore, cleanup, cleanupServices, admin);
  cleanup.finished = () => events.publish('library');
  app.addHook('onReady', async () => { cleanup.start(); });
  app.addHook('onClose', async () => { cleanup.close(); });
  app.get('/health', async () => ({status: 'ok'}));
  app.get('/api/v1/setup', async () => ({plexConfigured: config.plexConfigured, milestone: 0}));
  app.post('/api/v1/auth/plex/start', { config: {rateLimit: {max: 10, timeWindow: 60000}} }, async (_req, reply) => {
    requireThat(config.plexConfigured, 'SETUP_REQUIRED', 'Configure Plex owner, machine and library IDs.', 503);
    const start = await identity.start(); reply.setCookie(linkCookie, start.binding, {...cookieOpts, maxAge: 600}); return {authUrl: start.authUrl};
  });
  app.post('/api/v1/auth/plex/status', async (req, reply) => {
    requireThat(req.cookies[linkCookie], 'AUTH_EXPIRED', 'Start Plex sign-in first.', 401);
    const result = await identity.finish(req.cookies[linkCookie]);
    if (!result) return {status: 'pending'};
    reply.clearCookie(linkCookie, cookieOpts).setCookie(sessionCookie, result.cookie, {...cookieOpts, maxAge: 43200});
    return {status: 'authenticated'};
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[sessionCookie];
    if (token) {const {digest} = await import('./security/vault.js'); const hash = digest(token); stopStreams(s => s.hash === hash); transcodes.stopWhere(t => t.hash === hash); live.stopWhere(v => v.hash === hash); customTv.stopWhere(v => v.hash === hash);}
    identity.logout(token); reply.clearCookie(sessionCookie, cookieOpts); return {status: 'signed_out'};
  });
  app.get('/api/v1/me', async req => { const {grant} = await auth(req); return {accountId: grant.accountId, role: grant.role,libraries:grant.libraries.filter(l=>['movie','show'].includes(l.type))}; });
  app.get('/api/v1/libraries', async req => ({libraries: (await auth(req)).grant.libraries}));
  app.get<{Params: {id: string}}>('/api/v1/media/:id', async req => {
    const {grant} = await auth(req), item = await plex.metadata(grant, req.params.id);
    return {ratingKey: item.ratingKey, title: item.title, durationMs: item.duration, viewOffsetMs: item.viewOffset ?? 0};
  });
  const caps = z.object({videoCodecs: z.array(z.string().max(40)).max(20), audioCodecs: z.array(z.string().max(40)).max(20), containers: z.array(z.string().max(40)).max(20)}).strict();
  app.post('/api/v1/playback/sessions', {config: {rateLimit: {max: 20, timeWindow: 60000}}}, async req => {
    // startAtMs with audioStreamId or quality restarts a title at the current position with another track or quality.
    const input = z.object({mode: z.literal('plex_vod'), ratingKey: z.string().regex(/^\d+$/), capabilities: caps,startFrom:z.enum(['resume','beginning']).default('resume'),
      startAtMs: z.number().int().nonnegative().optional(), audioStreamId: z.string().regex(/^\d+$/).max(20).optional(), quality: quality.default('auto')}).strict().parse(req.body);
    const {hash, grant} = await auth(req), item = await plex.metadata(grant, input.ratingKey, {markers: true}), media = item.Media[0];
    requireThat(media, 'SOURCE_INCOMPATIBLE', 'No playable media.', 422);
    const video = media.Part[0]?.Stream?.find(s => s.streamType === 1), {audio, fileDefault, plexSelected} = audioStreams(item);
    const requested = input.audioStreamId === undefined ? undefined : audio.find(s => s.id === input.audioStreamId);
    requireThat(input.audioStreamId === undefined || requested, 'INVALID_AUDIO', 'Audio track is not part of this media.');
    // Browsers play only the file's default audio, so any other track needs Plex HLS.
    const target = requested ?? plexSelected ?? fileDefault, otherTrack = !!target && target.id !== fileDefault?.id;
    const sourceVideo = {codec: media.videoCodec, width: media.width, height: media.height, container: media.container, audioCodec: target?.codec ?? media.audioCodec, bitDepth: video?.bitDepth, bitrateKbps: media.bitrate};
    const route = chooseRoute(sourceVideo, input.capabilities, input.quality, false, !otherTrack);
    const startOffsetMs = Math.max(0, Math.min(input.startAtMs ?? (input.startFrom==='beginning' ? 0 : item.viewOffset ?? 0), item.duration));
    // Track and source details let the player offer subtitles and describe the stream; markers let it skip intros and credits.
    const playing = route.kind === 'direct' ? fileDefault : target;
    const details = {tracks: mediaTracks(item, playing?.id), markers: mediaMarkers(item), source: {videoCodec: media.videoCodec, audioCodec: playing?.codec ?? media.audioCodec, width: media.width, height: media.height, container: media.container, bitrateKbps: media.bitrate},
      quality: input.quality, qualityOptions: qualityOptions(sourceVideo, input.capabilities, false, !otherTrack)};
    if (route.kind === 'direct') return {...playback.createVod(hash, input.ratingKey, startOffsetMs), ...details};
    if (requested && requested.id !== plexSelected?.id) await plex.selectAudioStream(grant, item, requested.id);
    const created = playback.createVod(hash, input.ratingKey, startOffsetMs, route.kind === 'remux' ? 'remux' : 'transcode');
    try {await transcodes.start(created.id, hash, grant, item, route, requested || otherTrack ? {id: target!.id, codec: target!.codec} : undefined);} catch (e) {playback.stop(created.id, hash); throw e;}
    return {...created, ...details};
  });
  // Plex transcoder HLS proxy. Playlists reauthorize fully; segments use the
  // local session check plus the transcoder's periodic Plex reauthorization.
  app.get<{Params: {id: string; '*': string}}>('/api/v1/playback/sessions/:id/hls/*', {config: {rateLimit: {max: 1200, timeWindow: 60000}}}, async (req, reply) => {
    const rel = req.params['*'], playlist = rel.endsWith('.m3u8');
    const hash = playlist ? (await auth(req)).hash : identity.session(req.cookies[sessionCookie]);
    playback.owned(req.params.id, hash);
    const abort = new AbortController(); reply.raw.once('close', () => abort.abort());
    const result = await transcodes.fetch(req.params.id, hash, rel, req.url.split('?')[1] ?? '', abort.signal);
    if (result.kind === 'playlist') return reply.type('application/vnd.apple.mpegurl').send(result.body);
    const {response} = result;
    reply.code(response.status);
    for (const h of ['content-type', 'content-length']) if (response.headers.has(h)) reply.header(h, response.headers.get(h)!);
    return reply.send(response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : null);
  });
  app.get<{Params: {id: string}}>('/api/v1/playback/sessions/:id/file', async (req, reply) => {
    const {hash, grant} = await auth(req), session = playback.owned(req.params.id, hash);
    requireThat(session.mode === 'plex_vod', 'INVALID_MODE', 'This endpoint only serves on-demand media.', 403);
    if (req.headers.range) requireThat(/^bytes=\d*-\d*$/.test(req.headers.range), 'INVALID_RANGE', 'Only a single byte range is supported.');
    const item = await plex.metadata(grant, session.rating_key), running = {id: session.id, hash, abort: new AbortController()};
    requireThat([...streams].filter(s => s.hash === hash).length < 20, 'STREAM_LIMIT', 'Too many open media requests.', 429);
    streams.add(running);
    const timer = setInterval(() => {void auth(req).then(a => plex.metadata(a.grant, session.rating_key)).then(() => playback.owned(session.id, hash)).catch(() => running.abort.abort());}, 15000); timer.unref();
    const cleanup = () => {clearInterval(timer); running.abort.abort(); streams.delete(running);};
    reply.raw.once('close', cleanup);
    // Same-host mode: serve the authorized part from disk, else proxy Plex below.
    let local: LocalPart | undefined;
    try {local = await localMedia.open(grant, item);} catch(e) {cleanup(); throw e;}
    if (local) {
      const range = byteRange(req.headers.range, local.size);
      reply.header('accept-ranges', 'bytes');
      if (range === 'unsatisfiable') {await local.handle.close(); return reply.code(416).header('content-range', `bytes */${local.size}`).send();}
      const {start, end} = range ?? {start: 0, end: local.size - 1};
      reply.code(range ? 206 : 200).type(local.type).header('content-length', String(end - start + 1));
      if (range) reply.header('content-range', `bytes ${start}-${end}/${local.size}`);
      if (end < start) {await local.handle.close(); return reply.send(Buffer.alloc(0));}
      const body = local.handle.createReadStream({start, end, autoClose: true});
      if (running.abort.signal.aborted) body.destroy(); else running.abort.signal.addEventListener('abort', () => body.destroy(), {once: true});
      return reply.send(body);
    }
    let response: Response;
    try {response = await plex.directPart(grant, item, req.headers.range, running.abort.signal);} catch(e) {cleanup(); throw e;}
    reply.code(response.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers.has(h)) reply.header(h, response.headers.get(h)!);
    return reply.send(response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : null);
  });
  app.get<{Params: {id: string; stream: string}}>('/api/v1/playback/sessions/:id/subtitles/:stream', async (req, reply) => {
    requireThat(/^\d+$/.test(req.params.stream), 'INVALID_MEDIA', 'Invalid subtitle identifier.');
    const {hash, grant} = await auth(req), session = playback.owned(req.params.id, hash);
    requireThat(session.mode === 'plex_vod', 'INVALID_MODE', 'Subtitles are only available for on-demand media.', 403);
    const item = await plex.metadata(grant, session.rating_key);
    return reply.type('text/vtt; charset=utf-8').send(await subtitles.webvtt(grant, item, req.params.stream));
  });
  app.patch<{Params: {id: string}}>('/api/v1/playback/sessions/:id/progress', async req => {
    const input = z.object({timeMs: z.number().int().nonnegative(), state: z.enum(['playing', 'paused', 'stopped'])}).strict().parse(req.body);
    const {hash, grant} = await auth(req); await playback.progress(req.params.id, hash, grant, input.timeMs, input.state); transcodes.touch(req.params.id, hash, grant); return {status: 'synchronized'};
  });
  app.delete<{Params: {id: string}}>('/api/v1/playback/sessions/:id', async req => { const {hash} = await auth(req); playback.stop(req.params.id, hash); if (transcodes.has(req.params.id, hash)) transcodes.stop(req.params.id); stopStreams(s => s.id === req.params.id && s.hash === hash); return {status: 'stopped'}; });
  app.get('/api/v1/admin/settings/playback', async req => { await admin(req); return {...settings.get(), activeVideoEncoders: budget.count, customBuffer: customTv.usage()}; });
  app.patch('/api/v1/admin/settings/playback', async req => {
    const {grant} = await admin(req), input = playbackSettings.extend({expectedRevision: z.number().int().nonnegative()}).strict().parse(req.body);
    const {expectedRevision, ...value} = input; return settings.update(grant.accountId, expectedRevision, value);
  });
  const webRoot = resolve('dist/web');
  // Register only the trusted build's actual public files; no user-supplied filesystem paths,
  // directory listing, symlink traversal, wildcard routing or media-cache mount.
  const types: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  const registerAssets = async (dir: string, prefix: string) => {
    for (const file of await readdir(dir,{withFileTypes:true})) {
      if (file.name.startsWith('.')) continue;
      const path = join(dir,file.name), url = `${prefix}/${file.name}`;
      if (file.isDirectory()) await registerAssets(path,url);
      else if (file.isFile() && types[extname(file.name)]) {
        // Vite emits content-hashed names under /assets, so those can be cached forever;
        // the HTML entry point is always revalidated so new builds are picked up.
        const caching = url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
        const handler = async (_req: unknown, reply: import('fastify').FastifyReply) => reply.type(types[extname(file.name)]!).header('Cache-Control', caching).send(createReadStream(path));
        app.get(url,handler); if (url === '/index.html') app.get('/',handler);
      }
    }
  };
  if (existsSync(webRoot)) await registerAssets(webRoot,'');
  const reaper = setInterval(() => identity.reap(), 30000); reaper.unref();
  app.addHook('preClose', async () => {stopStreams(() => true); transcodes.close(); live.close(); customTv.close(); parts.close(); episodes.close(); health.close(); sports.close();});
  app.addHook('onClose', async () => { clearInterval(reaper); });
  return app;
}
