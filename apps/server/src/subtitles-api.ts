import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SubtitleLists, SubtitleMissing, SubtitleVideo, SubtitlesTest, SubtitlesView } from '../../../packages/contracts/src/subtitles.js';
import { connectionActor, viewer } from './modules/access.js';
import { AppError, requireThat } from './errors.js';
import type { LibraryStore } from './persistence/library-store.js';
import { utcDay, type SubtitleStore } from './persistence/subtitle-store.js';
import { OpenSubtitles, OpenSubtitlesError } from './providers/opensubtitles.js';
import type { SubtitleFinder } from './services/subtitle-finder.js';
import { episodesLabel } from './services/wanted.js';

// Admin › Downloads › Subtitles (docs/PHASE-4.md, step 4), and the OpenSubtitles card in Admin › Connections. The login
// is saved and tested with connection-admin access, as the indexers' keys are; the rest is admin.

const input = z.object({
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
  dailyCap: z.number().int().min(0).max(5000).optional(),
  preferHearingImpaired: z.boolean().optional(),
}).strict();
const loginInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  apiKey: z.string().trim().max(200).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(200).optional(),
}).strict();
const pathInput = z.object({ path: z.string().min(1).max(4096) }).strict();

export function registerSubtitlesAdmin(app: FastifyInstance, deps: { store: SubtitleStore; finder: SubtitleFinder; library: Pick<LibraryStore, 'fileByPath' | 'title' | 'fileEpisodes'>;
  transport?: typeof fetch }) {
  const { store, finder, library } = deps;
  const connection = { config: { access: 'connectionAdmin' as const } };

  const view = (): SubtitlesView => {
    const { revision, enabled, dailyCap, preferHearingImpaired } = store.settings(), blocked = finder.blocked();
    return { revision, enabled, dailyCap, preferHearingImpaired, login: store.loginParts(), today: store.downloadsOn(utcDay(Date.now())),
      ...(blocked ? { blocked } : {}), progress: finder.progress(), accounting: finder.accounting(), checking: finder.checking(), sources: store.sources(), jobs: store.counts(), skipped: store.skipCount() };
  };
  // The library's title for a video, and a show file's episodes.
  const video = (path: string): SubtitleVideo => {
    const file = library.fileByPath(path), title = file && library.title(file.titleId);
    if (!file || !title) return { path };
    const refs = title.kind === 'show' ? library.fileEpisodes(title.id).get(file.id) ?? [] : [];
    return { path, titleId: title.id, title: title.title, kind: title.kind, ...(title.year ? { year: title.year } : {}), ...(refs.length ? { episodes: episodesLabel(refs) } : {}) };
  };

  app.get('/api/v1/admin/subtitles', async () => view());
  // Switching it on, the cap and the hearing-impaired preference (Admin › Downloads › Subtitles).
  app.put('/api/v1/admin/subtitles', async request => {
    const { expectedRevision, ...patch } = input.parse(request.body);
    if (patch.enabled) requireThat(store.login(), 'SUBTITLES_LOGIN_MISSING', 'Set up OpenSubtitles in Admin › Connections first.', 409);
    const saved = store.updateSettings(viewer(request).grant.accountId, expectedRevision, patch);
    requireThat(saved, 'REVISION_CONFLICT', 'Subtitle settings changed. Reload and retry.', 409);
    finder.unblock();
    return view();
  });
  // The login (Admin › Connections › Indexers & downloaders).
  app.put('/api/v1/admin/subtitles/login', connection, async request => {
    const { expectedRevision, apiKey, username, password } = loginInput.parse(request.body);
    const login = { ...(apiKey !== undefined ? { apiKey } : {}), ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}) };
    const saved = store.updateSettings(connectionActor(request), expectedRevision, {}, login);
    requireThat(saved, 'REVISION_CONFLICT', 'Subtitle settings changed. Reload and retry.', 409);
    // A new login, or switching on, is worth another try at once.
    finder.unblock();
    return view();
  });
  app.post('/api/v1/admin/subtitles/test', { config: { access: 'connectionAdmin', rateLimit: { max: 10, timeWindow: 60000 } } }, async (): Promise<SubtitlesTest> => {
    const login = store.login();
    requireThat(login, 'SUBTITLES_LOGIN_MISSING', 'Save the API key, username and password first.', 409);
    try {
      const account = await new OpenSubtitles(login, deps.transport).account();
      finder.unblock();
      return { ok: true, ...account };
    } catch (e) {
      if (e instanceof OpenSubtitlesError) throw new AppError(e.kind === 'auth' ? 'SUBTITLES_LOGIN_REFUSED' : 'SUBTITLES_UNREACHABLE', e.message, 502);
      throw e;
    }
  });
  // Every video without English, once: checked and missing it, the worker's open or failed jobs, and the skipped.
  app.get('/api/v1/admin/subtitles/videos', async (): Promise<SubtitleLists> => {
    const rows = new Map<string, SubtitleMissing>();
    const row = (path: string, at: number) => {
      const r = rows.get(path) ?? { ...video(path), at };
      r.at = Math.max(r.at, at);
      rows.set(path, r);
      return r;
    };
    for (const m of store.missing()) row(m.path, m.at);
    for (const j of store.jobs(100000)) row(j.path, j.createdAt).job = { state: j.state, notBefore: j.notBefore, attempts: j.attempts, ...(j.error ? { error: j.error } : {}) };
    for (const s of store.skips(100000)) row(s.path, s.at).skipped = s.reason;
    return { missing: [...rows.values()] };
  });
  // The accounting, once: every library file not known to have English is checked (sidecar or embedded track), and
  // those without are listed as missing. Nothing is searched or downloaded.
  app.post('/api/v1/admin/subtitles/check', async () => ({ queued: finder.checkLibrary() }));
  // A skipped video is looked at again now.
  app.post('/api/v1/admin/subtitles/retry', async request => {
    const { path } = pathInput.parse(request.body);
    requireThat(library.fileByPath(path), 'NOT_IN_LIBRARY', 'The library no longer has that file.', 404);
    store.unskip(path);
    finder.request(path);
    return { ok: true };
  });
}
