import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CalendarEntry, CalendarPage } from '../../../packages/contracts/src/index.js';
import type { PlexAdapter } from './providers/plex.js';
import type { PlexIndex } from './services/plex-index.js';
import { imagePath, tmdbImage } from './providers/explore-images.js';
import type { CalendarEpisode, CalendarMovie, LibraryCalendar } from './services/library.js';
import type { Have } from './services/wanted.js';
import type { TmdbTitles } from './providers/tmdb-titles.js';
import { requireThat } from './errors.js';
import { viewer } from './modules/access.js';
import { movieReleaseDate } from './lib/release-day.js';

const day = z.iso.date();
const query = z.object({from: day, to: day, zone: z.string().min(1).max(100).default('UTC'), account: z.string().optional()}).strict();
const dayMs = 86_400_000;
type Scheduled = CalendarEntry & { have: Have };

// The calendar's movies are the library's, on the day its TMDB dates give (digital, else physical, else theatrical).
// The picture and summary are TMDB's, from the details the library already reads (cached). Shows are the library's
// too, at TVmaze's exact air time where it has one, else on TMDB's air date. Which titles show, and what tk.box has of
// each (a file, Plex holding it, or none), are the library's (library.calendar).
export type CalendarLibrary = { calendar(from: string, to: string): LibraryCalendar };
// Keys by TVDB id (else TMDB), so a viewer's Plex match and the season finales find them.
export function libraryEpisodeEntries(episodes: CalendarEpisode[]): Scheduled[] {
  return episodes.map(({show, season, episode, name, airDate, airTime, have}) => {
    const titleKey = `episode:${show.tvdbId ? `tvdb:${show.tvdbId}` : `tmdb:${show.tmdbId}`}`;
    return {key: `${titleKey}:${season}:${episode}`, titleKey, kind: 'episode' as const,
    title: show.title, ...(show.year ? {year: show.year} : {}), ids: {tmdb: show.tmdbId, ...(show.tvdbId ? {tvdb: show.tvdbId} : {}), ...(show.imdbId ? {imdb: show.imdbId} : {})},
    day: airDate, ...(airTime !== undefined ? {airTime: new Date(airTime).toISOString()} : {}), season, episode, episodeLabel: episode === 1 ? season === 1 ? 'series-premiere' as const : 'season-premiere' as const : undefined,
    episodeTitle: name && !/^tba$/i.test(name) ? name : undefined, have};
  });
}
export function libraryMovieEntries(movies: CalendarMovie[], from: string, to: string): Scheduled[] {
  return movies.flatMap(m => {
    const release = movieReleaseDate({inCinemas: m.released.theatrical, digitalRelease: m.released.digital, physicalRelease: m.released.physical});
    if (!release || release.day < from || release.day > to) return [];
    return [{key: `movie:${m.tmdbId}`, titleKey: `movie:${m.tmdbId}`, title: m.title, ...(m.year ? {year: m.year} : {}), ids: {tmdb: m.tmdbId, ...(m.imdbId ? {imdb: m.imdbId} : {})},
      day: release.day, kind: release.format, have: m.have}];
  });
}

export function registerCalendar(app: FastifyInstance, plex: Pick<PlexAdapter, 'calendarMedia'>, tmdb?: Pick<TmdbTitles, 'episodeFinales' | 'get'>, library?: CalendarLibrary,
  // The title identity (the Plex index): each entry's rating key on this server.
  plexTitles?: Pick<PlexIndex, 'resolve'>) {
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
    const scheduled = library?.calendar(upstreamStart.slice(0, 10), upstreamEnd.slice(0, 10));
    const movies = async () => {
      if (!scheduled) return [];
      const rows = libraryMovieEntries(scheduled.movies, upstreamStart.slice(0, 10), upstreamEnd.slice(0, 10));
      await pictures(rows);
      return rows;
    };
    const shows = async () => {
      if (!scheduled) return [];
      const rows = libraryEpisodeEntries(scheduled.episodes);
      await pictures(rows);
      return rows;
    };
    const feeds = await Promise.all([movies(), shows()]);
    const unique = new Map<string, Scheduled>();
    for (const entry of feeds.flat()) {
      const local = entry.airTime ? localDay.format(new Date(entry.airTime)) : entry.day;
      if (local < from || local >= to) continue;
      const previous = unique.get(entry.key);
      if (!previous || (entry.have !== 'none' && previous.have === 'none')) unique.set(entry.key, {...entry, day: local});
    }
    const groups = new Map<string, Scheduled[]>();
    const seasons = new Map<string, Scheduled[]>();
    for (const entry of unique.values()) {
      if (tmdb && entry.kind === 'episode' && entry.season && entry.episode && !entry.episodeLabel) {
        const key = `${entry.titleKey}:${entry.season}`;
        const season = seasons.get(key) ?? [];
        season.push(entry);
        seasons.set(key, season);
      }
      // Plex can only have what tk.box has (a file, or on Plex already); what nothing has isn't looked for.
      if (entry.have === 'none') continue;
      const group = groups.get(entry.titleKey) ?? [];
      group.push(entry);
      groups.set(entry.titleKey, group);
    }
    let plexUnavailable = false;
    const pending = groups.values();
    // A season may air together. Match its series once, then find each episode by number.
    const availability = Array.from({length: Math.min(6, groups.size)}, async () => {
      for (const group of pending) {
        const first = group[0]!;
        const kind = first.kind === 'episode' ? 'show' : 'movie';
        // The server's copies from the title identity; one Plex hasn't got (an import not yet scanned) has no match.
        const copies = first.ids.tmdb ? plexTitles?.resolve({kind, tmdb: first.ids.tmdb, tvdb: first.ids.tvdb})?.copies : undefined;
        if (!copies?.length) continue;
        try {
          const media = await plex.calendarMedia(grant, kind, copies);
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
      .map(({have: _, ...entry}) => entry);
    return {dates, sources, plexUnavailable};
  });
}
