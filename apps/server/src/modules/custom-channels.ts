import { defineModule } from './module.js';
import { customChannelsMigrations } from './migrations/custom-channels.js';
import { CustomChannelStore } from '../persistence/custom-channels.js';
import { registerCustomChannels } from '../custom-api.js';
import { EpisodeSync } from '../services/episode-sync.js';
import { CustomTv } from '../services/custom-tv.js';
import { PartProxy } from '../providers/part-proxy.js';
import type { LocalMedia } from '../providers/local-media.js';

type Deps = { localMedia: LocalMedia; pauseRetentionMs: () => number };

// Custom channels: Plex titles looped as live channels. The Channel Manager (admin), new-episode sync, and the stations
// that play them. Their viewers share the live session routes with IPTV, so those routes stay with the app for now.
export const customChannelsModule = defineModule({
  name: 'custom-channels',
  migrations: customChannelsMigrations,
  setup(routes, { config, db, plex, bus, budget, background, log }, { localMedia, pauseRetentionMs }: Deps) {
    const store = new CustomChannelStore(db);
    const episodes = new EpisodeSync(store, plex, () => background.grant(), (message, detail) => log.info(message, detail));
    registerCustomChannels(routes, store, plex, episodes);
    const parts = new PartProxy(plex), tv = new CustomTv(store, plex, localMedia, parts, budget, config.CACHE_DIR, pauseRetentionMs, config.SEGMENT_CACHE_MAX_BYTES,
      config.FFMPEG_PATH, (message, detail) => log.warn(message, detail));
    tv.historyServerId = config.PLEX_MACHINE_ID;
    tv.onViewerEnded = sessionId => bus.emit('live.viewer.ended', { sessionId });
    return {
      api: { store, tv },
      start() { episodes.start(); },
      stop() { tv.close(); parts.close(); episodes.close(); }
    };
  }
});
