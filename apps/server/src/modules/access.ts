import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IdentityService } from '../services/identity.js';
import { requireThat } from '../errors.js';

// Who may call a route, declared on the route itself (`{config: {access: 'admin'}}`) and checked before its handler runs.
// Module routes must declare one (modules/module.ts refuses to start otherwise); 'public' is the explicit opt-out.
// session: a signed-in browser session, checked locally without asking Plex, for high-frequency media requests that
// are reauthorized fully elsewhere. viewer: any signed-in Plex account. admin: the owner or an account made admin,
// acting on Plex with the owner's saved token. owner: the Plex server owner alone.
// connectionAdmin: Admin › Connections settings and checks that don't need a Plex grant.
export type AccessLevel = 'public' | 'session' | 'viewer' | 'admin' | 'owner' | 'connectionAdmin';
export type Viewer = Awaited<ReturnType<IdentityService['authenticate']>>;
type FullLevel = Exclude<AccessLevel, 'public' | 'session' | 'connectionAdmin'>;
export type AccessChecks = Record<FullLevel, (req: FastifyRequest) => Promise<Viewer>> & {
  session: (req: FastifyRequest) => Promise<string>;
  connectionAdmin: (req: FastifyRequest) => Promise<string>;
};

declare module 'fastify' {
  // portal: the route is also served on the Requests site (modules/module.ts); 'admin' lets an admin route through there.
  interface FastifyContextConfig { access?: AccessLevel; portal?: boolean | 'admin' }
  interface FastifyRequest { viewer: Viewer | null; sessionHash: string | null; connectionActor: string | null }
  interface FastifyInstance { accessChecks: Partial<AccessChecks> }
}

// Once per app, before any route that declares access.
export function installAccess(app: FastifyInstance, checks: Partial<AccessChecks>) {
  app.decorate('accessChecks', checks);
  app.decorateRequest('viewer', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('connectionActor', null);
  app.addHook('onRequest', async req => {
    const level = req.routeOptions.config.access;
    if (!level || level === 'public') return;
    if (level === 'connectionAdmin') {
      requireThat(checks.connectionAdmin, 'FORBIDDEN', 'Access level is not available.', 403);
      req.connectionActor = await checks.connectionAdmin(req);
      return;
    }
    if (level === 'session') {
      requireThat(checks.session, 'FORBIDDEN', 'Access level is not available.', 403);
      req.sessionHash = await checks.session(req);
      return;
    }
    await authorize(req, level);
  });
}

export const asConnectionAdmin = { config: { access: 'connectionAdmin' as const } };

export function connectionActor(req: FastifyRequest) {
  requireThat(req.connectionActor, 'FORBIDDEN', 'Administrator access required.', 403);
  return req.connectionActor;
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
