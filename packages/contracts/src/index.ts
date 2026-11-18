import { z } from 'zod';

export const playbackMode = z.enum(['plex_vod', 'custom_linear', 'iptv_live']);
export type PlaybackMode = z.infer<typeof playbackMode>;
export const playbackObservation = z.object({
  sequence: z.number().int().positive(),
  elapsedMs: z.number().int().nonnegative(),
  positionMs: z.number().int().nonnegative(),
  presentationUtc: z.number().int().positive().optional(),
  rate: z.number().min(0.25).max(4),
  state: z.enum(['playing', 'paused', 'buffering', 'seeking', 'ended', 'stopped'])
}).strict();
export type PlaybackObservation = z.infer<typeof playbackObservation>;
export const historySources = ['vod', 'plex', 'iptv', 'custom'] as const;
export type HistorySource = typeof historySources[number];
export type HistoryListRow = {
  id: string; source: HistorySource; accountId: string; accountName: string | null; title: string;
  kind: string; ratingKey: string; showTitle?: string; startedAt: number; endedAt: number | null;
  year?: number; season?: number; episode?: number; channelNumber?: number;
  watchMs: number; positionMs: number; durationMs?: number; client: string;
  stream: { delivery: string; video?: string; audio?: string; sourceHeight?: number; outputHeight?: number; maxHeight?: number };
  endReason: string | null; serverId: string;
};
export type HistorySessionDetail = {
  session: HistoryListRow;
  observedAt: number;
  deliveryMs: Record<'direct' | 'remux' | 'transcode', number>;
  allocations: { day: string; feedId: string; watchMs: number; title: string | null; estimated: number }[];
};
export type HistoryRank = { id: string; title: string; sessions: number; watchMs: number; viewers: number };
export type HistoryMediaRank = HistoryRank & { kind: 'movie' | 'show' | 'episode' | 'channel' | 'program' };
export type HistorySummary = {
  sessions: number; viewers: number; watchMs: number;
  days: { day: string; watchMs: number }[];
  delivery: { direct: number; remux: number; transcode: number };
};
// Conversion choices, Plex's ladder from 20 Mbps down to 480p. Each caps output height and video bitrate.
export const qualityTiers = [
  { id: '1080p-20', label: '1080p HD (High)', height: 1080, bitrateKbps: 20000 },
  { id: '1080p-12', label: '1080p HD (Medium)', height: 1080, bitrateKbps: 12000 },
  { id: '1080p-10', label: '1080p HD', height: 1080, bitrateKbps: 10000 },
  { id: '1080p-8', label: '1080p HD', height: 1080, bitrateKbps: 8000 },
  { id: '720p-4', label: '720p HD (High)', height: 720, bitrateKbps: 4000 },
  { id: '720p-3', label: '720p HD (Medium)', height: 720, bitrateKbps: 3000 },
  { id: '720p-2', label: '720p HD', height: 720, bitrateKbps: 2000 },
  { id: '480p-1.5', label: '480p', height: 480, bitrateKbps: 1500 }
] as const;
export type QualityTier = typeof qualityTiers[number];
export const quality = z.enum(['auto', 'original', ...qualityTiers.map(t => t.id)] as ['auto', 'original', ...QualityTier['id'][]]);
export type Quality = z.infer<typeof quality>;
// One entry in a title's quality menu: the route it plays by, or why it is unavailable.
export type QualityOption = { quality: Quality; available: boolean; route?: 'direct' | 'remux' | 'cpu'; reason?: string };
// Languages a viewer can prefer for audio and subtitles, by ISO 639-2/T code. Plex tags tracks with
// three-letter codes in either the /T or /B form, so both (and two-letter tags) compare through `languageKey`.
export const preferredLanguages = [
  ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'],
  ['nld', 'Dutch'], ['swe', 'Swedish'], ['nor', 'Norwegian'], ['dan', 'Danish'], ['fin', 'Finnish'], ['pol', 'Polish'],
  ['ces', 'Czech'], ['hun', 'Hungarian'], ['ron', 'Romanian'], ['ell', 'Greek'], ['tur', 'Turkish'], ['rus', 'Russian'],
  ['ukr', 'Ukrainian'], ['heb', 'Hebrew'], ['ara', 'Arabic'], ['hin', 'Hindi'], ['tha', 'Thai'], ['vie', 'Vietnamese'],
  ['ind', 'Indonesian'], ['msa', 'Malay'], ['zho', 'Chinese'], ['jpn', 'Japanese'], ['kor', 'Korean']
] as const;
const languageAliases: Record<string, string> = {
  fre: 'fra', ger: 'deu', dut: 'nld', cze: 'ces', rum: 'ron', gre: 'ell', chi: 'zho', may: 'msa', nob: 'nor', nno: 'nor',
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', nl: 'nld', sv: 'swe', no: 'nor', nb: 'nor', nn: 'nor', da: 'dan',
  fi: 'fin', pl: 'pol', cs: 'ces', hu: 'hun', ro: 'ron', el: 'ell', tr: 'tur', ru: 'rus', uk: 'ukr', he: 'heb', ar: 'ara', hi: 'hin',
  th: 'tha', vi: 'vie', id: 'ind', ms: 'msa', zh: 'zho', ja: 'jpn', ko: 'kor'
};
export const languageKey = (code?: string | null) => {const c = code?.trim().toLowerCase() ?? ''; return languageAliases[c] ?? c;};
export const playbackSettings = z.object({
  maxConcurrentCpuVideoTranscodes: z.number().int().min(1).max(16),
  pauseRetentionMinutes: z.number().int().min(5).max(120)
}).strict();
export type PlaybackSettings = z.infer<typeof playbackSettings>;
// `owner` is the Plex server owner, the one admin who can make others admins.
export type Principal = { accountId: string; role: 'admin' | 'viewer'; owner?: boolean };
export type PlexUserSettings = {
  key: string;
  accountId: string | null;
  name: string;
  username?: string;
  home: boolean;
  managed: boolean;
  access: 'granted' | 'pending' | 'none';
  canAdmin: boolean;
};
export type PlexUsersView = {
  users: PlexUserSettings[];
  admins: { accountId: string; name: string; addedAt: number }[];
  ownerId: string;
  ownerName?: string;
  ownerTokenSaved: boolean;
  directoryIncomplete: boolean;
  canRevoke: boolean;
};
export type CleanupUsersView = {
  users: { accountId: number; name: string; username?: string }[];
  directoryIncomplete: boolean;
};
export type ApiError = { code: string; message: string; retryable: boolean };

