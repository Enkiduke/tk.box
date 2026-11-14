import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../persistence/database.js';
import type { Vault } from '../security/vault.js';
import type { PlexAdapter } from '../providers/plex.js';
import type { EncoderBudget } from '../streaming/policy.js';
import type { ServiceKeys } from '../persistence/service-keys.js';
import type { PlexBackground } from '../services/plex-background.js';
import type { EventBus } from './bus.js';
import type { AccessLevel } from './access.js';

// What every module is given: the shared services, built once by buildApp.
export type ModuleContext = {
  config: Config; db: Db; vault: Vault; plex: PlexAdapter; bus: EventBus;
  // Server-wide CPU video encoder limit, shared by every transcode and relay.
  budget: EncoderBudget;
  // Admin › Connections keys (TheSportsDB, the Plex admin token).
  serviceKeys: ServiceKeys;
  // The owner's Plex grant from the saved Plex admin token, for work no viewer started.
  background: PlexBackground;
  log: { info: (message: string, detail?: object) => void; warn: (message: string, detail?: object) => void };
};

// A module builds its services and routes in setup, and hands the rest of the app only its `api`. Timers that must wait
// for the server go in start (after every module is set up); stop runs as the server closes, before the database does,
// and before the stops of modules mounted earlier.
export type ModuleInstance<Api> = { api: Api; start?: () => void | Promise<void>; stop?: () => void | Promise<void> };
// `access`, when set, is the level of every route of the module that declares none (a module whose routes are all admin).
export type AppModule<Deps, Api> = { name: string; access?: AccessLevel; setup: (routes: FastifyInstance, ctx: ModuleContext, deps: Deps) => ModuleInstance<Api> | Promise<ModuleInstance<Api>> };
export const defineModule = <Deps, Api>(module: AppModule<Deps, Api>) => module;

// Modules stop in reverse mount order, so a module stops before the modules it depends on (live sessions before the
// watch history they report to).
const stops = new WeakMap<FastifyInstance, (() => void | Promise<void>)[]>();

// Routes a module adds live in their own scope, where each one must declare an access level or the server won't start.
export async function mountModule<Deps, Api>(app: FastifyInstance, ctx: ModuleContext, module: AppModule<Deps, Api>, deps: Deps): Promise<Api> {
  let instance: ModuleInstance<Api> | undefined;
  await app.register(async routes => {
    routes.addHook('onRoute', route => {
      if (route.config?.access) return;
      if (!module.access) throw new Error(`Module ${module.name}: ${String(route.method)} ${route.url} declares no access level.`);
      route.config = { ...route.config, access: module.access };
    });
    instance = await module.setup(routes, ctx, deps);
  });
  if (!instance) throw new Error(`Module ${module.name} did not set up.`);
  const { api, start, stop } = instance;
  if (start) app.addHook('onReady', async () => { await start(); });
  if (stop) {
    let list = stops.get(app);
    if (!list) {
      const pending: (() => void | Promise<void>)[] = list = [];
      stops.set(app, list);
      app.addHook('preClose', async () => { for (const run of pending.reverse()) await run(); });
    }
    list.push(stop);
  }
  return api;
}
