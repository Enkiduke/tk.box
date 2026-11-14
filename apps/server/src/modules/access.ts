import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IdentityService } from '../services/identity.js';
import { requireThat } from '../errors.js';

// Who may call a route, declared on the route itself (`{config: {access: 'admin'}}`) and checked before its handler runs.
// Module routes must declare one (modules/module.ts refuses to start otherwise); 'public' is the explicit opt-out.
// session: a signed-in browser session, checked locally without asking Plex, for high-frequency media requests that
// are reauthorized fully elsewhere. viewer: any signed-in Plex account. admin: the owner or an account made admin,
// acting on Plex with the owner's saved token. owner: the Plex server owner alone.
export type AccessLevel = 'public' | 'session' | 'viewer' | 'admin' | 'owner';
export type Viewer = Awaited<ReturnType<IdentityService['authenticate']>>;
type FullLevel = Exclude<AccessLevel, 'public' | 'session'>;
export type AccessChecks = Record<FullLevel, (req: FastifyRequest) => Promise<Viewer>> & { session: (req: FastifyRequest) => Promise<string> };

declare module 'fastify' {
  interface FastifyContextConfig { access?: AccessLevel }
  interface FastifyRequest { viewer: Viewer | null; sessionHash: string | null }
  interface FastifyInstance { accessChecks: Partial<AccessChecks> }
}

// Once per app, before any route that declares access.
export function installAccess(app: FastifyInstance, checks: Partial<AccessChecks>) {
  app.decorate('accessChecks', checks);
  app.decorateRequest('viewer', null);
  app.decorateRequest('sessionHash', null);
  app.addHook('onRequest', async req => {
    const level = req.routeOptions.config.access;
    if (!level || level === 'public') return;
    if (level === 'session') {
      requireThat(checks.session, 'FORBIDDEN', 'Access level is not available.', 403);
      req.sessionHash = await checks.session(req);
      return;
    }
    await authorize(req, level);
  });
}

// Default deny: every route in the app must declare an access level, or the server won't start. Checked once every route
// is registered, so a module's default level (filled in by its own scope, after this hook sees the route) counts.
// Call before registering any route.
export function requireDeclaredAccess(app: FastifyInstance) {
  const routes: { method: string | string[]; url: string; config?: { access?: AccessLevel } }[] = [];
  app.addHook('onRoute', route => { routes.push(route); });
  app.addHook('onReady', async () => {
    const open = routes.filter(route => !route.config?.access).map(route => `${String(route.method)} ${route.url}`);
    if (open.length) throw new Error(`Routes declare no access level: ${open.join(', ')}`);
  });
}

// Runs a full check on a request whose route declared a lighter one (a session route's playlist, say).
export async function authorize(req: FastifyRequest, level: FullLevel): Promise<Viewer> {
  const check = req.server.accessChecks[level];
  requireThat(check, 'FORBIDDEN', 'Access level is not available.', 403);
  return req.viewer = await check(req);
}

// The caller a route's access check admitted.
export function viewer(req: FastifyRequest): Viewer {
  requireThat(req.viewer, 'UNAUTHENTICATED', 'Sign in with Plex.', 401);
  return req.viewer;
}

// The browser session a 'session' route's check admitted.
export function session(req: FastifyRequest): string {
  requireThat(req.sessionHash, 'UNAUTHENTICATED', 'Sign in with Plex.', 401);
  return req.sessionHash;
}