export type Library = {key: string; title: string; type: 'movie' | 'show'};
export type CatalogItem = {
  id: string; libraryId: string; type: 'movie' | 'show' | 'season' | 'episode'; title: string;
  summary: string; year?: number; durationMs?: number; viewOffsetMs: number; watched: boolean;
  posterUrl?: string; showPosterUrl?: string; backdropUrl?: string; parentId?: string; parentTitle?: string;
  showId?: string; showTitle?: string; seasonNumber?: number; episodeNumber?: number;
  // seasonCount is set only on a recently added show card that merges several new seasons.
  seasonCount?: number; episodeCount?: number; watchedEpisodeCount?: number; contentRating?: string; rating?: number;
  genres: string[]; addedAt?: number;
  // Detail fields Plex sends on a single item (lists usually omit them).
  ratings?: ExternalRating[]; logoUrl?: string; tagline?: string; airDate?: string; studio?: string; directors?: string[]; cast?: string[];
  // A movie's or show's TMDB id, which lets its cast and crew link to the right people, and the item's own IMDb id.
  tmdbId?: number; imdbId?: string; tvdbId?: number;
  // The Plex collections a movie or show belongs to (detail only).
  collections?: { id: string; title: string; count?: number; kind: 'movie' | 'show'; posterUrl?: string }[];
};
// A third-party score from the item's Plex agent, on Plex's 0–10 scale. `fresh` is Rotten Tomatoes' fresh/upright state.
export type ExternalRating = {source: 'imdb' | 'tomatometer' | 'popcornmeter' | 'tmdb'; score: number; fresh?: boolean};
export type CatalogPage = {items: CatalogItem[]; offset: number; limit: number; total?: number; hasMore: boolean};

// Explore: titles from catalog sources outside the Plex server (Plex Discover, TMDB).
export const exploreSources = ['plex', 'tmdb'] as const;
export type ExploreSource = typeof exploreSources[number];
export const exploreBrowseSources = ['plex', 'tmdb'] as const;
export type ExploreBrowseSource = typeof exploreBrowseSources[number];
export const streamingRows = ['popular-streaming', 'recent-streaming'] as const;
export type StreamingRow = typeof streamingRows[number];
// TMDB's rows in their default order. The `top-` and `because-` rows are each viewer's own suggestions.
export const tmdbExploreRows = ['popular-movies', 'popular-shows', 'top-movies', 'top-shows', 'trending', 'because-movie', 'popular-streaming',
  'because-show', 'recent-streaming', 'acclaimed', 'upcoming-movies', 'upcoming-shows'] as const;
