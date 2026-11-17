import { defineModule } from './module.js';
import { subtitleFinderMigrations } from './migrations/subtitle-finder.js';
import { AppError, preview } from '../errors.js';
import { every, errorDetail } from '../lib/every.js';
import { SubtitleStore } from '../persistence/subtitle-store.js';
import { OpenSubtitles } from '../providers/opensubtitles.js';
import { SubtitleFinder } from '../services/subtitle-finder.js';
import { probeSubtitles } from '../services/subtitle-check.js';
import { registerSubtitlesAdmin } from '../subtitles-api.js';
import { registerTitleSubtitles } from '../subtitles-title-api.js';
import type { QueueApi } from '../services/queue.js';
import type { LibraryStore } from '../persistence/library-store.js';

const HOUR_MS = 3600000, BACKFILL_MINUTES = 10;

// English subtitles from OpenSubtitles.com, replacing Bazarr (docs/PHASE-4.md). Each file the library imports is
// looked at (`find-subtitles` on the queue). Hourly: subtitles of videos the library no longer has are forgotten (with
// the sidecars tk.box wrote), and videos whose 3-day grace is over are looked at again. Off until it's switched on in
// Admin › Downloads › Subtitles (step 4). Every 10 minutes the backfill queues the next 50 library files not yet
// dealt with (once the last 50 have run, while there's room under the cap); daily, Whisper subtitles a month old are
// looked for again on OpenSubtitles.
export const subtitleFinderModule = defineModule({
  name: 'subtitle-finder',
  access: 'admin',
  migrations: subtitleFinderMigrations,
  setup(routes, { config, db, vault, plex, bus, background, jobs, log }, { queue, library }: { queue: QueueApi; library: { store: LibraryStore } }) {
    const store = new SubtitleStore(db, vault);
    const finder = new SubtitleFinder({
      store, library: library.store, queue,
      probe: probeSubtitles(config.FFPROBE_PATH),
      client: login => new OpenSubtitles(login),
      scan: async folder => {
        const grant = await background.grant();
        if (!grant) throw new AppError('NO_PLEX_TOKEN', 'No Plex admin token in Admin › Connections.', 409);
        return plex.scanFolder(grant.serverToken, folder);
      },
      log: (message, detail) => log.info(message, detail),
    });
    finder.register();
    registerSubtitlesAdmin(routes, { store, finder, library: library.store });
    registerTitleSubtitles(routes, { db, library: library.store });
    bus.on('library.file.imported', ({ path }) => {
      if (preview()) return;
      void finder.imported(path).catch(e => log.warn('subtitles: an imported file could not be queued', { path, ...errorDetail(e) }));
    });
    const tidyNow = () => jobs.track('subtitles.tidy', async () => ({ forgotten: await finder.reconcile(), due: finder.due() }));
    jobs.add({ id: 'subtitles.tidy', label: 'Tidy subtitles', area: 'Subtitles', section: 'queue',
      schedule: () => ({ enabled: store.settings().enabled, schedule: { kind: 'every', minutes: 60 } }), status: () => jobs.tracked('subtitles.tidy'), run: tidyNow });
    const backfillNow = () => jobs.track('subtitles.backfill', async () => ({ queued: finder.backfill(), ...finder.progress() }));
    const whisperNow = () => jobs.track('subtitles.whisper', async () => ({ queued: finder.whisperRetry() }));
    jobs.add(
      { id: 'subtitles.backfill', label: 'Find subtitles for the library', area: 'Subtitles', section: 'queue',
        schedule: () => ({ enabled: store.settings().enabled, schedule: { kind: 'every', minutes: BACKFILL_MINUTES } }), status: () => jobs.tracked('subtitles.backfill'), run: backfillNow },
      { id: 'subtitles.whisper', label: 'Look again for Whisper subtitles', area: 'Subtitles', section: 'queue',
        schedule: () => ({ enabled: store.settings().enabled, schedule: { kind: 'every', minutes: 24 * 60 } }), status: () => jobs.tracked('subtitles.whisper'), run: whisperNow });
    let timers: { stop(): void }[] = [];
    return {
      api: { store, finder },
      start() {
        if (preview()) return;
        timers = [
          every(HOUR_MS, tidyNow, e => log.warn('subtitles: the hourly tidy failed', errorDetail(e))),
          every(BACKFILL_MINUTES * 60000, backfillNow, e => log.warn('subtitles: the backfill failed', errorDetail(e))),
          every(24 * HOUR_MS, whisperNow, e => log.warn('subtitles: the Whisper retry failed', errorDetail(e))),
        ];
      },
      stop() { for (const t of timers) t.stop(); }
    };
  }
});
