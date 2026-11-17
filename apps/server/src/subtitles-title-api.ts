import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SubtitleJobState, SubtitleSource, TitleSubtitle, TitleSubtitles } from '../../../packages/contracts/src/subtitles.js';
import type { Db } from './persistence/database.js';
import type { LibraryStore } from './persistence/library-store.js';
import { prepared } from './persistence/statements.js';

// What each of a title's files has in English, for its Admin dialog (movie-dialog.tsx). Read-only over subtitle-finder's
// own tables; the library module doesn't know about subtitles.

const params = z.object({ id: z.coerce.number().int().positive() }).strict();
const OPEN: readonly SubtitleJobState[] = ['waiting', 'queued', 'claimed', 'failed'];

export function registerTitleSubtitles(app: FastifyInstance, deps: { db: Db; library: Pick<LibraryStore, 'files'> }) {
  const { db, library } = deps;
  app.get('/api/v1/admin/subtitles/title/:id', async (request): Promise<TitleSubtitles> => {
    const files: Record<number, TitleSubtitle> = {};
    for (const f of library.files(params.parse(request.params).id)) {
      const english = prepared(db, "SELECT source, subtitle_path, hash_match, at FROM subtitle_files WHERE path = ? AND language = 'en'").get(f.path) as
        { source: SubtitleSource; subtitle_path: string | null; hash_match: number | null; at: number } | undefined;
      if (english) {
        files[f.id] = { state: 'english', source: english.source, at: english.at, ...(english.subtitle_path ? { subtitlePath: english.subtitle_path } : {}),
          ...(english.hash_match !== null ? { hashMatch: english.hash_match === 1 } : {}) };
        continue;
      }
      const skip = prepared(db, 'SELECT reason, at FROM subtitle_skips WHERE path = ?').get(f.path) as { reason: string; at: number } | undefined;
      if (skip) { files[f.id] = { state: 'skipped', reason: skip.reason, at: skip.at }; continue; }
      const job = prepared(db, "SELECT state, not_before AS notBefore, attempts, error FROM subtitle_jobs WHERE path = ? AND language = 'en'").get(f.path) as
        { state: SubtitleJobState; notBefore: number; attempts: number; error: string | null } | undefined;
      const missing = prepared(db, 'SELECT at FROM subtitle_missing WHERE path = ?').get(f.path) as { at: number } | undefined;
      const open = job && OPEN.includes(job.state) ? job : undefined;
      if (missing || open) {
        files[f.id] = { state: 'missing', ...(missing ? { at: missing.at } : {}),
          ...(open ? { job: { state: open.state, notBefore: open.notBefore, attempts: open.attempts, ...(open.error ? { error: open.error } : {}) } } : {}) };
        continue;
      }
      files[f.id] = { state: 'unchecked' };
    }
    return { files };
  });
}