export type TmdbExploreRow = typeof tmdbExploreRows[number];
export type ExploreWatchProvider = {id: number; name: string; logoUrl?: string};
export type ExploreWatchProviders = {regions: {code: string; name: string}[]; providers: ExploreWatchProvider[]; defaults: number[]};
// tk.box's own requests (docs/REQUESTS.md). A title's label: on the server, partly, being downloaded, or asked for.
export type RequestLabel = 'available' | 'partial' | 'downloading' | 'requested';
export type ExploreStatus = RequestLabel;
export type RequestStatus = 'queued' | 'requested' | 'downloading' | 'partial' | 'available' | 'failed' | 'removed';
export type RequestItem = { id: number; kind: 'movie' | 'show'; tmdbId: number; title: string; year?: number; status: RequestStatus; statusAt: number; createdAt: number;
  seen: boolean; seasons: { season: number; available: boolean }[]; accountName: string; error?: string; removedBy?: string;
  // The Requests page's All requests: the request is the viewer's own, so they may cancel it.
  mine?: boolean };
export type RequestPage = { items: RequestItem[]; total: number; page: number; hasMore: boolean };
export type RequestArtwork = { posterUrl?: string; backdropUrl?: string };
export type RequestRelease =
  | { kind: 'movie'; date?: { format: 'theatrical' | 'digital' | 'physical'; day: string }; waitingForRelease?: true }
  | { kind: 'episode'; season: number; episode: number; day: string; aired: boolean };
export type RequestTiming = { kind: 'added'; at?: number } | { kind: 'searched'; at?: number; unavailable?: true; release?: RequestRelease };
export type MyRequests = { items: RequestItem[]; unseen: number };
// Alerts behind the header's bell (docs/NOTIFICATIONS.md). `audience` 'admins': a system alert every admin sees, with
// read state per admin. `open`: a condition (a service down, a job failing) that stays until its cause is fixed.
export type NotificationTone = 'success' | 'info' | 'warning' | 'error';
export type NotificationItem = { id: number; audience: 'account' | 'admins'; kind: string; tone: NotificationTone; title: string; detail?: string;
  link?: string; createdAt: number; updatedAt: number; read: boolean; open: boolean };
export type NotificationList = { items: NotificationItem[]; unread: number };
export type RequestDestination = { profileId: number; rootFolder: string; tags: number[] };
export type RequestSettings = { revision: number; movie: RequestDestination; show: RequestDestination & { seasonFolders: boolean }; searchOnAdd: boolean };
// Admin › Requests › Requests site. `running` is the port it is listening on now; `publicAddress` says tk.box has a
// public address, so the site needs one too.
export type RequestsSiteStatus = { revision: number; port: number | null; publicUrl: string | null; publicAddress: boolean; appPort: number; running: number | null; error?: string };
// `keepTag`: Clean Up's first protected tag, which a request's Keep adds; absent when Clean Up has none. `tkbox`: the
// kind is fulfilled by tk.box's own library, so the profiles are its pick profiles, there are no folders or tags, and
// Keep is the title's own flag (`keepTag` is then 'Keep').
export type RequestOptions = { connected: boolean; tkbox?: boolean; profiles: { id: number; name: string }[]; rootFolders: { path: string; freeSpace?: number }[]; tags: { id: number; label: string }[];
  defaults: RequestDestination; keepTag?: string };
// The genres Explore filters on: TMDB's movie and TV genres and Plex's, merged into one list.
export const exploreGenres = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids',
  'Music', 'Mystery', 'Reality', 'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western'] as const;
