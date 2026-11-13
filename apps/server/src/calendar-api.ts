import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CalendarEntry, CalendarPage } from '../../../packages/contracts/src/index.js';
import type { ArrService } from './providers/arr-tags.js';
import type { PlexAdapter, PlexGrant } from './providers/plex.js';
import { imagePath } from './providers/explore-images.js';
import { remoteJson } from './providers/remote-json.js';
import type { TmdbTitles } from './providers/tmdb-titles.js';
import { requireThat } from './errors.js';

const day = z.iso.date();
const query = z.object({from: day, to: day, zone: z.string().min(1).max(100).default('UTC'), account: z.string().optional()}).strict();
const dayMs = 86_400_000;
const id = z.number().int().positive().optional().catch(undefined);
const images = z.array(z.object({coverType: z.string(), remoteUrl: z.string().nullish(), url: z.string().nullish()})).optional().catch(undefined);
const info = z.object({
  title: z.string().trim().min(1).max(500), year: z.number().int().positive().optional().catch(undefined),
  overview: z.string().max(20_000).optional().catch(undefined), tmdbId: id, tvdbId: id,
  imdbId: z.string().regex(/^tt\d{1,12}$/).optional().catch(undefined),
  remotePoster: z.string().optional().catch(undefined),
  images,
});
const movie = info.extend({inCinemas: z.unknown().optional(), digitalRelease: z.unknown().optional(), physicalRelease: z.unknown().optional(), hasFile: z.boolean().optional()});
const episode = z.object({
  title: z.string().trim().max(500).optional().catch(undefined), seasonNumber: z.number().int().nonnegative(),
  episodeNumber: z.number().int().nonnegative(), airDate: z.unknown().optional(), airDateUtc: z.unknown().optional(),
  hasFile: z.boolean().optional(), series: info, images,
});
type Scheduled = CalendarEntry & { hasFile?: boolean };
type Source = keyof CalendarPage['sources'];

function datePart(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return undefined;
  const date = value.slice(0, 10);
  return day.safeParse(date).success && date > '0001-01-01' ? date : undefined;
}

function cover(art: z.infer<typeof images>, types: string[]) {
  return types.flatMap(type => (art ?? []).filter(image => image.coverType.toLowerCase() === type)
    .flatMap(image => imagePath(image.remoteUrl ?? undefined) ?? imagePath(image.url ?? undefined) ?? []))[0];
}

function titleFields(value: z.infer<typeof info>) {
  const ids = {tmdb: value.tmdbId, tvdb: value.tvdbId, imdb: value.imdbId};
  return {title: value.title, year: value.year, summary: value.overview, ids,
    posterUrl: imagePath(value.remotePoster) ?? cover(value.images, ['poster']),
    backdropUrl: cover(value.images, ['fanart', 'backdrop', 'banner'])};
}

function movieEntry(raw: unknown): Scheduled[] {
  const result = movie.safeParse(raw);
  if (!result.success || !result.data.tmdbId) return [];
  const item = result.data;
  const digital = datePart(item.digitalRelease), physical = datePart(item.physicalRelease);
  const useDigital = digital && (!physical || digital <= physical);
  const release = useDigital ? digital : physical ?? datePart(item.inCinemas);
  if (!release) return [];
  return [{...titleFields(item), key: `movie:${item.tmdbId}`, day: release, kind: useDigital ? 'digital' : physical ? 'physical' : 'theatrical', hasFile: item.hasFile}];
}

function episodeEntry(raw: unknown): Scheduled[] {
  const result = episode.safeParse(raw);
  if (!result.success) return [];
  const {series, seasonNumber, episodeNumber, title, airDate, airDateUtc, hasFile} = result.data;
  const seriesKey = series.tvdbId ? `tvdb:${series.tvdbId}` : series.tmdbId ? `tmdb:${series.tmdbId}` : series.imdbId;
  if (!seriesKey) return [];
  const timed = z.iso.datetime({offset: true}).safeParse(airDateUtc);
  const airTime = timed.success && datePart(timed.data) ? new Date(timed.data) : undefined;
  const release = datePart(airDate) ?? (airTime && datePart(airTime.toISOString()));
  if (!release) return [];
  return [{...titleFields(series), key: `episode:${seriesKey}:${seasonNumber}:${episodeNumber}`, kind: 'episode',
    day: release, airTime: airTime?.toISOString(), season: seasonNumber, episode: episodeNumber,
    episodeLabel: episodeNumber === 1 && seasonNumber > 0 ? seasonNumber === 1 ? 'series-premiere' : 'season-premiere' : undefined,
    stillUrl: cover(result.data.images, ['screenshot', 'still', 'thumb']),
    episodeTitle: title && !/^tba$/i.test(title) ? title : undefined, hasFile}];
}

