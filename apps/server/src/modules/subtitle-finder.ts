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
import { registerSubtitleWorker, registerSubtitleWorkersAdmin } from '../subtitle-worker-api.js';
import { SubtitleWorkerStore } from '../persistence/subtitle-worker-store.js';
import { SubtitleWorkerService, ffmpegAudio } from '../services/subtitle-worker.js';
import { ffprobe } from '../services/library-import.js';
import { join } from 'node:path';
import type { QueueApi } from '../services/queue.js';
import type { LibraryFiles } from '../services/library.js';

const HOUR_MS = 3600000, BACKFILL_MINUTES = 10;

// English subtitles from OpenSubtitles.com, replacing Bazarr (docs/PHASE-4.md). Each file the library imports is
// looked at (`find-subtitles` on the queue). Hourly: subtitles of videos the library no longer has are forgotten (with
// the sidecars tk.box wrote). Off until it's switched on in Admin › Downloads › Subtitles (step 4). Every 10 minutes
// the backfill queues the next 50 library files not yet dealt with (once the last 50 have run, while there's room under
// the cap); daily, Whisper subtitles that are due (daily while the release is new, monthly until it's a year old) are
// looked for again on OpenSubtitles.
export const subtitleFinderModule = defineModule({
  name: 'subtitle-finder',
  access: 'admin',
  migrations: subtitleFinderMigrations,
  setup(routes, { config, db, vault, plex, bus, plexOwner, jobs, log }, { queue, library }: { queue: QueueApi; library: { files: LibraryFiles } }) {
    const store = new SubtitleStore(db, vault);
    const finder = new SubtitleFinder({
      store, library: library.files, queue,
      probe: probeSubtitles(config.FFPROBE_PATH),
      client: login => new OpenSubtitles(login),
      scan: folder => plexOwner.scanFolder(folder),
      log: (message, detail) => log.info(message, detail),
    });
    finder.register();
    // The PC worker (docs/PHASE-5.md): jobs OpenSubtitles had nothing for, made by whisper.cpp on the home PC.
    const probe = ffprobe(config.FFPROBE_PATH);
    const workers = new SubtitleWorkerStore(db);
    const worker = new SubtitleWorkerService({
      workers, store, library: library.files, audioDir: join(config.CACHE_DIR, 'subtitle-worker'),
      makeAudio: ffmpegAudio(config.FFMPEG_PATH), probeDuration: async path => (await probe(path)).durationSec,
      scan: folder => plexOwner.scanFolder(folder),
      log: (message, detail) => log.info(message, detail),
    });
    registerSubtitleWorker(routes, worker);
    registerSubtitleWorkersAdmin(routes, workers);
    registerSubtitlesAdmin(routes, { store, finder, library: library.files });
    registerTitleSubtitles(routes, { store, library: library.files });
    bus.on('library.file.imported', ({ path }) => {
      if (preview()) return;
      void finder.imported(path).catch(e => log.warn('subtitles: an imported file could not be queued', { path, ...errorDetail(e) }));
    });
    bus.on('library.title.changed', ({ paths }) => {
      if (!paths?.length || preview()) return;
      void finder.gone(paths).catch(e => log.warn('subtitles: a deleted file’s subtitles could not be forgotten', errorDetail(e)));
    });
    const tidyNow = () => jobs.track('subtitles.tidy', async () => ({ forgotten: await finder.reconcile(), leasesExpired: await worker.sweep() }));
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
      api: { store, finder, workers, worker },
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
