import { z } from 'zod';
import { defineModule } from './module.js';
import { iptvMigrations } from './migrations/iptv.js';
import { viewer } from './access.js';
import { IptvStore } from '../persistence/iptv-store.js';
import { SourceRefresh } from '../services/source-refresh.js';
import { registerIptv } from '../iptv-api.js';
import { LiveTv } from '../services/live-tv.js';
import { HealthStore } from '../persistence/channel-health-store.js';
import { ChannelHealth } from '../services/channel-health.js';
import { registerChannelHealth } from '../health-api.js';
import { IptvSettingsStore, iptvSettings } from '../persistence/iptv-settings.js';
import { ProviderConnections } from '../streaming/provider-connections.js';
import { StreamGuard } from '../streaming/stream-guard.js';
import { SportsStore } from '../persistence/sports-store.js';
import { SportsSchedule } from '../services/sports-schedule.js';
import { DEFAULT_ESPN, DEFAULT_TSDB } from '../providers/sports-feeds.js';
import { registerSports } from '../sports-api.js';
import type { CustomChannelStore } from '../persistence/custom-channels.js';

const list = (value: string | undefined, fallback: string[]) => { const items = (value ?? '').split(',').map(s => s.trim()).filter(Boolean); return items.length ? items : fallback; };

// IPTV: playlist and guide sources, the live lineup and guide, channel health checks, sports event channels and the
// relays that play them. The guide also lists custom channels, so it reads their store.
export const iptvModule = defineModule({
  name: 'iptv',
  migrations: iptvMigrations,
  setup(routes, { config, db, vault, plex, bus, budget, serviceKeys, log }, { custom }: { custom: CustomChannelStore }) {
    const iptv = new IptvStore(db, vault), refresh = new SourceRefresh(iptv);
    refresh.published = sourceId => bus.emit('iptv.source.published', { sourceId });
    registerIptv(routes, iptv, refresh, { custom, plexArtwork: async (req, id, kind) => plex.artwork(viewer(req).grant, id, kind) });
    const live = new LiveTv(iptv, budget, config.CACHE_DIR, config.FFMPEG_PATH, config.FFPROBE_PATH, (message, detail) => log.warn(message, detail));
    live.onViewerEnded = sessionId => bus.emit('live.viewer.ended', { sessionId });
    // Channel checks hide channels that fail to play or show a provider's offline screen.
    const healthStore = new HealthStore(db), health = new ChannelHealth(iptv, healthStore, config.CACHE_DIR, config.FFMPEG_PATH,
      (message, detail) => log.info(message, detail), { enabled: config.CHANNEL_HEALTH_CHECKS });
    // Every viewer and check, on any source, draws from one server-wide connection limit; viewers always come first.
    const iptvConfig = new IptvSettingsStore(db), connections = new ProviderConnections(() => iptvConfig.get().maxConnections);
    live.connections = connections; health.connections = connections;
    // Provider stream addresses are untrusted: FFmpeg reaches only public addresses unless a source allows its local network.
    const guard = new StreamGuard(); live.guard = guard; health.guard = guard;
    routes.get('/api/v1/admin/iptv/settings', { config: { access: 'admin' } }, async () => ({ ...iptvConfig.get(), connections: connections.usage() }));
    routes.put('/api/v1/admin/iptv/settings', { config: { access: 'admin' } }, async req => {
      const { grant } = viewer(req), { expectedRevision, ...value } = iptvSettings.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(req.body);
      const saved = iptvConfig.update(grant.accountId, expectedRevision, value); health.pump(); return { ...saved, connections: connections.usage() };
    });
    health.relays = { live: id => live.isLive(id) };
    live.observer = { tuned: id => health.tuned(id), tuneFailed: id => health.tuneFailed(id) };
    registerChannelHealth(routes, iptv, healthStore, health);
    // Sports events: event-driven sources show a channel only while the event it names is on.
    // Without a saved TheSportsDB key, its free public key ('123') is used.
    const sportsStore = new SportsStore(db, id => iptv.relist(id)), sports = new SportsSchedule(iptv, sportsStore, health.enabled ? healthStore : undefined, () => health.pump(),
      { espn: list(config.SPORTS_ESPN_LEAGUES, DEFAULT_ESPN), tsdb: list(config.SPORTS_TSDB_LEAGUES, DEFAULT_TSDB), tsdbKey: () => serviceKeys.get('thesportsdb') ?? '123', zone: config.SPORTS_NAME_TIMEZONE ?? 'America/New_York', nameHours: 3, tickMs: 60000 },
      (message, detail) => log.info(message, detail));
    // A watched event channel stays on past its scheduled end (SportsStore.hold).
    live.observer.watching = (id, seen) => sportsStore.hold(id, seen);
    registerSports(routes, iptv, sportsStore, sports);
    // New listings or a new TheSportsDB key: match events again.
    bus.on('iptv.source.published', () => sports.invalidate());
    bus.on('service-keys.changed', () => sports.invalidate());
    let timer: NodeJS.Timeout | undefined;
    return {
      api: { store: iptv, live },
      async start() {
        timer = setInterval(() => { void refresh.tick().catch(() => {}); }, 15000); timer.unref();
        iptv.relistAll(); await refresh.tick();
        void sports.tick();
      },
      async stop() {
        clearInterval(timer); await refresh.close();
        live.close(); health.close(); sports.close(); guard.close();
      }
    };
  }
});