export function registerCalendar(app: FastifyInstance, plex: Pick<PlexAdapter, 'calendarMedia'>,
  auth: (request: FastifyRequest) => Promise<{grant: PlexGrant}>, connections: () => {radarr: ArrService; sonarr: ArrService},
  transport: typeof fetch = fetch, tmdb?: Pick<TmdbTitles, 'episodeFinales'>) {
  // Provider schedules are shared. Plex matches are cached separately by the viewer's grant.
  const cache = new Map<string, {until: number; rows: Promise<Scheduled[]>}>();
  const read = (source: Source, connection: ArrService, start: string, end: string) => {
    const key = createHash('sha256').update(JSON.stringify([source, connection.url, connection.key, start, end])).digest('hex');
    const now = Date.now(), hit = cache.get(key);
    if (hit && hit.until > now) return hit.rows;
    const url = new URL(`${connection.url.replace(/\/+$/, '')}/api/v3/calendar`);
    url.search = new URLSearchParams({start, end, unmonitored: 'true', ...(source === 'Sonarr' ? {includeSeries: 'true', includeEpisodeImages: 'true'} : {})}).toString();
    const rows = remoteJson(url, {headers: {'X-Api-Key': connection.key!}}, source, transport, 10_000, 16 * 1024 * 1024).then(response => {
      requireThat(response.status === 200 && Array.isArray(response.data), 'CALENDAR_UNAVAILABLE', `${source} could not load its calendar.`, 502);
      return response.data.flatMap(source === 'Radarr' ? movieEntry : episodeEntry);
    });
    cache.delete(key);
    cache.set(key, {until: now + 5 * 60_000, rows});
    rows.catch(() => { if (cache.get(key)?.rows === rows) cache.delete(key); });
    while (cache.size > 100) cache.delete(cache.keys().next().value!);
    return rows;
  };

  app.get('/api/v1/calendar', {config: {rateLimit: {max: 60, timeWindow: 60_000}}}, async (request, reply): Promise<CalendarPage> => {
    const {grant} = await auth(request);
    reply.header('Cache-Control', 'private, no-store');
    const {from, to, zone, account} = query.parse(request.query), start = Date.parse(from), end = Date.parse(to);
    requireThat(account === undefined || account === grant.accountId, 'FORBIDDEN', 'This calendar belongs to another account.', 403);
    requireThat(end > start && end - start <= 62 * dayMs, 'INVALID_CALENDAR_RANGE', 'Choose a calendar range of 1 to 62 days.');
    let localDay: Intl.DateTimeFormat;
    try { localDay = new Intl.DateTimeFormat('sv-SE', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'}); }
    catch { requireThat(false, 'INVALID_CALENDAR_ZONE', 'Invalid calendar time zone.'); }
    // Arr returns UTC timestamps. Pad the upstream window for viewers on either side of UTC and apply exact local bounds below.
    const upstreamStart = new Date(start - dayMs).toISOString(), upstreamEnd = new Date(end + dayMs).toISOString();
    const {radarr, sonarr} = connections();
    const sources: CalendarPage['sources'] = {Radarr: 'disconnected', Sonarr: 'disconnected'};
    const fetchSource = async (source: Source, connection: ArrService) => {
      if (!connection.url || !connection.key) return [];
      try {
        const rows = await read(source, connection, upstreamStart, upstreamEnd);
        sources[source] = 'ready';
        return rows;
      } catch {
        sources[source] = 'unavailable';
        return [];
      }
    };
    const feeds = await Promise.all([fetchSource('Radarr', radarr), fetchSource('Sonarr', sonarr)]);
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