export type ExploreGenre = typeof exploreGenres[number];
export type ExploreItem = {
  key: string; source: ExploreSource; kind: 'movie' | 'show'; title: string; year?: number; summary?: string;
  posterUrl?: string; backdropUrl?: string; rating?: number; durationMs?: number; episodeCount?: number;
  // Original language (ISO 639-1, TMDB's codes). Plex Discover does not send it.
  language?: string;
  // Genres in Explore's own names (`exploreGenres`), whatever each source calls them.
  genres?: ExploreGenre[];
  // `plex` is the Plex Discover rating key (not this server's), `plexGuid` the plex:// guid both share.
  ids: { tmdb?: number; imdb?: string; tvdb?: number; plex?: string; plexGuid?: string };
  status?: ExploreStatus;
};
export type ExplorePage = { items: ExploreItem[]; page: number; hasMore: boolean; total?: number; title?: string };
export type TitleCredit = {
  personId?: number; name: string; role: 'actor' | 'director' | 'creator'; character?: string; portraitUrl?: string;
};
export type TitleCredits = {tmdbId?: number; credits: TitleCredit[]};
// A person's page (TMDB): their credits, each carrying tk.box's request label like Explore cards.
// `roles`: acting and/or directing (a show's creator counts as directing).
export type PersonCredit = { item: ExploreItem; roles: ('actor' | 'director')[]; character?: string; job?: string; votes: number; popularity: number; date?: string };
export type PersonDetails = {
  id: number; name: string; photoUrl?: string; department?: string; since?: number; biography?: string;
  birthday?: string; deathday?: string; birthplace?: string; imdb?: string; movies: number; shows: number;
  knownFor: PersonCredit[]; upcoming: PersonCredit[]; library: PersonCredit[]; credits: PersonCredit[];
};
export type RelatedRowKind = 'similar' | 'maker' | 'actor';
export type TitleRelated = {
  rows: {kind: RelatedRowKind; person?: TitleCredit; items: ExploreItem[]}[];
  failed: RelatedRowKind[];
};
export type CalendarEpisodeLabel = 'series-premiere' | 'season-premiere' | 'season-finale' | 'series-finale';
export type CalendarEntry = {
  // `key`: this entry; `titleKey`: its movie or show (a show's episodes share it), e.g. `movie:603`, `episode:tvdb:121361`.
  key: string; titleKey: string; title: string; day: string; year?: number; airTime?: string;
  kind: 'theatrical' | 'digital' | 'physical' | 'episode';
  season?: number; episode?: number; episodeTitle?: string; episodeLabel?: CalendarEpisodeLabel; summary?: string;
  posterUrl?: string; backdropUrl?: string; stillUrl?: string;
  ids: Pick<ExploreItem['ids'], 'tmdb' | 'tvdb' | 'imdb'>; plexItemId?: string; plexShowId?: string; availabilityUnknown?: boolean;
};
export type CalendarPage = {
  dates: CalendarEntry[];
  // Library: tk.box's own movies and shows.
  sources: Partial<Record<'Library', 'ready' | 'disconnected' | 'unavailable'>>;
  plexUnavailable: boolean;
};
// Search across every catalog source; `failed` names sources that could not be searched.
export type ExploreSearchResult = { items: ExploreItem[]; failed: ExploreSource[] };
export type ExploreRowInfo = { id: string; title: string; icon: string; personal?: boolean; streaming?: boolean };
export type ExploreSeason = { number: number; name: string; episodeCount?: number; airDate?: string; status?: ExploreStatus };
// Server-wide: the order Explore lists its sources in, sources switched off, and single rows hidden (`source:rowId`).
export type ExploreLayout = { order: ExploreBrowseSource[]; hidden: ExploreBrowseSource[]; hiddenRows: string[]; tmdbOrder?: TmdbExploreRow[];
  ranking?: import('./explore-ranking.js').ExploreRanking };
export type ExploreSources = {
  plex: boolean;
  // Sources shown, in the administrator's order (whether or not each is set up).
  order: ExploreBrowseSource[];
  // Whether movies and shows can be requested (tk.box's library takes both).
  requests: { movie: boolean; show: boolean };
  tmdb: { configured: boolean };
};
export type ExploreDetails = {
  item: ExploreItem; genres: string[]; tagline?: string; cast: string[]; network?: string; contentRating?: string;
  // The facts listed beside a title. `status` is TMDB's (Ended, Returning Series, Released…), dates are YYYY-MM-DD.
  status?: string; released?: string; language?: string; countries: { code?: string; name: string; flagUrl?: string }[]; studios: string[];
  ratings: ExternalRating[]; providers: { name: string; logoUrl?: string }[];
  links: { site: 'tmdb' | 'tvdb' | 'imdb' | 'rottentomatoes'; url: string }[];
  // This server's library copy, when the viewer can open it.
  libraryId?: string;
  // A library copy verified by external GUID, for direct navigation from a related card.
  matchedLibraryId?: string;
  // Plex Discover watchlist state; undefined when Discover does not know the title.
  watchlisted?: boolean;
  // What is still open to request: the movie, or each regular season with its state. Absent when TMDB doesn't know
  // the title.
  request?: { requestable: boolean; seasons: ExploreSeason[] };
  // TMDB's YouTube trailer (or teaser), by YouTube video key.
  trailer?: TitleTrailer;
};
export type TitleTrailer = { key: string; name?: string };
