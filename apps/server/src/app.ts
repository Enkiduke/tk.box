import Fastify, { LogController, type FastifyRequest } from 'fastify';
import { RequestsSite } from './services/requests-site.js';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './persistence/database.js';
import { SettingsStore } from './persistence/database.js';
import { PlexAdapter } from './providers/plex.js';
import { LocalMedia } from './providers/local-media.js';
import { IdentityService, isOwner } from './services/identity.js';
import { SubtitleService } from './services/subtitles.js';
import { AppError, requireThat } from './errors.js';
import type { Vault } from './security/vault.js';
import { EncoderBudget } from './streaming/policy.js';
import { ServiceKeys } from './persistence/service-keys.js';
import { PlexBackground } from './services/plex-background.js';
import { plexOwner as ownerGrant } from './services/plex-owner.js';
import { TmdbTitles } from './providers/tmdb-titles.js';
import { ServerMetrics } from './services/metrics.js';
import { bearerToken, installAccess, requireDeclaredAccess } from './modules/access.js';
import { SubtitleWorkerStore } from './persistence/subtitle-worker-store.js';
import { EventBus } from './modules/bus.js';
import { mountModule, type ModuleContext } from './modules/module.js';
import { Jobs } from './services/jobs.js';
import { jobsModule } from './modules/jobs.js';
import { iptvModule } from './modules/iptv.js';
import { customChannelsModule } from './modules/custom-channels.js';
import { liveSessionsModule } from './modules/live-sessions.js';
import { vodPlaybackModule } from './modules/vod-playback.js';
import { watchHistoryModule } from './modules/watch-history.js';
import { activityModule } from './modules/activity.js';
import { playbackSessionsModule } from './modules/playback-sessions.js';
import { artworkModule } from './modules/artwork.js';
import { cleanupModule } from './modules/cleanup.js';
import { requestsModule } from './modules/requests.js';
import { clientEventsModule } from './modules/client-events.js';
import { notificationsModule } from './modules/notifications.js';
import { queueModule } from './modules/queue.js';
import { indexersModule } from './modules/indexers.js';
import { downloadersModule } from './modules/downloaders.js';
import { libraryModule } from './modules/library.js';
import { plexIndexModule } from './modules/plex-index.js';
import { subtitleFinderModule } from './modules/subtitle-finder.js';
import { systemAlertsModule } from './modules/system-alerts.js';
import { catalogModule } from './modules/catalog.js';
import { exploreModule } from './modules/explore.js';
import { calendarModule } from './modules/calendar.js';
import { plexNotificationsModule } from './modules/plex-notifications.js';
import { signInModule } from './modules/sign-in.js';
import { adminModule } from './modules/admin.js';
import { webModule } from './modules/web.js';

declare module 'fastify' {
  interface FastifyRequest { portal: boolean }
}

