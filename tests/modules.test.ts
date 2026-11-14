import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { installAccess, authorize, session, requireDeclaredAccess } from '../apps/server/src/modules/access.js';
import { defineModule, mountModule, type ModuleContext } from '../apps/server/src/modules/module.js';
import { EventBus } from '../apps/server/src/modules/bus.js';

const ctx = { bus: new EventBus() } as unknown as ModuleContext;

test('a module route without an access level stops the server from starting', async () => {
  const app = Fastify();
  installAccess(app, {});
  const open = defineModule({ name: 'open', setup(routes) { routes.get('/api/v1/open', async () => ({})); return { api: {} }; } });
  await assert.rejects(mountModule(app, ctx, open, {}), /declares no access level/);
});

test('session routes check the local session and escalate to a full check only when asked', async () => {
  const app = Fastify(), calls: string[] = [];
  installAccess(app, {
    session: async req => { calls.push('session'); if (req.headers.cookie !== 'ok') throw Object.assign(new Error('no'), { statusCode: 401 }); return 'hash'; },
    viewer: async () => { calls.push('viewer'); return { hash: 'hash', grant: { accountId: 'a' } } as never; }
  });
  const media = defineModule({ name: 'media', setup(routes) {
    routes.get<{ Params: { file: string } }>('/api/v1/media/:file', { config: { access: 'session' } }, async req => {
      if (req.params.file === 'index.m3u8') return { viewer: (await authorize(req, 'viewer')).grant.accountId };
      return { session: session(req) };
    });
    return { api: {} };
  } });
  await mountModule(app, ctx, media, {});
  assert.equal((await app.inject({ url: '/api/v1/media/seg.ts' })).statusCode, 401);
  calls.length = 0;
  assert.deepEqual((await app.inject({ url: '/api/v1/media/seg.ts', headers: { cookie: 'ok' } })).json(), { session: 'hash' });
  assert.deepEqual(calls, ['session']);
  calls.length = 0;
  assert.deepEqual((await app.inject({ url: '/api/v1/media/index.m3u8', headers: { cookie: 'ok' } })).json(), { viewer: 'a' });
  assert.deepEqual(calls, ['session', 'viewer']);
  await app.close();
});

test('one failing bus listener does not stop the others', () => {
  const logged: string[] = [], bus = new EventBus(message => logged.push(message)), seen: string[] = [];
  bus.on('iptv.source.published', () => { throw new Error('boom'); });
  bus.on('iptv.source.published', ({ sourceId }) => seen.push(sourceId));
  bus.emit('iptv.source.published', { sourceId: 's1' });
  assert.deepEqual(seen, ['s1']);
  assert.deepEqual(logged, ['event listener failed']);
});

test('modules start in mount order and stop in reverse, before the app closes', async () => {
  const app = Fastify(), calls: string[] = [];
  installAccess(app, {});
  const named = (name: string) => defineModule({ name, setup() { return { api: {}, start() { calls.push(`start ${name}`); }, stop() { calls.push(`stop ${name}`); } }; } });
  await mountModule(app, ctx, named('history'), {});
  await mountModule(app, ctx, named('live'), {});
  await mountModule(app, ctx, named('vod'), {});
  app.addHook('onClose', async () => { calls.push('closed'); });
  await app.ready();
  await app.close();
  assert.deepEqual(calls, ['start history', 'start live', 'start vod', 'stop vod', 'stop live', 'stop history', 'closed']);
});

test('a module default access level covers routes that declare none, and a route can still declare its own', async () => {
  const app = Fastify();
  installAccess(app, {
    admin: async () => { throw Object.assign(new Error('Administrator access required.'), { statusCode: 403 }); },
    viewer: async () => ({ hash: 'hash', grant: { accountId: 'a' } }) as never
  });
  const shared = { config: { rateLimit: { max: 5, timeWindow: 60000 } } };
  const admin = defineModule({ name: 'admin-only', access: 'admin', setup(routes) {
    routes.get('/api/v1/admin/thing', shared, async () => ({}));
    routes.get('/api/v1/thing', { config: { access: 'viewer' } }, async () => ({ ok: true }));
    return { api: {} };
  } });
  await mountModule(app, ctx, admin, {});
  assert.equal((await app.inject({ url: '/api/v1/admin/thing' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'HEAD', url: '/api/v1/admin/thing' })).statusCode, 403);
  assert.deepEqual((await app.inject({ url: '/api/v1/thing' })).json(), { ok: true });
  assert.equal((shared.config as { access?: string }).access, undefined);
  await app.close();
});

test('the app will not start with a route that declares no access, but module defaults count', async () => {
  const app = Fastify();
  installAccess(app, {});
  requireDeclaredAccess(app);
  const open = defineModule({ name: 'open', access: 'public', setup(routes) { routes.get('/open', async () => ({})); return { api: {} }; } });
  await mountModule(app, ctx, open, {});
  app.get('/declared', { config: { access: 'public' } }, async () => ({}));
  await app.ready();
  await app.close();
  const bare = Fastify();
  installAccess(bare, {});
  requireDeclaredAccess(bare);
  bare.get('/undeclared', async () => ({}));
  await assert.rejects(async () => { await bare.ready(); },/GET \/undeclared/);
});
