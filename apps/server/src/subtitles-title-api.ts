import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TitleSubtitle, TitleSubtitles } from '../../../packages/contracts/src/subtitles.js';
import type { SubtitleStore } from './persistence/subtitle-store.js';
import type { LibraryFiles } from './services/library.js';

// What each of a title's files has in English, for its Admin dialog (movie-dialog.tsx). The library lists the files;
// SubtitleStore answers for each. The library module doesn't know about subtitles.

const params = z.object({ id: z.coerce.number().int().positive() }).strict();

export function registerTitleSubtitles(app: FastifyInstance, deps: { store: Pick<SubtitleStore, 'titleState'>; library: Pick<LibraryFiles, 'files'> }) {
  const { store, library } = deps;
  app.get('/api/v1/admin/subtitles/title/:id', async (request): Promise<TitleSubtitles> => {
    const files: Record<number, TitleSubtitle> = {};
    for (const f of library.files(params.parse(request.params).id)) files[f.id] = store.titleState(f.path);
    return { files };
  });
}