export async function buildApp(config: Config, db: Db, vault: Vault, plex: PlexAdapter, logging = true, cookieNamespace = 'tk.box', exploreTransports: {tmdb?:typeof fetch; images?:typeof fetch} = {}) {
  // The Requests site (Admin › Requests) is a second listener on this same app: one set of services, jobs and caches.
  // Its requests reach only routes marked `portal` (modules/module.ts).
  // It takes requests through app.routing, the handler the main server uses. (A serverFactory would stop Fastify
  // binding both 127.0.0.1 and ::1 for APP_HOST=localhost.)
  const app = Fastify({ logger: logging ? {level: 'info'} : false, logController: new LogController({disableRequestLogging: true}), bodyLimit: 65536, trustProxy: config.trustedProxies.length ? config.trustedProxies : false });
  const site = new RequestsSite(config, () => app.routing);
  app.addHook('onClose', async () => { await site.close(); });
  app.decorateRequest('portal', false);
  const identity = new IdentityService(db, vault, plex, config.PLEX_RECHECK_SECONDS * 1000), settings = new SettingsStore(db);
  const budget = new EncoderBudget(() => settings.get().maxConcurrentCpuVideoTranscodes);
  const localMedia = new LocalMedia(config.localMedia), subtitles = new SubtitleService(plex, config.FFMPEG_PATH, config.CACHE_DIR, localMedia);
  await app.register(cookie);
  await app.register(rateLimit, {max: 120, timeWindow: 60000, errorResponseBuilder: (_req, {statusCode, ttl}) => {
    const seconds = Math.max(1, Math.ceil(ttl / 1000));
    return new AppError('RATE_LIMITED', `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`, statusCode, true);
  }});
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
    // Unknown routes, routes not on the Requests site, and admin and owner routes are not found there, except an admin
    // route marked `portal: 'admin'` (still for administrators only).
    if (site.has(req.raw)) {
      req.portal = true;
      const route = req.routeOptions.config as {portal?: boolean | 'admin'; access?: string} | undefined;
      requireThat(route?.portal && (route.portal === 'admin' ? route.access === 'admin' : route.access !== 'admin' && route.access !== 'owner' && route.access !== 'connectionAdmin' && route.access !== 'worker'), 'NOT_FOUND', 'Not found.', 404);
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    // blob: images are ones the page made itself (the artwork layout editor's previews); data: stays blocked.
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src https://www.youtube-nocookie.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    // The PC subtitle worker's routes take a bearer token and never cookies, so a browser can't be made to send one.
    const bearerOnly = (req.routeOptions.config as {access?: string} | undefined)?.access === 'worker';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !bearerOnly) {
      const host = req.headers.host, peer = req.raw.socket.remoteAddress;
      const validOrigin = req.portal ? !!site.origin && req.headers.origin === site.origin
        : previewHosts
        ? !!host && previewHosts.has(host) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') && req.headers.origin === `http://${host}`
        : req.headers.origin === config.browserOrigin;
      requireThat(validOrigin, 'CSRF_REJECTED', 'Request origin is not permitted.', 403);
      // Neither type can be sent cross-site without a preflight, so the origin check above stays the guard.
      const binary = (req.routeOptions.config as {binary?: boolean} | undefined)?.binary === true;
      const type = req.headers['content-type']?.split(';')[0];
      requireThat(binary ? type === 'application/octet-stream' : type === 'application/json', 'INVALID_CONTENT_TYPE', binary ? 'Use application/octet-stream.' : 'Use application/json.', 415);
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
    app.log.warn({code: e.code, requestId: req.id, ...(e.code === 'RATE_LIMITED' ? {route: req.routeOptions.url} : {})}, 'request rejected');
    // Plex refused something: the viewer's next request checks their access with Plex again.
    if (e.code === 'PLEX_ACCESS_DENIED') identity.forget(req.cookies[sessionCookie]);
    reply.code(e.status).send({code: e.code, message: e.message, retryable: e.retryable});
  });
  const auth = (req: {cookies: Record<string, string | undefined>}) => identity.authenticate(req.cookies[sessionCookie]);
  // Admins are the Plex server owner and the Plex accounts the owner made admins (Admin › Users). Plex lets only the
  // owner's token change the server, so the others act on Plex with the owner's saved Plex admin token (Admin ›
  // Connections), as themselves in tk.box's audit; without one saved they keep their own.
  // The grant keeps the account's own role ('viewer'): only the token is the owner's.
  const admins = identity.admins;
  const admin = async (req: {cookies: Record<string, string | undefined>}) => {
    const a = await auth(req);
    if (isOwner(a.grant)) return a;
    requireThat(identity.isAdmin(a.grant), 'FORBIDDEN', 'Administrator access required.', 403);
    const {name: _, role: __, ...owner} = await plexOwner.grant() ?? a.grant;
    return {...a, grant: {...owner, accountId: a.grant.accountId, ...(a.grant.name ? {name: a.grant.name} : {}), role: a.grant.role}};
  };
  // Admin › metrics: event-loop delay, route timings and Plex reads since the server started.
  const metrics = new ServerMetrics();
  plex.observe = (ms, ok) => metrics.plex(ms, ok);
  app.addHook('onReady', async () => { metrics.start(); });
  app.addHook('onClose', async () => { metrics.stop(); });
  app.addHook('onResponse', async (req, reply) => { metrics.route(`${req.method} ${req.routeOptions.url ?? 'unmatched'}`, reply.elapsedTime, reply.statusCode < 500); });
  const ownerOnly = async (req: {cookies: Record<string, string | undefined>}) => { const a = await auth(req); requireThat(isOwner(a.grant), 'FORBIDDEN', 'Only the Plex server owner can do that.', 403); return a; };
  const connectionAdmin = async (req: {cookies: Record<string, string | undefined>}) => {
    const accountId = identity.sessionAccount(req.cookies[sessionCookie]);
    // The configured owner can recover these settings using an existing session during a Plex outage.
    if (config.plexConfigured && accountId === config.PLEX_OWNER_ACCOUNT_ID) return accountId;
    // Delegated admins still need current Plex access. These routes never need the saved owner's grant.
    requireThat(admins.has(accountId), 'FORBIDDEN', 'Administrator access required.', 403);
    await auth(req);
    requireThat(admins.has(accountId), 'FORBIDDEN', 'Administrator access required.', 403);
    return accountId;
  };
  // Every route declares an access level, checked here before its handler runs; one that declares none stops startup.
  // The PC subtitle worker (docs/PHASE-5.md): its bearer token, on its own routes only.
  const subtitleWorkers = new SubtitleWorkerStore(db);
  const worker = async (req: FastifyRequest) => {
    const found = subtitleWorkers.authenticate(bearerToken(req));
    requireThat(found, 'UNAUTHENTICATED', 'Worker token not recognised.', 401);
    return {id: found.id, name: found.name};
  };
  installAccess(app, {viewer: auth, admin, owner: ownerOnly, connectionAdmin, worker, session: async req => identity.session(req.cookies[sessionCookie])});
  requireDeclaredAccess(app);
  const bus = new EventBus((message, detail) => app.log.warn(detail, message));
  // Plex caches go first, so every module reacting to the same change (and every page told to reload) reads Plex anew.
  bus.on('plex.library.changed', () => plex.forgetIndexes());
  bus.on('library.edited', () => plex.forgetMetadata());
  bus.on('library.title.changed', ({ change }) => { if (change === 'file' || change === 'removed') plex.forgetMetadata(); });
  // Background work reads Plex with the owner's Plex token from Admin › Connections.
  const serviceKeys = new ServiceKeys(db, vault);
  const plexOwner = ownerGrant(new PlexBackground(serviceKeys, plex, (message, detail) => app.log.warn(detail, message)), plex);
  // The one TMDB client, with its key from Admin › Connections: the library, requests, Explore, the calendar and Artwork.
  const tmdb = new TmdbTitles(() => serviceKeys.get('tmdb'), exploreTransports.tmdb);
  const jobs = new Jobs((message, detail) => app.log.info(detail, message));
  const ctx: ModuleContext = {config, db, vault, plex, bus, budget, serviceKeys, plexOwner, tmdb, jobs,
    log: {info: (message, detail) => app.log.info(detail ?? {}, message), warn: (message, detail) => app.log.warn(detail ?? {}, message)}};
  // What Plex holds, and the one title identity (plexIndex.resolve): read by watch history, the library, requests,
  // Explore and the calendar. It needs nothing else, so it mounts first.
  const plexIndex = await mountModule(app, ctx, plexIndexModule, undefined);
  // The one registry of playback sessions (VOD, IPTV, custom channels) comes before everything that hears or reads it:
  // watch history records its sessions from its events, Admin › Activity lists them, and the playback modules open them.
  // It also hears sign-out first, so a browser's streams end before watch history closes the rest.
  const sessions = await mountModule(app, ctx, playbackSessionsModule, undefined);
  const watchHistory = await mountModule(app, ctx, watchHistoryModule, {plexIndex}), {history, monitor} = watchHistory;
  const activityApi = await mountModule(app, ctx, activityModule, {sessions, monitor});
  // Custom channels share the live session routes with IPTV; their sessions belong to CustomTv.
  const {store: custom, tv: customTv} = await mountModule(app, ctx, customChannelsModule, {localMedia, settings});
  const {store: iptv, live} = await mountModule(app, ctx, iptvModule, {custom});
  await mountModule(app, ctx, liveSessionsModule, {live, iptv, customTv, custom, sessions, activity: activityApi, history, subtitles});
  await mountModule(app, ctx, vodPlaybackModule, {identity, sessions, activity: activityApi, history, subtitles, localMedia});
  await mountModule(app, ctx, clientEventsModule, {identity});
  await mountModule(app, ctx, notificationsModule, {identity});
  // The durable work queue, NZBGeek and SABnzbd (docs/ARR-REPLACEMENT.md, phase 1). The library module uses them.
  const queue = await mountModule(app, ctx, queueModule, undefined);
  const indexers = await mountModule(app, ctx, indexersModule, undefined);
  const downloaders = await mountModule(app, ctx, downloadersModule, undefined);
  // Anyone streaming (Activity's `streaming`) holds back the nightly full collections run. Collections' seasonal
  // downloads go to tk.box's library (collections.acquire on the bus).
  const artwork = await mountModule(app, ctx, artworkModule, {streaming: activityApi.streaming});
  await mountModule(app, ctx, catalogModule, {artwork});
  // tk.box's own library for movies and shows. Requests send both to it, and hand it who asked for each title as they
  // mount (Admin › Manage's Source column).
  const library = await mountModule(app, ctx, libraryModule, {queue, indexers, downloaders, artwork, plexIndex});
  await mountModule(app, ctx, subtitleFinderModule, {queue, library});
  const {requests} = await mountModule(app, ctx, requestsModule, {site, library, plexIndex});
  await mountModule(app, ctx, cleanupModule, {artwork, requests, watchHistory, identity, library, plexIndex});
  await mountModule(app, ctx, exploreModule, {identity, requests, plexTitles: plexIndex, watchHistory, transports: exploreTransports});
  await mountModule(app, ctx, plexNotificationsModule, undefined);
  await mountModule(app, ctx, calendarModule, {library, plexTitles: plexIndex});
  await mountModule(app, ctx, signInModule, {identity, cookies: {session: sessionCookie, link: linkCookie, setup: `${cookieNamespace}_setup`, options: cookieOpts, sessionAge: sessionCookieAge}});
  // Admins' system alerts. Admin › Connections checks through it, so its result updates the alerts too.
  const alerts = await mountModule(app, ctx, systemAlertsModule, {identity, downloaders, transports: exploreTransports});
  await mountModule(app, ctx, adminModule, {admins, settings, metrics, identity, customTv, checkConnections: alerts.checkConnections});
  await mountModule(app, ctx, jobsModule, undefined);
  await mountModule(app, ctx, webModule, undefined);
  return app;
}
