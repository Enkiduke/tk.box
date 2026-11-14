import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './persistence/database.js';
import { SettingsStore } from './persistence/database.js';
import { PlexAdapter } from './providers/plex.js';
import { LocalMedia } from './providers/local-media.js';
import { IdentityService } from './services/identity.js';
import { SubtitleService } from './services/subtitles.js';
import { AppError, requireThat } from './errors.js';
import type { Vault } from './security/vault.js';
import { EncoderBudget } from './streaming/policy.js';
import { ServiceKeys } from './persistence/service-keys.js';
import { AdminStore } from './persistence/admin-store.js';
import { PlexBackground } from './services/plex-background.js';
import { ServerMetrics } from './services/metrics.js';
import { installAccess, requireDeclaredAccess } from './modules/access.js';
import { EventBus } from './modules/bus.js';
import { mountModule, type ModuleContext } from './modules/module.js';
import { iptvModule } from './modules/iptv.js';
import { customChannelsModule } from './modules/custom-channels.js';
import { liveSessionsModule } from './modules/live-sessions.js';
import { vodPlaybackModule } from './modules/vod-playback.js';
import { watchHistoryModule } from './modules/watch-history.js';
import { activityModule } from './modules/activity.js';
import { artworkModule } from './modules/artwork.js';
import { cleanupModule } from './modules/cleanup.js';
import { arrModule } from './modules/arr.js';
import { requestsModule } from './modules/requests.js';
import { clientEventsModule } from './modules/client-events.js';
import { catalogModule } from './modules/catalog.js';
import { exploreModule } from './modules/explore.js';
import { calendarModule } from './modules/calendar.js';
import { plexNotificationsModule } from './modules/plex-notifications.js';
import { signInModule } from './modules/sign-in.js';
import { adminModule } from './modules/admin.js';
import { connectionHealth } from './services/connection-health.js';
import { webModule } from './modules/web.js';

