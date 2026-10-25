import { z } from 'zod';

export const playbackMode = z.enum(['plex_vod', 'custom_linear', 'iptv_live']);
export type PlaybackMode = z.infer<typeof playbackMode>;
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
export const playbackSettings = z.object({
  maxConcurrentCpuVideoTranscodes: z.number().int().min(1).max(16),
  pauseRetentionMinutes: z.number().int().min(5).max(120)
}).strict();
export type PlaybackSettings = z.infer<typeof playbackSettings>;
// `owner` is the Plex server owner, the one admin who can make others admins.
export type Principal = { accountId: string; role: 'admin' | 'viewer'; owner?: boolean };
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
  tmdbId?: number; imdbId?: string;
  // The Plex collections a movie or show belongs to (detail only).
  collections?: { id: string; title: string; count?: number; kind: 'movie' | 'show'; posterUrl?: string }[];
};
// A third-party score from the item's Plex agent, on Plex's 0–10 scale. `fresh` is Rotten Tomatoes' fresh/upright state.
export type ExternalRating = {source: 'imdb' | 'tomatometer' | 'popcornmeter' | 'tmdb'; score: number; fresh?: boolean};
export type CatalogPage = {items: CatalogItem[]; offset: number; limit: number; total?: number; hasMore: boolean};

// Explore: titles from catalog sources outside the Plex server (Plex Discover, Seerr, Trakt).
export type ExploreSource = 'plex' | 'seerr' | 'trakt';
// Seerr's view of a title on the media server: available, partly available, or requested (including being downloaded).
export type ExploreStatus = 'available' | 'partial' | 'requested';
export type ExploreItem = {
  key: string; source: ExploreSource; kind: 'movie' | 'show'; title: string; year?: number; summary?: string;
  posterUrl?: string; backdropUrl?: string; rating?: number; durationMs?: number; episodeCount?: number;
  // Original language (ISO 639-1, TMDB's codes). Plex Discover does not send it.
  language?: string;
  // `plex` is the Plex Discover rating key (not this server's), `plexGuid` the plex:// guid both share.
  ids: { tmdb?: number; imdb?: string; tvdb?: number; trakt?: number; plex?: string; plexGuid?: string };
  status?: ExploreStatus;
};
export type ExplorePage = { items: ExploreItem[]; page: number; hasMore: boolean; total?: number };
// Search across every catalog source; `failed` names sources that could not be searched.
export type ExploreSearchResult = { items: ExploreItem[]; failed: ExploreSource[] };
export type ExploreRowInfo = { id: string; title: string; icon: string; personal?: boolean };
export type ExploreSeason = { number: number; name: string; episodeCount?: number; airDate?: string; status?: ExploreStatus };
// Server-wide: the order Explore lists its sources in, sources switched off, and single rows hidden (`source:rowId`).
export type ExploreLayout = { order: ExploreSource[]; hidden: ExploreSource[]; hiddenRows: string[] };
export type ExploreSources = {
  plex: boolean;
  // Sources shown, in the administrator's order (whether or not each is set up).
  order: ExploreSource[];
  // `statuses`: Plex and Trakt titles carry Seerr's labels (needs the Seerr API key).
  seerr: { configured: boolean; statuses: boolean };
  trakt: { configured: boolean; linked: boolean; user?: string };
};
export type ExploreDetails = {
  item: ExploreItem; genres: string[]; tagline?: string; cast: string[]; network?: string; contentRating?: string;
  // The facts Seerr lists beside a title. `status` is TMDB's (Ended, Returning Series, Released…), dates are YYYY-MM-DD.
  status?: string; released?: string; language?: string; countries: { code?: string; name: string; flagUrl?: string }[]; studios: string[];
  ratings: ExternalRating[]; providers: { name: string; logoUrl?: string }[];
  links: { site: 'tmdb' | 'tvdb' | 'imdb' | 'rottentomatoes' | 'trakt'; url: string }[];
  // This server's library copy, when the viewer can open it.
  libraryId?: string;
  // Plex Discover watchlist state; undefined when Discover does not know the title.
  watchlisted?: boolean;
  // What is still open to request (4K only when Seerr has 4K on). The viewer's own permissions are checked when they request.
  seerr?: { requestable: boolean; requestable4k: boolean; seasons: ExploreSeason[]; seasons4k: ExploreSeason[]; status4k?: ExploreStatus };
};
// The viewer's Seerr account, read only when they go to request (it signs them in to Seerr with their Plex account).
export type ExploreSeerrAccount = { user?: string; canRequest: { movie: boolean; show: boolean }; fourK: { movie: boolean; show: boolean };
  // Requests Seerr approves without an administrator, by quality.
  autoApprove: { movie: boolean; show: boolean; movie4k: boolean; show4k: boolean };
  // `advanced` may pick the Radarr/Sonarr server, quality profile, root folder and tags; `requestAs` may request for another Seerr user.
  advanced: boolean; requestAs: boolean };
// Radarr or Sonarr choices for an advanced request, with the server's defaults selected.
export type ExploreSeerrOptions = { servers: { id: number; name: string }[]; serverId?: number; profiles: { id: number; name: string }[]; profileId?: number;
  rootFolders: { path: string; freeSpace?: number }[]; rootFolder?: string; languageProfiles: { id: number; name: string }[]; languageProfileId?: number;
  tags: { id: number; label: string }[]; defaultTags: number[] };
export type ExploreSeerrUser = { id: number; name: string; email?: string };
export type ExploreRequestExtras = { serverId?: number; profileId?: number; rootFolder?: string; languageProfileId?: number; tags?: number[]; userId?: number };
