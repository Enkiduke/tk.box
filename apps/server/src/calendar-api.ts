import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CalendarEntry, CalendarPage } from '../../../packages/contracts/src/index.js';
import type { PlexAdapter } from './providers/plex.js';
import { imagePath, tmdbImage } from './providers/explore-images.js';
import type { LibraryTitle } from './persistence/library-store.js';
import type { TmdbTitles } from './providers/tmdb-titles.js';
import { requireThat } from './errors.js';
import { viewer } from './modules/access.js';
import { TtlCache } from './lib/ttl-cache.js';
import { movieReleaseDate, releaseDay } from './lib/release-day.js';

const day = z.iso.date();
const query = z.object({from: day, to: day, zone: z.string().min(1).max(100).default('UTC'), account: z.string().optional()}).strict();
const dayMs = 86_400_000;
type Scheduled = CalendarEntry & { hasFile?: boolean };

// The calendar's movies are the library's, on the day its TMDB dates give (digital, else physical, else theatrical).
// The picture and summary are TMDB's, from the details the library already reads (cached). Shows are the library's
// too, on TMDB's air date (TMDB has no air time).
export type CalendarEpisode = { show: LibraryTitle; season: number; episode: number; name?: string; airDate: string; hasFile: boolean };
export type CalendarLibrary = {
  store: { calendarMovies(): (LibraryTitle & { hasFile: boolean })[]; calendarEpisodes(from: string, to: string): CalendarEpisode[] };
};
// Keys by TVDB id (else TMDB), so a viewer's Plex match and the season finales find them.
export function libraryEpisodeEntries(episodes: CalendarEpisode[]): Scheduled[] {
  return episodes.map(({show, season, episode, name, airDate, hasFile}) => ({
    key: `episode:${show.tvdbId ? `tvdb:${show.tvdbId}` : `tmdb:${show.tmdbId}`}:${season}:${episode}`, kind: 'episode' as const,
    title: show.title, ...(show.year ? {year: show.year} : {}), ids: {tmdb: show.tmdbId, ...(show.tvdbId ? {tvdb: show.tvdbId} : {}), ...(show.imdbId ? {imdb: show.imdbId} : {})},
    day: airDate, season, episode, episodeLabel: episode === 1 ? season === 1 ? 'series-premiere' as const : 'season-premiere' as const : undefined,
    episodeTitle: name && !/^tba$/i.test(name) ? name : undefined, hasFile}));
}
export function libraryMovieEntries(movies: (LibraryTitle & { hasFile: boolean })[], from: string, to: string): Scheduled[] {
  return movies.flatMap(m => {
    const release = movieReleaseDate({inCinemas: m.released.theatrical, digitalRelease: m.released.digital, physicalRelease: m.released.physical});
    if (!release || release.day < from || release.day > to) return [];
    return [{key: `movie:${m.tmdbId}`, title: m.title, ...(m.year ? {year: m.year} : {}), ids: {tmdb: m.tmdbId, ...(m.imdbId ? {imdb: m.imdbId} : {})},
      day: release.day, kind: release.format, hasFile: m.hasFile}];
  });
}