export async function buildApp(config: Config, db: Db, vault: Vault, plex: PlexAdapter, logging = true, cookieNamespace = 'tk.box', exploreTransports: {tmdb?:typeof fetch; seerr?:typeof fetch; images?:typeof fetch} = {}) {
  const app = Fastify({ logger: logging ? {level: 'info'} : false, logController: new LogController({disableRequestLogging: true}), bodyLimit: 65536, trustProxy: config.trustedProxies.length ? config.trustedProxies : false });
  const identity = new IdentityService(db, vault, plex, config.PLEX_RECHECK_SECONDS * 1000), settings = new SettingsStore(db);
  const budget = new EncoderBudget(() => settings.get().maxConcurrentCpuVideoTranscodes);
  const localMedia = new LocalMedia(config.localMedia), subtitles = new SubtitleService(plex, config.FFMPEG_PATH, config.CACHE_DIR, localMedia);
  await app.register(cookie); await app.register(rateLimit, {max: 120, timeWindow: 60000});
  // JSON, scripts, styles and playlists go out brotli/gzip-compressed; images, video and byte ranges never are, and
  // request bodies are never decompressed. Registered before any route, since it attaches to each route as it is added.
  await app.register(compress, {encodings: ['br', 'gzip'], globalDecompression: false});
  // Cookie scope does not include the port. Development harnesses on another
  // loopback port must use their own namespace to preserve real app sessions.
  const sessionCookie = config.secureCookies ? `__Host-${cookieNamespace}` : `${cookieNamespace}_local`, linkCookie = `${cookieNamespace}_link`;
  const previewHosts = cookieNamespace === 'tk.box_readonly' && config.APP_HOST === 'localhost' && !config.PUBLIC_BASE_URL
    ? new Set(['localhost', '127.0.0.1', '[::1]'].map(host => `${host}:${config.APP_PORT}`))
    : undefined;
  const cookieOpts = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/' };
  // The browser keeps the sign-in cookie as long as it allows (400 days); the server ends the session itself after 7 days unused.
  const sessionCookieAge = 400 * 24 * 60 * 60;
  // Preserve existing browser sessions and in-progress Plex links during the rebrand.
  const legacyNamespace = cookieNamespace.replace(/^tk\.box(?=_|$)/, 'enki');
  const legacyCookies = legacyNamespace === cookieNamespace ? [] : [
    {old: config.secureCookies ? `__Host-${legacyNamespace}` : `${legacyNamespace}_local`, current: sessionCookie, maxAge: sessionCookieAge},
    {old: `${legacyNamespace}_link`, current: linkCookie, maxAge: 600}
  ];
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    // blob: images are ones the page made itself (the artwork layout editor's previews); data: stays blocked.
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const host = req.headers.host, peer = req.raw.socket.remoteAddress;
      const validOrigin = previewHosts
        ? !!host && previewHosts.has(host) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') && req.headers.origin === `http://${host}`
        : req.headers.origin === config.browserOrigin;
      requireThat(validOrigin, 'CSRF_REJECTED', 'Request origin is not permitted.', 403);
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
    // Plex refused something: the viewer's next request checks their access with Plex again.
    if (e.code === 'PLEX_ACCESS_DENIED') identity.forget(req.cookies[sessionCookie]);
    reply.code(e.status).send({code: e.code, message: e.message, retryable: e.retryable});
  });
  const auth = (req: {cookies: Record<string, string | undefined>}) => identity.authenticate(req.cookies[sessionCookie]);
  // Admins are the Plex server owner and the Plex accounts the owner made admins (Admin › Admins). Plex lets only the
  // owner's token change the server, so the others act on Plex with the owner's saved Plex admin token (Admin ›
  // Connections), as themselves in tk.box's audit; without one saved they keep their own.
  const admins = new AdminStore(db);
  const admin = async (req: {cookies: Record<string, string | undefined>}) => {
    const a = await auth(req);
    if (a.grant.role === 'admin') return a;
    requireThat(admins.has(a.grant.accountId), 'FORBIDDEN', 'Administrator access required.', 403);
    const {name: _, ...owner} = await background.grant() ?? a.grant;
    return {...a, grant: {...owner, accountId: a.grant.accountId, ...(a.grant.name ? {name: a.grant.name} : {}), role: 'admin' as const}};
  };
  // Admin › metrics: event-loop delay, route timings and Plex reads since the server started.
  const metrics = new ServerMetrics();
  plex.observe = (ms, ok) => metrics.plex(ms, ok);
  app.addHook('onReady', async () => { metrics.start(); });
  app.addHook('onClose', async () => { metrics.stop(); });
  app.addHook('onResponse', async (req, reply) => { metrics.route(`${req.method} ${req.routeOptions.url ?? 'unmatched'}`, reply.elapsedTime, reply.statusCode < 500); });
  const ownerOnly = async (req: {cookies: Record<string, string | undefined>}) => { const a = await auth(req); requireThat(a.grant.role === 'admin', 'FORBIDDEN', 'Only the Plex server owner can do that.', 403); return a; };
  // Every route declares an access level, checked here before its handler runs; one that declares none stops startup.
  installAccess(app, {viewer: auth, admin, owner: ownerOnly, session: async req => identity.session(req.cookies[sessionCookie])});
  requireDeclaredAccess(app);
  const bus = new EventBus((message, detail) => app.log.warn(detail, message));
  // Plex caches go first, so every module reacting to the same change (and every page told to reload) reads Plex anew.
  bus.on('plex.library.changed', () => plex.forgetIndexes());
  bus.on('library.edited', () => plex.forgetMetadata());
  // Background work reads Plex with the owner's Plex token from Admin › Connections.
  const serviceKeys = new ServiceKeys(db, vault), background = new PlexBackground(serviceKeys, plex, (message, detail) => app.log.warn(detail, message));
  const ctx: ModuleContext = {config, db, vault, plex, bus, budget, serviceKeys, background,
    log: {info: (message, detail) => app.log.info(detail ?? {}, message), warn: (message, detail) => app.log.warn(detail ?? {}, message)}};
  // Watch history and Admin › Activity come first: every playback module reports to them.
  const {history, monitor: plexMonitor} = await mountModule(app, ctx, watchHistoryModule, undefined);
  const plexSessions = (grant: Parameters<typeof plex.sessions>[0]) => plexMonitor.sessions(grant);
  const activityApi = await mountModule(app, ctx, activityModule, {history, plexSessions}), {activity} = activityApi;
  // Custom channels share the live session routes with IPTV; their sessions belong to CustomTv.
  const {store: custom, tv: customTv} = await mountModule(app, ctx, customChannelsModule, {localMedia, pauseRetentionMs: () => settings.get().pauseRetentionMinutes * 60000});
  const {store: iptv, live} = await mountModule(app, ctx, iptvModule, {custom});
  await mountModule(app, ctx, liveSessionsModule, {live, iptv, customTv, custom, activity: activityApi, history, subtitles});
  await mountModule(app, ctx, vodPlaybackModule, {identity, activity: activityApi, history, subtitles, localMedia});
  await mountModule(app, ctx, clientEventsModule, undefined);
  // Anyone streaming, in tk.box or any Plex app, holds back the nightly full collections run.
  const streaming = async (grant: Parameters<typeof plex.sessions>[0]) => activity.list(() => true, Date.now()).length + (await plexSessions(grant)).length;
  // Radarr and Sonarr, read by Collections, Clean Up and the calendar.
  const arr = await mountModule(app, ctx, arrModule, undefined);
  const artwork = await mountModule(app, ctx, artworkModule, {streaming, tmdbTransport: exploreTransports.tmdb, arr}), tmdbTitles = artwork.titles;
  await mountModule(app, ctx, catalogModule, {hiddenRecent: () => artwork.engine.hiddenFromRecent()});
  await mountModule(app, ctx, requestsModule, {arr, titles: tmdbTitles});
  const {store: exploreStore} = await mountModule(app, ctx, exploreModule, {accountToken: hash => identity.accountToken(hash), titles: tmdbTitles, transports: exploreTransports});
  await mountModule(app, ctx, plexNotificationsModule, undefined);
  const cleanup = await mountModule(app, ctx, cleanupModule, {artwork, arr, seerr: () => exploreStore.seerr()});
  await mountModule(app, ctx, calendarModule, {connections: () => ({radarr: arr.connection('radarr'), sonarr: arr.connection('sonarr')}), titles: tmdbTitles});
  await mountModule(app, ctx, signInModule, {identity, admins, cookies: {session: sessionCookie, link: linkCookie, setup: `${cookieNamespace}_setup`, options: cookieOpts, sessionAge: sessionCookieAge}});
  await mountModule(app, ctx, adminModule, {admins, settings, metrics, identity, customBuffer: () => customTv.usage(),
    checkConnections: connectionHealth(cleanup.services, () => artwork.store.keys(), exploreTransports)});
  await mountModule(app, ctx, webModule, undefined);
  return app;
}
