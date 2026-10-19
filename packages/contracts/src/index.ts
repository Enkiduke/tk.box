import { z } from 'zod';

export const playbackMode = z.enum(['plex_vod', 'custom_linear', 'iptv_live']);
export type PlaybackMode = z.infer<typeof playbackMode>;
export const quality = z.enum(['auto', 'original', '1080p', '720p']);
export type Quality = z.infer<typeof quality>;
// One entry in a title's quality menu: the route it plays by, or why it is unavailable.
export type QualityOption = { quality: Quality; available: boolean; route?: 'direct' | 'remux' | 'cpu'; reason?: string };
export const playbackSettings = z.object({
  maxConcurrentCpuVideoTranscodes: z.number().int().min(1).max(16),
  pauseRetentionMinutes: z.number().int().min(5).max(120)
}).strict();
export type PlaybackSettings = z.infer<typeof playbackSettings>;
export type Principal = { accountId: string; role: 'admin' | 'viewer' };
export type ApiError = { code: string; message: string; retryable: boolean };

export type Library = {key: string; title: string; type: 'movie' | 'show'};
export type CatalogItem = {
  id: string; libraryId: string; type: 'movie' | 'show' | 'season' | 'episode'; title: string;
  summary: string; year?: number; durationMs?: number; viewOffsetMs: number; watched: boolean;
  posterUrl?: string; showPosterUrl?: string; backdropUrl?: string; parentId?: string; parentTitle?: string;
  showId?: string; showTitle?: string; seasonNumber?: number; episodeNumber?: number;
  episodeCount?: number; watchedEpisodeCount?: number; contentRating?: string; rating?: number;
  genres: string[]; addedAt?: number;
};
export type CatalogPage = {items: CatalogItem[]; offset: number; limit: number; total?: number; hasMore: boolean};
