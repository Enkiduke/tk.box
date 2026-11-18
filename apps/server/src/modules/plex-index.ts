import { defineModule } from './module.js';
import { PlexIndex } from '../services/plex-index.js';
import { every, errorDetail } from '../lib/every.js';

const REBUILD_MS = 6 * 3600000;

// What Plex holds (services/plex-index.ts), read once for the whole app with the owner's grant. Mounted before the
// library and requests, which both read it. Rebuilt at start; 30 s after Plex says its library changed; 10 s after
// the library imports a file (Plex has been told to scan); 5 s after Clean Up finishes; every 6 hours (Admin ›
// Schedule, `requests.availability`); and when a reader finds it not yet built.
export const plexIndexModule = defineModule({
  name: 'plex-index',
  setup(_routes, { plex, bus, plexOwner, jobs, log }) {
    // Episodes too for the shows the library follows (it says which, through `follow`).
    const index = new PlexIndex(async () => plex.availability(await plexOwner.require()), (message, detail) => log.warn(message, detail),
      async ratingKey => plex.showEpisodes(await plexOwner.require(), ratingKey));
    bus.on('plex.library.changed', () => index.soon());
    bus.on('library.file.imported', () => index.soon(10000));
    bus.on('library.edited', ({ by }) => { if (by === 'cleanup') index.soon(5000); });
    const rebuildNow = () => jobs.track('requests.availability', () => index.rebuild());
    jobs.add({ id: 'requests.availability', label: 'Check Plex for requested titles', area: 'Requests', section: 'requests',
      schedule: () => ({ enabled: true, schedule: { kind: 'every', minutes: REBUILD_MS / 60000 } }), status: () => jobs.tracked('requests.availability'), run: rebuildNow });
    let rebuild: { stop(): void } | undefined;
    return {
      api: index,
      start() {
        void rebuildNow().catch(e => log.warn('plex index failed', errorDetail(e)));
        rebuild = every(REBUILD_MS, rebuildNow, e => log.warn('plex index failed', errorDetail(e)));
      },
      stop() { rebuild?.stop(); index.close(); },
    };
  },
});
