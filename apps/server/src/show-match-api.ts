import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ShowMatchView, TvdbSeriesView } from '../../../packages/contracts/src/downloads.js';
import { viewer } from './modules/access.js';
import { imagePath } from './providers/explore-images.js';
import { suggestSeasons } from './lib/season-map.js';
import type { Library } from './services/library.js';
import type { Tvdb } from './providers/tvdb.js';

// The Match dialog's routes (lib/season-map.ts): a show's TMDB seasons and match, a TVDB search, one TVDB series with
// the season each TMDB season most likely is, and saving the match. The series' name and year are read from TVDB here,
// not taken from the page.
const tmdbParam = z.object({ tmdbId: z.coerce.number().int().positive() });
const tvdbParam = z.object({ tvdbId: z.coerce.number().int().positive() });
const season = z.coerce.number().int().positive().max(999);
const matchInput = z.object({ tvdbId: z.number().int().positive(), seasons: z.record(z.string().regex(/^\d{1,3}$/), season) }).strict();

export function registerShowMatch(app: FastifyInstance, library: Library, tvdb: Tvdb) {
  const admin = { config: { access: 'admin' as const } };
  const view = async (tmdbId: number): Promise<ShowMatchView> => {
    const facts = await library.matchFacts(tmdbId), m = facts.match;
    return { tmdbId, title: facts.title, ...(facts.year ? { year: facts.year } : {}), tvdbKey: tvdb.configured(), seasons: facts.seasons,
      ...(m ? { match: { tvdbId: m.tvdbId, series: m.series, ...(m.seasons ? { seasons: { ...m.seasons } } : {}), at: m.at } } : {}) };
  };
  app.get('/api/v1/admin/library/matches/:tmdbId', admin, async request => view(tmdbParam.parse(request.params).tmdbId));
  app.get('/api/v1/admin/library/tvdb/search', { config: { access: 'admin', rateLimit: { max: 60, timeWindow: 60000 } } }, async request => {
    const { q } = z.object({ q: z.string().trim().min(1).max(120) }).parse(request.query);
    return { items: (await tvdb.search(q)).map(({ image, ...hit }) => { const poster = imagePath(image); return { ...hit, ...(poster ? { image: poster } : {}) }; }) };
  });
  app.get('/api/v1/admin/library/tvdb/series/:tvdbId', admin, async (request): Promise<TvdbSeriesView> => {
    const { tvdbId } = tvdbParam.parse(request.params), { tmdb } = z.object({ tmdb: z.coerce.number().int().positive() }).parse(request.query);
    const [found, facts] = await Promise.all([tvdb.series(tvdbId), library.matchFacts(tmdb)]);
    const { image, ...series } = found.series, poster = imagePath(image);
    return { series: { ...series, ...(poster ? { image: poster } : {}) }, seasons: found.seasons, suggested: suggestSeasons(facts.seasons, found.seasons) };
  });
  app.put('/api/v1/admin/library/matches/:tmdbId', admin, async request => {
    const { tmdbId } = tmdbParam.parse(request.params), input = matchInput.parse(request.body);
    const { series } = await tvdb.series(input.tvdbId);
    // TVDB tells same-named series apart with the year in the name (Monster (2022)); the match keeps the name bare, as
    // searches and release names use it, and the year beside it, as the folder name adds it back.
    const suffix = series.year ? `(${series.year})` : undefined, bare = suffix && series.name.endsWith(suffix) ? series.name.slice(0, -suffix.length).trim() : series.name;
    await library.matchShow({ tmdbId, tvdbId: input.tvdbId, series: { title: bare, ...(series.year ? { year: series.year } : {}) }, seasons: input.seasons,
      by: viewer(request).grant.accountId });
    return view(tmdbId);
  });
}
