import { defineModule } from './module.js';
import { viewer } from './access.js';
import { requireThat } from '../errors.js';
import { digest } from '../security/vault.js';
import { registerSetup, type CookieOptions } from '../setup-api.js';
import type { IdentityService } from '../services/identity.js';
import type { AdminStore } from '../persistence/admin-store.js';
import { every, errorDetail, type Repeating } from '../lib/every.js';

type Deps = {
  identity: IdentityService; admins: AdminStore;
  cookies: { session: string; link: string; setup: string; options: CookieOptions; sessionAge: number };
};

// First-run setup, Plex sign-in and sign-out, and who the viewer is. Signing out emits `session.signed-out`, which
// stops everything that browser session was watching.
export const signInModule = defineModule({
  name: 'sign-in',
  setup(routes, { config, plex, bus, log }, { identity, admins, cookies }: Deps) {
    registerSetup(routes, config, plex, identity, { setup: cookies.setup, session: cookies.session, options: cookies.options, sessionAge: cookies.sessionAge });
    routes.post('/api/v1/auth/plex/start', { config: { access: 'public', rateLimit: { max: 10, timeWindow: 60000 } } }, async (_req, reply) => {
      requireThat(config.plexConfigured, 'SETUP_REQUIRED', 'Configure Plex owner, machine and library IDs.', 503);
      const start = await identity.start(); reply.setCookie(cookies.link, start.binding, { ...cookies.options, maxAge: 600 }); return { authUrl: start.authUrl };
    });
    routes.post('/api/v1/auth/plex/status', { config: { access: 'public' } }, async (req, reply) => {
      const link = req.cookies[cookies.link];
      requireThat(link, 'AUTH_EXPIRED', 'Start Plex sign-in first.', 401);
      const result = await identity.finish(link);
      if (!result) return { status: 'pending' };
      reply.clearCookie(cookies.link, cookies.options).setCookie(cookies.session, result.cookie, { ...cookies.options, maxAge: cookies.sessionAge });
      return { status: 'authenticated' };
    });
    routes.post('/api/v1/auth/logout', { config: { access: 'public' } }, async (req, reply) => {
      const token = req.cookies[cookies.session];
      if (token) bus.emit('session.signed-out', { hash: digest(token) });
      identity.logout(token); reply.clearCookie(cookies.session, cookies.options); return { status: 'signed_out' };
    });
    const asViewer = { config: { access: 'viewer' as const } };
    routes.get('/api/v1/me', asViewer, async req => { const { grant } = viewer(req), owner = grant.role === 'admin'; return { accountId: grant.accountId, role: owner || admins.has(grant.accountId) ? 'admin' : 'viewer', owner, libraries: grant.libraries.filter(l => ['movie', 'show'].includes(l.type)) }; });
    routes.get('/api/v1/libraries', asViewer, async req => ({ libraries: viewer(req).grant.libraries }));
    routes.get<{ Params: { id: string } }>('/api/v1/media/:id', asViewer, async req => {
      const { grant } = viewer(req), item = await plex.metadata(grant, req.params.id);
      return { ratingKey: item.ratingKey, title: item.title, durationMs: item.duration, viewOffsetMs: item.viewOffset ?? 0 };
    });
    let reaper: Repeating | undefined;
    return {
      api: {},
      start() { reaper = every(30000, () => identity.reap(), e => log.warn('session reaper failed', errorDetail(e))); },
      stop() { reaper?.stop(); }
    };
  }
});