export function registerCalendar(app: FastifyInstance, plex: Pick<PlexAdapter, 'calendarMedia'>, tmdb?: Pick<TmdbTitles, 'episodeFinales' | 'get'>, library?: CalendarLibrary) {
  const pictures = async (entries: Scheduled[]) => {
    if (!tmdb) return;
    const pending = entries.values();
    await Promise.all(Array.from({length: Math.min(6, entries.length)}, async () => {
      for (const entry of pending) {
        // A movie's details as the library reads them; a show's as its refresh does (both cached).
        const movie = await (entry.kind === 'episode' ? tmdb.get(`/tv/${entry.ids.tmdb}`, {append_to_response: 'external_ids,alternative_titles'})
          : tmdb.get(`/movie/${entry.ids.tmdb}`, {append_to_response: 'alternative_titles,release_dates,external_ids'})).catch(() => undefined) as
          {poster_path?: string | null; backdrop_path?: string | null; overview?: string} | undefined;
        entry.posterUrl = tmdbImage(movie?.poster_path, 'w500');
        entry.backdropUrl = tmdbImage(movie?.backdrop_path, 'w1280');
        if (movie?.overview) entry.summary = movie.overview;
      }
    }));
  };
  app.get('/api/v1/calendar', {config: {access: 'viewer', rateLimit: {max: 60, timeWindow: 60_000}}}, async (request, reply): Promise<CalendarPage> => {
    const {grant} = viewer(request);
    reply.header('Cache-Control', 'private, no-store');
    const {from, to, zone, account} = query.parse(request.query), start = Date.parse(from), end = Date.parse(to);
    requireThat(account === undefined || account === grant.accountId, 'FORBIDDEN', 'This calendar belongs to another account.', 403);
    requireThat(end > start && end - start <= 62 * dayMs, 'INVALID_CALENDAR_RANGE', 'Choose a calendar range of 1 to 62 days.');
    let localDay: Intl.DateTimeFormat;
    try { localDay = new Intl.DateTimeFormat('sv-SE', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'}); }
    catch { requireThat(false, 'INVALID_CALENDAR_ZONE', 'Invalid calendar time zone.'); }
    // Pad the window for viewers on either side of UTC and apply exact local bounds below.
    const upstreamStart = new Date(start - dayMs).toISOString(), upstreamEnd = new Date(end + dayMs).toISOString();
    const sources: CalendarPage['sources'] = {Library: library ? 'ready' : 'disconnected'};
    const movies = async () => {
      if (!library) return [];
      const rows = libraryMovieEntries(library.store.calendarMovies(), upstreamStart.slice(0, 10), upstreamEnd.slice(0, 10));
      await pictures(rows);
      return rows;
    };
    const shows = async () => {
      if (!library) return [];
      const rows = libraryEpisodeEntries(library.store.calendarEpisodes(upstreamStart.slice(0, 10), upstreamEnd.slice(0, 10)));
      await pictures(rows);
      return rows;
    };
    const feeds = await Promise.all([movies(), shows()]);
    const unique = new Map<string, Scheduled>();
    for (const entry of feeds.flat()) {
      const local = entry.airTime ? localDay.format(new Date(entry.airTime)) : entry.day;
      if (local < from || local >= to) continue;
      const previous = unique.get(entry.key);
      if (!previous || (entry.hasFile && !previous.hasFile)) unique.set(entry.key, {...entry, day: local});
    }
    const groups = new Map<string, Scheduled[]>();
    const seasons = new Map<string, Scheduled[]>();
    for (const entry of unique.values()) {
      if (tmdb && entry.kind === 'episode' && entry.season && entry.episode && !entry.episodeLabel) {
        const key = entry.key.slice(0, entry.key.lastIndexOf(':'));
        const season = seasons.get(key) ?? [];
        season.push(entry);
        seasons.set(key, season);
      }
      if (entry.hasFile === false) continue;
      const key = entry.kind === 'episode' ? entry.key.split(':').slice(0, -2).join(':') : entry.key;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    let plexUnavailable = false;
    const pending = groups.values();
    // A season may air together. Match its series once, then find each episode by number.
    const availability = Array.from({length: Math.min(6, groups.size)}, async () => {
      for (const group of pending) {
        const first = group[0]!;
        const guids = Object.entries(first.ids).flatMap(([source, value]) => value ? [`${source}://${value}`] : []);
        try {
          const media = await plex.calendarMedia(grant, first.kind === 'episode' ? 'show' : 'movie', first.title, guids);
          for (const entry of group) {
            const match = media.find(item => item.season === entry.season && item.episode === entry.episode);
            if (match) {
              entry.plexItemId = match.id;
              entry.plexShowId = match.showId;
              entry.posterUrl = match.posterUrl ?? entry.posterUrl;
              entry.backdropUrl = match.backdropUrl ?? entry.backdropUrl;
            }
          }
        } catch {
          plexUnavailable = true;
          for (const entry of group) entry.availabilityUnknown = true;
        }
      }
    });
    const pendingSeasons = seasons.values();
    const episodeLabels = Array.from({length: Math.min(6, seasons.size)}, async () => {
      for (const season of pendingSeasons) {
        const first = season[0]!;
        const labels = await tmdb!.episodeFinales(first.ids, first.season!, season.map(entry => entry.episode!)).catch(() => undefined);
        for (const entry of season) entry.episodeLabel = labels?.get(entry.episode!);
      }
    });
    await Promise.all([...availability, ...episodeLabels]);
    const dates = [...unique.values()].sort((a, b) => a.day.localeCompare(b.day) || (a.airTime ?? '').localeCompare(b.airTime ?? '') ||
      a.title.localeCompare(b.title) || (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))
      .map(({hasFile: _, ...entry}) => entry);
    return {dates, sources, plexUnavailable};
  });
}
